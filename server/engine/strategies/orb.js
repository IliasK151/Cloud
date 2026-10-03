import { TraderAgent } from '../agent.js';
import { atr, sma, last } from '../../market/indicators.js';

const RANGE_MIN = 15;
const WINDOW_MIN = 150;

export function indexFrom(bars, ms) {
  const sec = ms / 1000;
  let i = bars.length;
  while (i > 0 && bars[i - 1].time >= sec) i--;
  return i;
}

// Index futures desk: Opening Range Breakout at the London and New York opens.
export class OpeningRangeBreakout extends TraderAgent {
  static strategyName = 'Opening Range Breakout';
  static strategyBlurb = 'Marks the first 15 minutes after the London and New York opens, then trades a volume-confirmed break of that range with a stop at the range midpoint.';
  // minWidth / maxWidth: the range in ATRs it trades · volume: the break bar's volume against
  // the 20-bar average
  static RULES = { minWidth: 1.5, maxWidth: 9, volume: 1.1 };

  constructor(profile, env) {
    super(profile, env);
    this.windows = new Map();
    this.range = null;
  }

  resetMarket() {
    this.range = null;
  }

  #activeWindow(now) {
    const candidates = [
      { name: 'New York', start: this.session.nyOpen(now) },
      { name: 'London', start: this.session.londonOpen(now) },
    ].filter((w) => now >= w.start && now < w.start + WINDOW_MIN * 60_000);
    return candidates[0] || null;
  }

  evaluate() {
    const now = this.env.clock.now();
    const bars = this.bars();
    const a = last(atr(bars, 14));
    const win = this.#activeWindow(now);
    if (!win || !Number.isFinite(a)) {
      this.range = null;
      this.setup = { ...this.setup, bias: 'NEUTRAL', armed: false, levels: [], confidence: 0,
        thesis: 'Opening range strategies only trade the first two and a half hours after the London (03:00 ET) and New York (09:30 ET) opens.',
        checklist: [{ label: 'Inside an open window', ok: false }] };
      this.setStage('Waiting for the next London / New York open');
      return;
    }

    const from = indexFrom(bars, win.start);
    const rangeEnd = win.start + RANGE_MIN * 60_000;
    const rangeBars = bars.slice(from).filter((b) => b.time * 1000 < rangeEnd);
    const hi = Math.max(...rangeBars.map((b) => b.high));
    const lo = Math.min(...rangeBars.map((b) => b.low));
    const mid = (hi + lo) / 2;

    if (now < rangeEnd) {
      this.range = rangeBars.length ? { hi, lo, mid, name: win.name, forming: true } : null;
      this.setup = { ...this.setup, bias: 'NEUTRAL', armed: false, confidence: 20,
        levels: rangeBars.length ? [{ label: 'Range high', price: hi }, { label: 'Range low', price: lo }] : [],
        thesis: `Letting the ${win.name} open print its first ${RANGE_MIN} minutes before committing.`,
        checklist: [{ label: 'Inside an open window', ok: true }, { label: `Range complete (${rangeBars.length}/${RANGE_MIN})`, ok: false }] };
      this.setStage(`Marking the ${win.name} opening range (${rangeBars.length}/${RANGE_MIN} min)`);
      return;
    }
    if (rangeBars.length < 8) {
      this.setStage('Opening range incomplete — data gap, standing aside');
      return;
    }

    const key = `${this.session.tradingDay(now)}-${win.name}`;
    if (!this.windows.has(key)) this.windows.set(key, { long: false, short: false });
    const state = this.windows.get(key);
    const width = hi - lo;
    const R = this.rules;
    const widthOk = width >= R.minWidth * a && width <= R.maxWidth * a;
    const vols = bars.map((b) => b.volume);
    const avgVol = last(sma(vols, 20));
    const bar = bars[bars.length - 1];
    const volOk = bar.volume >= R.volume * avgVol;
    const price = this.price();
    this.range = { hi, lo, mid, name: win.name, forming: false };

    const flat = !this.position();
    if (flat && widthOk && volOk && !state.long && bar.close > hi + 0.1 * a) {
      state.long = true;
      const stop = Math.min(mid, price - 1.2 * a);
      this.openTrade({ side: 'LONG', stop, target: price + 2 * (price - stop), reason: `${win.name} ORB long above ${this.px(hi)}`, trail: 2.5 });
    } else if (flat && widthOk && volOk && !state.short && bar.close < lo - 0.1 * a) {
      state.short = true;
      const stop = Math.max(mid, price + 1.2 * a);
      this.openTrade({ side: 'SHORT', stop, target: price - 2 * (stop - price), reason: `${win.name} ORB short below ${this.px(lo)}`, trail: 2.5 });
    }

    const armed = flat && widthOk && (!state.long || !state.short);
    this.setup = {
      ...this.setup,
      bias: price > hi ? 'LONG' : price < lo ? 'SHORT' : 'NEUTRAL',
      armed,
      levels: [
        { label: 'Range high', price: hi },
        { label: 'Range mid', price: mid },
        { label: 'Range low', price: lo },
      ],
      thesis: `${win.name} range ${this.px(lo)}–${this.px(hi)} (${(width / a).toFixed(1)}× ATR). A close outside the range on above-average volume is the trigger; stop at the midpoint, 2R target, trail after 1R.`,
      checklist: [
        { label: 'Range complete', ok: true },
        { label: `Range width ${R.minWidth}–${R.maxWidth}× ATR`, ok: widthOk },
        { label: `Break bar volume > ${R.volume}× average`, ok: volOk },
        { label: 'Long side available', ok: !state.long },
        { label: 'Short side available', ok: !state.short },
      ],
      confidence: Math.round(30 + (widthOk ? 25 : 0) + (volOk ? 25 : 0) + (price > hi || price < lo ? 15 : 0)),
      indicators: { 'ATR(14)': a, 'Range width': width, 'Vol / avg': avgVol ? bar.volume / avgVol : 0 },
    };
    if (!flat) this.setStage(`In the ${win.name} breakout trade`);
    else if (!widthOk) this.setStage(`${win.name} range ${width < R.minWidth * a ? 'too tight' : 'too wide'} — standing aside`);
    else if (armed) this.setStage(`Armed: long above ${this.px(hi)}, short below ${this.px(lo)}`);
    else this.setStage(`${win.name} range traded both ways — done for this open`);
  }

  pitch() {
    const r = this.range;
    if (!r) return `I'm running the Opening Range Breakout on ${this.symbol}. Nothing to do until the next London or New York open, so I'm keeping my powder dry.`;
    if (r.forming) return `The ${r.name} opening range on ${this.symbol} is still forming, ${this.px(r.lo)} to ${this.px(r.hi)} so far. I wait for the full fifteen minutes.`;
    if (this.position()) return `I caught the ${r.name} opening range break on ${this.symbol}. The range was ${this.px(r.lo)} to ${this.px(r.hi)}.`;
    return `My setup is the ${r.name} opening range on ${this.symbol}: ${this.px(r.lo)} to ${this.px(r.hi)}. I buy a volume break above ${this.px(r.hi)} or sell a break below ${this.px(r.lo)}, stop at the midpoint.`;
  }
}
