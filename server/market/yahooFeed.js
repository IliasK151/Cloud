// Index futures, gold, oil and FX from Yahoo Finance's public chart endpoint.
// Polls 1-minute bars; marks a symbol DELAYED/CLOSED when bars stop arriving
// (e.g. weekends or the daily futures maintenance break).

const HOSTS = ['https://query1.finance.yahoo.com', 'https://query2.finance.yahoo.com'];
const HEADERS = {
  'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 14_0) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126 Safari/537.36',
  Accept: 'application/json',
};

async function fetchChart(ticker, query, timeoutMs = 9000) {
  let lastErr;
  for (const host of HOSTS) {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), timeoutMs);
    try {
      const res = await fetch(`${host}/v8/finance/chart/${encodeURIComponent(ticker)}?${query}`, { headers: HEADERS, signal: ctrl.signal });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const json = await res.json();
      const result = json?.chart?.result?.[0];
      if (!result) throw new Error(json?.chart?.error?.description || 'empty result');
      return result;
    } catch (err) {
      lastErr = err;
    } finally {
      clearTimeout(timer);
    }
  }
  throw lastErr;
}

function toBars(result) {
  const ts = result.timestamp || [];
  const q = result.indicators?.quote?.[0] || {};
  const bars = [];
  for (let i = 0; i < ts.length; i++) {
    const close = q.close?.[i];
    if (close == null) continue;
    const open = q.open?.[i] ?? close;
    const bar = {
      time: Math.floor(ts[i] / 60) * 60,
      open,
      high: q.high?.[i] ?? Math.max(open, close),
      low: q.low?.[i] ?? Math.min(open, close),
      close,
      volume: q.volume?.[i] ?? 0,
    };
    const prev = bars[bars.length - 1];
    // Yahoo's newest point can share a minute with the previous bar: merge them.
    if (prev && prev.time === bar.time) {
      prev.high = Math.max(prev.high, bar.high);
      prev.low = Math.min(prev.low, bar.low);
      prev.close = bar.close;
      prev.volume += bar.volume;
    } else if (!prev || bar.time > prev.time) {
      bars.push(bar);
    }
  }
  return bars;
}

export class YahooFeed {
  constructor(md, symbols, log = console, { pollMs = 10_000 } = {}) {
    this.md = md;
    this.symbols = symbols;
    this.log = log;
    this.pollMs = pollMs;
    this.timers = [];
    this.failures = new Map();
  }

  // Returns { ok: [ids], failed: [{ id, error, lastPrice }] }.
  async start() {
    const ok = [];
    const failed = [];
    await Promise.all(this.symbols.map(async (s) => {
      try {
        const result = await fetchChart(s.source.ticker, 'interval=1m&range=2d&includePrePost=true');
        const bars = toBars(result);
        if (bars.length < 30) throw new Error('not enough history');
        const forming = bars.pop();
        this.md.seed(s.id, bars);
        this.md.applyBar(s.id, forming);
        this.#updateStatus(s.id);
        ok.push(s.id);
      } catch (err) {
        failed.push({ id: s.id, error: err.message });
      }
    }));
    const live = this.symbols.filter((s) => ok.includes(s.id));
    live.forEach((s, i) => {
      // Stagger requests so we stay well inside Yahoo's rate limits.
      const t = setTimeout(() => {
        this.#poll(s);
        this.timers.push(setInterval(() => this.#poll(s), this.pollMs));
      }, (i * this.pollMs) / Math.max(1, live.length));
      this.timers.push(t);
    });
    return { ok, failed };
  }

  async #poll(s) {
    const now = Math.floor(Date.now() / 1000);
    try {
      const result = await fetchChart(s.source.ticker, `interval=1m&period1=${now - 900}&period2=${now + 60}&includePrePost=true`);
      for (const bar of toBars(result)) this.md.applyBar(s.id, bar);
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
    const lastBar = s.current?.time ?? s.lastBarTime;
    const ageMin = (Date.now() / 1000 - lastBar) / 60;
    const status = ageMin < 4 ? 'LIVE' : ageMin < 30 ? 'DELAYED' : 'CLOSED';
    this.md.setStatus(id, status, 'yahoo');
  }

  stop() {
    for (const t of this.timers) clearInterval(t);
  }
}
