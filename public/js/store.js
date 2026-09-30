// Client-side state mirrored from the server over the WebSocket.

const MAX_BARS = 400;
const MAX_TICKS = 40;

class Store extends EventTarget {
  constructor() {
    super();
    this.ready = false;
    this.config = null;
    this.fund = null;
    this.symbols = {};
    this.profiles = [];
    this.profileById = {};
    this.agents = {};
    this.quotes = {};
    this.candles = {};
    this.ticks = {}; // recent price prints per symbol for time & sales
    this.equity = [];
    this.dayCurves = {};
    this.events = [];
    this.alerts = [];
    this.blotter = [];
    this.selected = null;
    this.live = null; // FTMO / MT5 live trading state
  }

  emit(type, detail) {
    this.dispatchEvent(new CustomEvent(type, { detail }));
  }

  on(type, fn) {
    const h = (e) => fn(e.detail);
    this.addEventListener(type, h);
    return () => this.removeEventListener(type, h);
  }

  init(msg) {
    this.config = msg.config;
    this.symbols = Object.fromEntries(msg.symbols.map((s) => [s.id, s]));
    this.profiles = msg.profiles;
    this.profileById = Object.fromEntries(msg.profiles.map((p) => [p.id, p]));
    this.candles = {};
    for (const [id, bars] of Object.entries(msg.candles)) this.candles[id] = sanitize(bars);
    this.equity = sanitize(msg.equity);
    this.dayCurves = Object.fromEntries(Object.entries(msg.dayCurves).map(([k, v]) => [k, sanitize(v)]));
    this.events = msg.events;
    this.alerts = msg.alerts;
    this.blotter = msg.blotter;
    this.#applySnapshot(msg);
    const first = !this.ready;
    this.ready = true;
    this.emit('init', { first });
  }

  #applySnapshot(msg) {
    this.fund = msg.fund;
    this.quotes = msg.quotes;
    for (const a of msg.agents) this.agents[a.id] = a;
    for (const [id, q] of Object.entries(msg.quotes)) {
      const list = (this.ticks[id] ||= []);
      const lastTick = list[list.length - 1];
      if (Number.isFinite(q.price) && (!lastTick || lastTick.price !== q.price)) {
        list.push({ price: q.price, time: msg.fund.marketTime, up: lastTick ? q.price >= lastTick.price : true });
        if (list.length > MAX_TICKS) list.shift();
      }
    }
  }

  snapshot(msg) {
    this.#applySnapshot(msg);
    for (const { symbol, bar } of msg.closed || []) this.#mergeBar(symbol, bar);
    for (const [symbol, bar] of Object.entries(msg.bars || {})) if (bar) this.#mergeBar(symbol, bar);
    this.emit('snapshot', msg);
  }

  #mergeBar(symbol, bar) {
    const list = (this.candles[symbol] ||= []);
    const lastBar = list[list.length - 1];
    if (!lastBar || bar.time > lastBar.time) {
      list.push({ ...bar });
      if (list.length > MAX_BARS) list.shift();
    } else if (bar.time === lastBar.time) {
      Object.assign(lastBar, bar);
    }
  }

  addEvent(ev) {
    this.events.push(ev);
    if (this.events.length > 120) this.events.shift();
    this.emit('event', ev);
  }

  addEquity(sample) {
    const lastPt = this.equity[this.equity.length - 1];
    if (!lastPt || sample.time > lastPt.time) this.equity.push({ time: sample.time, value: sample.nav });
    for (const [id, v] of Object.entries(sample.agents)) {
      const c = (this.dayCurves[id] ||= []);
      const l = c[c.length - 1];
      if (!l || sample.time > l.time) c.push({ time: sample.time, value: v });
      else if (l.time > sample.time) this.dayCurves[id] = [{ time: sample.time, value: v }];
    }
    this.emit('equity', sample);
  }

  addTrade(trade) {
    this.blotter.unshift(trade);
    if (this.blotter.length > 60) this.blotter.pop();
    this.emit('trade', trade);
  }

  addAlert(alert) {
    this.alerts.push(alert);
    if (this.alerts.length > 40) this.alerts.shift();
    this.emit('alert', alert);
  }

  setLive(view) {
    if (!view) return;
    this.live = view;
    this.emit('live', view);
  }

  setTunnel(view) {
    if (!view) return;
    this.tunnel = view;
    this.emit('tunnel', view);
  }

  select(id) {
    if (this.selected === id) return;
    this.selected = id;
    this.emit('select', id);
  }
}

// Lightweight Charts needs strictly ascending, unique timestamps.
function sanitize(points = []) {
  const out = [];
  for (const p of [...points].sort((a, b) => a.time - b.time)) {
    if (out.length && out[out.length - 1].time === p.time) out[out.length - 1] = p;
    else out.push(p);
  }
  return out;
}

export const store = new Store();
