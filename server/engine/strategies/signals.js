import { TraderAgent } from '../agent.js';
import { supertrend, atr, last } from '../../market/indicators.js';

// TradingView signals desk: executes TradingView webhook alerts for any instrument,
// and runs the classic TradingView Supertrend (10, 3) on its home market in between.
export class TradingViewSignals extends TraderAgent {
  static strategyName = 'TradingView Signals + Supertrend';
  static strategyBlurb = 'Executes TradingView webhook alerts (any symbol) with house risk sizing. Between alerts it trades Supertrend(10, 3) flips on its home market, trailing the Supertrend line.';

  constructor(profile, env) {
    super(profile, env);
    this.lastAlert = null;
    this.st = null;
  }

  evaluate(symbol) {
    if (symbol !== this.symbol) return;
    const bars = this.bars();
    if (bars.length < 30) return this.setStage('Warming up Supertrend');
    const { line, dir } = supertrend(bars, 10, 3);
    const d = last(dir);
    const prevD = last(dir, 1);
    const l = last(line);
    const a = last(atr(bars, 14));
    const price = this.price();
    const flip = d !== prevD && prevD !== 0;
    this.st = { dir: d, line: l };
    const pos = this.position();
    const plan = this.plan;

    // Trail house (non-alert) trades on the Supertrend line.
    if (plan && plan.tag !== 'TV') {
      const long = plan.side === 'LONG';
      if (long && d === 1 && l > plan.stop) plan.stop = l;
      if (!long && d === -1 && l < plan.stop) plan.stop = l;
    }
    if (flip && pos && plan?.tag !== 'TV' && (pos.qty > 0) !== (d === 1)) {
      this.closeTrade(this.symbol, 'Supertrend flipped');
    }
    if (flip && !this.position()) {
      const side = d === 1 ? 'LONG' : 'SHORT';
      const stop = d === 1 ? Math.min(l, price - a) : Math.max(l, price + a);
      this.openTrade({ side, stop, target: null, reason: `Supertrend flipped ${d === 1 ? 'bullish' : 'bearish'}`, partialAt: 1.5, tag: 'ST' });
    }

    const distAtr = Math.abs(price - l) / a;
    const alertAge = this.lastAlert ? Math.round((Date.now() - this.lastAlert.at) / 60000) : null;
    this.setup = {
      ...this.setup,
      bias: d === 1 ? 'LONG' : 'SHORT',
      armed: !this.position() && distAtr < 1,
      levels: [{ label: `Supertrend (${d === 1 ? 'support' : 'resistance'})`, price: l }],
      thesis: `Listening for TradingView webhooks on every desk's markets. House signal: Supertrend(10, 3) is ${d === 1 ? 'bullish' : 'bearish'} on ${this.symbol}, line at ${this.px(l)} (${distAtr.toFixed(1)} ATR away).` +
        (this.lastAlert ? ` Last alert: ${this.lastAlert.action.toUpperCase()} ${this.lastAlert.symbol}, ${alertAge} min ago.` : ' No TradingView alerts received yet.'),
      checklist: [
        { label: 'TradingView webhook listening', ok: true },
        { label: 'Alert received this session', ok: !!this.lastAlert },
        { label: 'Supertrend direction', ok: true },
        { label: 'Price near the Supertrend line (<1 ATR)', ok: distAtr < 1 },
      ],
      confidence: Math.round(Math.min(90, 40 + (distAtr < 1 ? 20 : 0) + (this.lastAlert ? 20 : 0))),
      indicators: { 'Supertrend': l, 'Direction': d === 1 ? 'UP' : 'DOWN', 'ATR(14)': a },
    };
    if (this.position()) this.setStage(plan?.tag === 'TV' ? 'Managing a TradingView alert trade' : `Riding the Supertrend ${d === 1 ? 'long' : 'short'}`);
    else this.setStage(`Supertrend ${d === 1 ? 'bullish' : 'bearish'} at ${this.px(l)} — listening for alerts`);
  }

  pitch() {
    const st = this.st;
    const alert = this.lastAlert
      ? `The last TradingView alert was a ${this.lastAlert.action} on ${this.lastAlert.symbol}.`
      : `I haven't received any TradingView alerts yet. Point your alerts at the webhook and I'll execute them.`;
    const house = st ? `My house signal, the Supertrend on ${this.symbol}, is ${st.dir === 1 ? 'bullish' : 'bearish'} with the line at ${this.px(st.line)}.` : '';
    return `I run the TradingView signals desk. ${alert} ${house}`;
  }
}
