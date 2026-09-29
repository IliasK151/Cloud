import { TraderAgent } from '../agent.js';
import { ema, rsi, atr, closes, last } from '../../market/indicators.js';

// Energy desk: buys pullbacks to the EMA 20 in an established EMA 20/50 uptrend (and vice versa).
export class TrendPullback extends TraderAgent {
  static strategyName = 'Trend Pullback';
  static strategyBlurb = 'Joins established trends on pullbacks into the EMA 20 once RSI has reset, entering on a reversal bar through the prior bar; stop under the pullback, 2.2R target.';

  evaluate() {
    const bars = this.bars();
    if (bars.length < 60) return this.setStage('Warming up indicators');
    const c = closes(bars);
    const e20 = ema(c, 20);
    const e50 = ema(c, 50);
    const r = rsi(c, 14);
    const a = last(atr(bars, 14));
    const n = bars.length;
    const bar = bars[n - 1];
    const prev = bars[n - 2];
    const slope = e50[n - 1] - e50[n - 11];
    const up = e20[n - 1] > e50[n - 1] && slope > 0.1 * a && bar.close > e50[n - 1];
    const down = e20[n - 1] < e50[n - 1] && slope < -0.1 * a && bar.close < e50[n - 1];
    const look = bars.slice(-6);
    const rLook = r.slice(-6);
    const touchedUp = look.some((b, k) => b.low <= e20[n - 6 + k] + 0.2 * a);
    const touchedDown = look.some((b, k) => b.high >= e20[n - 6 + k] - 0.2 * a);
    const resetUp = Math.min(...rLook) < 48;
    const resetDown = Math.max(...rLook) > 52;
    const price = this.price();

    if (!this.position()) {
      if (up && touchedUp && resetUp && bar.close > bar.open && bar.close > prev.high) {
        const stop = Math.min(...look.map((b) => b.low)) - 0.2 * a;
        this.openTrade({ side: 'LONG', stop, target: price + 2.2 * (price - stop), reason: 'Uptrend pullback to EMA 20, reversal bar', trail: 2.5 });
      } else if (down && touchedDown && resetDown && bar.close < bar.open && bar.close < prev.low) {
        const stop = Math.max(...look.map((b) => b.high)) + 0.2 * a;
        this.openTrade({ side: 'SHORT', stop, target: price - 2.2 * (stop - price), reason: 'Downtrend pullback to EMA 20, reversal bar', trail: 2.5 });
      }
    }

    const inPullback = (up && touchedUp) || (down && touchedDown);
    this.setup = {
      ...this.setup,
      bias: up ? 'LONG' : down ? 'SHORT' : 'NEUTRAL',
      armed: !this.position() && inPullback,
      levels: [
        { label: 'EMA 20', price: e20[n - 1] },
        { label: 'EMA 50', price: e50[n - 1] },
      ],
      thesis: up
        ? `Uptrend: EMA 20 above a rising EMA 50. I buy the dip into the EMA 20 once RSI cools off.`
        : down
          ? `Downtrend: EMA 20 below a falling EMA 50. I sell the rip into the EMA 20 once RSI resets.`
          : `No clean trend — EMAs are flat or tangled, so no pullbacks to buy or sell.`,
      checklist: [
        { label: 'Trend defined (EMA 20/50 + slope)', ok: up || down },
        { label: 'Pullback touched EMA 20', ok: inPullback },
        { label: 'RSI reset', ok: up ? resetUp : down ? resetDown : false },
        { label: 'Reversal bar trigger', ok: up ? bar.close > prev.high : down ? bar.close < prev.low : false },
      ],
      confidence: Math.round(Math.min(95, 15 + (up || down ? 30 : 0) + (inPullback ? 25 : 0) + ((up && resetUp) || (down && resetDown) ? 20 : 0))),
      indicators: { 'EMA 50 slope': slope, 'RSI(14)': last(r), 'ATR(14)': a },
    };
    if (this.position()) this.setStage('Trend trade on, trailing 2.5 ATR');
    else if (inPullback) this.setStage(`Pullback into EMA 20 — waiting for a ${up ? 'bullish' : 'bearish'} reversal bar`);
    else if (up || down) this.setStage(`${up ? 'Uptrend' : 'Downtrend'} — waiting for a pullback to ${this.px(e20[n - 1])}`);
    else this.setStage('No trend — sitting on my hands');
  }

  pitch() {
    const st = this.setup;
    if (this.position()) return `I joined the trend on ${this.symbol} off a pullback to the twenty EMA and I'm trailing it.`;
    if (st.bias === 'NEUTRAL') return `I trade trend pullbacks on ${this.symbol}, but there is no clean trend right now, so I'm flat and patient.`;
    return `${this.symbol} is in a${st.bias === 'LONG' ? 'n up' : ' down'}trend. I want a pullback into the twenty EMA around ${this.px(st.levels[0].price)} and a reversal bar to ${st.bias === 'LONG' ? 'buy' : 'sell'}.`;
  }
}
