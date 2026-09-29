// Technical indicators over arrays of bars ({ time, open, high, low, close, volume }).
// Functions return full-length arrays aligned with the input (NaN until warm).

export const closes = (bars) => bars.map((b) => b.close);

export function sma(values, len) {
  const out = new Array(values.length).fill(NaN);
  let sum = 0;
  for (let i = 0; i < values.length; i++) {
    sum += values[i];
    if (i >= len) sum -= values[i - len];
    if (i >= len - 1) out[i] = sum / len;
  }
  return out;
}

export function ema(values, len) {
  const out = new Array(values.length).fill(NaN);
  const k = 2 / (len + 1);
  let prev = NaN;
  for (let i = 0; i < values.length; i++) {
    const v = values[i];
    if (Number.isNaN(prev)) {
      if (i >= len - 1) {
        let s = 0;
        for (let j = i - len + 1; j <= i; j++) s += values[j];
        prev = s / len;
        out[i] = prev;
      }
    } else {
      prev = v * k + prev * (1 - k);
      out[i] = prev;
    }
  }
  return out;
}

export function stdev(values, len) {
  const out = new Array(values.length).fill(NaN);
  for (let i = len - 1; i < values.length; i++) {
    let s = 0;
    for (let j = i - len + 1; j <= i; j++) s += values[j];
    const m = s / len;
    let v = 0;
    for (let j = i - len + 1; j <= i; j++) v += (values[j] - m) ** 2;
    out[i] = Math.sqrt(v / len);
  }
  return out;
}

export function trueRange(bars) {
  return bars.map((b, i) => {
    if (i === 0) return b.high - b.low;
    const pc = bars[i - 1].close;
    return Math.max(b.high - b.low, Math.abs(b.high - pc), Math.abs(b.low - pc));
  });
}

// Wilder's smoothing.
function rma(values, len) {
  const out = new Array(values.length).fill(NaN);
  let prev = NaN;
  for (let i = 0; i < values.length; i++) {
    if (Number.isNaN(prev)) {
      if (i >= len - 1) {
        let s = 0;
        for (let j = i - len + 1; j <= i; j++) s += values[j];
        prev = s / len;
        out[i] = prev;
      }
    } else {
      prev = (prev * (len - 1) + values[i]) / len;
      out[i] = prev;
    }
  }
  return out;
}

export function atr(bars, len = 14) {
  return rma(trueRange(bars), len);
}

export function rsi(values, len = 14) {
  const gains = [0];
  const losses = [0];
  for (let i = 1; i < values.length; i++) {
    const d = values[i] - values[i - 1];
    gains.push(Math.max(d, 0));
    losses.push(Math.max(-d, 0));
  }
  const g = rma(gains, len);
  const l = rma(losses, len);
  return g.map((gv, i) => {
    if (Number.isNaN(gv) || Number.isNaN(l[i])) return NaN;
    if (l[i] === 0) return 100;
    return 100 - 100 / (1 + gv / l[i]);
  });
}

export function adx(bars, len = 14) {
  const plusDM = [0];
  const minusDM = [0];
  for (let i = 1; i < bars.length; i++) {
    const up = bars[i].high - bars[i - 1].high;
    const down = bars[i - 1].low - bars[i].low;
    plusDM.push(up > down && up > 0 ? up : 0);
    minusDM.push(down > up && down > 0 ? down : 0);
  }
  const tr = rma(trueRange(bars), len);
  const pdm = rma(plusDM, len);
  const mdm = rma(minusDM, len);
  const dx = bars.map((_, i) => {
    if (!(tr[i] > 0)) return NaN;
    const pdi = (100 * pdm[i]) / tr[i];
    const mdi = (100 * mdm[i]) / tr[i];
    return pdi + mdi === 0 ? 0 : (100 * Math.abs(pdi - mdi)) / (pdi + mdi);
  });
  const firstValid = dx.findIndex((v) => !Number.isNaN(v));
  const out = new Array(bars.length).fill(NaN);
  if (firstValid === -1) return { adx: out, plusDI: out, minusDI: out };
  const smoothed = rma(dx.slice(firstValid), len);
  for (let i = 0; i < smoothed.length; i++) out[firstValid + i] = smoothed[i];
  const plusDI = bars.map((_, i) => (tr[i] > 0 ? (100 * pdm[i]) / tr[i] : NaN));
  const minusDI = bars.map((_, i) => (tr[i] > 0 ? (100 * mdm[i]) / tr[i] : NaN));
  return { adx: out, plusDI, minusDI };
}

export function bollinger(values, len = 20, mult = 2) {
  const mid = sma(values, len);
  const sd = stdev(values, len);
  return {
    mid,
    upper: mid.map((m, i) => m + mult * sd[i]),
    lower: mid.map((m, i) => m - mult * sd[i]),
  };
}

export function keltner(bars, len = 20, mult = 1.5) {
  const mid = ema(closes(bars), len);
  const a = atr(bars, len);
  return {
    mid,
    upper: mid.map((m, i) => m + mult * a[i]),
    lower: mid.map((m, i) => m - mult * a[i]),
  };
}

// Volume-weighted average price anchored at `fromIndex`, with volume-weighted σ bands.
export function anchoredVwap(bars, fromIndex = 0) {
  const vwap = new Array(bars.length).fill(NaN);
  const sd = new Array(bars.length).fill(NaN);
  let pv = 0;
  let vol = 0;
  let pv2 = 0;
  for (let i = Math.max(0, fromIndex); i < bars.length; i++) {
    const b = bars[i];
    const tp = (b.high + b.low + b.close) / 3;
    const v = Math.max(b.volume, 1e-9);
    pv += tp * v;
    pv2 += tp * tp * v;
    vol += v;
    vwap[i] = pv / vol;
    sd[i] = Math.sqrt(Math.max(pv2 / vol - vwap[i] ** 2, 0));
  }
  return { vwap, sd };
}

// Supertrend (ATR bands that flip with price). dir = 1 uptrend, -1 downtrend.
export function supertrend(bars, len = 10, mult = 3) {
  const a = atr(bars, len);
  const line = new Array(bars.length).fill(NaN);
  const dir = new Array(bars.length).fill(0);
  let upper = NaN;
  let lower = NaN;
  for (let i = 0; i < bars.length; i++) {
    if (Number.isNaN(a[i])) continue;
    const hl2 = (bars[i].high + bars[i].low) / 2;
    const basicUpper = hl2 + mult * a[i];
    const basicLower = hl2 - mult * a[i];
    const prevClose = i > 0 ? bars[i - 1].close : bars[i].close;
    upper = Number.isNaN(upper) || basicUpper < upper || prevClose > upper ? basicUpper : upper;
    lower = Number.isNaN(lower) || basicLower > lower || prevClose < lower ? basicLower : lower;
    const prevDir = i > 0 && dir[i - 1] !== 0 ? dir[i - 1] : 1;
    let d = prevDir;
    if (prevDir === 1 && bars[i].close < lower) d = -1;
    else if (prevDir === -1 && bars[i].close > upper) d = 1;
    dir[i] = d;
    line[i] = d === 1 ? lower : upper;
  }
  return { line, dir };
}

export function highest(bars, from, to, key = 'high') {
  let v = -Infinity;
  for (let i = Math.max(0, from); i <= to && i < bars.length; i++) v = Math.max(v, bars[i][key]);
  return v;
}

export function lowest(bars, from, to, key = 'low') {
  let v = Infinity;
  for (let i = Math.max(0, from); i <= to && i < bars.length; i++) v = Math.min(v, bars[i][key]);
  return v;
}

// Fractal swing points: a swing high has `strength` lower highs on each side.
export function swings(bars, strength = 3, lookback = 120) {
  const highs = [];
  const lows = [];
  const start = Math.max(strength, bars.length - lookback);
  for (let i = start; i < bars.length - strength; i++) {
    let isHigh = true;
    let isLow = true;
    for (let k = 1; k <= strength; k++) {
      if (bars[i].high <= bars[i - k].high || bars[i].high <= bars[i + k].high) isHigh = false;
      if (bars[i].low >= bars[i - k].low || bars[i].low >= bars[i + k].low) isLow = false;
    }
    if (isHigh) highs.push({ index: i, price: bars[i].high, time: bars[i].time });
    if (isLow) lows.push({ index: i, price: bars[i].low, time: bars[i].time });
  }
  return { highs, lows };
}

// Aggregate 1-minute bars into higher-timeframe bars (e.g. 15 for M15).
export function resample(bars, minutes) {
  const out = [];
  const size = minutes * 60;
  for (const b of bars) {
    const bucket = Math.floor(b.time / size) * size;
    const last = out[out.length - 1];
    if (!last || last.time !== bucket) {
      out.push({ time: bucket, open: b.open, high: b.high, low: b.low, close: b.close, volume: b.volume });
    } else {
      last.high = Math.max(last.high, b.high);
      last.low = Math.min(last.low, b.low);
      last.close = b.close;
      last.volume += b.volume;
    }
  }
  return out;
}

// Ordinary least squares slope/intercept of y on x.
export function ols(x, y) {
  const n = Math.min(x.length, y.length);
  let sx = 0, sy = 0, sxx = 0, sxy = 0;
  for (let i = 0; i < n; i++) {
    sx += x[i]; sy += y[i]; sxx += x[i] * x[i]; sxy += x[i] * y[i];
  }
  const denom = n * sxx - sx * sx;
  const beta = denom === 0 ? 1 : (n * sxy - sx * sy) / denom;
  return { beta, alpha: (sy - beta * sx) / n };
}

export const last = (arr, back = 0) => arr[arr.length - 1 - back];
