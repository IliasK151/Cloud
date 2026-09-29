import { TraderAgent } from '../agent.js';
import { anchoredVwap, rsi, atr, adx, closes, last } from '../../market/indicators.js';
import { indexFrom } from './orb.js';

// Execution desk: fades 2σ excursions from session VWAP back to VWAP in non-trending tape.
export class VwapReversion extends TraderAgent {
  static strategyName = 'VWAP Mean Reversion';
  static strategyBlurb = 'Fades stretched moves outside the ±2σ session VWAP bands once price closes back inside, targeting VWAP. Disabled when ADX says the tape is trending.';

  evaluate() {
    const bars = this.bars();
    const now = this.env.clock.now();
    const from = indexFrom(bars, this.session.vwapAnchor(now));
    const since = bars.length - from;
    if (since < 20 || bars.length < 40) {
      this.setup = { ...this.setup, armed: false, bias: 'NEUTRAL', checklist: [{ label: 'VWAP has 20+ bars', ok: false }] };
      return this.setStage(`Building session VWAP (${Math.max(0, since)}/20 bars)`);
    }
    const { vwap, sd } = anchoredVwap(bars, from);
    const v = last(vwap);
    const s = last(sd);
    const a = last(atr(bars, 14));
    const r = rsi(closes(bars), 7);
    const x = last(adx(bars, 14).adx);
    const up2 = v + 2 * s;
    const dn2 = v - 2 * s;
    const bar = bars[bars.length - 1];
    const prev = bars[bars.length - 2];
    const price = this.price();
    const bandsOk = s > 0.6 * a;
    const calm = x < 28;
    const recentHigh = Math.max(...bars.slice(-4).map((b) => b.high));
    const recentLow = Math.min(...bars.slice(-4).map((b) => b.low));

    if (!this.position() && bandsOk && calm) {
      if (prev.high > up2 && bar.close < up2 && last(r, 1) > 68) {
        const stop = recentHigh + 0.3 * a;
        if ((price - v) / (stop - price) >= 1) {
          this.openTrade({ side: 'SHORT', stop, target: v, reason: 'Rejected +2σ VWAP band, fading to VWAP', partialAt: 0.8, timeStopBars: 45 });
        }
      } else if (prev.low < dn2 && bar.close > dn2 && last(r, 1) < 32) {
        const stop = recentLow - 0.3 * a;
        if ((v - price) / (price - stop) >= 1) {
          this.openTrade({ side: 'LONG', stop, target: v, reason: 'Reclaimed −2σ VWAP band, fading to VWAP', partialAt: 0.8, timeStopBars: 45 });
        }
      }
    }

    const dev = s > 0 ? (price - v) / s : 0;
    const stretched = Math.abs(dev) > 1.6;
    this.setup = {
      ...this.setup,
      bias: dev > 1 ? 'SHORT' : dev < -1 ? 'LONG' : 'NEUTRAL',
      armed: !this.position() && calm && bandsOk && stretched,
      levels: [
        { label: '+2σ', price: up2 },
        { label: 'VWAP', price: v },
        { label: '−2σ', price: dn2 },
      ],
      thesis: `Price is ${dev >= 0 ? '+' : ''}${dev.toFixed(2)}σ from session VWAP ${this.px(v)}. ${calm ? 'Tape is rotational (ADX ' + x.toFixed(0) + '), so extremes tend to revert.' : 'ADX ' + x.toFixed(0) + ' says trending — no fading today.'}`,
      checklist: [
        { label: 'Session VWAP established', ok: true },
        { label: 'ADX(14) < 28 (rotational)', ok: calm },
        { label: 'Bands wide enough (σ > 0.6 ATR)', ok: bandsOk },
        { label: 'Price stretched beyond 1.6σ', ok: stretched },
        { label: 'RSI(7) at extreme', ok: last(r) > 68 || last(r) < 32 },
      ],
      confidence: Math.round(Math.min(95, 20 + (calm ? 25 : 0) + (bandsOk ? 15 : 0) + Math.min(35, Math.abs(dev) * 15))),
      indicators: { VWAP: v, 'σ': s, 'Deviation σ': dev, 'RSI(7)': last(r), 'ADX(14)': x },
    };
    if (this.position()) this.setStage(`Fading back to VWAP ${this.px(v)}`);
    else if (!calm) this.setStage(`Trend day (ADX ${x.toFixed(0)}) — fading disabled`);
    else if (stretched) this.setStage(`Stretched ${dev.toFixed(1)}σ — waiting for a close back inside the band`);
    else this.setStage(`Inside the bands (${dev.toFixed(1)}σ) — watching ${this.px(up2)} / ${this.px(dn2)}`);
  }

  pitch() {
    const lv = this.setup.levels;
    if (lv.length < 3) return `I trade VWAP reversion on ${this.symbol}. Session VWAP is still building, so I am just watching.`;
    const dev = this.setup.indicators['Deviation σ'];
    if (this.position()) return `I faded a two-sigma stretch on ${this.symbol} and I'm targeting VWAP at ${this.px(lv[1].price)}.`;
    return `I run VWAP mean reversion on ${this.symbol}. VWAP is ${this.px(lv[1].price)}, the two-sigma bands are ${this.px(lv[2].price)} and ${this.px(lv[0].price)}. Price is ${Math.abs(dev).toFixed(1)} sigma ${dev >= 0 ? 'above' : 'below'} VWAP. I fade a rejection of the outer band back to VWAP.`;
  }
}
