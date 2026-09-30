import { SYMBOLS, usdPerQuote, roundToLot } from '../market/symbols.js';
import { atr, last } from '../market/indicators.js';
import { fmtPrice, fmtQty, fmtUsd, spokenPnl, round } from '../util/format.js';
import { DeskLearner } from './learning.js';
import { eventLabel, spokenLabel, spokenTime } from '../market/calendar.js';

const LOG_SIZE = 80;

const freshDayStats = () => ({ trades: 0, entries: 0, wins: 0, losses: 0, grossWin: 0, grossLoss: 0 });

// Base class for every desk. Strategies override `evaluate(symbol, bar)` and `pitch()`;
// entries go through `openTrade`, which sizes via the risk desk and then manages the
// trade tick-by-tick: stop, 1R scale-out with stop to breakeven, ATR trailing, time stop.
export class TraderAgent {
  static strategyName = 'Discretionary';
  static strategyBlurb = '';

  constructor(profile, env) {
    this.profile = profile;
    this.id = profile.id;
    this.symbols = profile.symbols;
    this.symbol = profile.symbols[0];
    this.env = env;
    this.allocation = env.allocation;
    this.paused = false;
    this.halted = null;
    this.cooldownBars = 0;
    this.plans = new Map();
    this.day = freshDayStats();
    // realN / realSumR: trades on real market prices only (live mode), the record the
    // prop account trusts. Demo-mode (simulated) trades never count there.
    this.lifetime = { trades: 0, wins: 0, losses: 0, grossWin: 0, grossLoss: 0, sumR: 0, countR: 0, best: 0, worst: 0, realN: 0, realSumR: 0 };
    this.equityPeak = 0;
    this.maxDrawdown = 0;
    this.log = [];
    this.moodEvent = null;
    this.setup = {
      bias: 'NEUTRAL', stage: 'Warming up', thesis: '', armed: false,
      levels: [], checklist: [], confidence: 0, indicators: {},
    };
    this.learner = new DeskLearner(this);
  }

  // ---- accessors -----------------------------------------------------------------
  get md() { return this.env.md; }
  get broker() { return this.env.broker; }
  get risk() { return this.env.risk; }
  get session() { return this.env.session; }
  get book() { return this.broker.book(this.id); }
  get plan() { return this.plans.get(this.symbol) || null; }
  get firstName() { return this.profile.name.split(' ')[0]; }

  bars(symbol = this.symbol) { return this.md.bars(symbol); }
  price(symbol = this.symbol) { return this.md.price(symbol); }
  position(symbol = this.symbol) { return this.broker.position(this.id, symbol); }
  dec(symbol = this.symbol) { return SYMBOLS[symbol].decimals; }
  px(value, symbol = this.symbol) { return fmtPrice(value, this.dec(symbol)); }
  atrNow(symbol = this.symbol, len = 14) { return last(atr(this.bars(symbol), len)); }
  unrealized() { return this.broker.unrealized(this.id); }
  dayPnl() { return this.book.realizedDay + this.unrealized(); }
  totalPnl() { return this.book.realizedTotal + this.unrealized(); }

  // ---- lifecycle hooks (called by the fund) --------------------------------------------
  onBar(symbol, bar) {
    if (!this.symbols.includes(symbol) && !this.plans.has(symbol)) return;
    if (symbol === this.symbol && this.cooldownBars > 0) this.cooldownBars--;
    this.learner.onBar(symbol, bar);
    const plan = this.plans.get(symbol);
    if (plan) this.#manageOnBar(plan, bar);
    if (this.symbols.includes(symbol) && !this.paused && !this.halted) {
      try {
        this.evaluate(symbol, bar);
      } catch (err) {
        this.note(`Strategy error: ${err.message}`, 'error');
      }
    }
    this.#trackDrawdown();
  }

  onTick(symbol, price) {
    const plan = this.plans.get(symbol);
    if (plan) this.#manageTick(plan, price);
    if (this.onTickExtra && this.symbols.includes(symbol) && !this.paused && !this.halted) this.onTickExtra(symbol, price);
  }

  // Strategy hooks
  evaluate() {}
  pitch() { return `I'm running ${this.constructor.strategyName} on ${this.symbol}.`; }

  // ---- trading API -------------------------------------------------------------------
  openTrade({ side, stop, target = null, reason, symbol = this.symbol, tag = '', partialAt = 1, trail = null, timeStopBars = null, riskMultiplier = 1, testAlert = false }) {
    const check = this.risk.canOpen(this, symbol);
    if (!check.ok) {
      this.lastReject = check.reason;
      this.setStage(`Signal skipped — ${check.reason}`);
      return false;
    }
    if (this.position(symbol)) return false;
    const entry = this.price(symbol);
    const long = side === 'LONG';
    if (!Number.isFinite(entry) || !Number.isFinite(stop) || (long ? stop >= entry : stop <= entry)) return false;
    if (target != null && (long ? target <= entry : target >= entry)) target = null;

    // No trade on the desk's say-so alone: the department committee reviews the idea.
    const review = this.env.committee?.review({ agent: this, symbol, side, entry, stop, target, reason, external: tag === 'TV' }) ?? null;
    if (review && !review.ok) {
      this.lastReject = `the committee said no (${review.reason})`;
      this.setStage(`Committee said no: ${review.reason}`, review.silent ? 'quiet' : 'setup');
      return false;
    }
    if (review) riskMultiplier *= review.sizeMult;

    // What the desk has learned from its own trades: sit out losing situations, size by
    // proven edge, and adjust stop / target / profit-taking.
    const learn = this.learner.beforeEntry({ symbol, side, entry, stop, target, partialAt, trail, external: tag === 'TV' });
    if (learn.skip) {
      this.lastReject = learn.reason;
      this.setStage(`Skipped a signal: ${learn.reason}`);
      return false;
    }
    ({ stop, target, partialAt, trail } = learn);
    riskMultiplier *= learn.sizeMult;

    const qty = this.risk.size(this, symbol, entry, stop, { riskMultiplier });
    if (!qty) return false;
    const initialRisk = qty * Math.abs(entry - stop) * usdPerQuote(symbol, entry);
    const meta = review ? { thesis: review.thesis, grade: review.grade, score: Math.round(review.score * 100) / 100, verdict: review.shadowVerdict ?? null, debate: review.debate?.id ?? null, f: review.debate ? Object.fromEntries(Object.entries(review.debate.factors).map(([k, v]) => [k, v ? Math.round(v.value * 100) / 100 : null])) : null } : null;
    const res = this.broker.execute(this.id, symbol, long ? qty : -qty, { reason, tag, stop, target, initialRisk, meta });
    if (!res) return false;
    const fillPx = res.fill.price;
    const plan = {
      symbol, side, qty, entry: fillPx, stop, initialStop: stop, target,
      risk: Math.abs(fillPx - stop), partialAt, partialDone: false, trail, timeStopBars,
      barsHeld: 0, reason, tag, extreme: fillPx, worst: fillPx, openedAt: this.env.clock.now(),
      learnMult: learn.sizeMult, riskMult: riskMultiplier, probe: learn.probe,
      thesis: review?.thesis ?? null, grade: review?.grade ?? null, score: review?.score ?? null,
      testAlert: !!testAlert, // from the TradingView tab's test button: paper only
    };
    this.plans.set(symbol, plan);
    this.learner.onOpened(res.position?.trade?.id, learn, plan);
    this.day.entries++;
    this.setup.armed = false;
    const rr = target != null ? Math.abs(target - fillPx) / Math.abs(fillPx - stop) : null;
    this.note(
      `${long ? 'Bought' : 'Sold'} ${fmtQty(qty)} ${symbol} @ ${this.px(fillPx, symbol)} · stop ${this.px(stop, symbol)}` +
        (target != null ? ` · target ${this.px(target, symbol)} (${rr.toFixed(1)}R)` : '') +
        (review ? ` · committee grade ${review.grade}` : '') +
        (learn.probe ? ' · small test trade' : learn.sizeMult !== 1 ? ` · size ×${learn.sizeMult} from experience` : ''),
      'entry',
      { symbol, side, price: fillPx, qty },
    );
    return true;
  }

  closeTrade(symbol, reason, fraction = 1) {
    const pos = this.position(symbol);
    if (!pos) {
      this.plans.delete(symbol);
      return null;
    }
    let qty = -pos.qty * fraction;
    if (fraction < 1) {
      qty = roundToLot(symbol, qty);
      if (!qty) return null;
    }
    const res = this.broker.execute(this.id, symbol, qty, { reason });
    if (!res) return null;
    if (!res.position) this.plans.delete(symbol);
    if (fraction < 1) {
      this.note(`Scaled out ${Math.round(fraction * 100)}% of ${symbol} @ ${this.px(res.fill.price, symbol)} — ${reason}`, 'partial', { symbol, price: res.fill.price });
    }
    return res;
  }

  // Direct execution without a managed plan (pairs / market making).
  trade(symbol, qty, opts = {}) {
    return this.broker.execute(this.id, symbol, qty, opts);
  }

  flatten(reason = 'Flatten') {
    const had = this.book.positions.size > 0;
    this.broker.flatten(this.id, reason);
    this.plans.clear();
    if (this.onFlatten) this.onFlatten();
    if (had) this.note(`Flat — ${reason}`, 'exit');
  }

  // Keep a managed trade's levels consistent after a data-feed switch.
  rebase(symbol, offset) {
    const plan = this.plans.get(symbol);
    if (!plan) return;
    for (const k of ['entry', 'stop', 'initialStop', 'extreme']) plan[k] += offset;
    if (plan.target != null) plan.target += offset;
  }

  halt(reason) {
    this.halted = reason;
    this.flatten('Risk halt');
    this.note(`HALTED: ${reason}`, 'halt');
  }

  pause(paused) {
    this.paused = paused;
    this.note(paused ? 'Desk paused by the boss' : 'Desk resumed', 'info');
  }

  resetDay() {
    this.day = freshDayStats();
    this.halted = null;
    this.cooldownBars = 0;
    this.equityPeak = this.totalPnl();
    if (this.onNewDay) this.onNewDay();
  }

  // Broker callback for every closed round trip that belongs to this desk.
  onTradeClosed(trade) {
    const win = trade.pnl > 0;
    this.day.trades++;
    this.lifetime.trades++;
    if (win) {
      this.day.wins++; this.lifetime.wins++;
      this.day.grossWin += trade.pnl; this.lifetime.grossWin += trade.pnl;
    } else {
      this.day.losses++; this.lifetime.losses++;
      this.day.grossLoss += -trade.pnl; this.lifetime.grossLoss += -trade.pnl;
    }
    if (trade.r != null) { this.lifetime.sumR += trade.r; this.lifetime.countR++; }
    if (trade.r != null && !trade.simFeed) { this.lifetime.realN++; this.lifetime.realSumR += trade.r; }
    this.lifetime.best = Math.max(this.lifetime.best, trade.pnl);
    this.lifetime.worst = Math.min(this.lifetime.worst, trade.pnl);
    if (!win && !this.profile.noCooldown) this.cooldownBars = this.learner.cooldownBars(this.profile.cooldownBars ?? 3);
    if (!this.profile.quietTrades || Math.abs(trade.pnl) > this.allocation * 0.0015) {
      this.moodEvent = { mood: win ? 'celebrating' : 'frustrated', until: Date.now() + 7000 };
      const rText = trade.r != null ? ` (${trade.r >= 0 ? '+' : ''}${trade.r.toFixed(2)}R)` : '';
      this.note(`${win ? 'Closed for a win' : 'Took a loss'} on ${trade.symbol}: ${fmtUsd(trade.pnl, { sign: true })}${rText} — ${trade.exitReason || 'exit'}`, 'exit', { symbol: trade.symbol, pnl: trade.pnl });
    }
    for (const lesson of this.learner.onClosed(trade) || []) {
      this.note(`Lesson learned — ${lesson.title}. ${lesson.text.split(/(?<=\.)\s/)[0]}`, 'learn');
    }
  }

  // External signal (TradingView webhook).
  handleSignal({ action, symbol = this.symbol, stop, target, comment, test = false }) {
    const label = `TradingView alert${comment ? ` (${comment})` : ''}`;
    if (!this.md.get(symbol)) return { ok: false, reason: `Unknown symbol ${symbol}` };
    if (this.noPrices(symbol)) return { ok: false, reason: `No real prices for ${symbol} yet (its live feed isn't answering)` };
    if (action === 'close') {
      if (!this.position(symbol)) return { ok: false, reason: `No ${symbol} position to close` };
      this.closeTrade(symbol, label);
      return { ok: true, text: `Closed ${symbol} on ${label}` };
    }
    const side = action === 'buy' ? 'LONG' : 'SHORT';
    const pos = this.position(symbol);
    if (pos && (pos.qty > 0) === (side === 'LONG')) return { ok: false, reason: `Already ${side.toLowerCase()} ${symbol}` };
    if (pos) this.closeTrade(symbol, `Reversed on ${label}`);
    const price = this.price(symbol);
    const a = this.atrNow(symbol) || price * 0.002;
    const long = side === 'LONG';
    const s = Number.isFinite(stop) && (long ? stop < price : stop > price) ? stop : long ? price - 1.5 * a : price + 1.5 * a;
    const t = Number.isFinite(target) && (long ? target > price : target < price) ? target : long ? price + 2 * (price - s) : price - 2 * (s - price);
    this.note(`${label}: ${side} ${symbol}`, 'signal');
    this.lastReject = null;
    const ok = this.openTrade({ side, stop: s, target: t, reason: label, symbol, tag: 'TV', trail: 2, testAlert: test });
    return ok ? { ok: true, text: `${side} ${symbol} executed` } : { ok: false, reason: this.lastReject ? `Rejected: ${this.lastReject}` : 'Rejected by risk checks' };
  }

  // ---- trade management -------------------------------------------------------------
  #manageTick(plan, price) {
    const long = plan.side === 'LONG';
    plan.extreme = long ? Math.max(plan.extreme, price) : Math.min(plan.extreme, price);
    plan.worst = long ? Math.min(plan.worst ?? price, price) : Math.max(plan.worst ?? price, price);
    const stopHit = long ? price <= plan.stop : price >= plan.stop;
    if (stopHit) {
      const moved = long ? plan.stop > plan.initialStop : plan.stop < plan.initialStop;
      const atEntry = Math.abs(plan.stop - plan.entry) <= plan.risk * 0.05;
      this.closeTrade(plan.symbol, atEntry ? 'Breakeven stop' : moved ? 'Trailing stop' : 'Stop loss');
      return;
    }
    if (plan.target != null && (long ? price >= plan.target : price <= plan.target)) {
      this.closeTrade(plan.symbol, 'Target hit');
      return;
    }
    if (plan.partialAt && !plan.partialDone) {
      const trigger = long ? plan.entry + plan.partialAt * plan.risk : plan.entry - plan.partialAt * plan.risk;
      if (long ? price >= trigger : price <= trigger) {
        plan.partialDone = true;
        const res = this.closeTrade(plan.symbol, `Scale out at +${plan.partialAt}R`, 0.5);
        if (res && res.position) {
          plan.stop = plan.entry;
          this.note(`Stop to breakeven on ${plan.symbol} (${this.px(plan.entry, plan.symbol)})`, 'info');
        }
      }
    }
  }

  #manageOnBar(plan) {
    plan.barsHeld++;
    const long = plan.side === 'LONG';
    const price = this.price(plan.symbol);
    const rNow = plan.risk > 0 ? ((price - plan.entry) * (long ? 1 : -1)) / plan.risk : 0;
    if (plan.trail && (plan.partialDone || rNow >= 1)) {
      const a = this.atrNow(plan.symbol);
      if (Number.isFinite(a)) {
        const trailStop = long ? plan.extreme - plan.trail * a : plan.extreme + plan.trail * a;
        if (long ? trailStop > plan.stop : trailStop < plan.stop) plan.stop = trailStop;
      }
    }
    if (plan.timeStopBars && plan.barsHeld >= plan.timeStopBars && rNow < 0.5) {
      this.closeTrade(plan.symbol, `Time stop (${plan.barsHeld} bars)`);
    }
  }

  #trackDrawdown() {
    const eq = this.totalPnl();
    this.equityPeak = Math.max(this.equityPeak, eq);
    this.maxDrawdown = Math.max(this.maxDrawdown, this.equityPeak - eq);
  }

  // ---- presentation ------------------------------------------------------------------
  note(text, kind = 'info', data = {}) {
    const entry = { time: this.env.clock.now(), text, kind };
    this.log.push(entry);
    if (this.log.length > LOG_SIZE) this.log.shift();
    this.env.emit?.({ agentId: this.id, kind, text, ...data });
  }

  // Update the headline stage; logs only when it actually changes (kind 'quiet' never logs).
  setStage(stage, kind = 'setup') {
    if (this.setup.stage === stage) return;
    this.setup.stage = stage;
    if (kind !== 'quiet') this.note(stage, kind);
  }

  // Live mode never simulates: a market whose real feed hasn't answered has no prices.
  noPrices(symbol = this.symbol) {
    const s = this.md.get(symbol);
    return s?.status === 'WAITING' && !Number.isFinite(s.price);
  }

  status() {
    if (this.paused) return 'PAUSED';
    if (this.halted) return 'HALTED';
    if (this.book.positions.size) return 'IN TRADE';
    if (this.session.isFlattenWindow()) return 'FLAT · CLOSE';
    const st = this.md.get(this.symbol)?.status;
    if (this.noPrices()) return 'NO PRICES';
    if (st === 'CLOSED') return 'MARKET CLOSED';
    if (this.bars().length < 30) return 'WARMING UP';
    if (this.newsHold()) return 'NEWS';
    if (this.cooldownBars > 0) return 'COOLDOWN';
    if (this.setup.armed) return 'ARMED';
    return 'SCANNING';
  }

  // The economic calendar has this desk's market in a blackout right now.
  newsHold() {
    return this.env.news?.blackout(this.symbol) || null;
  }

  newsView() {
    const news = this.env.news;
    if (!news?.settings.enabled) return null;
    const hold = this.newsHold();
    const next = news.next(this.symbol, this.env.clock.now(), 6 * 3_600_000);
    return {
      hold: hold ? { label: eventLabel(hold.event), impact: hold.impact, time: hold.event.time, until: hold.until, phase: hold.phase } : null,
      next: next ? { label: eventLabel(next.event), impact: next.impact, time: next.event.time } : null,
    };
  }

  newsLine() {
    const news = this.env.news;
    if (!news?.settings.enabled) return null;
    const now = this.env.clock.now();
    const b = news.blackout(this.symbol, now);
    if (b) {
      if (b.phase === 'before') {
        return `Heads up: ${spokenLabel(b.event)} comes out at ${spokenTime(b.event.time)} New York time, ${b.impact} impact, so I'm standing aside until ${spokenTime(b.until)}.`;
      }
      const nums = b.event.actual ? `, ${b.event.actual} against ${b.event.forecast || 'no'} forecast` : '';
      return `${spokenLabel(b.event)} just came out${nums}. I'm letting the spike settle and I'm back at ${spokenTime(b.until)}.`;
    }
    const n = news.next(this.symbol, now, 3 * 3_600_000);
    if (n) {
      return `On the calendar: ${spokenLabel(n.event)} at ${spokenTime(n.event.time)} New York time, ${n.impact} impact. ` +
        (n.impact === 'high' ? `I'll be flat ${news.settings.flattenBefore} minutes before and won't trade around it.` : `I'll stand aside for a few minutes either side.`);
    }
    if (news.status === 'schedule') return `I can't reach the live news calendar, so I'm standing aside around the usual US release times.`;
    return 'No major news for my market in the next few hours.';
  }

  mood() {
    if (this.halted) return 'dejected';
    if (this.moodEvent && this.moodEvent.until > Date.now()) return this.moodEvent.mood;
    const unreal = this.unrealized();
    if (this.book.positions.size) {
      if (unreal < -this.allocation * 0.0015) return 'stressed';
      if (unreal > this.allocation * 0.0015) return 'confident';
      return 'focused';
    }
    const day = this.dayPnl();
    if (day > this.allocation * 0.004) return 'happy';
    if (day < -this.allocation * 0.008) return 'stressed';
    return 'focused';
  }

  positionsView() {
    return [...this.book.positions.values()].map((pos) => {
      const mark = this.price(pos.symbol);
      const plan = this.plans.get(pos.symbol);
      const unreal = pos.qty * (mark - pos.avg) * usdPerQuote(pos.symbol, mark);
      const risk = plan?.risk;
      return {
        symbol: pos.symbol,
        side: pos.qty > 0 ? 'LONG' : 'SHORT',
        qty: pos.qty,
        avg: pos.avg,
        mark,
        unrealized: unreal,
        stop: plan?.stop ?? null,
        target: plan?.target ?? null,
        r: risk ? ((mark - pos.avg) * Math.sign(pos.qty)) / risk : null,
        openTime: pos.openTime,
      };
    });
  }

  statsView() {
    const L = this.lifetime;
    return {
      tradesDay: this.day.trades,
      winsDay: this.day.wins,
      lossesDay: this.day.losses,
      trades: L.trades,
      wins: L.wins,
      losses: L.losses,
      winRate: L.trades ? L.wins / L.trades : null,
      profitFactor: L.grossLoss > 0 ? L.grossWin / L.grossLoss : L.grossWin > 0 ? Infinity : null,
      avgR: L.countR ? L.sumR / L.countR : null,
      best: L.best,
      worst: L.worst,
      maxDrawdown: this.maxDrawdown,
    };
  }

  snapshot() {
    const book = this.book;
    const unreal = this.unrealized();
    // While a trade is on, the headline bias is the side of the book.
    const main = this.position(this.symbol);
    const setup = main ? { ...this.setup, bias: main.qty > 0 ? 'LONG' : 'SHORT' } : this.setup;
    return {
      id: this.id,
      status: this.status(),
      mood: this.mood(),
      paused: this.paused,
      halted: this.halted,
      setup,
      positions: this.positionsView(),
      pnl: {
        day: book.realizedDay + unreal,
        total: book.realizedTotal + unreal,
        realizedDay: book.realizedDay,
        unrealized: unreal,
        feesDay: book.feesDay,
      },
      lossLimit: this.risk.deskLossLimit(this),
      exposure: this.broker.grossExposure(this.id),
      stats: this.statsView(),
      learning: this.learner.summary(),
      news: this.newsView(),
      log: this.log.slice(-10),
    };
  }

  briefing() {
    const lines = [];
    lines.push(`${this.firstName} here, ${this.profile.desk} desk.`);
    if (this.halted) {
      lines.push(`Bad news first: risk has me benched for the rest of the day. ${this.halted}.`);
    } else if (this.paused) {
      lines.push(`You paused my desk, so I'm on my hands until you say go.`);
    } else if (this.noPrices()) {
      lines.push(`There are no real prices for ${this.symbol} right now: its live feed isn't answering, and we never trade on made-up prices. I'm standing aside and start the moment real prices come in.`);
    } else {
      lines.push(this.pitch());
    }
    const newsLine = this.newsLine();
    if (newsLine) lines.push(newsLine);
    const plan = this.plans.get(this.symbol);
    if (plan?.thesis) lines.push(`Why I'm in: ${plan.thesis.replace(/^[^.]*\. Why: /, '')} The committee graded it ${plan.grade}.`);
    else if (this.env.committee && !this.book.positions.size) {
      const t = this.env.committee.thought(this.id, this.symbol);
      if (t) lines.push(`My read: ${t.text.replace(`${this.symbol}: `, '')}`);
    }
    // With an FTMO account connected, a position that is live on the account is described
    // from MT5 (below); anything else is said plainly to be paper.
    const book = this.env.liveBook?.(this.id);
    for (const p of this.positionsView()) {
      if (this.profile.customPositionPitch) break;
      if (book?.enabled && book.liveSymbols?.includes(p.symbol)) continue;
      const plan = this.plans.get(p.symbol);
      let s = `${book ? (book.enabled ? 'On paper only, ' : 'On paper, ') : ''}I'm ${p.side.toLowerCase()} ${fmtQty(p.qty)} ${p.symbol} from ${this.px(p.avg, p.symbol)}`;
      if (plan) {
        s += `, stop at ${this.px(plan.stop, p.symbol)}`;
        if (plan.target != null) s += `, target ${this.px(plan.target, p.symbol)}`;
      }
      s += `. The position is ${spokenPnl(p.unrealized)}`;
      if (p.r != null) s += `, that's ${p.r >= 0 ? 'plus' : 'minus'} ${Math.abs(round(p.r, 1))} R`;
      lines.push(s + '.');
    }
    const d = this.day;
    const tradesTxt = d.trades === 0 ? 'no closed trades yet' : `${d.trades} closed trade${d.trades === 1 ? '' : 's'}, ${d.wins} winner${d.wins === 1 ? '' : 's'}`;
    if (book?.enabled) {
      const live = this.env.liveDescribe?.(this.id);
      if (live) lines.push(live);
      lines.push(book.trades === 0
        ? 'No trades on your FTMO account yet today.'
        : `On your FTMO account today I'm ${spokenPnl(book.day)} across ${book.trades} trade${book.trades === 1 ? '' : 's'}, and ${spokenPnl(book.total)} since you connected it.`);
    } else if (book) {
      lines.push(`I'm not switched on for your FTMO account, so I'm paper trading only. My paper book is ${spokenPnl(this.dayPnl())} today with ${tradesTxt}.`);
    } else {
      lines.push(`On the day I'm ${spokenPnl(this.dayPnl())} with ${tradesTxt}. Since inception the desk is ${spokenPnl(this.totalPnl())}.`);
    }
    const learned = this.learner.briefingLine();
    if (learned) lines.push(learned);
    lines.push(this.#closer());
    return { greeting: 'Hello boss!', lines, text: lines.join(' ') };
  }

  #closer() {
    const mood = this.mood();
    const map = {
      celebrating: 'Just booked that one — good day to be on this desk.',
      happy: 'Book is working. I will keep pressing what the tape gives us.',
      confident: 'Trade is working; I will let it run and protect the stop.',
      stressed: 'It is a grind right now, but every loss is sized. I will stick to the plan.',
      frustrated: 'That one stung, but it was a valid setup. Resetting and staying patient.',
      dejected: 'I will review the tape tonight and come back sharp tomorrow.',
      focused: 'Staying patient and waiting for my level.',
    };
    return map[mood] || map.focused;
  }
}
