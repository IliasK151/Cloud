import { EventEmitter } from 'node:events';
import { ROSTER, publicProfile } from './roster.js';
import { publicSymbolInfo } from '../market/symbols.js';
import { fmtUsd } from '../util/format.js';

const EVENT_BUFFER = 150;
const EQUITY_POINTS = 3000;
const DAY_CURVE_POINTS = 1500;

// The fund: owns the ten desks, routes market data to them, enforces fund-level
// risk, samples the equity curve and produces the snapshots the UI renders.
export class Fund extends EventEmitter {
  constructor({ config, md, clock, session, broker, risk }) {
    super();
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
      md, clock, session, broker, risk,
      allocation: this.allocation,
      emit: (e) => this.#event(e),
      liveDescribe: null, // set by the live (FTMO) trader when it is running
    };
    this.env = env;
    this.agents = ROSTER.map((p) => new p.Strategy(p, env));
    this.byId = new Map(this.agents.map((a) => [a.id, a]));
    for (const a of this.agents) this.dayCurves.set(a.id, []);

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

    if (this.session.isFlattenWindow(now) && this.flattenedFor !== key) {
      this.flattenedFor = key;
      this.flattenAll('End-of-day flat');
      this.#event({ kind: 'session', text: 'Session close: all desks flat into the close' });
    }

    for (const a of this.agents) {
      if (this.risk.checkDesk(a, a.dayPnl())) {
        this.#event({ agentId: a.id, kind: 'risk', text: `Risk desk halted ${a.profile.name}: loss limit ${fmtUsd(this.risk.deskLossLimit(a))}` });
      }
    }
    const nav = this.nav();
    if (this.risk.checkFund(this.dayPnl(), this.dayStartNav)) {
      for (const a of this.agents) if (!a.halted) a.halt(this.risk.riskOff.reason);
      this.#event({ kind: 'risk', text: `FUND RISK-OFF: ${this.risk.riskOff.reason}. All desks halted.` });
    }

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
      Object.assign(a.lifetime, { trades: 0, wins: 0, losses: 0, grossWin: 0, grossLoss: 0, sumR: 0, countR: 0, best: 0, worst: 0 });
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
