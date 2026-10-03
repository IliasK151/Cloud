import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { MarketClock, Session } from '../server/market/session.js';
import { MarketData } from '../server/market/marketData.js';
import { Broker } from '../server/engine/broker.js';
import { RiskManager } from '../server/engine/risk.js';
import { Fund } from '../server/engine/fund.js';
import { Mt5Bridge } from '../server/live/bridge.js';
import { LiveTrader, MAGIC_BASE, LATEST_EA, eaOutdated } from '../server/live/liveTrader.js';
import { lotsForRisk, normalizeProfile, guardMetrics, programRules, bestDayCheck, tradeCost, COST_LIMIT_R } from '../server/live/rules.js';
import { autoMap } from '../server/live/symbolMap.js';

const GOLD = { bid: 3800, ask: 3800.2, digits: 2, point: 0.01, tickSize: 0.01, tickValue: 1, tickValueLoss: 1, volMin: 0.01, volStep: 0.01, volMax: 50, stopsLevel: 0, bars: [] };
const tick = () => new Promise((r) => setImmediate(r));

function setup({ mode = 'live', committee = 'off', quotes = {}, symbols = [], dataDir = null } = {}) {
  const clock = new MarketClock('live');
  const session = new Session(clock);
  session.isFlattenWindow = () => false; // tests must not depend on the time of day
  const md = new MarketData(clock);
  const broker = new Broker(md, clock);
  const risk = new RiskManager({ riskPerTradePct: 0.005, deskDailyLossPct: 0.02, fundDailyLossPct: 0.012, maxLeverage: 4 }, session);
  // These tests cover the mirroring mechanics; the committee and account plan have their own tests.
  const fund = new Fund({ config: { startingCapital: 100_000_000, feed: mode, fundName: 'Test' }, md, clock, session, broker, risk, committee });
  const bridge = new Mt5Bridge();
  dataDir ||= fs.mkdtempSync(path.join(os.tmpdir(), 'live-'));
  const live = new LiveTrader({ fund, md, bridge, clock, mode, dataDir, token: 't', log: { warn() {} } });
  clearInterval(live.timer);
  md.applyTick('XAUUSD', 3800.1, 1, clock.now());

  const mt5 = { balance: 100_000, equity: 100_000, closedToday: 0, positions: [], acks: [], deals: [] };
  const account = () => ({
    login: 555, server: 'FTMO-Demo', currency: 'USD', balance: mt5.balance, equity: mt5.equity, closedToday: mt5.closedToday,
    initialDeposit: 100_000, tradeAllowed: true, expertAllowed: true, algoAllowed: true, connected: true, marginMode: 2,
  });
  // extra: more of what the EA sends (history pages, say).
  const sync = (extra = {}) => {
    const reply = bridge.handleSync({
      account: account(), positions: mt5.positions, deals: mt5.deals, quotes: { XAUUSD: GOLD, ...quotes },
      symbols: ['XAUUSD', 'US100.cash', 'EURUSD', ...symbols], serverDay: '2026.09.29', gmtOffset: 0, acks: mt5.acks.splice(0),
      ...extra,
    });
    return reply.split('\n').filter((l) => /^(open|close|modify|closeall)\|/.test(l)).map((l) => l.split('|'));
  };
  return { fund, live, bridge, sync, mt5, dataDir, chen: fund.byId.get('chen') };
}

test('position sizing turns account risk into lots', () => {
  // $250 risk, 5.0 stop on gold at $1 per 0.01 per lot → $500 per lot → 0.5 lots
  assert.equal(lotsForRisk(250, 5, GOLD), 0.5);
  assert.equal(lotsForRisk(1, 5, GOLD), 0); // below the 0.01 minimum
  assert.equal(lotsForRisk(1e9, 5, GOLD), 50); // capped at volMax
});

test('FTMO presets and guard maths', () => {
  const p = normalizeProfile({ program: '2-step', type: 'verification', size: 50_000 });
  assert.equal(p.targetPct, 5);
  assert.equal(p.dailyLossPct, 5);
  assert.equal(normalizeProfile({ type: 'funded' }).targetPct, null);
  const m = guardMetrics(normalizeProfile({ program: '2-step', type: 'challenge', size: 100_000 }), { balance: 101_000, equity: 99_000, closedToday: 1_000 });
  assert.equal(m.dayStartBalance, 100_000);
  assert.equal(m.dailyLoss, 1_000);
  assert.equal(m.dailyGuard, 4_000); // 80% of the 5% ($5,000) limit
  assert.equal(m.dailyBreach, false);
  assert.equal(guardMetrics(p, { balance: 50_000, equity: 52_600 }).targetHit, true);
});

test('FTMO symbol names are mapped automatically', () => {
  const map = autoMap(['US100.cash', 'US500.cash', 'XAUUSD', 'USOIL.cash', 'EURUSD', 'USDJPY', 'BTCUSD', 'ETHUSD', 'GER40.cash']);
  assert.equal(map.NAS100, 'US100.cash');
  assert.equal(map.USOIL, 'USOIL.cash');
  assert.equal(map.SOLUSD, null);
  assert.equal(autoMap(['EURUSD.r', 'XAUUSD.pro']).EURUSD, 'EURUSD.r');
  const suffixed = autoMap(['XAUUSD.z', 'EURUSD.z', 'NAS100.z', 'USDJPY+', 'BTCUSD#']);
  assert.equal(suffixed.XAUUSD, 'XAUUSD.z');
  assert.equal(suffixed.NAS100, 'NAS100.z');
  assert.equal(suffixed.USDJPY, 'USDJPY+');
  assert.equal(suffixed.BTCUSD, 'BTCUSD#');
  assert.equal(suffixed.SPX500, null);
});

test('bridge converts broker bars to UTC and re-sends until acknowledged', () => {
  const b = new Mt5Bridge();
  b.handleSync({ gmtOffset: 10_799, account: { login: 1 } });
  assert.equal(b.gmtOffset, 10_800);
  assert.equal(b.toBars([[1_000_800, 1, 2, 0.5, 1.5, 10]])[0].time, 1_000_800 - 10_800);
  const id = b.close(42, 1, {});
  assert.match(b.handleSync({}), new RegExp(`close\\|${id}\\|42\\|1`));
  assert.doesNotMatch(b.handleSync({}), /close\|/); // not re-sent within the resend window
  b.handleSync({ acks: [{ id, ok: true }] });
  assert.equal(b.pending.size, 0);
});

test('arming rules: live mode, desks enabled, confirmation for paid accounts', () => {
  const { live, sync } = setup();
  sync();
  assert.equal(live.arm().ok, false); // no setup yet
  live.setup({ program: '2-step', type: 'challenge', size: 100_000 });
  assert.match(live.arm().error, /at least one desk/);
  assert.equal(live.setDesk('kenji', true).ok, false); // pairs desk is paper only
  live.setDesk('chen', true);
  assert.match(live.arm().error, /Type the account number/);
  assert.equal(live.arm({ confirm: '555' }).ok, true);

  const demo = setup({ mode: 'sim' });
  demo.sync();
  demo.live.setup({ program: '2-step', type: 'trial', training: false });
  demo.live.setDesk('chen', true);
  assert.match(demo.live.arm().error, /live market data/);
});

test('desk trades are mirrored: entry, scale-out, stop moves and exit', async () => {
  const { live, sync, mt5, chen } = setup();
  sync();
  live.setup({ program: '2-step', type: 'trial', training: false, size: 100_000 });
  live.setDesk('chen', true);
  assert.equal(live.arm().ok, true);

  // The desk takes a TradingView alert: long gold, stop 5 below, target 10 above.
  const res = chen.handleSignal({ action: 'buy', symbol: 'XAUUSD', stop: 3795, target: 3810 });
  assert.equal(res.ok, true);
  await tick();
  live.reconcile();
  let cmds = sync();
  const open = cmds.find((c) => c[0] === 'open');
  assert.ok(open, 'an open order goes to MT5');
  const [, id, sym, side, vol, slDist, tpDist, magic] = open;
  assert.equal(sym, 'XAUUSD');
  assert.equal(side, 'BUY');
  const plan = chen.plans.get('XAUUSD');
  assert.ok(Math.abs(Number(slDist) - plan.risk) < 1e-9);
  assert.ok(Number(tpDist) > 0);
  assert.equal(Number(magic), MAGIC_BASE + 10);
  // 0.25% of $100k = $250 over a ~5.2 stop → about 0.48 lots
  assert.ok(Number(vol) >= 0.45 && Number(vol) <= 0.5, `volume ${vol}`);

  // MT5 fills it.
  const fill = 3800.2;
  mt5.acks.push({ id, ok: true, ticket: 9001, price: fill, volume: Number(vol) });
  mt5.positions.push({ ticket: 9001, symbol: 'XAUUSD', side: 'BUY', volume: Number(vol), open: fill, sl: fill - Number(slDist), tp: fill + Number(tpDist), profit: 0, magic: Number(magic), comment: open[8] });
  sync();
  const link = [...live.links.values()].find((l) => l.agentId === 'chen');
  assert.equal(link.state, 'open');
  assert.equal(link.ticket, 9001);

  // Desk scales out half → same fraction comes off MT5.
  chen.closeTrade('XAUUSD', 'test scale-out', 0.5);
  live.reconcile();
  cmds = sync();
  const partial = cmds.find((c) => c[0] === 'close');
  assert.ok(partial, 'partial close sent');
  assert.ok(Math.abs(Number(partial[3]) - 0.5) < 0.05);
  mt5.acks.push({ id: partial[1], ok: true, ticket: 9001, price: 3802, volume: Number(vol) / 2 });
  mt5.positions[0].volume = Number(vol) - Math.round((Number(vol) / 2) * 100) / 100;
  sync();

  // Desk moves its stop to breakeven → live stop follows (tighten only).
  chen.plans.get('XAUUSD').stop = plan.entry;
  GOLD.bid = 3804;
  live.reconcile();
  cmds = sync();
  const modify = cmds.find((c) => c[0] === 'modify');
  assert.ok(modify, 'stop modification sent');
  assert.ok(Math.abs(Number(modify[3]) - (plan.entry + (fill - plan.entry))) < 0.02);
  mt5.acks.push({ id: modify[1], ok: true, ticket: 9001, price: Number(modify[3]) });
  mt5.positions[0].sl = Number(modify[3]);
  sync();

  // Desk exits → live position closed exactly once.
  chen.closeTrade('XAUUSD', 'test exit');
  live.reconcile();
  live.reconcile();
  cmds = sync();
  assert.equal(cmds.filter((c) => c[0] === 'close').length, 1);
  assert.equal(link.state, 'closing');
  mt5.positions = [];
  for (let i = 0; i < 3; i++) sync();
  assert.equal(link.state, 'closed');
  live.reconcile();
  assert.equal(sync().length, 0);
  GOLD.bid = 3800;
});

test('the guard stops trading before the FTMO daily loss limit', () => {
  const { live, sync, mt5 } = setup();
  sync();
  live.setup({ program: '2-step', type: 'challenge', size: 100_000 });
  live.setDesk('chen', true);
  live.arm({ confirm: '555' });
  mt5.positions = [{ ticket: 1, symbol: 'XAUUSD', side: 'BUY', volume: 1, open: 3800, sl: 3790, tp: 0, profit: -4100, magic: MAGIC_BASE + 10, comment: 'MF-chen-x' }];
  mt5.equity = 95_900; // $4,100 down on the day: past 80% of the $5,000 daily limit
  const cmds = sync();
  assert.equal(live.armed, false);
  assert.equal(live.halt.kind, 'daily');
  assert.ok(cmds.some((c) => c[0] === 'closeall'), 'closes the floor positions');
  assert.match(live.arm({ confirm: '555' }).error, /halted/);
});

test('profit target reached locks the account', () => {
  const { live, sync, mt5 } = setup();
  sync();
  live.setup({ program: '2-step', type: 'trial', training: false, size: 100_000 });
  live.setDesk('chen', true);
  live.arm();
  mt5.balance = mt5.equity = 110_050;
  sync();
  assert.equal(live.halt.kind, 'target');
  assert.equal(live.armed, false);
  assert.equal(live.resetHalt().ok, true);
  assert.equal(live.halt, null);
});

test('switching to the broker feed does not create fake P&L on open positions', async () => {
  const { fund, chen } = setup();
  chen.handleSignal({ action: 'buy', symbol: 'XAUUSD', stop: 3795, target: 3810 });
  const plan = chen.plans.get('XAUUSD');
  const stopBefore = plan.stop;
  const before = chen.unrealized();
  // Broker prices sit $55 higher than the public feed (different contract / basis).
  const bars = Array.from({ length: 60 }, (_, i) => ({ time: 1_000_000 + i * 60, open: 3855, high: 3856, low: 3854, close: 3855.1, volume: 10 }));
  fund.md.claim('XAUUSD', 'mt5', bars);
  assert.ok(Math.abs(chen.unrealized() - before) < 1e-6, `unrealized jumped from ${before} to ${chen.unrealized()}`);
  assert.ok(Math.abs(plan.stop - (stopBefore + 55)) < 1e-9);
  // Updates from the old feed are now ignored.
  fund.md.applyTick('XAUUSD', 3700, 1, Date.now(), 'yahoo');
  assert.equal(fund.md.price('XAUUSD'), 3855.1);
});

test('briefings talk about the FTMO account once it is connected', () => {
  const { live, sync, chen, fund } = setup();
  sync();
  live.setup({ program: '2-step', type: 'trial', training: false, size: 10_000 });
  live.setDesk('chen', true);
  const text = chen.briefing().text;
  assert.match(text, /FTMO/);
  assert.match(text, /No trades on your FTMO account yet today/);
  assert.doesNotMatch(text, /Since inception the desk/);
  assert.match(fund.byId.get('kenji').briefing().text, /paper trading only/);
});

test('a market on simulated prices never reaches the FTMO account', async () => {
  const { fund, live, sync, chen } = setup();
  sync();
  live.setup({ program: '2-step', type: 'trial', training: false, size: 100_000 });
  live.setDesk('chen', true);
  assert.equal(live.arm().ok, true);

  // Gold's live feed is down: the floor runs it on the simulated stand-in.
  fund.md.setStatus('XAUUSD', 'SIM', 'sim');
  assert.equal(chen.handleSignal({ action: 'buy', symbol: 'XAUUSD', stop: 3795, target: 3810 }).ok, true);
  await tick();
  live.reconcile();
  assert.equal(sync().filter((c) => c[0] === 'open').length, 0, 'nothing is sent to MT5');
  const skipped = [...live.links.values()].find((l) => l.agentId === 'chen');
  assert.equal(skipped.state, 'skipped');
  assert.match(skipped.reason, /simulated prices/);

  // The trade closes on paper: it counts as practice, not as a real track record.
  chen.closeTrade('XAUUSD', 'test exit');
  const trade = fund.broker.book('chen').trades.at(-1);
  assert.equal(trade.simFeed, true);
  assert.equal(chen.lifetime.realN, 0);
  assert.equal(chen.lifetime.countR, 1);

  // Real prices again (the broker's feed): the next trade is mirrored and counts.
  const bars = Array.from({ length: 60 }, (_, i) => ({ time: Math.floor(Date.now() / 60_000) * 60 - (60 - i) * 60, open: 3800, high: 3801, low: 3799, close: 3800.1, volume: 10 }));
  fund.md.claim('XAUUSD', 'mt5', bars);
  chen.cooldownBars = 0; // the desk's normal cool-off after that paper loss
  const again = chen.handleSignal({ action: 'buy', symbol: 'XAUUSD', stop: 3795, target: 3810 });
  assert.equal(again.ok, true, again.reason);
  await tick();
  live.reconcile();
  assert.equal(sync().filter((c) => c[0] === 'open').length, 1);
});

test('the daily stop switch is saved on the account and noted in the live log', () => {
  const { live, sync } = setup();
  sync();
  assert.equal(live.setPlan({ dailyStopOn: false }).ok, false, 'needs the account set up');
  live.setup({ program: '2-step', type: 'trial', training: false, size: 10_000 });
  assert.equal(live.profile.dailyStopOn, true);
  assert.equal(live.setPlan({ dailyStopOn: false }).ok, true);
  assert.equal(live.profile.dailyStopOn, false);
  assert.equal(live.view().plan.dailyStopOn, false);
  assert.match(live.events.at(-1).text, /Daily stop switched OFF/);
  // Saving the setup form keeps the choice it sends.
  live.setup({ program: '2-step', type: 'trial', training: false, size: 10_000, dailyStopOn: false });
  assert.equal(live.profile.dailyStopOn, false);
  live.setPlan({ dailyStopOn: true });
  assert.equal(live.profile.dailyStopOn, true);
});

test('the floor never says a desk is on FTMO while its trades stay on paper; the boss\'s alerts do go', async () => {
  const { fund, live, sync, chen } = setup({ committee: 'on' });
  sync();
  live.setup({ program: '2-step', type: 'trial', training: false, size: 100_000 });
  live.setDesk('amara', true);
  live.setDesk('chen', true);
  assert.equal(live.arm().ok, true);

  // Amara's own trade: switched on, but no record on real prices yet.
  const amara = fund.byId.get('amara');
  assert.equal(amara.openTrade({ side: 'LONG', stop: 3790, target: 3830, reason: 'test setup', symbol: 'XAUUSD' }), true);
  await tick();
  live.reconcile();
  assert.equal(sync().filter((c) => c[0] === 'open').length, 0, 'not sent to MT5');
  const row = live.view().desks.find((d) => d.id === 'amara');
  assert.equal(row.status.state, 'proving');
  assert.ok(row.lastSkip?.reason, 'the reason is shown');
  const says = live.describeFor('amara');
  assert.match(says, /haven't earned real money yet/);
  assert.match(says, /XAUUSD trade is on paper only/);
  assert.doesNotMatch(says, /cleared to trade/);
  assert.match(amara.briefing().text, /On paper only, I'm long/);

  // The boss's own TradingView alert through Chen goes to MT5 straight away.
  assert.equal(live.view().desks.find((d) => d.id === 'chen').status.state, 'proving');
  assert.equal(chen.handleSignal({ action: 'buy', symbol: 'XAUUSD', stop: 3795, target: 3810 }).ok, true);
  await tick();
  live.reconcile();
  const open = sync().filter((c) => c[0] === 'open');
  assert.equal(open.length, 1, 'the alert reached MT5');
  assert.equal(live.view().desks.find((d) => d.id === 'chen').status.state, 'live');
  assert.match(live.describeFor('chen'), /sent a buy order/);

  // The TradingView tab's test button never trades the account.
  chen.closeTrade('XAUUSD', 'test exit');
  chen.cooldownBars = 0;
  assert.equal(chen.handleSignal({ action: 'sell', symbol: 'XAUUSD', stop: 3810, target: 3790, test: true }).ok, true);
  await tick();
  live.reconcile();
  assert.equal(sync().filter((c) => c[0] === 'open').length, 0);
  assert.match([...live.links.values()].at(-1).reason, /test alert/);
});

test('an outdated EA gets a doable update: one click copies it into MT5, then it turns green', () => {
  const { live, bridge } = setup();
  const acc = { login: 555, server: 'FTMO-Demo', balance: 10_000, equity: 10_000, initialDeposit: 10_000, tradeAllowed: true, expertAllowed: true, algoAllowed: true, connected: true, marginMode: 2 };
  bridge.handleSync({ version: '1.0.0', account: acc, positions: [], deals: [], quotes: {}, symbols: [] });
  assert.match(LATEST_EA, /^\d+\.\d+\.\d+$/);
  assert.equal(eaOutdated('1.0.0'), true);
  assert.equal(eaOutdated(LATEST_EA), false);
  let ea = live.view().ea;
  assert.equal(ea.outdated, true);
  assert.equal(ea.latest, LATEST_EA);

  // "Put the update into MT5": the shipped EA lands in MT5's Experts folder.
  const experts = fs.mkdtempSync(path.join(os.tmpdir(), 'mt5-experts-'));
  const res = live.installEa({ locate: () => [experts] });
  assert.equal(res.ok, true);
  assert.match(fs.readFileSync(path.join(experts, 'MeridianBridge.mq5'), 'utf8'), new RegExp(`EA_VERSION\\s+"${LATEST_EA.replace(/\./g, '\\.')}"`));
  assert.equal(live.installEa({ locate: () => [] }).ok, false, 'MT5 not on this Mac: says so');

  // Compiled in MetaEditor: MT5 reloads it, the floor sees the new version.
  bridge.handleSync({ version: LATEST_EA, caps: { maxRiskPct: 1, maxPositions: 8 }, account: acc, positions: [], deals: [], quotes: {}, symbols: [] });
  ea = live.view().ea;
  assert.equal(ea.outdated, false);
  assert.ok(ea.updated, 'confirmed once');
  assert.ok(live.events.some((e) => /EA updated to/.test(e.text)));
  assert.equal(live.view().warnings.some((w) => /older version/.test(w)), false);
});

test('plan switches save together, survive the setup form, and ghost orders stop counting', async () => {
  const { live, sync, mt5, chen } = setup();
  sync();
  live.setup({ program: '2-step', type: 'trial', training: false, size: 100_000 });
  assert.equal(live.setPlan({ tradeCapOn: false, provenOnly: false }).ok, true);
  assert.equal(live.profile.tradeCapOn, false);
  assert.equal(live.profile.provenOnly, false);
  assert.ok(live.events.some((e) => /Trade cap switched OFF/.test(e.text)));
  live.setup({ program: '2-step', type: 'trial', training: false, size: 100_000 }); // saving the form keeps them
  assert.equal(live.profile.tradeCapOn, false);
  assert.equal(live.profile.provenOnly, false);

  // An order MT5 never confirmed: after two minutes it no longer counts or blocks anything.
  live.setDesk('chen', true);
  live.arm();
  assert.equal(chen.handleSignal({ action: 'buy', symbol: 'XAUUSD', stop: 3795, target: 3810 }).ok, true);
  await tick();
  live.reconcile();
  const link = [...live.links.values()].find((l) => l.agentId === 'chen');
  assert.equal(link.state, 'pending');
  mt5.acks = [];
  live.bridge.pending.clear(); // the command itself was lost
  link.createdAt -= 3 * 60_000;
  sync();
  assert.equal(link.state, 'failed');
  assert.match(link.reason, /never confirmed/);
  assert.equal(live.brain.state().tradesToday, 0);
});

test('a trade below the broker minimum goes at the minimum lot only within the base risk', async () => {
  const { live, sync, chen } = setup();
  sync();
  live.setup({ program: '2-step', type: 'trial', training: false, size: 100_000, riskPerTradePct: 0.01 }); // $10 per trade
  live.setDesk('chen', true);
  live.arm();
  // Gold, a $5 stop: 0.01 lot risks $5 → within $10, so it goes at the minimum.
  assert.equal(chen.handleSignal({ action: 'buy', symbol: 'XAUUSD', stop: 3795, target: 3830 }).ok, true);
  await tick();
  live.reconcile();
  const open = sync().filter((c) => c[0] === 'open');
  assert.equal(open.length, 1);
  assert.equal(open[0][4], '0.01');
});

test('with "Proven desks only" off, a desk\'s own trade really reaches MT5 at half risk', async () => {
  const { fund, live, sync } = setup({ committee: 'on' });
  sync();
  live.setup({ program: '2-step', type: 'trial', training: false, size: 100_000 });
  live.setDesk('amara', true);
  assert.equal(live.arm().ok, true);
  const amara = fund.byId.get('amara');

  // Proven desks only (default): stays on paper.
  assert.equal(amara.openTrade({ side: 'LONG', stop: 3790, target: 3830, reason: 'setup one', symbol: 'XAUUSD' }), true);
  await tick();
  live.reconcile();
  assert.equal(sync().filter((c) => c[0] === 'open').length, 0);
  amara.closeTrade('XAUUSD', 'test exit');
  amara.cooldownBars = 0;

  // Switched off: the next trade goes to MT5, at half the risk of a proven desk.
  live.setPlan({ provenOnly: false });
  assert.equal(live.view().desks.find((d) => d.id === 'amara').status.state, 'probation');
  assert.equal(amara.openTrade({ side: 'LONG', stop: 3790, target: 3830, reason: 'setup two', symbol: 'XAUUSD' }), true);
  await tick();
  live.reconcile();
  const open = sync().filter((c) => c[0] === 'open');
  assert.equal(open.length, 1, 'the order went to MT5');
  const link = [...live.links.values()].find((l) => l.state === 'pending');
  assert.equal(link.agentId, 'amara');
  assert.equal(link.riskMult, 0.5);
  assert.match(live.describeFor('amara'), /sent a buy order/);
});

test("a scalper's GBPUSD scalp reaches MT5 under its own magic number, with its tight stop", async () => {
  const CABLE = { bid: 1.34, ask: 1.34008, digits: 5, point: 0.00001, tickSize: 0.00001, tickValue: 1, tickValueLoss: 1, volMin: 0.01, volStep: 0.01, volMax: 50, stopsLevel: 0, bars: [] };
  const { fund, live, sync } = setup({ quotes: { GBPUSD: CABLE }, symbols: ['GBPUSD'] });
  fund.md.applyTick('GBPUSD', 1.34004, 1, Date.now());
  sync();
  live.setup({ program: '2-step', type: 'trial', training: false, size: 100_000 });
  live.setPlan({ provenOnly: false });
  assert.equal(live.setDesk('jake', true).ok, true);
  assert.equal(live.arm().ok, true);
  assert.equal(live.view().desks.find((d) => d.id === 'jake').brokerSymbol, 'GBPUSD');
  const jake = fund.byId.get('jake');
  assert.equal(jake.openTrade({ side: 'LONG', stop: 1.3394, target: 1.3425, reason: 'London scalp: ran the Asia low', symbol: 'GBPUSD', partialAt: 1, timeStopBars: 20 }), true);
  await tick();
  live.reconcile();
  const open = sync().filter((c) => c[0] === 'open');
  assert.equal(open.length, 1, 'the scalp went to MT5');
  // open|id|SYM|BUY|vol|slDist|tpDist|magic|comment
  const [, , sym, side, , slDist, , magic] = open[0];
  assert.equal(sym, 'GBPUSD');
  assert.equal(side, 'BUY');
  assert.equal(Number(magic), MAGIC_BASE + 16, 'the scalpers come after the original fifteen desks');
  assert.ok(Number(slDist) > 0 && Number(slDist) < 0.001, `a scalp stop under 10 pips (${slDist})`);
});

test('a market added after the account was set up (GBPUSD) is mapped to the broker on the next sync', () => {
  const { live, sync } = setup({ symbols: ['GBPUSD'] });
  sync();
  live.setup({ program: '2-step', type: 'trial', training: false, size: 100_000 });
  // An account saved before GBPUSD existed, where the boss also chose to leave EURUSD unmapped.
  delete live.profile.symbolMap.GBPUSD;
  live.profile.symbolMap.EURUSD = null;
  sync();
  assert.equal(live.profile.symbolMap.GBPUSD, 'GBPUSD');
  assert.equal(live.profile.symbolMap.EURUSD, null, 'a market set to "not mapped" stays that way');
  assert.ok(live.events.some((e) => /New market mapped to your broker: GBPUSD → GBPUSD/.test(e.text)));
  // Nothing new the next time.
  const n = live.events.length;
  sync();
  assert.equal(live.events.filter((e) => /New market/.test(e.text)).length, live.events.slice(0, n).filter((e) => /New market/.test(e.text)).length);
});

test('a market without real prices is never made up: its desks stand aside and say why', () => {
  const { fund, live, sync } = setup();
  fund.md.setStatus('GBPUSD', 'WAITING', 'none');
  const jake = fund.byId.get('jake');
  assert.equal(jake.status(), 'NO PRICES');
  assert.match(jake.briefing().text, /no real prices for GBPUSD right now/);
  const alert = jake.handleSignal({ action: 'buy', symbol: 'GBPUSD' });
  assert.equal(alert.ok, false);
  assert.match(alert.reason, /No real prices for GBPUSD/);
  sync();
  live.setup({ program: '2-step', type: 'trial', training: false, size: 100_000 });
  const w = live.view().warnings.find((x) => /^No real prices/.test(x));
  assert.ok(w, 'the FTMO tab says so');
  assert.match(w, /Nothing is simulated/);
  assert.match(w, /GBPUSD isn't mapped to a symbol on your broker/);
});

const wait = (ms) => new Promise((r) => setTimeout(r, ms));

test('the daily report card records the day: trades, R, what stayed on paper, and phone alerts', async () => {
  const { live, sync, mt5, dataDir, chen, fund } = setup();
  const alerts = [];
  live.on('alert', (a) => alerts.push(a));
  sync();
  live.setup({ program: '2-step', type: 'trial', training: false, size: 100_000 });
  live.setDesk('chen', true);
  live.setDesk('amara', true);
  assert.equal(live.arm().ok, true);
  assert.ok(alerts.some((a) => a.kind === 'arming' && /Armed/.test(a.text)));

  // Chen's alert trade reaches MT5, fills, and later closes for +$125.
  assert.equal(chen.handleSignal({ action: 'buy', symbol: 'XAUUSD', stop: 3795, target: 3810 }).ok, true);
  await tick();
  live.reconcile();
  const open = sync().find((c) => c[0] === 'open');
  mt5.acks.push({ id: open[1], ok: true, ticket: 9101, price: 3800.2, volume: Number(open[4]) });
  mt5.positions.push({ ticket: 9101, symbol: 'XAUUSD', side: 'BUY', volume: Number(open[4]), open: 3800.2, sl: 3795, tp: 3815, profit: 0, magic: Number(open[7]), comment: open[8] });
  sync();
  assert.ok(alerts.some((a) => a.kind === 'trade' && /Chen bought .* XAUUSD @ 3800.2/.test(a.text)), JSON.stringify(alerts));

  // Amara wants gold too while Chen holds it: one position per correlated group, so hers
  // stays on paper, and the report says why.
  const amara = fund.byId.get('amara');
  assert.equal(amara.openTrade({ side: 'LONG', stop: 3790, target: 3830, reason: 'sweep', symbol: 'XAUUSD' }), true);
  await tick();
  live.reconcile();

  const link = [...live.links.values()].find((l) => l.agentId === 'chen');
  mt5.positions = [];
  mt5.deals = [{ position: 9101, entry: 1, pnl: 125 }];
  for (let i = 0; i < 3; i++) sync();
  assert.equal(link.state, 'closed');
  const closeAlert = alerts.find((a) => a.kind === 'trade' && /closed XAUUSD/.test(a.text));
  assert.match(closeAlert.text, /Chen closed XAUUSD \+\$125\.00 \(\+0\.\dR\)/);
  assert.match(closeAlert.text, /Today on FTMO · 1 closed trade, 1 won:\n🟢 Chen XAUUSD \+\$125\.00/);

  const r = live.reports.current;
  assert.equal(r.day, '2026.09.29', 'the FTMO server day');
  assert.equal(r.desks.chen.trades, 1);
  assert.equal(r.desks.chen.wins, 1);
  assert.equal(r.desks.chen.pnl, 125);
  assert.ok(r.desks.chen.sumR > 0);
  assert.equal(r.desks.amara.skipped, 1);
  assert.equal(r.skipped['Correlated position already open'], 1, JSON.stringify(r.skipped));
  assert.ok(r.events.some((e) => e.kind === 'arm'));
  live.reports.flush();
  const saved = JSON.parse(fs.readFileSync(path.join(dataDir, 'reports', '2026-09-29.json'), 'utf8'));
  assert.equal(saved.desks.chen.pnl, 125);
});

test('stay armed after a restart: the same account re-arms by itself, never after disarm or a guard stop', async () => {
  const a = setup();
  a.sync();
  a.live.setup({ program: '2-step', type: 'trial', training: false, size: 100_000 });
  a.live.setDesk('chen', true);
  assert.equal(a.live.arm().ok, true);
  assert.equal(a.live.setStayArmed(true).ok, true);
  await wait(300);
  await a.live.shutdown();

  // The floor restarts: once MT5 syncs, it arms again by itself.
  const b = setup({ dataDir: a.dataDir });
  const alerts = [];
  b.live.on('alert', (x) => alerts.push(x));
  assert.equal(b.live.armed, false);
  b.sync();
  assert.equal(b.live.armed, true);
  assert.ok(alerts.some((x) => /Re-armed automatically/.test(x.text)));
  assert.ok(b.live.events.some((e) => /ARMED again automatically/.test(e.text)));

  // The boss disarms: a restart leaves it disarmed.
  b.live.disarm();
  await wait(300);
  const c = setup({ dataDir: a.dataDir });
  c.sync();
  assert.equal(c.live.armed, false);

  // Switched off: a restart never arms.
  assert.equal(c.live.arm().ok, true);
  c.live.setStayArmed(false);
  await wait(300);
  const d = setup({ dataDir: a.dataDir });
  d.sync();
  assert.equal(d.live.armed, false);

  // A risk-guard stop is never undone by a restart.
  d.live.setStayArmed(true);
  assert.equal(d.live.arm().ok, true);
  d.mt5.equity = 95_500; // down $4,500: past 80% of the $5,000 daily limit
  d.sync();
  assert.equal(d.live.armed, false);
  assert.ok(d.live.halt);
  await wait(300);
  const e = setup({ dataDir: a.dataDir });
  e.sync();
  assert.equal(e.live.armed, false);
  assert.equal(e.live.view().rememberedArmed, false);
});

test('MT5 going quiet for a minute is an alert, and so is it coming back', () => {
  const { live, sync, bridge } = setup();
  const alerts = [];
  live.on('alert', (a) => alerts.push(a));
  sync();
  live.setup({ program: '2-step', type: 'trial', training: false, size: 100_000 });
  bridge.lastSync = Date.now() - 70_000;
  live.tick();
  live.tick();
  assert.equal(alerts.filter((a) => a.kind === 'connection').length, 1);
  assert.match(alerts[0].text, /stopped talking to the floor/);
  sync();
  live.tick();
  assert.match(alerts.at(-1).text, /MT5 is back after 1 minute/);
});

test('Today on the account: ideas, what the committee turned down, what stayed on paper and why, what reached MT5', async () => {
  const { todaySummary, todayRailNote, marketClock, renderToday } = await import('../public/js/ui/todayCard.js');
  const { fund, live, sync } = setup({ committee: 'on' });
  sync();
  live.setup({ program: '2-step', type: 'trial', training: false, size: 100_000 });
  live.setDesk('amara', true);
  live.setDesk('chen', true);
  live.setPlan({ provenOnly: false }); // as on the boss's Free Trial
  assert.equal(live.arm().ok, true);
  const store = () => ({ live: live.view(), agents: Object.fromEntries(fund.agents.map((a) => [a.id, a.snapshot()])) });

  let s = todaySummary(store());
  assert.match(s.headline, /No trades yet today\. Everything is connected and armed.*hasn't given them a setup/);
  assert.deepEqual([s.funnel.ideas, s.funnel.paper, s.funnel.held, s.funnel.sent], [0, 0, 0, 0]);

  // The committee turns an idea down: counted once, with the reason, and not again when the
  // desk repeats it a minute later.
  const amara = fund.byId.get('amara');
  const committee = fund.committee;
  const review = committee.review.bind(committee);
  committee.review = () => ({ ok: false, silent: false, reason: 'the target is only 0.6R, less than the risk', grade: '—' });
  assert.equal(amara.openTrade({ side: 'LONG', stop: 3790, target: 3806, reason: 'sweep', symbol: 'XAUUSD' }), false);
  committee.review = () => ({ ok: false, silent: true, reason: 'the target is only 0.6R, less than the risk', grade: '—' });
  assert.equal(amara.openTrade({ side: 'LONG', stop: 3790, target: 3806, reason: 'sweep', symbol: 'XAUUSD' }), false);
  committee.review = review;
  assert.deepEqual(amara.snapshot().today, { ideas: 1, vetoed: 1, skipped: 0, entries: 0, whyNot: amara.day.whyNot });
  assert.match(amara.day.whyNot.text, /committee said no: the target is only 0\.6R/);
  s = todaySummary(store());
  assert.match(s.headline, /found 1 setup and the committee turned it down/);

  // The next idea the committee isn't convinced by (grade C): a paper trade, held back from
  // the account.
  committee.review = () => ({ ok: true, silent: false, grade: 'C', score: 0.05, sizeMult: 0.25, thesis: 'Sweep.', reason: 'not convinced' });
  assert.equal(amara.openTrade({ side: 'LONG', stop: 3790, target: 3830, reason: 'sweep', symbol: 'XAUUSD' }), true);
  committee.review = review;
  await tick();
  live.reconcile();
  let t = live.view().today;
  assert.equal(t.held, 1);
  assert.deepEqual(t.reasons, [['Committee grade too low', 1]]);
  assert.equal(t.byDesk.amara.held, 1);
  s = todaySummary(store());
  assert.match(s.headline, /No trades on FTMO yet today\. .*1 trade was held back from the account, mostly: committee grade too low/);
  assert.match(s.meaning, /Only A and B-grade trades go to the account/);
  const row = s.rows.find((r) => r.id === 'amara');
  assert.deepEqual([row.ideas, row.vetoed, row.paper, row.sent], [2, 1, 1, 0]);
  assert.match(row.why.text, /XAUUSD trade held back: committee grade C/);
  amara.closeTrade('XAUUSD', 'test exit');

  // The boss's TradingView alert through Chen goes to MT5.
  assert.equal(fund.byId.get('chen').handleSignal({ action: 'buy', symbol: 'XAUUSD', stop: 3795, target: 3815 }).ok, true);
  await tick();
  live.reconcile();
  assert.equal(sync().filter((c) => c[0] === 'open').length, 1);
  t = live.view().today;
  assert.equal(t.sent, 1);
  assert.equal(t.byDesk.chen.sent, 1);
  s = todaySummary(store());
  assert.equal(s.tone, 'good');
  assert.match(s.headline, /^1 trade went to FTMO today\. 1 more stayed on paper, mostly: committee grade too low\./);
  assert.match(todayRailNote(store()), /1 trade on FTMO today.*data-goto-view="ftmo"/);
  const html = renderToday({ ...store(), fund: { marketTime: Date.UTC(2026, 9, 1, 6, 13) } }, { now: Date.now(), timeZone: 'Europe/Athens' });
  assert.match(html, /Now <b>02:13<\/b> in New York, <b>09:13( AM)?<\/b> your time: the Asia session/);
  assert.match(html, /Committee grade too low/);

  // Disarmed: said first, plainly.
  live.disarm();
  assert.match(todaySummary(store()).headline, /isn't armed, so the desks trade on paper only/);

  // The market hours, in the boss's own time (Athens, 1 Oct 2026, New York on summer time).
  const c = marketClock(Date.UTC(2026, 9, 1, 6, 13), 'Europe/Athens');
  assert.equal(c.ny, '02:13');
  assert.match(c.local, /^09:13/);
  assert.deepEqual(c.windows.map((w) => w.label), ['London open', 'New York open']);
  assert.match(c.windows[0].local, /^10:00/);
  assert.match(c.windows[1].local, /^(16:30|04:30 PM)/);
  assert.deepEqual(c.scalp.map((k) => k.open), [true, false], 'the London scalpers are in their killzone');
  assert.equal(marketClock(Date.UTC(2026, 9, 3, 12, 0), 'Europe/Athens').weekend, true, 'Saturday');
  assert.match(marketClock(Date.UTC(2026, 9, 1, 14, 0), 'Europe/Athens').session, /New York session/);
});

test('training on FTMO (Free Trial): every trade the desks take goes to the account, the loss guard stays', async () => {
  const { fund, live, sync, mt5 } = setup({ committee: 'on' });
  sync();
  live.setup({ program: '2-step', type: 'trial', size: 100_000 });
  assert.equal(live.profile.training, true, 'on by default on a Free Trial');
  assert.ok(live.view().desks.filter((d) => d.eligible).every((d) => d.enabled), 'a new Free Trial starts with every desk on the account');
  live.setDesk('amara', true);
  live.setDesk('lucas', true);
  assert.equal(live.arm().ok, true);
  const v = live.view();
  assert.equal(v.plan.training, true);
  assert.equal(v.plan.blocked, null);
  assert.match(v.plan.rules[0].text, /Training on FTMO: every trade/);
  assert.equal(v.desks.find((d) => d.id === 'amara').status.state, 'training');

  // An unproven desk's trade the committee isn't convinced by (C): it goes, sized smaller.
  const committee = fund.committee;
  const review = committee.review.bind(committee);
  committee.review = () => ({ ok: true, silent: false, grade: 'C', score: 0.05, sizeMult: 0.25, thesis: 'Sweep.', reason: 'not convinced' });
  const amara = fund.byId.get('amara');
  assert.equal(amara.openTrade({ side: 'LONG', stop: 3790, target: 3830, reason: 'sweep', symbol: 'XAUUSD' }), true);
  // A second gold trade from another desk: no one-per-group hold while training.
  const lucas = fund.byId.get('lucas');
  lucas.symbols.push('XAUUSD');
  assert.equal(lucas.openTrade({ side: 'LONG', stop: 3792, target: 3830, reason: 'pullback', symbol: 'XAUUSD' }), true);
  committee.review = review;
  await tick();
  live.reconcile();
  const opens = sync().filter((c) => c[0] === 'open');
  assert.equal(opens.length, 2, 'both trades went to MT5');
  const links = [...live.links.values()].filter((l) => l.state === 'pending');
  assert.deepEqual(links.map((l) => l.agentId).sort(), ['amara', 'lucas']);
  assert.equal(live.view().today.held, 0, 'nothing held back on paper');

  // No daily cap and no stop for the day while training, but a losing streak gets a cool-off…
  const lossDay = (i, at = Date.now()) => ({ key: `x${i}`, agentId: 'amara', state: 'closed', ticket: 500 + i, pnl: -50, login: '555', closedAt: at, closedDay: '2026.09.29', openedDay: '2026.09.29' });
  for (let i = 0; i < 7; i++) live.links.set(`x${i}`, lossDay(i));
  let st = live.brain.state();
  assert.match(st.blocked, /7 losses in a row on the account: a 2-hour cool-off, 120 minutes to go/);
  assert.equal(st.status, 'COOLING OFF');
  // …that ends after 2 hours, with risk still halved after losses.
  for (let i = 0; i < 7; i++) live.links.set(`x${i}`, lossDay(i, Date.now() - 2.5 * 3_600_000));
  st = live.brain.state();
  assert.equal(st.blocked, null);
  assert.ok(st.mult < 1, 'but risk still halves after losses');
  // …and FTMO's loss guard still keeps out a trade that could breach the limit: $3,950 down
  // today on a $100,000 trial, the guard acts at $4,000, and two orders are still in flight.
  mt5.closedToday = -3_950;
  mt5.balance = 96_050;
  mt5.equity = 96_050;
  sync();
  amara.closeTrade('XAUUSD', 'test exit');
  amara.cooldownBars = 0;
  assert.equal(amara.openTrade({ side: 'LONG', stop: 3790, target: 3830, reason: 'sweep again', symbol: 'XAUUSD' }), true);
  await tick();
  live.reconcile();
  assert.deepEqual(live.view().today.reasons, [['No room under the loss guard', 1]]);

  // Training is for the Free Trial only.
  live.setPlan({ training: false });
  assert.equal(live.profile.training, false);
  assert.equal(live.view().desks.find((d) => d.id === 'amara').status.state !== 'training', true);
  live.setup({ program: '2-step', type: 'challenge', size: 100_000 });
  assert.equal(live.profile.training, false);
  assert.match(live.setPlan({ training: true }).error, /for the Free Trial/);
  assert.equal(live.view().plan.canTrain, false);
});

test('training on FTMO: an account saved before it existed trains, and switching it on puts every desk on the account', () => {
  const { live, sync } = setup();
  sync();
  live.setup({ program: '2-step', type: 'trial', training: false, size: 10_000 });
  delete live.state.profiles[live.login].training; // saved by an older version
  assert.equal(live.profile.training, true);
  live.setPlan({ training: false });
  assert.equal(live.view().desks.filter((d) => d.enabled).length, 0);
  live.setPlan({ training: true });
  const desks = live.view().desks;
  assert.ok(desks.filter((d) => d.eligible).every((d) => d.enabled), 'every desk that can trade the account is on');
  assert.ok(desks.filter((d) => !d.eligible).every((d) => !d.enabled), 'pairs and market making stay paper (they can\'t be mirrored)');
  assert.ok(live.events.some((e) => /Training on FTMO switched ON/.test(e.text)));
});

test('MT5 syncs only as often as needed: fast while orders go through, every 2 s when nothing happens', async () => {
  const { PACE } = await import('../server/live/bridge.js');
  const { live, sync, fund, mt5, bridge } = setup();
  let reply = '';
  const handle = bridge.handleSync.bind(bridge);
  bridge.handleSync = (m) => (reply = handle(m));
  const pace = () => {
    sync();
    return Number(reply.match(/^pace\|(\d+)$/m)?.[1]);
  };
  sync();
  assert.equal(pace(), PACE.idle, 'nothing going on: every 2 seconds');
  // A desk on the account is waiting for its trigger: once a second.
  live.setup({ program: '2-step', type: 'trial', size: 100_000 });
  live.setDesk('amara', true);
  assert.equal(live.arm().ok, true);
  // MT5 has answered the history requests the setup made (this test's MT5 sends no bars).
  bridge.requestHistory = () => {};
  bridge.historyWanted.clear();
  fund.byId.get('amara').setup.armed = true;
  assert.equal(pace(), PACE.active);
  fund.byId.get('amara').setup.armed = false;
  assert.equal(pace(), PACE.idle);
  // An order on its way: twice a second until MT5 confirms it, and for a little while after.
  assert.equal(fund.byId.get('amara').openTrade({ side: 'LONG', stop: 3790, target: 3830, reason: 'sweep', symbol: 'XAUUSD' }), true);
  await tick();
  live.reconcile();
  sync();
  assert.match(reply, /^open\|/m);
  assert.match(reply, /^pace\|500$/m, 'the pace comes after the commands it covers');
  // History MT5 can't give doesn't keep it fast for more than a minute.
  bridge.pending.clear();
  bridge.lastCommandAt = 0;
  bridge.historyWanted.set('XAUUSD', { count: 600, lastAsked: Date.now(), since: Date.now() - 61_000 });
  fund.byId.get('amara').closeTrade('XAUUSD', 'test');
  live.reconcile();
  bridge.pending.clear();
  assert.notEqual(bridge.pace(), PACE.busy);
  bridge.historyWanted.clear();
  // Positions open: once a second.
  bridge.pending.clear();
  bridge.lastCommandAt = 0;
  mt5.positions = [{ ticket: 1, symbol: 'XAUUSD', side: 'BUY', volume: 0.1, open: 3800, sl: 3790, tp: 0, profit: 0, magic: 771005 }];
  assert.equal(pace(), PACE.active);
});

test('the trades that reached FTMO today still count after the floor restarts', async () => {
  const a = setup();
  a.sync();
  a.live.setup({ program: '2-step', type: 'trial', size: 100_000 });
  a.live.setDesk('chen', true);
  assert.equal(a.live.arm().ok, true);
  assert.equal(a.chen.handleSignal({ action: 'buy', symbol: 'XAUUSD', stop: 3795, target: 3810 }).ok, true);
  await tick();
  a.live.reconcile();
  const open = a.sync().find((c) => c[0] === 'open');
  a.mt5.acks.push({ id: open[1], ok: true, ticket: 9301, price: 3800.2, volume: Number(open[4]) });
  a.sync();
  assert.equal(a.live.view().today.sent, 1);
  a.live.reports.flush();
  await a.live.shutdown();

  const b = setup({ dataDir: a.dataDir });
  b.sync();
  const t = b.live.view().today;
  assert.equal(t.sent, 1, 'from the day\'s report, not from this session\'s orders');
  assert.equal(t.byDesk.chen.sent, 1);
});

test('the EA follows the floor\'s pace, re-reads the account history only after a trade, redraws its chart only on news, and pages back through history', () => {
  const ea = fs.readFileSync(new URL('../mt5/MeridianBridge.mq5', import.meta.url), 'utf8');
  assert.equal(LATEST_EA, '1.3.0');
  assert.equal(eaOutdated('1.1.1'), true, 'the boss is asked to update');
  assert.equal(eaOutdated('1.2.0'), true, 'EA 1.2 can\'t page back through history');
  // 1.3: history|SYM|COUNT|START, START bars back (older floors' history|SYM|COUNT still works).
  assert.match(ea, /g_historyReq\[sz\] = f\[1\] \+ "\|" \+ f\[2\] \+ "\|" \+ \(k >= 4 \? f\[3\] : "1"\);/);
  assert.match(ea, /int start = ArraySize\(parts\) >= 3 \? \(int\)StringToInteger\(parts\[2\]\) : 1;/);
  assert.match(ea, /CopyRates\(s, PERIOD_M1, start, count, r\)/);
  assert.match(ea, /else if\(cmd == "pace" && k >= 2\)\s*SetPace\(/);
  assert.match(ea, /void SetPace\(const int ms\)[\s\S]*MathMax\(MathMax\(200, InpSyncMs\), MathMin\(5000, ms\)\)/);
  assert.match(ea, /void OnTrade\(\)\s*\{\s*g_dealsDirty = true;/);
  assert.match(ea, /if\(g_dealsDirty \|\| day != g_dealsDay \|\| TimeLocal\(\) - g_dealsAt >= 30\)/);
  assert.match(ea, /if\(text == g_comment\)\s*return;/);
  assert.match(ea, /OnDeinit[\s\S]*g_timerMs = 0;/, 'a chart change starts the timer again');
  // Every MQL5 brace and parenthesis is balanced (a cheap check that it compiles).
  // Line by line: strings first (a URL holds "//"), then comments.
  const code = ea.split('\n').map((l) => l.replace(/"(?:[^"\\]|\\.)*"/g, '""').replace(/'(?:[^'\\]|\\.)'/g, "''").replace(/\/\/.*$/, '')).join('\n');
  for (const [o, c] of [['{', '}'], ['(', ')'], ['[', ']']]) assert.equal(code.split(o).length, code.split(c).length, `${o}${c} balanced`);
});

test('phone alerts: the real fill price, and every closed trade of the day with its P&L, as MT5 counts it', async () => {
  const { live, sync, mt5, chen } = setup();
  const alerts = [];
  live.on('alert', (a) => alerts.push(a));
  sync();
  live.setup({ program: '2-step', type: 'trial', size: 100_000 });
  assert.equal(live.arm().ok, true);
  assert.equal(chen.handleSignal({ action: 'buy', symbol: 'XAUUSD', stop: 3795, target: 3815 }).ok, true);
  await tick();
  live.reconcile();
  const open = sync().find((c) => c[0] === 'open');
  // This broker reports a market order's fill price as 0: the alert waits for the position.
  mt5.acks.push({ id: open[1], ok: true, ticket: 9401, price: 0, volume: Number(open[4]) });
  sync();
  assert.ok(!alerts.some((a) => /bought/.test(a.text)), 'no "@ 0"');
  mt5.positions.push({ ticket: 9401, symbol: 'XAUUSD', side: 'BUY', volume: Number(open[4]), open: 3800.35, sl: 3795, tp: 3815, profit: 0, magic: Number(open[7]), comment: open[8] });
  sync();
  const fill = alerts.filter((a) => /bought/.test(a.text));
  assert.equal(fill.length, 1);
  assert.match(fill[0].text, /Chen bought [\d.]+ XAUUSD @ 3800\.35/);
  const link = [...live.links.values()].find((l) => l.ticket === 9401);
  const stop = 3800.35 - link.stopDistance;
  assert.ok(fill[0].text.includes(`\nStop ${stop.toFixed(2)} (−$`), fill[0].text);
  assert.match(fill[0].text, /· target [\d.]+ \(\+\$[\d.]+, [\d.]+R\)/);
  assert.match(fill[0].text, /\n\nWhy: TradingView alert/);
  assert.match(fill[0].text, /TradingView: https:\/\/www\.tradingview\.com\/chart\/\?symbol=OANDA%3AXAUUSD/);
  // …with the setup to draw: the fill, the stop and target at the desk's distances.
  const c = fill[0].chart;
  assert.equal(c.entry, 3800.35);
  assert.equal(c.side, 'BUY');
  assert.ok(Math.abs(c.stop - stop) < 1e-9 && c.target > c.entry);
  assert.match(c.title, /^Chen · BUY [\d.]+ XAUUSD @ 3800\.35$/);
  assert.ok(c.bars.length > 0, 'the candles it traded on');
  assert.equal(fill[0].linkKey, link.key);
  live.setChart(link.key, '/api/charts/2026-10-01/101400-x.png');
  assert.equal(live.view().positions.find((x) => x.ticket === 9401).chart, '/api/charts/2026-10-01/101400-x.png');
  sync();
  assert.equal(alerts.filter((a) => /bought/.test(a.text)).length, 1, 'once');

  // Closed: the P&L counts every deal of the position, the entry's commission included.
  mt5.positions = [];
  mt5.deals = [{ position: 9401, entry: 0, pnl: -0.34 }, { position: 9401, entry: 1, pnl: 10.45 }];
  for (let i = 0; i < 3; i++) sync();
  const close = alerts.find((a) => /closed XAUUSD/.test(a.text));
  assert.match(close.text, /Chen closed XAUUSD \+\$10\.11/);
  assert.match(close.text, /🟢 Chen XAUUSD \+\$10\.11/);
  assert.equal(live.reports.current.trades.at(-1).pnl, 10.11);
});

test('the list of the day\'s trades reads like MT5\'s history', async () => {
  const { tradesListText, dailyAlertText } = await import('../server/live/liveTrader.js');
  const { summarize } = await import('../server/live/dailyReport.js');
  // The boss's trades on 1 October (MT5 history), net of commission.
  const day = [['Lucas', 'USOIL.cash', 10.11], ['Chen', 'ETHUSD', -1.01], ['Marcus', 'US100.cash', 6.2], ['Chen', 'ETHUSD', -3.39], ['Jake', 'GBPUSD', 9.82], ['Marcus', 'US100.cash', 4.21], ['Lucas', 'USOIL.cash', 8.57]];
  const list = day.map(([name, symbol, pnl]) => ({ name, symbol, pnl, r: null }));
  const text = tradesListText(list, { accountToday: 31.2 });
  assert.equal(text, [
    'Today on FTMO · 7 closed trades, 5 won:',
    '🟢 Lucas USOIL.cash +$10.11',
    '🔴 Chen ETHUSD -$1.01',
    '🟢 Marcus US100.cash +$6.20',
    '🔴 Chen ETHUSD -$3.39',
    '🟢 Jake GBPUSD +$9.82',
    '🟢 Marcus US100.cash +$4.21',
    '🟢 Lucas USOIL.cash +$8.57',
    'Closed trades: +$34.51 · account today +$31.20 (with open trades)',
  ].join('\n'));
  // A long day keeps the message short: the latest 15, and how many came before.
  const many = Array.from({ length: 20 }, (_, i) => ({ name: 'Ryan', symbol: 'XAUUSD', pnl: i % 2 ? 2 : -1, r: null }));
  assert.match(tradesListText(many), /… 5 earlier/);
  // The end-of-day report on the phone lists them too.
  const report = { day: '2026.10.01', account: { dayPnl: 32.15 }, desks: { lucas: { name: 'Lucas Meyer', trades: 1, wins: 1, pnl: 10.11, sumR: 0.5, countR: 1 } }, skipped: {}, events: [],
    trades: [{ agentId: 'lucas', symbol: 'USOIL.cash', pnl: 10.11, r: 0.5, openedAt: 1, closedAt: 2 }] };
  assert.match(dailyAlertText(summarize(report)), /Trades · 1 closed trade, 1 won:\n🟢 Lucas USOIL\.cash \+\$10\.11 \(\+0\.5R\)/);
});

test('why a desk entered, in a few lines: its setup, the evidence, its checklist, the committee and the floor\'s memory', async () => {
  const { entryReasons, brainLevels } = await import('../server/live/liveTrader.js');
  const plan = {
    reason: 'London scalp: ran the Asia low, trapped and shifted',
    thesis: 'London scalp: ran the Asia low. Why: the higher-timeframe trend is up, with the trade; structure agrees.',
    checklist: ['Inside the London killzone', 'Asia low swept', 'Closed back inside'],
    debate: 'd1',
  };
  const committee = { debates: [{ id: 'd1', factors: { memory: { text: "the floor's memory: 14 trades like this (XAUUSD, with the trend, wild, London) averaged +0.42R, 64% won" } },
    messages: [{ from: 'ryan', role: 'proposes' }, { from: 'mia', role: 'reviews', stance: 'agree' }, { from: 'lucas', role: 'reviews', stance: 'cautious' }, { from: 'elena', role: 'decides', text: 'Approved, full size (score 0.41). Room to run.' }] }] };
  const names = { mia: 'Mia', lucas: 'Lucas', elena: 'Elena' };
  assert.deepEqual(entryReasons(plan, committee, (id) => names[id]), [
    'Why: London scalp: ran the Asia low, trapped and shifted',
    'The case: the higher-timeframe trend is up, with the trade; structure agrees',
    'Checklist: ✓ Inside the London killzone ✓ Asia low swept ✓ Closed back inside',
    'Committee: Mia agrees · Lucas is cautious · Elena: Approved, full size (score 0.41)',
    'Memory: 14 trades like this (XAUUSD, with the trend, wild, London) averaged +0.42R, 64% won',
  ]);
  assert.deepEqual(entryReasons(null, committee), []);
  assert.deepEqual(brainLevels({ resistance: [{ label: 'VWAP', price: 2 }, { label: 'session high', price: 3 }, { label: 'x', price: 4 }], support: [{ label: 'session low', price: 1 }] }).map((l) => l.label), ['VWAP', 'session high', 'session low']);
});

// ---- FTMO 1-Step rules ------------------------------------------------------------------------
test('FTMO 1-Step: 3% daily, a max loss that trails the best end-of-day balance, and the stricter rules until the program is set', () => {
  const one = normalizeProfile({ program: '1-step', type: 'trial', size: 10_000 });
  assert.equal(one.dailyLossPct, 3);
  assert.equal(one.maxLossPct, 10);
  assert.equal(normalizeProfile({ program: '1-step', type: 'verification' }).type, 'challenge', '1-Step has no Verification');
  const unknown = normalizeProfile({ type: 'trial', size: 10_000, dailyLossPct: 5 });
  assert.equal(unknown.program, null);
  assert.equal(unknown.dailyLossPct, 3, 'not told yet: the stricter daily limit');
  assert.equal(programRules(unknown).trailing, true);

  // The line trails the best end-of-day balance: $10,400 → equity may not go below $9,400.
  let m = guardMetrics(one, { balance: 10_200, equity: 9_800, closedToday: -100 }, 0, { peakBalance: 10_400 });
  assert.equal(m.dayStartBalance, 10_300);
  assert.equal(m.dailyFloor, 10_000); // 3% of the $10,000 start below today's $10,300 start
  assert.equal(m.maxFloor, 9_400);
  assert.equal(m.totalLoss, 600);
  assert.equal(m.maxUsed, 0.6);
  // …and stops rising once it reaches the starting balance.
  assert.equal(guardMetrics(one, { balance: 11_800, equity: 11_800 }, 0, { peakBalance: 11_800 }).maxFloor, 10_000);
  // Today's start is an end-of-day balance too.
  assert.equal(guardMetrics(one, { balance: 10_500, equity: 10_500 }).maxFloor, 9_500);

  // 2-Step: fixed at the start.
  const two = normalizeProfile({ program: '2-step', type: 'trial', size: 10_000 });
  m = guardMetrics(two, { balance: 10_200, equity: 9_800, closedToday: -100 }, 0, { peakBalance: 10_400 });
  assert.equal(m.maxFloor, 9_000);
  assert.equal(m.totalLoss, 200);
  assert.equal(m.dailyFloor, 9_800);
});

test('the Best Day rule: the best day as a share of all winning days, and what it takes to pass', () => {
  const c = bestDayCheck([{ day: 'a', pnl: 400 }, { day: 'b', pnl: 100 }, { day: 'c', pnl: -50 }, { day: 'd', pnl: 200 }], 50);
  assert.equal(c.total, 700);
  assert.equal(c.best.day, 'a');
  assert.equal(Math.round(c.share * 100), 57);
  assert.equal(c.ok, false);
  assert.equal(c.needed, 100, '$400 is 50% of $800: $100 more on other days');
  assert.equal(c.winningDays, 3);
  assert.equal(bestDayCheck([{ pnl: 300 }, { pnl: 300 }]).ok, true, 'exactly 50% passes');
  assert.deepEqual([bestDayCheck([]).share, bestDayCheck([]).ok], [null, true]);
});

test('the FTMO tab asks which program; 1-Step trails the best end-of-day balance the floor has seen', () => {
  const { live, sync, mt5 } = setup();
  // Two earlier days on this account (and one on another account), from the daily reports.
  live.reports.snapshot('2026.09.26', { login: 999, server: 'FTMO-Demo', startBalance: 100_000, balance: 150_000, equity: 150_000 });
  live.reports.snapshot('2026.09.27', { login: 555, server: 'FTMO-Demo', startBalance: 100_000, balance: 100_900, equity: 100_900 });
  live.reports.snapshot('2026.09.28', { login: 555, server: 'FTMO-Demo', startBalance: 100_900, balance: 101_500, equity: 101_500 });
  Object.assign(mt5, { balance: 101_300, equity: 101_300, closedToday: -200 }); // today started at $101,500
  sync();
  live.setup({ type: 'trial', training: false, size: 100_000 });
  sync();
  let v = live.view();
  assert.equal(v.plan.program, null);
  assert.equal(v.profile.dailyLossPct, 3, 'the stricter daily limit until the boss says');
  assert.ok(v.plan.rules.some((r) => /Which FTMO program is this account/.test(r.text) && !r.ok));
  assert.equal(v.metrics.maxFloor, 91_500, 'best end-of-day $101,500 − $10,000');
  assert.ok(v.programs['1-step'] && v.programs['2-step']);

  assert.equal(live.setProgram('2-step').ok, true);
  v = live.view();
  assert.equal(v.profile.dailyLossPct, 5);
  assert.equal(v.metrics.maxFloor, 90_000);
  assert.equal(v.metrics.trailing, false);
  assert.equal(v.plan.bestDay, null, 'no Best Day rule on 2-Step');
  assert.equal(v.plan.rules.some((r) => /Which FTMO program/.test(r.text)), false);

  assert.equal(live.setProgram('1-step').ok, true);
  assert.match(live.setProgram('3-step').error, /2-Step or 1-Step/);
  v = live.view();
  assert.equal(v.profile.dailyLossPct, 3);
  assert.equal(v.metrics.maxFloor, 91_500);
  assert.match(v.plan.rules.find((r) => /Max loss line/.test(r.text)).text, /stay above \$91,500/);
  assert.match(v.plan.goal, /3% daily or 10% max loss \(trailing\), no day over 50% of the profit/);

  // The best end-of-day balance never goes down, and is remembered.
  Object.assign(mt5, { balance: 100_800, equity: 100_800, closedToday: -700 });
  sync();
  assert.equal(live.view().metrics.maxFloor, 91_500);
  assert.equal(live.state.peaks['555'], 101_500);

  // Best Day: +$900 and +$600 on the earlier days, today −$700: the best is 60% of $1,500.
  const b = live.view().plan.bestDay;
  assert.equal(b.total, 1_500);
  assert.equal(Math.round(b.share * 100), 60);
  assert.equal(b.ok, false);
  assert.equal(b.needed, 300);
  assert.equal(b.dayCap, 5_000, 'half the $10,000 target');
  assert.ok(live.view().plan.rules.find((r) => /Best Day rule/.test(r.text)).ok, 'not a problem until the target is reached');
});

test('1-Step: a day stops at half the target, training too; the target only counts once the Best Day rule is met', async () => {
  const { fund, live, sync, mt5 } = setup();
  Object.assign(mt5, { balance: 105_100, equity: 105_100, closedToday: 5_100 });
  sync();
  live.setup({ program: '1-step', type: 'trial', size: 100_000 });
  sync();
  assert.equal(live.profile.training, true);
  assert.equal(live.arm().ok, true);
  const st = live.brain.state();
  assert.match(st.blocked, /Best Day rule: \+\$5,100 today, half the target's profit/);
  const amara = fund.byId.get('amara');
  assert.equal(amara.openTrade({ side: 'LONG', stop: 3790, target: 3830, reason: 'sweep', symbol: 'XAUUSD' }), true);
  await tick();
  live.reconcile();
  assert.deepEqual(live.view().today.reasons, [['FTMO Best Day rule', 1]], 'held back even while training');
  assert.equal(live.view().desks.find((d) => d.id === 'amara').status.state, 'stopped');

  // Past the 10% target with one $8,000 day: not locked in, the desks trade on at half risk.
  const b = setup();
  b.live.reports.snapshot('2026.09.28', { login: 555, server: 'FTMO-Demo', startBalance: 100_000, balance: 108_000, equity: 108_000 });
  Object.assign(b.mt5, { balance: 110_500, equity: 110_500, closedToday: 2_500 });
  b.sync();
  b.live.setup({ program: '1-step', type: 'trial', training: false, size: 100_000 });
  b.sync();
  assert.equal(b.live.halt, null, 'not locked in yet');
  const s2 = b.live.brain.state();
  assert.equal(s2.bestDayPending, true);
  assert.ok(s2.reasons.some((r) => /Best Day rule needs about \$5,500 more on other days: half risk/.test(r)), s2.reasons.join(' | '));
  assert.ok(b.live.events.some((e) => /Best Day rule isn't met yet: the best day \(\+\$8,000\) is 76%/.test(e.text)));
  // Another good day brings the best day down to half: now it's locked in.
  Object.assign(b.mt5, { balance: 116_000, equity: 116_000, closedToday: 8_000 });
  b.sync();
  assert.equal(b.live.halt?.kind, 'target');
  assert.match(b.live.halt.reason, /and the Best Day rule is met/);
});

test('order actions are counted per FTMO day, survive a restart, and new trades stop far below FTMO\'s 2,000', async () => {
  const br = new Mt5Bridge();
  br.handleSync({ account: { login: 1 }, serverDay: '2026.09.29' });
  br.open({ symbol: 'XAUUSD', side: 'BUY', volume: 0.1, slDistance: 5, magic: 1, comment: 'x' }, {});
  br.modify(1, 3790, 'keep', {});
  br.close(1, 1, {});
  assert.equal(br.actionsToday(), 3);
  br.positions = [{}, {}];
  br.closeAll({});
  assert.equal(br.actionsToday(), 5, 'closing everything is one request per position');
  br.handleSync({ serverDay: '2026.09.30' });
  assert.equal(br.actionsToday(), 0, 'a new FTMO day starts at zero');

  const a = setup();
  a.sync();
  a.live.setup({ program: '2-step', type: 'trial', training: false, size: 100_000 });
  a.live.setDesk('chen', true);
  assert.equal(a.live.arm().ok, true);
  a.bridge.actions = { day: '2026.09.29', n: 1_000 };
  assert.deepEqual(a.live.view().today.actions, { n: 1_000, ftmo: 2_000, newTrades: 1_000, stopMoves: 1_500 });
  assert.equal(a.chen.handleSignal({ action: 'buy', symbol: 'XAUUSD', stop: 3795, target: 3810 }).ok, true);
  await tick();
  a.live.reconcile();
  assert.deepEqual(a.live.view().today.reasons, [['FTMO order-action limit', 1]]);
  assert.equal(a.sync().filter((c) => c[0] === 'open').length, 0);
  a.live.save();
  await new Promise((r) => setTimeout(r, 300));
  const b = setup({ dataDir: a.dataDir });
  b.sync();
  assert.equal(b.bridge.actionsToday(), 1_000, 'the count survives a restart of the floor');
});

test('the Today card shows FTMO\'s own limits in one line: actions, both loss lines, the Best Day rule', async () => {
  const { ftmoLine } = await import('../public/js/ui/todayCard.js');
  const { live, sync, mt5 } = setup();
  live.reports.snapshot('2026.09.28', { login: 555, server: 'FTMO-Demo', startBalance: 100_000, balance: 100_900, equity: 100_900 });
  Object.assign(mt5, { balance: 101_200, equity: 101_200, closedToday: 300 });
  sync();
  live.setup({ type: 'trial', training: false, size: 100_000 });
  sync();
  let html = ftmoLine(live.view());
  assert.match(html, /FTMO program not set: <b>the stricter 1-Step limits apply<\/b>/);
  assert.match(html, /Order actions today <b class="num">0<\/b> of FTMO's 2,000/);
  assert.match(html, /Daily loss line <b class="num">\$97,900<\/b>/);
  assert.match(html, /Max loss line <b class="num">\$90,900<\/b><small>trails the best end-of-day balance/);
  assert.match(html, /Best Day rule <b class="num">75%<\/b><small>best day \+\$900 of \$1,200/);
  live.setProgram('2-step');
  html = ftmoLine(live.view());
  assert.match(html, /FTMO 2-Step/);
  assert.match(html, /Max loss line <b class="num">\$90,000<\/b><small>fixed at the start/);
  assert.doesNotMatch(html, /Best Day/);
});

// ---- the institutional framework: costs and risk limits -----------------------------------------
test('transaction costs in R: the spread and the commission both ways, the same at any size', () => {
  const gold = { ...GOLD, bid: 3800, ask: 3800.2 };
  // $5 stop: $500 per lot; $2.50 per lot per side → 0.01R; spread 0.2 → 0.04R.
  assert.deepEqual(tradeCost(gold, 5, 2.5), { spreadR: 0.04, commissionR: 0.01, totalR: 0.05, commissionKnown: true });
  // A 3-pip EURUSD scalp: 0.8 pips of spread and $5 of commission against $30 of risk per lot.
  const eur = { bid: 1.17, ask: 1.17008, tickSize: 0.00001, tickValue: 1 };
  const c = tradeCost(eur, 0.0003, 2.5);
  assert.equal(c.totalR, 0.43);
  assert.ok(c.totalR > COST_LIMIT_R, 'too expensive for the account');
  assert.equal(tradeCost(eur, 0.0003).commissionKnown, false, 'commission not measured yet: spread only');
  assert.equal(tradeCost(eur, 0), null);
});

test('the account learns the commission from its own fills and refuses trades the costs would eat', async () => {
  // MT5's gold spread is a whole dollar right now (a rollover spike): wider than the floor's usual estimate.
  const { fund, live, sync, mt5 } = setup({ quotes: { XAUUSD: { ...GOLD, bid: 3800, ask: 3801 } } });
  sync();
  live.setup({ program: '2-step', type: 'trial', size: 100_000 }); // training: every desk on
  assert.equal(live.arm().ok, true);
  // MT5's entry deal for a 0.5-lot gold fill: no profit, $1.25 commission → $2.50 per lot per side.
  mt5.deals.push({ ticket: 77, position: 9, symbol: 'XAUUSD', type: 0, entry: 0, volume: 0.5, price: 3800.2, pnl: -1.25, magic: 0 });
  sync();
  sync(); // seen once, counted once
  assert.deepEqual([live.state.costs.XAUUSD.perLot, live.state.costs.XAUUSD.n], [2.5, 1]);

  // A gold trade with a $2 stop: fine at gold's usual costs, so the desk takes it on paper,
  // but MT5's $1 spread right now is half the risk, so it stays off the account.
  const amara = fund.byId.get('amara');
  assert.equal(amara.openTrade({ side: 'LONG', stop: 3798.1, target: 3806, reason: 'tight', symbol: 'XAUUSD' }), true);
  await tick();
  live.reconcile();
  const v = live.view();
  assert.deepEqual(v.today.reasons, [['Costs too high for the stop', 1]]);
  assert.match(v.today.recent[0].reason, /costs would eat 0\.\d\dR before it starts \(spread 0\.\d\dR \+ commission 0\.\d\dR\), over the 0\.4R limit/);
  assert.equal(sync().filter((c) => c[0] === 'open').length, 0);

  // A normal stop goes, and the entry alert says what it costs.
  const alerts = [];
  live.on('alert', (a) => alerts.push(a));
  amara.closeTrade('XAUUSD', 'test');
  amara.cooldownBars = 0;
  assert.equal(amara.openTrade({ side: 'LONG', stop: 3790, target: 3830, reason: 'room', symbol: 'XAUUSD' }), true);
  await tick();
  live.reconcile();
  const open = sync().find((c) => c[0] === 'open');
  assert.ok(open, 'sent to MT5');
  const link = [...live.links.values()].find((l) => l.state === 'pending');
  assert.ok(link.costR > 0 && link.costR < 0.15, `${link.costR}`);
  mt5.acks.push({ id: open[1], ok: true, ticket: 9100, price: 3800.2, volume: Number(open[4]) });
  mt5.positions.push({ ticket: 9100, symbol: 'XAUUSD', side: 'BUY', volume: Number(open[4]), open: 3800.2, sl: 3790, tp: 0, profit: 0, magic: Number(open[7]), comment: open[8] });
  sync();
  assert.match(alerts.find((a) => a.kind === 'trade').text, /Costs 0\.1\dR \(spread 0\.\d\dR \+ commission 0\.0\dR\)/);
});

test('risk limits that hold while training: no flipping, a desk loss limit, and capital that follows results', () => {
  const { fund, live, sync } = setup();
  sync();
  live.setup({ program: '2-step', type: 'trial', size: 100_000 });
  assert.equal(live.arm().ok, true);
  const amara = fund.byId.get('amara');
  const lucas = fund.byId.get('lucas');
  const closed = (key, o) => live.links.set(key, { key, login: '555', state: 'closed', ticket: 1, closedDay: '2026.09.29', openedDay: '2026.09.29', createdAt: Date.now(), ...o });
  const long = { symbol: 'XAUUSD', qty: 1 };
  const short = { symbol: 'XAUUSD', qty: -1 };
  assert.equal(live.brain.allow(amara, long, {}).ok, true);

  // The account just lost on a short gold: no long gold for 30 minutes, from any desk.
  closed('s1', { agentId: 'lucas', floorSymbol: 'XAUUSD', side: 'SELL', pnl: -40, risk: 50, closedAt: Date.now() - 10 * 60_000 });
  assert.match(live.brain.allow(amara, long, {}).reason, /just lost on a short XAUUSD \(10 min ago\): no flipping to the other side within 30 minutes/);
  assert.equal(live.brain.allow(amara, short, {}).ok, true, 'the same side is fine');
  assert.equal(live.brain.allow(amara, long, { tag: 'TV' }).ok, false, 'your own alerts too: it is a risk rule');
  live.links.get('s1').closedAt = Date.now() - 31 * 60_000;
  assert.equal(live.brain.allow(amara, long, {}).ok, true, 'after 30 minutes it may');

  // Lucas has lost 2× his full risk ($250 on $100,000 at 0.25%) today: off the account until tomorrow.
  closed('l1', { agentId: 'lucas', floorSymbol: 'USOIL', side: 'BUY', pnl: -260, risk: 250, closedAt: Date.now() - 3 * 3_600_000 });
  closed('l2', { agentId: 'lucas', floorSymbol: 'USOIL', side: 'BUY', pnl: -250, risk: 250, closedAt: Date.now() - 3 * 3_600_000 });
  assert.match(live.brain.allow(amara, long, {}).reason, /3 losses in a row on the account: a 2-hour cool-off/, 'three losers in a row: the whole account cools off');
  closed('w1', { agentId: 'priya', floorSymbol: 'EURUSD', side: 'BUY', pnl: 30, risk: 50, closedAt: Date.now() - 60_000 });
  const v = live.brain.allow(lucas, { symbol: 'USOIL', qty: 1 }, {});
  assert.match(v.reason, /desk loss limit: -\$550 on the account today, 2× its full risk of \$250\. Off the account until tomorrow/);
  assert.equal(live.brain.deskStatus(lucas).label, 'Desk limit');
  assert.equal(live.brain.allow(amara, long, {}).ok, true, 'other desks trade on');
  assert.equal(live.brain.allow(lucas, { symbol: 'USOIL', qty: 1 }, { tag: 'TV' }).ok, true, 'your own alerts through his desk are your call');

  // Amara's last 8 account trades lost 0.2R each after costs: half size until she earns it back.
  const before = live.brain.allow(amara, long, {}).riskMult;
  for (let i = 0; i < 8; i++) closed(`a${i}`, { agentId: 'amara', floorSymbol: 'XAUUSD', side: 'BUY', pnl: -10, risk: 50, closedAt: Date.now() - (5 - i * 0.1) * 3_600_000, closedDay: '2026.09.28' });
  const after = live.brain.allow(amara, long, {});
  assert.ok(Math.abs(after.riskMult - before * 0.5) < 1e-9, `${after.riskMult} = half of ${before}`);
  assert.ok(after.reasons.some((r) => /Amara's last 8 account trades made −0\.20R each after costs: half size until it earns it back/.test(r)));
  assert.equal(live.brain.deskStatus(amara).label, 'Training · half size');
  // Two good trades turn the record positive again.
  closed('a8', { agentId: 'amara', floorSymbol: 'XAUUSD', side: 'BUY', pnl: 120, risk: 50, closedAt: Date.now() - 3_600_000, closedDay: '2026.09.28' });
  assert.equal(live.brain.allocation(amara).mult, 1);
  assert.ok(live.view().plan.rules.some((r) => /Capital follows results/.test(r.text)));
});

test('every desk refuses a trade its costs would eat, on paper too, and says what stop it needs', async () => {
  const { roundTripCostBps, tradeCostR } = await import('../server/market/symbols.js');
  // Costs as FTMO charges them: FX a few tenths of a pip plus $2.50 a lot a side; crypto 0.0325% a side.
  assert.ok(Math.abs(roundTripCostBps('EURUSD') - 0.875) < 1e-9);
  assert.ok(roundTripCostBps('BTCUSD') > 10, 'crypto is expensive on a prop account');
  assert.ok(Math.abs(roundTripCostBps('NAS100') - 0.9) < 1e-9, 'indices: the spread only');
  // A 1.5-pip EURUSD stop gives about two thirds of its risk to costs; a 10-pip stop under a tenth.
  assert.ok(tradeCostR('EURUSD', 1.17, 1.16985) > 0.6);
  assert.ok(tradeCostR('EURUSD', 1.17, 1.169) < 0.11);

  const { fund } = setup();
  const amara = fund.byId.get('amara');
  // Gold at 3,800: a round trip costs about $0.42, so a 50-cent stop is mostly costs.
  assert.equal(amara.openTrade({ side: 'LONG', stop: 3799.6, target: 3801.6, reason: 'tight', symbol: 'XAUUSD' }), false);
  assert.match(amara.day.whyNot.text, /turned down: costs would eat 0\.\d\dR \(spread, slippage and commission\): the stop is too tight for XAUUSD, it needs at least 1\.\d\d/);
  assert.deepEqual([amara.day.ideas, amara.day.vetoed], [1, 1]);
  // The same signal on the next bar isn't a new idea.
  assert.equal(amara.openTrade({ side: 'LONG', stop: 3799.6, target: 3801.6, reason: 'tight', symbol: 'XAUUSD' }), false);
  assert.equal(amara.day.ideas, 1);
  // A stop with room is taken as planned.
  assert.equal(amara.openTrade({ side: 'LONG', stop: 3790, target: 3830, reason: 'room', symbol: 'XAUUSD' }), true);
  assert.equal(amara.plans.get('XAUUSD').stop, 3790);
  amara.closeTrade('XAUUSD', 'test');
  amara.cooldownBars = 0;
  // A $1.20 stop costs about 0.35R: the desk widens it until costs are 0.25R, the target moves
  // out by the same factor (same reward-to-risk), and the size shrinks with it.
  const entry = amara.price('XAUUSD');
  assert.equal(amara.openTrade({ side: 'LONG', stop: entry - 1.2, target: entry + 2.4, reason: 'a bit tight', symbol: 'XAUUSD' }), true);
  const plan = amara.plans.get('XAUUSD');
  const k = tradeCostR('XAUUSD', entry, entry - 1.2) / 0.25;
  assert.ok(k > 1.2 && k < 1.6, `${k}`);
  assert.ok(Math.abs(plan.initialStop - (entry - 1.2 * k)) < 0.01, `stop ${plan.initialStop}`);
  assert.ok(Math.abs(plan.target - (entry + 2.4 * k)) < 0.01, `target ${plan.target}`);
  amara.closeTrade('XAUUSD', 'test');
  // Your own TradingView alerts are your call.
  const chen = fund.byId.get('chen');
  chen.symbols.push('XAUUSD');
  assert.equal(chen.openTrade({ side: 'SHORT', stop: 3800.6, reason: 'boss alert', symbol: 'XAUUSD', tag: 'TV' }), true);
});

test('the paper broker charges each market its own commission', () => {
  const { fund } = setup();
  fund.md.applyTick('BTCUSD', 100_000, 1, Date.now());
  const fill = fund.broker.execute('viktor', 'BTCUSD', 1);
  // 0.0325% of a $100,000 trade, as FTMO charges crypto.
  assert.ok(Math.abs(fill.fill.fee - 32.5) < 0.2, `${fill.fill.fee}`);
  const fx = fund.broker.execute('priya', 'EURUSD', 100_000);
  if (fx) assert.ok(fx.fill.fee < 5, 'FX: about $2.50 a lot a side');
});

test('a desk earns its place on the account with its form: out of form, it trades paper only until it recovers', () => {
  const { fund, live, sync } = setup();
  sync();
  live.setup({ program: '2-step', type: 'trial', size: 100_000, practiceAll: false }); // training: every desk on
  assert.equal(live.arm().ok, true);
  const ryan = fund.byId.get('ryan');
  const gold = { symbol: 'XAUUSD', qty: 1 };
  // Its trades on real prices are remembered (simulated-feed trades never count).
  ryan.lifetime.recentR = [];
  ryan.onTradeClosed({ id: 'a', symbol: 'XAUUSD', pnl: -100, r: -1, exitReason: 'Stop loss' });
  ryan.onTradeClosed({ id: 'b', symbol: 'XAUUSD', pnl: -100, r: -1, exitReason: 'Stop loss', simFeed: true });
  assert.deepEqual(ryan.lifetime.recentR, [-1]);
  assert.equal(live.brain.allow(ryan, gold, {}).ok, true, 'one or two trades say little');
  ryan.lifetime.recentR = [-1, -1.1, 0.8];
  const v = live.brain.allow(ryan, gold, {});
  assert.match(v.reason, /out of form: Ryan's last 3 trades on real prices averaged −0\.43R\. Paper only until that's back to 0R or better/);
  assert.equal(live.brain.deskStatus(ryan).label, 'Paper · out of form');
  assert.equal(live.brain.allow(ryan, gold, { tag: 'TV' }).ok, true, 'your own alerts are your call');
  // A good paper trade lifts the average back over 0R: on the account again.
  ryan.lifetime.recentR.push(1.5);
  assert.equal(live.brain.allow(ryan, gold, {}).ok, true);
  // Only the last 20 count.
  ryan.lifetime.recentR = [-5, ...Array(20).fill(0.1)];
  assert.equal(live.brain.form(ryan).ok, true);
  assert.ok(live.view().plan.rules.some((r) => /Desks earn their place/.test(r.text)));
});

test('a desk saved before it kept its form starts it from its learning journal', () => {
  const { fund } = setup();
  const amara = fund.byId.get('amara');
  amara.learner.state.journal = [{ t: 1, r: 0.5 }, { t: 2, r: -1 }, { t: 3, r: 2 }];
  fund.restore({ version: 1, dayKey: 'x', agents: { amara: { lifetime: { trades: 3, realN: 3, realSumR: 1.5 }, learning: amara.learner.state } } });
  assert.deepEqual(amara.lifetime.recentR, [0.5, -1, 2]);
  // Saved with its form: kept as it was.
  fund.restore({ version: 1, dayKey: 'x', agents: { amara: { lifetime: { recentR: [1] }, learning: amara.learner.state } } });
  assert.deepEqual(amara.lifetime.recentR, [1]);
});

test('capital follows the nightly review: no edge on your prices is paper only, unclear is half size', async () => {
  const { fund, live, sync } = setup();
  sync();
  live.setup({ program: '2-step', type: 'trial', size: 100_000, practiceAll: false }); // training: every desk on
  assert.equal(live.arm().ok, true);
  const verdicts = {
    marcus: { id: 'marcus', n: 21, avgR: -0.56, verdict: 'no edge' },
    amara: { id: 'amara', n: 40, avgR: 0.03, verdict: 'unclear' },
    nico: { id: 'nico', n: 31, avgR: 0.42, verdict: 'EDGE' },
    jake: { id: 'jake', n: 6, avgR: 0.5, verdict: 'too few trades to tell' },
  };
  const report = { at: Date.now() - 2 * 3_600_000, tradingDays: 18 };
  live.review = { verdictFor: (id) => verdicts[id] || null, report, current: () => report };
  const brain = live.brain;
  const m = fund.byId.get('marcus');
  const v = brain.allow(m, { symbol: 'NAS100', qty: 1 }, {});
  assert.equal(v.ok, false, 'even while training');
  assert.match(v.reason, /the nightly review found no edge on your prices \(−0\.56R a trade over 21 trades\): paper only until a review finds one/);
  assert.equal(brain.deskStatus(m).label, 'Paper · no edge');
  assert.equal(brain.allow(m, { symbol: 'NAS100', qty: 1 }, { tag: 'TV' }).ok, true, 'your own alerts are your call');

  const full = brain.allow(fund.byId.get('nico'), { symbol: 'NAS100', qty: 1 }, {});
  const half = brain.allow(fund.byId.get('amara'), { symbol: 'XAUUSD', qty: 1 }, {});
  assert.equal(full.ok && half.ok, true);
  assert.ok(Math.abs(half.riskMult - full.riskMult * 0.5) < 1e-9, `${half.riskMult} vs ${full.riskMult}`);
  assert.ok(half.reasons.some((r) => /Amara is unproven on your prices \(\+0\.03R a trade over 40 trades in the nightly review\): half size/.test(r)));
  assert.equal(brain.deskStatus(fund.byId.get('amara')).label, 'Training · half size');
  assert.equal(brain.deskStatus(fund.byId.get('nico')).label, 'Training · proven');
  assert.equal(brain.allow(fund.byId.get('jake'), { symbol: 'GBPUSD', qty: 1 }, {}).riskMult, full.riskMult, 'too few trades: unchanged');
  assert.ok(live.view().plan.rules.some((r) => /Evidence first: every night each desk is replayed on your own prices \(last review 2 h ago, 18 trading days\)/.test(r.text)));
  // Reviews stopped for days: flagged, and the old verdicts still decide.
  report.at = Date.now() - 6 * 86_400_000;
  live.review.current = () => null;
  const stale = live.view().plan.rules.find((r) => /Evidence first/.test(r.text));
  assert.equal(stale.ok, false);
  assert.match(stale.text, /the last nightly review is 6 days ago, so the reviews have stopped .* Its verdicts still apply until a new one runs/);
  assert.equal(brain.allow(m, { symbol: 'NAS100', qty: 1 }, {}).ok, false, 'Marcus stays off the account');

  // The review's "use the best risk" button.
  assert.equal(live.setRisk(0.75).ok, true);
  assert.equal(live.profile.riskPerTradePct, 0.75);
  assert.match(live.setRisk(5).error, /between 0\.01% and 2%/);
  assert.equal(live.setRisk('abc').ok, false);
  assert.equal(live.profile.riskPerTradePct, 0.75, 'a refused change leaves the risk as it was');
});

test('the review card: verdicts, what they mean for the account, and the odds at each risk', async () => {
  const { renderReview, riskAdvice } = await import('../public/js/ui/reviewCard.js');
  const sim = {
    trades: 92, avgR: 0.21, tradesPerDay: 4.1,
    rows: [{ riskPct: 0.25, passed: 0.31, failed: 0.02, open: 0.67, medianDays: 44 }, { riskPct: 0.5, passed: 0.68, failed: 0.12, open: 0.2, medianDays: 21 }, { riskPct: 1, passed: 0.52, failed: 0.48, open: 0, medianDays: 9 }],
    best: { riskPct: 0.5, passed: 0.68 },
  };
  assert.deepEqual(riskAdvice(sim, 0.25).worth, true);
  assert.deepEqual(riskAdvice(sim, 0.5).worth, false, 'already at the best');
  const v = {
    mode: 'live', profile: { riskPerTradePct: 0.25, program: '1-step', size: 10_000 },
    review: {
      running: null, lastError: null, fresh: true,
      report: {
        at: Date.now() - 3 * 3_600_000, tookMs: 240_000, program: '1-step', size: 10_000, tradingDays: 18,
        desks: [
          { id: 'nico', name: 'Nico Rossi', desk: 'Scalping · NAS100 New York', symbol: 'NAS100', n: 31, winRate: 0.68, avgR: 0.42, ci: [0.08, 0.77], verdict: 'EDGE' },
          { id: 'marcus', name: 'Marcus Reid', desk: 'Index Futures', symbol: 'NAS100', n: 21, winRate: 0.29, avgR: -0.56, ci: [-0.85, -0.25], verdict: 'no edge' },
          { id: 'sofia', name: 'Sofia Laurent', desk: 'Global Macro', symbol: 'USDJPY', n: 0, verdict: 'no saved history' },
        ],
        withEdge: sim, everyone: null,
      },
    },
  };
  const html = renderReview(v);
  assert.match(html, /Nightly review: who has an edge on your prices/);
  assert.match(html, /Last review 3 h ago \(took 4 min\) · 18 trading days of your prices/);
  assert.match(html, /<span class="verdict-chip v-edge">Edge<\/span><\/td>\s*<td>Full size/);
  assert.match(html, /<span class="verdict-chip v-none">No edge<\/span><\/td>\s*<td>Paper only/);
  assert.match(html, /no saved history/);
  assert.match(html, /Chance of passing FTMO 1-step \(\$10,000\), trading the desks with an edge/);
  assert.match(html, /data-act="use-risk" data-risk="0\.5">Use 0\.5% risk a trade/);
  assert.match(html, /The desks with an edge pass 68% of simulated challenges at 0\.5% risk/);
  // The account changed program since the review: the odds don't fit it, nothing is suggested.
  const moved = renderReview({ ...v, profile: { ...v.profile, program: '2-step' } });
  assert.match(moved, /These odds are for FTMO 1-step \$10,000; your account is now 2-step \$10,000\. Press Run now/);
  assert.doesNotMatch(moved, /data-act="use-risk"/);
  // Every size fails (one lucky pass in 4,000 at 1.5%): no "best" and no time to pass.
  const hopeless = { rows: [{ riskPct: 0.25, passed: 0, failed: 1, open: 0, medianDays: null }, { riskPct: 1.5, passed: 0.00025, failed: 0.99975, open: 0, medianDays: 4 }], best: { riskPct: 1.5, passed: 0.00025 }, trades: 220, avgR: -0.2, tradesPerDay: 44 };
  const none = renderReview({ ...v, review: { ...v.review, report: { ...v.review.report, withEdge: null, everyone: hopeless } } });
  assert.match(none, /with every desk \(none has an edge yet\)/);
  assert.doesNotMatch(none, /class="b">best/);
  assert.doesNotMatch(none, /~4 days/);
  assert.doesNotMatch(none, /data-act="use-risk"/);
  // Running, and no review yet.
  const first = renderReview({ mode: 'live', profile: { riskPerTradePct: 0.5 }, review: { running: { startedAt: Date.now(), line: 'Nico Rossi on NAS100 (9,000 bars)…' }, report: null, fresh: false } });
  assert.match(first, /Reviewing…/);
  assert.match(first, /Nico Rossi on NAS100/);
  assert.match(first, /No review yet/);
  // A failed review says when the floor tries again.
  const failed = renderReview({ mode: 'live', profile: { riskPerTradePct: 0.5 }, review: { running: null, lastError: { text: 'took too long and was stopped' }, retryAt: Date.now() + 30 * 60_000, report: null, fresh: false } });
  assert.match(failed, /The last review didn't finish: took too long and was stopped\. The floor tries again by itself in 30 min\./);
});

test('end to end: a review on disk takes a desk off the account, and the Today card says why', async () => {
  const { EdgeReview } = await import('../server/live/review.js');
  const { fund, live, sync, dataDir } = setup();
  // The review npm run edge (or last night's) saved: Amara has no edge on these prices.
  fs.writeFileSync(path.join(dataDir, 'edge-report.json'), JSON.stringify({
    at: Date.now() - 3_600_000, program: '2-step', size: 100_000, tradingDays: 15, seeds: 2,
    desks: [{ id: 'amara', name: 'Amara Okafor', desk: 'Metals', symbol: 'XAUUSD', n: 40, avgR: -0.31, winRate: 0.4, ci: [-0.6, -0.02], halves: [-0.3, -0.32], verdict: 'no edge' }],
    withEdge: null, everyone: null,
  }));
  live.review = new EdgeReview({ dataDir, log: { info() {}, warn() {} } });
  sync();
  live.setup({ program: '2-step', type: 'trial', size: 100_000, practiceAll: false });
  assert.equal(live.arm().ok, true);
  const amara = fund.byId.get('amara');
  assert.equal(amara.openTrade({ side: 'LONG', stop: 3790, target: 3830, reason: 'sweep', symbol: 'XAUUSD' }), true, 'she still trades on paper');
  await tick();
  live.reconcile();
  assert.equal(sync().filter((c) => c[0] === 'open').length, 0, 'nothing went to MT5');
  const v = live.view();
  assert.deepEqual(v.today.reasons, [['No edge on your prices', 1]]);
  assert.equal(v.desks.find((d) => d.id === 'amara').status.label, 'Paper · no edge');
  assert.equal(v.review.report.desks[0].verdict, 'no edge', 'the FTMO tab gets the review');
  // A new review (written while the floor runs) puts her back on the account within a tick.
  fs.writeFileSync(path.join(dataDir, 'edge-report.json'), JSON.stringify({
    at: Date.now(), program: '2-step', size: 100_000, tradingDays: 16, seeds: 2,
    desks: [{ id: 'amara', name: 'Amara Okafor', desk: 'Metals', symbol: 'XAUUSD', n: 44, avgR: 0.35, winRate: 0.55, ci: [0.05, 0.6], halves: [0.3, 0.4], verdict: 'EDGE' }],
    withEdge: null, everyone: null,
  }));
  fs.utimesSync(path.join(dataDir, 'edge-report.json'), new Date(), new Date(Date.now() + 5000));
  live.review.tick();
  assert.notEqual(live.view().desks.find((d) => d.id === 'amara').status.label, 'Paper · no edge');
  // Unclear, with the account disarmed: the desk table already says it will trade at half size.
  fs.writeFileSync(path.join(dataDir, 'edge-report.json'), JSON.stringify({
    at: Date.now() + 1, program: '2-step', size: 100_000, tradingDays: 16, seeds: 2,
    desks: [{ id: 'amara', name: 'Amara Okafor', desk: 'Metals', symbol: 'XAUUSD', n: 44, avgR: 0.05, winRate: 0.5, ci: [-0.2, 0.3], halves: [0.1, 0], verdict: 'unclear' }],
    withEdge: null, everyone: null,
  }));
  fs.utimesSync(path.join(dataDir, 'edge-report.json'), new Date(), new Date(Date.now() + 10_000));
  live.review.tick();
  live.disarm();
  const st = live.view().desks.find((d) => d.id === 'amara').status;
  assert.equal(st.label, 'Training · half size · not armed');
  assert.match(st.text, /half size/);
});

// ---- the long-run record, research desks proving live, the drawdown cut, months of MT5 history ----

const FROM = Date.UTC(2018, 6, 1) / 1000;
const TO = Date.UTC(2020, 4, 14) / 1000;
const LONG = {
  v: 1, at: Date.now(), source: 'test bars', seed: 1,
  desks: [
    { id: 'amara', name: 'Amara Okafor', symbol: 'XAUUSD', n: 2078, avgR: -0.162, ci: [-0.21, -0.12], from: FROM, to: TO, verdict: 'loses', quarters: { positive: 1, total: 8 } },
    { id: 'lucas', name: 'Lucas Meyer', symbol: 'USOIL', n: 4016, avgR: -0.166, ci: [-0.19, -0.14], from: FROM, to: TO, verdict: 'loses', quarters: { positive: 0, total: 8 } },
    { id: 'nico', name: 'Nico Rossi', symbol: 'NAS100', n: 648, avgR: -0.014, ci: [-0.09, 0.06], from: FROM, to: TO, verdict: 'no edge', quarters: { positive: 4, total: 8 } },
    { id: 'jake', name: 'Jake Morrison', symbol: 'GBPUSD', verdict: 'no history', n: 0 },
  ],
};

test('long run: a desk that lost money over months of real prices stays off the account, even while training', async () => {
  const { Baseline } = await import('../server/live/baseline.js');
  const { skipCategory } = await import('../server/live/dailyReport.js');
  const { fund, live, sync } = setup();
  sync();
  live.setup({ program: '2-step', type: 'trial', size: 100_000, practiceAll: false });
  assert.equal(live.arm().ok, true);
  live.baseline = new Baseline(LONG);
  const brain = live.brain;
  const lucas = fund.byId.get('lucas');
  const v = brain.allow(lucas, { symbol: 'USOIL', qty: 1 }, {});
  assert.equal(v.ok, false, 'training doesn\'t send it');
  assert.match(v.reason, /^Lucas lost money over the long run: −0\.17R a trade over 4,016 trades on 22 months \(Jul 2018 – May 2020\) of real 1-minute prices \(90% range −0\.19R to −0\.14R\)\. Paper only until the nightly review finds a real edge on your own prices$/);
  assert.equal(skipCategory(v.reason), 'Loses over the long run');
  assert.equal(brain.deskStatus(lucas).label, 'Paper · loses long-term');
  assert.equal(brain.allow(lucas, { symbol: 'USOIL', qty: 1 }, { tag: 'TV' }).ok, true, 'your own TradingView alerts are your call');
  // No edge either way over the long run: half size. No long-run record: unchanged.
  const full = brain.allow(fund.byId.get('jake'), { symbol: 'GBPUSD', qty: 1 }, {});
  const nico = brain.allow(fund.byId.get('nico'), { symbol: 'NAS100', qty: 1 }, {});
  assert.equal(full.ok && nico.ok, true);
  assert.ok(Math.abs(nico.riskMult - full.riskMult * 0.5) < 1e-9);
  assert.ok(nico.reasons.some((r) => /Nico has no edge over the long run \(−0\.01R a trade over 648 trades/.test(r)));
  // A hair above zero, the range either side of it: not proven either.
  live.baseline = new Baseline({ ...LONG, desks: LONG.desks.map((d) => (d.id === 'nico' ? { ...d, avgR: 0.002, ci: [-0.08, 0.09], verdict: 'unclear' } : d)) });
  const unclear = brain.allow(fund.byId.get('nico'), { symbol: 'NAS100', qty: 1 }, {});
  assert.ok(Math.abs(unclear.riskMult - full.riskMult * 0.5) < 1e-9);
  assert.ok(unclear.reasons.some((r) => /Nico has no proven edge over the long run \(\+0\.00R a trade over 648 trades/.test(r)));
  live.baseline = new Baseline(LONG);
  // The nightly review on your own prices: only a statistically real edge outweighs the long
  // run, and then at half size; a promising few weeks don't.
  const report = { at: Date.now() - 3_600_000, tradingDays: 20 };
  const recent = {
    amara: { id: 'amara', n: 44, avgR: 0.4, verdict: 'EDGE' },
    lucas: { id: 'lucas', n: 30, avgR: 0.2, verdict: 'promising' },
    nico: { id: 'nico', n: 35, avgR: 0.3, verdict: 'EDGE' },
  };
  live.review = { verdictFor: (id) => recent[id] || null, report, current: () => report };
  const amara = brain.allow(fund.byId.get('amara'), { symbol: 'XAUUSD', qty: 1 }, {});
  assert.equal(amara.ok, true);
  assert.ok(Math.abs(amara.riskMult - full.riskMult * 0.5) < 1e-9);
  assert.ok(amara.reasons.some((r) => /Amara has an edge on your recent prices \(\+0\.40R a trade over 44 trades in the nightly review\) but lost money over the long run .*: half size until the edge lasts/.test(r)));
  assert.equal(brain.allow(lucas, { symbol: 'USOIL', qty: 1 }, {}).ok, false, 'promising isn\'t enough against 4,016 losing trades');
  assert.equal(brain.allow(fund.byId.get('nico'), { symbol: 'NAS100', qty: 1 }, {}).riskMult, full.riskMult, 'no edge long-run, a real edge now: full size');
  // The account's rule list says so, and the FTMO tab gets the record.
  const rule = live.view().plan.rules.find((r) => /^Long-run record/.test(r.text));
  assert.match(rule.text, /each desk was replayed on up to 22 months \(Jul 2018 – May 2020\) of real 1-minute prices\. 2 of the 3 desks on the account lost money there with confidence \(Amara, Lucas\)/);
  const bv = live.view().baseline;
  assert.equal(bv.desks.find((d) => d.id === 'lucas').span, '22 months (Jul 2018 – May 2020)');
  // A broken file is no record at all (the floor runs as before).
  assert.equal(new Baseline({ desks: [{ id: 'lucas', verdict: 'loses', n: 'many' }] }).forDesk('lucas'), null);
  live.baseline = null;
  assert.equal(brain.allow(lucas, { symbol: 'USOIL', qty: 1 }, {}).ok, true);
});

test('practice on the Free Trial: desks the evidence holds back still trade it, small; never on a paid challenge', async () => {
  const { Baseline } = await import('../server/live/baseline.js');
  const { fund, live, sync } = setup();
  sync();
  live.setup({ program: '2-step', type: 'trial', size: 100_000, riskPerTradePct: 0.5 });
  assert.equal(live.profile.practiceAll, true, 'on by default on the Free Trial');
  assert.equal(live.arm().ok, true);
  live.baseline = new Baseline(LONG);
  const brain = live.brain;
  const lucas = fund.byId.get('lucas');
  const full = brain.allow(fund.byId.get('jake'), { symbol: 'GBPUSD', qty: 1 }, {});
  const v = brain.allow(lucas, { symbol: 'USOIL', qty: 1 }, {});
  assert.equal(v.ok, true, 'it trades the trial');
  assert.equal(v.practice, true);
  assert.ok(Math.abs(v.riskMult - full.riskMult * 0.5) < 1e-9, 'at 0.25% a trade, half the 0.5% the account risks');
  assert.ok(v.reasons.some((r) => /^Practice on the Free Trial at 0\.25% a trade: Lucas lost money over the long run/.test(r)));
  assert.equal(brain.deskStatus(lucas).label, 'Practice · loses long-term');
  assert.match(brain.deskStatus(lucas).text, /Practises on the Free Trial at 0\.25% a trade/);
  const plan = live.view().plan;
  assert.equal(plan.practice, true);
  assert.ok(plan.rules.some((r) => /^Practice is ON: desks the evidence holds back/.test(r.text)));
  assert.ok(plan.rules.some((r) => /they practise on the Free Trial at 0\.25% a trade; on a paid challenge, paper only/.test(r.text)));
  // The cool-off and a desk's own loss limit still hold; so does the boss's switch.
  assert.equal(live.setPlan({ practiceAll: false }).ok, true);
  assert.match(brain.allow(lucas, { symbol: 'USOIL', qty: 1 }, {}).reason, /lost money over the long run/);
  assert.equal(brain.deskStatus(lucas).label, 'Paper · loses long-term');
  assert.ok(live.view().plan.rules.some((r) => /^Practice is OFF/.test(r.text)));
  // Practice only means something while training.
  live.setPlan({ practiceAll: true, training: false });
  assert.equal(brain.allow(lucas, { symbol: 'USOIL', qty: 1 }, {}).ok, false);
  // A paid challenge never practises.
  live.setup({ program: '2-step', type: 'challenge', size: 100_000 });
  assert.equal(live.profile.practiceAll, false);
  assert.match(live.setPlan({ practiceAll: true }).error, /Practice is for the Free Trial/);
  assert.equal(brain.allow(lucas, { symbol: 'USOIL', qty: 1 }, {}).ok, false);
  live.baseline = null;
});

test('the shipped long-run record is complete and judged on thousands of real trades', async () => {
  const { loadBaseline, Baseline } = await import('../server/live/baseline.js');
  const data = loadBaseline(undefined, { warn: (m) => assert.fail(m) });
  assert.ok(data, 'server/research/baseline.json is valid');
  const b = new Baseline(data);
  const judged = data.desks.filter((d) => b.forDesk(d.id));
  assert.ok(judged.length >= 8, `${judged.length} desks judged`);
  for (const d of judged) {
    assert.ok(d.n >= 100, `${d.id}: ${d.n} trades`);
    assert.ok(d.to - d.from > 300 * 86_400, `${d.id}: covers most of a year or more`);
    if (d.verdict === 'loses') assert.ok(d.ci[1] < 0, `${d.id}: the whole 90% range below zero`);
  }
});

test('long-run verdicts need confidence', async () => {
  const { judgeLong } = await import('../scripts/baseline.js');
  const t0 = Date.UTC(2019, 0, 1);
  const mk = (rs) => rs.map((r, i) => ({ r, time: t0 + i * 86_400_000, grossR: r + 0.05, costR: 0.05 }));
  const seq = (n, f) => Array.from({ length: n }, (_, i) => f(i));
  assert.equal(judgeLong(mk(seq(50, () => -1))).verdict, 'too few trades');
  assert.equal(judgeLong(mk(seq(400, (i) => (i % 2 ? 1 : -1.4)))).verdict, 'loses');
  assert.equal(judgeLong(mk(seq(400, (i) => (i % 2 ? 1 : -1.02)))).verdict, 'no edge');
  assert.equal(judgeLong(mk(seq(400, (i) => (i % 2 ? 1.6 : -1)))).verdict, 'edge');
  const j = judgeLong(mk(seq(400, (i) => (i % 2 ? 1 : -1.4))));
  assert.equal(j.n, 400);
  assert.ok(j.ci[1] < 0);
  assert.ok(j.quarters.total >= 4);
  assert.equal(j.costR, 0.05);
});

test('a research desk\'s new strategy trades paper first, then the account', async () => {
  const { skipCategory } = await import('../server/live/dailyReport.js');
  const { fund, live, sync } = setup();
  sync();
  live.setup({ program: '2-step', type: 'trial', size: 100_000, practiceAll: false });
  assert.equal(live.arm().ok, true);
  const elena = fund.byId.get('elena');
  elena.active = { name: '15m Squeeze breakout', symbol: 'XAUUSD', live: { trades: 3, sumR: 1.2, realTrades: 3, realSumR: 1.2 } };
  const v = live.brain.allow(elena, { symbol: 'XAUUSD', qty: 1 }, {});
  assert.equal(v.ok, false, 'even while training');
  assert.match(v.reason, /^Elena's new strategy \(15m Squeeze breakout\) trades paper first: 3 of 10 live trades on real prices so far, \+1\.20R in total\. Validated on history isn't proven live$/);
  assert.equal(skipCategory(v.reason), 'New strategy proving itself on paper');
  assert.equal(live.brain.deskStatus(elena).label, 'Paper · proving live');
  elena.active.live = { trades: 12, sumR: -0.5, realTrades: 12, realSumR: -0.5 };
  assert.match(live.brain.allow(elena, { symbol: 'XAUUSD', qty: 1 }, {}).reason, /is down 0\.50R over its 12 live trades: it reaches the account once that's back to 0R or better/);
  elena.active.live = { trades: 12, sumR: 1.5, realTrades: 12, realSumR: 1.5 };
  assert.equal(live.brain.allow(elena, { symbol: 'XAUUSD', qty: 1 }, {}).ok, true, 'proven live: the account');
  assert.ok(live.view().plan.rules.some((r) => /^Proven live first: a research desk's new strategy trades paper on real prices until 10 live trades/.test(r.text)));
});

test('deep in drawdown the account trades a quarter of its risk', () => {
  const { live, sync, mt5 } = setup();
  sync();
  live.setup({ program: '2-step', type: 'challenge', size: 100_000 });
  mt5.balance = mt5.equity = 96_000; // 4% down: 0.4×
  sync();
  assert.equal(live.brain.state().mult, 0.4);
  mt5.balance = mt5.equity = 93_500; // 6.5% down, past 60% of the 10% max loss: a quarter
  sync();
  assert.equal(live.brain.state().mult, 0.25);
  assert.ok(live.brain.state().reasons.some((r) => /risk is ×0\.25 until that's won back/.test(r)));
});

test('months of history: the floor pages back through MT5 until it has enough, MT5 runs out, or an old EA repeats itself', () => {
  const { live, bridge, sync, fund } = setup();
  sync();
  live.setup({ program: '2-step', type: 'trial', size: 100_000 });
  const md = fund.env.md;
  // MT5 prices gold already.
  const now = Math.floor(Date.now() / 60_000) * 60;
  md.claim('XAUUSD', 'mt5', Array.from({ length: 60 }, (_, i) => ({ time: now - (60 - i) * 60, open: 3800, high: 3801, low: 3799, close: 3800, volume: 1 })), 'LIVE');
  const added = [];
  const store = {
    ready: true, have: 0,
    brokerBars: () => store.have,
    addBrokerHistory(id, bars) {
      added.push({ id, n: bars.length });
      store.have += bars.length;
      return bars.length ? { n: bars.length, oldest: bars.reduce((m, b) => Math.min(m, b.time), Infinity) } : { n: 0, oldest: null };
    },
  };
  live.history = store;
  // A page of MT5 bars (server time = UTC here), `start` bars back.
  const page = (start, n = 10_000) => Array.from({ length: n }, (_, i) => {
    const t = now - (start + n - 1 - i) * 60;
    return [t, 3800, 3801, 3799, 3800, 1];
  });
  sync();
  assert.deepEqual(pick(bridge.historyWanted.get('XAUUSD')), { count: 10_000, start: 1 });
  sync({ history: { XAUUSD: page(1) } });
  assert.deepEqual(pick(bridge.historyWanted.get('XAUUSD')), { count: 10_000, start: 10_001 }, 'the next page, asked in the same sync');
  sync({ history: { XAUUSD: page(10_001) } });
  assert.equal(bridge.historyWanted.get('XAUUSD').start, 20_001);
  // An EA before 1.3 ignores where to start and sends its latest bars again: stop.
  sync({ history: { XAUUSD: page(1) } });
  assert.equal(bridge.historyWanted.has('XAUUSD'), false);
  assert.equal(live.backfill.get('XAUUSD').done, true);
  assert.match(live.backfill.get('XAUUSD').why, /the EA sent the same bars again/);
  sync();
  assert.equal(bridge.historyWanted.has('XAUUSD'), false, 'and doesn\'t ask again');
  assert.deepEqual(added.map((a) => a.n), [10_000, 10_000, 10_000]);

  // MT5 holds less than asked: what it has is all there is.
  live.backfill.clear();
  live.state.backfill = {};
  store.have = 0;
  sync();
  sync({ history: { XAUUSD: page(1, 4000) } });
  assert.equal(live.backfill.get('XAUUSD').why, 'all the history MT5 holds');
  // A restart within a week with that history saved: no download again.
  assert.equal(live.state.backfill.XAUUSD.have, 4000);
  live.backfill.clear();
  sync();
  assert.equal(live.backfill.get('XAUUSD').why, 'already saved');
  assert.equal(bridge.historyWanted.has('XAUUSD'), false);
  // Nothing that far back: MT5 never answers the page, and the bridge gives up on it.
  live.backfill.clear();
  live.state.backfill = {};
  sync();
  sync({ history: { XAUUSD: page(1) } });
  // MT5 away for ten minutes (asleep): that's no answer, it simply wasn't asked.
  bridge.historyWanted.get('XAUUSD').since -= 600_000;
  sync();
  assert.equal(live.backfill.get('XAUUSD').done, false);
  // Asked again and again over a minute and a half, never answered: MT5 has nothing older.
  Object.assign(bridge.historyWanted.get('XAUUSD'), { asks: 3, firstAsked: Date.now() - 120_000 });
  sync();
  assert.equal(live.backfill.get('XAUUSD').done, true);
  assert.equal(live.backfill.get('XAUUSD').why, 'MT5 has nothing older');
  // Saved from an earlier run: no download at all.
  live.backfill.clear();
  live.state.backfill = {};
  store.have = 99_000;
  sync();
  assert.equal(bridge.historyWanted.has('XAUUSD'), false);
  assert.equal(live.backfill.get('XAUUSD').why, 'already saved');
});

const pick = (h) => (h ? { count: h.count, start: h.start } : null);

test('the bridge asks for history pages politely: one at a time, never while an order is on its way', () => {
  const b = new Mt5Bridge();
  const base = { account: { login: 1 }, positions: [], deals: [], quotes: {}, symbols: ['XAUUSD'], serverDay: '2026.10.02', gmtOffset: 0 };
  b.requestHistory('XAUUSD', 10_000, 10_001);
  b.requestHistory('EURUSD', 10_000, 20_001);
  b.requestHistory('GBPUSD', 6000);
  let reply = b.handleSync(base);
  assert.match(reply, /^history\|XAUUSD\|10000\|10001$/m);
  assert.doesNotMatch(reply, /history\|EURUSD/, 'one page a sync');
  assert.match(reply, /^history\|GBPUSD\|6000$/m, 'a first request has no start (every EA understands it)');
  // An order on its way: pages wait.
  b.open({ symbol: 'XAUUSD', side: 'BUY', volume: 0.1, slDistance: 5, tpDistance: 0, magic: 771001, comment: 'x' });
  b.historyWanted.get('EURUSD').lastAsked = 0;
  reply = b.handleSync(base);
  assert.doesNotMatch(reply, /history\|EURUSD/);
  // The answer says which page it was.
  const got = [];
  b.on('history', (sym, bars, meta) => got.push({ sym, n: bars.length, meta }));
  b.handleSync({ ...base, history: { XAUUSD: [[1_700_000_000, 1, 2, 0.5, 1.5, 3]] } });
  assert.deepEqual(got, [{ sym: 'XAUUSD', n: 1, meta: { start: 10_001, count: 10_000 } }]);
  // A page MT5 never answers is given up (asked 3 times over 90 s); a page waiting while MT5
  // was away isn't; a first request waits as long as MT5 needs.
  const missing = [];
  b.on('history-missing', (sym, meta) => missing.push({ sym, ...meta }));
  b.requestHistory('USDJPY', 10_000, 30_001);
  b.historyWanted.get('USDJPY').since -= 600_000;
  Object.assign(b.historyWanted.get('EURUSD'), { asks: 3, firstAsked: Date.now() - 91_000 });
  b.historyWanted.get('GBPUSD').since -= 600_000;
  b.handleSync(base);
  assert.deepEqual(missing, [{ sym: 'EURUSD', start: 20_001, count: 10_000 }]);
  assert.equal(b.historyPending('USDJPY'), true, 'never asked yet: not given up');
  assert.equal(b.historyPending('GBPUSD'), true);
  // EA 1.3 says how far back MT5 can go.
  b.handleSync({ ...base, maxBars: 5000 });
  assert.equal(b.maxBars, 5000);
});

test('the FTMO tab says when MT5 keeps too few bars to give months of history', () => {
  const { live, sync } = setup();
  sync({ maxBars: 5000 });
  assert.ok(live.view().warnings.some((w) => /MT5 keeps only 5,000 bars per chart, so the research lab and the nightly review get days of your broker's prices instead of months\. In MT5: Tools → Options → Charts → Max bars in chart → 100000/.test(w)));
  sync({ maxBars: 100_000 });
  assert.ok(!live.view().warnings.some((w) => /bars per chart/.test(w)));
});

test('the research history keeps months of the broker\'s own bars, and the broker\'s bars win', async () => {
  const { HistoryStore, MAX_BROKER_BARS } = await import('../server/research/history.js');
  const clock = new MarketClock('live');
  const md = new MarketData(clock);
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'hist-'));
  const now = Math.floor(Date.now() / 60_000) * 60;
  const bar = (t, close = 3800) => ({ time: t, open: close, high: close + 1, low: close - 1, close, volume: 1 });
  md.claim('XAUUSD', 'mt5', Array.from({ length: 100 }, (_, i) => bar(now - (100 - i) * 60)), 'LIVE');
  const store = new HistoryStore({ md, mode: 'live', dataDir, log: { info() {}, warn() {} }, fetchers: { yahoo: async () => [], binance: async () => [] } });
  assert.equal(store.addBrokerHistory('XAUUSD', [bar(now - 1e6)]), null, 'not before the history has loaded');
  await store.load();
  // A page that overlaps the stored minutes: the broker's bars replace them.
  const pageBars = Array.from({ length: 200 }, (_, i) => bar(now - (250 - i) * 60, 3700));
  const r = store.addBrokerHistory('XAUUSD', pageBars);
  assert.deepEqual(r, { n: 200, oldest: now - 250 * 60 });
  assert.equal(store.bars('XAUUSD').length, 250);
  assert.equal(store.bars('XAUUSD').find((b) => b.time === now - 100 * 60).close, 3700);
  assert.equal(store.brokerBars('XAUUSD'), 250);
  // Capped at MAX_BROKER_BARS (far more than a public feed's 20,000), and saved that way.
  const many = Array.from({ length: MAX_BROKER_BARS + 5000 }, (_, i) => bar(now - (MAX_BROKER_BARS + 6000 - i) * 60));
  store.addBrokerHistory('XAUUSD', many);
  assert.equal(store.bars('XAUUSD').length, MAX_BROKER_BARS);
  store.save();
  const saved = JSON.parse(fs.readFileSync(path.join(dataDir, 'history', 'XAUUSD.json'), 'utf8'));
  assert.equal(saved.level, 'mt5');
  assert.equal(saved.bars.length, MAX_BROKER_BARS);
  // A market MT5 doesn't price takes no broker pages.
  assert.equal(store.addBrokerHistory('EURUSD', [bar(now - 1e6)]), null);
  store.stop();
});
