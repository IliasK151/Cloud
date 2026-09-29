import WebSocket from 'ws';

// Live crypto prices from Binance public market data (no API key needed).
// data-api.binance.vision / data-stream.binance.vision are Binance's market-data-only
// mirrors that also work in regions where binance.com itself is blocked.
const REST_HOSTS = ['https://api.binance.com', 'https://data-api.binance.vision'];
const WS_HOSTS = ['wss://stream.binance.com:9443', 'wss://data-stream.binance.vision'];

async function fetchJson(url, timeoutMs = 8000) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const res = await fetch(url, { signal: ctrl.signal });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    return await res.json();
  } finally {
    clearTimeout(timer);
  }
}

const toBar = (k) => ({
  time: Math.floor(k[0] / 1000),
  open: +k[1], high: +k[2], low: +k[3], close: +k[4], volume: +k[5],
});

export class BinanceFeed {
  constructor(md, symbols, log = console) {
    this.md = md;
    this.symbols = symbols; // [{ id, source: { ticker } }]
    this.log = log;
    this.byTicker = new Map(symbols.map((s) => [s.source.ticker.toUpperCase(), s.id]));
    this.hostIndex = 0;
    this.ws = null;
    this.stopped = false;
    this.retry = 0;
  }

  // Loads history; throws if Binance is unreachable so the caller can fall back.
  async start() {
    let lastErr;
    for (let h = 0; h < REST_HOSTS.length; h++) {
      try {
        for (const s of this.symbols) {
          const rows = await fetchJson(`${REST_HOSTS[h]}/api/v3/klines?symbol=${s.source.ticker}&interval=1m&limit=600`);
          const bars = rows.map(toBar);
          // The last kline is still forming; feed it through applyBar so it keeps updating.
          const forming = bars.pop();
          this.md.seed(s.id, bars);
          if (forming) this.md.applyBar(s.id, forming);
          this.md.setStatus(s.id, 'LIVE', 'binance');
        }
        this.hostIndex = h;
        this.#connect();
        return;
      } catch (err) {
        lastErr = err;
      }
    }
    throw new Error(`Binance unreachable (${lastErr?.message || 'unknown error'})`);
  }

  #connect() {
    if (this.stopped) return;
    const streams = this.symbols.map((s) => `${s.source.ticker.toLowerCase()}@kline_1m`).join('/');
    const host = WS_HOSTS[this.hostIndex % WS_HOSTS.length];
    const ws = new WebSocket(`${host}/stream?streams=${streams}`);
    this.ws = ws;
    ws.on('open', () => {
      this.retry = 0;
      for (const s of this.symbols) this.md.setStatus(s.id, 'LIVE', 'binance');
    });
    ws.on('message', (buf) => {
      try {
        const msg = JSON.parse(buf.toString());
        const k = msg?.data?.k;
        if (!k) return;
        const id = this.byTicker.get(String(k.s).toUpperCase());
        if (!id) return;
        this.md.applyBar(id, {
          time: Math.floor(k.t / 1000),
          open: +k.o, high: +k.h, low: +k.l, close: +k.c, volume: +k.v,
        }, { closed: !!k.x });
      } catch {
        /* ignore malformed frames */
      }
    });
    const reconnect = () => {
      if (this.stopped || this.ws !== ws) return;
      this.ws = null;
      for (const s of this.symbols) this.md.setStatus(s.id, 'RECONNECTING', 'binance');
      this.retry++;
      if (this.retry % 3 === 0) this.hostIndex++;
      const delay = Math.min(30_000, 1000 * 2 ** Math.min(this.retry, 5));
      setTimeout(() => this.#connect(), delay);
    };
    ws.on('close', reconnect);
    ws.on('error', (err) => {
      this.log.warn?.(`[binance] ${err.message}`);
      try { ws.close(); } catch { /* noop */ }
    });
  }

  stop() {
    this.stopped = true;
    this.ws?.close();
  }
}
