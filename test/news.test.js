import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { NewsCalendar, parseForexFactory, impactFor, simCalendarDay, spokenLabel } from '../server/market/calendar.js';
import { MarketClock, Session, nyWallToMs } from '../server/market/session.js';
import { MarketData } from '../server/market/marketData.js';
import { SimFeed } from '../server/market/simFeed.js';
import { Broker } from '../server/engine/broker.js';
import { RiskManager } from '../server/engine/risk.js';
import { Fund } from '../server/engine/fund.js';
import { config } from '../server/config.js';

const quiet = { info() {}, warn() {} };
const MIN = 60_000;

// A calendar with a fixed list of events (live mode, no network).
function fixedCalendar(events, clock = { now: () => Date.now() }) {
  const cal = new NewsCalendar({ clock, mode: 'live', dataDir: null, log: quiet, fetchImpl: async () => { throw new Error('offline'); } });
  for (const e of events) cal.live.set(e.id, e);
  const t = events[0]?.time ?? Date.now();
  cal.coverage = [{ from: t - 7 * 86_400_000, to: t + 7 * 86_400_000 }];
  return cal;
}

const cpi = (time) => ({ id: 'cpi', title: 'CPI m/m', currency: 'USD', time, impact: 'high', forecast: '0.3%', previous: '0.2%', actual: '', source: 'forexfactory' });

test('Forex Factory rows are parsed and mapped to the markets they move', () => {
  const rows = [
    { title: 'CPI m/m', country: 'USD', date: '2026-10-14T08:30:00-04:00', impact: 'High', forecast: '0.3%', previous: '0.4%' },
    { title: 'Crude Oil Inventories', country: 'USD', date: '2026-10-14T10:30:00-04:00', impact: 'Medium', forecast: '-1.2M', previous: '0.8M' },
    { title: 'German ZEW Economic Sentiment', country: 'EUR', date: '2026-10-14T05:00:00-04:00', impact: 'Medium' },
    { title: 'Bank Holiday', country: 'JPY', date: '2026-10-13T00:00:00-04:00', impact: 'Holiday' },
    { title: 'broken', country: 'USD', date: 'not a date', impact: 'High' },
  ];
  const ev = parseForexFactory(rows);
  assert.equal(ev.length, 4);
  const [c, oil, zew] = ev;
  assert.equal(c.time, Date.parse('2026-10-14T12:30:00Z'));
  assert.equal(c.impact, 'high');
  // US CPI moves every market, crypto included.
  for (const s of ['NAS100', 'EURUSD', 'USDJPY', 'XAUUSD', 'BTCUSD']) assert.equal(impactFor(c, s), 'high');
  // The oil report matters (a lot) to oil only.
  assert.equal(impactFor(oil, 'USOIL'), 'high');
  assert.equal(impactFor(oil, 'NAS100'), null);
  // Euro data moves EURUSD, not US stocks; medium-impact data doesn't move crypto.
  assert.equal(impactFor(zew, 'EURUSD'), 'medium');
  assert.equal(impactFor(zew, 'NAS100'), null);
  assert.equal(impactFor({ ...c, impact: 'medium' }, 'BTCUSD'), null);
  assert.equal(spokenLabel(c), 'US CPI month on month');
});

test('blackout windows: 15 minutes around high impact, 5 around medium, flat 5 minutes before', () => {
  const T = nyWallToMs(2026, 10, 14, 8, 30);
  const cal = fixedCalendar([cpi(T), { id: 'claims', title: 'Unemployment Claims', currency: 'USD', time: T + 3 * 3_600_000, impact: 'medium' }]);
  assert.equal(cal.blackout('NAS100', T - 16 * MIN), null);
  assert.equal(cal.blackout('NAS100', T - 14 * MIN).phase, 'before');
  assert.equal(cal.blackout('NAS100', T + 14 * MIN).phase, 'after');
  assert.equal(cal.blackout('NAS100', T + 16 * MIN), null);
  assert.equal(cal.preNews('NAS100', T - 6 * MIN), null);
  assert.equal(cal.preNews('NAS100', T - 4 * MIN).id, 'cpi');
  const med = T + 3 * 3_600_000;
  assert.ok(cal.blackout('EURUSD', med - 4 * MIN));
  assert.equal(cal.blackout('EURUSD', med - 6 * MIN), null);
  assert.equal(cal.preNews('EURUSD', med - 2 * MIN), null, 'medium news does not force anyone flat');
  assert.equal(cal.next('SPX500', T - 60 * MIN).event.id, 'cpi');
  // Switched off: no blackouts at all.
  cal.setSettings({ enabled: false });
  assert.equal(cal.blackout('NAS100', T), null);
});

test('without the live calendar the desks stand aside at the usual US release times', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'news-'));
  const cal = new NewsCalendar({ clock: { now: () => Date.now() }, mode: 'live', dataDir: dir, log: quiet, fetchImpl: async () => { throw new Error('getaddrinfo ENOTFOUND'); } });
  await cal.refresh();
  assert.equal(cal.status, 'schedule');
  assert.match(cal.error, /Could not load the economic calendar/);
  // Find a weekday and check the 08:30 window.
  let day = Date.now();
  while (['Sat', 'Sun'].includes(new Intl.DateTimeFormat('en-US', { timeZone: 'America/New_York', weekday: 'short' }).format(day))) day += 86_400_000;
  const p = new Intl.DateTimeFormat('en-CA', { timeZone: 'America/New_York', year: 'numeric', month: '2-digit', day: '2-digit' }).format(day).split('-').map(Number);
  const t830 = nyWallToMs(p[0], p[1], p[2], 8, 30);
  assert.ok(cal.blackout('SPX500', t830 - 2 * MIN), '08:30 is treated as a release time');
  assert.equal(cal.blackout('BTCUSD', t830 - 2 * MIN), null, 'crypto ignores medium-impact windows');
});

test('the calendar is cached, and a successful refresh replaces the fallback', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'news-'));
  const rows = [{ title: 'Non-Farm Employment Change', country: 'USD', date: new Date(Date.now() + 3_600_000).toISOString(), impact: 'High', forecast: '150K', previous: '120K' }];
  const fetchImpl = async (url) => ({ ok: !url.includes('nextweek'), status: 404, json: async () => rows });
  const cal = new NewsCalendar({ clock: { now: () => Date.now() }, mode: 'live', dataDir: dir, log: quiet, fetchImpl });
  await cal.refresh();
  assert.equal(cal.status, 'live');
  assert.equal(cal.next('NAS100').event.title, 'Non-Farm Employment Change');
  const again = new NewsCalendar({ clock: { now: () => Date.now() }, mode: 'live', dataDir: dir, log: quiet, fetchImpl: async () => { throw new Error('offline'); } });
  assert.equal(again.status, 'cached');
  assert.equal(again.next('NAS100').event.title, 'Non-Farm Employment Change');
});

test('the risk desk refuses new trades inside a news blackout', () => {
  const T = nyWallToMs(2026, 10, 14, 10, 0);
  let now = T - 10 * MIN;
  const clock = { now: () => now, mode: 'live' };
  const session = new Session(clock);
  const risk = new RiskManager(config.risk, session);
  risk.news = fixedCalendar([{ ...cpi(T), title: 'ISM Manufacturing PMI' }], clock);
  const agent = { paused: false, halted: null, symbol: 'NAS100', day: { trades: 0 }, cooldownBars: 0, profile: {} };
  const blocked = risk.canOpen(agent);
  assert.equal(blocked.ok, false);
  assert.match(blocked.reason, /News blackout: US ISM Manufacturing PMI at 10:00 \(high impact\), no new NAS100 trades until 10:15/);
  now = T + 20 * MIN;
  assert.equal(risk.canOpen(agent).ok, true);
});

test('desks go flat before high-impact news, and the simulator moves the market on the release', () => {
  const clock = new MarketClock('sim', 1);
  const session = new Session(clock);
  const md = new MarketData(clock);
  const broker = new Broker(md, clock);
  const risk = new RiskManager(config.risk, session);
  const T = clock.now() + 60 * MIN;
  const news = fixedCalendar([{ ...cpi(T), surprise: 3, usd: 1, risk: -1 }], clock);
  const fund = new Fund({ config: { ...config, feed: 'sim' }, md, clock, session, broker, risk, news });
  const sim = new SimFeed(md, clock, ['NAS100', 'EURUSD', 'XAUUSD', 'BTCUSD'], { seed: 11, calendar: news });
  sim.warmup(300);
  fund.trading = true;
  const marcus = fund.byId.get('marcus');
  // Put a trade on well before the news.
  const px = marcus.price('NAS100');
  assert.ok(marcus.openTrade({ side: 'LONG', stop: px * 0.95, target: px * 1.1, reason: 'test', partialAt: null }));
  const events = [];
  fund.on('event', (e) => events.push(e));
  const advance = (ms) => {
    const end = clock.now() + ms;
    while (clock.now() < end) {
      const from = clock.now();
      clock.t += 5000;
      sim.step(from, clock.now());
      fund.housekeeping();
    }
  };
  advance(54 * MIN); // T-6: still allowed to hold
  assert.ok(marcus.position('NAS100'), `still in the trade 6 minutes before (${broker.book('marcus').trades.at(-1)?.exitReason})`);
  assert.equal(marcus.status(), 'IN TRADE');
  advance(2 * MIN); // T-4
  assert.equal(marcus.position('NAS100'), null, 'flat before the release');
  assert.equal(marcus.status(), 'NEWS');
  assert.match(broker.book('marcus').trades.at(-1).exitReason, /News: US CPI m\/m/);
  assert.ok(events.some((e) => e.kind === 'news' && /High-impact news in/.test(e.text)));
  assert.match(marcus.briefing().text, /standing aside until/);
  // No new trades inside the window.
  assert.equal(marcus.openTrade({ side: 'LONG', stop: marcus.price('NAS100') * 0.99, reason: 'test' }), false);
  // The release: a hot CPI print lifts the dollar (EURUSD down) with a burst of volatility.
  const before = md.price('EURUSD');
  advance(5 * MIN);
  const bars = md.bars('EURUSD').slice(-3);
  const range = Math.max(...bars.map((b) => b.high)) - Math.min(...bars.map((b) => b.low));
  const calm = md.bars('EURUSD').slice(-60, -30);
  const typical = calm.reduce((s, b) => s + (b.high - b.low), 0) / calm.length;
  assert.ok(range > 3 * typical, `release moved EURUSD (${range} vs ${typical} typical)`);
  assert.ok(md.price('EURUSD') < before, 'hot US data → stronger dollar');
  assert.ok(events.some((e) => e.kind === 'news' && /US CPI m\/m is out/.test(e.text)));
});

test('the simulated calendar is deterministic, weekday-only and realistic', () => {
  const a = simCalendarDay('2026-10-14');
  const b = simCalendarDay('2026-10-14');
  assert.deepEqual(a, b);
  assert.deepEqual(simCalendarDay('2026-10-17'), [], 'Saturday');
  let wednesdays = 0;
  let withOil = 0;
  for (let d = 1; d <= 28; d++) {
    const key = `2026-10-${String(d).padStart(2, '0')}`;
    const evs = simCalendarDay(key);
    if (new Date(`${key}T12:00:00Z`).getUTCDay() === 3) {
      wednesdays++;
      if (evs.some((e) => e.title === 'Crude Oil Inventories')) withOil++;
    }
    for (const e of evs) assert.ok(['high', 'medium', 'low'].includes(e.impact));
  }
  assert.equal(withOil, wednesdays, 'the oil report comes out every Wednesday');
});
