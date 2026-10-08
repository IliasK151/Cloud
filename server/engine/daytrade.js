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
  // The shift candle's body, at least this many ATRs (0: any close through). 0.3, not the 0.5
  // first chosen: on real history it took the tested desks from 0.83 to 1.08 trades a day
  // (quiet weekdays from 43% to 34%) for about the same total R and the same drawdown.
  disp: 0.3,
  gap: 1, // 1: the move off the sweep must leave a fair value gap
  stopBuf: 0.2, // the stop's distance beyond the sweep's extreme, in ATRs
  maxPerDay: 1, // trades a day
  beAt: 0, // stop to breakeven at this many R (0: never)
  zones: 'london,ny', // the killzones (see KILLZONES)
  sweepKz: 0, // 1: the sweep itself must come inside a killzone (the open's stop run)
  maxCostR: null, // skip a setup whose spread and commission would eat more than this, in R
  // The A+ zone entry (the boss's own playbook), alongside the sweep: in the bias's direction,
  // price trades into a weekly or daily area of interest and a candle on zoneTf rejects it
  // (an engulfing or a pin bar). In at once, the stop beyond the rejection, the target the
  // liquidity on the other side at zoneRR or more. 0: off.
  zone: 0,
  zoneTf: 'M15',
  zoneRR: 2,
};

// New York time, minutes since midnight.
export const KILLZONES = {
  london: { id: 'london', label: 'London open', from: 2 * 60, to: 5 * 60 },
  ny: { id: 'ny', label: 'New York open', from: 7 * 60, to: 11 * 60 },
  // The whole sessions: London until New York opens, New York until lunch, or its whole day.
  londonday: { id: 'londonday', label: 'London session', from: 2 * 60, to: 7 * 60 },
  nyday: { id: 'nyday', label: 'New York session', from: 7 * 60, to: 12 * 60 },
  nyfull: { id: 'nyfull', label: 'New York session', from: 7 * 60, to: 14 * 60 },
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

const aoiName = (z) => `${z.both ? 'weekly + daily' : z.tf === 'W' ? 'weekly' : 'daily'} AOI`;
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
    this.stats = { days: 0, biasDays: 0, sweeps: 0, deep: 0, stale: 0, shifts: 0, outside: 0, busy: 0, weak: 0, noGap: 0, located: 0, noTarget: 0, costly: 0, orders: 0, zoneTouches: 0, zoneBroken: 0, zoneWide: 0, zoneOrders: 0 };
    this.reset();
  }

  reset() {
    this.levels = new Map(); // key → { label, price, side, dead, swept }
    this.sweep = { LONG: null, SHORT: null }; // the live sweep each side is watching
    this.pending = null; // the order waiting for its fill
    this.trades = 0;
    this.lastSetup = null;
    this.why = 'Waiting for the day to start';
    // The day so far, for story(): the funnel at the start of the day, the bias it had, the
    // last level swept against it and the setups cancelled.
    this.dayStart = { ...this.stats };
    this.dayBias = null;
    this.daySwept = null;
    this.dayCancels = [];
    // The zone entry: zones already tried today, the zone price is in now.
    this.zoneUsed = new Set();
    this.zoneTouch = null;
    this.zoneSeq = null;
  }

  // A closed 1-minute bar, after the book has it. Returns a new order { side, entry, stop,
  // target, market, reason, ... } when a setup completes, otherwise null.
  onBar(book, bar) {
    const R = this.rules;
    const ms = bar.time * 1000 + 60_000; // the bar's close
    const day = tradingDayOf(ms - 1);
    if (day !== this.day) {
      this.stats.days++;
      this.reset();
      this.day = day;
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
    this.dayBias = bias;
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
          this.daySwept = lv.label;
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

    // The A+ zone entry, alongside the sweep.
    if (R.zone) {
      const z = this.#zoneSetup(book, bar, read, bias, kz);
      if (z) return z;
    }

    const sw = this.sweep[side];
    if (!sw) return this.#idle(this.zoneTouch ? `${read.short}: ${long ? 'bullish' : 'bearish'} bias, price is in the ${aoiName(this.zoneTouch.z)} at ${this.fmt(this.zoneTouch.z.level)}, waiting for a ${R.zoneTf === 'M5' ? '5' : '15'}-minute rejection` : `${read.short}: ${long ? 'bullish' : 'bearish'} bias, waiting for price to run ${long ? 'a low' : 'a high'}`);

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

  // The A+ zone entry: price in a weekly or daily AOI on the bias side, then a candle that
  // rejects it. Each zone gets one try a day; a close well through it means the zone broke.
  #zoneSetup(book, bar, read, bias, kz) {
    const R = this.rules;
    const long = bias === 'LONG';
    for (const z of read.aois || []) {
      const key = `${z.tf}|${z.level}`;
      if (this.zoneUsed.has(key) || this.zoneTouch?.key === key) continue;
      if (long ? bar.low <= z.hi && bar.high >= z.lo : bar.high >= z.lo && bar.low <= z.hi) {
        this.zoneTouch = { key, z, at: bar.time, extreme: long ? bar.low : bar.high, candles: 0 };
        this.stats.zoneTouches++;
      }
    }
    const t = this.zoneTouch;
    if (!t) return null;
    t.extreme = long ? Math.min(t.extreme, bar.low) : Math.max(t.extreme, bar.high);
    const candles = book.candles(R.zoneTf);
    const c = candles.at(-1);
    if (!c || c.seq === this.zoneSeq) return null; // once per closed candle
    this.zoneSeq = c.seq;
    const span = (R.zoneTf === 'M5' ? 5 : 15) * MIN;
    if (c.time + span <= t.at) return null; // closed before price reached the zone
    const atr = atrOf(candles);
    if (!(atr > 0)) return null;
    const z = t.z;
    const drop = (stat) => {
      if (stat) this.stats[stat]++;
      this.zoneUsed.add(t.key);
      this.zoneTouch = null;
      return null;
    };
    if (long ? c.close < z.lo - 0.5 * atr : c.close > z.hi + 0.5 * atr) return drop('zoneBroken');
    const prev = candles.at(-2);
    const range = c.high - c.low;
    const engulf = !!prev && (long
      ? c.close > c.open && c.open <= bodyLo(prev) && c.close >= bodyHi(prev)
      : c.close < c.open && c.open >= bodyHi(prev) && c.close <= bodyLo(prev));
    const pin = range >= 0.5 * atr && (long ? bodyLo(c) - c.low >= 0.6 * range : c.high - bodyHi(c) >= 0.6 * range);
    const atZone = long ? c.low <= z.hi + 0.1 * atr : c.high >= z.lo - 0.1 * atr;
    if (!(engulf || pin) || !atZone) {
      if (++t.candles >= 4) this.zoneTouch = null; // no rejection within the hour: let it go
      return null;
    }
    // A rejection outside its window doesn't count, and doesn't use the zone up for the day.
    if (!kz) {
      this.zoneTouch = null;
      return null;
    }
    if (this.pending || this.trades >= R.maxPerDay) return drop();
    const entry = c.close;
    const stop = long ? Math.min(c.low, t.extreme) - R.stopBuf * atr : Math.max(c.high, t.extreme) + R.stopBuf * atr;
    const risk = Math.abs(entry - stop);
    if (!(risk > 0) || risk > 3 * atr) return drop('zoneWide');
    const cost = R.maxCostR && this.costR ? this.costR(entry, stop) : null;
    if (cost != null && cost > R.maxCostR) return drop('costly');
    const rr = (x) => Math.abs(x.price - entry) / risk;
    const tgt = this.#targets(book, read, long, entry, long ? c.high : c.low).find((x) => rr(x) >= R.zoneRR && rr(x) <= R.maxRR)
      || { label: `${R.zoneRR}R`, price: long ? entry + R.zoneRR * risk : entry - R.zoneRR * risk };
    const how = engulf ? 'engulfing' : 'pin bar';
    const order = {
      side: bias, entry, stop, target: tgt.price, market: true, risk, rr: rr(tgt), at: bar.time, zone: kz.id, model: 'zone',
      swept: aoiName(z), sweptPrice: z.level, extreme: t.extreme, targetLabel: tgt.label, bias: read.short,
      reason: `${read.short} ${long ? 'bullish' : 'bearish'} bias · ${kz.label}: rejection from the ${aoiName(z)} at ${this.fmt(z.level)} (${R.zoneTf === 'M5' ? '5' : '15'}-minute ${how}); target the ${lc(tgt.label)} (${rr(tgt).toFixed(1)}R)`,
    };
    order.entryText = this.fmt(entry);
    this.stats.zoneOrders++;
    this.lastSetup = order;
    this.zoneUsed.add(t.key);
    this.zoneTouch = null;
    this.why = `Setup: ${order.reason}`;
    return order;
  }

  #cancel(why) {
    this.pending = null;
    this.why = `Setup cancelled: ${why}`;
    this.dayCancels.push(why);
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

  // The desk's day so far in one line: how far its setup got, and why it hasn't traded.
  // `key` groups desks for the day's summary (DAY_STORY below).
  story(ms = Date.now()) {
    const R = this.rules;
    const read = this.read;
    // No bar yet on today's trading day: the market is closed (the weekend) or hasn't opened.
    if (!read || this.day !== tradingDayOf(ms)) return { key: 'closed', text: 'No prices yet today: its market is closed or hasn\'t opened' };
    if (this.trades) return { key: 'traded', text: `Took its trade${this.lastSetup ? `: ${this.lastSetup.reason}` : ''}` };
    if (this.pending) return { key: 'setup', text: `Setup waiting for the pullback to ${this.pending.entryText} (stop ${this.fmt(this.pending.stop)}, target ${this.fmt(this.pending.target)})` };
    if (this.dayCancels.length) return { key: 'cancelled', text: `Had a setup, cancelled: ${this.dayCancels.at(-1)}` };
    if (!read.ready) return { key: 'noread', text: `No top-down read yet: ${lc(read.text || 'not enough history behind it')}` };
    if (!this.biasSeen) return { key: 'nobias', text: `No bias today (${read.short}): the higher timeframes disagree, so no trade` };
    const d = {};
    for (const k of Object.keys(this.stats)) d[k] = this.stats[k] - (this.dayStart?.[k] ?? 0);
    const long = this.dayBias === 'LONG';
    const b = `${read.short}: ${long ? 'bullish' : 'bearish'} bias`;
    const lvl = this.daySwept ? `the ${lc(this.daySwept)}` : (long ? 'a low' : 'a high');
    const tf = R.tf === 'M15' ? '15' : '5';
    if (d.costly) return { key: 'costly', text: `${b}; swept ${lvl} and shifted, but the costs were too big for the stop` };
    if (d.noTarget) return { key: 'shiftno', text: `${b}; swept ${lvl} and shifted, but no liquidity ${R.minRR}R away to target` };
    if (d.weak || d.noGap || d.located) return { key: 'shiftno', text: `${b}; swept ${lvl} and shifted, but ${d.weak ? 'without a strong candle (no displacement)' : d.noGap ? 'the move left no fair value gap' : 'not in the right part of the daily range'}` };
    if (d.outside) return { key: 'outside', text: `${b}; swept ${lvl} and shifted, but outside its window (${zonesText(R.zones)} New York)` };
    // Where the day is against its window (the trading day starts at 18:00 New York).
    const since = (x) => (x - 18 * 60 + 1440) % 1440;
    const now = since(nyMinute(ms));
    const zones = String(R.zones).split(',').map((id) => KILLZONES[id.trim()]).filter(Boolean);
    const win = `${zonesText(R.zones)} New York`;
    const inWindow = zones.some((z) => now >= since(z.from) && now < since(z.from) + (z.to - z.from));
    const before = zones.length && now < Math.min(...zones.map((z) => since(z.from)));
    const over = !inWindow && !before;
    const run = long ? 'a low' : 'a high';
    const sw = this.sweep.LONG || this.sweep.SHORT;
    if (sw && !over) return { key: 'swept', text: `${b}; swept the ${lc(sw.level.label)}, waiting for the ${tf}-minute shift` };
    if (sw || d.stale) return { key: 'noshift', text: `${b}; swept ${lvl}, but no ${tf}-minute shift ${over ? 'in its window' : 'followed'}` };
    if (d.deep) return { key: 'breakdown', text: `${b}; price ran through ${lvl} and kept going (a breakdown, not a sweep)` };
    if (inWindow) return { key: 'watching', text: `${b}; in its window now (${win}), waiting for price to run ${run}` };
    if (before) return { key: 'waiting', text: `${b}; waiting for its window (${win}) and price to run ${run}` };
    return { key: 'nosweep', text: `${b}, but price didn't run ${run} for it to ${long ? 'buy' : 'sell'} after` };
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
