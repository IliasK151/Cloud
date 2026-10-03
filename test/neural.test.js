import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import zlib from 'node:zlib';

import { Net, auc } from '../server/neural/net.js';
import { FEATURES, N_FEATURES, senseTrade } from '../server/neural/features.js';
import { fit, load, walkForward, evaluate, insights, score } from '../server/neural/train.js';
import { NeuralBrain, NEURAL, SHIPPED_BRAIN, SHIPPED_EXAMPLES, weightChanges, loadShippedExamples } from '../server/neural/brain.js';
import { learn } from '../server/neural/worker.js';
import { AccountBrain } from '../server/live/accountBrain.js';
import { normalizeProfile, guardMetrics } from '../server/live/rules.js';
import { skipCategory } from '../server/live/dailyReport.js';
import { MarketClock, Session, nyWallToMs } from '../server/market/session.js';
import { MarketData } from '../server/market/marketData.js';
import { Broker } from '../server/engine/broker.js';
import { RiskManager } from '../server/engine/risk.js';
import { Fund } from '../server/engine/fund.js';
import { config } from '../server/config.js';
import { mulberry32 } from '../server/util/random.js';

const MONTH = 30 * 86_400_000;
const idx = (k) => FEATURES.findIndex((f) => f.key === k);

// Trades whose outcome follows two senses (the hourly and 15-minute trend), or pure noise.
function synth(n, { signal = true, seed = 3, desks = ['amara', 'marcus'], t0 = Date.UTC(2024, 0, 1), span = 18 * MONTH } = {}) {
  const rng = mulberry32(seed);
  return Array.from({ length: n }, (_, i) => {
    const x = Array.from({ length: N_FEATURES }, () => Math.round((rng() * 2 - 1) * 1e4) / 1e4);
    const win = signal ? x[idx('htf')] + 0.6 * x[idx('trend')] + (rng() - 0.5) * 0.6 > 0 : rng() < 0.5;
    return { desk: desks[i % desks.length], symbol: 'XAUUSD', t: Math.round(t0 + (i * span) / n), x, r: win ? 1.2 : -1 };
  });
}

function tmpDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'neural-'));
}

// A brain trained on `examples`, saved where a NeuralBrain finds the shipped one.
function shippedFiles(dir, examples, { validation = null } = {}) {
  const model = fit(examples, { seed: 1, epochs: 40 });
  const brainFile = path.join(dir, 'brain.json');
  const exFile = path.join(dir, 'brain-examples.json.gz');
  fs.writeFileSync(brainFile, JSON.stringify({ ...model, validation }));
  fs.writeFileSync(exFile, zlib.gzipSync(JSON.stringify({ v: 1, examples })));
  return { shipped: brainFile, shippedExamples: exFile, model };
}

const COIN = { all: { n: 9960, allR: -0.13, picked: 1258, pickedR: -0.112, auc: 0.506 }, halves: [], desks: {}, calibration: [], months: [] };

// A desk as the brain sees it, with a market read we control.
function deskFor(id = 'amara', { now = Date.UTC(2026, 9, 14, 14, 30) } = {}) {
  const read = { regime: { key: 'trend-up' }, volPct: 0.8, atr1: 1, atr5: 2.2, z: 1, day: { hi: 110, lo: 90, prevHi: 105, prevLo: 92 } };
  const marketBrain = {
    assess: (symbol, side) => ({
      read, roomR: 2.5,
      f: { htf: { value: 0.8 }, trend: { value: 0.5 }, structure: { value: 1 }, momentum: { value: -0.2 }, stretch: { value: 0.3 }, location: { value: 1 }, room: { value: 0.5 }, volatility: { value: 0.4 } },
      side,
    }),
  };
  return {
    id, profile: { name: 'Amara Okafor' },
    env: { marketBrain, clock: { now: () => now } },
    md: { bars: () => [] },
    lifetime: { recentR: [-1, -1, 0.5] },
    day: { entries: 2 },
    setup: { confidence: 70 },
  };
}

// ---- the network -------------------------------------------------------------------------------
test('the network learns a real pattern, and its saved form round-trips (and refuses damage)', () => {
  const model = fit(synth(900), { seed: 1, epochs: 60 });
  const brain = load(model);
  const fresh = synth(400, { seed: 9 });
  const a = auc(fresh.map((e) => (e.r > 0 ? 1 : 0)), fresh.map((e) => brain.judge(e.x, e.desk).p));
  assert.ok(a > 0.85, `AUC ${a}`);
  // expected R = p × the desk's average win − (1 − p) × its average loss
  const j = brain.judge(fresh[0].x, 'amara');
  const s = model.desks.amara;
  assert.ok(Math.abs(j.expR - (j.p * s.win - (1 - j.p) * s.loss)) < 1e-9);
  // Saved and loaded, it judges exactly the same.
  const again = load(JSON.parse(JSON.stringify(model)));
  assert.equal(again.judge(fresh[1].x, 'marcus').p, brain.judge(fresh[1].x, 'marcus').p);
  const net = Net.from(model.net);
  assert.equal(net.sizes.join(), [N_FEATURES, 24, 12, 1].join());
  const bad = JSON.parse(JSON.stringify(model.net));
  bad.W[1][3] = null;
  assert.throws(() => Net.from(bad), /damaged/);
  assert.throws(() => load({ ...model, features: model.features.slice(1) }), /different senses/);
  assert.throws(() => fit(synth(100)), /only 100 trades/);
});

test('AUC: weights count like repeated trades, ties count half', () => {
  assert.equal(auc([1, 0, 1, 0], [0.9, 0.1, 0.4, 0.6]), 0.75);
  assert.equal(auc([1, 0, 1, 0], [0.9, 0.1, 0.4, 0.6], [1, 1, 2, 1]), auc([1, 0, 1, 0, 1], [0.9, 0.1, 0.4, 0.6, 0.4]));
  assert.equal(auc([1, 0], [0.5, 0.5]), 0.5);
  assert.ok(Number.isNaN(auc([1, 1], [0.2, 0.3])));
});

// ---- the senses ----------------------------------------------------------------------------------
test('the brain senses ~50 facts about an idea, each between -1 and +1, signed in the trade\'s favour', () => {
  const desk = deskFor();
  const long = senseTrade({ brain: desk.env.marketBrain, agent: desk, symbol: 'XAUUSD', side: 'LONG', entry: 104, stop: 102, target: 108, now: desk.env.clock.now() });
  const short = senseTrade({ brain: desk.env.marketBrain, agent: desk, symbol: 'XAUUSD', side: 'SHORT', entry: 104, stop: 106, target: null, now: desk.env.clock.now() });
  assert.equal(long.length, N_FEATURES);
  assert.ok(N_FEATURES >= 45 && N_FEATURES <= 60);
  for (const v of [...long, ...short]) assert.ok(v >= -1 && v <= 1 && Number.isFinite(v));
  const at = (x, k) => x[idx(k)];
  assert.equal(at(long, 'htf'), 0.8);
  assert.equal(at(long, 'side'), 1);
  assert.equal(at(short, 'side'), -1);
  assert.equal(at(long, 'regimeWith'), 1, 'an uptrend is with a long');
  assert.equal(at(short, 'regimeWith'), -1, '… and against a short');
  assert.ok(Math.abs(at(long, 'dayPos') - 0.4) < 1e-9, 'high in today\'s range: good for a long…');
  assert.ok(Math.abs(at(short, 'dayPos') + 0.4) < 1e-9, '… not for a short');
  assert.equal(at(long, 'rr'), 0, 'a 2R target');
  assert.equal(at(short, 'hasTarget'), -1);
  assert.equal(at(long, 'mkt:gold'), 1);
  assert.equal(at(long, 'mkt:fx'), 0);
  assert.equal(at(long, 'confidence'), 0.4);
  assert.ok(at(long, 'streak') < 0 && at(long, 'form') < 0, 'two losses in a row, out of form');
  // No market read yet: nothing to sense.
  assert.equal(senseTrade({ brain: { assess: () => null }, agent: desk, symbol: 'XAUUSD', side: 'LONG', entry: 100, stop: 98, now: 0 }), null);
});

// ---- the honest test -------------------------------------------------------------------------------
test('walk-forward: on months it never saw it finds a real pattern, and nothing in noise', () => {
  const opts = { epochs: 40, minExamples: 200 };
  const real = walkForward(synth(1400), opts);
  assert.ok(real.months.length >= 6);
  for (const m of real.months) assert.ok(m.trained < 1400);
  const ev = evaluate(real.preds, { bar: 0 });
  assert.ok(ev.all.auc > 0.8, `AUC ${ev.all.auc}`);
  assert.ok(ev.all.pickedR > ev.all.allR + 0.3, 'its picks beat taking every trade');
  assert.ok(ev.halves[0].n > 0 && ev.halves[1].n > 0);
  assert.ok(ev.desks.amara && ev.desks.marcus);
  const noise = evaluate(walkForward(synth(1400, { signal: false, seed: 5 }), opts).preds);
  assert.ok(Math.abs(noise.all.auc - 0.5) < 0.08, `noise AUC ${noise.all.auc}`);
  // What each desk's brain learned, in words.
  const ins = insights(load(fit(synth(900), { seed: 1, epochs: 60 })), synth(400, { seed: 4 }));
  assert.equal(ins.amara.helps[0].text, 'the hourly trend is with the trade');
  assert.ok(ins.amara.helps.some((h) => h.key === 'trend'));
  assert.ok(ins.amara.takes > 0 && ins.amara.takes < 1);
  assert.equal(ins.amara.bestHours.length, 2);
});

// ---- the brain on the floor ----------------------------------------------------------------------
test('learning: a brain that can\'t yet tell winners from losers judges every idea but decides nothing', () => {
  const dir = tmpDir();
  const files = shippedFiles(dir, synth(600, { signal: false }), { validation: COIN });
  const nb = new NeuralBrain({ dataDir: dir, ...files, log: { warn() {}, info() {} } });
  assert.equal(nb.ready, true);
  const sk = nb.skill();
  assert.equal(sk.trusted, false);
  assert.equal(sk.source, 'history');
  assert.match(sk.text, /ranking skill 0\.506 \(0\.5 is a coin\)/);
  assert.match(sk.text, /every idea still trades on paper/);
  const thoughts = [];
  nb.on('thought', (t) => thoughts.push(t));
  const desk = deskFor();
  const j = nb.judge(desk, { symbol: 'XAUUSD', side: 'LONG', entry: 100, stop: 98, target: 104 });
  assert.equal(j.take, true);
  assert.equal(j.verdict, 'learning');
  assert.ok(['take', 'pass'].includes(j.would));
  assert.equal(j.sizeMult, undefined, 'the desk\'s own size');
  assert.equal(j.x.length, N_FEATURES);
  assert.ok(j.p > 0 && j.p < 1);
  // The Brain tab lights the network with what each neuron computed.
  assert.equal(thoughts.length, 1);
  assert.deepEqual(thoughts[0].acts.map((a) => a.length), [N_FEATURES, 24, 12, 1]);
  assert.equal(thoughts[0].name, 'Amara');
  // Your own alerts are yours.
  assert.equal(nb.judge(desk, { symbol: 'XAUUSD', side: 'LONG', entry: 100, stop: 98, external: true }).verdict, 'yours');
  const v = nb.view();
  assert.equal(v.mode, 'learning');
  assert.equal(v.network.W.length, 3);
  assert.equal(v.features.length, N_FEATURES);
  assert.equal(v.tested.all.auc, 0.506);
  assert.equal(v.thoughts.length, 2);
  assert.equal(v.thoughts[0].acts, undefined, 'the list stays small');
  // No brain at all: every idea trades.
  const none = new NeuralBrain({ dataDir: tmpDir(), shipped: path.join(dir, 'missing.json'), log: { warn() {}, info() {} } });
  assert.deepEqual(none.judge(desk, { symbol: 'XAUUSD', side: 'LONG', entry: 100, stop: 98 }), { take: true });
});

test('it earns a say only from its record on trades it hadn\'t learned from; then it passes, and explores on paper', () => {
  const dir = tmpDir();
  const files = shippedFiles(dir, synth(600, { signal: false }), { validation: COIN });
  let roll = 0.9;
  const nb = new NeuralBrain({ dataDir: dir, ...files, mode: 'live', rng: () => roll, log: { warn() {}, info() {} } });
  const desk = deskFor();
  const x = Array(N_FEATURES).fill(0);
  // A record with real skill: what it said at entry matched how trades ended.
  const rng = mulberry32(7);
  for (let i = 0; i < NEURAL.trust.minN; i++) {
    const win = rng() < 0.5;
    const p = win ? 0.62 : 0.38;
    nb.observe(desk, { symbol: 'XAUUSD', openTime: i, r: win ? 1 : -1, neural: { x, p, expR: win ? 0.2 : -0.3 } });
  }
  const sk = nb.skill();
  assert.equal(sk.source, 'live');
  assert.equal(sk.auc, 1);
  assert.equal(sk.trusted, true);
  assert.match(sk.text, /earned a say/);
  // Now an idea it expects to lose is passed…
  nb.active = { ...nb.active, judge: () => ({ p: 0.35, expR: -0.4 }) };
  const pass = nb.judge(desk, { symbol: 'XAUUSD', side: 'SHORT', entry: 100, stop: 102 });
  assert.equal(pass.take, false);
  assert.equal(pass.verdict, 'pass');
  assert.match(pass.reason, /35% chance, −0\.40R expected after costs/);
  // … except now and then, small, on paper.
  roll = 0.1;
  const ex = nb.judge(desk, { symbol: 'XAUUSD', side: 'SHORT', entry: 100, stop: 102 });
  assert.equal(ex.verdict, 'explore');
  assert.equal(ex.take, true);
  assert.equal(ex.explore, true);
  assert.equal(ex.sizeMult, NEURAL.exploreSize);
  nb.active = { ...nb.active, judge: () => ({ p: 0.6, expR: 0.3 }) };
  assert.equal(nb.judge(desk, { symbol: 'XAUUSD', side: 'LONG', entry: 100, stop: 98 }).verdict, 'take');
  assert.equal(nb.view().mode, 'trusted');
  // A record with no skill takes the say away again (explorations count for all the passes).
  for (let i = 0; i < NEURAL.trust.window; i++) {
    nb.observe(desk, { symbol: 'XAUUSD', openTime: 1000 + i, r: rng() < 0.5 ? 1 : -1, neural: { x, p: 0.5 + (rng() - 0.5) * 0.2, expR: rng() - 0.5, explore: rng() < 0.3 } });
  }
  assert.equal(nb.skill().trusted, false);
  assert.ok(Math.abs(nb.skill().auc - 0.5) < 0.08);
});

test('only real prices teach it, and it remembers what it learned across restarts', () => {
  const dir = tmpDir();
  const files = shippedFiles(dir, synth(600, { signal: false }), { validation: COIN });
  const desk = deskFor();
  const x = Array(N_FEATURES).fill(0.1);
  const demo = new NeuralBrain({ dataDir: dir, ...files, mode: 'sim', log: { warn() {}, info() {} } });
  demo.observe(desk, { symbol: 'XAUUSD', openTime: 1, r: 1, neural: { x, p: 0.5 } });
  assert.equal(demo.own.length, 0, 'demo mode never teaches it');
  const nb = new NeuralBrain({ dataDir: dir, ...files, mode: 'live', log: { warn() {}, info() {} } });
  const outcomes = [];
  nb.on('outcome', (o) => outcomes.push(o));
  nb.observe(desk, { symbol: 'XAUUSD', openTime: 1, r: 1, simFeed: true, neural: { x, p: 0.5 } });
  nb.observe(desk, { symbol: 'XAUUSD', openTime: 1, r: 1, neural: { p: 0.5 } });
  nb.observe(desk, { symbol: 'XAUUSD', openTime: 1, r: 1, neural: { x: [1, 2], p: 0.5 } });
  assert.equal(nb.own.length, 0, 'a stand-in feed, or no senses: nothing to learn');
  nb.observe(desk, { symbol: 'XAUUSD', openTime: 5, r: 1.5, neural: { x, p: 0.7, expR: 0.4 } });
  nb.observe(desk, { symbol: 'XAUUSD', openTime: 6, r: -1, neural: { x, p: 0.7, expR: 0.4, explore: true } });
  assert.equal(nb.own.length, 2);
  assert.deepEqual(outcomes.map((o) => o.won), [true, false]);
  assert.deepEqual(nb.view().calibration, [{ band: 3, n: 2, said: 0.7, won: 0.5 }]);
  assert.equal(nb.view().own.explored, 1);
  nb.flush();
  const again = new NeuralBrain({ dataDir: dir, ...files, mode: 'live', log: { warn() {}, info() {} } });
  assert.equal(again.own.length, 2);
  assert.equal(again.own[0].expR, 0.4);
  assert.equal(again.view().calibration[0].n, 2);
});

test('it studies after the New York close, keeps a new version only if it judges unseen trades better, and flashes what changed', async () => {
  const dir = tmpDir();
  const base = synth(600, { signal: false, t0: Date.UTC(2019, 0, 1) });
  const files = shippedFiles(dir, base, { validation: COIN });
  let now = nyWallToMs(2026, 10, 14, 12, 0);
  const nb = new NeuralBrain({ dataDir: dir, ...files, mode: 'live', inline: true, now: () => now, log: { warn() {}, info() {} } });
  const desk = deskFor();
  // The floor's own trades: here the trends really do decide them.
  const own = synth(240, { seed: 11, t0: Date.UTC(2026, 6, 1), span: 3 * MONTH });
  for (const e of own.slice(0, 20)) nb.observe(desk, { symbol: e.symbol, openTime: e.t, r: e.r, neural: { x: e.x, p: 0.5, expR: 0 } });
  assert.equal(nb.isDue(), false, `fewer than ${NEURAL.minNew} new trades`);
  assert.match(nb.retrain('asked').error, /once it has 30 trades/);
  for (const e of own.slice(20)) nb.observe(desk, { symbol: e.symbol, openTime: e.t, r: e.r, neural: { x: e.x, p: 0.5, expR: 0 } });
  assert.equal(nb.isDue(), false, 'midday: the desks are trading');
  now = nyWallToMs(2026, 10, 14, 17, 10);
  assert.equal(nb.isDue(), true, 'after the close');
  const events = [];
  for (const k of ['learning', 'learned']) nb.on(k, (ev) => events.push({ k, ...ev }));
  const done = new Promise((resolve) => nb.once('learned', resolve));
  nb.tick();
  assert.equal(nb.view().learning.reason, 'nightly');
  assert.match(nb.retrain('asked').error, /already learning/);
  const ev = await done;
  assert.equal(events[0].k, 'learning');
  assert.equal(ev.held, 120, 'half the trades it had never learned from');
  assert.ok(ev.challenger.logLoss < ev.champion.logLoss, 'the floor\'s own trades taught it something real');
  assert.equal(ev.adopted, true);
  assert.equal(ev.version, 2);
  assert.match(ev.text, /The brain learned \(v2\)/);
  assert.ok(ev.changes.length > 50 && ev.changes.every((c) => Number.isInteger(c.l) && Number.isInteger(c.i) && Number.isInteger(c.j)));
  assert.ok(Math.abs(ev.changes[0].d) >= Math.abs(ev.changes.at(-1).d));
  assert.equal(nb.view().version, 2);
  assert.equal(nb.newSinceTrain(), 0);
  assert.ok(nb.view().insights.amara, 'what each desk learned, refreshed');
  assert.equal(nb.isDue(), false, 'once a day');
  // A restart picks up the brain it learned.
  const again = new NeuralBrain({ dataDir: dir, ...files, mode: 'live', log: { warn() {}, info() {} } });
  assert.equal(again.view().from, 'learned');
  assert.equal(again.view().version, 2);
  assert.equal(again.view().versions.at(-1).adopted, true);
});

test('a fair test needs trades the current brain never learned from', () => {
  const base = synth(400, { signal: false, t0: Date.UTC(2019, 0, 1) });
  const champion = fit(base, { seed: 1, epochs: 20 });
  const dir = tmpDir();
  const file = path.join(dir, 'ex.json.gz');
  fs.writeFileSync(file, zlib.gzipSync(JSON.stringify({ v: 1, examples: base })));
  // Trades from before the champion's last lesson don't count as unseen.
  const old = synth(50, { seed: 2, t0: Date.UTC(2019, 0, 1), span: MONTH });
  const res = learn({ examplesFile: file, own: old, champion, settings: NEURAL });
  assert.equal(res.ok, false);
  assert.match(res.error, /only 0 trades it hasn't learned from/);
  // A test brain judged on its own words.
  const s = score(load(champion), synth(200, { seed: 8 }));
  assert.equal(s.n, 200);
  assert.ok(Number.isFinite(s.logLoss) && s.auc > 0.3 && s.auc < 0.7);
});

test('weight changes list the connections that moved most', () => {
  const a = new Net([3, 2, 1], { seed: 1 }).toJSON();
  const b = JSON.parse(JSON.stringify(a));
  b.W[0][5] += 0.5; // input 2 → hidden 1 (W[l][j * nIn + i])
  b.W[1][0] -= 0.1;
  const ch = weightChanges(a, b);
  assert.deepEqual(ch[0], { l: 0, i: 2, j: 1, d: 0.5 });
  assert.deepEqual(ch[1], { l: 1, i: 0, j: 0, d: -0.1 });
});

// ---- the desks and the account -----------------------------------------------------------------
function floor() {
  const clock = new MarketClock('sim', 1);
  const session = new Session(clock);
  const md = new MarketData(clock);
  const broker = new Broker(md, clock);
  const risk = new RiskManager(config.risk, session);
  const fund = new Fund({ config: { ...config, feed: 'sim' }, md, clock, session, broker, risk, committee: 'off' });
  return { fund, clock, md };
}

test('every desk asks the brain: a pass is a skipped idea, an exploration trades small, and what it sensed stays off the saved record', () => {
  const { fund, md } = floor();
  md.applyTick('NAS100', 20_000, 1, fund.clock.now());
  const marcus = fund.byId.get('marcus');
  const x = Array(N_FEATURES).fill(0.25);
  const seen = [];
  let call = { take: false, verdict: 'pass', reason: 'it gives this NAS100 long a 31% chance, −0.35R expected after costs', x, p: 0.31, expR: -0.35 };
  fund.env.neural = { judge: (agent, idea) => { seen.push(idea); return call; }, observe: (agent, trade) => seen.push(trade) };
  assert.equal(marcus.openTrade({ side: 'LONG', stop: 19_950, target: 20_100, reason: 'ORB' }), false);
  assert.equal(seen[0].symbol, 'NAS100');
  assert.equal(seen[0].external, false);
  assert.match(marcus.day.whyNot.text, /the neural brain passed: it gives this NAS100 long a 31% chance/);
  assert.equal(marcus.day.skipped, 1);

  call = { take: true, verdict: 'take', x, p: 0.6, expR: 0.2, version: 3 };
  assert.equal(marcus.openTrade({ side: 'LONG', stop: 19_950, target: 20_100, reason: 'ORB' }), true);
  const full = marcus.plans.get('NAS100').qty;
  assert.deepEqual(marcus.plans.get('NAS100').neural, { p: 0.6, expR: 0.2, explore: false, verdict: 'take', version: 3 });
  marcus.closeTrade('NAS100', 'test');
  const t = fund.broker.book('marcus').trades.at(-1);
  assert.equal(seen.at(-1), t, 'the brain hears how it ended');
  assert.deepEqual(t.neural.x, x, 'what it sensed, to learn from');
  assert.equal(JSON.parse(JSON.stringify(t)).neural.x, undefined, '… but not saved or sent with every trade');
  assert.equal(JSON.parse(JSON.stringify(t)).neural.p, 0.6);

  call = { take: true, verdict: 'explore', explore: true, sizeMult: NEURAL.exploreSize, x, p: 0.3, expR: -0.3 };
  marcus.cooldownBars = 0;
  assert.equal(marcus.openTrade({ side: 'LONG', stop: 19_950, target: 20_100, reason: 'ORB' }), true);
  const small = marcus.plans.get('NAS100');
  assert.ok(small.qty < full * 0.3, `exploration size ${small.qty} vs ${full}`);
  assert.equal(small.neural.explore, true);
  // An exploration is the brain's experiment, not the desk's record (which the account goes by).
  const before = { ...marcus.lifetime };
  marcus.closeTrade('NAS100', 'test');
  assert.equal(fund.broker.book('marcus').trades.at(-1).neural.explore, true);
  assert.equal(marcus.lifetime.trades, before.trades + 1);
  assert.equal(marcus.lifetime.countR, before.countR);
  assert.equal(marcus.lifetime.sumR, before.sumR);
});

test('the account: an idea the brain passed on never reaches FTMO, training or not, and the plan says what the brain may do', () => {
  const { fund } = floor();
  const marcus = fund.byId.get('marcus');
  const pos = { symbol: 'NAS100', qty: 1 };
  const plan = { grade: 'A', neural: { p: 0.41, expR: -0.18, explore: true, verdict: 'explore' } };
  for (const training of [false, true]) {
    const p = { ...normalizeProfile({ program: '2-step', type: 'trial', size: 10_000, training }, {}), symbolMap: {} };
    const live = {
      login: '1', profile: p, account: { equity: 10_000, balance: 10_000 }, halt: null, bridge: { serverDay: '2026.10.14' }, links: new Map(),
      metrics: () => guardMetrics(p, { balance: 10_000, equity: 10_000, closedToday: 0 }, 0, {}),
      consistency: () => null,
      fund: { agents: [], env: { neural: { ready: true, trust: NEURAL.trust, skill: () => ({ trusted: false, auc: 0.506 }) } } },
    };
    const brain = new AccountBrain(live);
    const v = brain.allow(marcus, pos, plan);
    assert.equal(v.ok, false);
    assert.match(v.reason, /the neural brain passed on this idea \(41% chance, −0\.18R expected\): it trades small on paper only/);
    assert.equal(skipCategory(v.reason), 'Neural brain\'s paper experiment');
    const rule = brain.state().rules.find((r) => /Neural brain/.test(r.text));
    assert.match(rule.text, /Neural brain is learning: it judges every idea .* decides nothing for the account .*\(skill 0\.506 now, it needs 0\.55\)/);
  }
});

test('the brain that ships with the floor: trained on long real history, with its honest test', () => {
  const shipped = JSON.parse(fs.readFileSync(SHIPPED_BRAIN, 'utf8'));
  const brain = load(shipped);
  assert.ok(brain.judge(Array(N_FEATURES).fill(0), 'amara').p > 0);
  assert.ok(shipped.trainedOn.n > 5000);
  assert.ok(shipped.validation.all.n > 5000, 'judged on thousands of trades from months it never saw');
  assert.ok(shipped.validation.months.length >= 12);
  assert.ok(Number.isFinite(shipped.validation.all.auc));
  assert.ok(Object.keys(shipped.insights).length >= 8);
  assert.match(shipped.source, /Oanda/);
  const ex = loadShippedExamples(SHIPPED_EXAMPLES);
  assert.equal(ex.length, shipped.trainedOn.n);
  assert.ok(ex.every((e) => e.x.length === N_FEATURES && Number.isFinite(e.r) && e.desk));
});
