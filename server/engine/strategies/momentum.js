import { TraderAgent } from '../agent.js';
import { ema, atr, adx, closes, last } from '../../market/indicators.js';

// Digital assets desk: EMA 9/21 momentum with an EMA 50 trend filter and ADX confirmation.
export class TrendMomentum extends TraderAgent {
  static strategyName = 'Trend Momentum';
  static strategyBlurb = 'Trades EMA 9/21 crosses in the direction of the EMA 50 when ADX confirms a trending tape; 1.5 ATR stop, trails winners with a 2 ATR chandelier.';

  evaluate() {
    const bars = this.bars();
    if (bars.length < 60) return this.setStage('Warming up indicators');
    const c = closes(bars);
    const e9 = ema(c, 9);
    const e21 = ema(c, 21);
    const e50 = ema(c, 50);
    const { adx: ax, plusDI, minusDI } = adx(bars, 14);
    const a = last(atr(bars, 14));
    const price = this.price();
    const [f, s, t, x, pdi, mdi] = [last(e9), last(e21), last(e50), last(ax), last(plusDI), last(minusDI)];
    const crossUp = last(e9, 1) <= last(e21, 1) && f > s;
    const crossDown = last(e9, 1) >= last(e21, 1) && f < s;
    const trending = x > 20;
    const upStack = price > t && f > s;
    const downStack = price < t && f < s;
    const pos = this.position();

    if (pos && pos.qty > 0 && crossDown) this.closeTrade(this.symbol, 'Momentum faded (EMA 9/21 cross down)');
    if (pos && pos.qty < 0 && crossUp) this.closeTrade(this.symbol, 'Momentum faded (EMA 9/21 cross up)');

    if (!this.position()) {
      if (crossUp && price > t && trending && pdi > mdi) {
        this.openTrade({ side: 'LONG', stop: price - 1.5 * a, target: price + 4.5 * a, reason: 'EMA 9/21 bull cross above EMA 50, ADX trending', trail: 2 });
      } else if (crossDown && price < t && trending && mdi > pdi) {
        this.openTrade({ side: 'SHORT', stop: price + 1.5 * a, target: price - 4.5 * a, reason: 'EMA 9/21 bear cross below EMA 50, ADX trending', trail: 2 });
      }
    }

    const bias = price > t ? 'LONG' : price < t ? 'SHORT' : 'NEUTRAL';
    const nearCross = Math.abs(f - s) < 0.35 * a;
    const armed = !this.position() && trending && nearCross;
    this.setup = {
      ...this.setup,
      bias,
      armed,
      levels: [
        { label: 'EMA 9', price: f },
        { label: 'EMA 21', price: s },
        { label: 'EMA 50', price: t },
      ],
      thesis: `Trend filter is ${bias === 'LONG' ? 'bullish' : 'bearish'} (price ${bias === 'LONG' ? 'above' : 'below'} EMA 50). ADX ${x.toFixed(0)} — ${trending ? 'trending tape, momentum signals are live' : 'no trend, standing aside'}.`,
      checklist: [
        { label: 'EMA stack aligned', ok: upStack || downStack },
        { label: 'ADX(14) > 20', ok: trending },
        { label: 'Directional index confirms', ok: bias === 'LONG' ? pdi > mdi : mdi > pdi },
        { label: 'Fresh 9/21 cross', ok: crossUp || crossDown },
      ],
      confidence: Math.round(Math.min(95, 20 + (upStack || downStack ? 25 : 0) + Math.min(30, x) + (nearCross ? 15 : 0))),
      indicators: { 'ADX(14)': x, '+DI': pdi, '-DI': mdi, 'ATR(14)': a },
    };
    if (this.position()) this.setStage(`Riding ${this.position().qty > 0 ? 'long' : 'short'} momentum, trailing 2 ATR`);
    else if (!trending) this.setStage(`Chop filter on — ADX ${x.toFixed(0)}, waiting for a trend`);
    else if (armed) this.setStage(`Armed: EMA 9/21 about to cross ${f > s ? 'down' : 'up'}`);
    else this.setStage(`Trend ${bias === 'LONG' ? 'up' : 'down'}, waiting for a fresh cross`);
  }

  pitch() {
    const st = this.setup;
    const adxVal = st.indicators?.['ADX(14)'];
    if (this.position()) return `I'm riding a momentum trade on ${this.symbol}. The EMAs are stacked and I'm trailing a two-ATR stop.`;
    return `I trade momentum on ${this.symbol}: EMA nine twenty-one crosses in the direction of the fifty. Trend bias is ${st.bias.toLowerCase()}, ADX is ${Number.isFinite(adxVal) ? adxVal.toFixed(0) : 'warming up'}. ${st.armed ? 'A cross is close, I am ready.' : 'Waiting for the next clean cross.'}`;
  }
}
