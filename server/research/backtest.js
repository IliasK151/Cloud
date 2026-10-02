import { signalAt } from './families.js';

// Bar-by-bar backtester that manages every trade exactly like a live desk does:
//   - the signal fires at the close of a timeframe bar, the entry fills at the next price
//     plus half the spread and slippage, plus commission (the paper broker's cost model);
//   - stop checked before target inside every 1-minute bar (the pessimistic assumption),
//     gaps through a stop fill at the worse open, stops pay extra slippage;
//   - half off at the partial level with the stop to breakeven, ATR trailing stop once 1R
//     up, time stop, no entries inside news blackouts, flat before high-impact news and
//     into the session close;
//   - after a loss the desk cools off for a few bars, a daily trade cap and a daily loss
//     stop (the desk's 2% loss limit ≈ 4R) apply.
// Results are in R (multiples of the initial risk), after costs.

export const TAKER_FEE_BPS = 0.35; // a market without its own commission (symbols.js feeBps)

// feeBps: the market's commission per side (symbols.js), as the paper broker charges it.
export function costModel(spreadBps, feeBps = TAKER_FEE_BPS) {
  return { half: spreadBps / 2 / 1e4, fee: feeBps / 1e4 };
}

function firstEval(tfc, from) {
  let lo = 0;
  let hi = tfc.n;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (tfc.last1m[mid] < from) lo = mid + 1;
    else hi = mid;
  }
  return lo;
}

export function backtest(m, tfc, g, { from = 0, to = m.n, cost, costMult = 1, cooldown = 3, maxPerDay = 12, dailyStopR = 4, keepTrades = false } = {}) {
  const { o, h, l, c, t, atr1, flat, blocked, newsFlat, day } = m;
  const half = cost.half * costMult * 1.5; // half spread + average slippage, per side
  const fee = cost.fee * costMult;
  const stopSlip = cost.half * costMult * 0.5;
  const timeStop = g.timeStop ? g.timeStop * g.tf : null;
  const rs = [];
  const trades = keepTrades ? [] : null;

  let pos = null;
  let pending = null;
  let cool = -1;
  let curDay = -1;
  let dayTrades = 0;
  let dayR = 0;
  let k = firstEval(tfc, from);

  const close = (px, why, j, isStop = false) => {
    const dir = pos.dir;
    const fill = px * (1 - dir * (half + (isStop ? stopSlip : 0)));
    const pnl = pos.realized + pos.remaining * ((fill - pos.entry) * dir - fill * fee) - pos.entry * fee;
    const r = pnl / pos.risk;
    rs.push(r);
    trades?.push({ in: t[pos.open], out: t[j], dir, r: Math.round(r * 1000) / 1000, why });
    dayTrades++;
    dayR += r;
    if (r < 0) cool = j + cooldown;
    pos = null;
  };

  for (let j = from; j < to; j++) {
    if (day[j] !== curDay) {
      curDay = day[j];
      dayTrades = 0;
      dayR = 0;
    }
    if (pending) {
      const p = pending;
      pending = null;
      if (!blocked[j] && !flat[j] && !newsFlat[j]) {
        const entry = o[j] * (1 + p.dir * half);
        const risk = (entry - p.stop) * p.dir;
        if (risk > 0 && (p.target == null || (p.target - entry) * p.dir > 0)) {
          pos = { dir: p.dir, entry, stop: p.stop, target: p.target, risk, extreme: entry, partial: false, bars: 0, open: j, realized: 0, remaining: 1 };
        }
      }
    }

    if (pos) {
      const dir = pos.dir;
      if (flat[j] || newsFlat[j]) {
        close(o[j], newsFlat[j] ? 'news' : 'close', j);
      } else if (dir > 0 ? l[j] <= pos.stop : h[j] >= pos.stop) {
        close(dir > 0 ? Math.min(o[j], pos.stop) : Math.max(o[j], pos.stop), 'stop', j, true);
      } else {
        let done = false;
        if (g.partialAt && !pos.partial) {
          const trig = pos.entry + dir * g.partialAt * pos.risk;
          if (dir > 0 ? h[j] >= trig : l[j] <= trig) {
            const fill = trig * (1 - dir * half);
            pos.realized += 0.5 * ((fill - pos.entry) * dir - fill * fee);
            pos.remaining = 0.5;
            pos.partial = true;
            pos.stop = pos.entry;
            // Closed back through entry in the same bar: assume the breakeven stop was hit.
            if (dir > 0 ? c[j] <= pos.entry : c[j] >= pos.entry) {
              close(pos.entry, 'breakeven', j, true);
              done = true;
            }
          }
        }
        if (!done && pos.target != null && (dir > 0 ? h[j] >= pos.target : l[j] <= pos.target)) {
          close(dir > 0 ? Math.max(o[j], pos.target) : Math.min(o[j], pos.target), 'target', j);
          done = true;
        }
        if (!done) {
          pos.extreme = dir > 0 ? Math.max(pos.extreme, h[j]) : Math.min(pos.extreme, l[j]);
          pos.bars++;
          const rNow = ((c[j] - pos.entry) * dir) / pos.risk;
          if (g.trail && (pos.partial || rNow >= 1) && atr1[j] > 0) {
            const ts = pos.extreme - dir * g.trail * atr1[j];
            if (dir > 0 ? ts > pos.stop : ts < pos.stop) pos.stop = ts;
          }
          if (timeStop && pos.bars >= timeStop && rNow < 0.5) close(c[j], 'time', j);
        }
      }
    }

    while (k < tfc.n && tfc.last1m[k] < j) k++;
    if (!pos && k < tfc.n && tfc.last1m[k] === j && j + 1 < to && j >= cool && dayTrades < maxPerDay && dayR > -dailyStopR) {
      const sig = signalAt(tfc, g, k, m.nyMin);
      if (sig) pending = sig;
    }
  }
  if (pos) close(c[to - 1], 'end', to - 1);
  const stats = metrics(rs);
  if (trades) stats.trades = trades;
  return stats;
}

export function metrics(rs) {
  const n = rs.length;
  let sum = 0, win = 0, gw = 0, gl = 0, peak = 0, eq = 0, dd = 0, streak = 0, worstStreak = 0;
  for (const r of rs) {
    sum += r;
    if (r > 0) { win++; gw += r; streak = 0; } else { gl -= r; streak++; worstStreak = Math.max(worstStreak, streak); }
    eq += r;
    peak = Math.max(peak, eq);
    dd = Math.max(dd, peak - eq);
  }
  const avg = n ? sum / n : 0;
  let v = 0;
  for (const r of rs) v += (r - avg) ** 2;
  const sd = n > 1 ? Math.sqrt(v / (n - 1)) : 0;
  return {
    n, wins: win, winRate: n ? win / n : 0, sumR: sum, avgR: avg, sd,
    pf: gl > 0 ? gw / gl : gw > 0 ? 99 : 0,
    maxDD: dd, t: sd > 0 ? avg / (sd / Math.sqrt(n)) : 0,
    avgWin: win ? gw / win : 0, avgLoss: n - win ? gl / (n - win) : 0, lossStreak: worstStreak,
    rs,
  };
}

// Bootstrap the trade sequence: how often does it end up positive, and how deep can the
// drawdown get by bad luck alone?
export function monteCarlo(rs, rng, iters = 500) {
  const n = rs.length;
  if (!n) return { pPositive: 0, ddP95: 0, sumP5: 0 };
  const sums = new Float64Array(iters);
  const dds = new Float64Array(iters);
  for (let it = 0; it < iters; it++) {
    let eq = 0, peak = 0, dd = 0;
    for (let i = 0; i < n; i++) {
      eq += rs[Math.floor(rng() * n)];
      if (eq > peak) peak = eq;
      if (peak - eq > dd) dd = peak - eq;
    }
    sums[it] = eq;
    dds[it] = dd;
  }
  sums.sort();
  dds.sort();
  let pos = 0;
  for (const s of sums) if (s > 0) pos++;
  return { pPositive: pos / iters, ddP95: dds[Math.floor(iters * 0.95)], sumP5: sums[Math.floor(iters * 0.05)] };
}
