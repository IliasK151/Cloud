import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { FloorMemory, situationKey } from '../server/brain/memory.js';
import { Committee } from '../server/brain/committee.js';
import { MarketClock, Session } from '../server/market/session.js';
import { MarketData } from '../server/market/marketData.js';
import { Broker } from '../server/engine/broker.js';
import { RiskManager } from '../server/engine/risk.js';
import { Fund } from '../server/engine/fund.js';
import { config } from '../server/config.js';

const CTX = { trend: 'with', vol: 'wild', session: 'london', side: 'LONG' };

function floor(memory) {
  const clock = new MarketClock('sim', 1);
  const session = new Session(clock);
  const md = new MarketData(clock);
  const broker = new Broker(md, clock);
  const risk = new RiskManager(config.risk, session);
  const fund = new Fund({ config: { ...config, feed: 'sim' }, md, clock, session, broker, risk, committee: 'off', memory });
  return fund;
}

function stubBrain(v = 0.3) {
  const f = (text) => ({ value: v, text });
  const read = { regime: { key: 'range', label: 'Ranging' }, news: null, volPct: 0.5, price: 100 };
  return {
    read: () => read,
    assess: (symbol, side, { entry = 100, stop = 99, target = 102 } = {}) => ({
      read, symbol, side, dir: 1, entry, stop, target, risk: 1, rr: 2, roomR: 2, ahead: null,
      f: { htf: f('htf'), trend: f('trend'), structure: f('structure'), momentum: f('momentum'), stretch: f('stretch'), location: f('location'), room: f('room'), volatility: f('vol'), news: f('news') },
    }),
  };
}

test('the floor memory files every real-price trade by situation, and speaks once it has seen enough', () => {
  const mem = new FloorMemory({ mode: 'live' });
  const amara = { id: 'amara' };
  const ryan = { id: 'ryan' };
  const events = [];
  mem.on('event', (e) => events.push(e));
  assert.equal(mem.recall('XAUUSD', CTX).ready, false, 'nothing yet');
  for (let i = 0; i < 4; i++) mem.onTrade(amara, { symbol: 'XAUUSD', r: 1.2 }, CTX);
  // A trade decided on a simulated stand-in feed teaches nothing about the real market.
  mem.onTrade(ryan, { symbol: 'XAUUSD', r: -5, simFeed: true }, CTX);
  let r = mem.recall('XAUUSD', CTX);
  assert.equal(r.trades, 4);
  assert.equal(r.ready, false, 'four trades are not enough evidence');
  for (let i = 0; i < 4; i++) mem.onTrade(ryan, { symbol: 'XAUUSD', r: 0.8 }, CTX);
  r = mem.recall('XAUUSD', CTX);
  assert.equal(r.trades, 8);
  assert.equal(r.ready, true);
  assert.ok(r.value > 0.5, `a clearly good situation (${r.value})`);
  assert.match(r.text, /the floor's memory: 8 trades like this \(XAUUSD, with the trend, wild, London\) averaged \+\d\.\d\dR, 100% won/);
  // The same market in another situation is another memory.
  assert.equal(mem.recall('XAUUSD', { ...CTX, trend: 'against' }).ready, false);
  assert.equal(events.filter((e) => e.kind === 'trade').length, 8);
  assert.equal(events[0].key, situationKey('XAUUSD', CTX));

  // Recent trades count more: a run of losers turns it around.
  for (let i = 0; i < 20; i++) mem.onTrade(amara, { symbol: 'XAUUSD', r: -1 }, CTX);
  assert.ok(mem.recall('XAUUSD', CTX).value < 0);
});

test('the knowledge graph: desks, markets, situations, lessons and who reviews whom', () => {
  const mem = new FloorMemory();
  const fund = floor(mem);
  const amara = fund.byId.get('amara');
  for (let i = 0; i < 7; i++) mem.onTrade(amara, { symbol: 'XAUUSD', r: 0.5 }, CTX);
  mem.onLesson(amara, { id: 'l1', title: 'Sit out wild markets in Asia', time: 1, status: 'active' });
  mem.onDebate({ proposer: 'amara', symbol: 'XAUUSD', verdict: 'APPROVED', grade: 'A', messages: [{ from: 'amara', role: 'proposes' }, { from: 'lucas', role: 'reviews', stance: 'agree' }, { from: 'omar', role: 'reviews', stance: 'disagree' }] });
  const g = mem.graph(fund.agents);
  const ids = new Set(g.nodes.map((n) => n.id));
  assert.equal(g.nodes.filter((n) => n.type === 'desk').length, fund.agents.length);
  assert.ok(ids.has('mkt:XAUUSD') && ids.has('mkt:NAS100'));
  const sit = g.nodes.find((n) => n.type === 'situation');
  assert.equal(sit.id, `sit:${situationKey('XAUUSD', CTX)}`);
  assert.equal(sit.trades, 7);
  assert.equal(sit.ready, true);
  assert.ok(g.links.some((l) => l.kind === 'took' && l.s === 'desk:amara' && l.t === sit.id && l.trades === 7));
  assert.ok(g.links.some((l) => l.kind === 'of' && l.s === sit.id && l.t === 'mkt:XAUUSD'));
  assert.ok(g.links.some((l) => l.kind === 'learned' && l.s === 'lesson:l1' && l.t === 'desk:amara'));
  assert.ok(g.links.some((l) => l.kind === 'reviews' && l.s === 'desk:lucas' && l.t === 'desk:amara' && l.agree === 1));
  assert.ok(g.links.some((l) => l.kind === 'correlated' && [l.s, l.t].sort().join() === 'mkt:NAS100,mkt:SPX500'));
  assert.deepEqual(g.stats, { trades: 7, situations: 1, ready: 1, lessons: 1, reviews: 2 });
  assert.equal(g.strongest[0].id, sit.id);
  assert.deepEqual(g.events.map((e) => e.kind).slice(-2), ['lesson', 'debate']);
});

test('a desk\'s closed trade and its lessons reach the floor memory', () => {
  const mem = new FloorMemory();
  const fund = floor(mem);
  const marcus = fund.byId.get('marcus');
  marcus.learner.open.set('t1', { ctx: CTX, plan: { side: 'LONG', entry: 100, risk: 1, extreme: 101, worst: 99.5, barsHeld: 10, symbol: 'NAS100' } });
  marcus.onTradeClosed({ id: 't1', symbol: 'NAS100', pnl: 500, r: 1.5, exitReason: 'Target' });
  const r = mem.recall('NAS100', CTX);
  assert.equal(r.trades, 1);
  assert.equal(mem.graph(fund.agents).links.find((l) => l.kind === 'took').s, 'desk:marcus');
});

test('the committee weighs the floor memory, but only once it has seen enough trades like this', () => {
  const mem = new FloorMemory();
  const fund = floor(null);
  const marcus = fund.byId.get('marcus');
  const committee = new Committee({ brain: stubBrain(0.3), agents: fund.byId, clock: fund.clock, memory: mem });
  const ctx = marcus.learner.context('NAS100', 'LONG');
  const idea = { agent: marcus, symbol: 'NAS100', side: 'LONG', entry: 100, stop: 99, target: 102, reason: 'ORB' };
  const before = committee.review(idea);
  assert.equal(before.debate.factors.memory, null, 'no memory yet: it stays out of the vote');

  // Ten losing trades like this one across the floor: the committee likes the idea less.
  for (let i = 0; i < 10; i++) mem.onTrade({ id: 'james' }, { symbol: 'NAS100', r: -1 }, ctx);
  const after = new Committee({ brain: stubBrain(0.3), agents: fund.byId, clock: fund.clock, memory: mem }).review(idea);
  assert.ok(after.debate.factors.memory.value < 0);
  assert.match(after.debate.factors.memory.text, /the floor's memory: 10 trades like this/);
  assert.ok(after.score < before.score, `${after.score} < ${before.score}`);
  assert.ok(after.debate.messages.some((m) => /floor's memory/.test(m.text)), 'someone brings it up in the debate');
});

test('the memory is kept on disk, and starts from what the desks already remember', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'memory-'));
  const file = path.join(dir, 'memory.json');
  const fund = floor(null);
  const lucas = fund.byId.get('lucas');
  lucas.learner.state.journal = [{ t: 1, ctx: CTX, r: 0.4 }, { t: 2, ctx: CTX, r: -0.2 }, { t: 3, ctx: { ...CTX, vol: 'quiet' }, r: 1 }];
  fund.byId.get('elena').learner.state.journal = [{ t: 1, ctx: CTX, r: 2 }]; // research desks move markets: left out
  const a = new FloorMemory({ file });
  assert.equal(a.seedFromJournals(fund.agents), 3);
  assert.equal(a.seedFromJournals(fund.agents), 0, 'only once');
  a.flush();
  const b = new FloorMemory({ file });
  assert.equal(b.recall('USOIL', CTX).trades, 2);
  assert.equal(b.recall('USOIL', { ...CTX, vol: 'quiet' }).trades, 1);
  assert.equal(fs.statSync(file).mode & 0o777, 0o600);
});
