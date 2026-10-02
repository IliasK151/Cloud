import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { YahooClient } from '../server/market/yahooClient.js';
import { FeedManager } from '../server/market/feedManager.js';
import { MarketClock } from '../server/market/session.js';
import { MarketData } from '../server/market/marketData.js';
import { Broker } from '../server/engine/broker.js';
import { HistoryStore, alignTo } from '../server/research/history.js';
import { ResearchLab } from '../server/research/lab.js';
import { Committee } from '../server/brain/committee.js';

const quiet = { info() {}, warn() {} };

// A Yahoo chart result with `n` one-minute bars ending now.
function chartResult(n = 120, price = 100) {
  const end = Math.floor(Date.now() / 60_000) * 60;
  const timestamp = Array.from({ length: n }, (_, i) => end - (n - 1 - i) * 60);
  const q = { open: [], high: [], low: [], close: [], volume: [] };
  timestamp.forEach((_, i) => {
    const p = price + Math.sin(i / 5);
    q.open.push(p); q.high.push(p + 0.2); q.low.push(p - 0.2); q.close.push(p + 0.05); q.volume.push(10);
  });
  return { timestamp, indicators: { quote: [q] } };
}

const response = (status, body = '', headers = {}) => ({
  status, ok: status >= 200 && status < 300,
  headers: { get: (k) => headers[k.toLowerCase()] ?? null, getSetCookie: () => [].concat(headers['set-cookie'] || []) },
  json: async () => JSON.parse(body), text: async () => body, arrayBuffer: async () => new ArrayBuffer(0),
});

test('the Yahoo client opens a cookie session, and backs off on HTTP 429 instead of hammering', async () => {
  let t = 1_000_000;
  const calls = [];
  let limited = true;
  const fetchImpl = async (url, opts) => {
    calls.push({ url, cookie: opts.headers.Cookie });
    if (url.startsWith('https://fc.yahoo.com')) return response(404, '', { 'set-cookie': ['A3=abc; Domain=.yahoo.com; Path=/'] });
    if (url.includes('/getcrumb')) return response(200, 'Crumb123');
    if (limited) return response(429, 'Too Many Requests');
    return response(200, JSON.stringify({ chart: { result: [chartResult(40)] } }));
  };
  const client = new YahooClient({ fetchImpl, gapMs: 0, baseBackoffMs: 30_000, now: () => t });

  await assert.rejects(client.chart('GC=F', 'interval=1m&range=2d'), (err) => err.rateLimited === true);
  const chartCalls = calls.filter((c) => c.url.includes('/v8/finance/chart/'));
  assert.equal(chartCalls.length, 1, 'a 429 is not retried on the other host');
  assert.equal(chartCalls[0].cookie, 'A3=abc');
  assert.match(chartCalls[0].url, /crumb=Crumb123/);

  // While paused, calls fail fast without touching the network.
  const before = calls.length;
  await assert.rejects(client.chart('GC=F', 'interval=1m&range=2d'), /429/);
  assert.equal(calls.length, before);

  // After the pause it works again, and a second 429 would pause longer.
  t += 31_000;
  limited = false;
  const result = await client.chart('GC=F', 'interval=1m&range=2d');
  assert.equal(result.timestamp.length, 40);
  assert.equal(client.strikes, 0);
});

test('live mode never simulates: a market whose feed is down has no prices until real ones arrive', async () => {
  const realFetch = globalThis.fetch;
  let answer = false;
  // Binance's REST klines (the websocket after it may fail here; that's fine).
  globalThis.fetch = async () => {
    if (!answer) throw new Error('offline');
    const end = Math.floor(Date.now() / 60_000) * 60_000;
    const rows = Array.from({ length: 100 }, (_, i) => [end - (99 - i) * 60_000, '100000', '100010', '99990', '100005', '5']);
    return { ok: true, json: async () => rows };
  };
  const client = {
    paused: false,
    chart: async () => {
      if (!answer) throw Object.assign(new Error('HTTP 429 (Yahoo rate limit)'), { rateLimited: true });
      return chartResult(120, 3800);
    },
  };
  const clock = new MarketClock('live');
  const md = new MarketData(clock);
  const feeds = new FeedManager({ md, clock, mode: 'live', log: quiet, yahooOptions: { client }, recoverDelaysMs: [20] });
  const recovered = [];
  feeds.on('recovered', (id, source) => recovered.push([id, source]));
  try {
    await feeds.start();
    assert.equal(feeds.sim, null, 'no simulator in live mode');
    for (const id of ['XAUUSD', 'GBPUSD', 'BTCUSD']) {
      assert.equal(md.get(id).status, 'WAITING', id);
      assert.equal(Number.isFinite(md.price(id)), false, `${id} has no made-up price`);
      assert.equal(md.bars(id).length, 0, `${id} has no made-up bars`);
    }
    assert.ok(feeds.notes.some((n) => /Waiting for real prices.*GBPUSD/.test(n)));

    // The real feeds answer: Yahoo's markets and Binance's coins get real prices.
    answer = true;
    const deadline = Date.now() + 4000;
    while (feeds.waiting.size && Date.now() < deadline) await new Promise((r) => setTimeout(r, 20));
    assert.equal(feeds.waiting.size, 0, `still waiting: ${[...feeds.waiting]}`);
    assert.equal(md.get('XAUUSD').source, 'yahoo');
    assert.equal(md.ownerOf('XAUUSD'), 'yahoo');
    assert.ok(Math.abs(md.price('XAUUSD') - 3800) < 5, `price ${md.price('XAUUSD')}`);
    assert.equal(md.get('BTCUSD').source, 'binance');
    assert.ok(Math.abs(md.price('BTCUSD') - 100005) < 1, `price ${md.price('BTCUSD')}`);
    assert.ok(recovered.some(([id, src]) => id === 'XAUUSD' && src === 'yahoo'));
    assert.ok(recovered.some(([id, src]) => id === 'BTCUSD' && src === 'binance'));
    assert.ok(!feeds.notes.some((n) => /Waiting for real prices/.test(n)));
  } finally {
    feeds.stop();
    globalThis.fetch = realFetch;
  }
});

test('trades on simulated prices are tagged and never count as a real record', () => {
  const clock = new MarketClock('live');
  const md = new MarketData(clock);
  const broker = new Broker(md, clock);
  md.setStatus('XAUUSD', 'SIM', 'sim');
  md.applyTick('XAUUSD', 3800, 1, clock.now(), 'sim');
  broker.execute('x', 'XAUUSD', 1, { initialRisk: 10 });
  const sim = broker.execute('x', 'XAUUSD', -1).closed[0];
  assert.equal(sim.simFeed, true);
  md.setStatus('EURUSD', 'LIVE', 'yahoo');
  md.applyTick('EURUSD', 1.1, 1, clock.now());
  broker.execute('x', 'EURUSD', 1000, { initialRisk: 1 });
  assert.equal(broker.execute('x', 'EURUSD', -1000).closed[0].simFeed, undefined);

  // In live mode the committee's measured edge only counts real-priced trades.
  const desk = { profile: {}, lifetime: { countR: 40, sumR: 12, realN: 4, realSumR: -0.5 }, learner: null };
  const live = new Committee({ brain: null, agents: new Map(), clock: { mode: 'live' } });
  const e = live.edge(desk, 'XAUUSD', 'LONG');
  assert.equal(e.n, 4);
  assert.ok(e.e < 0);
  assert.match(e.text, /real track record/);
  const demo = new Committee({ brain: null, agents: new Map(), clock: { mode: 'sim' } });
  assert.equal(demo.edge(desk, 'XAUUSD', 'LONG').n, 40);

  // A research strategy validated on simulated history has no edge for real money.
  const lab = { profile: { lab: true }, active: { symbol: 'XAUUSD', name: 'Test', real: false, stats: { unseen: { avgR: 0.3, n: 60 } }, live: { trades: 0, sumR: 0 } } };
  assert.equal(live.edge(lab, 'XAUUSD', 'LONG').e, 0);
  assert.match(live.edge(lab, 'XAUUSD', 'LONG').text, /simulated history/);
  lab.active.real = true;
  assert.ok(live.edge(lab, 'XAUUSD', 'LONG').e > 0);
});

test('research history: only real data, never generated in live mode; broker bars fill a market that had none', async () => {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'hist-'));
  const dir = path.join(dataDir, 'history');
  fs.mkdirSync(dir);
  // An old-format cache (could hold generated bars): must not be trusted.
  fs.writeFileSync(path.join(dir, 'EURUSD.json'), JSON.stringify([[1, 9, 9, 9, 9, 1]]));

  const clock = new MarketClock('live');
  const md = new MarketData(clock);
  const now = Math.floor(Date.now() / 60_000) * 60;
  const mk = (n, price, end = now) => Array.from({ length: n }, (_, i) => ({ time: end - (n - i) * 60, open: price, high: price + 1, low: price - 1, close: price + 0.5, volume: 5 }));
  md.seed('EURUSD', mk(100, 1.1));
  md.setStatus('EURUSD', 'LIVE', 'yahoo');
  for (const id of ['NAS100', 'SPX500', 'USOIL', 'USDJPY', 'XAUUSD', 'BTCUSD', 'ETHUSD', 'SOLUSD']) md.setStatus(id, 'LIVE', id.endsWith('USD') && id !== 'XAUUSD' && id !== 'USDJPY' ? 'binance' : 'yahoo');
  md.setStatus('XAUUSD', 'WAITING', 'none'); // gold's feed is down: no prices at all
  const fetchers = { binance: async () => [], yahoo: async () => { throw new Error('HTTP 429'); } };
  const history = new HistoryStore({ md, mode: 'live', dataDir, log: quiet, fetchers });
  await history.load();

  assert.ok(history.bars('EURUSD').every((b) => b.time !== 1), 'the old cache was ignored');
  assert.equal(history.isReal('EURUSD'), true);
  assert.equal(history.bars('XAUUSD').length, 0, 'no history for gold yet, and none is made up');
  assert.notEqual(history.status().XAUUSD.source, 'simulated');

  history.save();
  assert.equal(fs.existsSync(path.join(dir, 'XAUUSD.json')), false, 'nothing to save for gold yet');
  const saved = JSON.parse(fs.readFileSync(path.join(dir, 'EURUSD.json'), 'utf8'));
  assert.equal(saved.v, 2);
  assert.equal(saved.level, 'yahoo');

  // MT5 takes gold over with 3,000 of the broker's own bars.
  md.claim('XAUUSD', 'mt5', mk(3000, 3850));
  assert.equal(history.isReal('XAUUSD'), true);
  assert.equal(history.status().XAUUSD.source, 'broker');
  const bars = history.bars('XAUUSD');
  assert.equal(bars.length, 3000);
  assert.ok(bars.every((b) => b.close === 3850.5), 'no generated bars left');
  history.save();
  assert.equal(JSON.parse(fs.readFileSync(path.join(dir, 'XAUUSD.json'), 'utf8')).level, 'mt5');
  history.stop();
});

test('public history is shifted onto the broker price level by the overlap', () => {
  const feed = Array.from({ length: 50 }, (_, i) => ({ time: i * 60, open: 100, high: 101, low: 99, close: 100 + i * 0.1, volume: 1 }));
  const broker = feed.slice(30).map((b) => ({ ...b, close: b.close + 12 }));
  const out = alignTo(feed, broker);
  assert.ok(Math.abs(out[0].close - 112) < 1e-9);
  assert.equal(alignTo(feed, [{ time: 999_999, close: 5 }]), null);
});

test('the research lab records whether a strategy was validated on real data', async () => {
  const results = [];
  for (const real of [false, true]) {
    const history = { ready: true, bars: () => [], isReal: () => real };
    const lab = new ResearchLab({ history, mode: 'live', inline: true, log: quiet });
    const done = new Promise((r) => lab.once('result', r));
    lab.request('mei', 'BTCUSD');
    results.push(await done);
  }
  assert.deepEqual(results.map((r) => r.real), [false, true]);
});

test('a Yahoo answer that stalls halfway times out instead of holding up every request after it', async () => {
  let stall = true;
  const fetchImpl = async (url) => {
    if (url.startsWith('https://fc.yahoo.com') || url.includes('/getcrumb')) return response(404, '');
    if (stall) return { ...response(200, ''), text: () => new Promise(() => {}) }; // headers came, the body never does
    return response(200, JSON.stringify({ chart: { result: [chartResult(5)] } }));
  };
  const client = new YahooClient({ fetchImpl, gapMs: 0 });
  await assert.rejects(client.chart('GC=F', 'interval=1m', 50), /timed out/);
  stall = false;
  const result = await client.chart('GC=F', 'interval=1m', 50);
  assert.equal(result.timestamp.length, 5, 'the next request went through');
});

test('research history never waits forever: a feed that doesn\'t answer is skipped, and MT5\'s bars are used', async () => {
  const clock = new MarketClock('live');
  const md = new MarketData(clock);
  const now = Math.floor(Date.now() / 60_000) * 60;
  const mk = (n, price) => Array.from({ length: n }, (_, i) => ({ time: now - (n - i) * 60, open: price, high: price + 1, low: price - 1, close: price + 0.5, volume: 5 }));
  const fetchers = { binance: async () => [], yahoo: () => new Promise(() => {}) }; // Yahoo never answers
  const history = new HistoryStore({ md, mode: 'live', log: quiet, fetchers, loadDeadlineMs: 100 });
  const loading = history.load();
  // MT5 takes gold over while the history is loading, with 6,000 of the broker's bars.
  md.claim('XAUUSD', 'mt5', mk(6000, 3800), 'LIVE');
  const started = Date.now();
  await loading;
  assert.ok(Date.now() - started < 5000, 'done within the deadline');
  assert.equal(history.ready, true);
  assert.equal(history.status().XAUUSD.source, 'broker');
  assert.ok(history.bars('XAUUSD').length >= 6000, 'the research desks get the broker\'s bars');
});
