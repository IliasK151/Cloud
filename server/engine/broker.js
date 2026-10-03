import { EventEmitter } from 'node:events';
import { SYMBOLS, usdPerQuote, roundToTick } from '../market/symbols.js';

// Paper prime broker: fills orders against the live mark with spread + slippage,
// charges commissions, keeps positions per desk and books round-trip trades.
// Emits 'fill' (fill) and 'trade' (closedTrade).

const TAKER_FEE_BPS = 0.35; // a market without its own commission (symbols.js feeBps)
const MAKER_REBATE_BPS = 0.1;
const MAX_TRADES_KEPT = 400;

let fillSeq = 0;
let tradeSeq = 0;

export class Book {
  constructor(agentId) {
    this.agentId = agentId;
    this.positions = new Map(); // symbol -> position
    this.realizedDay = 0;
    this.realizedTotal = 0;
    this.feesDay = 0;
    this.feesTotal = 0;
    this.trades = []; // closed round trips, newest last
    this.fills = [];
  }

  resetDay() {
    this.realizedDay = 0;
    this.feesDay = 0;
  }
}

export class Broker extends EventEmitter {
  constructor(md, clock) {
    super();
    this.md = md;
    this.clock = clock;
    this.books = new Map();
  }

  book(agentId) {
    if (!this.books.has(agentId)) this.books.set(agentId, new Book(agentId));
    return this.books.get(agentId);
  }

  position(agentId, symbol) {
    return this.book(agentId).positions.get(symbol) || null;
  }

  // qty > 0 buys, qty < 0 sells. Market orders cross half the spread plus slippage;
  // passing `price` with maker=true fills passively at that price (market making).
  execute(agentId, symbol, qty, { price, maker = false, tag = '', reason = '', stop = null, target = null, initialRisk = 0, meta = null } = {}) {
    if (!qty || !Number.isFinite(qty)) return null;
    const sym = SYMBOLS[symbol];
    const mark = this.md.price(symbol);
    if (!Number.isFinite(mark)) return null;

    let fillPrice;
    if (maker && Number.isFinite(price)) {
      fillPrice = roundToTick(symbol, price);
    } else {
      const halfSpread = (mark * sym.spreadBps) / 2 / 1e4;
      const slip = halfSpread * (0.2 + Math.random() * 0.6);
      fillPrice = roundToTick(symbol, mark + Math.sign(qty) * (halfSpread + slip));
    }
    const fx = usdPerQuote(symbol, fillPrice);
    const notional = Math.abs(qty) * fillPrice * fx;
    const fee = maker ? -(notional * MAKER_REBATE_BPS) / 1e4 : (notional * (sym.feeBps ?? TAKER_FEE_BPS)) / 1e4;

    const book = this.book(agentId);
    const now = this.clock.now();
    // In live mode a market whose real feed is down runs on simulated prices. Trades there
    // are paper practice only: they never count as a real track record.
    const simFeed = this.clock.mode === 'live' && this.md.get(symbol)?.source === 'sim';
    const fill = {
      id: ++fillSeq, time: now, agentId, symbol,
      side: qty > 0 ? 'BUY' : 'SELL', qty: Math.abs(qty), price: fillPrice,
      notional, fee, tag, reason, maker,
    };
    book.fills.push(fill);
    if (book.fills.length > MAX_TRADES_KEPT) book.fills.shift();
    book.feesDay += fee;
    book.feesTotal += fee;
    book.realizedDay -= fee;
    book.realizedTotal -= fee;

    let pos = book.positions.get(symbol);
    let remaining = qty;
    const closed = [];

    if (pos && Math.sign(pos.qty) !== Math.sign(remaining)) {
      // Reduce / close / flip.
      const closeQty = Math.min(Math.abs(remaining), Math.abs(pos.qty));
      const pnl = closeQty * (fillPrice - pos.avg) * Math.sign(pos.qty) * fx;
      book.realizedDay += pnl;
      book.realizedTotal += pnl;
      pos.trade.realized += pnl;
      pos.trade.exitQty += closeQty;
      pos.trade.exitNotional += closeQty * fillPrice;
      pos.trade.fees += fee * (closeQty / Math.abs(qty));
      pos.qty += Math.sign(remaining) * closeQty;
      remaining -= Math.sign(remaining) * closeQty;
      if (reason) pos.trade.exitReason = reason;
      if (simFeed) pos.trade.simFeed = true;
      if (Math.abs(pos.qty) < 1e-12) {
        closed.push(this.#closeTrade(book, pos, now));
        book.positions.delete(symbol);
        pos = null;
      }
    } else if (pos) {
      // Scale in.
      const total = Math.abs(pos.qty) + Math.abs(remaining);
      pos.avg = (pos.avg * Math.abs(pos.qty) + fillPrice * Math.abs(remaining)) / total;
      pos.qty += remaining;
      pos.trade.entryQty += Math.abs(remaining);
      pos.trade.entryNotional += Math.abs(remaining) * fillPrice;
      pos.trade.fees += fee;
      if (initialRisk) pos.trade.initialRisk += initialRisk;
      remaining = 0;
    }

    if (Math.abs(remaining) > 1e-12) {
      // Open a new position (possibly the remainder of a flip).
      pos = {
        symbol, qty: remaining, avg: fillPrice, openTime: now,
        trade: {
          id: ++tradeSeq, agentId, symbol, side: remaining > 0 ? 'LONG' : 'SHORT', openTime: now, tag,
          entryQty: Math.abs(remaining), entryNotional: Math.abs(remaining) * fillPrice,
          exitQty: 0, exitNotional: 0, realized: 0,
          fees: fee * (Math.abs(remaining) / Math.abs(qty)),
          initialRisk, stop, target, entryReason: reason, exitReason: '', meta, simFeed,
        },
      };
      book.positions.set(symbol, pos);
    }

    this.emit('fill', fill);
    for (const t of closed) this.emit('trade', t);
    return { fill, closed, position: book.positions.get(symbol) || null };
  }

  #closeTrade(book, pos, now) {
    const t = pos.trade;
    const net = t.realized - t.fees;
    const trade = {
      id: t.id, agentId: t.agentId, symbol: t.symbol, side: t.side, tag: t.tag,
      qty: t.entryQty,
      entry: t.entryNotional / t.entryQty,
      exit: t.exitQty ? t.exitNotional / t.exitQty : NaN,
      openTime: t.openTime, closeTime: now,
      gross: t.realized, fees: t.fees, pnl: net,
      r: t.initialRisk > 0 ? net / t.initialRisk : null,
      entryReason: t.entryReason, exitReason: t.exitReason,
      ...(t.simFeed ? { simFeed: true } : {}),
      ...(t.meta ? { thesis: t.meta.thesis, grade: t.meta.grade, score: t.meta.score, verdict: t.meta.verdict, f: t.meta.f } : {}),
    };
    // The neural brain's call at entry. What it sensed (x) is there for it to learn from, but
    // isn't saved or sent to the browser with every trade (not enumerable).
    if (t.meta?.neural) {
      const { x, ...call } = t.meta.neural;
      trade.neural = call;
      if (x) Object.defineProperty(call, 'x', { value: x, enumerable: false });
    }
    book.trades.push(trade);
    if (book.trades.length > MAX_TRADES_KEPT) book.trades.shift();
    return trade;
  }

  unrealized(agentId, symbol = null) {
    let total = 0;
    for (const pos of this.book(agentId).positions.values()) {
      if (symbol && pos.symbol !== symbol) continue;
      const mark = this.md.price(pos.symbol);
      if (!Number.isFinite(mark)) continue;
      total += pos.qty * (mark - pos.avg) * usdPerQuote(pos.symbol, mark);
    }
    return total;
  }

  grossExposure(agentId) {
    let total = 0;
    for (const pos of this.book(agentId).positions.values()) {
      const mark = this.md.price(pos.symbol);
      if (Number.isFinite(mark)) total += Math.abs(pos.qty) * mark * usdPerQuote(pos.symbol, mark);
    }
    return total;
  }

  // Shift open positions to a new price level (data feed switch) without booking P&L.
  rebase(symbol, offset) {
    for (const book of this.books.values()) {
      const pos = book.positions.get(symbol);
      if (!pos) continue;
      pos.avg += offset;
      pos.trade.entryNotional += offset * pos.trade.entryQty;
    }
  }

  flatten(agentId, reason = 'Flatten') {
    const out = [];
    for (const pos of [...this.book(agentId).positions.values()]) {
      const res = this.execute(agentId, pos.symbol, -pos.qty, { reason, tag: 'FLATTEN' });
      if (res) out.push(res);
    }
    return out;
  }
}
