import { nyParts } from '../market/session.js';

// Top-down analysis, the way a discretionary trader reads a chart before any entry:
//
//   1. Bias from the weekly, daily and 4-hour market structure, read on candle bodies (closes),
//      not wicks. Bullish: higher highs and higher lows; bearish: lower highs and lower lows.
//      The trend only changes on a close through the protected level: below the higher low
//      (bullish → bearish) or above the lower high (bearish → bullish). A close through the
//      latest swing in the trend's direction is a break of structure (continuation).
//      Higher timeframes outrank lower ones: weekly and daily bullish with the 4-hour bearish
//      is still a bullish bias (the 4-hour is the retracement).
//   2. The area of interest (AOI): on the weekly and daily, a level price has turned at more
//      than once, inside the current range and on the right side of it (the lower half of a
//      bullish range, the upper half of a bearish one), never beyond the protected level.
//      Weekly and daily AOIs that overlap are the strongest.
//   3. Where the liquidity rests: the previous day's and week's high and low, and the Asia
//      and London session ranges. A day trader waits for price to run one of them against the
//      bias and turn (the sweep) before looking for an entry.
//
// One book per market, fed every closed 1-minute bar; the higher-timeframe candles are built
// as the minutes arrive, so reading it is cheap. Everything here is in New York time: the
// trading day rolls at 18:00 New York, the 4-hour candles start there too.

const MIN = 60_000;
const HOUR = 60 * MIN;
const DAY = 24 * HOUR;

// New York's offset from UTC for the hour containing `ms` (it only changes on the hour).
const offCache = new Map();
function nyOffset(ms) {
  const h = Math.floor(ms / HOUR);
  let off = offCache.get(h);
  if (off == null) {
    const p = nyParts(h * HOUR);
    off = Date.UTC(p.year, p.month - 1, p.day, p.hour, p.minute) - h * HOUR;
    if (offCache.size > 20_000) offCache.clear();
    offCache.set(h, off);
  }
  return off;
}

// New York wall-clock time of `ms` as a UTC-based number (so getUTC* read New York's fields).
const nyWall = (ms) => ms + nyOffset(ms);
// Minutes since New York midnight.
export const nyMinute = (ms) => {
  const w = nyWall(ms);
  return Math.floor((((w % DAY) + DAY) % DAY) / MIN);
};
// The trading day (rolls at 18:00 New York): New York's date six hours later.
export const tradingDayOf = (ms) => new Date(nyWall(ms) + 6 * HOUR).toISOString().slice(0, 10);
// The trading week: the Monday of the trading day's week (Saturday and Sunday, crypto's
// weekend days, belong to the week before them).
function weekOf(day) {
  const d = new Date(`${day}T00:00:00Z`);
  const back = (d.getUTCDay() + 6) % 7;
  return new Date(d.getTime() - back * DAY).toISOString().slice(0, 10);
}

// The timeframes this book keeps, and how a 1-minute bar's time maps to each one's candle.
// 4-hour candles start at 18:00 New York (18, 22, 02, 06, 10, 14).
export const TIMEFRAMES = {
  W: { label: 'weekly', keep: 120, k: 2, key: (ms) => weekOf(tradingDayOf(ms)) },
  D: { label: 'daily', keep: 400, k: 2, key: (ms) => tradingDayOf(ms) },
  H4: { label: '4-hour', keep: 600, k: 2, intraday: true, key: (ms) => Math.floor((nyWall(ms) - 18 * HOUR) / (4 * HOUR)) },
  H1: { label: 'hourly', keep: 600, k: 3, intraday: true, key: (ms) => Math.floor(ms / HOUR) },
  M15: { label: '15-minute', keep: 600, k: 2, intraday: true, key: (ms) => Math.floor(ms / (15 * MIN)) },
  M5: { label: '5-minute', keep: 900, k: 2, intraday: true, key: (ms) => Math.floor(ms / (5 * MIN)) },
};
const ORDER = ['W', 'D', 'H4'];

const bodyHi = (c) => Math.max(c.open, c.close);
const bodyLo = (c) => Math.min(c.open, c.close);

// Market structure on one timeframe, updated as each candle closes. Swings are confirmed
// `k` candles later (a swing high has k lower bodies on each side), on candle bodies.
export class Structure {
  constructor(k = 2) {
    this.k = k;
    this.trend = null; // 'bull' | 'bear' | null (not enough candles yet)
    this.sh = null; // the latest confirmed swing high { price, seq, time, broken }
    this.sl = null; // the latest confirmed swing low
    this.protLow = null; // bullish: the higher low that must hold
    this.protHigh = null; // bearish: the lower high that must hold
    this.extHigh = null; // bullish: the higher high (the most recent extreme)
    this.extLow = null; // bearish: the lower low
    this.since = null; // when the current trend began (a candle time, seconds)
    this.last = null; // the last event: { kind: 'bos' | 'shift', dir, price, time }
  }

  // `candles`: closed candles, oldest first, each with a running `seq`.
  update(candles) {
    const n = candles.length;
    const k = this.k;
    const c = candles[n - 1];
    const j = n - 1 - k;
    if (j >= k) {
      const p = candles[j];
      let hi = true;
      let lo = true;
      for (let i = 1; i <= k; i++) {
        if (!(bodyHi(p) > bodyHi(candles[j - i]) && bodyHi(p) >= bodyHi(candles[j + i]))) hi = false;
        if (!(bodyLo(p) < bodyLo(candles[j - i]) && bodyLo(p) <= bodyLo(candles[j + i]))) lo = false;
      }
      if (hi) this.sh = { price: bodyHi(p), seq: p.seq, time: p.time, broken: false };
      if (lo) this.sl = { price: bodyLo(p), seq: p.seq, time: p.time, broken: false };
    }
    if (this.trend === 'bull') this.extHigh = Math.max(this.extHigh, bodyHi(c));
    if (this.trend === 'bear') this.extLow = Math.min(this.extLow, bodyLo(c));
    // The lowest (highest) body between a swing and now: the pullback that the break leaves
    // behind it, the new higher low (lower high).
    const extreme = (fromSeq, fn, pick) => {
      let v = pick === 'min' ? Infinity : -Infinity;
      for (let i = n - 1; i >= 0 && candles[i].seq >= fromSeq; i--) v = pick === 'min' ? Math.min(v, fn(candles[i])) : Math.max(v, fn(candles[i]));
      return v;
    };
    // A close through the protected level shifts the trend.
    if (this.trend === 'bull' && this.protLow != null && c.close < this.protLow) {
      this.trend = 'bear';
      this.protHigh = this.extHigh;
      this.extLow = bodyLo(c);
      this.since = c.time;
      this.last = { kind: 'shift', dir: 'bear', price: this.protLow, time: c.time };
      if (this.sl && c.close < this.sl.price) this.sl.broken = true;
      return;
    }
    if (this.trend === 'bear' && this.protHigh != null && c.close > this.protHigh) {
      this.trend = 'bull';
      this.protLow = this.extLow;
      this.extHigh = bodyHi(c);
      this.since = c.time;
      this.last = { kind: 'shift', dir: 'bull', price: this.protHigh, time: c.time };
      if (this.sh && c.close > this.sh.price) this.sh.broken = true;
      return;
    }
    // A close through the latest swing: a break of structure in the trend's direction (or the
    // first trend). Internal swings against the trend don't change it: only the protected
    // level does.
    if (this.sh && !this.sh.broken && c.close > this.sh.price && this.trend !== 'bear') {
      this.sh.broken = true;
      const first = this.trend !== 'bull';
      this.protLow = extreme(this.sh.seq, bodyLo, 'min');
      this.extHigh = first ? bodyHi(c) : Math.max(this.extHigh, bodyHi(c));
      if (first) { this.trend = 'bull'; this.since = c.time; }
      this.last = { kind: first ? 'shift' : 'bos', dir: 'bull', price: this.sh.price, time: c.time };
    } else if (this.sh && !this.sh.broken && c.close > this.sh.price) this.sh.broken = true;
    if (this.sl && !this.sl.broken && c.close < this.sl.price && this.trend !== 'bull') {
      this.sl.broken = true;
      const first = this.trend !== 'bear';
      this.protHigh = extreme(this.sl.seq, bodyHi, 'max');
      this.extLow = first ? bodyLo(c) : Math.min(this.extLow, bodyLo(c));
      if (first) { this.trend = 'bear'; this.since = c.time; }
      this.last = { kind: first ? 'shift' : 'bos', dir: 'bear', price: this.sl.price, time: c.time };
    } else if (this.sl && !this.sl.broken && c.close < this.sl.price) this.sl.broken = true;
  }

  // The current dealing range: bullish [higher low, higher high], bearish [lower low, lower high].
  range() {
    if (this.trend === 'bull' && this.protLow != null) return { lo: this.protLow, hi: this.extHigh };
    if (this.trend === 'bear' && this.protHigh != null) return { lo: this.extLow, hi: this.protHigh };
    return null;
  }
}

// Average true range of the last `len` candles.
function atrOf(candles, len = 14) {
  if (candles.length < 2) return null;
  let sum = 0;
  let n = 0;
  for (let i = Math.max(1, candles.length - len); i < candles.length; i++) {
    const c = candles[i];
    const pc = candles[i - 1].close;
    sum += Math.max(c.high - c.low, Math.abs(c.high - pc), Math.abs(c.low - pc));
    n++;
  }
  return n ? sum / n : null;
}

// Areas of interest on one timeframe: levels the bodies turned at two or more times, inside
// the structure's range, on the side the trend trades from (bullish: the lower half, above the
// higher low; bearish: the upper half, below the lower high).
function aoisOf(candles, st, tol, tf) {
  const r = st.range();
  if (!r || !(tol > 0) || r.hi <= r.lo) return [];
  const mid = (r.lo + r.hi) / 2;
  const pts = [];
  const k = 2;
  const from = Math.max(k, candles.length - 160);
  for (let j = from; j < candles.length - k; j++) {
    const p = candles[j];
    let hi = true;
    let lo = true;
    for (let i = 1; i <= k; i++) {
      if (!(bodyHi(p) > bodyHi(candles[j - i]) && bodyHi(p) >= bodyHi(candles[j + i]))) hi = false;
      if (!(bodyLo(p) < bodyLo(candles[j - i]) && bodyLo(p) <= bodyLo(candles[j + i]))) lo = false;
    }
    if (hi) pts.push(bodyHi(p));
    if (lo) pts.push(bodyLo(p));
  }
  pts.sort((a, b) => a - b);
  const out = [];
  let group = [];
  const flush = () => {
    if (group.length >= 2) {
      const level = group.reduce((s, x) => s + x, 0) / group.length;
      const zone = { lo: Math.min(...group) - tol * 0.25, hi: Math.max(...group) + tol * 0.25, level, touches: group.length, tf };
      const inside = st.trend === 'bull' ? level > r.lo && level <= mid : level < r.hi && level >= mid;
      if (inside) {
        // Never beyond the protected level: below the higher low the market is bearish.
        if (st.trend === 'bull') zone.lo = Math.max(zone.lo, r.lo);
        else zone.hi = Math.min(zone.hi, r.hi);
        out.push(zone);
      }
    }
    group = [];
  };
  for (const x of pts) {
    if (group.length && x - group[0] > tol) flush();
    group.push(x);
  }
  flush();
  return out;
}

// The liquidity a day trader watches: session ranges per trading day, in New York time.
// Asia 19:00–02:00, London 02:00–07:00, New York 07:00–16:00.
const SESSIONS = [
  { id: 'asia', label: 'Asia', from: 19 * 60, to: 2 * 60 },
  { id: 'london', label: 'London', from: 2 * 60, to: 7 * 60 },
  { id: 'newyork', label: 'New York', from: 7 * 60, to: 16 * 60 },
];
function sessionOf(minute) {
  for (const s of SESSIONS) {
    if (s.from < s.to ? minute >= s.from && minute < s.to : minute >= s.from || minute < s.to) return s.id;
  }
  return null;
}

export class TopDownBook {
  constructor(symbol) {
    this.symbol = symbol;
    this.lastTime = -Infinity;
    this.tf = {};
    for (const [id, def] of Object.entries(TIMEFRAMES)) this.tf[id] = { def, candles: [], cur: null, seq: 0, st: new Structure(def.k) };
    // Per trading day: the day's and each session's high and low (with when they were made).
    this.days = new Map();
    this.cache = null;
  }

  // One closed 1-minute bar { time (s), open, high, low, close }. Bars must come in time order;
  // repeats and late ones are skipped.
  feed(bar) {
    if (!bar || !(bar.time > this.lastTime) || !Number.isFinite(bar.close)) return;
    this.lastTime = bar.time;
    const ms = bar.time * 1000;
    for (const t of Object.values(this.tf)) {
      const key = t.def.key(ms);
      if (t.cur && t.cur.key !== key) this.#close(t);
      if (!t.cur) t.cur = { key, time: bar.time, open: bar.open, high: bar.high, low: bar.low, close: bar.close };
      else {
        t.cur.high = Math.max(t.cur.high, bar.high);
        t.cur.low = Math.min(t.cur.low, bar.low);
        t.cur.close = bar.close;
      }
      // The candle's last minute: it is closed now, not when the next one starts.
      if (t.def.intraday && t.def.key(ms + MIN) !== key) this.#close(t);
    }
    // Session ranges.
    const day = tradingDayOf(ms);
    let d = this.days.get(day);
    if (!d) {
      d = { day, hi: -Infinity, lo: Infinity, sessions: {} };
      this.days.set(day, d);
      if (this.days.size > 12) this.days.delete(this.days.keys().next().value);
    }
    if (bar.high > d.hi) { d.hi = bar.high; d.hiTime = bar.time; }
    if (bar.low < d.lo) { d.lo = bar.low; d.loTime = bar.time; }
    const sid = sessionOf(nyMinute(ms));
    if (sid) {
      const s = (d.sessions[sid] ||= { hi: -Infinity, lo: Infinity, end: 0 });
      if (bar.high > s.hi) { s.hi = bar.high; s.hiTime = bar.time; }
      if (bar.low < s.lo) { s.lo = bar.low; s.loTime = bar.time; }
      s.end = bar.time + 60;
    }
    this.lastPrice = bar.close;
    this.cache = null;
  }

  #close(t) {
    t.cur.seq = ++t.seq;
    t.candles.push(t.cur);
    if (t.candles.length > t.def.keep) t.candles.shift();
    t.st.update(t.candles);
    t.cur = null;
  }

  // Closed candles of one timeframe (oldest first).
  candles(tf) {
    return this.tf[tf].candles;
  }

  // The read: bias, structure per timeframe, AOIs and where price is. The structure only
  // changes when a 4-hour, daily or weekly candle closes, so that part is kept until one does.
  read() {
    if (this.cache) return this.cache;
    const key = `${this.tf.W.seq}|${this.tf.D.seq}|${this.tf.H4.seq}`;
    if (this.frame?.key !== key) this.frame = { key, ...this.#frame() };
    const { tfs, bias, strength, known, dr, aois: all, atrD } = this.frame;
    const price = this.lastPrice;
    let zone = null;
    if (dr && Number.isFinite(price) && dr.hi > dr.lo) {
      const pos = (price - dr.lo) / (dr.hi - dr.lo);
      zone = { pos, word: pos < 0.45 ? 'discount' : pos > 0.55 ? 'premium' : 'equilibrium' };
    }
    const aois = [...all].sort((a, b) => Math.abs(a.level - price) - Math.abs(b.level - price)).slice(0, 4);
    const inAoi = aois.find((a) => price >= a.lo && price <= a.hi) || null;
    const arrow = (id) => (tfs[id].trend === 'bull' ? '↑' : tfs[id].trend === 'bear' ? '↓' : '–');
    const short = ORDER.map((id) => `${id === 'H4' ? '4H' : id} ${arrow(id)}`).join(' · ');
    const ready = !!tfs.D.trend && !!tfs.H4.trend;
    const text = !ready
      ? `Reading the higher timeframes (${this.tf.D.candles.length} daily and ${this.tf.H4.candles.length} 4-hour candles so far)`
      : bias
        ? `${short}: ${bias === 'LONG' ? 'bullish' : 'bearish'} bias${strength === 3 ? ', every timeframe agrees' : ''}${zone ? `, price in the ${zone.word} of the daily range` : ''}${inAoi ? `, inside the ${inAoi.both ? 'weekly + daily' : inAoi.tf === 'W' ? 'weekly' : 'daily'} AOI` : ''}`
        : `${short}: no clear bias`;
    this.cache = { ready, bias, strength, of: known, tfs, zone, aois, inAoi, atrD, price, text, short };
    return this.cache;
  }

  #frame() {
    const tfs = {};
    for (const id of ORDER) {
      const t = this.tf[id];
      const st = t.st;
      // Weekly structure needs some weeks behind it; the others a few swings.
      const enough = t.candles.length >= (id === 'W' ? 8 : 12);
      tfs[id] = {
        id, label: t.def.label, candles: t.candles.length,
        trend: enough ? st.trend : null,
        range: enough ? st.range() : null,
        last: st.last,
        since: st.since,
      };
    }
    // Score: the majority, higher timeframes outranking lower ones.
    const known = ORDER.filter((id) => tfs[id].trend);
    let bias = null;
    let strength = 0;
    if (known.length) {
      const bull = known.filter((id) => tfs[id].trend === 'bull').length;
      const bear = known.length - bull;
      if (bull !== bear) bias = bull > bear ? 'LONG' : 'SHORT';
      else bias = tfs[known[0]].trend === 'bull' ? 'LONG' : 'SHORT'; // a tie: the highest timeframe decides
      const want = bias === 'LONG' ? 'bull' : 'bear';
      strength = known.filter((id) => tfs[id].trend === want).length;
    }
    // The dealing range the bias trades in: the daily's (the weekly's while the daily has none).
    const dr = tfs.D.range || tfs.W.range;
    // AOIs on the weekly and daily, in the bias's direction.
    const atrD = atrOf(this.tf.D.candles) || null;
    const aois = [];
    if (bias && atrD) {
      for (const id of ['W', 'D']) {
        const t = this.tf[id];
        if (!tfs[id].trend || (tfs[id].trend === 'bull') !== (bias === 'LONG')) continue;
        aois.push(...aoisOf(t.candles, t.st, (id === 'W' ? 0.6 : 0.35) * atrD, id));
      }
      // Weekly and daily zones that overlap: the strongest.
      for (const a of aois) a.both = aois.some((b) => b !== a && b.tf !== a.tf && b.lo <= a.hi && a.lo <= b.hi);
    }
    return { tfs, bias, strength, known: known.length, dr, aois, atrD };
  }

  // Where the stops rest now: the previous week's and day's high and low, and today's Asia and
  // London ranges (and the previous day's New York range). Each says whether it has been taken.
  liquidity(nowMs) {
    if (this.liq?.ms === nowMs && this.liq.at === this.lastTime) return this.liq.out;
    const day = tradingDayOf(nowMs);
    const days = [...this.days.keys()];
    const today = this.days.get(day);
    const prevKey = days.filter((d) => d < day).at(-1);
    const prev = prevKey ? this.days.get(prevKey) : null;
    const out = [];
    const add = (label, price, side, formed) => {
      if (!Number.isFinite(price) || !Number.isFinite(formed)) return;
      // Taken: today's range has traded through it since it formed.
      let taken = false;
      if (today && formed < (today.loTime ?? Infinity) + 1 && side === 'below') taken = today.lo < price;
      if (today && formed < (today.hiTime ?? Infinity) + 1 && side === 'above') taken = today.hi > price;
      out.push({ label, price, side, formed, taken });
    };
    if (prev) {
      add('Previous day high', prev.hi, 'above', prev.hiTime);
      add('Previous day low', prev.lo, 'below', prev.loTime);
    }
    const W = this.tf.W.candles.at(-1);
    if (W) {
      add('Previous week high', W.high, 'above', W.time);
      add('Previous week low', W.low, 'below', W.time);
    }
    const asia = today?.sessions.asia;
    const nowMin = nyMinute(nowMs);
    const afterAsia = nowMin >= 2 * 60 && nowMin < 18 * 60;
    if (asia && afterAsia && asia.hi > -Infinity) {
      add('Asia high', asia.hi, 'above', asia.end);
      add('Asia low', asia.lo, 'below', asia.end);
    }
    const lon = today?.sessions.london;
    if (lon && nowMin >= 7 * 60 && nowMin < 18 * 60 && lon.hi > -Infinity) {
      add('London high', lon.hi, 'above', lon.end);
      add('London low', lon.lo, 'below', lon.end);
    }
    this.liq = { ms: nowMs, at: this.lastTime, out };
    return out;
  }
}

// One book per market, shared by every desk (env.topDown(symbol)). Fed by the market data's
// closed bars; seeded from the longest history on hand (the research store keeps months of the
// broker's own bars) so the weekly and daily structure is there from the start.
export class TopDownBooks {
  constructor({ md, history = null }) {
    this.md = md;
    this.history = history;
    this.books = new Map();
    this.from = new Map(); // symbol → the oldest bar the book was built from (seconds)
    md.on?.('bar', (id, bar) => this.books.get(id)?.feed(bar));
    // The market's prices moved to another level (MT5 took it over): read it again from there.
    md.on?.('rebase', (id) => this.books.delete(id));
    md.on?.('claim', (id) => this.books.delete(id));
  }

  get(symbol) {
    let book = this.books.get(symbol);
    const span = this.history?.ready ? this.history.span?.(symbol) : null;
    // (Re)build when there is older history than the book was built from: the store finishes
    // loading after the floor starts, and MT5 pages months of the broker's bars in later.
    if (!book || (span?.from != null && span.from < (this.from.get(symbol) ?? Infinity) - 3600)) {
      book = new TopDownBook(symbol);
      const h = span?.n ? this.history.bars(symbol) : this.md.bars(symbol);
      for (const b of h) book.feed(b);
      for (const b of this.md.bars(symbol)) book.feed(b);
      this.books.set(symbol, book);
      this.from.set(symbol, h[0]?.time ?? Infinity);
    }
    return book;
  }
}
