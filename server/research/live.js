import { toColumns, nyMinutes, TfContext } from './context.js';
import { signalAt } from './families.js';

// The live side of a researched strategy: at the close of every timeframe bar the desk
// rebuilds the same context from recent history and asks the same signal function the
// backtest used. Enough bars are used for every indicator to have converged.
export const LIVE_BARS = 6000;

// True when this 1-minute bar completes a bar of the strategy's timeframe.
export function closesTimeframe(barTime, tf) {
  return (barTime + 60) % (tf * 60) === 0;
}

export function liveSignal(bars, g) {
  if (!bars.length) return null;
  const cols = toColumns(bars);
  const nyMin = nyMinutes(cols.t);
  const ctx = new TfContext(cols, g.tf, nyMin);
  const k = ctx.n - 1;
  if (k < 0 || !ctx.complete[k]) return null;
  return signalAt(ctx, g, k, nyMin);
}
