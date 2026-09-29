import { TraderAgent } from '../agent.js';
import { ols, last } from '../../market/indicators.js';
import { fmtUsd, spokenPnl } from '../../util/format.js';
import { roundToLot } from '../../market/symbols.js';

const LOOKBACK = 150;
const Z_WINDOW = 60;
const ENTRY_Z = 2.0;
const EXIT_Z = 0.35;
const STOP_Z = 3.6;
const MAX_BARS = 120;

// Quant desk: ETH/BTC statistical arbitrage. Hedge ratio from rolling OLS on log prices,
// trades the z-score of the spread, dollar-hedged, market-neutral.
export class PairsArbitrage extends TraderAgent {
  static strategyName = 'Statistical Arbitrage (ETH/BTC)';
  static strategyBlurb = 'Estimates a rolling hedge ratio between ETH and BTC, trades the spread when its z-score stretches beyond ±2 and exits on mean reversion. Market-neutral, both legs hedged.';

  constructor(profile, env) {
    super(profile, env);
    this.pair = null;
    this.stat = null;
    this.pendingLegs = [];
  }

  #compute() {
    const [ya, xb] = this.symbols;
    const ea = this.bars(ya);
    const eb = this.bars(xb);
    const mapB = new Map(eb.map((b) => [b.time, b.close]));
    const aligned = [];
    for (const b of ea) if (mapB.has(b.time)) aligned.push([Math.log(b.close), Math.log(mapB.get(b.time))]);
    if (aligned.length < LOOKBACK) return null;
    const win = aligned.slice(-LOOKBACK);
    const y = win.map((p) => p[0]);
    const x = win.map((p) => p[1]);
    const { beta, alpha } = ols(x, y);
    const spread = win.map((p) => p[0] - beta * p[1] - alpha);
    const zw = spread.slice(-Z_WINDOW);
    const mean = zw.reduce((s, v) => s + v, 0) / zw.length;
    const sd = Math.sqrt(zw.reduce((s, v) => s + (v - mean) ** 2, 0) / zw.length);
    const liveSpread = Math.log(this.price(ya)) - beta * Math.log(this.price(xb)) - alpha;
    return { beta, sd, mean, z: sd > 0 ? (liveSpread - mean) / sd : 0, spreadSeries: spread };
  }

  evaluate(symbol) {
    if (symbol !== this.symbol) return;
    const stat = this.#compute();
    if (!stat) return this.setStage('Collecting aligned ETH/BTC history');
    this.stat = stat;
    const { z, beta, sd } = stat;
    const [ya, xb] = this.symbols;

    if (this.pair) {
      this.pair.bars++;
      const adverse = this.pair.dir === 1 ? z < -STOP_Z : z > STOP_Z;
      if (Math.abs(z) < EXIT_Z) this.#closePair('Spread converged');
      else if (adverse) this.#closePair(`Spread stop (z ${z.toFixed(2)})`);
      else if (this.pair.bars > MAX_BARS) this.#closePair('Time stop');
    } else if (Math.abs(z) > ENTRY_Z && sd > 0) {
      const check = this.risk.canOpen(this);
      if (check.ok) {
        const dir = z < 0 ? 1 : -1; // +1: long ETH / short BTC
        const riskUsd = this.allocation * this.risk.riskPerTradePct;
        const adverseMove = (STOP_Z - Math.abs(z)) * sd;
        const notional = Math.min(this.allocation * 0.75, riskUsd / Math.max(adverseMove, 0.002));
        const qa = (dir * notional) / this.price(ya);
        const qb = (-dir * beta * notional) / this.price(xb);
        const ra = this.trade(ya, roundToLot(ya, qa), { reason: 'Pair entry', tag: 'PAIR', initialRisk: riskUsd / 2 });
        const rb = this.trade(xb, roundToLot(xb, qb), { reason: 'Pair hedge', tag: 'PAIR', initialRisk: riskUsd / 2 });
        if (ra && rb) {
          this.pair = { dir, entryZ: z, beta, bars: 0, notional };
          this.day.entries++;
          this.note(`${dir === 1 ? 'Long' : 'Short'} the ETH/BTC spread at z ${z.toFixed(2)} (β ${beta.toFixed(2)}), ${fmtUsd(notional)} per leg`, 'entry', { symbol: ya });
        }
      } else {
        this.setStage(`Signal skipped — ${check.reason}`);
      }
    }

    const stretched = Math.abs(z) > 1.5;
    this.setup = {
      ...this.setup,
      bias: z > 1 ? 'SHORT' : z < -1 ? 'LONG' : 'NEUTRAL',
      armed: !this.pair && stretched,
      levels: [],
      thesis: `Spread = ln(ETH) − ${beta.toFixed(2)}·ln(BTC). Z-score ${z.toFixed(2)}. Enter beyond ±${ENTRY_Z}, exit inside ±${EXIT_Z}, stop beyond ±${STOP_Z}. Both legs hedged, so the book is market-neutral.`,
      checklist: [
        { label: `${LOOKBACK} aligned bars`, ok: true },
        { label: 'Hedge ratio stable (0.3 < β < 3)', ok: beta > 0.3 && beta < 3 },
        { label: `|z| > ${ENTRY_Z}`, ok: Math.abs(z) > ENTRY_Z },
        { label: 'Book flat before entry', ok: !this.pair },
      ],
      confidence: Math.round(Math.min(95, 20 + Math.min(60, Math.abs(z) * 25))),
      indicators: { 'Z-score': z, 'Hedge β': beta, 'Spread σ': sd },
    };
    if (this.pair) this.setStage(`Holding ${this.pair.dir === 1 ? 'long' : 'short'} spread, z ${z.toFixed(2)} → target ±${EXIT_Z}`);
    else if (stretched) this.setStage(`Spread stretched (z ${z.toFixed(2)}) — entry beyond ±${ENTRY_Z}`);
    else this.setStage(`Spread fair (z ${z.toFixed(2)}) — no edge`);
  }

  #closePair(reason) {
    this.pendingLegs = [];
    for (const s of this.symbols) if (this.position(s)) this.closeTrade(s, reason);
    this.pair = null;
  }

  onFlatten() {
    this.pair = null;
  }

  // Combine both legs into a single round trip for the desk's stats.
  onTradeClosed(trade) {
    this.pendingLegs.push(trade);
    const open = this.symbols.some((s) => this.position(s));
    if (open) return;
    const legs = this.pendingLegs.splice(0);
    const pnl = legs.reduce((s, t) => s + t.pnl, 0);
    const risk = this.allocation * this.risk.riskPerTradePct;
    super.onTradeClosed({ ...legs[legs.length - 1], symbol: 'ETH/BTC', pnl, r: pnl / risk });
  }

  pitch() {
    const s = this.stat;
    if (!s) return `I run statistical arbitrage between ETH and BTC. Still collecting enough aligned data to estimate the hedge ratio.`;
    if (this.pair) {
      const unreal = this.unrealized();
      return `I'm ${this.pair.dir === 1 ? 'long ETH and short BTC' : 'short ETH and long BTC'}, a market-neutral spread trade entered at a z-score of ${this.pair.entryZ.toFixed(1)}. Z is now ${s.z.toFixed(1)}, and the pair is ${spokenPnl(unreal)}. I exit when z comes back inside ${EXIT_Z}.`;
    }
    return `I trade the ETH versus BTC spread. The hedge ratio is ${s.beta.toFixed(2)} and the spread z-score is ${s.z.toFixed(1)}. I enter beyond plus or minus two, so ${Math.abs(s.z) > 1.5 ? 'it is getting interesting' : 'there is no edge right now'}.`;
  }
}
