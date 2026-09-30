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
import { LiveTrader, MAGIC_BASE } from '../server/live/liveTrader.js';
import { lotsForRisk, normalizeProfile, guardMetrics } from '../server/live/rules.js';
import { autoMap } from '../server/live/symbolMap.js';

const GOLD = { bid: 3800, ask: 3800.2, digits: 2, point: 0.01, tickSize: 0.01, tickValue: 1, tickValueLoss: 1, volMin: 0.01, volStep: 0.01, volMax: 50, stopsLevel: 0, bars: [] };
const tick = () => new Promise((r) => setImmediate(r));

function setup({ mode = 'live' } = {}) {
  const clock = new MarketClock('live');
  const session = new Session(clock);
  session.isFlattenWindow = () => false; // tests must not depend on the time of day
  const md = new MarketData(clock);
  const broker = new Broker(md, clock);
  const risk = new RiskManager({ riskPerTradePct: 0.005, deskDailyLossPct: 0.02, fundDailyLossPct: 0.012, maxLeverage: 4 }, session);
  // These tests cover the mirroring mechanics; the committee and account plan have their own tests.
  const fund = new Fund({ config: { startingCapital: 100_000_000, feed: mode, fundName: 'Test' }, md, clock, session, broker, risk, committee: 'off' });
  const bridge = new Mt5Bridge();
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'live-'));
  const live = new LiveTrader({ fund, md, bridge, clock, mode, dataDir, token: 't', log: { warn() {} } });
  clearInterval(live.timer);
  md.applyTick('XAUUSD', 3800.1, 1, clock.now());

  const mt5 = { balance: 100_000, equity: 100_000, closedToday: 0, positions: [], acks: [] };
  const account = () => ({
    login: 555, server: 'FTMO-Demo', currency: 'USD', balance: mt5.balance, equity: mt5.equity, closedToday: mt5.closedToday,
    initialDeposit: 100_000, tradeAllowed: true, expertAllowed: true, algoAllowed: true, connected: true, marginMode: 2,
  });
  const sync = () => {
    const reply = bridge.handleSync({
      account: account(), positions: mt5.positions, deals: [], quotes: { XAUUSD: GOLD },
      symbols: ['XAUUSD', 'US100.cash', 'EURUSD'], serverDay: '2026.09.29', gmtOffset: 0, acks: mt5.acks.splice(0),
    });
    return reply.split('\n').filter((l) => /^(open|close|modify|closeall)\|/.test(l)).map((l) => l.split('|'));
  };
  return { fund, live, bridge, sync, mt5, chen: fund.byId.get('chen') };
}

test('position sizing turns account risk into lots', () => {
  // $250 risk, 5.0 stop on gold at $1 per 0.01 per lot → $500 per lot → 0.5 lots
  assert.equal(lotsForRisk(250, 5, GOLD), 0.5);
  assert.equal(lotsForRisk(1, 5, GOLD), 0); // below the 0.01 minimum
  assert.equal(lotsForRisk(1e9, 5, GOLD), 50); // capped at volMax
});

test('FTMO presets and guard maths', () => {
  const p = normalizeProfile({ type: 'verification', size: 50_000 });
  assert.equal(p.targetPct, 5);
  assert.equal(p.dailyLossPct, 5);
  assert.equal(normalizeProfile({ type: 'funded' }).targetPct, null);
  const m = guardMetrics(normalizeProfile({ type: 'challenge', size: 100_000 }), { balance: 101_000, equity: 99_000, closedToday: 1_000 });
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
  live.setup({ type: 'challenge', size: 100_000 });
  assert.match(live.arm().error, /at least one desk/);
  assert.equal(live.setDesk('kenji', true).ok, false); // pairs desk is paper only
  live.setDesk('chen', true);
  assert.match(live.arm().error, /Type the account number/);
  assert.equal(live.arm({ confirm: '555' }).ok, true);

  const demo = setup({ mode: 'sim' });
  demo.sync();
  demo.live.setup({ type: 'trial' });
  demo.live.setDesk('chen', true);
  assert.match(demo.live.arm().error, /live market data/);
});

test('desk trades are mirrored: entry, scale-out, stop moves and exit', async () => {
  const { live, sync, mt5, chen } = setup();
  sync();
  live.setup({ type: 'trial', size: 100_000 });
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
  live.setup({ type: 'challenge', size: 100_000 });
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
  live.setup({ type: 'trial', size: 100_000 });
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
  live.setup({ type: 'trial', size: 10_000 });
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
  live.setup({ type: 'trial', size: 100_000 });
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
