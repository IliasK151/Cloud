import { TraderAgent } from '../agent.js';
import { atr, adx, ema, swings, closes, last } from '../../market/indicators.js';
import { indexFrom } from './orb.js';

// Metals desk: smart-money liquidity sweep. Waits for price to run the stops above a
// swing high / session high (or below a low), close back inside, and displace away.
export class LiquiditySweep extends TraderAgent {
  static strategyName = 'Liquidity Sweep Reversal';
  static strategyBlurb = 'Maps resting liquidity at swing and session highs/lows. When price runs those stops and closes back inside with displacement, it trades the reversal toward the opposite pool.';
  // maxAdx: trades only below this ADX (rotational tape) · stopRun: the sweep bar's range in
  // ATRs · wick: the rejection wick's share of that bar
  static RULES = { maxAdx: 25, stopRun: 1.3, wick: 0.5 };

  constructor(profile, env) {
    super(profile, env);
    this.used = new Set();
    this.pools = { above: [], below: [] };
  }

  #pools(bars, a) {
    const n = bars.length;
    const { highs, lows } = swings(bars.slice(0, n - 2), 5, 180);
    const dayFrom = indexFrom(bars, this.session.dayStart());
    const out = { above: [], below: [] };
    const add = (list, price, label, index) => {
      if (list.some((p) => Math.abs(p.price - price) < 0.3 * a)) return;
      list.push({ price, label, index });
    };
    for (const h of highs) {
      // Only untouched highs still hold resting buy stops.
      let taken = false;
      for (let i = h.index + 1; i < n - 3; i++) if (bars[i].high > h.price) { taken = true; break; }
      if (!taken && n - h.index >= 15) add(out.above, h.price, 'Swing high', h.index);
    }
    for (const l of lows) {
      let taken = false;
      for (let i = l.index + 1; i < n - 3; i++) if (bars[i].low < l.price) { taken = true; break; }
      if (!taken && n - l.index >= 15) add(out.below, l.price, 'Swing low', l.index);
    }
    if (n - dayFrom > 20) {
      const day = bars.slice(dayFrom, n - 3);
      const dh = Math.max(...day.map((b) => b.high));
      const dl = Math.min(...day.map((b) => b.low));
      add(out.above, dh, 'Session high', dayFrom);
      add(out.below, dl, 'Session low', dayFrom);
    }
    out.above.sort((x, y) => x.price - y.price);
    out.below.sort((x, y) => y.price - x.price);
    return out;
  }

  evaluate() {
    const bars = this.bars();
    if (bars.length < 60) return this.setStage('Mapping liquidity');
    const a = last(atr(bars, 14));
    const n = bars.length;
    const bar = bars[n - 1];
    const recent = bars.slice(-3);
    const price = this.price();
    const e50 = last(ema(closes(bars), 50));
    const pools = this.#pools(bars, a);
    this.pools = pools;
    // Sweeps fail in strong trends (they become breakouts), so only fade in rotational tape.
    const x = last(adx(bars, 14).adx);
    const R = this.rules;
    const rotational = x < R.maxAdx;

    // A sweep needs a stop-run wick (rejection) or a displacement candle back through the level.
    const range = (b) => Math.max(b.high - b.low, 1e-9);
    const upperWick = (b) => (b.high - Math.max(b.open, b.close)) / range(b);
    const lowerWick = (b) => (Math.min(b.open, b.close) - b.low) / range(b);
    const body = Math.abs(bar.close - bar.open);
    if (!this.position() && rotational) {
      for (const p of [...pools.above].reverse()) {
        const key = `H${p.price.toFixed(5)}`;
        if (this.used.has(key)) continue;
        const sweepBar = recent.reduce((m, b) => (b.high > m.high ? b : m), recent[0]);
        const rejected = upperWick(sweepBar) >= R.wick || (bar.close < bar.open && body >= 0.6 * a);
        const stopRun = range(sweepBar) >= R.stopRun * a;
        if (sweepBar.high > p.price + 0.1 * a && bar.close < p.price && rejected && stopRun) {
          this.used.add(key);
          const stop = sweepBar.high + 0.35 * a;
          const risk = stop - price;
          const opp = pools.below.find((q) => price - q.price >= 2 * risk);
          const target = opp ? opp.price : price - 2.5 * risk;
          this.openTrade({ side: 'SHORT', stop, target, reason: `Swept ${p.label.toLowerCase()} ${this.px(p.price)} and rejected`, trail: 3 });
          break;
        }
      }
    }
    if (!this.position() && rotational) {
      for (const p of [...pools.below].reverse()) {
        const key = `L${p.price.toFixed(5)}`;
        if (this.used.has(key)) continue;
        const sweepBar = recent.reduce((m, b) => (b.low < m.low ? b : m), recent[0]);
        const rejected = lowerWick(sweepBar) >= R.wick || (bar.close > bar.open && body >= 0.6 * a);
        const stopRun = range(sweepBar) >= R.stopRun * a;
        if (sweepBar.low < p.price - 0.1 * a && bar.close > p.price && rejected && stopRun) {
          this.used.add(key);
          const stop = sweepBar.low - 0.35 * a;
          const risk = price - stop;
          const opp = pools.above.find((q) => q.price - price >= 2 * risk);
          const target = opp ? opp.price : price + 2.5 * risk;
          this.openTrade({ side: 'LONG', stop, target, reason: `Swept ${p.label.toLowerCase()} ${this.px(p.price)} and rejected`, trail: 3 });
          break;
        }
      }
    }
    if (this.used.size > 200) this.used = new Set([...this.used].slice(-100));

    const nearAbove = pools.above[0];
    const nearBelow = pools.below[0];
    const distA = nearAbove ? (nearAbove.price - price) / a : Infinity;
    const distB = nearBelow ? (price - nearBelow.price) / a : Infinity;
    const close = Math.min(distA, distB) < 1.5;
    this.setup = {
      ...this.setup,
      bias: price < e50 ? 'SHORT' : 'LONG',
      armed: !this.position() && close,
      levels: [
        ...pools.above.slice(0, 2).map((p) => ({ label: `BSL · ${p.label}`, price: p.price })),
        ...pools.below.slice(0, 2).map((p) => ({ label: `SSL · ${p.label}`, price: p.price })),
      ],
      thesis: `${nearAbove ? `Buy-side liquidity rests above ${this.px(nearAbove.price)}` : 'No untouched buy-side liquidity above'}, ${nearBelow ? `sell-side below ${this.px(nearBelow.price)}` : 'no untouched sell-side liquidity below'}. I don't chase: I wait for a stop run through a pool, a rejection wick or displacement candle back inside, then target the opposite pool.`,
      checklist: [
        { label: 'Liquidity pools mapped', ok: pools.above.length + pools.below.length > 0 },
        { label: `Rotational tape (ADX < ${R.maxAdx})`, ok: rotational },
        { label: 'Price within 1.5 ATR of a pool', ok: close },
        { label: `Stop-run spike (range ≥ ${R.stopRun} ATR)`, ok: range(bar) >= R.stopRun * a },
        { label: 'Rejection wick or displacement', ok: upperWick(bar) >= R.wick || lowerWick(bar) >= R.wick || body >= 0.6 * a },
      ],
      confidence: Math.round(Math.min(90, 20 + (close ? 35 : 0) + Math.min(25, (pools.above.length + pools.below.length) * 5))),
      indicators: { 'ATR(14)': a, 'ADX(14)': x, 'Pools above': pools.above.length, 'Pools below': pools.below.length, 'EMA 50': e50 },
    };
    if (this.position()) this.setStage('In a sweep reversal, targeting the opposite pool');
    else if (!rotational) this.setStage(`Trending tape (ADX ${x.toFixed(0)}) — sweeps would be breakouts, standing aside`);
    else if (close) this.setStage(`Price near ${distA < distB ? 'buy-side' : 'sell-side'} liquidity ${this.px(distA < distB ? nearAbove.price : nearBelow.price)} — waiting for the sweep`);
    else this.setStage(`Watching liquidity: ${nearAbove ? this.px(nearAbove.price) : '—'} above / ${nearBelow ? this.px(nearBelow.price) : '—'} below`);
  }

  pitch() {
    const a = this.pools.above[0];
    const b = this.pools.below[0];
    if (this.position()) return `I traded a liquidity sweep on ${this.symbol}: the stops got run, price reclaimed, and I'm positioned for the move to the other side.`;
    return `I hunt liquidity sweeps on ${this.symbol}. There are resting buy stops above ${a ? this.px(a.price) : 'the highs'} and sell stops below ${b ? this.px(b.price) : 'the lows'}. When price runs one of those pools and snaps back with displacement, I take the reversal.`;
  }
}
