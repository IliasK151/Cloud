import { EventEmitter } from 'node:events';
import { SYMBOLS } from './symbols.js';

const BAR_SECONDS = 60;
const MAX_BARS = 900;

// Holds 1-minute bars per instrument and emits:
//   'tick' (symbolId, price, marketMs)   on every price update
//   'bar'  (symbolId, closedBar)         when a 1-minute bar closes
export class MarketData extends EventEmitter {
  constructor(clock) {
    super();
    this.setMaxListeners(50);
    this.clock = clock;
    this.series = new Map();
    for (const id of Object.keys(SYMBOLS)) {
      this.series.set(id, {
        id, bars: [], current: null, price: NaN,
        status: 'LOADING', source: SYMBOLS[id].source.type,
        lastUpdate: 0, lastBarTime: 0, dayRef: NaN,
        owner: null, // when set, only updates from this source are accepted
      });
    }
  }

  get(id) {
    return this.series.get(id);
  }

  price(id) {
    return this.series.get(id)?.price ?? NaN;
  }

  setStatus(id, status, source) {
    const s = this.series.get(id);
    if (!s) return;
    s.status = status;
    if (source) s.source = source;
  }

  // Hand a symbol to one data source exclusively (e.g. the broker's own MT5 prices, or the
  // real feed coming back after a stretch on the simulated stand-in), replacing its
  // history so indicators run on the prices that will be traded.
  // Emits 'rebase' (id, offset) so open positions can be shifted to the new price level
  // instead of showing a fake profit or loss from the feed switch, then 'claim'
  // (id, source, bars) with the full history the source sent (the research store keeps it).
  claim(id, source, bars, status = 'LIVE') {
    const s = this.series.get(id);
    if (!s) return;
    const before = s.price;
    s.owner = source;
    this.seed(id, bars);
    s.dayRef = bars.length ? bars[0].open : s.dayRef;
    this.setStatus(id, status, source);
    const offset = s.price - before;
    if (Number.isFinite(offset) && offset !== 0) this.emit('rebase', id, offset);
    this.emit('claim', id, source, bars);
  }

  ownerOf(id) {
    return this.series.get(id)?.owner ?? null;
  }

  // Load historical, closed bars (oldest first).
  seed(id, bars) {
    const s = this.series.get(id);
    const clean = bars.filter((b) => Number.isFinite(b.close) && b.close > 0);
    s.bars = clean.slice(-MAX_BARS);
    s.current = null;
    const lastBar = s.bars[s.bars.length - 1];
    if (lastBar) {
      s.price = lastBar.close;
      s.lastBarTime = lastBar.time;
      if (!Number.isFinite(s.dayRef)) s.dayRef = s.bars[0].open;
    }
  }

  // Apply a (partial) bar from a bar-based feed. `closed` finalises it immediately.
  applyBar(id, bar, { closed = false, source = null } = {}) {
    const s = this.series.get(id);
    if (!s || !Number.isFinite(bar.close)) return;
    if (s.owner && source !== s.owner) return;
    const lastClosed = s.bars[s.bars.length - 1];
    if (lastClosed && bar.time <= lastClosed.time && !s.current) return;

    if (!s.current) {
      s.current = { ...bar };
    } else if (bar.time > s.current.time) {
      this.#finalize(s);
      s.current = { ...bar };
    } else if (bar.time === s.current.time) {
      s.current.high = Math.max(s.current.high, bar.high);
      s.current.low = Math.min(s.current.low, bar.low);
      s.current.close = bar.close;
      s.current.volume = Math.max(s.current.volume, bar.volume);
    } else {
      return; // stale update
    }
    this.#touch(s, bar.close);
    if (closed) this.#finalize(s);
  }

  // Apply a single trade/tick from a tick-based feed (simulator).
  applyTick(id, price, volume, marketMs, source = null) {
    const s = this.series.get(id);
    if (!s || !Number.isFinite(price)) return;
    if (s.owner && source !== s.owner) return;
    const time = Math.floor(marketMs / 1000 / BAR_SECONDS) * BAR_SECONDS;
    if (s.current && time > s.current.time) this.#finalize(s);
    if (!s.current) {
      s.current = { time, open: price, high: price, low: price, close: price, volume: 0 };
    }
    const c = s.current;
    c.high = Math.max(c.high, price);
    c.low = Math.min(c.low, price);
    c.close = price;
    c.volume += volume;
    this.#touch(s, price);
  }

  #touch(s, price) {
    s.price = price;
    s.lastUpdate = Date.now();
    if (!Number.isFinite(s.dayRef)) s.dayRef = price;
    this.emit('tick', s.id, price, this.clock.now());
  }

  #finalize(s) {
    if (!s.current) return;
    const bar = s.current;
    s.bars.push(bar);
    if (s.bars.length > MAX_BARS) s.bars.splice(0, s.bars.length - MAX_BARS);
    s.lastBarTime = bar.time;
    s.current = null;
    this.emit('bar', s.id, bar);
  }

  // Closed bars, optionally with the forming bar appended.
  bars(id, { includeCurrent = false } = {}) {
    const s = this.series.get(id);
    if (!s) return [];
    return includeCurrent && s.current ? [...s.bars, s.current] : s.bars;
  }

  currentBar(id) {
    const s = this.series.get(id);
    return s?.current ?? s?.bars[s.bars.length - 1] ?? null;
  }

  // Reference price for "change on the day".
  rollDay() {
    for (const s of this.series.values()) if (Number.isFinite(s.price)) s.dayRef = s.price;
  }

  quotes() {
    const out = {};
    for (const s of this.series.values()) {
      out[s.id] = {
        price: s.price,
        change: Number.isFinite(s.dayRef) && s.dayRef ? s.price / s.dayRef - 1 : 0,
        status: s.status,
        source: s.source,
      };
    }
    return out;
  }
}
