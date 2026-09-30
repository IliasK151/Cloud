// The strategy grammar the research desks build strategies from.
//
// A strategy ("genome") is an entry family with its parameters, a timeframe, a market
// condition filter, a direction filter and an exit plan:
//   { family, tf, side, gate, hours, p: {…}, stopAtr, target: 'rr'|'mid'|'none', rr, partialAt, trail, timeStop }
//
// Every family's `signal(ctx, g, i)` looks only at bars ≤ i and returns the trade the desk
// would place at the close of bar i: { dir, stop, target } in prices, or null. The backtest
// and the live desk call the very same function.

export const TIMEFRAMES = [1, 3, 5, 15];

const fin = Number.isFinite;

// Market-condition filter. Trend filters also require the trade to go with the trend.
function gateOk(ctx, g, i, dir) {
  if (g.gate === 'any') return true;
  const r = ctx.regime()[i];
  switch (g.gate) {
    case 'trend': return r === dir;
    case 'range': return r === 2;
    case 'squeeze': return r === 3 || (i > 0 && ctx.regime()[i - 1] === 3);
    case 'notrend': return r === 2 || r === 3;
    default: return true;
  }
}

const HOURS = {
  all: null,
  us: [570, 960], // 09:30–16:00 New York
  euus: [180, 960], // 03:00–16:00
};

function sideOk(g, dir) {
  return g.side === 'both' || (g.side === 'long' ? dir > 0 : dir < 0);
}

// Stop and target around the reference price (the close the signal fired on).
function levels(ctx, g, i, dir, mid = null) {
  const a = ctx.atr(14)[i];
  if (!fin(a) || a <= 0) return null;
  const px = ctx.c[i];
  const dist = g.stopAtr * a;
  const stop = px - dir * dist;
  let target = null;
  if (g.target === 'rr') target = px + dir * g.rr * dist;
  else if (g.target === 'mid') {
    if (!fin(mid) || (mid - px) * dir < 0.6 * dist) return null; // not enough room to the mean
    target = mid;
  }
  return { dir, stop, target, ref: px };
}

export const FAMILIES = {
  breakout: {
    label: 'Channel breakout',
    fits: { trend: 3, squeeze: 3, volatile: 2, range: 0.4 },
    space: { n: [10, 15, 20, 30, 40, 55], buffer: [0, 0.1, 0.25] },
    targets: ['rr', 'none'],
    signal(ctx, g, i) {
      const { n, buffer } = g.p;
      if (i < n + 2) return null;
      const hi = ctx.donHigh(n);
      const lo = ctx.donLow(n);
      const a = ctx.atr(14)[i];
      if (!fin(hi[i]) || !fin(a)) return null;
      const c = ctx.c;
      let dir = 0;
      if (c[i] > hi[i] + buffer * a && c[i - 1] <= hi[i - 1] + buffer * a) dir = 1;
      else if (c[i] < lo[i] - buffer * a && c[i - 1] >= lo[i - 1] - buffer * a) dir = -1;
      if (!dir) return null;
      return levels(ctx, g, i, dir);
    },
    describe: (g) => [`Enter when a ${g.tf}-minute bar closes ${g.p.buffer ? `${g.p.buffer} ATR ` : ''}beyond the ${g.p.n}-bar high or low`],
  },

  pullback: {
    label: 'Trend pullback',
    fits: { trend: 3.5, volatile: 1, range: 0.3, squeeze: 0.5 },
    space: { fast: [8, 13, 21], slow: [34, 55, 89], depth: [0, 0.3, 0.6] },
    targets: ['rr', 'none'],
    signal(ctx, g, i) {
      const { fast, slow, depth } = g.p;
      if (i < slow + 6) return null;
      const f = ctx.ema(fast);
      const s = ctx.ema(slow);
      const a = ctx.atr(14)[i];
      if (!fin(s[i - 5]) || !fin(a)) return null;
      const { c, o, l, h } = ctx;
      let dir = 0;
      if (f[i] > s[i] && s[i] > s[i - 5] && l[i] <= f[i] + depth * a && c[i] > f[i] && c[i] > o[i] && !(l[i - 1] <= f[i - 1] + depth * a && c[i - 1] > f[i - 1] && c[i - 1] > o[i - 1])) dir = 1;
      else if (f[i] < s[i] && s[i] < s[i - 5] && h[i] >= f[i] - depth * a && c[i] < f[i] && c[i] < o[i] && !(h[i - 1] >= f[i - 1] - depth * a && c[i - 1] < f[i - 1] && c[i - 1] < o[i - 1])) dir = -1;
      if (!dir) return null;
      return levels(ctx, g, i, dir);
    },
    describe: (g) => [`Trade with the trend when EMA ${g.p.fast} is above/below EMA ${g.p.slow} and the slow EMA slopes the same way`, `Enter when a ${g.tf}-minute bar dips ${g.p.depth ? `to within ${g.p.depth} ATR of` : 'into'} EMA ${g.p.fast} and closes back out in the trend direction`],
  },

  meanrev: {
    label: 'Band mean reversion',
    fits: { range: 3.5, squeeze: 0.6, volatile: 1.5, trend: 0.3 },
    space: { n: [14, 20, 30], k: [2.0, 2.4, 2.8], rsi: [0, 25, 15] },
    targets: ['mid', 'rr'],
    signal(ctx, g, i) {
      const { n, k, rsi: rsiLim } = g.p;
      if (i < n + 2) return null;
      const mid = ctx.sma(n);
      const sd = ctx.sd(n);
      if (!fin(sd[i])) return null;
      const r = rsiLim ? ctx.rsi(3)[i] : 50;
      const c = ctx.c;
      let dir = 0;
      if (c[i] < mid[i] - k * sd[i] && (!rsiLim || r < rsiLim)) dir = 1;
      else if (c[i] > mid[i] + k * sd[i] && (!rsiLim || r > 100 - rsiLim)) dir = -1;
      if (!dir) return null;
      return levels(ctx, g, i, dir, mid[i]);
    },
    describe: (g) => [`Fade ${g.tf}-minute closes more than ${g.p.k} standard deviations from the ${g.p.n}-bar mean${g.p.rsi ? ` with RSI(3) beyond ${g.p.rsi}/${100 - g.p.rsi}` : ''}`],
  },

  squeeze: {
    label: 'Squeeze breakout',
    fits: { squeeze: 4, range: 1.2, trend: 1, volatile: 0.6 },
    space: { kc: [1.2, 1.5, 1.8], minBars: [3, 6, 10] },
    targets: ['rr', 'none'],
    signal(ctx, g, i) {
      const { kc, minBars } = g.p;
      if (i < 30) return null;
      const sq = ctx.squeeze(kc);
      if (sq.run[i - 1] < minBars) return null;
      const c = ctx.c;
      let dir = 0;
      if (c[i] > sq.boxHi[i - 1]) dir = 1;
      else if (c[i] < sq.boxLo[i - 1]) dir = -1;
      if (!dir) return null;
      return levels(ctx, g, i, dir);
    },
    describe: (g) => [`Wait for at least ${g.p.minBars} ${g.tf}-minute bars of Bollinger bands inside Keltner channels (×${g.p.kc})`, 'Enter on the first close outside the squeeze box'],
  },

  vwap: {
    label: 'VWAP reversion',
    fits: { range: 3, volatile: 1.5, squeeze: 0.5, trend: 0.3 },
    space: { k: [1.5, 2.0, 2.5], minBars: [6, 12, 24] },
    targets: ['mid', 'rr'],
    signal(ctx, g, i) {
      const { k, minBars } = g.p;
      const { vw, sd, start } = ctx.vwap();
      if (i - start[i] < minBars || !fin(sd[i]) || sd[i] <= 0) return null;
      const { c, o } = ctx;
      let dir = 0;
      if (c[i] < vw[i] - k * sd[i] && c[i] > o[i]) dir = 1;
      else if (c[i] > vw[i] + k * sd[i] && c[i] < o[i]) dir = -1;
      if (!dir) return null;
      return levels(ctx, g, i, dir, vw[i]);
    },
    describe: (g) => [`When price is stretched ${g.p.k} standard deviations from the session VWAP, fade it on the first ${g.tf}-minute bar that turns back`],
  },

  momentum: {
    label: 'Momentum impulse',
    fits: { trend: 2.5, volatile: 2, squeeze: 1.2, range: 0.4 },
    space: { n: [5, 10, 20], thr: [1.0, 1.5, 2.0], slow: [50, 100] },
    targets: ['rr', 'none'],
    signal(ctx, g, i) {
      const { n, thr, slow } = g.p;
      if (i < Math.max(n, slow) + 2) return null;
      const a = ctx.atr(14);
      const s = ctx.ema(slow);
      if (!fin(a[i]) || !fin(s[i])) return null;
      const c = ctx.c;
      const z = (x) => (c[x] - c[x - n]) / (a[x] * Math.sqrt(n));
      let dir = 0;
      if (z(i) > thr && z(i - 1) <= thr && c[i] > s[i]) dir = 1;
      else if (z(i) < -thr && z(i - 1) >= -thr && c[i] < s[i]) dir = -1;
      if (!dir) return null;
      return levels(ctx, g, i, dir);
    },
    describe: (g) => [`Enter when the ${g.p.n}-bar move on the ${g.tf}-minute chart exceeds ${g.p.thr}× its normal range, on the right side of EMA ${g.p.slow}`],
  },
};

export const EXIT_SPACE = {
  stopAtr: [1.0, 1.5, 2.0, 2.5, 3.0],
  rr: [1.5, 2, 2.5, 3],
  partialAt: [null, 1],
  trail: [null, 2, 3.5, 5, 8],
  timeStop: [null, 8, 16, 32],
};

export const GATES = ['any', 'trend', 'range', 'squeeze', 'notrend'];

// The desk's signal at timeframe bar i (entry at the next price), or null.
export function signalAt(ctx, g, i, nyMin = null) {
  const fam = FAMILIES[g.family];
  if (!fam || !ctx.complete[i]) return null;
  if (g.hours && HOURS[g.hours] && nyMin) {
    const m = nyMin[ctx.last1m[i]];
    const [a, b] = HOURS[g.hours];
    if (m < a || m >= b) return null;
  }
  const sig = fam.signal(ctx, g, i);
  if (!sig || !sideOk(g, sig.dir) || !gateOk(ctx, g, i, sig.dir)) return null;
  return sig;
}

export function genomeKey(g) {
  return JSON.stringify([g.family, g.tf, g.side, g.gate, g.hours, g.p, g.stopAtr, g.target, g.rr, g.partialAt, g.trail, g.timeStop]);
}

// ---- describing a strategy to a human ------------------------------------------------------
const GATE_TEXT = {
  any: null,
  trend: 'Only when the market is trending, and only in the direction of the trend',
  range: 'Only when the market is ranging (no trend, normal volatility)',
  squeeze: 'Only during or right after a volatility squeeze',
  notrend: 'Only when the market is not trending',
};

export function strategyName(g) {
  const fam = FAMILIES[g.family];
  const side = g.side === 'long' ? ' (longs)' : g.side === 'short' ? ' (shorts)' : '';
  return `${g.tf}m ${fam.label}${side}`;
}

export function describe(g) {
  const fam = FAMILIES[g.family];
  const rules = [...fam.describe(g)];
  if (GATE_TEXT[g.gate]) rules.push(GATE_TEXT[g.gate]);
  if (g.side !== 'both') rules.push(g.side === 'long' ? 'Long trades only' : 'Short trades only');
  if (g.hours === 'us') rules.push('New York session only (09:30–16:00)');
  if (g.hours === 'euus') rules.push('London and New York sessions only (03:00–16:00 NY)');
  rules.push(`Stop ${g.stopAtr} ATR from entry`);
  if (g.target === 'rr') rules.push(`Target ${g.rr}R`);
  else if (g.target === 'mid') rules.push(g.family === 'vwap' ? 'Target the session VWAP' : 'Target the moving average (the mean)');
  else rules.push('No fixed target: the trade is managed with the trailing stop');
  if (g.partialAt) rules.push(`Take half off at +${g.partialAt}R and move the stop to breakeven`);
  if (g.trail) rules.push(`Trail the stop ${g.trail}× the 1-minute ATR once the trade is 1R up`);
  if (g.timeStop) rules.push(`Exit if it isn't working after ${g.timeStop * g.tf} minutes`);
  rules.push('No new trades around news; flat before high-impact releases and into the close');
  return rules;
}
