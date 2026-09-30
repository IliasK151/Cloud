// Index futures, gold, oil and FX from Yahoo Finance's public chart endpoint.
// Polls 1-minute bars, one request at a time through the shared, rate-limit-aware client;
// marks a symbol DELAYED/CLOSED when bars stop arriving (e.g. weekends or the daily futures
// maintenance break).

import { yahoo as sharedClient, toBars } from './yahooClient.js';

export class YahooFeed {
  constructor(md, symbols, log = console, { pollMs = 15_000, client = sharedClient } = {}) {
    this.md = md;
    this.symbols = symbols;
    this.log = log;
    this.pollMs = pollMs;
    this.client = client;
    this.live = new Set();
    this.lastPoll = new Map();
    this.failures = new Map();
    this.busy = false;
    this.timer = null;
  }

  // Returns { ok: [ids], failed: [{ id, error }] }. Requests go one after another: a
  // parallel burst is exactly what gets a connection rate-limited.
  async start() {
    const ok = [];
    const failed = [];
    for (const s of this.symbols) {
      try {
        const bars = await this.#history(s);
        const forming = bars.pop();
        this.md.seed(s.id, bars);
        this.md.applyBar(s.id, forming, { source: 'yahoo' });
        this.#updateStatus(s.id);
        this.live.add(s.id);
        ok.push(s.id);
      } catch (err) {
        failed.push({ id: s.id, error: err.message, rateLimited: !!err.rateLimited });
      }
    }
    this.timer = setInterval(() => this.#tick(), 1000);
    this.timer.unref?.();
    return { ok, failed };
  }

  async #history(s) {
    const result = await this.client.chart(s.source.ticker, 'interval=1m&range=2d&includePrePost=true');
    const bars = toBars(result);
    if (bars.length < 30) throw new Error('not enough history');
    return bars;
  }

  // A market that fell back to simulation: try the real feed again. On success the real
  // prices take over the symbol (md.claim) and it joins the polling rotation.
  async recover(id) {
    const s = this.symbols.find((x) => x.id === id);
    if (!s || this.live.has(id) || this.md.ownerOf(id) === 'mt5') return false; // the broker's prices already rule
    const bars = await this.#history(s);
    const forming = bars.pop();
    this.md.claim(id, 'yahoo', bars, 'LIVE');
    this.md.applyBar(id, forming, { source: 'yahoo' });
    this.live.add(id);
    this.lastPoll.set(id, Date.now());
    this.#updateStatus(id);
    return true;
  }

  // Poll the most overdue live symbol, at most one request in flight.
  #tick() {
    if (this.busy || this.client.paused) return;
    const now = Date.now();
    let pick = null;
    for (const id of this.live) {
      const owner = this.md.ownerOf(id);
      if (owner && owner !== 'yahoo') continue; // priced by the broker (MT5): no need to ask Yahoo
      const t = this.lastPoll.get(id) || 0;
      if (now - t >= this.pollMs && (pick === null || t < (this.lastPoll.get(pick) || 0))) pick = id;
    }
    if (!pick) return;
    this.lastPoll.set(pick, now);
    this.busy = true;
    this.#poll(this.symbols.find((x) => x.id === pick)).finally(() => { this.busy = false; });
  }

  async #poll(s) {
    const now = Math.floor(Date.now() / 1000);
    try {
      const result = await this.client.chart(s.source.ticker, `interval=1m&period1=${now - 900}&period2=${now + 60}&includePrePost=true`);
      for (const bar of toBars(result)) this.md.applyBar(s.id, bar, { source: 'yahoo' });
      this.failures.set(s.id, 0);
      this.#updateStatus(s.id);
    } catch (err) {
      const n = (this.failures.get(s.id) || 0) + 1;
      this.failures.set(s.id, n);
      if (n === 3) this.log.warn?.(`[yahoo] ${s.id}: ${err.message}`);
      if (n >= 3) this.md.setStatus(s.id, 'RECONNECTING', 'yahoo');
    }
  }

  #updateStatus(id) {
    const s = this.md.get(id);
    if (s.owner && s.owner !== 'yahoo') return;
    const lastBar = s.current?.time ?? s.lastBarTime;
    const ageMin = (Date.now() / 1000 - lastBar) / 60;
    const status = ageMin < 4 ? 'LIVE' : ageMin < 30 ? 'DELAYED' : 'CLOSED';
    this.md.setStatus(id, status, 'yahoo');
  }

  stop() {
    clearInterval(this.timer);
  }
}
