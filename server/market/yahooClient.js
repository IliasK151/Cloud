// One polite Yahoo Finance client for the whole floor.
//
// Yahoo rate-limits anonymous API traffic (HTTP 429 "Too Many Requests"), above all bursts
// of requests without the session cookie its own website uses. So this client:
//   - opens a browser-like session first (cookie + "crumb") and sends it with every request;
//   - sends requests one at a time with a short gap, never in parallel bursts;
//   - on a 429 pauses ALL Yahoo requests for a while (longer each time it happens again)
//     instead of retrying straight away, which only extends the block.
// While paused, calls fail fast so the floor keeps running; callers retry later.

const HOSTS = ['https://query2.finance.yahoo.com', 'https://query1.finance.yahoo.com'];
const UA = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/128.0.0.0 Safari/537.36';
const BASE_HEADERS = { 'User-Agent': UA, Accept: 'application/json,text/plain,*/*', 'Accept-Language': 'en-US,en;q=0.9' };
const SESSION_TTL_MS = 6 * 3_600_000;

export class RateLimitError extends Error {
  constructor(retryInMs) {
    super(`HTTP 429 (Yahoo rate limit; next try in ${Math.ceil(retryInMs / 1000)}s)`);
    this.rateLimited = true;
    this.retryInMs = retryInMs;
  }
}

export class YahooClient {
  constructor({ fetchImpl = (...a) => globalThis.fetch(...a), gapMs = 400, baseBackoffMs = 30_000, maxBackoffMs = 10 * 60_000, now = () => Date.now() } = {}) {
    this.fetch = fetchImpl;
    this.gapMs = gapMs;
    this.baseBackoffMs = baseBackoffMs;
    this.maxBackoffMs = maxBackoffMs;
    this.now = now;
    this.chain = Promise.resolve();
    this.lastAt = 0;
    this.pausedUntil = 0;
    this.strikes = 0; // consecutive 429s, for the back-off
    this.session = null; // { cookie, crumb, at }
    this.stats = { requests: 0, ok: 0, limited: 0 };
  }

  get paused() {
    return this.now() < this.pausedUntil;
  }

  // 1-minute chart data for one ticker. Rejects fast while Yahoo has us paused.
  chart(ticker, query, timeoutMs = 10_000) {
    return this.#queue(() => this.#chart(ticker, query, timeoutMs));
  }

  #queue(task) {
    const run = this.chain.then(async () => {
      if (this.paused) throw new RateLimitError(this.pausedUntil - this.now());
      const wait = this.lastAt + this.gapMs - this.now();
      if (wait > 0) await new Promise((r) => setTimeout(r, wait));
      try {
        return await task();
      } finally {
        this.lastAt = this.now();
      }
    });
    this.chain = run.catch(() => {});
    return run;
  }

  async #request(url, headers, timeoutMs, redirect = 'follow') {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), timeoutMs);
    try {
      this.stats.requests++;
      return await this.fetch(url, { headers, signal: ctrl.signal, redirect });
    } finally {
      clearTimeout(timer);
    }
  }

  #limited() {
    this.stats.limited++;
    this.strikes++;
    const ms = Math.min(this.maxBackoffMs, this.baseBackoffMs * 2 ** (this.strikes - 1));
    this.pausedUntil = this.now() + ms;
    return new RateLimitError(ms);
  }

  // A session like a browser's: the consent cookie from fc.yahoo.com, then a crumb.
  // Best effort: if it can't be had, requests go without it.
  async #ensureSession(force = false) {
    if (!force && this.session && this.now() - this.session.at < SESSION_TTL_MS) return this.session;
    let cookie = '';
    let crumb = '';
    try {
      // 'manual': the cookie comes on this response, not on wherever it redirects to.
      const res = await this.#request('https://fc.yahoo.com/', BASE_HEADERS, 8000, 'manual');
      const raw = typeof res.headers.getSetCookie === 'function' ? res.headers.getSetCookie() : [res.headers.get('set-cookie')].filter(Boolean);
      cookie = raw.map((c) => String(c).split(';')[0]).filter(Boolean).join('; ');
      await res.arrayBuffer().catch(() => {});
    } catch {
      /* no cookie: carry on without */
    }
    if (cookie) {
      try {
        const res = await this.#request(`${HOSTS[0]}/v1/test/getcrumb`, { ...BASE_HEADERS, Cookie: cookie }, 8000);
        if (res.status === 429) throw this.#limited();
        const text = res.ok ? (await res.text()).trim() : '';
        if (text && text.length < 64 && !/[<{\s]/.test(text)) crumb = text;
      } catch (err) {
        if (err.rateLimited) throw err;
      }
    }
    this.session = { cookie, crumb, at: this.now() };
    return this.session;
  }

  async #chart(ticker, query, timeoutMs) {
    const session = await this.#ensureSession();
    let lastErr;
    for (const host of HOSTS) {
      const crumb = session.crumb ? `&crumb=${encodeURIComponent(session.crumb)}` : '';
      const headers = session.cookie ? { ...BASE_HEADERS, Cookie: session.cookie } : BASE_HEADERS;
      try {
        const res = await this.#request(`${host}/v8/finance/chart/${encodeURIComponent(ticker)}?${query}${crumb}`, headers, timeoutMs);
        if (res.status === 429) throw this.#limited();
        if (res.status === 401 || res.status === 403) {
          this.session = null; // stale cookie or crumb: a fresh session next time
          throw new Error(`HTTP ${res.status}`);
        }
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        const json = await res.json();
        const result = json?.chart?.result?.[0];
        if (!result) throw new Error(json?.chart?.error?.description || 'empty result');
        this.strikes = 0;
        this.stats.ok++;
        return result;
      } catch (err) {
        if (err.rateLimited) throw err; // the other host shares the limit: don't make it worse
        lastErr = err.name === 'AbortError' ? new Error('timed out') : err;
      }
    }
    throw lastErr;
  }
}

// Yahoo's chart result → closed and forming 1-minute bars (oldest first).
export function toBars(result) {
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

// The floor's shared client.
export const yahoo = new YahooClient();
