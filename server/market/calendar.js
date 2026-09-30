import fs from 'node:fs';
import path from 'node:path';
import { EventEmitter } from 'node:events';
import { SYMBOLS } from './symbols.js';
import { nyParts, nyWallToMs, nyDateKey, fmtNyTime } from './session.js';
import { mulberry32, hashString as hash } from '../util/random.js';

// The economic calendar. Real traders don't open a trade into CPI, payrolls or a Fed
// decision, and they are flat before the number hits. Every desk checks this calendar:
//
//   - no new trades inside a blackout window around high/medium impact news for the
//     currencies its market moves on (high: 15 min before → 15 min after, medium: 5/5);
//   - open trades are closed 5 minutes before high-impact news (or, if the boss allows it,
//     big winners keep running with the stop locked in profit);
//   - briefings and the dashboard say what is coming and when the desk is back.
//
// Live mode reads the Forex Factory weekly calendar (cached in data/calendar.json and
// refreshed every few hours). If it can't be reached the desks fall back to the usual US
// release times (08:30, 10:00 and the Wednesday oil report). Simulation mode generates a
// realistic calendar and the simulator moves the markets when the numbers come out.

export const FEED_URLS = [
  'https://nfs.faireconomy.media/ff_calendar_thisweek.json',
  'https://nfs.faireconomy.media/ff_calendar_nextweek.json',
];
const REFRESH_MS = 4 * 3_600_000;
const RETRY_MS = 30 * 60_000;
const KEEP_MS = 9 * 86_400_000;
const MIN = 60_000;

// Currencies each market reacts to.
export const SYMBOL_CURRENCIES = {
  NAS100: ['USD'], SPX500: ['USD'], XAUUSD: ['USD'], USOIL: ['USD'],
  EURUSD: ['EUR', 'USD'], USDJPY: ['USD', 'JPY'],
  BTCUSD: ['USD'], ETHUSD: ['USD'], SOLUSD: ['USD'],
};

const OIL_RE = /crude oil inventories|eia crude|api weekly|opec/i;
const IGNORE_RE = /natural gas storage|bond auction|bill auction|bank holiday/i;

export const DEFAULT_SETTINGS = {
  enabled: true,
  highBefore: 15, highAfter: 15,
  mediumBefore: 5, mediumAfter: 5,
  flattenBefore: 5,
  keepWinners: false, // keep trades that are ≥ 1R with the stop locked at +0.5R
};

const REGION = { USD: 'US', EUR: 'Euro area', JPY: 'Japan', GBP: 'UK', CAD: 'Canada', AUD: 'Australia', NZD: 'New Zealand', CHF: 'Swiss', CNY: 'China' };

// How much this event matters for this market: 'high', 'medium' or null (ignore).
export function impactFor(ev, symbol) {
  const sym = SYMBOLS[symbol];
  if (!sym || !ev) return null;
  if (OIL_RE.test(ev.title)) return symbol === 'USOIL' ? 'high' : null;
  if (IGNORE_RE.test(ev.title)) return null;
  if (!SYMBOL_CURRENCIES[symbol]?.includes(ev.currency)) return null;
  if (ev.impact === 'high') return 'high';
  // Crypto shrugs off second-tier data; only the big US releases matter.
  if (ev.impact === 'medium') return sym.assetClass === 'Crypto' ? null : 'medium';
  return null;
}

export function marketsFor(ev) {
  return Object.keys(SYMBOLS).filter((s) => impactFor(ev, s));
}

// "CPI m/m" → "US CPI m/m" for display, and a speakable version for the voices.
export function eventLabel(ev) {
  const region = REGION[ev.currency] || ev.currency;
  return /^(fomc|fed|ecb|boj|opec|eia)/i.test(ev.title) ? ev.title : `${region} ${ev.title}`;
}

export function spokenLabel(ev) {
  return eventLabel(ev)
    .replace(/\bm\/m\b/gi, 'month on month')
    .replace(/\by\/y\b/gi, 'year on year')
    .replace(/\bq\/q\b/gi, 'quarter on quarter')
    .replace(/\bUoM\b/g, 'Michigan');
}

export function parseForexFactory(rows) {
  if (!Array.isArray(rows)) throw new Error('unexpected calendar format');
  const out = [];
  for (const r of rows) {
    const time = Date.parse(r?.date);
    const impact = String(r?.impact || '').toLowerCase();
    if (!Number.isFinite(time) || !r.title || !r.country) continue;
    if (!['high', 'medium', 'low', 'holiday'].includes(impact)) continue;
    out.push({
      id: `ff-${hash(`${r.country}|${r.title}|${r.date}`).toString(36)}`,
      title: String(r.title).slice(0, 80),
      currency: String(r.country).toUpperCase().slice(0, 4),
      time,
      impact,
      forecast: r.forecast || '',
      previous: r.previous || '',
      actual: r.actual || '',
      source: 'forexfactory',
    });
  }
  return out;
}

// ---- simulated calendar ------------------------------------------------------------------
// Values are drawn around a base; `usd` is how the dollar reacts to a higher-than-expected
// print, `risk` how stocks and crypto react.
const SIM_TEMPLATES = {
  early: [
    { h: 2, m: 0, cur: 'EUR', title: 'German Prelim CPI m/m', impact: 'high', base: 0.2, step: 0.1, unit: '%' },
    { h: 4, m: 0, cur: 'EUR', title: 'ECB President Lagarde Speaks', impact: 'high' },
    { h: 5, m: 0, cur: 'EUR', title: 'CPI Flash Estimate y/y', impact: 'high', base: 2.1, step: 0.1, unit: '%' },
    { h: 5, m: 0, cur: 'EUR', title: 'German ZEW Economic Sentiment', impact: 'medium', base: 12, step: 3, unit: '' },
  ],
  open: [
    { h: 8, m: 30, cur: 'USD', title: 'CPI m/m', impact: 'high', base: 0.3, step: 0.1, unit: '%', usd: 1, risk: -1 },
    { h: 8, m: 30, cur: 'USD', title: 'Core Retail Sales m/m', impact: 'high', base: 0.3, step: 0.2, unit: '%', usd: 1, risk: 1 },
    { h: 8, m: 30, cur: 'USD', title: 'Unemployment Claims', impact: 'medium', base: 225, step: 6, unit: 'K', usd: -1, risk: -1 },
    { h: 8, m: 30, cur: 'USD', title: 'PPI m/m', impact: 'medium', base: 0.2, step: 0.1, unit: '%', usd: 1, risk: -1 },
    { h: 8, m: 30, cur: 'USD', title: 'Core PCE Price Index m/m', impact: 'high', base: 0.2, step: 0.1, unit: '%', usd: 1, risk: -1 },
  ],
  session: [
    { h: 10, m: 0, cur: 'USD', title: 'ISM Manufacturing PMI', impact: 'high', base: 49.5, step: 0.8, unit: '', usd: 1, risk: 1 },
    { h: 10, m: 0, cur: 'USD', title: 'ISM Services PMI', impact: 'high', base: 52.0, step: 0.9, unit: '', usd: 1, risk: 1 },
    { h: 10, m: 0, cur: 'USD', title: 'CB Consumer Confidence', impact: 'high', base: 98, step: 2.5, unit: '', usd: 1, risk: 1 },
    { h: 10, m: 0, cur: 'USD', title: 'JOLTS Job Openings', impact: 'high', base: 7.4, step: 0.2, unit: 'M', usd: 1, risk: 1 },
    { h: 10, m: 0, cur: 'USD', title: 'Pending Home Sales m/m', impact: 'medium', base: 0.5, step: 1.2, unit: '%', usd: 1, risk: 1 },
    { h: 10, m: 0, cur: 'USD', title: 'Prelim UoM Consumer Sentiment', impact: 'medium', base: 58, step: 1.5, unit: '', usd: 1, risk: 1 },
    { h: 10, m: 0, cur: 'USD', title: 'New Home Sales', impact: 'medium', base: 690, step: 25, unit: 'K', usd: 1, risk: 1 },
  ],
  oil: { h: 10, m: 30, cur: 'USD', title: 'Crude Oil Inventories', impact: 'medium', base: -1.2, step: 1.6, unit: 'M', oil: -1 },
  fedSpeak: { cur: 'USD', title: 'FOMC Member Waller Speaks', impact: 'medium' },
  fomc: [
    { h: 14, m: 0, cur: 'USD', title: 'FOMC Statement', impact: 'high', usd: 1, risk: -1 },
    { h: 14, m: 0, cur: 'USD', title: 'Federal Funds Rate', impact: 'high', base: 4.25, step: 0.25, unit: '%', usd: 1, risk: -1, fixed: true },
    { h: 14, m: 30, cur: 'USD', title: 'FOMC Press Conference', impact: 'high', usd: 1, risk: -1 },
  ],
  auction: { h: 13, m: 0, cur: 'USD', title: '10-y Bond Auction', impact: 'low' },
};

const fmtVal = (v, t) => `${Number(v.toFixed(t.step < 0.1 ? 2 : t.step < 1 ? 1 : 0))}${t.unit}`;

// 8:30 AM / 2 PM style, for the voices.
export function spokenTime(ms) {
  const p = nyParts(ms);
  const h12 = p.hour % 12 || 12;
  const ampm = p.hour < 12 ? 'AM' : 'PM';
  return p.minute ? `${h12}:${String(p.minute).padStart(2, '0')} ${ampm}` : `${h12} ${ampm}`;
}

function simEvent(dateKey, t, rng, extra = {}) {
  const [y, mo, d] = dateKey.split('-').map(Number);
  const time = nyWallToMs(y, mo, d, extra.h ?? t.h, extra.m ?? t.m);
  const ev = {
    id: `sim-${dateKey}-${hash(t.title + (extra.m ?? t.m)).toString(36)}`,
    title: t.title, currency: t.cur, time, impact: t.impact,
    forecast: '', previous: '', actual: '', source: 'sim',
    usd: t.usd ?? 0, risk: t.risk ?? 0, oil: t.oil ?? 0,
  };
  if (t.base != null) {
    const pick = () => t.base + t.step * (Math.floor(rng() * 3) - 1);
    const forecast = pick();
    const surprise = t.fixed ? (rng() < 0.8 ? 0 : rng() < 0.5 ? -1 : 1) : Math.round((rng() + rng() + rng() - 1.5) * 2.2);
    ev.forecast = fmtVal(forecast, t);
    ev.previous = fmtVal(pick(), t);
    ev.simActual = fmtVal(forecast + surprise * t.step, t);
    ev.surprise = surprise;
  } else {
    // Speeches and statements: the "surprise" is the tone (hawkish / dovish).
    ev.surprise = Math.round((rng() - 0.5) * 3);
  }
  return ev;
}

export function simCalendarDay(dateKey) {
  const [y, mo, d] = dateKey.split('-').map(Number);
  const wd = new Date(Date.UTC(y, mo - 1, d, 12)).getUTCDay();
  if (wd === 0 || wd === 6) return [];
  const rng = mulberry32(hash(`calendar-${dateKey}`));
  const pickOne = (list) => list[Math.floor(rng() * list.length)];
  const events = [];
  if (rng() < 0.55) events.push(simEvent(dateKey, pickOne(SIM_TEMPLATES.early), rng));
  if (rng() < 0.7) events.push(simEvent(dateKey, pickOne(SIM_TEMPLATES.open), rng));
  if (rng() < 0.6) events.push(simEvent(dateKey, pickOne(SIM_TEMPLATES.session), rng));
  if (wd === 3) events.push(simEvent(dateKey, SIM_TEMPLATES.oil, rng));
  if (rng() < 0.4) events.push(simEvent(dateKey, SIM_TEMPLATES.fedSpeak, rng, { h: 11 + Math.floor(rng() * 4), m: rng() < 0.5 ? 0 : 30 }));
  if (rng() < 0.3) events.push(simEvent(dateKey, SIM_TEMPLATES.auction, rng));
  if (rng() < 0.07) for (const t of SIM_TEMPLATES.fomc) events.push(simEvent(dateKey, t, rng));
  return events.sort((a, b) => a.time - b.time);
}

// Usual US release times, used when the live calendar can't be reached.
function scheduleDay(dateKey) {
  const [y, mo, d] = dateKey.split('-').map(Number);
  const wd = new Date(Date.UTC(y, mo - 1, d, 12)).getUTCDay();
  if (wd === 0 || wd === 6) return [];
  const mk = (h, m, title) => ({
    id: `sched-${dateKey}-${h}${m}`, title, currency: 'USD', time: nyWallToMs(y, mo, d, h, m),
    impact: 'medium', forecast: '', previous: '', actual: '', source: 'schedule',
  });
  const out = [mk(8, 30, 'Data release window (08:30 ET)'), mk(10, 0, 'Data release window (10:00 ET)')];
  if (wd === 3) out.push({ ...mk(10, 30, 'Crude Oil Inventories (usual time)'), id: `sched-${dateKey}-oil` });
  return out;
}

const dayKeys = (fromMs, toMs) => {
  const keys = [];
  for (let t = fromMs - 86_400_000; t <= toMs + 86_400_000; t += 86_400_000) {
    const k = nyDateKey(t);
    if (!keys.includes(k)) keys.push(k);
  }
  return keys;
};

export class NewsCalendar extends EventEmitter {
  constructor({ clock, mode, dataDir, log = console, fetchImpl = globalThis.fetch }) {
    super();
    this.clock = clock;
    this.mode = mode;
    this.log = log;
    this.fetch = fetchImpl;
    this.cacheFile = dataDir ? path.join(dataDir, 'calendar.json') : null;
    this.settingsFile = dataDir ? path.join(dataDir, 'news.json') : null;
    this.settings = { ...DEFAULT_SETTINGS };
    this.live = new Map();
    this.coverage = []; // [{ from, to }] spans the live calendar covers
    this.simDays = new Map();
    this.status = mode === 'sim' ? 'sim' : 'loading';
    this.error = null;
    this.updatedAt = null;
    this.announced = new Set();
    this.#loadSettings();
    if (mode !== 'sim') this.#loadCache();
  }

  #loadSettings() {
    try {
      Object.assign(this.settings, JSON.parse(fs.readFileSync(this.settingsFile, 'utf8')));
    } catch {
      /* defaults */
    }
  }

  setSettings(patch = {}) {
    if (typeof patch.enabled === 'boolean') this.settings.enabled = patch.enabled;
    if (typeof patch.keepWinners === 'boolean') this.settings.keepWinners = patch.keepWinners;
    try {
      if (this.settingsFile) fs.writeFileSync(this.settingsFile, JSON.stringify(this.settings, null, 1));
    } catch {
      /* ignore */
    }
    this.emit('change');
    return { ok: true, settings: this.settings };
  }

  #loadCache() {
    try {
      const c = JSON.parse(fs.readFileSync(this.cacheFile, 'utf8'));
      for (const e of c.events || []) this.live.set(e.id, e);
      this.coverage = c.coverage || [];
      this.updatedAt = c.updatedAt || null;
      if (this.live.size) this.status = 'cached';
    } catch {
      /* no cache yet */
    }
  }

  #saveCache() {
    if (!this.cacheFile) return;
    try {
      fs.writeFileSync(this.cacheFile, JSON.stringify({ updatedAt: this.updatedAt, coverage: this.coverage, events: [...this.live.values()] }));
    } catch {
      /* ignore */
    }
  }

  async init() {
    if (this.mode === 'sim') return;
    const stale = !this.updatedAt || Date.now() - this.updatedAt > REFRESH_MS;
    if (stale) await this.refresh();
    this.#schedule(this.error ? RETRY_MS : REFRESH_MS);
  }

  #schedule(ms) {
    clearTimeout(this.timer);
    this.timer = setTimeout(async () => {
      await this.refresh();
      this.#schedule(this.error ? RETRY_MS : REFRESH_MS);
    }, ms);
    this.timer.unref?.();
  }

  stop() {
    clearTimeout(this.timer);
  }

  async refresh() {
    if (this.mode === 'sim') return;
    let got = 0;
    let lastErr = null;
    for (const [i, url] of FEED_URLS.entries()) {
      try {
        const ctrl = new AbortController();
        const timer = setTimeout(() => ctrl.abort(), 10_000);
        let rows;
        try {
          const res = await this.fetch(url, { signal: ctrl.signal, headers: { 'User-Agent': 'Mozilla/5.0 (Macintosh) TradingFloor/1.0', Accept: 'application/json' } });
          if (!res.ok) throw new Error(`HTTP ${res.status}`);
          rows = await res.json();
        } finally {
          clearTimeout(timer);
        }
        const events = parseForexFactory(rows);
        if (!events.length) continue;
        for (const e of events) {
          const prev = this.live.get(e.id);
          this.live.set(e.id, prev?.actual && !e.actual ? { ...e, actual: prev.actual } : e);
        }
        // The file covers one Sunday→Saturday week (New York time).
        const first = Math.min(...events.map((e) => e.time));
        const p = nyParts(first);
        const sunday = nyWallToMs(p.year, p.month, p.day, 0, 0) - ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'].indexOf(p.weekday) * 86_400_000;
        this.coverage = this.coverage.filter((c) => c.from !== sunday).concat({ from: sunday, to: sunday + 7 * 86_400_000 });
        got += events.length;
      } catch (err) {
        // The next-week file only exists late in the week; only the current week matters.
        if (i === 0) lastErr = err;
      }
    }
    const cutoff = Date.now() - KEEP_MS;
    for (const [id, e] of this.live) if (e.time < cutoff) this.live.delete(id);
    this.coverage = this.coverage.filter((c) => c.to > cutoff);
    if (got) {
      this.status = 'live';
      this.error = null;
      this.updatedAt = Date.now();
      this.#saveCache();
      this.log.info?.(`[news] economic calendar updated (${this.live.size} events this week)`);
    } else {
      this.error = lastErr ? `Could not load the economic calendar (${lastErr.message})` : 'The economic calendar was empty';
      this.status = this.live.size ? 'cached' : 'schedule';
      this.log.warn?.(`[news] ${this.error}${this.live.size ? ' — using the saved copy' : ' — standing aside around the usual US release times instead'}`);
    }
    this.emit('change');
  }

  #covered(ms) {
    return this.coverage.some((c) => ms >= c.from && ms < c.to);
  }

  // All events between two times, oldest first.
  events(fromMs, toMs) {
    const out = [];
    if (this.mode === 'sim') {
      for (const k of dayKeys(fromMs, toMs)) {
        if (!this.simDays.has(k)) {
          this.simDays.set(k, simCalendarDay(k));
          if (this.simDays.size > 120) this.simDays.delete(this.simDays.keys().next().value);
        }
        out.push(...this.simDays.get(k));
      }
    } else {
      for (const e of this.live.values()) out.push(e);
      for (const k of dayKeys(fromMs, toMs)) {
        const [y, mo, d] = k.split('-').map(Number);
        const noon = nyWallToMs(y, mo, d, 12, 0);
        if (!this.#covered(noon)) out.push(...scheduleDay(k));
      }
    }
    return out.filter((e) => e.time >= fromMs && e.time <= toMs).sort((a, b) => a.time - b.time);
  }

  #window(impact) {
    const s = this.settings;
    return impact === 'high' ? [s.highBefore * MIN, s.highAfter * MIN] : [s.mediumBefore * MIN, s.mediumAfter * MIN];
  }

  // Blackout windows for a market between two times (for backtests): [{ from, to, flatAt }].
  windows(symbol, fromMs, toMs) {
    const out = [];
    for (const e of this.events(fromMs - 3_600_000, toMs + 3_600_000)) {
      const impact = impactFor(e, symbol);
      if (!impact) continue;
      const [before, after] = this.#window(impact);
      out.push({ from: e.time - before, to: e.time + after, flatAt: impact === 'high' ? e.time - this.settings.flattenBefore * MIN : null, impact });
    }
    return out;
  }

  // Is this market inside a news blackout right now? → { event, impact, from, until, phase } | null
  blackout(symbol, ms = this.clock.now()) {
    if (!this.settings.enabled) return null;
    let hit = null;
    for (const e of this.events(ms - 3_600_000, ms + 3_600_000)) {
      const impact = impactFor(e, symbol);
      if (!impact) continue;
      const [before, after] = this.#window(impact);
      if (ms >= e.time - before && ms < e.time + after && (!hit || e.time + after > hit.until)) {
        hit = { event: e, impact, from: e.time - before, until: e.time + after, phase: ms < e.time ? 'before' : 'after' };
      }
    }
    return hit;
  }

  // High-impact news for this market is minutes away: time to get flat.
  preNews(symbol, ms = this.clock.now()) {
    if (!this.settings.enabled) return null;
    for (const e of this.events(ms - 5 * MIN, ms + 30 * MIN)) {
      if (impactFor(e, symbol) !== 'high') continue;
      if (ms >= e.time - this.settings.flattenBefore * MIN && ms < e.time + 2 * MIN) return e;
    }
    return null;
  }

  // Next event (high or medium) for this market within the horizon.
  next(symbol, ms = this.clock.now(), horizonMs = 3 * 3_600_000) {
    for (const e of this.events(ms, ms + horizonMs)) {
      const impact = impactFor(e, symbol);
      if (impact && e.time > ms) return { event: e, impact };
    }
    return null;
  }

  // Events whose release time falls in (from, to] — the simulator moves prices on these.
  releasedBetween(fromMs, toMs) {
    return this.events(fromMs, toMs).filter((e) => e.time > fromMs && e.time <= toMs && e.impact !== 'low' && e.impact !== 'holiday');
  }

  // Called every second: floor announcements ahead of and at big releases.
  tick(ms = this.clock.now()) {
    if (!this.settings.enabled) return;
    for (const e of this.events(ms - 2 * MIN, ms + 16 * MIN)) {
      const markets = marketsFor(e);
      if (!markets.length) continue;
      const high = markets.some((s) => impactFor(e, s) === 'high');
      const soonKey = `soon-${e.id}`;
      if (high && e.time - ms <= 15 * MIN && e.time > ms && !this.announced.has(soonKey)) {
        this.announced.add(soonKey);
        const mins = Math.max(1, Math.round((e.time - ms) / MIN));
        this.emit('announce', { kind: 'news', event: e, text: `High-impact news in ${mins} min: ${eventLabel(e)} at ${fmtNyTime(e.time)} NY. No new trades on ${markets.join(', ')}; desks go flat ${this.settings.flattenBefore} min before.` });
      }
      const outKey = `out-${e.id}`;
      if (ms >= e.time && !this.announced.has(outKey)) {
        this.announced.add(outKey);
        if (e.source === 'sim' && e.simActual) e.actual = e.simActual;
        const nums = e.actual ? `: actual ${e.actual} vs forecast ${e.forecast || 'n/a'}` : '';
        const [, after] = this.#window(high ? 'high' : 'medium');
        this.emit('announce', { kind: 'news', event: e, text: `${eventLabel(e)} is out${nums}. Desks wait ${Math.round(after / MIN)} min for the spike to settle.` });
      }
    }
    if (this.announced.size > 500) this.announced = new Set([...this.announced].slice(-200));
  }

  view(ms = this.clock.now()) {
    const events = this.events(ms - 6 * 3_600_000, ms + 36 * 3_600_000)
      .filter((e) => e.impact !== 'low' || e.time > ms - 3_600_000)
      .slice(0, 80)
      .map((e) => {
        const markets = marketsFor(e);
        const actual = e.actual || (e.source === 'sim' && ms >= e.time ? e.simActual : '') || '';
        return {
          id: e.id, title: e.title, label: eventLabel(e), currency: e.currency, time: e.time, impact: e.impact,
          forecast: e.forecast, previous: e.previous, actual, source: e.source,
          markets, high: markets.filter((s) => impactFor(e, s) === 'high'),
        };
      });
    const blackouts = {};
    for (const s of Object.keys(SYMBOLS)) {
      const b = this.blackout(s, ms);
      if (b) blackouts[s] = { label: eventLabel(b.event), impact: b.impact, until: b.until, phase: b.phase };
    }
    return {
      mode: this.mode, status: this.status, error: this.error, updatedAt: this.updatedAt,
      settings: this.settings, now: ms, events, blackouts,
    };
  }
}
