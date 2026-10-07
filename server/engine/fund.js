import { EventEmitter } from 'node:events';
import { ROSTER, publicProfile } from './roster.js';
import { TopDownBooks } from './topdown.js';
import { publicSymbolInfo } from '../market/symbols.js';
import { fmtUsd } from '../util/format.js';
import { eventLabel } from '../market/calendar.js';
import { fmtNyTime } from '../market/session.js';
import { MarketBrain } from '../brain/market.js';
import { Committee } from '../brain/committee.js';

const EVENT_BUFFER = 150;
const EQUITY_POINTS = 3000;
const DAY_CURVE_POINTS = 1500;

// The fund: owns the desks (and the research lab desks), routes market data to them, enforces fund-level
// risk, samples the equity curve and produces the snapshots the UI renders.
// A trading day that falls on a Saturday or Sunday (the floor's day starts at 18:00 New York
// the evening before): the weekend, from Friday 18:00 to Sunday 18:00 New York.
export const isWeekendDay = (dayKey) => [0, 6].includes(new Date(`${dayKey}T12:00:00Z`).getUTCDay());

export class Fund extends EventEmitter {
  // committee: 'on' (every trade is reviewed), 'shadow' (reviewed but never blocked) or 'off'.
  constructor({ config, md, clock, session, broker, risk, news = null, lab = null, committee = 'on', memory = null }) {
    super();
    this.news = news;
    this.lab = lab;
    this.config = config;
    this.md = md;
    this.clock = clock;
    this.session = session;
    this.broker = broker;
    this.risk = risk;
    this.allocation = config.startingCapital / ROSTER.length;
    this.events = [];
    this.alerts = [];
    this.equity = [];
    this.dayCurves = new Map();
    this.dayKey = session.tradingDay();
    this.dayStartNav = config.startingCapital;
    this.flattenedFor = null;
    this.lastSampleMinute = null;

    const env = {
      md, clock, session, broker, risk, news, lab,
      allocation: this.allocation,
      emit: (e) => this.#event(e),
      liveDescribe: null, // set by the live (FTMO) trader when it is running
      memory, // the floor's shared memory (brain/memory.js), when the floor keeps one
    };
    this.memory = memory;
    this.env = env;
    // The top-down read of every market (weekly, daily and 4-hour structure, areas of interest,
    // session liquidity), shared by the desks: each one trades with its market's bias.
    this.topDown = new TopDownBooks({ md, history: lab?.history ?? null });
    env.topDown = (symbol) => this.topDown.get(symbol);
    risk.news = news;
    news?.on('announce', (a) => this.#event({ kind: 'news', text: a.text }));
    this.agents = ROSTER.map((p) => new p.Strategy(p, env));
    this.byId = new Map(this.agents.map((a) => [a.id, a]));
    env.labDesks = () => this.agents.filter((a) => a.profile.lab);
    this.brain = new MarketBrain({ md, session, clock, news, history: lab?.history ?? null });
    env.marketBrain = this.brain; // what the neural brain senses each trade idea from
    this.committee = committee === 'off' ? null : new Committee({ brain: this.brain, agents: this.byId, clock, shadow: committee === 'shadow', memory });
    env.committee = this.committee;
    this.committee?.on('debate', (d) => {
      memory?.onDebate(d);
      const who = this.byId.get(d.proposer)?.firstName ?? d.proposer;
      const reviewers = d.messages.filter((m) => m.role === 'reviews').map((m) => `${this.byId.get(m.from)?.firstName}: ${m.stance}`).join(', ');
      this.#event({ agentId: d.proposer, kind: 'committee', debate: d.id, verdict: d.verdict, grade: d.grade, messages: d.messages.map((m) => ({ from: m.from, stance: m.stance, text: m.text })), text: `Committee ${d.verdict} ${who}'s ${d.symbol} ${d.side.toLowerCase()}${d.grade !== '—' ? ` (grade ${d.grade})` : ''}: ${d.why}${reviewers ? ` · ${reviewers}` : ''}` });
    });
    for (const a of this.agents) this.dayCurves.set(a.id, []);
    lab?.on('result', (r) => this.byId.get(r.agentId)?.onResearch?.(r));

    // Desks only start trading once history has loaded (start()), never on warm-up data.
    this.trading = false;
    md.on('bar', (symbol, bar) => {
      if (!this.trading) return;
      for (const a of this.agents) a.onBar(symbol, bar);
    });
    md.on('tick', (symbol, price) => {
      if (!this.trading) return;
      for (const a of this.agents) a.onTick(symbol, price);
    });
    broker.on('trade', (t) => this.byId.get(t.agentId)?.onTradeClosed(t));
    md.on('rebase', (symbol, offset) => {
      broker.rebase(symbol, offset);
      for (const a of this.agents) a.rebase(symbol, offset);
    });
    broker.on('fill', (f) => this.emit('fill', f));
  }

  start() {
    this.trading = true;
    this.timer = setInterval(() => this.housekeeping(), 1000);
    this.housekeeping();
  }

  stop() {
    clearInterval(this.timer);
  }

  // Lets other modules (e.g. the FTMO live trader) post to the floor's event stream.
  pushEvent(e) {
    this.#event(e);
  }

  #event(e) {
    const ev = { id: `${Date.now()}-${Math.random().toString(36).slice(2, 7)}`, time: this.clock.now(), ...e };
    if (e.kind !== 'quiet') {
      this.events.push(ev);
      if (this.events.length > EVENT_BUFFER) this.events.shift();
    }
    this.emit('event', ev);
  }

  nav() {
    let pnl = 0;
    for (const a of this.agents) pnl += a.totalPnl();
    return this.config.startingCapital + pnl;
  }

  dayPnl() {
    let pnl = 0;
    for (const a of this.agents) pnl += a.dayPnl();
    return pnl;
  }

  housekeeping() {
    const now = this.clock.now();
    const key = this.session.tradingDay(now);
    if (key !== this.dayKey) this.rollDay(key);
    this.#weekend(now);

    if (this.session.isFlattenWindow(now) && this.flattenedFor !== key) {
      this.flattenedFor = key;
      this.flattenAll('End-of-day flat');
      this.#event({ kind: 'session', text: 'Session close: all desks flat into the close' });
    }

    this.#newsGuard(now);
    if (this.trading) for (const a of this.agents) a.labTick?.();

    // The risk desk's loss limits (not when the desks trade their own way: then a halt from
    // earlier, saved before a restart, doesn't bench a desk either).
    const ownWay = !!this.env.ownWay?.();
    if (ownWay) {
      for (const a of this.agents) if (a.halted) a.halted = null;
      this.risk.riskOff = null;
    } else {
      for (const a of this.agents) {
        if (this.risk.checkDesk(a, a.dayPnl())) {
          this.#event({ agentId: a.id, kind: 'risk', text: `Risk desk halted ${a.profile.name}: loss limit ${fmtUsd(this.risk.deskLossLimit(a))}` });
        }
      }
      if (this.risk.checkFund(this.dayPnl(), this.dayStartNav)) {
        for (const a of this.agents) if (!a.halted) a.halt(this.risk.riskOff.reason);
        this.#event({ kind: 'risk', text: `FUND RISK-OFF: ${this.risk.riskOff.reason}. All desks halted.` });
      }
    }
    const nav = this.nav();

    const minute = Math.floor(now / 60_000);
    if (minute !== this.lastSampleMinute) {
      this.lastSampleMinute = minute;
      const t = minute * 60;
      const lastEq = this.equity[this.equity.length - 1];
      if (!lastEq || t > lastEq.time) {
        this.equity.push({ time: t, value: nav });
        if (this.equity.length > EQUITY_POINTS) this.equity.shift();
      }
      const sample = { time: t, nav, agents: {} };
      for (const a of this.agents) {
        const curve = this.dayCurves.get(a.id);
        const v = a.dayPnl();
        const lastPt = curve[curve.length - 1];
        if (!lastPt || t > lastPt.time) curve.push({ time: t, value: v });
        if (curve.length > DAY_CURVE_POINTS) curve.shift();
        sample.agents[a.id] = v;
      }
      this.emit('equity', sample);
    }
  }

  // Crypto day trading at the weekend: from Friday 18:00 to Sunday 18:00 New York (the trading
  // days of Saturday and Sunday, when FX, gold, oil and the indices are closed) every trading
  // desk with a weekend market (profile.weekendSymbol) trades it, flat by 16:50 each day like
  // any other day. Live mode only: the demo clock never runs at the weekend.
  #weekend(now) {
    if (this.clock.mode !== 'live') return;
    const on = isWeekendDay(this.session.tradingDay(now));
    if (on === this.weekendOn) return;
    this.weekendOn = on;
    let n = 0;
    for (const a of this.agents) {
      const w = a.profile.weekendSymbol;
      if (!w) continue;
      if (a.switchMarket(on ? w : a.profile.symbols[0], { weekend: on })) n++;
    }
    if (n) this.#event({ kind: 'session', text: on ? `Weekend: ${n} desks day-trade crypto until Sunday 18:00 New York` : 'Weekend over: every desk is back on its own market' });
  }

  // Real traders are flat before tier-one news: close every trade in a market with
  // high-impact news minutes away. If the boss allows it, a trade already ≥ 1R may run
  // with its stop locked at +0.5R, but never on an FTMO-connected desk (funded accounts
  // may not open or close trades around high-impact news).
  #newsGuard(now) {
    const news = this.news;
    if (!news || !this.trading) return;
    news.tick(now);
    // Their own way: no flattening for news, except where FTMO requires it (a funded account).
    if (this.env.newsRules?.() === false) return;
    for (const a of this.agents) {
      if (!a.book.positions.size) continue;
      const close = [];
      for (const pos of a.book.positions.values()) {
        const ev = news.preNews(pos.symbol, now);
        if (!ev) continue;
        const plan = a.plans.get(pos.symbol);
        if (plan?.newsKept === ev.id) continue;
        const onAccount = this.env.liveBook?.(a.id)?.enabled;
        if (news.settings.keepWinners && plan && !onAccount && plan.risk > 0) {
          const long = plan.side === 'LONG';
          const r = ((a.price(pos.symbol) - plan.entry) * (long ? 1 : -1)) / plan.risk;
          if (r >= 1) {
            const lock = long ? plan.entry + 0.5 * plan.risk : plan.entry - 0.5 * plan.risk;
            plan.stop = long ? Math.max(plan.stop, lock) : Math.min(plan.stop, lock);
            plan.newsKept = ev.id;
            a.note(`Keeping the ${pos.symbol} winner through ${eventLabel(ev)} with the stop locked at +0.5R`, 'news');
            continue;
          }
        }
        close.push({ symbol: pos.symbol, ev });
      }
      if (!close.length) continue;
      const ev = close[0].ev;
      const reason = `News: ${eventLabel(ev)} at ${fmtNyTime(ev.time)} NY (high impact)`;
      if (close.length === a.book.positions.size) a.flatten(reason);
      else for (const c of close) a.closeTrade(c.symbol, reason);
    }
  }

  rollDay(key) {
    this.dayKey = key;
    this.flattenedFor = null;
    this.dayStartNav = this.nav();
    this.risk.resetDay();
    this.md.rollDay();
    for (const a of this.agents) {
      this.broker.book(a.id).resetDay();
      a.resetDay();
      this.dayCurves.set(a.id, []);
    }
    this.#event({ kind: 'session', text: `New trading day ${key}. Daily P&L and risk limits reset.` });
  }

  flattenAll(reason) {
    for (const a of this.agents) a.flatten(reason);
  }

  // Wipe the paper track record (P&L, trades, stats). Open trades keep running.
  resetPaper() {
    for (const a of this.agents) {
      const b = this.broker.book(a.id);
      b.realizedDay = b.realizedTotal = b.feesDay = b.feesTotal = 0;
      b.trades = [];
      b.fills = [];
      a.resetDay();
      Object.assign(a.lifetime, { trades: 0, wins: 0, losses: 0, grossWin: 0, grossLoss: 0, sumR: 0, countR: 0, best: 0, worst: 0, realN: 0, realSumR: 0, recentR: [] });
      a.maxDrawdown = 0;
      a.equityPeak = a.totalPnl();
      this.dayCurves.set(a.id, []);
    }
    this.equity = [];
    this.risk.resetDay();
    this.dayStartNav = this.config.startingCapital;
    this.#event({ kind: 'session', text: 'Paper P&L and stats reset by the boss.' });
    this.emit('reset');
  }

  command(cmd, agentId) {
    const agent = agentId ? this.byId.get(agentId) : null;
    switch (cmd) {
      case 'reset-paper':
        this.resetPaper();
        return { ok: true };
      case 'research': {
        if (!agent?.requestResearch) return { ok: false, error: 'Only research desks research strategies' };
        return agent.requestResearch('requested by the boss');
      }
      case 'reset-learning':
        for (const a of agent ? [agent] : this.agents) {
          a.learner.reset();
          a.note('Cleared everything I had learned; starting fresh', 'learn');
        }
        return { ok: true };
      case 'flatten':
        if (agent) agent.flatten('Boss ordered flat');
        else this.flattenAll('Boss ordered the whole floor flat');
        return { ok: true };
      case 'pause':
        if (!agent) return { ok: false, error: 'agent required' };
        agent.pause(true);
        return { ok: true };
      case 'resume':
        if (!agent) return { ok: false, error: 'agent required' };
        agent.pause(false);
        return { ok: true };
      case 'pause-all':
        for (const a of this.agents) a.pause(true);
        return { ok: true };
      case 'resume-all':
        for (const a of this.agents) a.pause(false);
        return { ok: true };
      default:
        return { ok: false, error: `unknown command ${cmd}` };
    }
  }

  // Route a normalised TradingView alert to a desk.
  handleAlert(alert) {
    const byName = (q) => this.agents.find((a) => a.id === q || a.firstName.toLowerCase() === q || a.profile.name.toLowerCase() === q);
    let agent = alert.agent ? byName(alert.agent) : null;
    if (alert.agent && !agent) return this.#logAlert(alert, { ok: false, reason: `Unknown agent "${alert.agent}"` });
    if (!agent) agent = this.byId.get('chen');
    const symbol = alert.symbol || (!alert.rawSymbol ? agent.symbol : null);
    if (!symbol) return this.#logAlert(alert, { ok: false, reason: `Unknown symbol "${alert.rawSymbol}"` });
    if (agent.id === 'chen') agent.lastAlert = { action: alert.action, symbol, at: Date.now() };
    const result = agent.handleSignal({ ...alert, symbol });
    return this.#logAlert({ ...alert, symbol }, result, agent);
  }

  #logAlert(alert, result, agent = null) {
    const entry = {
      time: Date.now(),
      agentId: agent?.id ?? null,
      action: alert.action,
      symbol: alert.symbol || alert.rawSymbol,
      comment: alert.comment,
      ok: !!result.ok,
      result: result.ok ? result.text : result.reason,
    };
    this.alerts.push(entry);
    if (this.alerts.length > 50) this.alerts.shift();
    this.#event({ agentId: agent?.id, kind: 'alert', text: `TradingView ${alert.action.toUpperCase()} ${entry.symbol}: ${entry.result}` });
    this.emit('alert', entry);
    return { ...result, entry };
  }

  fundView() {
    const nav = this.nav();
    let gross = 0;
    let open = 0;
    let tradesDay = 0;
    let winsDay = 0;
    let realizedDay = 0;
    let unrealized = 0;
    for (const a of this.agents) {
      gross += this.broker.grossExposure(a.id);
      open += this.broker.book(a.id).positions.size;
      tradesDay += a.day.trades;
      winsDay += a.day.wins;
      realizedDay += this.broker.book(a.id).realizedDay;
      unrealized += a.unrealized();
    }
    return {
      name: this.config.fundName,
      nav,
      startingCapital: this.config.startingCapital,
      dayPnl: this.dayPnl(),
      totalPnl: nav - this.config.startingCapital,
      realizedDay,
      unrealized,
      grossExposure: gross,
      openPositions: open,
      tradesDay,
      winRateDay: tradesDay ? winsDay / tradesDay : null,
      riskOff: this.risk.riskOff,
      fundLossLimit: this.risk.fundDailyLossPct * this.dayStartNav,
      dayKey: this.dayKey,
      session: this.session.label(),
      marketTime: this.clock.now(),
      mode: this.config.feed,
      speed: this.clock.speed,
    };
  }

  snapshot() {
    return {
      fund: this.fundView(),
      agents: this.agents.map((a) => a.snapshot()),
      quotes: this.md.quotes(),
    };
  }

  initPayload(barCount = 300) {
    const candles = {};
    for (const [id] of this.md.series) {
      candles[id] = this.md.bars(id, { includeCurrent: true }).slice(-barCount);
    }
    const dayCurves = {};
    for (const [id, c] of this.dayCurves) dayCurves[id] = c;
    return {
      config: {
        fundName: this.config.fundName,
        mode: this.config.feed,
        speed: this.clock.speed,
        startingCapital: this.config.startingCapital,
        allocation: this.allocation,
        risk: {
          riskPerTradePct: this.risk.riskPerTradePct,
          deskDailyLossPct: this.risk.deskDailyLossPct,
          fundDailyLossPct: this.risk.fundDailyLossPct,
          maxLeverage: this.risk.maxLeverage,
        },
      },
      symbols: publicSymbolInfo(),
      profiles: ROSTER.map(publicProfile),
      equity: this.equity,
      dayCurves,
      candles,
      events: this.events.slice(-60),
      alerts: this.alerts.slice(-20),
      blotter: this.blotter(40),
      ...this.snapshot(),
    };
  }

  blotter(limit = 50) {
    const trades = [];
    for (const a of this.agents) trades.push(...this.broker.book(a.id).trades.slice(-limit));
    trades.sort((x, y) => y.closeTime - x.closeTime);
    return trades.slice(0, limit);
  }

  agentDetail(id) {
    const a = this.byId.get(id);
    if (!a) return null;
    const book = this.broker.book(id);
    return {
      profile: publicProfile(a.profile),
      snapshot: a.snapshot(),
      briefing: a.briefing(),
      learning: a.learner.view(),
      research: a.researchView?.(true) ?? null,
      brain: this.committee?.agentView(id) ?? null,
      trades: book.trades.slice(-60).reverse(),
      fills: book.fills.slice(-40).reverse(),
      log: a.log.slice(-60),
      dayCurve: this.dayCurves.get(id),
    };
  }

  // ---- persistence -------------------------------------------------------------------
  serialize() {
    const agents = {};
    for (const a of this.agents) {
      const b = this.broker.book(a.id);
      agents[a.id] = {
        realizedTotal: b.realizedTotal, feesTotal: b.feesTotal,
        realizedDay: b.realizedDay, feesDay: b.feesDay,
        trades: b.trades.slice(-200),
        lifetime: a.lifetime, day: a.day,
        maxDrawdown: a.maxDrawdown, equityPeak: a.equityPeak,
        halted: a.halted, paused: a.paused,
        dayCurve: this.dayCurves.get(a.id),
        learning: a.learner.serialize(),
        extra: a.serializeExtra?.() ?? null,
      };
    }
    return {
      version: 1, savedAt: Date.now(), mode: this.config.feed,
      dayKey: this.dayKey, dayStartNav: this.dayStartNav,
      equity: this.equity, agents, alerts: this.alerts,
    };
  }

  restore(state) {
    if (!state || state.version !== 1) return false;
    const nowSec = this.clock.now() / 1000;
    const sameDay = state.dayKey === this.dayKey;
    this.equity = (state.equity || []).filter((p) => p.time < nowSec);
    this.alerts = state.alerts || [];
    if (sameDay && state.dayStartNav) this.dayStartNav = state.dayStartNav;
    for (const a of this.agents) {
      const s = state.agents?.[a.id];
      if (!s) continue;
      const b = this.broker.book(a.id);
      b.realizedTotal = s.realizedTotal || 0;
      b.feesTotal = s.feesTotal || 0;
      b.trades = s.trades || [];
      Object.assign(a.lifetime, s.lifetime || {});
      a.maxDrawdown = s.maxDrawdown || 0;
      a.equityPeak = s.equityPeak || 0;
      a.paused = !!s.paused;
      a.learner.restore(s.learning);
      // Saved before the desk kept its recent form: start it from the learner's journal
      // (its trades on real prices).
      if (!Array.isArray(s.lifetime?.recentR)) {
        a.lifetime.recentR = (a.learner.state?.journal || []).filter((j) => Number.isFinite(j?.r)).slice(-20).map((j) => Math.round(j.r * 1000) / 1000);
      }
      a.restoreExtra?.(s.extra);
      if (sameDay) {
        b.realizedDay = s.realizedDay || 0;
        b.feesDay = s.feesDay || 0;
        Object.assign(a.day, s.day || {});
        a.halted = s.halted || null;
        this.dayCurves.set(a.id, (s.dayCurve || []).filter((p) => p.time < nowSec));
      }
    }
    if (!sameDay) this.dayStartNav = this.nav();
    return true;
  }
}
