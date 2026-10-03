import { TraderAgent } from '../agent.js';
import { atr, ema, resample, closes, last } from '../../market/indicators.js';
import { nyMinuteOfDay, nyTimeOnSameDay } from '../../market/session.js';
import { SYMBOLS } from '../../market/symbols.js';

// The scalping desk, modelled on how AJ Currency (Adrian Mudronja) describes his trading in
// public: he started with smart-money concepts and moved to a purely liquidity-based way of
// trading. He reads the higher timeframes first for context even though he scalps, marks
// where the liquidity rests, trades the London session (his signals come at 8am London),
// waits for the "run of liquidity" that traps the breakout traders, and keeps a tight fixed
// stop (he quotes 20 pips on gold) for a high reward to risk.
//
// On the 1-minute chart, inside the desk's killzone:
//   1. context: the hourly trend (15-minute while history is short). With it, any pool will
//      do; against it, only a run of major liquidity (Asia, London, the previous day, the
//      killzone's opening range), and the committee weighs the trend as well;
//   2. liquidity: the Asia range, the previous day's high and low, the London range (for
//      the New York desks), the killzone's opening range, and equal highs and lows (the 5-
//      and 1-minute swings are mapped too, but traded only with pools: 'all');
//   3. the run: price trades through a pool, then closes back inside (the trap);
//   4. the shift: a 1-minute close back through the candle that made the run's extreme,
//      with displacement;
//   5. entry on the pullback to the middle of the move off the sweep (a limit, given up
//      after 8 minutes or if price jumps through it), stop beyond the run, never tighter than
//      10 spreads nor wider than the scalp stop;
//   6. target: the liquidity on the other side, at least 2R. Half off at 1R with the stop
//      to breakeven; out after 30 minutes if it isn't working and after 45 regardless.
//
// Tested on real 1-minute history with scripts/scalp-test.js (npm run scalp-test): entering
// at market right after the shift lost about 0.27R a trade; the pullback entry at major
// liquidity was about breakeven to slightly positive. A small sample: judge it live.

export const KILLZONES = {
  london: { name: 'London', open: 'London open', from: 2 * 60, to: 5 * 60, local: '07:00–10:00 London' },
  newyork: { name: 'New York', open: 'New York open', from: 8 * 60, to: 11 * 60, local: '08:00–11:00 New York' },
};
// The demo clock only runs New York's cash session (09:30–16:00), so there the London desks
// work its first two hours and the New York desks the two after.
export const SIM_KILLZONES = {
  london: { name: 'Demo morning', open: 'Session open', from: 9 * 60 + 30, to: 11 * 60 + 30, local: '09:30–11:30 New York on the demo clock' },
  newyork: { name: 'Demo late morning', open: 'Late morning', from: 11 * 60, to: 13 * 60, local: '11:00–13:00 New York on the demo clock' },
};

// The scalp stop in pips: 20 on gold is AJ's own number; the others follow the same idea.
// When the market moves faster than that, the stop may stretch to 1.5× the 1-minute ATR
// so the desk isn't stopped by noise; a deeper run than that is skipped, never chased.
export const SCALP_STOPS = {
  XAUUSD: { pip: 0.1, pips: 20 },
  GBPUSD: { pip: 0.0001, pips: 10 },
  EURUSD: { pip: 0.0001, pips: 8 },
  USDJPY: { pip: 0.01, pips: 10 },
  NAS100: { pip: 1, pips: 20, unit: 'points' },
};

const SWEEP_WINDOW = 25; // the run must have started within the last 25 minutes
const SHIFT_WINDOW = 15; // and the structure must shift within 15 minutes of its extreme
const RETRACE_BARS = 8; // minutes to wait for the pullback entry
const MIN_RR = 2;
const DEFAULT_RR = 2.5;
const MAX_RR = 6;
const TIME_STOP_BARS = 30;
const MAX_HOLD_BARS = 45;
const PER_KILLZONE = 3;

const HOUR = 3_600_000;

// A pool's name inside a sentence: "the Asia low", "the previous day high".
const lc = (label) => (/^(Asia|London|New York|Session|Late)/.test(label) ? label : label.charAt(0).toLowerCase() + label.slice(1));

export class LiquidityScalp extends TraderAgent {
  static strategyName = 'Liquidity Scalp (AJ Currency style)';
  // perZone: scalps per killzone · extend: minutes the killzone runs past its usual end ·
  // sweepWindow / shiftWindow / retraceBars: the timing limits above, in minutes
  static RULES = { perZone: PER_KILLZONE, extend: 0, sweepWindow: SWEEP_WINDOW, shiftWindow: SHIFT_WINDOW, retraceBars: RETRACE_BARS };
  static strategyBlurb = 'Reads the higher timeframe first, marks the liquidity (Asia range, previous day, session highs and lows, equal highs and lows) and scalps the killzone: a run through a pool, a close back inside, a 1-minute structure shift with displacement, then in on the pullback to the middle of the move. Tight capped stop, target the liquidity on the other side, fast in and out.';

  constructor(profile, env) {
    super(profile, env);
    // How this desk scalps (profile.scalp overrides; scripts/scalp-test.js compares them on
    // real history).
    const o = profile.scalp || {};
    this.opt = {
      // The defaults won on real history (May 2014 gold and EURUSD, S&P futures; see the README):
      entry: o.entry || 'pullback', // pullback: the retrace to the middle of the move · auto: at once when the stop fits
      pools: o.pools || 'major', // major: Asia, London, previous day, opening range, equal highs/lows · all: + 5m/1m swings
      htf: o.htf || 'soft', // soft: against the trend only at major liquidity · strict: never against it
      minStopSpreads: o.minStopSpreads ?? 10, // the stop is at least this many spreads, so costs stay small
      timeStop: o.timeStop ?? TIME_STOP_BARS,
      minRR: o.minRR ?? MIN_RR,
      defaultRR: o.defaultRR ?? DEFAULT_RR,
    };
    this.used = new Set();
    this.perZone = new Map();
    this.pending = null;
    this.ctx = { pools: [], htf: { bias: 'NEUTRAL', text: '' }, kz: null, last: null };
  }

  // ---- the map --------------------------------------------------------------------------
  #killzone(now) {
    const zone = this.profile.scalp?.killzone === 'newyork' ? 'newyork' : 'london';
    const def = (this.session.mode === 'sim' ? SIM_KILLZONES : KILLZONES)[zone];
    const at = (min) => nyTimeOnSameDay(now, Math.floor(min / 60), min % 60);
    const m = nyMinuteOfDay(now);
    // After the 18:00 roll the next killzone belongs to the new trading day.
    const ext = this.rules.extend || 0;
    const to = def.to + ext;
    const local = ext ? `${def.local}, plus ${ext === 60 ? 'an hour' : `${ext} minutes`}` : def.local;
    return { ...def, local, start: at(def.from), end: at(to), active: m >= def.from && m < to, before: m < def.from || m >= 18 * 60, key: `${this.session.tradingDay(now)}|${def.name}` };
  }

  // The longest history on hand: the research store keeps days, the feed about 15 hours.
  #series() {
    const live = this.bars();
    const h = this.env.lab?.history;
    const long = h?.ready ? h.recent(this.symbol, 2400) : null;
    return long && long.length > live.length ? long : live;
  }

  #stopCap(a) {
    const spec = SCALP_STOPS[this.symbol] || { pip: SYMBOLS[this.symbol].tick * 10, pips: 10 };
    const fixed = spec.pips * spec.pip;
    const dist = Math.max(fixed, 1.5 * a);
    const unit = spec.unit || 'pips';
    return { dist, fixed, pip: spec.pip, unit, text: dist > fixed ? `${spec.pips} ${unit}, stretched to ${(dist / spec.pip).toFixed(0)} while the market is fast` : `${spec.pips} ${unit}` };
  }

  #pips(dist) {
    const spec = SCALP_STOPS[this.symbol] || { pip: SYMBOLS[this.symbol].tick * 10 };
    return (dist / spec.pip).toFixed(1);
  }

  // Higher-timeframe context: the hourly EMA's direction and where price sits against it.
  #context(B) {
    const h1 = resample(B, 60);
    const use = h1.length >= 24 ? { bars: h1, tf: 'hourly' } : { bars: resample(B, 15), tf: '15-minute' };
    if (use.bars.length < 22) return { bias: 'NEUTRAL', tf: use.tf, text: 'not enough history for the higher timeframe yet, so both ways' };
    const e = ema(closes(use.bars), 20);
    const slope = last(e) - last(e, 3);
    const price = last(use.bars).close;
    if (slope > 0 && price > last(e)) return { bias: 'LONG', tf: use.tf, text: `the ${use.tf} trend is up, so I buy the sell-side runs and only sell a run of major liquidity` };
    if (slope < 0 && price < last(e)) return { bias: 'SHORT', tf: use.tf, text: `the ${use.tf} trend is down, so I sell the buy-side runs and only buy a run of major liquidity` };
    return { bias: 'NEUTRAL', tf: use.tf, text: `the ${use.tf} chart has no clear trend, so both ways` };
  }

  // Where the stops rest. Each pool remembers when it formed: liquidity only counts while
  // no bar since then has traded through it.
  #pools(B, kz, a, now) {
    const sec = (ms) => Math.floor(ms / 1000);
    const out = [];
    const add = (side, price, label, formed) => {
      if (!Number.isFinite(price)) return;
      const twin = out.find((p) => p.side === side && Math.abs(p.price - price) < 0.2 * a);
      if (twin) return;
      out.push({ side, price, label, formed, major: !/swing|Equal/.test(label) });
    };
    const range = (fromSec, toSec) => {
      let hi = -Infinity;
      let lo = Infinity;
      let k = 0;
      for (const b of B) {
        if (b.time < fromSec || b.time >= toSec) continue;
        hi = Math.max(hi, b.high);
        lo = Math.min(lo, b.low);
        k++;
      }
      return k >= 15 ? { hi, lo } : null;
    };

    // The killzone's own opening range (its first 15 minutes).
    const orEnd = kz.start + 15 * 60_000;
    if (now >= orEnd) {
      const r = range(sec(kz.start), sec(orEnd));
      if (r) { add('above', r.hi, `${kz.open} high`, sec(orEnd)); add('below', r.lo, `${kz.open} low`, sec(orEnd)); }
    }
    if (this.session.mode !== 'sim') {
      // Asia (19:00–02:00 New York): the range London raids.
      const asiaEnd = nyTimeOnSameDay(now, 2, 0);
      const asia = now >= asiaEnd ? range(sec(asiaEnd - 7 * HOUR), sec(asiaEnd)) : null;
      if (asia) { add('above', asia.hi, 'Asia high', sec(asiaEnd)); add('below', asia.lo, 'Asia low', sec(asiaEnd)); }
      // London (02:00 until this killzone): the range New York raids.
      if (kz.from > 2 * 60) {
        const lon = range(sec(asiaEnd), sec(kz.start));
        if (lon) { add('above', lon.hi, 'London high', sec(kz.start)); add('below', lon.lo, 'London low', sec(kz.start)); }
      }
    }
    // The previous trading day's high and low (the last day that has bars).
    const dayStart = sec(this.session.dayStart(now));
    let i0 = -1;
    for (let i = B.length - 1; i >= 0; i--) if (B[i].time < dayStart) { i0 = i; break; }
    if (i0 > 30) {
      const prev = range(B[i0].time - 23 * 3600, B[i0].time + 1);
      if (prev) { add('above', prev.hi, 'Previous day high', dayStart); add('below', prev.lo, 'Previous day low', dayStart); }
    }
    // 5-minute swing highs and lows from the last few hours; two at the same price are
    // equal highs / lows, the most obvious stops on the chart.
    const b5 = resample(B.slice(-480), 5);
    const a5 = Math.max(a * 2.2, 1e-9);
    const highs = [];
    const lows = [];
    for (let i = 2; i < b5.length - 2; i++) {
      const b = b5[i];
      if (b.high > b5[i - 1].high && b.high > b5[i - 2].high && b.high >= b5[i + 1].high && b.high >= b5[i + 2].high) highs.push({ price: b.high, formed: b5[i + 2].time + 300 });
      if (b.low < b5[i - 1].low && b.low < b5[i - 2].low && b.low <= b5[i + 1].low && b.low <= b5[i + 2].low) lows.push({ price: b.low, formed: b5[i + 2].time + 300 });
    }
    const equal = (list, x) => list.some((y) => y !== x && Math.abs(y.price - x.price) <= 0.15 * a5);
    for (const [list, side, word] of [[highs, 'above', 'high'], [lows, 'below', 'low']]) {
      const eq = list.filter((x) => equal(list, x));
      for (const x of eq) add(side, x.price, `Equal ${word}s`, x.formed);
      for (const x of list.slice(-4)) add(side, x.price, `5m swing ${word}`, x.formed);
    }
    // The 1-minute swings of the last two hours: the stops a 1-minute scalper hunts.
    const n = B.length;
    for (let i = Math.max(4, n - 120); i < n - 4; i++) {
      const b = B[i];
      let hi = true;
      let lo = true;
      for (let k = 1; k <= 4; k++) {
        if (b.high <= B[i - k].high || b.high < B[i + k].high) hi = false;
        if (b.low >= B[i - k].low || b.low > B[i + k].low) lo = false;
      }
      if (hi) add('above', b.high, '1m swing high', B[i + 4].time + 60);
      if (lo) add('below', b.low, '1m swing low', B[i + 4].time + 60);
    }
    // Is the pool still there (no bar since it formed has traded through it)?
    for (const p of out) {
      p.takenAt = null;
      for (const b of B) {
        if (b.time < p.formed) continue;
        if (p.side === 'above' ? b.high > p.price : b.low < p.price) { p.takenAt = b.time; break; }
      }
    }
    return out;
  }

  // The structure a scalper watches right at the run: the candle that made the run's
  // extreme. A close back through it (the sweep candle engulfed) is the shift, and it keeps
  // the entry, and so the stop, close to the sweep.
  #shiftLevel(B, e, long) {
    const b = B[e];
    return b ? (long ? b.high : b.low) : null;
  }

  // The fair value gap the displacement left, newest first.
  #gap(B, e, long) {
    for (let k = B.length - 1; k >= e + 2; k--) {
      if (long && B[k].low > B[k - 2].high) return { top: B[k].low, bottom: B[k - 2].high };
      if (!long && B[k].high < B[k - 2].low) return { top: B[k - 2].low, bottom: B[k].high };
    }
    return null;
  }

  // A run through one of the pools on this side, trapped and followed by a shift.
  #setup(B, pools, side, a, kz, majorOnly = false) {
    const long = side === 'LONG';
    const n = B.length;
    const bar = B[n - 1];
    const kzStart = Math.floor(kz.start / 1000);
    const buf = Math.max(0.05 * a, SYMBOLS[this.symbol].tick);
    const progress = { swept: null, trapped: false, shifted: false, displaced: false };
    const majorPools = this.opt.pools === 'major';
    const mine = pools.filter((p) => p.side === (long ? 'below' : 'above') && p.takenAt != null && (!(majorOnly || majorPools) || p.major || (majorPools && /Equal/.test(p.label))))
      .sort((x, y) => Math.abs(x.price - bar.close) - Math.abs(y.price - bar.close));
    for (const p of mine) {
      const key = `${kz.key}|${p.label}|${p.price}`;
      if (this.used.has(key)) continue;
      // The run: the first bar through the pool, inside the killzone and recent.
      let j = -1;
      for (let i = n - 1; i >= 0 && B[i].time >= p.takenAt; i--) j = i;
      if (j < 0 || B[j].time < kzStart || j < n - this.rules.sweepWindow) continue;
      if (long ? B[j].low > p.price - buf : B[j].high < p.price + buf) {
        // Only a tick through: look for a real run later on.
        let k = -1;
        for (let i = j; i < n; i++) if (long ? B[i].low <= p.price - buf : B[i].high >= p.price + buf) { k = i; break; }
        if (k < 0) continue;
        j = k;
      }
      let e = j;
      for (let i = j; i < n; i++) if (long ? B[i].low < B[e].low : B[i].high > B[e].high) e = i;
      progress.swept ??= p;
      if (e >= n - 1) continue; // still running
      if (n - 1 - e > this.rules.shiftWindow) { this.used.add(key); continue; } // it ran and never turned
      // The trap: back inside the pool.
      if (long ? bar.close <= p.price : bar.close >= p.price) continue;
      progress.trapped = true;
      // The shift has to reclaim the pool too: price back inside and the run's candles taken out.
      const level = this.#shiftLevel(B, e, long);
      if (level == null) continue;
      const shift = long ? Math.max(level, p.price) : Math.min(level, p.price);
      if (long ? bar.close <= shift : bar.close >= shift) continue;
      // Only the first close through: a shift that happened a while ago is not chased.
      let earlier = false;
      for (let i = e + 1; i < n - 1; i++) if (long ? B[i].close > shift : B[i].close < shift) { earlier = true; break; }
      if (earlier) { this.used.add(key); continue; }
      progress.shifted = true;
      const gap = this.#gap(B, e, long);
      const body = Math.abs(bar.close - bar.open);
      const displaced = body >= 0.5 * a || bar.high - bar.low >= a || !!gap;
      if (!displaced) { this.used.add(key); continue; }
      progress.displaced = true;
      return { pool: p, key, extreme: long ? B[e].low : B[e].high, shift, gap, close: bar.close, progress };
    }
    return { progress };
  }

  #plan(s, side, a, pools, price) {
    const long = side === 'LONG';
    const spread = (price * SYMBOLS[this.symbol].spreadBps) / 1e4;
    const buf = Math.max(0.1 * a, 1.5 * spread);
    const cap = this.#stopCap(a);
    const minStop = Math.max(0.3 * a, this.opt.minStopSpreads * spread);
    let stop = long ? s.extreme - buf : s.extreme + buf;
    // In at once when the stop beyond the sweep fits the scalp stop. Otherwise wait for the
    // pullback to where it fits, as long as that is still the upper part of the move off
    // the sweep (deeper than that the trap has failed).
    let entry = price;
    let limit = false;
    if (this.opt.entry === 'pullback') {
      // The retrace to the middle of the move off the sweep (its equilibrium).
      const mid = s.extreme + 0.5 * (s.close - s.extreme);
      if (long ? price - mid >= 0.1 * a : mid - price >= 0.1 * a) { entry = mid; limit = true; }
      if (Math.abs(entry - stop) > cap.dist) return { skip: `the run went too deep for a scalp stop (${this.#pips(Math.abs(entry - stop))} ${cap.unit}, my limit is ${cap.text})` };
    } else if (Math.abs(price - stop) > cap.dist) {
      entry = long ? stop + 0.95 * cap.dist : stop - 0.95 * cap.dist;
      const leg = Math.abs(s.close - s.extreme);
      const depth = leg > 0 ? Math.abs(entry - s.extreme) / leg : 0;
      if (depth < 0.35) return { skip: `the run went too deep for a scalp stop (${this.#pips(Math.abs(price - stop))} ${cap.unit}, my limit is ${cap.text})` };
      limit = true;
    }
    if (Math.abs(entry - stop) < minStop) stop = long ? entry - minStop : entry + minStop;
    const risk = Math.abs(entry - stop);
    // Target: the next untouched liquidity on the other side, at least 2R away.
    const opp = pools.filter((q) => q.side === (long ? 'above' : 'below') && q.takenAt == null)
      .map((q) => ({ ...q, r: (long ? q.price - entry : entry - q.price) / risk }))
      .filter((q) => q.r >= this.opt.minRR && q.r <= MAX_RR)
      .sort((x, y) => x.r - y.r)[0];
    const dflt = this.opt.defaultRR;
    const target = opp ? opp.price : long ? entry + dflt * risk : entry - dflt * risk;
    return { entry, stop, target, limit, risk, targetText: opp ? `${lc(opp.label)} ${this.px(opp.price)}` : `${dflt}R` };
  }

  #take(side, p, reason) {
    const ok = this.openTrade({ side, stop: p.stop, target: p.target, reason, partialAt: 1, trail: null, timeStopBars: this.opt.timeStop });
    if (ok && this.ctx.kz) this.perZone.set(this.ctx.kz.key, (this.perZone.get(this.ctx.kz.key) || 0) + 1);
    return ok;
  }

  // ---- the tape -------------------------------------------------------------------------
  evaluate() {
    const B = this.#series();
    if (B.length < 90) return this.setStage('Mapping the liquidity');
    const now = this.env.clock.now();
    const a = last(atr(B.slice(-300), 14));
    if (!Number.isFinite(a) || a <= 0) return;
    const price = this.price();
    const kz = this.#killzone(now);
    const htf = this.#context(B);
    const pools = this.#pools(B, kz, a, now);
    this.ctx = { ...this.ctx, pools, htf, kz };

    // A scalp that turned into a hold is closed.
    const plan = this.plan;
    if (plan && plan.barsHeld >= MAX_HOLD_BARS) this.closeTrade(this.symbol, `Scalp time limit (${MAX_HOLD_BARS} min)`);

    if (this.pending) {
      this.pending.bars++;
      if (this.position()) this.pending = null;
      else if (!kz.active) this.#cancel('the killzone closed before the pullback');
      else if (this.pending.bars > this.rules.retraceBars) this.#cancel(`no pullback to the entry within ${this.rules.retraceBars} minutes`);
    }

    const count = this.perZone.get(kz.key) || 0;
    const room = count < this.rules.perZone;
    let found = null;
    let progress = { swept: null, trapped: false, shifted: false, displaced: false };
    if (kz.active && !this.position() && !this.pending && room) {
      for (const side of ['LONG', 'SHORT']) {
        const against = (side === 'LONG' && htf.bias === 'SHORT') || (side === 'SHORT' && htf.bias === 'LONG');
        if (against && this.opt.htf === 'strict') continue;
        const s = this.#setup(B, pools, side, a, kz, against);
        if (s.progress.swept && !progress.swept) progress = s.progress;
        if (!s.pool) continue;
        progress = s.progress;
        found = { ...s, side };
        break;
      }
    }

    if (found) {
      this.used.add(found.key);
      const long = found.side === 'LONG';
      const p = this.#plan(found, found.side, a, pools, price);
      const what = `${lc(found.pool.label)} ${this.px(found.pool.price)}`;
      if (p.skip) {
        this.setStage(`Skipped: ${p.skip}`);
      } else {
        const reason = `${kz.name} scalp: ran the ${what}, closed back inside and shifted structure; target the ${p.targetText}`;
        this.ctx.last = { side: found.side, pool: found.pool, plan: p, at: now };
        if (p.limit) {
          this.pending = { side: found.side, entry: p.entry, stop: p.stop, target: p.target, reason: `${reason} (entry on the pullback)`, bars: 0 };
          this.note(`${long ? 'Buy' : 'Sell'} setup on ${this.symbol}: ${lc(found.pool.label)} swept and structure shifted. Waiting for the pullback to ${this.px(p.entry)}, stop ${this.px(p.stop)}, target ${this.px(p.target)}`, 'setup');
          this.setup.armed = true;
        } else {
          this.#take(found.side, p, reason);
        }
      }
    }
    if (this.used.size > 400) this.used = new Set([...this.used].slice(-200));
    for (const k of this.perZone.keys()) if (this.perZone.size > 6) this.perZone.delete(k);

    this.#describe({ B, a, kz, htf, pools, price, count, room, progress });
  }

  onTickExtra(symbol, price) {
    const p = this.pending;
    if (!p || symbol !== this.symbol) return;
    if (this.position()) { this.pending = null; return; }
    const long = p.side === 'LONG';
    if (long ? price <= p.stop : price >= p.stop) return this.#cancel('price ran back through the sweep before the entry');
    if (long ? price >= p.target : price <= p.target) return this.#cancel('price ran to the target without a pullback');
    if (long ? price <= p.entry : price >= p.entry) {
      // Filled like a limit order: at the level or close to it. A jump well past the level
      // would put the entry next to the stop, so that one is let go.
      if (Math.abs(price - p.entry) > 0.2 * Math.abs(p.entry - p.stop)) return this.#cancel('price jumped through the entry');
      this.pending = null;
      this.#take(p.side, p, p.reason);
    }
  }

  #cancel(why) {
    if (!this.pending) return;
    this.pending = null;
    this.setup.armed = false;
    this.note(`Setup cancelled: ${why}`, 'setup');
  }

  onNewDay() {
    this.pending = null;
  }

  onFlatten() {
    this.pending = null;
  }

  #describe({ kz, htf, pools, price, count, room, progress, a }) {
    const cap = this.#stopCap(a);
    const live = pools.filter((p) => p.takenAt == null);
    const above = live.filter((p) => p.side === 'above' && p.price > price).sort((x, y) => x.price - y.price);
    const below = live.filter((p) => p.side === 'below' && p.price < price).sort((x, y) => y.price - x.price);
    this.setup = {
      ...this.setup,
      bias: this.pending ? this.pending.side : htf.bias,
      armed: !!this.pending || (kz.active && room && !this.position() && (above.length + below.length > 0)),
      levels: [
        ...above.slice(0, 2).map((p) => ({ label: `BSL · ${p.label}`, price: p.price })),
        ...below.slice(0, 2).map((p) => ({ label: `SSL · ${p.label}`, price: p.price })),
        ...(this.pending ? [{ label: 'Pullback entry', price: this.pending.entry }] : []),
      ],
      thesis: `${htf.text.charAt(0).toUpperCase()}${htf.text.slice(1)}. ${above[0] ? `Buy-side liquidity rests above ${this.px(above[0].price)} (${lc(above[0].label)})` : 'No untouched buy-side liquidity above'}, ${below[0] ? `sell-side below ${this.px(below[0].price)} (${lc(below[0].label)})` : 'none below'}. I scalp the ${kz.name} killzone (${kz.local}): a run through a pool that traps the breakout traders, a close back inside, a 1-minute structure shift with displacement, then in on the pullback to the middle of the move with a ${cap.text} stop, aiming for the liquidity on the other side.`,
      checklist: [
        { label: `Inside the ${kz.name} killzone (${kz.local})`, ok: kz.active },
        { label: `Higher timeframe read: ${htf.bias === 'NEUTRAL' ? 'no trend, both ways' : htf.bias === 'LONG' ? 'up, sells only at major liquidity' : 'down, buys only at major liquidity'}`, ok: true },
        { label: `Liquidity mapped (${above.length} above, ${below.length} below)`, ok: above.length + below.length > 0 },
        { label: progress.swept ? `Liquidity run: ${lc(progress.swept.label)}` : 'Liquidity run through a pool', ok: !!progress.swept },
        { label: 'Trap: closed back inside', ok: progress.trapped },
        { label: '1-minute structure shift with displacement', ok: progress.shifted && progress.displaced },
        { label: `Scalps this killzone: ${count} of ${this.rules.perZone}`, ok: room },
      ],
      confidence: Math.round(Math.min(90, (kz.active ? 25 : 0) + (htf.bias !== 'NEUTRAL' ? 15 : 5) + (progress.swept ? 20 : 0) + (progress.trapped ? 10 : 0) + (progress.shifted ? 10 : 0) + (progress.displaced ? 10 : 0))),
      indicators: { 'ATR(14) 1m': a, 'Scalp stop cap': cap.dist, 'Pools above': above.length, 'Pools below': below.length },
    };
    if (this.position()) this.setStage(`In a ${kz.name} scalp, working toward the liquidity`);
    else if (this.pending) this.setStage(`Waiting for the pullback to ${this.px(this.pending.entry)} to ${this.pending.side === 'LONG' ? 'buy' : 'sell'}`);
    else if (!kz.active) this.setStage(kz.before ? `Waiting for the ${kz.name} killzone (${kz.local})` : `Done for today: the ${kz.name} killzone (${kz.local}) is over`);
    else if (!room) this.setStage(`Done for this killzone (${this.rules.perZone} scalps)`);
    else if (progress.trapped) this.setStage(`${progress.swept.label} swept and trapped: waiting for the 1-minute shift`);
    else if (progress.swept) this.setStage(`${progress.swept.label} is being run: waiting for the close back inside`);
    else this.setStage(`${kz.name} killzone: watching ${above[0] ? this.px(above[0].price) : '—'} above and ${below[0] ? this.px(below[0].price) : '—'} below for the run`, 'quiet');
  }

  pitch() {
    const { kz, pools, htf } = this.ctx;
    if (!kz) return `I scalp ${this.symbol} the way AJ Currency trades: liquidity first, then a tight stop.`;
    const price = this.price();
    const live = pools.filter((p) => p.takenAt == null);
    const above = live.filter((p) => p.side === 'above' && p.price > price).sort((x, y) => x.price - y.price)[0];
    const below = live.filter((p) => p.side === 'below' && p.price < price).sort((x, y) => y.price - x.price)[0];
    if (this.position()) return `I'm in a ${kz.name} scalp on ${this.symbol}: the liquidity got run, the breakout traders got trapped, structure shifted, and I'm aiming for the liquidity on the other side.`;
    if (this.pending) return `I have a ${this.pending.side === 'LONG' ? 'buy' : 'sell'} setup on ${this.symbol}: liquidity swept and structure shifted. I'm waiting for the pullback to ${this.px(this.pending.entry)} with a tight stop at ${this.px(this.pending.stop)}.`;
    const map = `The liquidity I'm watching: ${above ? `${lc(above.label)} at ${this.px(above.price)} above` : 'nothing untouched above'} and ${below ? `${lc(below.label)} at ${this.px(below.price)} below` : 'nothing untouched below'}.`;
    const when = kz.active ? `We're in the ${kz.name} killzone now` : kz.before ? `My window is the ${kz.name} killzone, ${kz.local}` : `The ${kz.name} killzone is over for today, so no more scalps until tomorrow`;
    return `I scalp ${this.symbol} the way AJ Currency trades: ${htf.text}. ${map} ${when}. I wait for one side to be run, the close back inside and the shift, then I'm in with a tight stop and out fast.`;
  }
}
