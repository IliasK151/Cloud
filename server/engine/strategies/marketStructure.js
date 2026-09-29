import { TraderAgent } from '../agent.js';
import { atr, ema, resample, swings, closes, last } from '../../market/indicators.js';

// Global macro desk: top-down market structure. 15-minute structure sets the bias,
// the 1-minute chart provides the entry after a pullback into discount/premium and a
// break of minor structure (change of character).
export class MarketStructure extends TraderAgent {
  static strategyName = 'Top-Down Market Structure';
  static strategyBlurb = 'Reads higher highs / higher lows on the 15-minute chart for bias, waits for a pullback into the discount (or premium) half of the last impulse leg, then enters on a 1-minute break of structure.';

  constructor(profile, env) {
    super(profile, env);
    this.ctx = null;
  }

  #htfBias(bars) {
    const htf = resample(bars, 15);
    if (htf.length < 12) return { bias: 'NEUTRAL', why: 'Not enough 15m history' };
    const { highs, lows } = swings(htf, 2, 40);
    const e = ema(closes(htf), 10);
    const slope = last(e) - last(e, 3);
    if (highs.length >= 2 && lows.length >= 2) {
      const hh = last(highs).price > last(highs, 1).price;
      const hl = last(lows).price > last(lows, 1).price;
      if (hh && hl) return { bias: 'LONG', why: 'Higher highs and higher lows on the 15m' };
      if (!hh && !hl) return { bias: 'SHORT', why: 'Lower highs and lower lows on the 15m' };
    }
    if (Math.abs(slope) > 0) {
      const price = last(htf).close;
      if (slope > 0 && price > last(e)) return { bias: 'LONG', why: '15m EMA rising, price above it' };
      if (slope < 0 && price < last(e)) return { bias: 'SHORT', why: '15m EMA falling, price below it' };
    }
    return { bias: 'NEUTRAL', why: 'Mixed 15m structure' };
  }

  evaluate() {
    const bars = this.bars();
    if (bars.length < 200) return this.setStage('Building the 15-minute structure');
    const a = last(atr(bars, 14));
    const price = this.price();
    const htf = this.#htfBias(bars);
    const n = bars.length;
    const win = bars.slice(-90);
    const off = n - win.length;

    let leg = null;
    if (htf.bias === 'LONG') {
      let iH = 0;
      win.forEach((b, i) => { if (b.high >= win[iH].high) iH = i; });
      const pre = win.slice(0, iH + 1);
      let iL = 0;
      pre.forEach((b, i) => { if (b.low <= pre[iL].low) iL = i; });
      const post = win.slice(iH + 1);
      if (post.length >= 3 && iH - iL >= 5) {
        let iP = 0;
        post.forEach((b, i) => { if (b.low <= post[iP].low) iP = i; });
        leg = { from: win[iL].low, to: win[iH].high, pullback: post[iP].low, pbIndex: off + iH + 1 + iP };
      }
    } else if (htf.bias === 'SHORT') {
      let iL = 0;
      win.forEach((b, i) => { if (b.low <= win[iL].low) iL = i; });
      const pre = win.slice(0, iL + 1);
      let iH = 0;
      pre.forEach((b, i) => { if (b.high >= pre[iH].high) iH = i; });
      const post = win.slice(iL + 1);
      if (post.length >= 3 && iL - iH >= 5) {
        let iP = 0;
        post.forEach((b, i) => { if (b.high >= post[iP].high) iP = i; });
        leg = { from: win[iH].high, to: win[iL].low, pullback: post[iP].high, pbIndex: off + iL + 1 + iP };
      }
    }

    let inZone = false;
    let intact = false;
    let bos = false;
    let eq = null;
    if (leg) {
      eq = (leg.from + leg.to) / 2;
      const long = htf.bias === 'LONG';
      inZone = long ? leg.pullback <= eq : leg.pullback >= eq;
      intact = long ? leg.pullback > leg.from : leg.pullback < leg.from;
      const since = n - 1 - leg.pbIndex;
      if (since >= 2 && since <= 20) {
        const minor = bars.slice(Math.max(leg.pbIndex, n - 6), n - 1);
        if (minor.length) {
          const level = long ? Math.max(...minor.map((b) => b.high)) : Math.min(...minor.map((b) => b.low));
          const bar = bars[n - 1];
          bos = long ? bar.close > level : bar.close < level;
        }
      }
      if (!this.position() && inZone && intact && bos) {
        const stop = long ? leg.pullback - 0.3 * a : leg.pullback + 0.3 * a;
        const risk = Math.abs(price - stop);
        // Target the liquidity at the leg extreme if it pays at least 2R.
        const target = Math.abs(leg.to - price) >= 2 * risk ? leg.to : long ? price + 2.5 * risk : price - 2.5 * risk;
        const key = `${leg.pbIndex}-${leg.pullback}`;
        if (this.lastKey !== key) {
          this.lastKey = key;
          this.openTrade({ side: htf.bias, stop, target, reason: `15m ${htf.bias.toLowerCase()} structure, pullback into ${long ? 'discount' : 'premium'}, 1m BOS`, trail: 3 });
        }
      }
    }
    this.ctx = { htf, leg, eq };
    this.setup = {
      ...this.setup,
      bias: htf.bias,
      armed: !this.position() && !!leg && inZone && intact,
      levels: leg
        ? [
          { label: htf.bias === 'LONG' ? 'Leg high' : 'Leg low', price: leg.to },
          { label: 'Equilibrium 50%', price: eq },
          { label: 'Pullback extreme', price: leg.pullback },
          { label: 'Leg origin', price: leg.from },
        ]
        : [],
      thesis: `${htf.why}. ${leg ? `Last impulse ${this.px(leg.from)} → ${this.px(leg.to)}; equilibrium ${this.px(eq)}. I only ${htf.bias === 'LONG' ? 'buy in discount' : 'sell in premium'} after the 1-minute chart breaks structure back in the trend direction.` : 'No clean impulse leg to trade off yet.'}`,
      checklist: [
        { label: '15m bias defined', ok: htf.bias !== 'NEUTRAL' },
        { label: 'Impulse leg identified', ok: !!leg },
        { label: `Pullback into ${htf.bias === 'SHORT' ? 'premium' : 'discount'}`, ok: inZone },
        { label: 'Structure intact (origin holds)', ok: intact },
        { label: '1m break of structure', ok: bos },
      ],
      confidence: Math.round(Math.min(95, (htf.bias !== 'NEUTRAL' ? 30 : 5) + (leg ? 15 : 0) + (inZone ? 20 : 0) + (intact ? 10 : 0) + (bos ? 20 : 0))),
      indicators: { 'ATR(14)': a, 'HTF bias': htf.bias },
    };
    if (this.position()) this.setStage(`Positioned with the 15m ${htf.bias.toLowerCase()} trend`);
    else if (htf.bias === 'NEUTRAL') this.setStage('15m structure mixed — no bias, no trade');
    else if (!leg) this.setStage(`15m ${htf.bias.toLowerCase()} — waiting for an impulse leg`);
    else if (!inZone) this.setStage(`Waiting for a pullback to ${htf.bias === 'LONG' ? 'discount below' : 'premium above'} ${this.px(eq)}`);
    else if (!intact) this.setStage('Leg origin broken — structure invalid');
    else this.setStage(`In ${htf.bias === 'LONG' ? 'discount' : 'premium'} — waiting for the 1m break of structure`);
  }

  pitch() {
    const c = this.ctx;
    if (!c) return `I trade top-down market structure on ${this.symbol}. Still building the higher-timeframe picture.`;
    if (this.position()) return `I'm positioned with the fifteen-minute trend on ${this.symbol}. ${c.htf.why}.`;
    if (c.htf.bias === 'NEUTRAL') return `Top-down on ${this.symbol}: the fifteen-minute structure is mixed, so I have no bias and no trade. Discipline first.`;
    return `Top-down on ${this.symbol}: bias is ${c.htf.bias === 'LONG' ? 'bullish' : 'bearish'}, ${c.htf.why.toLowerCase()}. ${c.eq ? `Equilibrium of the last leg is ${this.px(c.eq)}; I want price ${c.htf.bias === 'LONG' ? 'below' : 'above'} it and a one-minute break of structure before I pull the trigger.` : 'Waiting for a clean impulse leg.'}`;
  }
}
