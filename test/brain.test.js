import { test } from 'node:test';
import assert from 'node:assert/strict';

import { MarketBrain } from '../server/brain/market.js';
import { Committee, DEPARTMENTS, departmentFor } from '../server/brain/committee.js';
import { opinion, FACTORS } from '../server/brain/personas.js';
import { AccountBrain } from '../server/live/accountBrain.js';
import { normalizeProfile } from '../server/live/rules.js';
import { MarketClock, Session, nyWallToMs } from '../server/market/session.js';
import { MarketData } from '../server/market/marketData.js';
import { Broker } from '../server/engine/broker.js';
import { RiskManager } from '../server/engine/risk.js';
import { Fund } from '../server/engine/fund.js';
import { config } from '../server/config.js';
import { runBacktest } from '../scripts/backtest.js';

// A market read we control completely: every factor at `v` (in the trade's favour).
function stubBrain({ v = 0.5, news = null, volPct = 0.5, rr = 2 } = {}) {
  const f = (text) => ({ value: v, text });
  const read = { regime: { key: 'range', label: 'Ranging' }, news, volPct, price: 100 };
  return {
    read: () => read,
    assess: (symbol, side, { entry = 100, stop = 99, target = 102 } = {}) => ({
      read, symbol, side, dir: side === 'LONG' ? 1 : -1, entry, stop, target, risk: 1, rr: target != null ? rr : null, roomR: 2, ahead: null,
      f: {
        htf: f('the higher-timeframe trend is with it'), trend: f('the 15-minute trend agrees'), structure: f('structure agrees'),
        momentum: f('momentum agrees'), stretch: f('good location'), location: f('support behind'), room: f('room to run'),
        volatility: f('volatility is normal'), news: f('no news'),
      },
    }),
  };
}

function floor(committeeMode = 'on') {
  const clock = new MarketClock('sim', 1);
  const session = new Session(clock);
  const md = new MarketData(clock);
  const broker = new Broker(md, clock);
  const risk = new RiskManager(config.risk, session);
  const fund = new Fund({ config: { ...config, feed: 'sim' }, md, clock, session, broker, risk, committee: committeeMode });
  return { fund, clock, md, session };
}

test('every market is covered by a department of at least two agents that debate it', () => {
  for (const d of DEPARTMENTS) assert.ok(d.members.length >= 2, d.name);
  for (const s of ['NAS100', 'SPX500', 'XAUUSD', 'USOIL', 'EURUSD', 'USDJPY', 'BTCUSD', 'ETHUSD', 'SOLUSD']) assert.ok(departmentFor(s), s);
});

test('agents have their own brains: the same evidence gets different opinions', () => {
  const chasingInTrend = { htf: { value: 0.9, text: 'trend up' }, trend: { value: 0.9, text: '15m up' }, structure: { value: 1, text: 'HH/HL' }, momentum: { value: 0.8, text: 'strong' }, stretch: { value: -1, text: '2.8σ above VWAP, chasing' }, location: { value: -0.3, text: 'nothing behind' } };
  const trend = opinion('marcus', chasingInTrend);
  const reverter = opinion('james', chasingInTrend);
  assert.ok(trend.score > reverter.score, 'the trend follower likes it more than the mean-reversion trader');
  assert.equal(trend.stance, 'agree');
  assert.notEqual(reverter.stance, 'agree');
  assert.ok(reverter.cons.some((c) => /chasing/.test(c.text)));
  assert.ok(FACTORS.includes('edge'));
});

test('the market brain reads a trending market', () => {
  const clock = new MarketClock('sim', 1);
  const session = new Session(clock);
  const md = new MarketData(clock);
  const start = Math.floor(nyWallToMs(2026, 10, 14, 9, 30) / 1000) - 800 * 60;
  const bars = [];
  let p = 24000;
  for (let i = 0; i < 800; i++) {
    const drift = 1.2 + 6 * Math.sin(i / 7);
    const o = p;
    p += drift;
    bars.push({ time: start + i * 60, open: o, high: Math.max(o, p) + 2, low: Math.min(o, p) - 2, close: p, volume: 100 });
  }
  md.seed('NAS100', bars);
  clock.t = (start + 800 * 60) * 1000;
  const brain = new MarketBrain({ md, session, clock });
  const r = brain.read('NAS100');
  assert.ok(r.mid.value > 0.3, `15m trend up (${r.mid.value})`);
  assert.ok(r.bias > 0);
  const long = brain.assess('NAS100', 'LONG', { entry: p, stop: p - 20, target: p + 50 });
  const short = brain.assess('NAS100', 'SHORT', { entry: p, stop: p + 20, target: p - 50 });
  assert.ok(long.f.trend.value > 0 && short.f.trend.value < 0);
  assert.equal(long.rr, 2.5);
  assert.match(short.f.trend.text, /fights/);
});

test('the committee debates every idea and grades it: A full size, weak ideas paper only', () => {
  const { fund } = floor('off');
  const marcus = fund.byId.get('marcus');
  const strong = new Committee({ brain: stubBrain({ v: 0.8 }), agents: fund.byId, clock: fund.clock });
  // A desk with a real, positive record.
  Object.assign(marcus.lifetime, { countR: 40, sumR: 12 });
  marcus.setup.confidence = 80;
  const a = strong.review({ agent: marcus, symbol: 'NAS100', side: 'LONG', entry: 100, stop: 99, target: 102, reason: 'Opening range breakout' });
  assert.equal(a.ok, true);
  assert.equal(a.grade, 'A');
  assert.equal(a.sizeMult, 1);
  const who = a.debate.messages.map((m) => m.from);
  assert.equal(who[0], 'marcus', 'the desk pitches first');
  assert.ok(who.includes('arjun') && who.includes('james'), 'its department reviews it');
  assert.equal(who.at(-1), 'elena', 'the head of research signs off on risk');
  assert.match(a.thesis, /Opening range breakout\. Why:/);

  // Same evidence, but the desk has been losing: the committee doesn't trust it with real money.
  Object.assign(marcus.lifetime, { countR: 40, sumR: -14 });
  const b = new Committee({ brain: stubBrain({ v: 0.1 }), agents: fund.byId, clock: fund.clock }).review({ agent: marcus, symbol: 'NAS100', side: 'LONG', entry: 100, stop: 99, target: 102, reason: 'ORB' });
  assert.equal(b.grade, 'C');
  assert.equal(b.sizeMult, 0.25, 'paper only, tiny, to keep measuring');
  assert.match(b.debate.messages.find((m) => m.from !== 'marcus').text, /record is −0\.35R per trade over 40 trades/);
});

test('hard vetoes: news, extreme or dead volatility, and a target smaller than the risk', () => {
  const { fund } = floor('off');
  const lucas = fund.byId.get('lucas');
  Object.assign(lucas.lifetime, { countR: 40, sumR: 12 });
  const cases = [
    [{ news: { label: 'US Crude Oil Inventories', impact: 'high', minutes: 20 } }, /Crude Oil Inventories is due in 20 minutes/],
    [{ volPct: 0.97 }, /volatility is extreme/],
    [{ volPct: 0.03 }, /dead quiet/],
    [{ rr: 0.6 }, /target is only 0\.6R/],
  ];
  for (const [opts, re] of cases) {
    const c = new Committee({ brain: stubBrain({ v: 0.9, ...opts }), agents: fund.byId, clock: fund.clock });
    const r = c.review({ agent: lucas, symbol: 'USOIL', side: 'LONG', entry: 100, stop: 99, target: 102, reason: 'pullback' });
    assert.equal(r.ok, false);
    assert.match(r.reason, re);
    assert.match(r.debate.messages.at(-1).text, /^Vetoed/);
    // Asking again straight away doesn't start a new debate.
    const again = c.review({ agent: lucas, symbol: 'USOIL', side: 'LONG', entry: 100, stop: 99, target: 102, reason: 'pullback' });
    assert.equal(again.silent, true);
    assert.equal(c.debates.length, 1);
  }
});

test('trades carry their thesis and grade, and rejected ideas are never traded', () => {
  const { fund, md } = floor('off');
  const c = new Committee({ brain: stubBrain({ v: 0.9, news: { label: 'US CPI m/m', impact: 'high', minutes: 10 } }), agents: fund.byId, clock: fund.clock });
  fund.env.committee = c;
  md.applyTick('NAS100', 100, 1, fund.clock.now());
  const marcus = fund.byId.get('marcus');
  assert.equal(marcus.openTrade({ side: 'LONG', stop: 99, target: 102, reason: 'ORB' }), false);
  assert.match(marcus.setup.stage, /Committee said no: US CPI m\/m is due in 10 minutes/);
  assert.equal(marcus.book.positions.size, 0);
  fund.env.committee = new Committee({ brain: stubBrain({ v: 0.9 }), agents: fund.byId, clock: fund.clock });
  Object.assign(marcus.lifetime, { countR: 40, sumR: 12 });
  assert.equal(marcus.openTrade({ side: 'LONG', stop: 99, target: 102, reason: 'ORB' }), true);
  const plan = marcus.plans.get('NAS100');
  assert.equal(plan.grade, 'A');
  assert.match(plan.thesis, /ORB\. Why:/);
  marcus.closeTrade('NAS100', 'test');
  const t = fund.broker.book('marcus').trades.at(-1);
  assert.equal(t.grade, 'A');
  assert.match(t.thesis, /Why:/);
});

// ---- the account brain ---------------------------------------------------------------------
function account({ size = 10_000, equity = 10_000, dayStart = 10_000, links = [], type = 'trial', profile = {} } = {}) {
  const p = { ...normalizeProfile({ type, size, ...profile }, {}), symbolMap: {} };
  const live = {
    login: '1', profile: p, account: { equity, balance: equity }, halt: null,
    bridge: { serverDay: '2026.10.14' },
    links: new Map(links.map((l, i) => [String(i), { login: '1', createdAt: Date.now(), ...l }])),
    metrics() {
      const targetEquity = p.targetPct ? size * (1 + p.targetPct / 100) : null;
      return { dayStartBalance: dayStart, targetEquity, profit: equity - size };
    },
  };
  return { brain: new AccountBrain(live), live };
}

test('account brain: normal risk when healthy, less in drawdown, and the $100 drawdown case', () => {
  const ok = account().brain.state();
  assert.equal(ok.status, 'NORMAL');
  assert.equal(ok.mult, 1);
  assert.match(ok.goal, /Pass: reach \+10%/);
  // $100 down on a $10,000 trial: risk trimmed a little, with the reason spelled out.
  const dd = account({ equity: 9_900, dayStart: 9_900 }).brain.state();
  assert.equal(dd.status, 'CAUTIOUS');
  assert.ok(dd.mult < 1 && dd.mult >= 0.75, `mult ${dd.mult}`);
  assert.match(dd.reasons[0], /[-−]\$100 from its start/);
  assert.ok(dd.riskPct < dd.baseRiskPct);
});

test('account brain: daily stop, losing streaks and the trade cap stop the day', () => {
  const day = account({ equity: 9_840, dayStart: 10_000 }).brain.state();
  assert.equal(day.status, 'STOPPED FOR TODAY');
  assert.match(day.blocked, /Daily stop/);
  const loss = (i) => ({ state: 'closed', pnl: -30, closedAt: Date.now() - (5 - i) * 60_000, closedDay: '2026.10.14', openedDay: '2026.10.14' });
  const two = account({ links: [loss(1), loss(2)] }).brain.state();
  assert.equal(two.streak, 2);
  assert.ok(two.reasons.some((r) => /2 losses in a row: half risk/.test(r)));
  const three = account({ links: [loss(1), loss(2), loss(3)] }).brain.state();
  assert.match(three.blocked, /3 losses in a row/);
  const busy = account({ links: Array.from({ length: 6 }, () => ({ state: 'closed', pnl: 10, closedAt: Date.now(), closedDay: '2026.10.14', openedDay: '2026.10.14' })) }).brain.state();
  assert.match(busy.blocked, /6 trades today/);
});

test('account brain: only proven desks, A-grade, one position per correlated group', () => {
  const { fund } = floor('on');
  const marcus = fund.byId.get('marcus');
  const pos = { symbol: 'NAS100', qty: 1 };
  const { brain } = account();
  assert.match(brain.allow(marcus, pos, { grade: 'B' }).reason, /only takes A-grade/);
  assert.match(brain.allow(marcus, pos, { grade: 'A' }).reason, /needs 10 or more paper trades/);
  Object.assign(marcus.lifetime, { countR: 30, sumR: -6 });
  assert.match(brain.allow(marcus, pos, { grade: 'A' }).reason, /edge is negative/);
  Object.assign(marcus.lifetime, { countR: 30, sumR: 9 });
  const yes = brain.allow(marcus, pos, { grade: 'A' });
  assert.equal(yes.ok, true);
  assert.equal(yes.riskMult, 1);
  const withSpx = account({ links: [{ state: 'open', floorSymbol: 'SPX500' }] }).brain;
  assert.match(withSpx.allow(marcus, pos, { grade: 'A' }).reason, /already has a US indices position/);
  // Near the target the risk shrinks; a funded account trades lighter.
  const near = account({ equity: 10_950, dayStart: 10_950 }).brain.state();
  assert.ok(near.reasons.some((r) => /left to the target/.test(r)));
  const funded = account({ type: 'funded' }).brain.state();
  assert.equal(funded.mult, 0.8);
  assert.match(funded.goal, /Payouts/);
});

test('with the committee on, a simulated session runs and every desk trade has a thesis and grade', () => {
  const fund = runBacktest({ sessions: 1, seed: 6, quiet: true, committee: 'on' });
  const errors = fund.agents.flatMap((a) => a.log.filter((l) => l.kind === 'error').map((l) => l.text));
  assert.deepEqual(errors, []);
  assert.ok(fund.committee.stats.reviewed > 5);
  const reviewed = fund.agents.filter((a) => !['kenji', 'isabella'].includes(a.id)).flatMap((a) => fund.broker.book(a.id).trades);
  assert.ok(reviewed.length > 0);
  for (const t of reviewed) {
    assert.ok(['A', 'B', 'C'].includes(t.grade), `${t.agentId} ${t.symbol} graded`);
    assert.match(t.thesis, /Why:/);
  }
});
