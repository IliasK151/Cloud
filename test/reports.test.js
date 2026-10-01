import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { DailyReports, summarize, skipCategory } from '../server/live/dailyReport.js';
import { dailyAlertText } from '../server/live/liveTrader.js';
import { TelegramNotifier } from '../server/notify/telegram.js';

const quiet = { info() {}, warn() {} };
const tmp = (p) => fs.mkdtempSync(path.join(os.tmpdir(), p));
const wait = (ms) => new Promise((r) => setTimeout(r, ms));

test('held-back reasons are grouped the way a trader thinks about them', () => {
  assert.equal(skipCategory('committee grade C: the account only takes A-grade trades'), 'Committee grade too low');
  assert.equal(skipCategory('the account already has a FX position (one per correlated group)'), 'Correlated position already open');
  assert.equal(skipCategory('already 5 live positions (max 5)'), 'Max open positions reached');
  assert.equal(skipCategory('open-risk budget of 1.5% is full'), 'Open-risk budget full');
  assert.equal(skipCategory('news blackout (CPI m/m)'), 'News blackout');
  assert.equal(skipCategory('the desk needs 10 or more paper trades on real market prices before it risks real money (3 so far)'), 'Desk not proven yet');
  assert.equal(skipCategory('6 trades today, the plan\'s daily cap of 6'), 'Account plan stopped for the day');
  assert.equal(skipCategory('no FTMO symbol mapped for SOLUSD'), 'Market not on MT5');
  assert.equal(skipCategory('something new'), 'Other');
});

test('a day\'s report card: trades, R, held-back trades, account; finalised when the day rolls', async () => {
  const dataDir = tmp('rep-');
  let t = Date.UTC(2026, 9, 1, 8, 0);
  const reports = new DailyReports({ dataDir, log: quiet, now: () => t });
  const finals = [];
  reports.onFinal = (s, r) => finals.push([s, r]);
  const D1 = '2026.10.01';
  reports.snapshot(D1, { login: 1514792774, server: 'FTMO-Demo', type: 'Free Trial', size: 10_000, startBalance: 10_000, balance: 10_000, equity: 10_000 });
  reports.opened(D1, { key: 'k1', agentId: 'ryan', name: 'Ryan Cole', desk: 'Scalping · Gold London', symbol: 'XAUUSD', side: 'BUY', volume: 0.1, risk: 25, grade: 'B' });
  reports.skipped(D1, { agentId: 'jake', name: 'Jake Morrison', symbol: 'GBPUSD', reason: 'the account already has a FX position (one per correlated group)' });
  reports.skipped(D1, { agentId: 'jake', name: 'Jake Morrison', symbol: 'GBPUSD', reason: 'committee grade C: the account only takes A and B-grade trades' });
  t += 20 * 60_000;
  reports.closed(D1, { key: 'k1', agentId: 'ryan', name: 'Ryan Cole', symbol: 'XAUUSD', side: 'BUY', volume: 0.1, risk: 25, pnl: 60 });
  reports.closed(D1, { key: 'k2', agentId: 'nico', name: 'Nico Rossi', symbol: 'US100.cash', side: 'SELL', volume: 0.2, risk: 25, pnl: -25 });
  reports.event(D1, 'guard', 'Risk guard: test');
  reports.snapshot(D1, { login: 1514792774, server: 'FTMO-Demo', startBalance: 10_000, balance: 10_035, equity: 10_035, dailyUsedPct: 0, maxUsedPct: 0 }, { ryan: { name: 'Ryan Cole', trades: 2, wins: 1 } });

  const s = summarize(reports.current);
  assert.equal(s.trades, 2);
  assert.equal(s.wins, 1);
  assert.equal(s.dayPnl, 35);
  assert.equal(s.avgR, 0.7); // (+2.4R − 1R) / 2
  assert.equal(s.skipped, 2);
  assert.equal(s.best.id, 'ryan');
  assert.equal(s.worst.id, 'nico');
  assert.equal(s.halted, true);
  assert.equal(reports.current.account.startBalance, 10_000, 'the day keeps its starting balance');
  assert.equal(reports.current.account.type, 'Free Trial');
  assert.equal(reports.current.trades.find((x) => x.key === 'k1').r, 2.4);

  const text = dailyAlertText(s);
  assert.match(text, /Daily report 2026\.10\.01: \+\$35/);
  assert.match(text, /2 trades, 1 win, average \+0\.70R/);
  assert.match(text, /Best: Ryan \+\$60\. Worst: Nico -\$25/);
  assert.match(text, /Held back on paper: 2 \(correlated position already open 1, committee grade too low 1\)/);

  // The next server day: yesterday is final (and summarised for the phone), today starts.
  const D2 = '2026.10.02';
  reports.opened(D2, { key: 'k3', agentId: 'mia', name: 'Mia Torres', symbol: 'XAUUSD', side: 'SELL', volume: 0.1, risk: 25 });
  assert.equal(finals.length, 1);
  assert.equal(finals[0][0].day, D1);
  assert.equal(reports.get(D1).final, true);
  assert.equal(reports.current.day, D2);
  reports.flush();
  assert.deepEqual(reports.list().map((d) => [d.day, d.final]), [[D2, false], [D1, true]]);
  assert.ok(fs.existsSync(path.join(dataDir, 'reports', '2026-10-01.json')));

  // The floor restarts mid-day: it carries on with today's card.
  const again = new DailyReports({ dataDir, log: quiet });
  assert.equal(again.current.day, D2);
  assert.equal(again.current.trades.length, 1);
  await wait(10);
});

// A fake Telegram Bot API.
function fakeTelegram({ updates = [], sendStatus = 200, photoStatus = 200 } = {}) {
  const calls = [];
  const fetchImpl = async (url, opts = {}) => {
    const method = url.split('/').pop();
    // A photo goes as a form (multipart); everything else as JSON.
    const body = opts.body instanceof FormData
      ? Object.fromEntries([...opts.body.entries()].map(([k, v]) => [k, typeof v === 'string' ? v : { type: v.type, size: v.size }]))
      : opts.body ? JSON.parse(opts.body) : null;
    calls.push({ url, method, body });
    const reply = (status, data) => ({ ok: status < 400, status, json: async () => data });
    if (!/\/bot\d+:[A-Za-z0-9_-]+\//.test(url)) return reply(404, { ok: false, description: 'Not Found' });
    if (method === 'getMe') return reply(200, { ok: true, result: { username: 'meridian_floor_bot', first_name: 'Meridian' } });
    if (method === 'getUpdates') return reply(200, { ok: true, result: updates });
    if (method === 'sendPhoto') return photoStatus === 200 ? reply(200, { ok: true, result: { message_id: calls.length } }) : reply(photoStatus, { ok: false, description: 'Bad Request: wrong file' });
    if (method === 'sendMessage') return sendStatus === 200 ? reply(200, { ok: true, result: { message_id: calls.length } }) : reply(sendStatus, { ok: false, description: 'Unauthorized' });
    return reply(404, { ok: false });
  };
  return { calls, fetchImpl };
}

const TOKEN = '123456789:AAHfakeTokenForTestsOnly_abcdefghijk';

test('Telegram alerts: set up with a bot token and the boss\'s chat, the token never leaves the Mac', async () => {
  const dataDir = tmp('tg-');
  const tg = fakeTelegram({ updates: [{ update_id: 1, message: { chat: { id: 4242, first_name: 'Ilias', type: 'private' }, text: 'hi' } }] });
  const n = new TelegramNotifier({ dataDir, log: quiet, fetchImpl: tg.fetchImpl, gapMs: 0 });

  assert.equal((await n.setToken('not a token')).ok, false);
  assert.equal(tg.calls.length, 0, 'nothing is sent for a malformed token');
  const set = await n.setToken(TOKEN);
  assert.equal(set.ok, true);
  assert.equal(set.botName, '@meridian_floor_bot');
  const view = n.view();
  assert.equal(view.token, '123456789:…hijk');
  assert.ok(!JSON.stringify(view).includes(TOKEN), 'the full token is never sent to the browser');
  assert.equal(fs.statSync(path.join(dataDir, 'telegram.json')).mode & 0o777, 0o600);

  const found = await n.findChat();
  assert.equal(found.ok, true);
  assert.equal(found.chatName, 'Ilias');
  assert.equal(n.view().enabled, true);
  assert.equal(tg.calls.at(-1).method, 'sendMessage');
  assert.equal(tg.calls.at(-1).body.chat_id, '4242');

  // Alerts go out in order; kinds the boss switched off don't.
  assert.equal(n.notify({ kind: 'trade', text: '🟩 Ryan bought 0.1 XAUUSD' }), true);
  assert.equal(n.notify({ kind: 'guard', text: '🛑 RISK GUARD' }), true);
  await wait(20);
  const sent = tg.calls.filter((c) => c.method === 'sendMessage').map((c) => c.body.text);
  assert.deepEqual(sent.slice(-2), ['🟩 Ryan bought 0.1 XAUUSD', '🛑 RISK GUARD']);
  n.settings({ kinds: { trade: false } });
  assert.equal(n.notify({ kind: 'trade', text: 'hidden' }), false);
  n.settings({ enabled: false });
  assert.equal(n.notify({ kind: 'guard', text: 'paused' }), false);
  assert.equal(n.settings({ chatId: 'abc' }).ok, false);

  // Settings survive a restart.
  const again = new TelegramNotifier({ dataDir, log: quiet, fetchImpl: tg.fetchImpl, gapMs: 0 });
  assert.equal(again.view().chatId, '4242');
  assert.equal(again.view().kinds.trade, false);
});

test('Telegram: a revoked bot token pauses the alerts instead of failing forever', async () => {
  const dataDir = tmp('tg2-');
  const tg = fakeTelegram({ updates: [{ update_id: 1, message: { chat: { id: 7 }, text: 'hi' } }] });
  const n = new TelegramNotifier({ dataDir, log: quiet, fetchImpl: tg.fetchImpl, gapMs: 0 });
  await n.setToken(TOKEN);
  await n.findChat();
  const revoked = fakeTelegram({ sendStatus: 401 });
  n.fetch = revoked.fetchImpl;
  n.notify({ kind: 'guard', text: 'x' });
  await wait(20);
  assert.equal(n.view().enabled, false);
  assert.match(n.view().lastError.text, /Unauthorized/);
});

test('Telegram: "Find my chat" says what to do when the bot has no message yet', async () => {
  const n = new TelegramNotifier({ dataDir: tmp('tg3-'), log: quiet, fetchImpl: fakeTelegram().fetchImpl, gapMs: 0 });
  await n.setToken(TOKEN);
  const res = await n.findChat();
  assert.equal(res.ok, false);
  assert.match(res.error, /press Start or send it "hi"/);
});

test('battery saver: the 3D floor draws only as often as it needs to', async () => {
  const { fpsFor } = await import('../public/js/floor/power.js');
  // Off: as fast as the display, as before.
  assert.equal(fpsFor({ eco: false, battery: true }), 0);
  // On the charger: smooth while you use it, calm when nobody touches it.
  assert.equal(fpsFor({ busy: true }), 30);
  assert.equal(fpsFor({ busy: false }), 15);
  assert.equal(fpsFor({ busy: true, focused: false }), 15, 'another window in front counts as not watching');
  // On battery: less again.
  assert.equal(fpsFor({ battery: true, busy: true }), 24);
  assert.equal(fpsFor({ battery: true }), 6);
});

test('an entry alert can carry its chart: sent as a photo with the reasons as caption, the text alone if the photo fails', async () => {
  const setUp = async (opts) => {
    const tg = fakeTelegram({ updates: [{ update_id: 1, message: { chat: { id: 77, type: 'private' }, text: 'hi' } }], ...opts });
    const n = new TelegramNotifier({ dataDir: tmp('tgp-'), log: quiet, fetchImpl: tg.fetchImpl, gapMs: 0 });
    await n.setToken(TOKEN);
    await n.findChat();
    tg.calls.length = 0;
    return { n, tg };
  };
  const png = Buffer.from([0x89, 0x50, 0x4e, 0x47, 1, 2, 3]);
  const { n, tg } = await setUp();
  n.notify({ kind: 'trade', text: '🟩 Ryan bought 0.48 XAUUSD @ 3812.70\nWhy: London scalp', photo: png });
  await new Promise((r) => setTimeout(r, 30));
  assert.equal(tg.calls.length, 1);
  assert.equal(tg.calls[0].method, 'sendPhoto');
  assert.equal(tg.calls[0].body.chat_id, '77');
  assert.match(tg.calls[0].body.caption, /Ryan bought 0\.48 XAUUSD @ 3812\.70\nWhy: London scalp/);
  assert.deepEqual(tg.calls[0].body.photo, { type: 'image/png', size: png.length });

  // A caption holds 1024 characters: the rest follows as a message, the photo isn't sent twice.
  tg.calls.length = 0;
  const long = ['🟩 Lucas bought 1.56 USOIL.cash @ 94.836', ...Array.from({ length: 30 }, (_, i) => `Line ${i}: ${Array(6).fill('reason').join(' ')}`)].join('\n');
  n.notify({ kind: 'trade', text: long, photo: png });
  await new Promise((r) => setTimeout(r, 30));
  assert.deepEqual(tg.calls.map((c) => c.method), ['sendPhoto', 'sendMessage']);
  assert.ok(tg.calls[0].body.caption.length <= 1024);
  assert.equal(tg.calls[0].body.caption + '\n' + tg.calls[1].body.text, long);

  // The photo is refused: the words still arrive.
  const b = await setUp({ photoStatus: 400 });
  b.n.notify({ kind: 'trade', text: '🟥 Mia sold 0.2 XAUUSD', photo: png });
  await new Promise((r) => setTimeout(r, 30));
  assert.deepEqual(b.tg.calls.map((c) => c.method), ['sendPhoto', 'sendMessage']);
  assert.equal(b.tg.calls[1].body.text, '🟥 Mia sold 0.2 XAUUSD');
});

test('the entry chart: the setup drawn TradingView style, with entry, stop, target and the desk\'s levels', async () => {
  const { chartSvg, entryChart } = await import('../server/notify/chartShot.js');
  const bars = Array.from({ length: 150 }, (_, i) => ({ time: 1790832000 + i * 60, open: 100 + Math.sin(i / 9), high: 100.6 + Math.sin(i / 9), low: 99.4 + Math.sin(i / 9), close: 100.2 + Math.sin(i / 9) }));
  const spec = {
    symbol: 'XAUUSD', brokerSymbol: 'XAUUSD', decimals: 2, side: 'BUY', entry: 100.5, stop: 99.5, target: 103, bars,
    title: 'Ryan · BUY 0.48 XAUUSD @ 100.50', subtitle: 'Scalping · Gold London · 1-minute · grade A · risk $17.52',
    stopLabel: 'Stop 99.50 · −$17.52', targetLabel: 'Target 103.00 · +$43.80 · 2.5R',
    levels: [{ label: 'Asia low', price: 98.9 }, { label: 'Far away', price: 500 }], context: [{ label: 'VWAP', price: 100.9 }],
    when: '1 Oct 2026 · 10:14', footer: 'Drawn by the floor from your MT5 prices', timeZone: 'UTC',
  };
  const svg = chartSvg(spec);
  assert.match(svg, /^<svg xmlns="http:\/\/www\.w3\.org\/2000\/svg" width="1200" height="675"/);
  assert.equal((svg.match(/<rect x="[\d.]+" y="[\d.]+" width="[\d.]+" height="[\d.]+" fill="#(089981|f23645)"\/>/g) || []).length, 120, 'the last 120 candles');
  for (const text of ['Ryan · BUY 0.48 XAUUSD @ 100.50', 'Stop 99.50 · −$17.52', 'Target 103.00 · +$43.80 · 2.5R', 'Buy 100.50', 'Asia low 98.90', 'VWAP 100.90', 'Meridian Capital']) assert.ok(svg.includes(text), text);
  assert.ok(!svg.includes('Far away'), 'levels far from the action stay off the chart');
  assert.ok(svg.includes('rgba(8,153,129,0.20)') && svg.includes('rgba(242,54,69,0.20)'), 'the position tool: profit and risk zones');
  const escaped = chartSvg({ ...spec, title: 'A & B <script>' });
  assert.ok(escaped.includes('A &amp; B &lt;script&gt;') && !escaped.includes('<script>'), 'text is escaped');
  const { png } = await entryChart(spec);
  if (png) assert.deepEqual([...png.subarray(0, 4)], [0x89, 0x50, 0x4e, 0x47], 'a PNG');
});
