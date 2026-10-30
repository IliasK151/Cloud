import { nyMinuteOfDay } from '../market/session.js';

// How the deep brain reads a market: the candles before an idea become tokens, the way a
// language model's input text becomes tokens.
//
// Four timeframes, six candles each, all ending at the moment of the idea: six 1-hour, six
// 15-minute, six 5-minute and six 1-minute candles (24 tokens; the idea itself is the 25th).
// The candles are rolled back from the idea, so the newest of each ends exactly then and
// nothing after the idea is ever read.
//
// Each candle becomes 8 numbers, all turned to the trade's side (for a short, down is the
// trade's way), so the brain learns "with the trade" rather than "up":
//   body, the wick in the trade's direction, the wick against it (a rejection), the range,
//   where it closed against the entry, its volume against its neighbours', and the time of
//   day (two numbers, so 23:59 sits next to 00:00).
// Sizes are measured in the market's own recent movement (the average 1-minute range, scaled
// up for longer candles), so gold, the yen and Bitcoin read alike.

export const TIMEFRAMES = [
  { tf: 60, n: 6, label: '1-hour' },
  { tf: 15, n: 6, label: '15-min' },
  { tf: 5, n: 6, label: '5-min' },
  { tf: 1, n: 6, label: '1-min' },
];
export const CANDLES = TIMEFRAMES.reduce((s, g) => s + g.n, 0);
export const SLOTS = CANDLES + 1; // the idea is the last slot
export const FEATS = 8;
export const LOOKBACK_MIN = Math.max(...TIMEFRAMES.map((g) => g.tf * g.n));

// The five experts, and which one each market starts with.
export const EXPERTS = ['Indices', 'FX', 'Gold', 'Oil', 'Crypto'];
const EXPERT_OF = { NAS100: 0, SPX500: 0, EURUSD: 1, GBPUSD: 1, USDJPY: 1, XAUUSD: 2, USOIL: 3, BTCUSD: 4, ETHUSD: 4, SOLUSD: 4 };
const CLASS_EXPERT = { Index: 0, FX: 1, Forex: 1, Metal: 2, Commodity: 3, Energy: 3, Crypto: 4 };
export function expertOf(symbol, assetClass = null) {
  return EXPERT_OF[symbol] ?? CLASS_EXPERT[assetClass] ?? 1;
}

const clamp = (x, lo, hi) => (Number.isFinite(x) ? Math.max(lo, Math.min(hi, x)) : 0);

// Index of the first bar at or after time t (seconds), in bars sorted by time.
export function lowerBound(bars, t) {
  let lo = 0;
  let hi = bars.length;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (bars[mid].time < t) lo = mid + 1;
    else hi = mid;
  }
  return lo;
}

// The candle tokens for an idea. bars: closed 1-minute bars, oldest first (time in seconds,
// each bar covering [time, time + 60)). end: index one past the last bar to read (default all).
// Returns { tok, slots, meta, scale } or null when there's too little to read.
export function candleTokens(bars, { side = 'LONG', entry = null, end = bars.length } = {}) {
  if (!bars?.length || end <= 0) return null;
  const last = bars[end - 1];
  const tEnd = last.time + 60;
  const from = lowerBound(bars, tEnd - LOOKBACK_MIN * 60);
  if (end - from < 30) return null;
  // The market's own movement: the average 1-minute range over the last hour of bars.
  let sum = 0;
  let k = 0;
  for (let i = Math.max(from, end - 60); i < end; i++) { sum += bars[i].high - bars[i].low; k++; }
  let s1 = k ? sum / k : 0;
  if (!(s1 > 0)) s1 = Math.abs(last.close) * 1e-4 || 1e-9;
  const dir = side === 'SHORT' ? -1 : 1;
  const e = Number.isFinite(entry) ? entry : last.close;
  const tok = [];
  const slots = [];
  const meta = [];
  let slot = 0;
  for (const g of TIMEFRAMES) {
    const span = g.tf * 60;
    const scale = s1 * Math.sqrt(g.tf);
    const group = [];
    for (let c = 0; c < g.n; c++) {
      const t0 = tEnd - (g.n - c) * span;
      const t1 = t0 + span;
      let i = lowerBound(bars, t0);
      if (i < from) i = from;
      let o = null;
      let h = -Infinity;
      let l = Infinity;
      let cl = null;
      let v = 0;
      for (; i < end && bars[i].time < t1; i++) {
        const b = bars[i];
        if (o == null) o = b.open;
        if (b.high > h) h = b.high;
        if (b.low < l) l = b.low;
        cl = b.close;
        v += Number.isFinite(b.volume) ? b.volume : 0;
      }
      group.push(o == null ? null : { slot: slot + c, tf: g.tf, t: t0, o, h, l, c: cl, v, scale });
    }
    const vols = group.filter(Boolean).map((x) => x.v).filter((x) => x > 0);
    const meanV = vols.length ? vols.reduce((a, b) => a + b, 0) / vols.length : 0;
    for (const x of group) {
      if (!x) continue;
      const o = dir * x.o;
      const c = dir * x.c;
      const hi = dir > 0 ? x.h : -x.l;
      const lo = dir > 0 ? x.l : -x.h;
      const S = x.scale;
      const mod = (2 * Math.PI * nyMinuteOfDay((x.t + span) * 1000)) / 1440;
      tok.push(
        clamp((c - o) / S, -4, 4) / 2,
        clamp((hi - Math.max(o, c)) / S, 0, 4) / 2,
        clamp((Math.min(o, c) - lo) / S, 0, 4) / 2,
        clamp(Math.log((hi - lo) / S + 0.05), -3, 3) / 2,
        clamp((c - dir * e) / S, -6, 6) / 3,
        x.v > 0 && meanV > 0 ? clamp(Math.log(x.v / meanV), -3, 3) / 2 : 0,
        Math.sin(mod),
        Math.cos(mod),
      );
      slots.push(x.slot);
      meta.push({ slot: x.slot, tf: x.tf, t: x.t, o: x.o, h: x.h, l: x.l, c: x.c });
    }
    slot += g.n;
  }
  if (slots.length < 6) return null;
  return { tok: Float64Array.from(tok), slots, meta, scale: s1 };
}

// Self-supervised lessons for pre-training, the way a language model learns from plain text
// before anyone labels anything: at random moments in the history, the candles before, and
// whether price was higher 15 minutes later. Moves smaller than a fifth of a typical 1-minute
// range are left out (no direction to learn). Gaps (weekends, missing data) are skipped.
export function pretrainSamples(bars, { n = 2000, rng = Math.random, horizon = 15 } = {}) {
  const out = [];
  if (!bars || bars.length < LOOKBACK_MIN + horizon + 60) return out;
  const lo = LOOKBACK_MIN;
  const hi = bars.length - horizon - 1;
  for (let tries = 0; out.length < n && tries < n * 6; tries++) {
    const end = lo + Math.floor(rng() * (hi - lo));
    const now = bars[end - 1];
    const later = bars[end - 1 + horizon];
    if (!later || later.time - now.time > (horizon + 15) * 60) continue;
    const t = candleTokens(bars, { end });
    if (!t) continue;
    const move = later.close - now.close;
    if (Math.abs(move) < 0.2 * t.scale) continue;
    out.push({ tok: t.tok, slots: t.slots, y: move > 0 ? 1 : 0 });
  }
  return out;
}

// Small, stable copies for saving (the floor's own trades keep the tokens they were judged on).
export const packTokens = (t) => (t ? { tok: Array.from(t.tok, (v) => Math.round(v * 1000) / 1000), slots: t.slots.slice() } : null);
export const unpackTokens = (p) => (p && Array.isArray(p.tok) && Array.isArray(p.slots) && p.tok.length === p.slots.length * FEATS ? { tok: Float64Array.from(p.tok), slots: p.slots.slice() } : null);
