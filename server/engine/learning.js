import { atr, ema } from '../market/indicators.js';
import { nyMinuteOfDay } from '../market/session.js';

// Self-learning for a desk. Every managed trade is journaled with the situation it was taken
// in (time of day, volatility, trend, setup quality, revenge, trade of the day, side) and how
// it played out (R, best and worst excursion, what the market did after a stop-out).
//
// From that journal the desk adapts, always from evidence and within hard limits:
//  - sizes down (or sits out, with occasional small probe trades) situations that keep
//    losing, and sizes up slightly where it has a proven edge
//  - fixes recurring mistakes in trade management: giving back winners, stops that are too
//    tight or too wide, targets that are rarely reached
//  - takes longer breaks after losses if revenge trades lose, trades less if late trades lose
// Every management change is reviewed after more trades and rolled back if it didn't help.

export const LEARNING_VERSION = 1;

const DECAY = 0.99; // weight kept per new trade (half-life ≈ 70 trades: recent trades count more)
const PRIOR = 5; // pseudo-trades at 0R that shrink small samples toward "no edge"
const MIN_FEATURE_N = 8; // effective trades (in and out of a situation) before it affects size
const AVOID_N = 12; // effective trades before a situation can be sat out
const MAX_AVOID = 2;
// Situations that can be sat out. The "normal" ones (clear head, first trades of the day,
// with the trend, good setups, normal volatility) never are: if those lose, the strategy
// itself is off, which the desk handles by sizing down while it's in a slump.
const AVOIDABLE = new Set(['session:asia', 'session:london', 'session:ny-open', 'session:ny-midday', 'session:ny-late', 'vol:quiet', 'vol:wild', 'trend:against', 'trend:flat', 'quality:low', 'quality:medium', 'revenge:yes', 'nth:3-4', 'nth:5+', 'side:LONG', 'side:SHORT']);
const WINDOW = 30; // recent trades used for management lessons
const REVIEW_AFTER = 15; // trades before a change is judged
const MAX_JOURNAL = 200;
const SHAKEOUT_BARS = 30;

export const FEATURE_LABELS = {
  'session:asia': 'the Asian session',
  'session:london': 'the London session',
  'session:ny-open': 'the New York open',
  'session:ny-midday': 'New York midday',
  'session:ny-late': 'the New York afternoon',
  'vol:quiet': 'quiet markets',
  'vol:normal': 'normal volatility',
  'vol:wild': 'very volatile markets',
  'trend:with': 'trades with the trend',
  'trend:against': 'trades against the trend',
  'trend:flat': 'trendless markets',
  'quality:high': 'high-quality setups',
  'quality:medium': 'medium-quality setups',
  'quality:low': 'low-quality setups',
  'revenge:yes': 'trading right after a loss',
  'revenge:no': 'trading with a clear head',
  'nth:1-2': 'my first two trades of the day',
  'nth:3-4': 'my third and fourth trades of the day',
  'nth:5+': 'my fifth trade of the day and later',
  'side:LONG': 'long trades',
  'side:SHORT': 'short trades',
};

const PARAM_LIMITS = {
  stopMult: [0.75, 1.6],
  targetMult: [0.7, 1.3],
  partialMult: [0.6, 1.2],
  trailMult: [0.6, 1.4],
  cooldownMult: [1, 3],
  maxTrades: [3, 12],
};

const clamp = (x, lo, hi) => Math.min(hi, Math.max(lo, x));
const round2 = (x) => Math.round(x * 100) / 100;
const fmtR = (r) => `${r >= 0 ? '+' : '−'}${Math.abs(r).toFixed(2)}R`;

function freshState() {
  return {
    version: LEARNING_VERSION,
    studied: 0,
    journal: [],
    features: {},
    total: { n: 0, sum: 0, sumSq: 0 },
    params: { stopMult: 1, targetMult: 1, partialMult: 1, trailMult: 1, cooldownMult: 1, maxTrades: null },
    avoid: {},
    probes: {},
    lessons: [],
    lastLossAt: null,
  };
}

export class DeskLearner {
  constructor(agent) {
    this.agent = agent;
    this.state = freshState();
    this.open = new Map(); // broker trade id → { ctx, plan, mult }
    this.watch = []; // stop-outs being followed to see if the market went our way after
    this.lessonSeq = 0;
  }

  get enabled() {
    return this.agent.profile.learning !== false;
  }

  // ---- situation at entry ------------------------------------------------------------
  context(symbol, side) {
    const a = this.agent;
    const now = a.env.clock.now();
    const m = nyMinuteOfDay(now);
    const session = m >= 18 * 60 || m < 3 * 60 ? 'asia' : m < 9 * 60 + 30 ? 'london' : m < 11 * 60 ? 'ny-open' : m < 14 * 60 ? 'ny-midday' : 'ny-late';
    const bars = a.bars(symbol);
    let vol = 'normal';
    let trend = 'flat';
    if (bars.length >= 60) {
      const series = atr(bars.slice(-160), 14).filter(Number.isFinite);
      const cur = series[series.length - 1];
      const sorted = series.slice().sort((x, y) => x - y);
      const median = sorted[Math.floor(sorted.length / 2)];
      if (cur < median * 0.8) vol = 'quiet';
      else if (cur > median * 1.3) vol = 'wild';
      const closes = bars.slice(-120).map((b) => b.close);
      const e = ema(closes, 50);
      const slope = e[e.length - 1] - e[e.length - 21];
      if (Number.isFinite(slope) && Math.abs(slope) > 0.3 * cur) {
        const up = slope > 0;
        trend = up === (side === 'LONG') ? 'with' : 'against';
      }
    }
    const conf = a.setup?.confidence ?? 50;
    const quality = conf >= 70 ? 'high' : conf >= 45 ? 'medium' : 'low';
    const revenge = this.state.lastLossAt != null && now - this.state.lastLossAt < 30 * 60_000 ? 'yes' : 'no';
    const n = (a.day?.entries ?? 0) + 1;
    const nth = n <= 2 ? '1-2' : n <= 4 ? '3-4' : '5+';
    return { session, vol, trend, quality, revenge, nth, side };
  }

  static keys(ctx) {
    return Object.entries(ctx).map(([k, v]) => `${k}:${v}`);
  }

  // Recency-weighted results in a situation, and for the desk's other trades (the contrast).
  stat(key) {
    const f = this.state.features[key] || { n: 0, sum: 0, sumSq: 0 };
    const T = this.state.total;
    const shrunk = (sum, n) => sum / (n + PRIOR);
    const n = f.n;
    const raw = n > 0 ? f.sum / n : 0;
    const variance = n > 0 ? Math.max(0.05, f.sumSq / n - raw * raw) : 1;
    const restN = Math.max(0, T.n - n);
    const rest = shrunk(T.sum - f.sum, restN);
    const mean = shrunk(f.sum, n);
    return { n, mean, raw, sd: Math.sqrt(variance), restN, rest, delta: mean - rest };
  }

  // The desk's overall recent form (shrunk toward zero).
  form() {
    const T = this.state.total;
    return { n: T.n, mean: T.sum / (T.n + PRIOR) };
  }

  featureFactor(s) {
    if (s.n < MIN_FEATURE_N || s.restN < MIN_FEATURE_N) return 1;
    return clamp(1 + 0.5 * s.delta, 0.7, 1.15);
  }

  formFactor() {
    const f = this.form();
    return f.n >= 10 ? clamp(1 + 0.4 * f.mean, 0.75, 1.1) : 1;
  }

  // ---- before a trade: size, skip, adjusted levels -------------------------------------
  // external: the boss's own TradingView alerts are journaled but never skipped or changed.
  beforeEntry({ symbol, side, entry, stop, target, partialAt, trail, external = false }) {
    const ctx = this.context(symbol, side);
    const out = { ctx, sizeMult: 1, stop, target, partialAt, trail, skip: false, reason: '', probe: false };
    if (!this.enabled || external) return out;
    const keys = DeskLearner.keys(ctx);
    // Situations the desk has learned to sit out (with an occasional half-size probe).
    const avoided = keys.filter((k) => this.state.avoid[k]);
    if (avoided.length) {
      // Probe now and then (at most hourly, after a couple of skipped signals) so the desk
      // can find out if the situation has changed.
      const k = avoided[0];
      const now = this.agent.env.clock.now();
      const pr = this.state.probes[k] || (this.state.probes[k] = { skips: 0, lastSkipAt: 0, lastProbeAt: 0 });
      if (now - pr.lastSkipAt >= 5 * 60_000) {
        pr.skips++;
        pr.lastSkipAt = now;
      }
      if (pr.skips < 2 || now - pr.lastProbeAt < 60 * 60_000) {
        out.skip = true;
        out.reason = `I've learned to sit out ${FEATURE_LABELS[k] || k}`;
        return out;
      }
      pr.skips = 0;
      pr.lastProbeAt = now;
      out.probe = true;
    }
    let mult = this.formFactor();
    for (const k of keys) mult *= this.featureFactor(this.stat(k));
    if (out.probe) mult = Math.min(mult, 0.5);
    out.sizeMult = round2(clamp(mult, 0.5, 1.25));
    // Management parameters learned from past mistakes.
    const p = this.state.params;
    const long = side === 'LONG';
    const dist = Math.abs(entry - stop) * p.stopMult;
    out.stop = long ? entry - dist : entry + dist;
    if (target != null) {
      const t = Math.abs(target - entry) * p.targetMult;
      out.target = long ? entry + t : entry - t;
    }
    if (partialAt) out.partialAt = round2(clamp(partialAt * p.partialMult, 0.5, 3));
    if (trail) out.trail = round2(trail * p.trailMult);
    return out;
  }

  onOpened(tradeId, info, plan) {
    if (tradeId == null) return;
    this.open.set(tradeId, { ctx: info.ctx, plan, sizeMult: info.sizeMult, probe: info.probe, targetR: plan.target != null ? Math.abs(plan.target - plan.entry) / plan.risk : null });
  }

  // ---- after a trade --------------------------------------------------------------------
  onClosed(trade) {
    const rec0 = this.open.get(trade.id);
    this.open.delete(trade.id);
    const now = this.agent.env.clock.now();
    if (trade.pnl < 0) this.state.lastLossAt = now;
    if (!rec0 || !this.enabled || trade.r == null) return null;
    const { plan, ctx } = rec0;
    const dir = plan.side === 'LONG' ? 1 : -1;
    const risk = plan.risk || 1;
    const mfe = Math.max(0, ((plan.extreme - plan.entry) * dir) / risk);
    const mae = Math.max(0, ((plan.entry - (plan.worst ?? plan.entry)) * dir) / risk);
    const r = clamp(trade.r, -3, 6);
    const rec = {
      t: now, ctx, r: round2(r), mfe: round2(mfe), mae: round2(mae), bars: plan.barsHeld,
      exit: trade.exitReason || '', targetR: rec0.targetR != null ? round2(rec0.targetR) : null,
      stopOut: /stop loss/i.test(trade.exitReason || ''), shakeout: null, probe: !!rec0.probe,
    };
    this.state.journal.push(rec);
    if (this.state.journal.length > MAX_JOURNAL) this.state.journal.shift();
    this.state.studied++;
    // Decay everything each trade so situations and the whole desk stay comparable.
    const present = new Set(DeskLearner.keys(ctx));
    for (const k of present) if (!this.state.features[k]) this.state.features[k] = { n: 0, sum: 0, sumSq: 0 };
    for (const [k, f] of [...Object.entries(this.state.features), ['*', this.state.total]]) {
      f.n *= DECAY;
      f.sum *= DECAY;
      f.sumSq *= DECAY;
      if (k === '*' || present.has(k)) {
        f.n += 1;
        f.sum += r;
        f.sumSq += r * r;
      }
    }
    if (rec.stopOut) {
      // Race from the stop price: 2R our way (entry + 1R) or 2R further against?
      // In a random market that's a coin flip, so only a clear bias counts as evidence.
      const stopPx = plan.entry - dir * risk;
      this.watch.push({ rec, symbol: plan.symbol, dir, up: plan.entry + dir * risk, down: stopPx - dir * 2 * risk, bars: 0 });
    }
    const lessons = [];
    lessons.push(...this.#reviewFeatures());
    if (this.state.studied % 5 === 0) lessons.push(...this.#reviewManagement());
    lessons.push(...this.#reviewChanges());
    return lessons;
  }

  // Follow stop-outs for a while: did the market go our way right after?
  onBar(symbol, bar) {
    if (!this.watch.length) return;
    this.watch = this.watch.filter((w) => {
      if (w.symbol !== symbol) return true;
      w.bars++;
      const favorable = w.dir > 0 ? bar.high >= w.up : bar.low <= w.up;
      const adverse = w.dir > 0 ? bar.low <= w.down : bar.high >= w.down;
      if (favorable !== adverse) {
        w.rec.shakeout = favorable;
        return false;
      }
      if (favorable && adverse) return false; // both in one bar: can't tell
      return w.bars < SHAKEOUT_BARS; // unresolved stays null
    });
  }

  // ---- lessons: situations -----------------------------------------------------------------
  #reviewFeatures() {
    const out = [];
    for (const k of Object.keys(this.state.features)) {
      const s = this.stat(k);
      const label = FEATURE_LABELS[k] || k;
      const avoided = !!this.state.avoid[k];
      const upper = s.raw + s.sd / Math.sqrt(Math.max(1, s.n));
      if (!avoided) {
        if (!AVOIDABLE.has(k) || Object.keys(this.state.avoid).length >= MAX_AVOID) continue;
        if (s.n < AVOID_N || s.restN < MIN_FEATURE_N) continue;
        if (!(s.mean <= -0.25 && s.delta <= -0.4 && upper < s.rest)) continue;
        const dim = k.split(':')[0];
        if (Object.keys(this.state.avoid).some((x) => x.startsWith(`${dim}:`))) continue; // one per dimension
        this.state.avoid[k] = { since: this.state.studied, mean: round2(s.raw) };
        out.push(this.#lesson(`avoid:${k}`, `Sitting out ${label}`,
          `I lose money on ${label}: ${fmtR(s.raw)} a trade over my last ${Math.round(s.n)} of them, against ${fmtR(s.rest)} on my other trades. I'm sitting those out now, with an occasional small test trade to see if that changes.`,
          { n: Math.round(s.n), avgR: round2(s.raw), otherR: round2(s.rest) }));
        if (k === 'revenge:yes') out.push(...this.#setParam('cooldownMult', Math.min(3, this.state.params.cooldownMult * 2), 'revenge',
          'Longer breaks after a loss', 'My trades right after a loss are my worst ones, so I now take a longer breather after every loss.'));
        if (k === 'nth:5+') out.push(...this.#setParam('maxTrades', 4, 'overtrading',
          'Fewer trades per day', 'My fifth trade of the day and beyond keeps losing, so I stop at four trades a day now.'));
      } else if (s.delta > -0.15 || s.mean > 0) {
        delete this.state.avoid[k];
        out.push(this.#lesson(`back:${k}`, `Back to ${label}`,
          `My test trades show ${label} working again (${fmtR(s.raw)} a trade recently), so I'm trading them normally again.`,
          { n: Math.round(s.n), avgR: round2(s.raw) }));
      }
    }
    return out;
  }

  // ---- lessons: trade management -------------------------------------------------------------
  #reviewManagement() {
    const recent = this.state.journal.slice(-WINDOW);
    if (recent.length < 12) return [];
    const out = [];
    const p = this.state.params;

    // Giving back winners: trades that were up at least 1R but closed flat or red.
    const gaveBack = recent.filter((t) => t.mfe >= 1 && t.r <= 0.1);
    if (gaveBack.length >= 4 && gaveBack.length / recent.length >= 0.25 && p.partialMult > PARAM_LIMITS.partialMult[0]) {
      out.push(...this.#setParam('partialMult', p.partialMult * 0.85, 'giveback', 'Locking in profits sooner',
        `I was giving back winners: ${gaveBack.length} of my last ${recent.length} trades were up at least 1R and still closed flat or red. I now take partial profits sooner and trail tighter.`,
        { trailMult: p.trailMult * 0.9 }));
    }

    // Stops too tight: stop-outs where the market went our way right after.
    const stops = recent.filter((t) => t.stopOut && t.shakeout != null);
    const shaken = stops.filter((t) => t.shakeout);
    if (stops.length >= 8 && shaken.length / stops.length >= 0.65 && p.stopMult < PARAM_LIMITS.stopMult[1]) {
      out.push(...this.#setParam('stopMult', p.stopMult * 1.15, 'tightstops', 'Giving trades more room',
        `My stops were too tight: after ${shaken.length} of my last ${stops.length} stop-outs the market went my way instead of carrying on against me. I've widened my stops a little, and the position size shrinks to keep the same risk.`));
    } else {
      // Stops too wide: good trades barely go against us, bad ones never work at all.
      const winners = recent.filter((t) => t.r > 0.5);
      const losers = recent.filter((t) => t.r < -0.5);
      const winMae = winners.length ? winners.reduce((s, t) => s + t.mae, 0) / winners.length : 1;
      const neverWorked = losers.filter((t) => t.mfe < 0.2).length;
      if (winners.length >= 5 && losers.length >= 5 && winMae <= 0.35 && neverWorked / losers.length >= 0.7 && p.stopMult > PARAM_LIMITS.stopMult[0]) {
        out.push(...this.#setParam('stopMult', p.stopMult * 0.9, 'widestops', 'Tighter stops',
          `My good trades rarely go against me by more than a third of my stop, and the bad ones never work at all. I've tightened my stops a little; the size adjusts so the risk per trade stays the same.`));
      }
    }

    // Targets too far: trades that went well but turned around before the target.
    const withTarget = recent.filter((t) => t.targetR != null && t.targetR >= 1.5);
    const missed = withTarget.filter((t) => t.mfe >= 1.2 && t.mfe < t.targetR * 0.95 && t.r < 0.5);
    if (withTarget.length >= 8 && missed.length >= 4 && missed.length / withTarget.length >= 0.3 && p.targetMult > PARAM_LIMITS.targetMult[0]) {
      out.push(...this.#setParam('targetMult', p.targetMult * 0.9, 'fartargets', 'Closer profit targets',
        `My targets were too ambitious: ${missed.length} of my last ${withTarget.length} trades got well into profit but turned around before the target. I've brought my targets in a little.`));
    }
    return out;
  }

  #setParam(param, value, key, title, text, extra = {}) {
    const p = this.state.params;
    const [lo, hi] = PARAM_LIMITS[param];
    const from = p[param];
    const to = param === 'maxTrades' ? clamp(Math.round(value), lo, hi) : round2(clamp(value, lo, hi));
    if (from === to) return [];
    const recent = this.state.journal.slice(-WINDOW);
    const baseline = recent.length ? recent.reduce((s, t) => s + t.r, 0) / recent.length : 0;
    const change = { [param]: { from, to } };
    p[param] = to;
    for (const [k, v] of Object.entries(extra)) {
      const [l2, h2] = PARAM_LIMITS[k];
      change[k] = { from: p[k], to: round2(clamp(v, l2, h2)) };
      p[k] = change[k].to;
    }
    return [this.#lesson(`param:${key}`, title, text, { n: recent.length, avgR: round2(baseline) }, { change, baseline: round2(baseline), reviewAt: this.state.studied + REVIEW_AFTER })];
  }

  // Judge earlier changes: keep what helped, roll back what didn't.
  #reviewChanges() {
    const out = [];
    for (const l of this.state.lessons) {
      if (l.status !== 'active' || !l.change || this.state.studied < l.reviewAt) continue;
      const since = this.state.journal.filter((t) => t.t > l.time);
      if (since.length < REVIEW_AFTER * 0.6) {
        l.reviewAt = this.state.studied + 5;
        continue;
      }
      const after = since.reduce((s, t) => s + t.r, 0) / since.length;
      if (after < l.baseline - 0.05) {
        for (const [k, { from }] of Object.entries(l.change)) this.state.params[k] = from;
        l.status = 'reverted';
        out.push(this.#lesson(`revert:${l.key}`, `Undid: ${l.title.toLowerCase()}`,
          `"${l.title}" didn't help: my trades averaged ${fmtR(after)} since, against ${fmtR(l.baseline)} before, so I've gone back to how I did it before.`,
          { n: since.length, avgR: round2(after) }));
      } else {
        l.status = 'kept';
        l.result = round2(after);
      }
    }
    return out;
  }

  #lesson(key, title, text, evidence, extra = {}) {
    const lesson = { id: `${Date.now().toString(36)}${(this.lessonSeq++).toString(36)}`, key, time: this.agent.env.clock.now(), studied: this.state.studied, title, text, evidence, status: extra.change ? 'active' : 'noted', ...extra };
    this.state.lessons.push(lesson);
    if (this.state.lessons.length > 40) this.state.lessons.shift();
    return lesson;
  }

  // ---- effects on the desk's rules ---------------------------------------------------------
  cooldownBars(base) {
    return Math.round(base * (this.state.params.cooldownMult || 1));
  }

  maxTrades(base) {
    const cap = this.state.params.maxTrades;
    return cap ? Math.min(base, cap) : base;
  }

  // ---- presentation ---------------------------------------------------------------------------
  adjustments({ includeForm = true } = {}) {
    const p = this.state.params;
    const out = [];
    const pctText = (x) => `${Math.round(Math.abs(x - 1) * 100)}%`;
    if (p.stopMult !== 1) out.push(`Stops ${pctText(p.stopMult)} ${p.stopMult > 1 ? 'wider' : 'tighter'} (same risk per trade)`);
    if (p.targetMult !== 1) out.push(`Profit targets ${pctText(p.targetMult)} ${p.targetMult > 1 ? 'further' : 'closer'}`);
    if (p.partialMult !== 1) out.push(`Partial profits ${pctText(p.partialMult)} ${p.partialMult < 1 ? 'sooner' : 'later'}`);
    if (p.trailMult !== 1) out.push(`Trailing stop ${pctText(p.trailMult)} ${p.trailMult < 1 ? 'tighter' : 'looser'}`);
    if (p.cooldownMult !== 1) out.push(`${p.cooldownMult}× longer break after a loss`);
    if (p.maxTrades) out.push(`At most ${p.maxTrades} trades a day`);
    for (const k of Object.keys(this.state.avoid)) out.push(`Sitting out ${FEATURE_LABELS[k] || k} (small test trades only)`);
    const ff = includeForm ? this.formFactor() : 1;
    if (ff < 0.97) out.push(`Trading ${Math.round((1 - ff) * 100)}% smaller while my recent trades are losing`);
    else if (ff > 1.03) out.push(`Trading ${Math.round((ff - 1) * 100)}% bigger while my recent trades are working`);
    return out;
  }

  summary() {
    const last = this.state.lessons[this.state.lessons.length - 1];
    return {
      studied: this.state.studied,
      lessons: this.state.lessons.length,
      adjustments: this.adjustments({ includeForm: false }).length,
      last: last ? { title: last.title, time: last.time } : null,
    };
  }

  view() {
    const features = Object.keys(this.state.features)
      .map((k) => {
        const s = this.stat(k);
        return { key: k, label: FEATURE_LABELS[k] || k, n: Math.round(s.n * 10) / 10, avgR: round2(s.raw), otherR: round2(s.rest), effect: round2(this.featureFactor(s)), avoided: !!this.state.avoid[k] };
      })
      .sort((a, b) => a.avgR - b.avgR);
    const recent = this.state.journal.slice(-WINDOW);
    return {
      enabled: this.enabled,
      studied: this.state.studied,
      form: round2(this.formFactor()),
      recentAvgR: recent.length ? round2(recent.reduce((s, t) => s + t.r, 0) / recent.length) : null,
      adjustments: this.adjustments(),
      lessons: this.state.lessons.slice().reverse(),
      features,
      params: { ...this.state.params },
    };
  }

  // One line for the spoken briefing about the latest thing learned.
  briefingLine() {
    const l = [...this.state.lessons].reverse().find((x) => x.status !== 'reverted' || x.key.startsWith('revert:'));
    if (!l) return this.state.studied >= 10 ? `I've studied my last ${this.state.studied} trades and nothing needs changing yet.` : null;
    const first = l.text.split(/(?<=\.)\s/)[0];
    return `Something I've learned: ${first.startsWith('I ') ? first : first[0].toLowerCase() + first.slice(1)}`;
  }

  reset() {
    this.state = freshState();
    this.open.clear();
    this.watch = [];
  }

  serialize() {
    return this.state;
  }

  restore(saved) {
    if (!saved || saved.version !== LEARNING_VERSION) return;
    this.state = { ...freshState(), ...saved, params: { ...freshState().params, ...saved.params } };
  }
}
