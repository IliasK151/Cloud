import { test } from 'node:test';
import assert from 'node:assert/strict';

import { SEATS, ROSTER, publicProfile } from '../server/engine/roster.js';
import { Structure, TopDownBook, nyMinute, tradingDayOf } from '../server/engine/topdown.js';
import { DayPlaybook, PLAYBOOK, killzoneAt, zonesText } from '../server/engine/daytrade.js';
import { DayTrader } from '../server/engine/strategies/dayTrader.js';
import { TraderAgent } from '../server/engine/agent.js';
import { MarketData } from '../server/market/marketData.js';
import { Session, nyWallToMs } from '../server/market/session.js';
import { Broker } from '../server/engine/broker.js';
import { RiskManager } from '../server/engine/risk.js';
import { departmentFor } from '../server/brain/committee.js';
import { styleKey } from '../server/brain/personas.js';
import { AccountBrain, LIMITS } from '../server/live/accountBrain.js';
import { skipCategory } from '../server/live/dailyReport.js';
import { config } from '../server/config.js';

// New York wall time → seconds.
const sec = (day, h, m) => Math.floor(nyWallToMs(2026, 10, day, h, m) / 1000);
const bar = (time, o, h, l, c) => ({ time, open: o, high: h, low: l, close: c, volume: 100 });

test('the day trading desk: five TJR-style day traders take the scalpers\' place, every seat keeps its magic number', () => {
  const first = ['marcus', 'sofia', 'kenji', 'amara', 'viktor', 'isabella', 'james', 'priya', 'lucas', 'chen', 'elena', 'arjun', 'hannah', 'omar', 'mei'];
  // A desk's place in SEATS is its MT5 magic number: the old desks keep theirs, the retired
  // scalpers keep their seats (16–20), the day traders come after them.
  assert.deepEqual(SEATS.slice(0, 15).map((p) => p.id), first);
  assert.deepEqual(SEATS.slice(15, 20).map((p) => p.id), ['jake', 'layla', 'ryan', 'mia', 'nico']);
  assert.ok(SEATS.slice(15, 20).every((p) => p.retired && !p.Strategy), 'no scalping any more');
  const day = SEATS.slice(20);
  assert.deepEqual(day.map((p) => p.id), ['tyler', 'sienna', 'theo', 'zara', 'diego']);
  assert.deepEqual(day.map((p) => p.symbols[0]), ['NAS100', 'SPX500', 'XAUUSD', 'EURUSD', 'USOIL']);
  // On the floor: the twenty active desks, no retired ones.
  assert.equal(ROSTER.length, 20);
  assert.ok(!ROSTER.some((p) => p.retired));
  for (const p of day) {
    assert.equal(p.Strategy, DayTrader, p.id);
    assert.ok(p.dayTrader, p.id);
    assert.ok(killzoneAt(p.rules.zones, 8 * 60), `${p.id} trades the New York open`);
    assert.equal(styleKey(p.id), 'daytrader');
    assert.ok(departmentFor(p.symbols[0])?.members.includes(p.id), `${p.id} sits in its market's department`);
    assert.ok(!p.weekendSymbol, 'the playbook was tested on its own markets, not weekend crypto');
  }
  // The FTMO tab says when each one trades.
  assert.equal(publicProfile(day[0]).sessions, 'New York open 07:00–11:00');
  assert.equal(publicProfile(day[2]).sessions, 'London open 02:00–05:00, New York open 07:00–11:00');
  assert.equal(zonesText('demo'), 'Demo session open 09:30–12:00');
});

test('market structure on candle bodies: break of structure, then a close through the higher low shifts the trend', () => {
  const st = new Structure(2);
  const candles = [];
  let seq = 0;
  const add = (o, c) => {
    candles.push({ seq: ++seq, time: seq, open: o, close: c, high: Math.max(o, c) + 0.2, low: Math.min(o, c) - 0.2 });
    st.update(candles);
  };
  // Up, a pullback, up through the swing high: a bullish break of structure.
  for (const [o, c] of [[10, 11], [11, 12], [12, 13], [13, 14], [14, 13.5], [13.5, 13], [13, 12.5], [12.5, 12.8], [12.8, 13.2], [13.2, 14.5]]) add(o, c);
  assert.equal(st.trend, 'bull');
  assert.equal(st.last.kind, 'shift', 'the first break sets the trend');
  assert.equal(st.protLow, 12.5, 'the higher low: the pullback\'s lowest body');
  // Higher again, then a pullback that holds the higher low: still bullish.
  for (const [o, c] of [[14.5, 15], [15, 15.5], [15.5, 15], [15, 14.6], [14.6, 14.4], [14.4, 14.7], [14.7, 15.8]]) add(o, c);
  assert.equal(st.trend, 'bull');
  assert.equal(st.last.kind, 'bos');
  assert.ok(st.protLow > 12.5, `the higher low moved up (${st.protLow})`);
  const higherLow = st.protLow;
  assert.deepEqual(st.range(), { lo: higherLow, hi: st.extHigh });
  // A wick below the higher low changes nothing; a close below it does.
  add(15.8, 15.2);
  candles.at(-1).low = higherLow - 1;
  assert.equal(st.trend, 'bull');
  add(15.2, higherLow - 0.1);
  assert.equal(st.trend, 'bear');
  assert.equal(st.last.kind, 'shift');
  assert.equal(st.protHigh, st.range().hi);
});

// Days of 1-minute bars that trend up, with weekly, daily and intraday pullbacks.
function trendingBook({ days = 120, slope = 0.0015, symbol = 'NAS100' } = {}) {
  const book = new TopDownBook(symbol);
  const t0 = sec(1, 18, 0) - days * 86_400;
  let px = 100;
  for (let i = 0; i < days * 1440; i++) {
    const t = t0 + i * 60;
    const k = i / 1440;
    const next = 100 + slope * i + 20 * Math.sin((2 * Math.PI * k) / 30) + 6 * Math.sin((2 * Math.PI * k) / 5) + 0.8 * Math.sin((2 * Math.PI * k) / 0.9);
    book.feed(bar(t, px, Math.max(px, next) + 0.05, Math.min(px, next) - 0.05, next));
    px = next;
  }
  return book;
}

test('the top-down book: a market trending up on the daily and weekly reads as a bullish bias', () => {
  const book = trendingBook();
  const r = book.read();
  assert.equal(r.ready, true, r.text);
  assert.equal(r.bias, 'LONG');
  assert.equal(r.tfs.D.trend, 'bull');
  assert.equal(r.tfs.W.trend, 'bull');
  assert.match(r.text, /^W ↑ · D ↑ · 4H [↑↓]: bullish bias/);
  assert.ok(r.atrD > 0);
  // Its AOIs sit inside the daily range, in its lower half, above the higher low.
  for (const a of r.aois) {
    const range = r.tfs[a.tf].range;
    assert.ok(a.lo >= range.lo - 1e-9 && a.level <= (range.lo + range.hi) / 2 + 1e-9, JSON.stringify(a));
  }
  // The read is cheap: the same object until the next bar.
  assert.equal(book.read(), r);
  // The 18:00 New York roll and New York minutes.
  assert.equal(tradingDayOf(nyWallToMs(2026, 10, 14, 18, 0)), '2026-10-15');
  assert.equal(tradingDayOf(nyWallToMs(2026, 10, 14, 17, 59)), '2026-10-14');
  assert.equal(nyMinute(nyWallToMs(2026, 10, 14, 9, 30)), 570);
});

// A book whose higher timeframes say `bias`, with the real 5-minute candles and session
// liquidity of the bars it is fed (the playbook's part is what's under test).
function biasedBook(bias, symbol = 'XAUUSD') {
  const book = new TopDownBook(symbol);
  const read = book.read.bind(book);
  const trend = bias === 'LONG' ? 'bull' : 'bear';
  const arrow = bias === 'LONG' ? '↑' : '↓';
  book.read = () => ({
    ...read(), ready: true, bias, strength: 3, of: 3, short: `W ${arrow} · D ${arrow} · 4H ${arrow}`,
    text: `W ${arrow} · D ${arrow} · 4H ${arrow}: ${bias === 'LONG' ? 'bullish' : 'bearish'} bias, every timeframe agrees`,
    tfs: { W: { trend, range: null }, D: { trend, range: null }, H4: { trend, range: null } },
  });
  return book;
}

// One trading day of gold (14 Oct 2026, New York time): yesterday's range, a quiet Asia between
// 2400 and 2404, then in the London open a run through the Asia low that turns into a
// 5-minute break of structure with a fair value gap.
function goldDay({ deep = false } = {}) {
  const bars = [];
  // Yesterday: 2390–2420, so its high and low are well away.
  for (let t = sec(13, 8, 0); t < sec(13, 17, 0); t += 60) {
    const k = (t - sec(13, 8, 0)) / 60;
    const mid = 2405 + 15 * Math.sin(k / 80);
    bars.push(bar(t, mid, mid + 0.3, mid - 0.3, mid + 0.1));
  }
  // Asia (18:00 → 02:00): 2401–2403 with the session's low at 2400 and high at 2404.
  for (let t = sec(13, 18, 0); t < sec(14, 2, 0); t += 60) {
    const k = (t - sec(13, 18, 0)) / 60;
    const mid = 2402 + Math.sin(k / 30);
    bars.push(bar(t, mid - 0.1, k === 100 ? 2404 : mid + 0.3, k === 300 ? 2400 : mid - 0.3, mid + 0.1));
  }
  // London: quiet at 2401.5–2402.5 with a small push at 02:10 (the swing that led into the run).
  for (let t = sec(14, 2, 0); t < sec(14, 2, 30); t += 60) {
    const m = (t - sec(14, 2, 0)) / 60;
    const up = m >= 10 && m < 15 ? 0.6 : 0;
    bars.push(bar(t, 2401.8 + up, 2402.3 + up, 2401.5 + up, 2402 + up));
  }
  const low = deep ? 2370 : 2398.6; // deep: through the Asia low and yesterday's low, and on
  // 02:30–02:34 down through the Asia low; 02:35–02:39 the extreme; then the displacement.
  const leg = [
    // 02:30–02:34 down through the Asia low, 02:35–02:39 the run's extreme.
    [2402, 2402.1, 2400.5, 2400.6], [2400.6, 2400.7, 2399.6, 2399.7], [2399.7, 2399.8, 2399.2, 2399.3], [2399.3, 2399.4, 2399, 2399.1], [2399.1, 2399.2, 2398.9, 2399],
    [2399, 2399.1, low, 2399], [2399, 2399.2, 2398.8, 2399.1], [2399.1, 2399.3, 2399, 2399.2], [2399.2, 2399.4, 2399.1, 2399.3], [2399.3, 2399.5, 2399.2, 2399.4],
    // 02:40–02:44 back up, still under the swing that started the run (2402).
    [2399.4, 2399.9, 2399.4, 2399.8], [2399.8, 2400.3, 2399.7, 2400.2], [2400.2, 2400.6, 2400.1, 2400.5], [2400.5, 2400.9, 2400.4, 2400.8], [2400.8, 2401.1, 2400.7, 2401],
    // 02:45–02:49 the displacement: a strong candle closes above 2402, its low over the
    // extreme candle's high (a fair value gap from 2399.5 to 2400.9).
    [2401, 2401.6, 2400.9, 2401.5], [2401.5, 2402.1, 2401.4, 2402], [2402, 2402.5, 2401.9, 2402.4], [2402.4, 2402.8, 2402.3, 2402.7], [2402.7, 2403.1, 2402.6, 2403],
    [2403, 2403.3, 2402.8, 2403.2], [2403.2, 2403.4, 2403, 2403.3],
  ];
  leg.forEach(([o, h, l, c], i) => bars.push(bar(sec(14, 2, 30) + i * 60, o, h, l, c)));
  return bars;
}

test('the playbook: bullish bias, the Asia low swept in the London open, a 5-minute shift with a gap: a buy on the pullback, 3R or more', () => {
  const book = biasedBook('LONG');
  const pb = new DayPlaybook({ zones: 'london,ny' });
  let order = null;
  for (const b of goldDay()) {
    book.feed(b);
    order = pb.onBar(book, b) || order;
  }
  assert.ok(order, pb.why);
  assert.equal(order.side, 'LONG');
  assert.equal(order.swept, 'Asia low');
  assert.equal(order.zone, 'london');
  assert.equal(order.market, false, 'a limit back in the fair value gap');
  assert.ok(order.stop < 2398.6, `stop beyond the sweep (${order.stop})`);
  assert.equal(order.entry, 2400.9, 'entry at the top of the fair value gap');
  assert.equal(order.targetLabel, 'Previous day high', 'the target is the liquidity on the other side');
  assert.ok(order.rr >= PLAYBOOK.minRR - 1e-9 && (order.target - order.entry) / (order.entry - order.stop) >= 3 - 1e-9, `3R or more (${order.rr})`);
  assert.match(order.reason, /bullish bias · London open: swept the Asia low, 5-minute shift with displacement; target the previous day high \(\d+\.\dR\)$/);
  assert.equal(pb.stats.sweeps, 1);
  assert.equal(pb.stats.orders, 1);
  // Price comes back to the entry: filled. Running back through the sweep first would cancel it.
  assert.equal(pb.touch(order.entry + 0.5), null);
  assert.equal(pb.touch(order.entry).kind, 'fill');
  pb.filled();
  assert.equal(pb.trades, 1);
});

test('the playbook stays out: a bearish bias doesn\'t buy a swept low, a run that keeps going is a breakdown', () => {
  const bear = biasedBook('SHORT');
  const pb = new DayPlaybook({ zones: 'london,ny' });
  for (const b of goldDay()) {
    bear.feed(b);
    assert.equal(pb.onBar(bear, b), null);
  }
  assert.equal(pb.stats.orders, 0);
  const book = biasedBook('LONG');
  const deep = new DayPlaybook({ zones: 'london,ny' });
  for (const b of goldDay({ deep: true })) {
    book.feed(b);
    assert.equal(deep.onBar(book, b), null);
  }
  assert.equal(deep.stats.deep, 1, 'too far through the level: not a sweep');
  // Outside its killzones it doesn't trade: the same day for a New York-only desk.
  const ny = new DayPlaybook({ zones: 'ny' });
  const b2 = biasedBook('LONG');
  const said = new Set();
  for (const b of goldDay()) {
    b2.feed(b);
    assert.equal(ny.onBar(b2, b), null);
    said.add(ny.why);
  }
  assert.equal(ny.stats.outside, 1);
  assert.ok([...said].includes('Price swept the Asia low and shifted, outside the killzones: no trade'), [...said].join('\n'));
});

// A live-mode desk on its own market with a hand-made top-down read.
function deskEnv(profile, book) {
  const clock = { mode: 'live', speed: 1, t: 0, now() { return this.t; } };
  const md = new MarketData(clock);
  const session = new Session(clock);
  const broker = new Broker(md, clock);
  const risk = new RiskManager(config.risk, session);
  const notes = [];
  const env = { md, clock, session, broker, risk, news: null, committee: null, allocation: 5_000_000, emit: (e) => notes.push(e), topDown: (s) => (s === profile.symbols[0] ? book : null) };
  return { env, md, clock, broker, notes };
}

test('a day trader on the floor: waits for the pullback, takes it with its stop and 3R+ target, then is done for the day', () => {
  const theo = ROSTER.find((p) => p.id === 'theo');
  const book = biasedBook('LONG');
  const { env, md, clock, notes } = deskEnv(theo, book);
  const agent = new DayTrader(theo, env);
  const seen = [];
  for (const b of goldDay()) {
    seen.push(b);
    md.seed('XAUUSD', seen.slice(-900));
    clock.t = (b.time + 60) * 1000;
    agent.onBar('XAUUSD', b);
  }
  const p = agent.pb.pending;
  assert.ok(p, agent.setup.stage);
  assert.ok(notes.some((n) => /^Buy setup on XAUUSD: .*Waiting for the pullback/.test(n.text)), 'it says what it waits for');
  assert.match(agent.setup.stage, /^Waiting for the pullback to /);
  assert.match(agent.setup.topDown, /bullish bias/);
  assert.ok(agent.setup.checklist.slice(0, 5).every((c) => c.ok), JSON.stringify(agent.setup.checklist));
  assert.match(agent.pitch(), /I have a buy setup on XAUUSD/);
  // The pullback fills it: no partial at 1R, no trailing; stop and target as planned.
  md.applyTick('XAUUSD', p.entry, 1, clock.t);
  agent.onTick('XAUUSD', p.entry);
  const plan = agent.plan;
  assert.ok(plan, agent.lastReject);
  assert.equal(plan.side, 'LONG');
  assert.equal(plan.partialAt, 0);
  assert.equal(plan.trail, null);
  assert.ok(Math.abs(plan.stop - p.stop) < 1e-9 && Math.abs(plan.target - p.target) < 1e-9);
  assert.equal(agent.pb.trades, 1);
  assert.match(agent.setup.stage, /In a long day trade/);
});

test('top-down first: every desk trades with its market\'s bias, never against it (your own alerts are your call)', () => {
  const marcus = ROSTER.find((p) => p.id === 'marcus');
  const read = { ready: true, bias: 'SHORT', strength: 2, of: 3, short: 'W ↓ · D ↓ · 4H ↑', text: 'W ↓ · D ↓ · 4H ↑: bearish bias', tfs: {} };
  const book = { read: () => read };
  const { env, md, clock } = deskEnv(marcus, book);
  const agent = new TraderAgent(marcus, env);
  clock.t = Date.UTC(2026, 9, 14, 15, 0);
  md.seed('NAS100', Array.from({ length: 60 }, (_, i) => bar(clock.t / 1000 - (60 - i) * 60, 20000, 20005, 19995, 20000)));
  md.applyTick('NAS100', 20000, 1, clock.t);
  assert.equal(agent.openTrade({ side: 'LONG', stop: 19950, target: 20100, reason: 'opening range breakout' }), false);
  assert.match(agent.lastReject, /^against the top-down read: W ↓ · D ↓ · 4H ↑: the higher timeframes are bearish, so no buys/);
  assert.match(agent.day.whyNot.text, /not taken, against the top-down read/);
  assert.equal(skipCategory(agent.day.whyNot.text), 'Against the top-down bias');
  assert.equal(agent.topDownView().text, read.text);
  assert.match(agent.briefing().text, /My top-down: weekly down, daily down, 4-hour up, so I only take sells on NAS100 right now\./);
  // With the bias: taken.
  assert.equal(agent.openTrade({ side: 'SHORT', stop: 20050, target: 19900, reason: 'opening range breakdown' }), true);
  agent.flatten('test');
  // Your own TradingView alert isn't held back by it.
  assert.equal(agent.openTrade({ side: 'LONG', stop: 19950, target: 20100, reason: 'TradingView alert', tag: 'TV' }), true);
  agent.flatten('test');
  // No read yet (too little history): nothing to go by, so nothing is held back.
  read.ready = false;
  assert.equal(agent.againstTopDown('NAS100', 'LONG'), null);
});

test('no pile-ups on the account: one desk per market, one per correlated group, at most three at once', () => {
  const names = { marcus: 'Marcus', tyler: 'Tyler', zara: 'Zara', theo: 'Theo', diego: 'Diego' };
  const live = (links) => ({
    links: new Map(links.map((l, i) => [String(i), { login: 1, state: 'open', ...l }])), login: 1,
    profile: {}, fund: { byId: new Map(Object.entries(names).map(([id, firstName]) => [id, { firstName }])) },
  });
  const crowd = (links, symbol) => new AccountBrain(live(links)).crowd({ symbol, qty: 1 });
  assert.equal(crowd([], 'NAS100'), null);
  assert.equal(crowd([{ agentId: 'marcus', floorSymbol: 'NAS100' }], 'NAS100'), 'one desk per market: Marcus already has a NAS100 trade on the account');
  assert.match(crowd([{ agentId: 'tyler', floorSymbol: 'NAS100' }], 'SPX500'), /^one trade per correlated group: Tyler's NAS100 trade is already on, and the US indices move together/);
  assert.match(crowd([{ agentId: 'zara', floorSymbol: 'EURUSD' }], 'GBPUSD'), /the FX pairs move together/);
  const three = [{ agentId: 'tyler', floorSymbol: 'NAS100' }, { agentId: 'zara', floorSymbol: 'EURUSD' }, { agentId: 'theo', floorSymbol: 'XAUUSD' }];
  const full = crowd(three, 'USOIL');
  assert.match(full, /^3 trades already open on the account, the most at once \(3\)/);
  assert.equal(LIMITS.together, 3);
  // Closed trades and ones from an earlier session don't count.
  assert.equal(crowd([{ agentId: 'tyler', floorSymbol: 'NAS100', state: 'closed' }, { agentId: 'zara', floorSymbol: 'EURUSD', previousSession: true }], 'SPX500'), null);
  assert.equal(skipCategory('one desk per market: Marcus already has a NAS100 trade on the account'), 'Another desk is in that market');
  assert.equal(skipCategory(full), 'Enough trades open at once');
  assert.equal(skipCategory(crowd([{ agentId: 'tyler', floorSymbol: 'NAS100' }], 'SPX500')), 'Correlated position already open');
});
