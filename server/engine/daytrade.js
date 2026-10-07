import { nyMinute, tradingDayOf } from './topdown.js';

// The day trader's playbook (the way TJR and most ICT-style day traders work), on top of the
// top-down read (topdown.js):
//
//   1. Bias first: the weekly, daily and 4-hour structure. Only trades with it, never against.
//   2. Liquidity: the stops resting at the previous day's and week's high and low and the Asia
//      and London session ranges. In a bullish bias the trade comes after price runs the
//      sell-side (a low) and turns; in a bearish one, after it runs a high.
//   3. The sweep: price trades through the level and comes back. A run that keeps going (too
//      far past the level) is a breakdown, not a sweep, and is left alone.
//   4. The shift: on the 5-minute chart a candle closes through the last swing that led into
//      the sweep (a change of character) with displacement: a strong candle that leaves a fair
//      value gap behind it.
//   5. The entry: a limit order back in the gap (or the 50% of the move off the sweep), the
//      stop beyond the sweep's extreme, the target the liquidity on the other side, and only if
//      it pays at least 3R. Low risk, high reward: most trades lose small, the winners pay for
//      them several times over.
//   6. Only inside the killzones (the London and New York opens), at most one trade a day by
//      default, flat by the end of the New York session (the floor flattens at 16:50).

const MIN = 60;

// The rules. The defaults were chosen on 20 months of real 1-minute history (2018–2020) in
// six markets, judged on the months they weren't chosen on (see the README, "Day Trading
// Desk"); the others stay here so the replays can test them again on your own prices.
export const PLAYBOOK = {
  // Which bias counts: 'majority' (two of weekly / daily / 4-hour, the higher outranking the
  // lower), 'all' (all three agree) or 'daily' (the daily and the 4-hour agree).
  bias: 'majority',
  // Where price must be: 'none', 'discount' (buy in the lower half of the daily range, sell in
  // the upper half) or 'aoi' (inside a weekly or daily area of interest).
  location: 'none',
  tf: 'M5', // the timeframe the shift is read on (M5 or M15)
  entry: 'fvg', // 'fvg' (top of the gap), 'fvgmid' (middle of the gap), 'fib50', 'close' (at once)
  minRR: 3, // the least the target must pay, in R
  maxRR: 10, // further than this isn't a day trade's target
  noTarget: 'fixed', // no liquidity at minRR or more: 'fixed' (minRR) or 'skip'
  maxDepth: 5, // how far past the level the sweep may run, in the timeframe's ATRs
  shiftWithin: 120, // minutes from the sweep's extreme to the shift
  fillWithin: 60, // minutes the limit order waits
  disp: 0.5, // the shift candle's body, at least this many ATRs (0: any close through)
  gap: 1, // 1: the move off the sweep must leave a fair value gap
  stopBuf: 0.2, // the stop's distance beyond the sweep's extreme, in ATRs
  maxPerDay: 1, // trades a day
  beAt: 0, // stop to breakeven at this many R (0: never)
  zones: 'london,ny', // the killzones (see KILLZONES)
  sweepKz: 0, // 1: the sweep itself must come inside a killzone (the open's stop run)
  maxCostR: null, // skip a setup whose spread and commission would eat more than this, in R
};

// New York time, minutes since midnight.
export const KILLZONES = {
  london: { id: 'london', label: 'London open', from: 2 * 60, to: 5 * 60 },
  ny: { id: 'ny', label: 'New York open', from: 7 * 60, to: 11 * 60 },
  nyidx: { id: 'nyidx', label: 'New York open', from: 9 * 60 + 30, to: 11 * 60 + 30 },
  nypm: { id: 'nypm', label: 'New York afternoon', from: 13 * 60 + 30, to: 15 * 60 },
  asia: { id: 'asia', label: 'Asia open', from: 20 * 60, to: 23 * 60 },
  // Demo mode's clock only runs 09:30–16:00 New York: its morning is the killzone.
  demo: { id: 'demo', label: 'Demo session', from: 9 * 60 + 30, to: 15 * 60 },
};

// "02:00–05:00 New York" for a killzone list.
export function zonesText(zones) {
  const t = (m) => `${String(Math.floor(m / 60)).padStart(2, '0')}:${String(m % 60).padStart(2, '0')}`;
  return String(zones).split(',').map((id) => KILLZONES[id.trim()]).filter(Boolean).map((z) => `${z.label} ${t(z.from)}–${t(z.to)}`).join(', ');
}

// A level's name inside a sentence: "the Asia low", "the previous day high", "the 3R".
const lc = (label) => (/^(Asia|London|New York|\d)/.test(label) ? label : label.charAt(0).toLowerCase() + label.slice(1));

const bodyHi = (c) => Math.max(c.open, c.close);
const bodyLo = (c) => Math.min(c.open, c.close);

function atrOf(candles, len = 14) {
  const n = candles.length;
  if (n < 2) return null;
  let sum = 0;
  let k = 0;
  for (let i = Math.max(1, n - len); i < n; i++) {
    const c = candles[i];
    const pc = candles[i - 1].close;
    sum += Math.max(c.high - c.low, Math.abs(c.high - pc), Math.abs(c.low - pc));
    k++;
  }
  return k ? sum / k : null;
}

export function killzoneAt(zones, minute) {
  for (const id of String(zones).split(',')) {
    const z = KILLZONES[id.trim()];
    if (z && minute >= z.from && minute < z.to) return z;
  }
  return null;
}

export class DayPlaybook {
  // fmt: how prices are written in its messages (the desk's decimals). costR: (entry, stop) →
  // what the market's costs come to, in R (for maxCostR).
  constructor(rules = {}, fmt = null, costR = null) {
    this.rules = { ...PLAYBOOK, ...rules };
    this.fmt = fmt || ((x) => String(Number(x.toPrecision(6))));
    this.costR = costR;
    this.events = []; // cancelled setups since the desk last looked (it says so on the floor)
    this.day = null;
    // What happened, all along: days with a bias, sweeps, shifts and why they didn't trade.
    this.stats = { days: 0, biasDays: 0, sweeps: 0, deep: 0, stale: 0, shifts: 0, outside: 0, busy: 0, weak: 0, noGap: 0, located: 0, noTarget: 0, costly: 0, orders: 0 };
    this.reset();
  }

  reset() {
    this.levels = new Map(); // key → { label, price, side, dead, swept }
    this.sweep = { LONG: null, SHORT: null }; // the live sweep each side is watching
    this.pending = null; // the order waiting for its fill
    this.trades = 0;
    this.lastSetup = null;
    this.why = 'Waiting for the day to start';
  }

  // A closed 1-minute bar, after the book has it. Returns a new order { side, entry, stop,
  // target, market, reason, ... } when a setup completes, otherwise null.
  onBar(book, bar) {
    const R = this.rules;
    const ms = bar.time * 1000 + 60_000; // the bar's close
    const day = tradingDayOf(ms - 1);
    if (day !== this.day) {
      this.reset();
      this.day = day;
      this.stats.days++;
      this.biasSeen = false;
    }
    const read = book.read();
    this.read = read;
    const minute = nyMinute(ms - 1);
    const kz = killzoneAt(R.zones, minute);
    this.kz = kz;
    const candles = book.candles(R.tf);
    const atr = atrOf(candles);
    this.atr = atr;

    // The liquidity on the chart, as it forms. A level already traded through when it first
    // shows up isn't resting liquidity any more.
    for (const lv of book.liquidity(ms, { openingRange: /\bdemo\b/.test(R.zones) })) {
      const key = `${lv.label}|${lv.price}`;
      if (!this.levels.has(key)) this.levels.set(key, { label: lv.label, price: lv.price, side: lv.side, dead: lv.taken, swept: false });
    }

    // The pending order's own life.
    if (this.pending) {
      const p = this.pending;
      if (bar.time - p.at > R.fillWithin * MIN) this.#cancel(`no pullback to ${p.entryText} within ${R.fillWithin} minutes`);
      else if (!kz && p.zone && minute >= KILLZONES[p.zone].to + 30) this.#cancel(`the ${KILLZONES[p.zone].label} killzone is over`);
    }

    const bias = this.#bias(read);
    this.bias = bias;
    if (!read.ready) return this.#idle(read.text);
    if (!bias) return this.#idle(`${read.short}: no clear bias, no trade`);
    if (!this.biasSeen) { this.biasSeen = true; this.stats.biasDays++; }
    if (!(atr > 0)) return this.#idle('Building the 5-minute chart');

    // Sweeps: price trading through a level on the bias side (sell-side under a bullish bias).
    const side = bias;
    const long = side === 'LONG';
    for (const lv of this.levels.values()) {
      if (lv.dead || lv.swept || lv.side !== (long ? 'below' : 'above')) continue;
      if (long ? bar.low < lv.price : bar.high > lv.price) {
        lv.swept = true;
        if (R.sweepKz && !kz) continue;
        const s = this.sweep[side];
        const extreme = long ? bar.low : bar.high;
        // Several levels run at once: the sweep remembers the furthest one.
        if (!s || bar.time - s.at > R.shiftWithin * MIN || (long ? lv.price < s.level.price : lv.price > s.level.price)) {
          if (!s) this.stats.sweeps++;
          this.sweep[side] = { level: lv, at: bar.time, extremeAt: bar.time, extreme, refLevel: null };
        }
      }
    }
    const s = this.sweep[side];
    if (s) {
      if (long ? bar.low < s.extreme : bar.high > s.extreme) {
        s.extreme = long ? bar.low : bar.high;
        s.extremeAt = bar.time;
        s.refLevel = null;
      }
      const depth = (long ? s.level.price - s.extreme : s.extreme - s.level.price) / atr;
      if (depth > R.maxDepth) {
        this.sweep[side] = null;
        this.stats.deep++;
        this.why = `${s.level.label} broke (ran ${depth.toFixed(1)} ATR through it): a breakdown, not a sweep`;
      } else if (bar.time - s.extremeAt > R.shiftWithin * MIN) {
        this.sweep[side] = null;
        this.stats.stale++;
        this.why = `${s.level.label} was swept but structure never shifted`;
      }
    }

    const sw = this.sweep[side];
    if (!sw) return this.#idle(`${read.short}: ${long ? 'bullish' : 'bearish'} bias, waiting for price to run ${long ? 'a low' : 'a high'}`);

    // The shift, read on the shift timeframe's candles as each one closes.
    this.why = `Swept the ${lc(sw.level.label)}; waiting for the ${R.tf === 'M15' ? '15' : '5'}-minute shift${sw.refLevel != null ? ` (a close ${long ? 'above' : 'below'} ${this.fmt(sw.refLevel)})` : ''}`;
    const last = candles.at(-1);
    if (!last || last.seq === this.seenSeq) return null;
    this.seenSeq = last.seq;
    const iEx = candles.findLastIndex((c) => c.time <= sw.extremeAt);
    if (iEx < 2 || candles.length - 1 <= iEx) return null;
    if (sw.refLevel == null) sw.refLevel = refSwing(candles, iEx, long);
    if (sw.refLevel == null) return null;
    const shiftC = last;
    const broke = long ? shiftC.close > sw.refLevel : shiftC.close < sw.refLevel;
    if (!broke) return this.#idle(`Swept the ${lc(sw.level.label)}; waiting for the ${R.tf === 'M15' ? '15' : '5'}-minute shift (a close ${long ? 'above' : 'below'} ${this.fmt(sw.refLevel)})`);
    this.sweep[side] = null; // one look per sweep
    this.stats.shifts++;
    const body = Math.abs(shiftC.close - shiftC.open);
    const strong = body >= R.disp * atr && (long ? shiftC.close > shiftC.open : shiftC.close < shiftC.open);
    const gap = lastGap(candles, iEx, long);
    const what = `swept the ${lc(sw.level.label)} and shifted`;
    const no = (stat, why) => {
      this.stats[stat]++;
      return this.#idle(`Price ${what}, ${why}`);
    };
    if (!kz) return no('outside', 'outside the killzones: no trade');
    if (this.pending || this.trades >= R.maxPerDay) return no('busy', this.pending ? 'but a setup is already waiting' : 'but that was my trade for the day');
    if (!strong) return no('weak', 'but without displacement (no strong candle)');
    if (R.gap && !gap) return no('noGap', 'but left no fair value gap');
    if (!this.#located(read, long)) return no('located', `but it isn't in the ${R.location === 'aoi' ? 'area of interest' : long ? 'discount' : 'premium'} of the daily range`);

    // The plan.
    const price = shiftC.close;
    const legEnd = long ? Math.max(...candles.slice(iEx).map((c) => c.high)) : Math.min(...candles.slice(iEx).map((c) => c.low));
    const stop = long ? sw.extreme - R.stopBuf * atr : sw.extreme + R.stopBuf * atr;
    let entry = price;
    let market = R.entry === 'close';
    if (R.entry === 'fvg' && gap) entry = long ? gap.hi : gap.lo;
    else if (R.entry === 'fvgmid' && gap) entry = (gap.hi + gap.lo) / 2;
    else if (R.entry === 'fib50') entry = (sw.extreme + legEnd) / 2;
    else market = true;
    if (long ? entry >= price : entry <= price) { entry = price; market = true; }
    const risk = Math.abs(entry - stop);
    if (!(risk > 0)) return null;
    // Too expensive for its stop: the spread and commission would eat too much of the trade.
    const cost = R.maxCostR && this.costR ? this.costR(entry, stop) : null;
    if (cost != null && cost > R.maxCostR) {
      this.stats.costly++;
      return this.#idle(`Price ${what}, but costs would eat ${cost.toFixed(2)}R of the trade (the limit is ${R.maxCostR}R)`);
    }
    // The target: the liquidity on the other side that pays at least minRR (the nearest one).
    const opp = this.#targets(book, read, long, entry, legEnd);
    const rr = (x) => Math.abs(x.price - entry) / risk;
    let tgt = opp.find((x) => rr(x) >= R.minRR && rr(x) <= R.maxRR) || null;
    if (!tgt) {
      if (R.noTarget === 'skip') {
        this.stats.noTarget++;
        this.why = `Setup on ${sw.level.label}, but no liquidity ${R.minRR}R away to target`;
        return null;
      }
      tgt = { label: `${R.minRR}R`, price: long ? entry + R.minRR * risk : entry - R.minRR * risk };
    }
    const order = {
      side, entry, stop, target: tgt.price, market, risk,
      rr: rr(tgt), at: bar.time, zone: kz.id,
      swept: sw.level.label, sweptPrice: sw.level.price, extreme: sw.extreme, shiftLevel: sw.refLevel,
      targetLabel: tgt.label, bias: read.short,
      reason: `${read.short} ${long ? 'bullish' : 'bearish'} bias · ${kz.label}: swept the ${lc(sw.level.label)}, 5-minute shift with displacement; target the ${lc(tgt.label)} (${rr(tgt).toFixed(1)}R)`,
    };
    order.entryText = this.fmt(order.entry);
    this.stats.orders++;
    this.lastSetup = order;
    if (!market) this.pending = order;
    this.why = market ? `Setup: ${order.reason}` : `Setup: waiting for the pullback to the ${R.entry === 'fib50' ? '50%' : 'fair value gap'}`;
    return order;
  }

  // While an order waits: 'fill' when price comes back to the entry, 'cancel' when the setup
  // is gone (price ran back through the sweep, or straight to the target without it).
  touch(price) {
    const p = this.pending;
    if (!p) return null;
    const long = p.side === 'LONG';
    if (long ? price <= p.stop : price >= p.stop) return this.#cancel('price ran back through the sweep before the entry');
    if (long ? price >= p.target : price <= p.target) return this.#cancel('price ran to the target without a pullback');
    if (long ? price <= p.entry : price >= p.entry) {
      this.pending = null;
      return { kind: 'fill', order: p };
    }
    return null;
  }

  filled() { this.trades++; }

  #cancel(why) {
    this.pending = null;
    this.why = `Setup cancelled: ${why}`;
    const ev = { kind: 'cancel', why };
    this.events.push(ev);
    if (this.events.length > 20) this.events.shift();
    return ev;
  }

  #idle(why) {
    this.why = why;
    return null;
  }

  #bias(read) {
    if (!read.ready || !read.bias) return null;
    const want = read.bias === 'LONG' ? 'bull' : 'bear';
    const t = read.tfs;
    if (this.rules.bias === 'all') return read.strength === 3 && read.of === 3 ? read.bias : null;
    if (this.rules.bias === 'daily') return t.D.trend === want && t.H4.trend === want ? read.bias : null;
    return read.bias;
  }

  #located(read, long) {
    const L = this.rules.location;
    if (L === 'discount') return !read.zone || (long ? read.zone.pos < 0.5 : read.zone.pos > 0.5);
    if (L === 'aoi') return !!read.inAoi;
    return true;
  }

  // Liquidity on the far side, nearest first: untaken session and previous-day/week levels,
  // the 4-hour and daily range extremes.
  #targets(book, read, long, entry, legEnd) {
    const out = [];
    for (const lv of this.levels.values()) {
      if (lv.dead || lv.swept || lv.side !== (long ? 'above' : 'below')) continue;
      if (long ? lv.price > legEnd : lv.price < legEnd) out.push({ label: lv.label, price: lv.price });
    }
    for (const id of ['H4', 'D']) {
      const r = read.tfs[id].range;
      if (!r) continue;
      const p = long ? r.hi : r.lo;
      if (long ? p > legEnd : p < legEnd) out.push({ label: `${id === 'H4' ? '4-hour' : 'daily'} ${long ? 'high' : 'low'}`, price: p });
    }
    return out.sort((a, b) => Math.abs(a.price - entry) - Math.abs(b.price - entry));
  }

  // For the desk's card: what it is waiting for.
  view() {
    return {
      bias: this.bias, why: this.why, kz: this.kz?.label || null,
      sweep: this.sweep.LONG || this.sweep.SHORT,
      pending: this.pending, trades: this.trades,
      levels: [...this.levels.values()].filter((l) => !l.dead),
    };
  }
}

// The swing that led into the sweep: the last body high (bullish) before the extreme that
// stands above its neighbours, within the last two hours of candles.
function refSwing(candles, iEx, long) {
  const from = Math.max(1, iEx - 24);
  for (let i = iEx - 1; i >= from; i--) {
    const c = candles[i];
    const prev = candles[i - 1];
    const next = candles[i + 1];
    if (long ? bodyHi(c) >= bodyHi(prev) && bodyHi(c) >= bodyHi(next) : bodyLo(c) <= bodyLo(prev) && bodyLo(c) <= bodyLo(next)) {
      return long ? bodyHi(c) : bodyLo(c);
    }
  }
  return null;
}

// The latest fair value gap in the move off the sweep: three candles where the first's high
// stays under the third's low (bullish). { lo, hi } or null.
function lastGap(candles, iEx, long) {
  for (let i = candles.length - 1; i >= Math.max(2, iEx); i--) {
    const a = candles[i - 2];
    const c = candles[i];
    if (long && a.high < c.low) return { lo: a.high, hi: c.low };
    if (!long && a.low > c.high) return { lo: c.high, hi: a.low };
  }
  return null;
}
