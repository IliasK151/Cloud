import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { DeepNet, Adam } from '../server/deep/model.js';
import { candleTokens, pretrainSamples, packTokens, unpackTokens, expertOf, SLOTS, FEATS, CANDLES } from '../server/deep/tokens.js';
import { nearest, pca3, project, unit, packVecs, unpackVecs } from '../server/deep/memory.js';
import { learn, fitNet, buildMemory, scoreOn, judgeWith } from '../server/deep/train.js';
import { DeepBrain, DEEP_BRAIN } from '../server/deep/brain.js';
import { auc } from '../server/neural/net.js';
import { mulberry32, gaussian } from '../server/util/random.js';
import { MarketClock, Session } from '../server/market/session.js';
import { MarketData } from '../server/market/marketData.js';
import { Broker } from '../server/engine/broker.js';
import { RiskManager } from '../server/engine/risk.js';
import { Fund } from '../server/engine/fund.js';

const SMALL = { d: 16, heads: 2, ffn: 32, expertHidden: 8 };
const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'deep-'));

// A random walk of 1-minute bars (time in seconds), with no gaps.
function walk(n, { seed = 1, start = Math.floor(Date.UTC(2026, 0, 5) / 1000), px = 100, vol = 0.05 } = {}) {
  const r = mulberry32(seed);
  const bars = [];
  for (let i = 0; i < n; i++) {
    const o = px;
    px += gaussian(r) * vol;
    bars.push({ time: start + i * 60, open: o, high: Math.max(o, px) + Math.abs(gaussian(r)) * vol * 0.4, low: Math.min(o, px) - Math.abs(gaussian(r)) * vol * 0.4, close: px, volume: 100 + r() * 20 });
  }
  return bars;
}

// Practice trades where the outcome hangs on one candle: a long rejection wick under the last
// 5-minute candle before the entry wins 80% of the time, otherwise 20%. The senses are noise.
function planted(n, { seed = 3 } = {}) {
  const r = mulberry32(seed);
  const bars = walk(60 * 24 * 30, { seed: seed + 1 });
  const out = [];
  for (let k = 0; k < n; k++) {
    const end = 400 + Math.floor(r() * (bars.length - 500));
    const plant = r() < 0.5;
    if (plant) { const b = bars[end - 3]; b.low = Math.min(b.open, b.close) - 0.35; }
    const tk = candleTokens(bars, { side: 'LONG', end });
    if (!tk) continue;
    const win = plant ? r() < 0.8 : r() < 0.2;
    out.push({ desk: 'marcus', symbol: 'NAS100', side: 'LONG', t: bars[end].time * 1000, x: Array.from({ length: 49 }, () => Math.round(gaussian(r) * 1000) / 1000), r: win ? 2 : -1, ...packTokens(tk), src: 'replay' });
  }
  return { bars, examples: out };
}

let trainedOnce = null;
async function trained() {
  if (trainedOnce) return trainedOnce;
  const { bars, examples } = planted(700);
  const res = await learn({ history: { NAS100: bars }, replays: examples, shipped: [], own: [], champion: null, mlp: null, seed: 1, now: Date.UTC(2026, 1, 20), settings: { arch: SMALL, epochs: 30, patience: 6, minEpochs: 12, lr: 0.004, pretrain: { perMarket: 600, epochs: 1 } } });
  trainedOnce = { res, bars, examples };
  return trainedOnce;
}

test('every gradient of the transformer and its experts matches a numerical estimate', () => {
  const net = new DeepNet({ d: 8, heads: 2, layers: 2, ffn: 8, feats: 8, senses: 6, slots: 5, experts: 3, expertHidden: 4 }, { seed: 3 });
  const r = mulberry32(9);
  for (let i = 0; i < net.size; i++) net.theta[i] += gaussian(r) * 0.3;
  const ex = { tok: Float64Array.from({ length: 4 * 8 }, () => gaussian(r)), slots: [0, 1, 2, 3], x: Float64Array.from({ length: 6 }, () => gaussian(r)), market: 1 };
  for (const mode of ['trade', 'pretrain']) {
    const loss = () => { const p = net.forward(ex, mode).p; return -Math.log(p); };
    const g = net.newGrad();
    const c = net.forward(ex, mode);
    net.backward(c, c.p - 1, g);
    let worst = 0;
    for (let i = 0; i < net.size; i++) {
      const old = net.theta[i];
      net.theta[i] = old + 1e-6;
      const a = loss();
      net.theta[i] = old - 1e-6;
      const b = loss();
      net.theta[i] = old;
      const num = (a - b) / 2e-6;
      const scale = Math.abs(num) + Math.abs(g.flat[i]);
      if (scale > 1e-8) worst = Math.max(worst, Math.abs(num - g.flat[i]) / scale);
    }
    assert.ok(worst < 1e-4, `${mode}: worst relative gradient error ${worst}`);
  }
});

test('the network saves and loads exactly, and refuses a damaged copy', () => {
  const net = new DeepNet(SMALL, { seed: 4 });
  net.scaler = { mean: new Array(49).fill(0), sd: new Array(49).fill(1) };
  const r = mulberry32(2);
  const ex = { tok: Float64Array.from({ length: 6 * FEATS }, () => gaussian(r)), slots: [0, 3, 7, 12, 18, 23], x: Float64Array.from({ length: 49 }, () => gaussian(r)), market: 4 };
  const back = DeepNet.from(JSON.parse(JSON.stringify(net.toJSON())));
  assert.ok(Math.abs(back.predict(ex) - net.predict(ex)) < 1e-6);
  assert.deepEqual(back.scaler, net.scaler);
  const bad = net.toJSON();
  bad.theta.pop();
  assert.throws(() => DeepNet.from(bad), /different shape/);
  assert.throws(() => DeepNet.from({ v: 99 }), /not a saved deep brain/);
  // Attention weights for the idea: one row per layer and head, summing to 1 over the candles.
  const att = net.attention(net.forward(ex, 'trade'));
  assert.equal(att.length, 2);
  assert.equal(att[0].length, SMALL.heads);
  for (const L of att) for (const h of L) assert.ok(h.reduce((s, w) => s + w, 0) <= 1 + 1e-9);
  // AdamW moves the numbers and clears the gradient.
  const before = net.theta.slice();
  const g = net.newGrad();
  const c = net.forward(ex, 'trade');
  net.backward(c, c.p - 1, g);
  new Adam(net).step(g, 1);
  assert.ok(net.theta.some((v, i) => v !== before[i]));
  assert.ok(g.flat.every((v) => v === 0));
});

test('candle tokens: four timeframes, turned to the trade\'s side, sized by the market, and nothing from the future', () => {
  const bars = walk(2000, { seed: 5 });
  const tk = candleTokens(bars, { side: 'LONG', end: 1500 });
  assert.equal(tk.slots.length, CANDLES);
  assert.equal(tk.tok.length, CANDLES * FEATS);
  assert.deepEqual(tk.slots, Array.from({ length: CANDLES }, (_, i) => i));
  assert.ok(tk.meta.every((m, i) => i === 0 || m.tf < tk.meta[i - 1].tf || m.t > tk.meta[i - 1].t), 'each timeframe in time order');
  // The newest candle of every timeframe ends where the idea is.
  for (const tf of [60, 15, 5, 1]) {
    const last = tk.meta.filter((m) => m.tf === tf).at(-1);
    assert.equal(last.t + tf * 60, bars[1499].time + 60);
  }
  // Bars after the idea change nothing.
  const later = bars.map((b, i) => (i >= 1500 ? { ...b, close: b.close + 50, high: b.high + 50 } : b));
  assert.deepEqual(Array.from(candleTokens(later, { side: 'LONG', end: 1500 }).tok), Array.from(tk.tok));
  // A short on the mirror image of the market reads exactly like a long on the market.
  const mirror = bars.map((b) => ({ ...b, open: 200 - b.open, close: 200 - b.close, high: 200 - b.low, low: 200 - b.high }));
  const short = candleTokens(mirror, { side: 'SHORT', end: 1500 });
  tk.tok.forEach((v, i) => assert.ok(Math.abs(v - short.tok[i]) < 1e-9, `feature ${i % FEATS}`));
  // The same market at 100× the price reads the same.
  const big = bars.map((b) => ({ ...b, open: b.open * 100, high: b.high * 100, low: b.low * 100, close: b.close * 100 }));
  candleTokens(big, { side: 'LONG', end: 1500 }).tok.forEach((v, i) => assert.ok(Math.abs(v - tk.tok[i]) < 1e-9));
  // Too little to read.
  assert.equal(candleTokens(bars.slice(0, 20), { side: 'LONG' }), null);
  assert.equal(candleTokens([], {}), null);
  // A gap leaves its candles out instead of inventing them.
  const gappy = bars.filter((b, i) => i < 1200 || i > 1440);
  const g = candleTokens(gappy, { side: 'LONG', end: gappy.findIndex((b) => b.time === bars[1499].time) + 1 });
  assert.ok(g.slots.length < CANDLES && g.slots.length >= 6);
  // Saved and back.
  const back = unpackTokens(JSON.parse(JSON.stringify(packTokens(tk))));
  assert.deepEqual(back.slots, tk.slots);
  back.tok.forEach((v, i) => assert.ok(Math.abs(v - tk.tok[i]) <= 0.0005));
  assert.equal(unpackTokens({ tok: [1, 2], slots: [0] }), null);
  assert.equal(expertOf('XAUUSD'), 2);
  assert.equal(expertOf('SOLUSD'), 4);
  assert.equal(SLOTS, CANDLES + 1);
});

test('pre-training lessons are labelled by what price did 15 minutes later', () => {
  const bars = walk(4000, { seed: 6 });
  const s = pretrainSamples(bars, { n: 200, rng: mulberry32(1) });
  assert.ok(s.length > 100);
  for (const e of s.slice(0, 50)) assert.ok(e.y === 0 || e.y === 1);
  assert.deepEqual(pretrainSamples(bars.slice(0, 300), { n: 10 }), []);
  // Higher 15 minutes later: every label 1 on a market that only rises.
  const up = walk(3000, { seed: 7, vol: 0 }).map((b, i) => ({ ...b, open: 100 + i * 0.01, close: 100 + i * 0.01 + 0.01, high: 100 + i * 0.01 + 0.02, low: 100 + i * 0.01 - 0.01 }));
  const ups = pretrainSamples(up, { n: 50, rng: mulberry32(2) });
  assert.ok(ups.length > 0 && ups.every((e) => e.y === 1));
});

test('memory: the closest past trades, the galaxy\'s axes, and saving', () => {
  const r = mulberry32(8);
  const d = 6;
  const n = 300;
  const vecs = new Float32Array(n * d);
  for (let i = 0; i < n; i++) vecs.set(unit(Array.from({ length: d }, () => gaussian(r))), i * d);
  const q = unit(Array.from({ length: d }, () => gaussian(r)));
  const got = nearest(vecs, d, q, 7);
  const brute = Array.from({ length: n }, (_, i) => ({ i, s: Array.from({ length: d }, (_, j) => vecs[i * d + j] * q[j]).reduce((a, b) => a + b, 0) })).sort((a, b) => b.s - a.s).slice(0, 7);
  assert.deepEqual(got.map((x) => x.i), brute.map((x) => x.i));
  const pca = pca3(vecs, d);
  for (let a = 0; a < 3; a++) {
    for (let b = 0; b < 3; b++) {
      const dot = pca.basis[a].reduce((s, v, j) => s + v * pca.basis[b][j], 0);
      assert.ok(Math.abs(dot - (a === b ? 1 : 0)) < 1e-6, 'the axes are orthonormal');
    }
  }
  assert.deepEqual(project(pca, pca.mean).map((v) => Math.round(v * 1e9)), [0, 0, 0]);
  assert.deepEqual(Array.from(unpackVecs(packVecs(vecs))), Array.from(vecs));
});

test('it finds a pattern in the candles that the senses don\'t have, and is tested fairly', async () => {
  const { res } = await trained();
  assert.equal(res.ok, true, res.error);
  assert.equal(res.adopted, true, 'the first version is always kept');
  const v = res.validation.challenger;
  assert.ok(v.n >= 100, 'the newest quarter kept back');
  assert.ok(v.auc > 0.65, `skill on unseen trades ${v.auc}`);
  assert.ok(v.pickedR > v.allR, 'its picks beat taking every trade');
  assert.ok(res.model.pretrain.n > 0, 'it pre-trained on the prices');
  assert.ok(res.validation.from > 0);
  // Its memory: every trade it learned from, on three axes.
  assert.equal(res.memory.n, res.data.replays);
  assert.equal(res.memory.meta.length, res.memory.n);
  assert.ok(res.memory.galaxy.length > 100);
  assert.ok(res.memory.galaxy.every((p) => p.length === 5 && p.slice(0, 3).every(Number.isFinite)));
});

test('too little history: it says how much more it needs instead of learning from nothing', async () => {
  const res = await learn({ history: {}, replays: [], shipped: [], own: [], seed: 1 });
  assert.equal(res.ok, false);
  assert.match(res.error, /needs at least 60 trades replayed on your saved prices/);
});

test('a new version is kept only if it judges the newest trades better', async () => {
  const { res, bars, examples } = await trained();
  // The same lesson again, starting from the kept version: the challenger must beat it.
  const again = await learn({ history: { NAS100: bars }, replays: examples.map((e) => ({ ...e, r: -e.r })), shipped: [], own: [], champion: res.model, seed: 2, now: Date.UTC(2026, 1, 21), settings: { arch: SMALL, epochs: 2, patience: 1, pretrain: { perMarket: 50, epochs: 1 } } });
  assert.equal(again.ok, true);
  assert.ok(again.validation.champion, 'the current version is judged on the same trades');
  if (!again.adopted) assert.equal(again.model, undefined);
  else assert.ok(again.validation.challenger.logLoss < again.validation.champion.logLoss);
});

test('the router asks the market\'s own expert first, and the experts learn different markets', () => {
  const net = new DeepNet({ ...SMALL, senses: 4 }, { seed: 5 });
  const r = mulberry32(11);
  const make = (market) => {
    const x = Float64Array.from({ length: 4 }, () => gaussian(r));
    const p = market === 0 ? (x[0] > 0 ? 0.85 : 0.15) : (x[0] < 0 ? 0.85 : 0.15);
    return { tok: new Float64Array(0), slots: [], x, market, y: r() < p ? 1 : 0, src: { r: 0 } };
  };
  const g0 = net.forward(make(0), 'trade').gates;
  assert.ok(g0[0] > g0[1] && g0[0] > 0.4, 'the prior points at the market\'s own expert');
  const train = Array.from({ length: 1600 }, (_, i) => make(i % 2 ? 0 : 4));
  const val = Array.from({ length: 400 }, (_, i) => make(i % 2 ? 0 : 4));
  fitNet(net, train, val, { epochs: 25, patience: 6, lr: 3e-3 });
  const p = val.map((e) => net.forward(e, 'trade').p);
  assert.ok(auc(val.map((e) => e.y), p) > 0.75, 'opposite rules in two markets, both learned');
});

// ---- the brain on the floor ---------------------------------------------------------------------
function deskWith(bars) {
  return { id: 'marcus', profile: { name: 'Marcus Reid' }, env: { md: { bars: () => bars }, clock: { now: () => bars.at(-1).time * 1000 + 30_000 } } };
}

async function brainWith(opts = {}) {
  const { res, bars } = await trained();
  const dir = tmp();
  const brain = new DeepBrain({ dataDir: dir, mode: 'live', inline: true, rng: opts.rng || mulberry32(1), now: () => Date.UTC(2026, 2, 2, 15), trainer: async () => res, history: { recent: () => bars.slice(-420), span: () => ({ from: bars[0].time }), isReal: () => true, save: () => {} }, ...opts });
  return { brain, dir, bars, res };
}

const until = async (fn, ms = 5000) => {
  const t0 = Date.now();
  while (!fn()) {
    if (Date.now() - t0 > ms) throw new Error('timed out');
    await new Promise((r) => setTimeout(r, 10));
  }
};

test('before its first lesson it has no opinion; its first lesson is kept and saved', async () => {
  const { brain, dir } = await brainWith();
  assert.equal(brain.judge(deskWith(walk(500)), { symbol: 'NAS100', side: 'LONG', entry: 100, stop: 99 }), null);
  assert.equal(brain.view().status, 'untrained');
  assert.equal(brain.isDue(), true, 'enough saved history: it learns at once');
  const learned = [];
  brain.on('learned', (e) => learned.push(e));
  assert.equal(brain.retrain('first').ok, true);
  assert.equal(brain.retrain('again').ok, false, 'one lesson at a time');
  await until(() => learned.length);
  assert.equal(learned[0].adopted, true);
  assert.match(learned[0].text, /deep brain learned \(v1\)/);
  assert.equal(brain.state.version, 1);
  for (const f of ['model.json', 'memory.json', 'state.json', 'own.json']) assert.ok(fs.existsSync(path.join(dir, 'deep', f)), f);
  // A restart loads it back.
  const again = new DeepBrain({ dataDir: dir, mode: 'live' });
  assert.equal(again.ready, true);
  assert.equal(again.state.version, 1);
  assert.equal(again.memory.n, brain.memory.n);
});

test('it judges an idea: real candles, attention, the experts\' trust and the closest past trades', async () => {
  const { brain, bars } = await brainWith();
  brain.retrain('first');
  await until(() => brain.ready);
  const thoughts = [];
  brain.on('thought', (t) => thoughts.push(t));
  const out = brain.judge(deskWith(bars), { symbol: 'NAS100', side: 'LONG', entry: bars.at(-1).close, stop: bars.at(-1).close - 0.3, x: new Array(49).fill(0) });
  assert.equal(out.take, true);
  assert.equal(out.verdict, 'learning', 'it watches until it has earned a say');
  assert.ok(out.p > 0 && out.p < 1 && Number.isFinite(out.expR));
  const t = thoughts[0];
  assert.equal(t.candles.length, CANDLES);
  assert.equal(t.attn.length, 2);
  assert.equal(t.attn[0][0].length, CANDLES);
  assert.equal(t.gates.length, 5);
  assert.ok(Math.abs(t.gates.reduce((s, g) => s + g, 0) - 1) < 0.01);
  assert.equal(t.near.length, DEEP_BRAIN.near);
  assert.ok(t.near.every((n) => n.pos.length === 3 && Number.isFinite(n.r)));
  assert.equal(t.nearWon, t.near.filter((n) => n.r > 0).length);
  assert.equal(t.top.length, 3);
  assert.ok(brain.pending.has(out.id));
  // TradingView alerts are the boss's own: always taken.
  assert.equal(brain.judge(deskWith(bars), { symbol: 'NAS100', side: 'LONG', entry: 100, stop: 99, x: new Array(49).fill(0), external: true }).verdict, 'yours');
});

test('it learns from the floor\'s closed trades on real prices only, and remembers them', async () => {
  const { brain, bars } = await brainWith();
  brain.retrain('first');
  await until(() => brain.ready);
  const out = brain.judge(deskWith(bars), { symbol: 'NAS100', side: 'LONG', entry: 100, stop: 99, x: new Array(49).fill(0.1) });
  const outcomes = [];
  brain.on('outcome', (o) => outcomes.push(o));
  const memBefore = brain.view().memory.n;
  brain.observe({ id: 'marcus' }, { symbol: 'NAS100', r: 1.8, deep: { id: out.id, explore: false } });
  assert.equal(brain.own.length, 1);
  assert.equal(brain.own[0].r, 1.8);
  assert.equal(brain.own[0].slots.length, CANDLES, 'the candles it was judged on are kept');
  assert.equal(brain.view().memory.n, memBefore + 1, 'a new star');
  assert.equal(outcomes[0].kept, true);
  assert.equal(brain.galaxy().points.at(-1)[4], 2, 'drawn as the floor\'s own');
  // Kept across a restart.
  brain.flush();
  const again = new DeepBrain({ dataDir: brain.dir.replace(/[\\/]deep$/, ''), mode: 'live' });
  assert.equal(again.own.length, 1);
  assert.equal(again.liveMem.length, 1);
  // Stand-in prices never teach it.
  const out2 = brain.judge(deskWith(bars), { symbol: 'NAS100', side: 'LONG', entry: 100, stop: 99, x: new Array(49).fill(0.1) });
  brain.observe({ id: 'marcus' }, { symbol: 'NAS100', r: -1, simFeed: true, deep: { id: out2.id } });
  assert.equal(brain.own.length, 1);
  assert.equal(outcomes[1].kept, false);
  // Nothing it didn't judge.
  brain.observe({ id: 'marcus' }, { symbol: 'NAS100', r: 1 });
  brain.observe({ id: 'marcus' }, { symbol: 'NAS100', r: 1, deep: { id: 'nope' } });
  assert.equal(brain.own.length, 1);
});

test('once its record earns a say it passes the ideas it expects to lose, a few on paper; never with no say', async () => {
  const draws = [0.9];
  const { brain, bars } = await brainWith({ rng: () => draws.shift() ?? 0.9 });
  brain.retrain('first');
  await until(() => brain.ready);
  // 300 trades on real prices where what it said ranked them well.
  const r = mulberry32(4);
  brain.own = Array.from({ length: 320 }, () => {
    const won = r() < 0.5;
    const p = won ? 0.55 + r() * 0.3 : 0.15 + r() * 0.3;
    return { desk: 'marcus', symbol: 'NAS100', t: 1, x: new Array(49).fill(0), r: won ? 2 : -1, p, expR: p * 2 - (1 - p), explore: false };
  });
  brain.skillCache = null;
  assert.equal(brain.skill().trusted, true, brain.skill().text);
  brain.judgeFn = () => ({ p: 0.2, expR: -0.4, cache: brain.net.forward({ tok: new Float64Array(0), slots: [], x: null, market: 0 }, 'trade') });
  const idea = { symbol: 'NAS100', side: 'LONG', entry: 100, stop: 99, x: new Array(49).fill(0) };
  const pass = brain.judge(deskWith(bars), idea);
  assert.equal(pass.take, false);
  assert.match(pass.reason, /20% chance, −0.40R expected/);
  draws.push(0.9, 0.1); // next: an exploration
  const explore = brain.judge(deskWith(bars), idea);
  assert.equal(explore.take, true);
  assert.equal(explore.verdict, 'explore');
  assert.equal(explore.sizeMult, DEEP_BRAIN.exploreSize);
  // The desks trade their own way: it watches only.
  assert.equal(brain.judge(deskWith(bars), { ...idea, noSay: true }).verdict, 'learning');
});

test('demo mode never teaches it, and it waits for enough saved history', async () => {
  const { brain } = await brainWith({ mode: 'sim' });
  assert.equal(brain.isDue(), false);
  assert.match(brain.retrain('asked').error, /real prices only/);
  const short = await brainWith({ history: { recent: () => [], span: () => ({ from: Math.floor(Date.UTC(2026, 2, 1) / 1000) }), isReal: () => true } });
  assert.equal(short.brain.isDue(), false, 'a day of prices is not enough');
  const failed = await brainWith({ trainer: async () => ({ ok: false, error: 'it needs at least 60 trades replayed on your saved prices to learn from, and has 12' }) });
  const learned = [];
  failed.brain.on('learned', (e) => learned.push(e));
  failed.brain.retrain('first');
  await until(() => learned.length);
  assert.equal(learned[0].failed, true);
  assert.match(failed.brain.view().lastError.text, /has 12/);
  assert.equal(failed.brain.isDue(), false, 'it tries again later, not every minute');
});

test('a desk asks the deep brain at the entry: a pass stops the trade, its call travels with it', () => {
  const clock = new MarketClock('live');
  const session = new Session(clock);
  session.isFlattenWindow = () => false;
  const md = new MarketData(clock);
  const broker = new Broker(md, clock);
  const risk = new RiskManager({ riskPerTradePct: 0.005, deskDailyLossPct: 0.02, fundDailyLossPct: 0.012, maxLeverage: 4 }, session);
  const fund = new Fund({ config: { startingCapital: 100_000_000, feed: 'live', fundName: 'Test' }, md, clock, session, broker, risk, committee: 'off' });
  md.applyTick('XAUUSD', 3800.1, 1, clock.now());
  const amara = fund.byId.get('amara');
  amara.againstTopDown = () => null;
  const asked = [];
  const seen = [];
  fund.env.deep = {
    judge: (a, x) => { asked.push(x); return x.side === 'SHORT' && !x.noSay ? { take: false, id: 'd1', reason: 'it gives this XAUUSD short a 22% chance, −0.35R expected after costs' } : { take: true, id: 'd2', p: 0.51, expR: 0.12, verdict: 'learning' }; },
    observe: (a, t) => seen.push(t),
  };
  amara.env.ownWay = () => false;
  assert.equal(amara.openTrade({ side: 'SHORT', stop: 3810, target: 3770, reason: 'test', symbol: 'XAUUSD' }), false);
  assert.match(amara.day.whyNot.text, /deep brain passed: it gives this XAUUSD short a 22% chance/);
  assert.equal(amara.openTrade({ side: 'LONG', stop: 3790, target: 3830, reason: 'test', symbol: 'XAUUSD' }), true);
  assert.equal(amara.plans.get('XAUUSD').deep.p, 0.51);
  amara.closeTrade('XAUUSD', 'Target hit');
  assert.equal(seen.length, 1);
  assert.equal(seen[0].deep.id, 'd2');
  assert.equal(asked[0].noSay, false);
  // Their own way: it is asked, but has no say (another desk, fresh for the day).
  const theo = fund.byId.get('theo');
  theo.againstTopDown = () => null;
  theo.env.ownWay = () => true;
  const n = asked.length;
  assert.equal(theo.openTrade({ side: 'SHORT', stop: 3810, target: 3770, reason: 'test', symbol: 'XAUUSD' }), true);
  assert.equal(asked.length, n + 1);
  assert.equal(asked.at(-1).noSay, true);
});

test('the deep brain\'s explorations never go to the account', async () => {
  const { AccountBrain } = await import('../server/live/accountBrain.js');
  const ab = Object.create(AccountBrain.prototype);
  ab.live = { ftmoOnly: false };
  ab.state = () => ({});
  const out = ab.allow({ id: 'amara' }, { symbol: 'XAUUSD', qty: 1, trade: {} }, { deep: { explore: true, p: 0.3, expR: -0.2 } });
  assert.equal(out.ok, false);
  assert.match(out.reason, /deep brain passed on this idea \(30% chance, −0.20R expected\)/);
});

test('scoring on kept-back trades: skill, picks and every trade', () => {
  const list = [
    { y: 1, src: { r: 2 } }, { y: 0, src: { r: -1 } }, { y: 1, src: { r: 1.5 } }, { y: 0, src: { r: -1 } },
  ];
  const s = scoreOn((ex) => ({ p: ex.y ? 0.7 : 0.3, expR: ex.y ? 0.4 : -0.3 }), list);
  assert.equal(s.picked, 2);
  assert.equal(s.pickedR, 1.75);
  assert.equal(s.allR, 0.375);
  const net = new DeepNet(SMALL, { seed: 1 });
  const j = judgeWith(net, { '*': { win: 2, loss: 1 } })({ tok: new Float64Array(0), slots: [], x: null, market: 0 }, 'x');
  assert.ok(Math.abs(j.expR - (j.p * 2 - (1 - j.p))) < 1e-12);
  const mem = buildMemory(net, [{ desk: 'a', symbol: 'NAS100', t: 1, r: 1, x: new Array(49).fill(0), src: 'own' }], null, { galaxy: 10 });
  assert.equal(mem.n, 1);
  assert.equal(mem.galaxy[0][4], 2);
});
