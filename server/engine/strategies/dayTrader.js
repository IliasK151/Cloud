import { TraderAgent } from '../agent.js';
import { DayPlaybook, PLAYBOOK, KILLZONES, zonesText } from '../daytrade.js';

const lcLabel = (label) => (/^(Asia|London|New York)/.test(label) ? label : label.charAt(0).toLowerCase() + label.slice(1));

// The Day Trading Desk: TJR-style day traders. Top-down first (weekly, daily, 4-hour bias), then
// the session liquidity, the sweep, the 5-minute shift with displacement, and the entry back in
// the fair value gap with the stop beyond the sweep and the target at the liquidity on the other
// side, 3R or more. One trade a day. The playbook itself is engine/daytrade.js; this desk runs it
// on the floor's bars and says what it is waiting for.
export class DayTrader extends TraderAgent {
  static strategyName = 'Top-Down Day Trading (TJR style)';
  static strategyBlurb = 'Top-down first: the weekly, daily and 4-hour structure set the bias, and it only trades with it. Then the liquidity: the previous day\'s and week\'s highs and lows, the Asia and London ranges. In the killzone it waits for price to sweep a level against the bias and come back, a 5-minute break of structure with displacement that leaves a fair value gap, and enters on the pullback into the gap. Stop beyond the sweep, target the liquidity on the other side at 3R or more. One trade a day, flat by the close.';
  static RULES = { ...PLAYBOOK };

  constructor(profile, env) {
    super(profile, env);
    this.pb = this.#playbook();
  }

  #playbook() {
    // Demo mode's clock runs 09:30–16:00 New York only: its morning is the killzone there.
    const rules = this.session.mode === 'sim' ? { ...this.rules, zones: 'demo' } : this.rules;
    return new DayPlaybook(rules, (x) => this.px(x));
  }

  resetMarket() {
    this.pb = this.#playbook();
  }

  onFlatten() {
    this.pb.pending = null;
  }

  // The market's top-down book (engine/topdown.js), shared by the floor.
  topDownBook() {
    return this.env.topDown?.(this.symbol) || null;
  }

  evaluate(symbol, bar) {
    if (symbol !== this.symbol) return;
    const book = this.topDownBook();
    if (!book) return this.setStage('No top-down read for this market', 'quiet');
    book.feed(bar); // the floor's books are fed too: the same bar twice is skipped
    const flat = this.session.isFlattenWindow();
    if (flat) this.pb.pending = null;
    let order = flat ? null : this.pb.onBar(book, bar);
    // Already in a trade: the map stays current, nothing new.
    if (order && this.position()) { order = null; this.pb.pending = null; }
    for (const ev of this.pb.events.splice(0)) this.note(`Setup cancelled: ${ev.why}`, 'setup');
    if (order) {
      if (order.market) this.#take(order);
      else {
        this.note(`${order.side === 'LONG' ? 'Buy' : 'Sell'} setup on ${this.symbol}: ${order.reason}. Waiting for the pullback to ${this.px(order.entry)}, stop ${this.px(order.stop)}, target ${this.px(order.target)}`, 'setup');
        this.setup.armed = true;
      }
    }
    this.#describe(book);
  }

  // The limit entry: filled when price comes back to it (a jump well past it is let go, so the
  // entry never ends up next to the stop).
  onTickExtra(symbol, price) {
    const p = this.pb.pending;
    if (!p || symbol !== this.symbol) return;
    if (this.position()) { this.pb.pending = null; return; }
    const ev = this.pb.touch(price);
    if (ev?.kind === 'cancel') {
      this.pb.events.splice(0);
      this.setup.armed = false;
      this.note(`Setup cancelled: ${ev.why}`, 'setup');
    } else if (ev?.kind === 'fill') {
      if (Math.abs(price - p.entry) > 0.2 * Math.abs(p.entry - p.stop)) {
        this.note('Setup cancelled: price jumped through the entry', 'setup');
        return;
      }
      this.#take(p);
      const book = this.topDownBook();
      if (book) this.#describe(book);
    }
  }

  #take(order) {
    const ok = this.openTrade({ side: order.side, stop: order.stop, target: order.target, reason: order.reason, partialAt: 0, trail: null });
    if (ok) this.pb.filled();
    this.setup.armed = false;
    return ok;
  }

  #describe(book) {
    const pb = this.pb;
    const read = pb.read || book.read();
    const v = pb.view();
    const price = this.price();
    const long = v.bias === 'LONG';
    const levels = v.levels.filter((l) => !l.swept);
    const above = levels.filter((l) => l.side === 'above' && l.price > price).sort((a, b) => a.price - b.price);
    const below = levels.filter((l) => l.side === 'below' && l.price < price).sort((a, b) => b.price - a.price);
    const zones = zonesText(pb.rules.zones);
    const sweep = pb.sweep.LONG || pb.sweep.SHORT;
    const p = v.pending;
    const pos = this.position();
    this.setup = {
      ...this.setup,
      bias: v.bias || 'NEUTRAL',
      armed: !!p,
      topDown: read.text,
      levels: [
        ...above.slice(0, 2).map((l) => ({ label: `BSL · ${l.label}`, price: l.price })),
        ...below.slice(0, 2).map((l) => ({ label: `SSL · ${l.label}`, price: l.price })),
        ...(p ? [{ label: 'Entry (fair value gap)', price: p.entry }, { label: 'Stop (beyond the sweep)', price: p.stop }, { label: `Target · ${p.targetLabel}`, price: p.target }] : []),
        ...(read.aois || []).slice(0, 2).map((a) => ({ label: `${a.both ? 'W+D' : a.tf} AOI`, price: a.level })),
      ],
      thesis: `${read.text}. ${v.bias ? `I only ${long ? 'buy' : 'sell'} today, and only after price runs ${long ? 'sell-side liquidity (a low)' : 'buy-side liquidity (a high)'}: ${long ? (below[0] ? `the ${lcLabel(below[0].label)} at ${this.px(below[0].price)}` : 'no low left untouched below') : (above[0] ? `the ${lcLabel(above[0].label)} at ${this.px(above[0].price)}` : 'no high left untouched above')}.` : 'No clear bias: no trade until the higher timeframes agree.'} Then a 5-minute break of structure with displacement, the entry back in the fair value gap, the stop beyond the sweep and the target at the liquidity on the other side, 3R or more. My windows: ${zones} (New York time).`,
      checklist: [
        { label: `Top-down bias: ${read.short}${v.bias ? ` → ${long ? 'bullish' : 'bearish'}` : ' → none'}`, ok: !!v.bias },
        { label: `Inside a killzone (${zones})`, ok: !!v.kz },
        { label: sweep ? `Liquidity swept: ${sweep.level.label}` : `Liquidity swept against the bias`, ok: !!sweep || !!p || !!pos },
        { label: '5-minute shift with displacement and a fair value gap', ok: !!p || !!pos },
        { label: 'Entry in the gap, stop beyond the sweep, 3R+ to the liquidity', ok: !!p || !!pos },
        { label: `Trades today: ${v.trades} of ${pb.rules.maxPerDay}`, ok: v.trades < pb.rules.maxPerDay },
      ],
      confidence: Math.round(Math.min(90, (v.bias ? 25 + 8 * (read.strength || 0) : 0) + (v.kz ? 15 : 0) + (sweep ? 15 : 0) + (p ? 20 : 0))),
      indicators: { 'ATR 5m': pb.atr ?? null, 'ATR daily': read.atrD ?? null, 'Range position': read.zone ? Math.round(read.zone.pos * 100) : null, 'Liquidity above': above.length, 'Liquidity below': below.length },
    };
    if (pos) this.setStage(`In a ${pos.qty > 0 ? 'long' : 'short'} day trade, working toward the liquidity`);
    else if (p) this.setStage(`Waiting for the pullback to ${this.px(p.entry)} to ${p.side === 'LONG' ? 'buy' : 'sell'} (stop ${this.px(p.stop)}, target ${this.px(p.target)})`);
    else this.setStage(v.why, /^Setup cancelled|^Price swept/.test(v.why) ? 'setup' : 'quiet');
  }

  pitch() {
    const pb = this.pb;
    const read = pb.read;
    if (!read) return `I day trade ${this.symbol} top-down: the weekly, daily and 4-hour bias first, then a liquidity sweep and a 5-minute shift, 3R or more.`;
    if (this.position()) return `I'm in a day trade on ${this.symbol} (${read.text}). The liquidity got swept, structure shifted, and I'm holding for the liquidity on the other side.`;
    if (pb.pending) return `I have a ${pb.pending.side === 'LONG' ? 'buy' : 'sell'} setup on ${this.symbol}: ${pb.pending.reason}. I'm waiting for the pullback to ${this.px(pb.pending.entry)}.`;
    if (!pb.bias) return `${read.text} on ${this.symbol}. No bias, no trade: I wait until the higher timeframes agree.`;
    const kz = pb.kz ? `We're in the ${pb.kz.label} now` : `My windows are ${zonesText(pb.rules.zones)} New York time`;
    return `${read.text} on ${this.symbol}, so I only ${pb.bias === 'LONG' ? 'buy' : 'sell'} today. ${kz}. I wait for price to run ${pb.bias === 'LONG' ? 'a low' : 'a high'} and turn, then a 5-minute shift with displacement, and I'm in on the pullback with the stop beyond the sweep, aiming for 3R or more.`;
  }
}

export { KILLZONES };
