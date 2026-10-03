import { TraderAgent } from '../agent.js';
import { bollinger, keltner, atr, sma, closes, last } from '../../market/indicators.js';

// FX desk: volatility squeeze (Bollinger inside Keltner) breakout.
export class VolatilitySqueeze extends TraderAgent {
  static strategyName = 'Volatility Squeeze Breakout';
  static strategyBlurb = 'Waits for Bollinger Bands to compress inside the Keltner Channel for 6+ bars, then trades the release in the direction of momentum with a 1.5 ATR stop.';
  // minBars: how long the squeeze must last · confirmBars: bars after the release that
  // momentum has to confirm it
  static RULES = { minBars: 6, confirmBars: 3 };

  constructor(profile, env) {
    super(profile, env);
    this.fired = null; // { dir, index, time }
  }

  evaluate() {
    const bars = this.bars();
    if (bars.length < 40) return this.setStage('Warming up indicators');
    const c = closes(bars);
    const bb = bollinger(c, 20, 2);
    const kc = keltner(bars, 20, 1.5);
    const a = last(atr(bars, 14));
    const mid = sma(c, 20);
    const n = bars.length;
    const on = (i) => bb.upper[i] < kc.upper[i] && bb.lower[i] > kc.lower[i];
    let run = 0;
    for (let i = n - 2; i >= 0 && on(i); i--) run++;
    const squeezeNow = on(n - 1);
    const R = this.rules;
    const released = !squeezeNow && on(n - 2) && run >= R.minBars;
    const mom = c[n - 1] - mid[n - 1];
    const momRising = mom > c[n - 4] - mid[n - 4];
    const price = this.price();

    if (released) {
      this.fired = { dir: mom > 0 ? 'LONG' : 'SHORT', time: bars[n - 1].time, bars: 0 };
      this.note(`Squeeze fired after ${run} bars — momentum ${mom > 0 ? 'up' : 'down'}`, 'setup');
    } else if (this.fired) {
      this.fired.bars++;
      if (this.fired.bars > R.confirmBars) this.fired = null;
    }

    if (this.fired && !this.position()) {
      const long = this.fired.dir === 'LONG';
      const confirm = long ? mom > 0 && momRising && price > bb.mid[n - 1] : mom < 0 && !momRising && price < bb.mid[n - 1];
      if (confirm) {
        const stop = long ? price - 1.5 * a : price + 1.5 * a;
        const ok = this.openTrade({ side: this.fired.dir, stop, target: long ? price + 3.5 * a : price - 3.5 * a, reason: 'Volatility squeeze released', trail: 2 });
        if (ok) this.fired = null;
      }
    }

    const bw = (last(bb.upper) - last(bb.lower)) / (last(kc.upper) - last(kc.lower));
    this.setup = {
      ...this.setup,
      bias: mom > 0 ? 'LONG' : mom < 0 ? 'SHORT' : 'NEUTRAL',
      armed: !this.position() && (squeezeNow || !!this.fired),
      levels: [
        { label: 'BB upper', price: last(bb.upper) },
        { label: 'Basis', price: last(bb.mid) },
        { label: 'BB lower', price: last(bb.lower) },
      ],
      thesis: squeezeNow
        ? `Volatility is compressed: Bollinger Bands sit inside the Keltner Channel (${run + 1} bars). Energy is building; I trade the release with momentum.`
        : `No squeeze right now (BB/KC width ratio ${bw.toFixed(2)}). I only trade compression releases.`,
      checklist: [
        { label: 'Squeeze on (BB inside KC)', ok: squeezeNow || run >= R.minBars },
        { label: `Squeeze lasted ${R.minBars}+ bars`, ok: run >= R.minBars || (squeezeNow && run + 1 >= R.minBars) },
        { label: 'Momentum direction clear', ok: Math.abs(mom) > 0.2 * a },
        { label: 'Release confirmed', ok: !!this.fired },
      ],
      confidence: Math.round(Math.min(95, 15 + Math.min(40, run * 5) + (Math.abs(mom) > 0.2 * a ? 20 : 0) + (this.fired ? 20 : 0))),
      indicators: { 'Squeeze bars': squeezeNow ? run + 1 : 0, 'BB/KC ratio': bw, Momentum: mom, 'ATR(14)': a },
    };
    if (this.position()) this.setStage('In the squeeze breakout, trailing 2 ATR');
    else if (this.fired) this.setStage(`Squeeze fired ${this.fired.dir} — waiting for momentum confirmation`);
    else if (squeezeNow) this.setStage(`Squeeze ON for ${run + 1} bars — coiling`);
    else this.setStage('No compression — scanning for the next squeeze');
  }

  pitch() {
    const st = this.setup;
    if (this.position()) return `I caught a volatility squeeze release on ${this.symbol} and I'm trailing it.`;
    const bars = st.indicators['Squeeze bars'];
    if (bars > 0) return `${this.symbol} is in a volatility squeeze, ${bars} bars and counting. Bollinger is inside Keltner, so a big move is loading. I will trade the release, momentum is pointing ${st.bias === 'LONG' ? 'up' : 'down'}.`;
    return `I trade volatility squeezes on ${this.symbol}. There is no compression right now, so I am waiting for the bands to coil.`;
  }
}
