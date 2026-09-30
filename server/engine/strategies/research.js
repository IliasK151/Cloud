import { TraderAgent } from '../agent.js';
import { liveSignal, closesTimeframe, LIVE_BARS } from '../../research/live.js';
import { classifyRegime } from '../../research/context.js';
import { FAMILIES } from '../../research/families.js';

// A research desk. It doesn't come to work with a fixed strategy: it reads the market's
// current condition, has the lab generate and backtest hundreds of strategy ideas that
// suit it, and only trades one that survives out-of-sample, robustness, Monte Carlo and
// final-holdout validation. A new strategy starts on probation at half size; live results
// are checked against the backtest after every trade and the strategy is retired (and the
// research redone) if it performs clearly worse than validated, or if the market changes
// and nothing passes validation any more. If nothing passes, the desk doesn't trade.

const MIN = 60_000;
const RETRY_MS = 45 * MIN; // after "no edge", look again
const REVALIDATE_MS = 4 * 60 * MIN; // walk forward: re-run research on fresh data
const REGIME_EVERY_MS = 5 * MIN;
const REGIME_PERSIST_MS = 30 * MIN;
const PROBATION_TRADES = 5;
const HISTORY_KEEP = 30;

const r2 = (x) => Math.round(x * 100) / 100;
// "5m Channel breakout" → "5-minute channel breakout" for the voices.
const spoken = (g) => `${g.tf}-minute ${FAMILIES[g.family].label.toLowerCase()}${g.side === 'long' ? ', longs only' : g.side === 'short' ? ', shorts only' : ''}`;

export class QuantResearch extends TraderAgent {
  static strategyName = 'Quant Research';
  static strategyBlurb = 'Researches strategies for the current market condition, validates them out-of-sample, under stress and on a final holdout, and trades only what passes. Nothing passes: no trades.';

  constructor(profile, env) {
    super(profile, env);
    this.markets = profile.research?.markets || profile.symbols;
    this.budget = profile.research?.budget || 360;
    this.active = null;
    this.pending = null; // symbol → result while a research round runs
    this.pendingSwap = null;
    this.lastRun = null;
    this.events = [];
    this.tested = 0;
    this.regimes = {};
    this.regimeSince = {};
    this.lastRegimeCheck = 0;
    this.retireReason = null;
    this.lastSignalAt = 0;
    this.setup.stage = 'Waiting for market history';
  }

  get lab() { return this.env.lab; }
  get history() { return this.lab?.history; }
  now() { return this.env.clock.now(); }

  #setMarket(symbol) {
    this.symbols = [symbol];
    this.symbol = symbol;
  }

  #record(event, text, extra = {}) {
    this.events.push({ time: this.now(), event, text, ...extra });
    if (this.events.length > HISTORY_KEEP) this.events.shift();
  }

  // ---- research loop (called every second by the fund) ----------------------------------
  labTick() {
    const lab = this.lab;
    if (!lab?.history?.ready) return;
    const now = this.now();
    if (now - this.lastRegimeCheck >= REGIME_EVERY_MS || !this.lastRegimeCheck) this.#checkRegimes(now);
    if (this.pending || lab.isBusy(this.id)) return;
    const flat = this.book.positions.size === 0;
    // The head of research looks across markets once the specialists have had a first look,
    // so she doesn't duplicate what they deploy.
    if (!this.lastRun && this.profile.research?.diversify && this.env.labDesks?.().some((a) => a !== this && !a.paused && !a.lastRun)) return;
    let reason = null;
    if (this.retireReason) reason = this.retireReason;
    else if (!this.lastRun) reason = 'first look at the market';
    else if (!this.active && now - this.lastRun.at >= RETRY_MS) reason = 'looking again for an edge';
    else if (!this.active && this.#regimeChangedSince(this.lastRun.at, now)) reason = 'the market condition changed';
    else if (this.active && flat && now - this.active.researchedAt >= REVALIDATE_MS) reason = 'walk-forward revalidation on fresh data';
    else if (this.active && flat && this.#regimeChangedSince(this.active.researchedAt, now, [this.active.symbol])) reason = `${this.active.symbol} changed from ${this.active.regime.label.toLowerCase()} to ${this.regimes[this.active.symbol]?.label.toLowerCase()}`;
    // Validated on simulated history (the real feed was down) and real data is here now:
    // it has to prove itself again on the real thing.
    else if (this.env.clock.mode === 'live' && flat && this.#realDataArrived()) reason = 'real market data arrived, re-testing on it';
    if (!reason) return;
    if (this.paused) return;
    this.retireReason = null;
    this.#startResearch(reason);
  }

  #checkRegimes(now) {
    this.lastRegimeCheck = now;
    for (const sym of this.markets) {
      const bars = this.history.recent(sym, 2400);
      if (bars.length < 300) continue;
      const rg = classifyRegime(bars);
      if (this.regimes[sym]?.key !== rg.key) this.regimeSince[sym] = now;
      this.regimes[sym] = rg;
    }
  }

  #regimeChangedSince(at, now, markets = this.markets) {
    const was = this.lastRun?.regimes || {};
    return markets.some((s) => this.regimes[s] && was[s] && this.regimes[s].key !== was[s].key && now - (this.regimeSince[s] || now) >= REGIME_PERSIST_MS && this.regimeSince[s] > at);
  }

  #realDataArrived() {
    const h = this.history;
    if (this.active) return !this.active.real && h.isReal?.(this.active.symbol);
    const res = this.lastRun?.results || {};
    return Object.entries(res).some(([sym, r]) => !r.real && r.outcome !== 'error' && h.isReal?.(sym));
  }

  requestResearch(reason) {
    if (!this.lab?.history?.ready) return { ok: false, error: 'Market history is still loading' };
    if (this.pending || this.lab.isBusy(this.id)) return { ok: false, error: 'Already researching' };
    this.#startResearch(reason);
    return { ok: true };
  }

  #startResearch(reason) {
    this.pending = new Map(this.markets.map((s) => [s, null]));
    this.pendingReason = reason;
    for (const sym of this.markets) this.lab.request(this.id, sym, { reason, budget: this.budget });
    const where = this.markets.length > 3 ? `all ${this.markets.length} markets` : this.markets.join(' and ');
    this.note(`Researching ${where}: ${reason}`, 'research');
    this.setStage(`Researching strategies (${reason})`, 'quiet');
  }

  onResearch({ symbol, result, error, real = false }) {
    if (!this.pending?.has(symbol)) return;
    this.pending.set(symbol, result ? { ...result, real } : { ok: false, outcome: 'error', summary: error || 'Research failed', symbol, real });
    if (result?.tested) this.tested += result.tested;
    if ([...this.pending.values()].some((v) => v === null)) return;
    const results = Object.fromEntries(this.pending);
    this.pending = null;
    this.#conclude(results);
  }

  #conclude(results) {
    const now = this.now();
    const list = Object.values(results);
    this.lastRun = {
      at: now, reason: this.pendingReason,
      regimes: Object.fromEntries(list.map((r) => [r.symbol, r.regime])),
      results: Object.fromEntries(list.map((r) => [r.symbol, {
        outcome: r.outcome, summary: r.summary, funnel: r.funnel, reasons: r.reasons, nearMiss: r.nearMiss || null,
        regime: r.regime, tested: r.tested || 0, bars: r.bars, real: !!r.real, strategy: r.strategy ? { name: r.strategy.name, unseen: r.strategy.unseen } : null,
      }])),
    };
    for (const r of list) if (r.regime) this.regimes[r.symbol] = r.regime;
    const tested = list.reduce((s, r) => s + (r.tested || 0), 0);
    let passing = list.filter((r) => r.ok).sort((a, b) => b.strategy.unseen.t - a.strategy.unseen.t);
    // The head of research diversifies: skip markets another research desk already trades.
    if (this.profile.research?.diversify) {
      const taken = new Set(this.env.labDesks?.().filter((a) => a !== this && a.active).map((a) => a.active.symbol));
      const fresh = passing.filter((r) => !taken.has(r.symbol));
      if (fresh.length) passing = fresh;
    }
    const best = passing[0];
    if (!best) {
      const dataShort = list.every((r) => r.outcome === 'data');
      const text = dataShort
        ? `Not enough history to research yet (${list.map((r) => `${r.symbol} ${r.bars}`).join(', ')} bars). Collecting data.`
        : `Tested ${tested} strategies; nothing passed validation${this.active ? `, so I'm retiring ${this.active.name}` : ''}. Standing aside.`;
      if (this.active) this.#record('retired', `Retired ${this.active.name}: nothing passes validation in current conditions`, { name: this.active.name });
      this.#record(dataShort ? 'data' : 'no-edge', text);
      this.note(text, 'research');
      this.active = null;
      this.pendingSwap = null;
      this.setStage(dataShort ? 'Collecting market history' : 'No validated edge: standing aside', 'quiet');
      return;
    }
    const s = best.strategy;
    const next = {
      symbol: best.symbol, genome: s.genome, key: s.key, name: s.name, rules: s.rules,
      stats: { is: s.is, oos: s.oos, holdout: s.holdout, unseen: s.unseen, all: s.all },
      robust: s.robust, expectation: s.expectation, tradesPerDay: s.tradesPerDay,
      curve: s.curve.slice(-400), splits: s.splits, regime: best.regime, funnel: best.funnel, tested,
      researchedAt: now, deployedAt: now, real: !!best.real,
      live: { trades: 0, wins: 0, sumR: 0, peak: 0, dd: 0, realTrades: 0, realSumR: 0 },
    };
    if (this.active && this.active.key === next.key && this.active.symbol === next.symbol) {
      // Same strategy re-validated on fresh data: keep its live record.
      Object.assign(this.active, { ...next, deployedAt: this.active.deployedAt, live: this.active.live });
      this.#record('kept', `Re-validated ${next.name} on ${next.symbol} with fresh data`, { name: next.name, symbol: next.symbol });
      this.note(`Re-validated ${next.name} on ${next.symbol}: still passes every test (unseen data ${this.#fmtR(next.stats.unseen.avgR)} per trade over ${next.stats.unseen.n} trades)`, 'research');
      return;
    }
    if (this.book.positions.size) {
      this.pendingSwap = next;
      this.note(`Found a better validated strategy (${next.name} on ${next.symbol}); switching once the current trade is closed`, 'research');
      return;
    }
    this.#deploy(next);
  }

  #deploy(next) {
    const replaced = this.active;
    this.active = next;
    this.pendingSwap = null;
    this.#setMarket(next.symbol);
    this.cooldownBars = 0;
    const u = next.stats.unseen;
    this.#record('deployed', `Deployed ${next.name} on ${next.symbol}`, { name: next.name, symbol: next.symbol, unseen: u });
    this.note(
      `${replaced ? `Replaced ${replaced.name} with` : 'Deployed'} ${next.name} on ${next.symbol} (${next.regime.label.toLowerCase()}): ` +
        `on data it never saw ${this.#fmtR(u.avgR)}/trade over ${u.n} trades, PF ${u.pf}, survived 2× costs and a final holdout. Half size for the first ${PROBATION_TRADES} trades.`,
      'research',
    );
    this.setStage(`Trading ${next.name}: waiting for its signal`, 'quiet');
  }

  #fmtR(x) {
    return `${x >= 0 ? '+' : ''}${x.toFixed(2)}R`;
  }

  get probation() {
    const l = this.active?.live;
    return !!l && (l.trades < PROBATION_TRADES || l.sumR < 0);
  }

  // ---- trading: the validated strategy's own signal, nothing else -----------------------
  evaluate(symbol, bar) {
    const act = this.active;
    if (!act || act.symbol !== symbol || !this.history?.ready) return;
    const g = act.genome;
    if (!closesTimeframe(bar.time, g.tf) || this.position(symbol)) return;
    const bars = this.history.recent(symbol, LIVE_BARS);
    const sig = liveSignal(bars, g);
    this.#updateSetup(sig);
    if (!sig) return;
    this.lastSignalAt = this.now();
    this.openTrade({
      side: sig.dir > 0 ? 'LONG' : 'SHORT', stop: sig.stop, target: sig.target, symbol,
      reason: `${act.name} signal`, tag: 'LAB',
      partialAt: g.partialAt, trail: g.trail, timeStopBars: g.timeStop ? g.timeStop * g.tf : null,
      riskMultiplier: this.probation ? 0.5 : 1,
    });
  }

  #updateSetup(sig) {
    const act = this.active;
    const st = this.setup;
    st.thesis = act ? `${act.name} on ${act.symbol}: ${act.rules[0]}.` : '';
    st.bias = sig ? (sig.dir > 0 ? 'LONG' : 'SHORT') : 'NEUTRAL';
    st.confidence = act ? Math.round(Math.min(95, 40 + act.stats.unseen.t * 12)) : 0;
    const rg = this.regimes[act?.symbol];
    st.checklist = act ? [
      { label: `Out-of-sample: ${this.#fmtR(act.stats.oos.avgR)} × ${act.stats.oos.n}`, ok: true },
      { label: `Holdout: ${this.#fmtR(act.stats.holdout.sumR)} total`, ok: true },
      { label: `Neighbours profitable: ${Math.round(act.robust.neighbours * 100)}%`, ok: true },
      { label: `2× costs: ${this.#fmtR(act.robust.doubleCostsAvgR)}/trade`, ok: true },
      { label: `Market now: ${rg?.label || 'n/a'}`, ok: !!rg && rg.key === act.regime.key },
    ] : [];
    if (!sig) this.setStage(`Trading ${act.name}: waiting for its signal`, 'quiet');
  }

  // ---- live monitoring ---------------------------------------------------------------------
  onTradeClosed(trade) {
    super.onTradeClosed(trade);
    const act = this.active;
    if (!act || trade.symbol !== act.symbol || trade.r == null) return;
    const l = act.live;
    l.trades++;
    if (trade.r > 0) l.wins++;
    l.sumR += trade.r;
    if (!trade.simFeed) {
      l.realTrades = (l.realTrades || 0) + 1;
      l.realSumR = (l.realSumR || 0) + trade.r;
    }
    l.peak = Math.max(l.peak, l.sumR);
    l.dd = Math.max(l.dd, l.peak - l.sumR);
    const exp = act.expectation;
    const floor = exp.avgR * l.trades - 2.33 * Math.max(exp.sd, 0.8) * Math.sqrt(l.trades);
    const ddLimit = Math.max(4, 1.5 * (exp.ddP95 || 0));
    let why = null;
    if (l.trades >= 5 && l.sumR < floor) why = `live results (${this.#fmtR(l.sumR)} over ${l.trades} trades) are far below what validation promised`;
    else if (l.dd >= ddLimit) why = `live drawdown of ${l.dd.toFixed(1)}R is beyond anything validation expected`;
    if (why) {
      this.#record('retired', `Retired ${act.name}: ${why}`, { name: act.name });
      this.note(`Retiring ${act.name}: ${why}. Back to research.`, 'research');
      this.active = null;
      this.retireReason = 'the last strategy stopped working';
      this.setStage('Strategy retired: researching a replacement', 'quiet');
      return;
    }
    if (l.trades === PROBATION_TRADES && l.sumR >= 0) this.note(`${act.name} passed probation (${this.#fmtR(l.sumR)} over ${l.trades} live trades): full size from now on`, 'research');
    if (this.pendingSwap && !this.book.positions.size) this.#deploy(this.pendingSwap);
  }

  onFlatten() {
    if (this.pendingSwap) setImmediate(() => { if (this.pendingSwap && !this.book.positions.size) this.#deploy(this.pendingSwap); });
  }

  // ---- presentation ------------------------------------------------------------------------
  status() {
    const base = super.status();
    if (['PAUSED', 'HALTED', 'IN TRADE', 'FLAT · CLOSE', 'MARKET CLOSED', 'NEWS'].includes(base)) return base;
    if (!this.active) {
      if (this.pending || this.lab?.isBusy(this.id)) return 'RESEARCHING';
      if (!this.lab?.history?.ready || this.lastRun?.results && Object.values(this.lastRun.results).every((r) => r.outcome === 'data')) return 'LOADING DATA';
      return 'NO EDGE';
    }
    return base;
  }

  researchView(full = false) {
    const lab = this.lab;
    const running = lab?.running?.agentId === this.id ? lab.running : null;
    const queued = lab ? lab.queue.filter((j) => j.agentId === this.id).length : 0;
    const act = this.active;
    const view = {
      markets: this.markets,
      researching: !!this.pending,
      progress: running ? { symbol: running.symbol, stage: running.stage, done: running.done, total: running.total } : null,
      queued,
      waitingFor: this.pending ? [...this.pending].filter(([, v]) => !v).map(([s]) => s) : [],
      tested: this.tested,
      regimes: this.regimes,
      active: act ? {
        symbol: act.symbol, name: act.name, regime: act.regime, stats: full ? act.stats : { unseen: act.stats.unseen },
        live: act.live, probation: this.probation, deployedAt: act.deployedAt, researchedAt: act.researchedAt, tradesPerDay: act.tradesPerDay, real: !!act.real,
        ...(full ? { rules: act.rules, robust: act.robust, expectation: act.expectation, curve: act.curve, splits: act.splits, funnel: act.funnel, tested: act.tested, genome: act.genome } : {}),
      } : null,
      pendingSwap: this.pendingSwap ? { name: this.pendingSwap.name, symbol: this.pendingSwap.symbol } : null,
      lastRun: this.lastRun ? { at: this.lastRun.at, reason: this.lastRun.reason, ...(full ? { results: this.lastRun.results } : {}) } : null,
    };
    if (full) view.events = [...this.events].reverse();
    return view;
  }

  snapshot() {
    return { ...super.snapshot(), symbol: this.symbol, research: this.researchView(false) };
  }

  pitch() {
    const act = this.active;
    const run = this.lastRun;
    if (this.pending || this.lab?.isBusy(this.id)) {
      const p = this.lab?.running?.agentId === this.id ? this.lab.running : null;
      return p
        ? `I'm in the middle of research on ${p.symbol}: ${p.stage.toLowerCase()}. Nothing trades until a strategy passes every test.`
        : `My research is queued at the lab. Nothing trades until a strategy passes every test.`;
    }
    if (!act) {
      if (!run) return 'I am loading market history before I start researching.';
      const r = Object.values(run.results);
      if (r.every((x) => x.outcome === 'data')) return "I don't have enough market history to research properly yet, so I'm collecting data and not trading.";
      const tested = r.reduce((s, x) => s + (x.tested || 0), 0);
      const near = r.map((x) => x.nearMiss).filter(Boolean)[0];
      return `I tested ${tested} strategy ideas on ${r.map((x) => x.symbol).join(', ')} and none passed validation${near ? `. The closest one failed because ${near.why.replace(/^(\w)/, (c) => c.toLowerCase())}` : ''}. So I'm not trading: sitting out beats trading an edge that isn't there.`;
    }
    const u = act.stats.unseen;
    const l = act.live;
    let s = `I'm trading a ${spoken(act.genome)} strategy on ${act.symbol}, built for ${act.regime.label.toLowerCase()} conditions. ` +
      `I picked it from ${act.tested} ideas I tested, and on data it had never seen it made ${u.avgR >= 0 ? 'plus' : 'minus'} ${Math.abs(r2(u.avgR))} R per trade over ${u.n} trades with a profit factor of ${u.pf}. ` +
      `It also survived double trading costs, nearby settings and a final holdout.`;
    if (l.trades) s += ` Live it's ${l.sumR >= 0 ? 'up' : 'down'} ${Math.abs(r2(l.sumR))} R over ${l.trades} trade${l.trades === 1 ? '' : 's'}${this.probation ? ', still on probation at half size' : ''}.`;
    else s += ` It's on probation at half size for its first ${PROBATION_TRADES} trades.`;
    if (this.env.clock.mode === 'live' && !act.real) s += ` One caveat: the real feed for ${act.symbol} was down, so I validated it on simulated history. It stays on paper until it passes again on real data.`;
    return s;
  }

  // ---- persistence -----------------------------------------------------------------------
  serializeExtra() {
    return { active: this.active, events: this.events, tested: this.tested, lastRun: this.lastRun };
  }

  restoreExtra(x) {
    if (!x) return;
    this.events = x.events || [];
    this.tested = x.tested || 0;
    this.lastRun = x.lastRun || null;
    if (x.active?.genome) {
      this.active = x.active;
      this.#setMarket(x.active.symbol);
      // Market time moved on (or the data source changed): re-validate soon.
      this.active.researchedAt = Math.min(this.active.researchedAt || 0, this.now() - REVALIDATE_MS + 10 * MIN);
    }
    if (this.lastRun) this.lastRun.at = Math.min(this.lastRun.at, this.now());
  }
}
