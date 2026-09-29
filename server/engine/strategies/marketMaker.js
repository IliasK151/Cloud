import { TraderAgent } from '../agent.js';
import { ema, atr, adx, closes, last } from '../../market/indicators.js';
import { roundToLot, SYMBOLS } from '../../market/symbols.js';
import { fmtQty, spokenPnl } from '../../util/format.js';

const MAX_CLIPS = 3;
// Average market-seconds between fills on one side when quoting at the minimum width.
const FILL_INTERVAL_SEC = 300;

// Electronic market-making desk. Rests a bid and an offer around the mid, sized in clips.
// Fills are modelled as a queue: incoming flow hits the resting quotes at a rate that falls
// as quotes widen, and rises on the side the market is moving toward (adverse selection).
// Inventory skews the quotes back to flat; a hard inventory stop dumps risk if the tape runs.
export class MarketMaker extends TraderAgent {
  static strategyName = 'Electronic Market Making';
  static strategyBlurb = 'Rests a two-sided market around the mid in clips, earning the spread plus maker rebates. Inventory skews the quotes, toxic trending flow pulls a side, and an inventory stop dumps risk if the market runs.';

  constructor(profile, env) {
    super(profile, env);
    this.params = null;
    this.quotes = null;
    this.fills = 0;
    this.pauseBars = 0;
    this.lastTick = null;
  }

  get clip() {
    return roundToLot(this.symbol, (this.allocation * 0.03) / this.price());
  }

  get inventory() {
    return this.position()?.qty ?? 0;
  }

  // Recomputed every bar: quote width, skew and the toxic-flow filter.
  #reparam() {
    const bars = this.bars();
    const c = closes(bars);
    const a = last(atr(bars, 14));
    const fast = last(ema(c, 5));
    const slow = last(ema(c, 20));
    const price = this.price();
    if (!Number.isFinite(a) || !Number.isFinite(fast)) return;
    const minHalf = (price * SYMBOLS[this.symbol].spreadBps) / 2 / 1e4;
    const momentum = (fast - slow) / a;
    const directional = last(adx(bars, 14).adx) > 32;
    this.params = {
      half: Math.max(0.12 * a, 1.5 * minHalf),
      minHalf,
      atr: a,
      momentum,
      directional,
      bidLive: !directional && momentum > -0.5,
      askLive: !directional && momentum < 0.5,
    };
    this.#quote(price);
  }

  #quote(mid) {
    const p = this.params;
    if (!p) return;
    const clips = this.clip ? this.inventory / this.clip : 0;
    const skew = -(clips / MAX_CLIPS) * 0.5 * p.half;
    this.quotes = { bid: mid - p.half + skew, ask: mid + p.half + skew, mid, clips };
  }

  evaluate() {
    if (this.bars().length < 30) return this.setStage('Warming up');
    if (this.pauseBars > 0) this.pauseBars--;
    this.#reparam();
    this.#describe();
  }

  onTickExtra(symbol, price) {
    const now = this.env.clock.now();
    const prev = this.lastTick;
    this.lastTick = { t: now, price };
    if (this.#inventoryStop()) return;
    const p = this.params;
    if (!p || !prev || this.pauseBars > 0 || !this.risk.canOpen(this).ok) return;
    const dt = Math.min(10, Math.max(0, (now - prev.t) / 1000));
    if (!dt) return;
    this.#quote(price);
    const q = this.quotes;
    const clip = this.clip;
    if (!clip) return;
    const inv = this.inventory;
    const move = (price - prev.price) / (0.1 * p.atr);
    const width = (p.minHalf * 1.5) / p.half;
    const base = (dt / FILL_INTERVAL_SEC) * Math.min(1, width * 4);
    // Sellers hit the bid more when price is falling (informed flow), and vice versa.
    const pBid = Math.min(0.9, base * (1 + 4 * Math.max(0, -move)) * (1 - Math.max(0, q.clips) / (MAX_CLIPS + 1)));
    const pAsk = Math.min(0.9, base * (1 + 4 * Math.max(0, move)) * (1 - Math.max(0, -q.clips) / (MAX_CLIPS + 1)));
    if (p.bidLive && inv < MAX_CLIPS * clip && Math.random() < pBid) {
      this.trade(symbol, clip, { price: q.bid, maker: true, reason: 'Bid hit', tag: 'MM' });
      this.fills++;
    } else if (p.askLive && inv > -MAX_CLIPS * clip && Math.random() < pAsk) {
      this.trade(symbol, -clip, { price: q.ask, maker: true, reason: 'Offer lifted', tag: 'MM' });
      this.fills++;
    }
  }

  // Inventory stop, checked on every tick. Returns true if it fired.
  #inventoryStop() {
    if (!this.inventory) return false;
    const limit = this.allocation * this.risk.riskPerTradePct * 0.6;
    if (this.unrealized() < -limit) {
      this.closeTrade(this.symbol, 'Inventory stop — market ran through the quotes');
      this.pauseBars = 6;
      this.note('Pulled quotes for 6 bars after an inventory stop', 'risk');
      return true;
    }
    return false;
  }

  onFlatten() {
    this.quotes = null;
  }

  #describe() {
    const q = this.quotes;
    const p = this.params;
    const clips = q?.clips ?? 0;
    const live = !!q && !!p && this.pauseBars === 0 && !p.directional;
    this.setup = {
      ...this.setup,
      bias: clips > 0.5 ? 'LONG' : clips < -0.5 ? 'SHORT' : 'NEUTRAL',
      armed: live,
      levels: q ? [{ label: 'Offer', price: q.ask }, { label: 'Mid', price: q.mid }, { label: 'Bid', price: q.bid }] : [],
      thesis: q && p
        ? `Quoting ${p.bidLive ? this.px(q.bid) : '(bid pulled)'} / ${p.askLive ? this.px(q.ask) : '(offer pulled)'} around the ${this.px(q.mid)} mid. Inventory ${clips >= 0 ? '+' : ''}${clips.toFixed(1)} clips (max ±${MAX_CLIPS}); quotes skew to work it back to flat${p.bidLive && p.askLive ? '' : ', one side pulled because the tape is running'}.`
        : 'Quotes pulled.',
      checklist: [
        { label: 'Quotes live', ok: live },
        { label: `Inventory within ±${MAX_CLIPS} clips`, ok: Math.abs(clips) < MAX_CLIPS },
        { label: 'Tape not directional (ADX ≤ 32)', ok: !!p && !p.directional },
        { label: 'Two-sided (no toxic flow)', ok: !!p && p.bidLive && p.askLive },
      ],
      confidence: Math.round(Math.max(10, 80 - Math.abs(clips) * 12)),
      indicators: { 'Inventory (clips)': clips, 'Fills today': this.fills, 'Half-spread': p?.half ?? 0 },
    };
    if (this.pauseBars > 0) this.setStage(`Quotes pulled (${this.pauseBars} bars) after inventory stop`);
    else if (p?.directional) this.setStage('Tape too directional (ADX > 32) — quotes pulled');
    else if (q) this.setStage(`Making markets: ${this.px(q.bid)} / ${this.px(q.ask)} · inv ${clips >= 0 ? '+' : ''}${clips.toFixed(1)} clips`, 'quiet');
  }

  onNewDay() {
    this.fills = 0;
  }

  pitch() {
    const q = this.quotes;
    if (!q || this.params?.directional) return `I make markets in ${this.symbol}. The tape is too directional right now, so my quotes are pulled until it calms down.`;
    const inv = this.inventory;
    return `I'm making a two-sided market in ${this.symbol}: bid ${this.px(q.bid)}, offer ${this.px(q.ask)}. ${this.fills} fills so far today. ${inv ? `I'm carrying ${fmtQty(inv)} ${inv > 0 ? 'long' : 'short'} inventory, ${spokenPnl(this.unrealized())}, and I'm skewing quotes to get flat.` : 'Inventory is flat, which is exactly where I like it.'}`;
  }
}
