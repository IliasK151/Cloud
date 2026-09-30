import { ema, sma, atr, rsi, adx, stdev } from '../market/indicators.js';
import { nyParts } from '../market/session.js';

// Shared market context for research and for the live desks that trade its results.
// Everything here is causal (a value at bar i only uses bars ≤ i), so a backtest can't
// peek into the future and the live desk computes exactly what the backtest computed.

// Bars (objects) → typed columns.
export function toColumns(bars) {
  const n = bars.length;
  const cols = { n, t: new Float64Array(n), o: new Float64Array(n), h: new Float64Array(n), l: new Float64Array(n), c: new Float64Array(n), v: new Float64Array(n) };
  for (let i = 0; i < n; i++) {
    const b = bars[i];
    cols.t[i] = b.time; cols.o[i] = b.open; cols.h[i] = b.high; cols.l[i] = b.low; cols.c[i] = b.close; cols.v[i] = b.volume || 0;
  }
  return cols;
}

// New York minute-of-day per bar, computed once per hour (the offset only changes with DST).
export function nyMinutes(t) {
  const out = new Int16Array(t.length);
  let hourKey = NaN;
  let offset = 0;
  for (let i = 0; i < t.length; i++) {
    const hk = Math.floor(t[i] / 3600);
    if (hk !== hourKey) {
      hourKey = hk;
      const p = nyParts(t[i] * 1000);
      const utcMin = Math.floor((t[i] % 86400) / 60);
      offset = (((p.hour * 60 + p.minute) - utcMin) % 1440 + 1440) % 1440;
    }
    out[i] = (Math.floor((t[i] % 86400) / 60) + offset) % 1440;
  }
  return out;
}

// Per-1-minute-bar arrays the backtester needs: ATR for trailing stops, the session flatten
// window, news blackouts and pre-news flattening, and a trading-day index.
//   mode: 'sim' (cash session, flat from 15:55 NY) or 'live' (flat 16:50–18:00 NY, day rolls 18:00)
//   windows: [{ from, to, flatAt }] in epoch ms from the economic calendar
export function minuteContext(cols, { mode = 'live', windows = [] } = {}) {
  const n = cols.n;
  const barsObj = new Array(n);
  for (let i = 0; i < n; i++) barsObj[i] = { high: cols.h[i], low: cols.l[i], close: cols.c[i] };
  const atr1 = Float64Array.from(atr(barsObj, 14), (x) => (Number.isFinite(x) ? x : NaN));
  const nyMin = nyMinutes(cols.t);
  const flat = new Uint8Array(n);
  const blocked = new Uint8Array(n);
  const newsFlat = new Uint8Array(n);
  const day = new Int32Array(n);
  let d = 0;
  for (let i = 0; i < n; i++) {
    const m = nyMin[i];
    flat[i] = mode === 'sim' ? (m >= 955 || m < 570 ? 1 : 0) : m >= 1010 && m < 1080 ? 1 : 0;
    if (i > 0) {
      const gapped = cols.t[i] - cols.t[i - 1] > 3 * 3600;
      const rolled = mode === 'sim' ? nyMin[i] < nyMin[i - 1] : nyMin[i - 1] < 1080 && nyMin[i] >= 1080;
      if (gapped || rolled) d++;
    }
    day[i] = d;
  }
  if (windows.length) {
    const ws = [...windows].sort((a, b) => a.from - b.from);
    let k = 0;
    for (let i = 0; i < n; i++) {
      const t0 = cols.t[i] * 1000;
      const t1 = t0 + 60_000;
      while (k < ws.length && ws[k].to + 3 * 60_000 < t0) k++;
      for (let q = k; q < ws.length && ws[q].from < t1 + 30 * 60_000; q++) {
        const w = ws[q];
        if (t0 >= w.from && t0 < w.to) blocked[i] = 1;
        if (w.flatAt != null && t1 > w.flatAt && t0 < w.flatAt + 7 * 60_000) newsFlat[i] = 1;
      }
    }
  }
  return { ...cols, atr1, nyMin, flat, blocked, newsFlat, day };
}

// Higher-timeframe view of the minute bars. A timeframe bar is "complete" at the minute bar
// that closes its bucket; that is when both the backtest and the live desk evaluate it.
export class TfContext {
  constructor(cols, tf, nyMin = null) {
    this.tf = tf;
    const size = tf * 60;
    const t = [], o = [], h = [], l = [], c = [], v = [], last = [], complete = [], sess = [];
    let startMin = -1;
    for (let i = 0; i < cols.n; i++) {
      const bucket = Math.floor(cols.t[i] / size) * size;
      const k = t.length - 1;
      if (k < 0 || t[k] !== bucket) {
        t.push(bucket); o.push(cols.o[i]); h.push(cols.h[i]); l.push(cols.l[i]); c.push(cols.c[i]); v.push(cols.v[i]);
        last.push(i); complete.push(0);
        // Session start for VWAP: a gap of > 1 hour or the NY 09:30 open / 18:00 roll.
        const m = nyMin ? nyMin[i] : 0;
        const prevT = i > 0 ? cols.t[i - 1] : -Infinity;
        const newSession = cols.t[i] - prevT > 3600 || (nyMin && i > 0 && ((nyMin[i - 1] < 570 && m >= 570) || (nyMin[i - 1] < 1080 && m >= 1080)));
        if (newSession || startMin < 0) startMin = t.length - 1;
        sess.push(startMin);
      } else {
        h[k] = Math.max(h[k], cols.h[i]); l[k] = Math.min(l[k], cols.l[i]); c[k] = cols.c[i]; v[k] += cols.v[i];
        last[k] = i;
      }
      if ((cols.t[i] + 60) % size === 0) complete[t.length - 1] = 1;
    }
    this.n = t.length;
    this.t = t; this.o = o; this.h = h; this.l = l; this.c = c; this.v = v;
    this.last1m = last; this.complete = complete; this.sessStart = sess;
    this.bars = t.map((_, i) => ({ time: t[i], open: o[i], high: h[i], low: l[i], close: c[i], volume: v[i] }));
    this.cache = new Map();
  }

  #memo(key, fn) {
    let hit = this.cache.get(key);
    if (!hit) {
      hit = fn();
      this.cache.set(key, hit);
    }
    return hit;
  }

  ema(n) { return this.#memo(`ema${n}`, () => ema(this.c, n)); }
  sma(n) { return this.#memo(`sma${n}`, () => sma(this.c, n)); }
  atr(n = 14) { return this.#memo(`atr${n}`, () => atr(this.bars, n)); }
  rsi(n) { return this.#memo(`rsi${n}`, () => rsi(this.c, n)); }
  sd(n) { return this.#memo(`sd${n}`, () => stdev(this.c, n)); }
  adx(n = 14) { return this.#memo(`adx${n}`, () => adx(this.bars, n).adx); }

  // Highest high / lowest low of the n bars before i (excluding bar i).
  donHigh(n) {
    return this.#memo(`dh${n}`, () => {
      const out = new Array(this.n).fill(NaN);
      for (let i = n; i < this.n; i++) {
        let m = -Infinity;
        for (let j = i - n; j < i; j++) if (this.h[j] > m) m = this.h[j];
        out[i] = m;
      }
      return out;
    });
  }

  donLow(n) {
    return this.#memo(`dl${n}`, () => {
      const out = new Array(this.n).fill(NaN);
      for (let i = n; i < this.n; i++) {
        let m = Infinity;
        for (let j = i - n; j < i; j++) if (this.l[j] < m) m = this.l[j];
        out[i] = m;
      }
      return out;
    });
  }

  // Kaufman efficiency ratio: 1 = straight line, 0 = pure chop.
  er(n = 20) {
    return this.#memo(`er${n}`, () => {
      const out = new Array(this.n).fill(NaN);
      for (let i = n; i < this.n; i++) {
        let path = 0;
        for (let j = i - n + 1; j <= i; j++) path += Math.abs(this.c[j] - this.c[j - 1]);
        out[i] = path > 0 ? Math.abs(this.c[i] - this.c[i - n]) / path : 0;
      }
      return out;
    });
  }

  // Bollinger band width as a percentile of its own last `look` values (0 = tightest).
  bbwPct(n = 20, look = 100) {
    return this.#memo(`bbw${n}-${look}`, () => {
      const mid = this.sma(n);
      const sd = this.sd(n);
      const w = mid.map((m, i) => (m > 0 ? (4 * sd[i]) / m : NaN));
      const out = new Array(this.n).fill(NaN);
      for (let i = n + 10; i < this.n; i++) {
        let below = 0;
        let count = 0;
        for (let j = Math.max(0, i - look); j < i; j++) {
          if (!Number.isFinite(w[j])) continue;
          count++;
          if (w[j] < w[i]) below++;
        }
        out[i] = count >= 20 ? below / count : NaN;
      }
      return out;
    });
  }

  // Keltner squeeze: Bollinger(20, 2) inside Keltner(20, k). Returns run length and the
  // high/low of the current (or just-ended) squeeze box.
  squeeze(k) {
    return this.#memo(`sq${k}`, () => {
      const mid = this.sma(20);
      const sd = this.sd(20);
      const e = this.ema(20);
      const a = this.atr(20);
      const run = new Array(this.n).fill(0);
      const boxHi = new Array(this.n).fill(NaN);
      const boxLo = new Array(this.n).fill(NaN);
      let hi = -Infinity;
      let lo = Infinity;
      for (let i = 0; i < this.n; i++) {
        const on = Number.isFinite(sd[i]) && Number.isFinite(a[i]) && mid[i] + 2 * sd[i] < e[i] + k * a[i] && mid[i] - 2 * sd[i] > e[i] - k * a[i];
        if (on) {
          run[i] = (i > 0 ? run[i - 1] : 0) + 1;
          if (run[i] === 1) { hi = -Infinity; lo = Infinity; }
          hi = Math.max(hi, this.h[i]);
          lo = Math.min(lo, this.l[i]);
        }
        boxHi[i] = hi;
        boxLo[i] = lo;
      }
      return { run, boxHi, boxLo };
    });
  }

  // Session VWAP and its volume-weighted standard deviation.
  vwap() {
    return this.#memo('vwap', () => {
      const vw = new Array(this.n).fill(NaN);
      const sd = new Array(this.n).fill(NaN);
      let pv = 0, vol = 0, pv2 = 0, start = -1;
      for (let i = 0; i < this.n; i++) {
        if (this.sessStart[i] !== start) {
          start = this.sessStart[i];
          pv = 0; vol = 0; pv2 = 0;
        }
        const tp = (this.h[i] + this.l[i] + this.c[i]) / 3;
        const v = Math.max(this.v[i], 1e-9);
        pv += tp * v; pv2 += tp * tp * v; vol += v;
        vw[i] = pv / vol;
        sd[i] = Math.sqrt(Math.max(pv2 / vol - vw[i] ** 2, 0));
      }
      return { vw, sd, start: this.sessStart };
    });
  }

  // Market condition per bar: 1 = trending up, -1 = trending down, 2 = ranging, 3 = squeeze.
  regime() {
    return this.#memo('regime', () => {
      const er = this.er(20);
      const ax = this.adx(14);
      const bw = this.bbwPct(20, 100);
      const e = this.ema(20);
      const out = new Int8Array(this.n).fill(0);
      for (let i = 25; i < this.n; i++) {
        if (!Number.isFinite(er[i]) || !Number.isFinite(ax[i])) continue;
        if (er[i] >= 0.3 && ax[i] >= 20) out[i] = e[i] >= e[i - 5] ? 1 : -1;
        else if (Number.isFinite(bw[i]) && bw[i] <= 0.2) out[i] = 3;
        else out[i] = 2;
      }
      return out;
    });
  }
}

// The condition the market is in right now, in words (on 5-minute bars).
export function classifyRegime(bars1m) {
  const cols = toColumns(bars1m.slice(-2400));
  const tfc = new TfContext(cols, 5);
  const i = tfc.n - 1;
  if (i < 40) return { label: 'Not enough data', key: 'unknown', dir: 0 };
  const er = tfc.er(20)[i];
  const ax = tfc.adx(14)[i];
  const bw = tfc.bbwPct(20, 100)[i];
  const a = tfc.atr(14);
  const e = tfc.ema(20);
  const valid = a.filter(Number.isFinite);
  const sorted = [...valid].sort((x, y) => x - y);
  const volPct = sorted.length ? sorted.findIndex((x) => x >= a[i]) / sorted.length : 0.5;
  const dir = e[i] >= e[i - 5] ? 1 : -1;
  let key;
  if (er >= 0.3 && ax >= 20) key = dir > 0 ? 'trend-up' : 'trend-down';
  else if (Number.isFinite(bw) && bw <= 0.2) key = 'squeeze';
  else if (volPct >= 0.85) key = 'volatile';
  else key = 'range';
  const labels = { 'trend-up': 'Trending up', 'trend-down': 'Trending down', squeeze: 'Volatility squeeze', volatile: 'Volatile', range: 'Ranging' };
  return {
    key, label: labels[key], dir,
    er: Math.round(er * 100) / 100, adx: Math.round(ax), bbwPct: Number.isFinite(bw) ? Math.round(bw * 100) / 100 : null, volPct: Math.round(volPct * 100) / 100,
  };
}
