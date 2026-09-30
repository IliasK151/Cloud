import { test } from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';

import { toColumns, minuteContext, TfContext, nyMinutes, classifyRegime } from '../server/research/context.js';
import { FAMILIES, signalAt, describe, strategyName } from '../server/research/families.js';
import { backtest, costModel, metrics, monteCarlo } from '../server/research/backtest.js';
import { research, neighbours } from '../server/research/search.js';
import { liveSignal, closesTimeframe } from '../server/research/live.js';
import { syntheticHistory } from '../server/research/history.js';
import { NewsCalendar } from '../server/market/calendar.js';
import { MarketClock, Session, nyWallToMs } from '../server/market/session.js';
import { MarketData } from '../server/market/marketData.js';
import { SimFeed } from '../server/market/simFeed.js';
import { Broker } from '../server/engine/broker.js';
import { RiskManager } from '../server/engine/risk.js';
import { Fund } from '../server/engine/fund.js';
import { config } from '../server/config.js';
import { mulberry32, gaussian } from '../server/util/random.js';
import { runFloor } from '../scripts/backtest.js';

const quiet = { info() {}, warn() {} };
const T0 = nyWallToMs(2026, 10, 14, 9, 45) / 1000; // a Wednesday morning, New York
const bar = (i, o, h, l, c) => ({ time: T0 + i * 60, open: o, high: h, low: l, close: c, volume: 100 });

// Random walk with volatility clustering and fat tails, laid out in 09:30–16:00 sessions.
// There is no edge in it by construction.
function randomWalk(seed, n) {
  const rng = mulberry32(seed);
  let p = 100;
  let vol = 0.0006;
  let t = Math.floor(Date.UTC(2026, 8, 1, 13, 30) / 1000);
  let minute = 0;
  const out = [];
  for (let i = 0; i < n; i++) {
    if (minute === 390) {
      minute = 0;
      t += (24 * 60 - 390) * 60;
      const d = new Date(t * 1000).getUTCDay();
      if (d === 6) t += 2 * 86400;
      if (d === 0) t += 86400;
    }
    vol = Math.max(0.0002, vol * Math.exp(0.05 * gaussian(rng)) * 0.999 + 0.0006 * 0.001);
    const o = p;
    let h = o;
    let l = o;
    for (let k = 0; k < 6; k++) {
      p *= Math.exp((vol / Math.sqrt(6)) * (rng() < 0.02 ? 4 : 1) * gaussian(rng));
      h = Math.max(h, p);
      l = Math.min(l, p);
    }
    out.push({ time: t, open: o, high: h, low: l, close: p, volume: 100 });
    t += 60;
    minute++;
  }
  return out;
}

const breakout = { family: 'breakout', tf: 1, side: 'both', gate: 'any', hours: 'all', p: { n: 20, buffer: 0 }, stopAtr: 1, target: 'rr', rr: 2, partialAt: null, trail: null, timeStop: null };

// 40 quiet bars, a breakout bar, then whatever `after` says.
function breakoutSeries(after) {
  const bars = [];
  for (let i = 0; i < 40; i++) bars.push(bar(i, 100, 100.1, 99.9, 100));
  bars.push(bar(40, 100, 100.5, 100, 100.4));
  after.forEach((b, k) => bars.push(bar(41 + k, ...b)));
  for (let i = bars.length; i < 60; i++) bars.push(bar(i, 100.4, 100.45, 100.35, 100.4));
  return bars;
}

function run(bars, g, opts = {}) {
  const cols = toColumns(bars);
  const m = minuteContext(cols, { mode: 'sim', windows: opts.windows || [] });
  const tfc = new TfContext(cols, g.tf, m.nyMin);
  return backtest(m, tfc, g, { cost: opts.cost || { half: 0, fee: 0 }, keepTrades: true, ...opts });
}

test('backtester: next-bar entry, target in R, stop checked before target, costs reduce R', () => {
  // Target reached: +2R exactly without costs.
  const win = run(breakoutSeries([[100.4, 100.9, 100.3, 100.8]]), breakout);
  assert.equal(win.n, 1);
  assert.ok(Math.abs(win.rs[0] - 2) < 1e-9, `target trade is +2R (${win.rs[0]})`);
  assert.equal(win.trades[0].in, T0 + 41 * 60, 'entered at the next bar, not the signal bar');
  // A bar that touches both the stop and the target counts as a loss.
  const both = run(breakoutSeries([[100.4, 100.9, 100.1, 100.5]]), breakout);
  assert.ok(Math.abs(both.rs[0] + 1) < 1e-9, `ambiguous bar is a full loss (${both.rs[0]})`);
  assert.equal(both.trades[0].why, 'stop');
  // Real costs (spread, slippage, commission) make the winner smaller.
  const costly = run(breakoutSeries([[100.4, 100.9, 100.3, 100.8]]), breakout, { cost: costModel(1.0) });
  assert.ok(costly.rs[0] < 2 && costly.rs[0] > 1.8);
  // Gap through the stop fills at the (worse) open.
  const gap = run(breakoutSeries([[100.4, 100.5, 100.3, 100.4], [99.8, 99.9, 99.7, 99.8]]), breakout);
  assert.ok(gap.rs[0] < -2.5, `gap loss is worse than 1R (${gap.rs[0]})`);
  // Opening beyond the stop: the entry is refused, exactly like a live desk would.
  assert.equal(run(breakoutSeries([[99.8, 99.9, 99.7, 99.8]]), breakout).n, 0);
});

test('backtester respects news: no entry in a blackout, flat before high-impact news', () => {
  const t41 = (T0 + 41 * 60) * 1000;
  const blocked = run(breakoutSeries([[100.4, 100.9, 100.3, 100.8]]), breakout, { windows: [{ from: t41 - 60_000, to: t41 + 10 * 60_000, flatAt: null }] });
  assert.equal(blocked.n, 0);
  // In a trade when a high-impact release approaches: out at the open of that minute.
  const g = { ...breakout, rr: 10 };
  const flat = run(breakoutSeries([[100.4, 100.5, 100.35, 100.45], [100.45, 100.5, 100.4, 100.45], [100.45, 100.5, 100.4, 100.45]]), g, { windows: [{ from: t41 + 2 * 60_000, to: t41 + 30 * 60_000, flatAt: t41 + 2 * 60_000 }] });
  assert.equal(flat.n, 1);
  assert.equal(flat.trades[0].why, 'news');
});

test('no look-ahead: the live desk computes exactly the backtest signal from past bars only', () => {
  const bars = randomWalk(3, 3000);
  const cols = toColumns(bars);
  const ny = nyMinutes(cols.t);
  const genomes = [];
  for (const family of Object.keys(FAMILIES)) {
    for (const [tf, gate] of [[1, 'any'], [3, 'range'], [5, 'trend'], [15, 'any']]) {
      const p = Object.fromEntries(Object.entries(FAMILIES[family].space).map(([k, v]) => [k, v[1]]));
      genomes.push({ family, tf, side: 'both', gate, hours: 'all', p, stopAtr: 1.5, target: FAMILIES[family].targets[0], rr: 2, partialAt: 1, trail: 3.5, timeStop: 16 });
    }
  }
  let checked = 0;
  let fired = 0;
  for (const g of genomes) {
    const full = new TfContext(cols, g.tf, ny);
    let k = 0;
    for (let j = 2000; j < bars.length; j += g.tf === 1 ? 7 : 1) {
      if (!closesTimeframe(bars[j].time, g.tf)) continue;
      while (full.last1m[k] < j) k++;
      const a = full.last1m[k] === j ? signalAt(full, g, k, ny) : null;
      const b = liveSignal(bars.slice(0, j + 1), g);
      checked++;
      if (a) fired++;
      assert.deepEqual(b, a, `${g.family} ${g.tf}m at bar ${j}`);
    }
  }
  assert.ok(checked > 1000 && fired > 20, `checked ${checked}, fired ${fired}`);
});

test('validation rejects strategies found in pure noise', () => {
  for (const seed of [1, 2, 3, 4]) {
    const r = research({ bars: randomWalk(seed * 101, 11_700), symbol: 'NAS100', mode: 'sim', spreadBps: 0.6, budget: 360, seed });
    assert.equal(r.ok, false, `seed ${seed}: ${r.summary}`);
    assert.equal(r.outcome, 'no-edge');
    assert.ok(r.funnel.tested >= 300, 'hundreds of ideas were actually tested');
    assert.ok(r.funnel.inSample > 0, 'some looked good in-sample (that is the trap)');
  }
});

test('validation finds and deploys a real edge in the simulated markets', async () => {
  const clock = { now: () => 0, mode: 'sim' };
  const cal = new NewsCalendar({ clock, mode: 'sim', dataDir: null, log: quiet });
  const endSec = Math.floor(nyWallToMs(2026, 10, 1, 9, 0) / 1000);
  const hist = await syntheticHistory(['XAUUSD', 'EURUSD', 'USDJPY'], { endSec, calendar: cal, seed: 7, sessions: 30 });
  const deployed = [];
  for (const [id, bars] of Object.entries(hist)) {
    const windows = cal.windows(id, bars[0].time * 1000, bars.at(-1).time * 1000);
    const r = research({ bars, symbol: id, mode: 'sim', windows, spreadBps: 1, budget: 360, seed: 3 });
    assert.ok(r.regime?.label, 'market condition classified');
    if (!r.ok) continue;
    const s = r.strategy;
    deployed.push(id);
    assert.ok(s.unseen.n >= 20 && s.unseen.t >= 2, 'significant on unseen data');
    assert.ok(s.oos.avgR > 0 && s.holdout.sumR > 0 && s.robust.doubleCostsAvgR > 0);
    assert.ok(s.rules.length >= 4 && s.rules.at(-1).includes('news'));
    assert.equal(s.name, strategyName(s.genome));
    assert.ok(s.curve.length === s.all.n);
  }
  assert.ok(deployed.length >= 1, 'at least one market had a validated edge');
});

test('metrics, Monte Carlo and parameter neighbours', () => {
  const m = metrics([1, -1, 2, -1, 1]);
  assert.equal(m.n, 5);
  assert.equal(m.sumR, 2);
  assert.equal(m.pf, 2);
  assert.equal(m.maxDD, 1);
  const mc = monteCarlo(Array(50).fill(0.5), mulberry32(1));
  assert.equal(mc.pPositive, 1);
  const nb = neighbours({ ...breakout, p: { n: 20, buffer: 0.1 } });
  assert.ok(nb.length >= 5 && nb.every((g) => g.family === 'breakout'));
  assert.ok(describe(breakout).some((r) => /Target 2R/.test(r)));
  assert.equal(classifyRegime(randomWalk(9, 1200)).key.length > 0, true);
});

// ---- the research desks ----------------------------------------------------------------------
function floorWithFakeLab() {
  const clock = new MarketClock('sim', 1);
  const session = new Session(clock);
  const md = new MarketData(clock);
  const broker = new Broker(md, clock);
  const risk = new RiskManager(config.risk, session);
  const requests = [];
  const lab = Object.assign(new EventEmitter(), {
    history: { ready: true, recent: () => [], bars: () => [] },
    running: null, queue: [],
    isBusy: () => false,
    request: (agentId, symbol) => { requests.push({ agentId, symbol }); return true; },
  });
  const fund = new Fund({ config: { ...config, feed: 'sim' }, md, clock, session, broker, risk, lab });
  const sim = new SimFeed(md, clock, ['NAS100', 'SPX500', 'XAUUSD', 'SOLUSD'], { seed: 5 });
  sim.warmup(120);
  fund.trading = true;
  return { fund, lab, requests, clock };
}

function passing(symbol, t = 3, avgR = 0.4) {
  const genome = { ...breakout, tf: 5 };
  const s = { n: 40, winRate: 0.5, avgR, sumR: avgR * 40, pf: 1.9, maxDD: 3, t };
  return {
    ok: true, outcome: 'deploy', symbol, tested: 360, bars: 11_700, regime: { key: 'range', label: 'Ranging' },
    funnel: { tested: 360, inSample: 90, outOfSample: 3, robust: 2, holdout: 1 },
    strategy: {
      genome, key: `k-${symbol}`, name: strategyName(genome), rules: describe(genome), is: s, oos: s, holdout: s, unseen: s, all: s,
      robust: { neighbours: 0.8, doubleCostsAvgR: 0.25, mc: { pPositive: 0.99, ddP95: 4 } },
      expectation: { avgR, sd: 1.1, ddP95: 4 }, tradesPerDay: 3, curve: [], splits: {},
    },
  };
}
const failing = (symbol) => ({ ok: false, outcome: 'no-edge', symbol, tested: 360, bars: 11_700, regime: { key: 'trend-up', label: 'Trending up' }, funnel: { tested: 360, inSample: 40, outOfSample: 0, robust: 0, holdout: 0 }, reasons: { 'edge disappeared out-of-sample': 4 }, nearMiss: { stage: 'oos', why: 'edge disappeared out-of-sample', name: '5m Trend pullback' } });

test('a research desk deploys only a validated strategy, on probation, and says so', () => {
  const { fund, requests } = floorWithFakeLab();
  const arjun = fund.byId.get('arjun');
  assert.equal(arjun.requestResearch('test').ok, true);
  assert.deepEqual(requests.map((r) => r.symbol), ['NAS100', 'SPX500']);
  assert.equal(arjun.status(), 'RESEARCHING');
  assert.equal(arjun.requestResearch('again').ok, false, 'one research round at a time');
  arjun.onResearch({ symbol: 'NAS100', result: failing('NAS100') });
  assert.equal(arjun.active, null, 'waits for every market before choosing');
  arjun.onResearch({ symbol: 'SPX500', result: passing('SPX500') });
  assert.equal(arjun.active.symbol, 'SPX500');
  assert.equal(arjun.symbol, 'SPX500', 'the desk moves to where the edge is');
  assert.equal(arjun.probation, true, 'new strategies start at half size');
  assert.match(arjun.briefing().text, /on probation at half size/);
  assert.ok(arjun.log.some((l) => l.kind === 'research' && /Deployed 5m Channel breakout on SPX500/.test(l.text)));
  // Five winning live trades end probation.
  for (let i = 0; i < 5; i++) arjun.onTradeClosed({ symbol: 'SPX500', pnl: 1000, r: 0.6, exitReason: 'Target hit' });
  assert.equal(arjun.probation, false);
});

test('a research desk retires a strategy that stops working, then researches again', () => {
  const { fund, requests } = floorWithFakeLab();
  const omar = fund.byId.get('omar');
  omar.requestResearch('test');
  omar.onResearch({ symbol: 'XAUUSD', result: passing('XAUUSD') });
  omar.onResearch({ symbol: 'USOIL', result: failing('USOIL') });
  assert.equal(omar.active.symbol, 'XAUUSD');
  for (let i = 0; i < 5; i++) omar.onTradeClosed({ symbol: 'XAUUSD', pnl: -1000, r: -1.1, exitReason: 'Stop loss' });
  assert.equal(omar.active, null, 'retired after results far below validation');
  assert.ok(omar.log.some((l) => /Retiring 5m Channel breakout: live results/.test(l.text)));
  requests.length = 0;
  omar.labTick();
  assert.equal(requests.length, 2, 'research starts again straight away');
});

test('no validated edge means no trading, and the desk explains why', () => {
  const { fund } = floorWithFakeLab();
  const mei = fund.byId.get('mei');
  mei.requestResearch('test');
  for (const s of ['BTCUSD', 'ETHUSD', 'SOLUSD']) mei.onResearch({ symbol: s, result: failing(s) });
  assert.equal(mei.active, null);
  assert.equal(mei.status(), 'NO EDGE');
  assert.match(mei.pitch(), /none passed validation.*So I'm not trading/);
  mei.evaluate('BTCUSD', { time: T0 });
  assert.equal(mei.book.positions.size, 0);
});

test('the head of research diversifies away from markets the team already trades, and state survives a restart', () => {
  const { fund } = floorWithFakeLab();
  const mei = fund.byId.get('mei');
  mei.requestResearch('test');
  mei.onResearch({ symbol: 'BTCUSD', result: failing('BTCUSD') });
  mei.onResearch({ symbol: 'ETHUSD', result: failing('ETHUSD') });
  mei.onResearch({ symbol: 'SOLUSD', result: passing('SOLUSD', 5) });
  const elena = fund.byId.get('elena');
  elena.requestResearch('test');
  for (const s of elena.markets) elena.onResearch({ symbol: s, result: s === 'SOLUSD' ? passing(s, 5) : s === 'XAUUSD' ? passing(s, 3) : failing(s) });
  assert.equal(elena.active.symbol, 'XAUUSD', 'SOLUSD is already traded by the crypto researcher');
  // Save and restore.
  const saved = JSON.parse(JSON.stringify(fund.serialize()));
  const { fund: fresh } = floorWithFakeLab();
  fresh.restore(saved);
  const e2 = fresh.byId.get('elena');
  assert.equal(e2.active.name, elena.active.name);
  assert.equal(e2.symbol, 'XAUUSD');
  assert.ok(e2.events.length > 0);
});

test('the whole floor runs a session with the economic calendar and the research lab', { timeout: 120_000 }, async () => {
  const fund = await runFloor({ sessions: 1, seed: 42 });
  const errors = fund.agents.flatMap((a) => a.log.filter((l) => l.kind === 'error').map((l) => `${a.id}: ${l.text}`));
  assert.deepEqual(errors, []);
  const lab = fund.agents.filter((a) => a.profile.lab);
  assert.equal(lab.length, 5);
  for (const a of lab) assert.ok(a.lastRun, `${a.id} researched`);
  assert.ok(lab.filter((a) => a.active).length >= 2, 'validated strategies were deployed');
  for (const a of lab) {
    for (const t of fund.broker.book(a.id).trades) assert.ok(a.events.some((e) => e.event === 'deployed' && e.symbol === t.symbol), `${a.id} only traded a deployed strategy`);
  }
  assert.ok(fund.events.some((e) => e.kind === 'research'));
});
