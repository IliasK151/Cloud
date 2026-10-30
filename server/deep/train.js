import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';
import { ROSTER } from '../engine/roster.js';
import { SYMBOLS } from '../market/symbols.js';
import { senseTrade, toArray, N_FEATURES } from '../neural/features.js';
import { auc, logLoss, scaler, scale } from '../neural/net.js';
import { deskStats, load as loadMlp } from '../neural/train.js';
import { mulberry32 } from '../util/random.js';
import { DeepNet, Adam } from './model.js';
import { candleTokens, pretrainSamples, expertOf, packTokens, unpackTokens, lowerBound, SLOTS, FEATS } from './tokens.js';
import { unit, pca3, project, packVecs } from './memory.js';

// How the deep brain learns, on your own computer, from real prices only.
//
// 1. Practice trades: every desk is replayed, minute by minute, through the floor's own code on
//    the 1-minute prices the floor has saved in data/history (your broker's, from MT5, and the
//    public feeds'; never simulated ones). Each entry is kept with the candles before it, what
//    the neural brain sensed, and how the trade ended. Replays are kept in data/deep and only
//    redone for a market once it has days of new prices.
// 2. Pre-training, like a language model: before it sees a single trade, the transformer learns
//    to read candles by guessing whether price is higher 15 minutes later, at thousands of
//    moments across the history (no labels needed).
// 3. Learning trades: the whole network (transformer, router and experts) then learns which
//    trades won, from the replays, the floor's own trades on real prices (counted 3×), and the
//    long history the neural brain shipped with (senses only, no candles, counted half).
// 4. The fair test: the newest quarter of the trades with candles is kept back. The new
//    network, the current one and the neural brain all judge those trades, which none of them
//    learned from. The new one is kept only if it does better than the current one.
// 5. Memory: every trade's vector from the kept network, for "the 12 most similar past trades"
//    and the galaxy in the Brain tab.

export const DEEP = {
  epochs: 40, patience: 6, minEpochs: 10, batch: 32, lr: 3e-3, wd: 1e-4, dropout: 0.3,
  pretrain: { perMarket: 2500, epochs: 3, lr: 3e-3, batch: 64, maxAgeDays: 7 },
  valShare: 0.25, // the newest share of the trades with candles, kept back for the fair test
  // Trades with candles needed before it learns at all. Few on purpose: the desks take a trade or
  // two a day and MT5 keeps about ten weeks, and reading candles is learned in pre-training
  // (no trades needed). Its say still waits for its record (DEEP_BRAIN.trust in deep/brain.js).
  minCandleTrades: 60,
  minHistoryDays: 21, // a market needs this much saved history before its desks are replayed
  replayFreshDays: 3, // a market's replays are redone once it has this many days of new prices
  weights: { shipped: 0.5, replay: 1, own: 3 },
  // Its memory holds the trades with candles (replays, the floor's own). Only while there are
  // fewer than `min` of those is it topped up from the long history (senses only).
  memory: { min: 800 },
  galaxy: 2600,
  bar: 0, // the expected R an idea needs (as the neural brain)
};
const DAY = 86_400_000;
const REPLAY_V = 1;
const round = (x, d = 4) => (Number.isFinite(x) ? Math.round(x * 10 ** d) / 10 ** d : null);

// ---- the saved prices ---------------------------------------------------------------------------
// data/history/<SYMBOL>.json as the floor writes it (research/history.js): only real prices are
// ever saved there (CACHE_VERSION 2). Anything else is ignored.
export function loadHistory(dir) {
  const out = {};
  if (!dir) return out;
  for (const id of Object.keys(SYMBOLS)) {
    try {
      const raw = JSON.parse(fs.readFileSync(path.join(dir, `${id}.json`), 'utf8'));
      if (raw?.v !== 2 || !Array.isArray(raw.bars)) continue;
      const bars = raw.bars
        .map(([time, open, high, low, close, volume]) => ({ time, open, high, low, close, volume }))
        .filter((b) => [b.time, b.open, b.high, b.low, b.close].every(Number.isFinite) && b.high >= b.low && b.close > 0)
        .sort((a, b) => a.time - b.time);
      const clean = [];
      for (const b of bars) if (!clean.length || b.time > clean[clean.length - 1].time) clean.push(b);
      if (clean.length) out[id] = clean;
    } catch { /* not saved yet */ }
  }
  return out;
}

const daysOf = (bars) => (bars?.length ? (bars[bars.length - 1].time - bars[0].time) / 86_400 : 0);

// ---- practice trades: the desks replayed on the saved prices ------------------------------------
// The replay's neural hook records, for each entry, the senses and the candles before it.
export async function replayDesk(profile, bars, { seed = 1, replayFn = null } = {}) {
  const replay = replayFn || (await import('../../scripts/replay.js')).replay;
  const out = [];
  const pending = new Map();
  const random = Math.random;
  Math.random = mulberry32(seed);
  try {
    replay({
      profile, bars,
      neural: (agent, env) => ({
        judge(a, idea) {
          const now = env.clock.now();
          let x = null;
          try { x = senseTrade({ brain: env.marketBrain, agent: a, ...idea, now }); } catch { x = null; }
          if (!x) return { take: true };
          // Only bars closed before this moment.
          const end = lowerBound(bars, Math.floor(now / 1000) - 59);
          pending.set(now, { tk: candleTokens(bars, { side: idea.side, entry: idea.entry, end }), side: idea.side });
          return { take: true, x: toArray(x) };
        },
        observe(a, trade) {
          const x = trade?.neural?.x;
          if (!Array.isArray(x) || !Number.isFinite(trade.r)) return;
          const pd = pending.get(trade.openTime);
          pending.delete(trade.openTime);
          const tk = packTokens(pd?.tk);
          out.push({ desk: a.id, symbol: trade.symbol, side: pd?.side ?? null, t: trade.openTime, x, r: round(trade.r), ...(tk || {}), src: 'replay' });
        },
      }),
    });
  } finally {
    Math.random = random;
  }
  return out;
}

const signature = (p) => JSON.stringify([p.symbols, p.rules, p.Strategy?.strategyName, p.maxTradesPerDay, p.riskScale]);

// Every desk's practice trades, reusing the saved replays of markets without new prices.
export async function practiceTrades(history, { cacheFile = null, seed = 1, progress = () => {}, replayFn = null, settings = DEEP, roster = ROSTER } = {}) {
  let cache = { v: REPLAY_V, desks: {} };
  if (cacheFile) {
    try {
      const raw = JSON.parse(zlib.gunzipSync(fs.readFileSync(cacheFile)).toString('utf8'));
      if (raw?.v === REPLAY_V && raw.desks) cache = raw;
    } catch { /* first time */ }
  }
  const all = [];
  const desks = roster.filter((p) => !p.retired && daysOf(history[p.symbols?.[0]]) >= settings.minHistoryDays);
  let changed = false;
  for (let i = 0; i < desks.length; i++) {
    const p = desks[i];
    const sym = p.symbols[0];
    const bars = history[sym];
    const to = bars[bars.length - 1].time;
    const hit = cache.desks[p.id];
    const fresh = hit && hit.sig === signature(p) && hit.from <= bars[0].time + 86_400 && (to - hit.to) / 86_400 < settings.replayFreshDays;
    if (fresh) {
      all.push(...hit.examples);
      continue;
    }
    progress({ stage: 'replay', pct: i / desks.length, text: `Replaying ${p.name.split(' ')[0]} on your ${sym} prices (${i + 1} of ${desks.length})` });
    const examples = await replayDesk(p, bars, { seed: seed + i, replayFn });
    cache.desks[p.id] = { sig: signature(p), symbol: sym, from: bars[0].time, to, at: Date.now(), examples };
    changed = true;
    all.push(...examples);
  }
  if (changed && cacheFile) {
    try {
      fs.mkdirSync(path.dirname(cacheFile), { recursive: true });
      fs.writeFileSync(`${cacheFile}.tmp`, zlib.gzipSync(JSON.stringify(cache)));
      fs.renameSync(`${cacheFile}.tmp`, cacheFile);
    } catch { /* the replays are redone next time */ }
  }
  return { examples: all, desks: desks.length };
}

// ---- training ---------------------------------------------------------------------------------
function shuffle(a, rng) {
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(rng() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}

// One pass over examples in mini-batches; mode 'trade' or 'pretrain'. Returns nothing: the
// network's numbers change in place.
// Input dropout on the senses: each pass hides a random share of them, so the network can't lean
// on memorising a few senses of a few trades and has to find what holds up (in the candles too).
function epoch(net, opt, grad, list, mode, batch, rng, dropout = 0) {
  const order = shuffle(list.map((_, i) => i), rng);
  let n = 0;
  let sw = 0;
  for (const i of order) {
    let e = list[i];
    const w = e.w ?? 1;
    if (dropout > 0 && e.x) {
      const k = 1 / (1 - dropout);
      e = { ...e, x: Float64Array.from(e.x, (v) => (rng() < dropout ? 0 : v * k)) };
    }
    const c = net.forward(e, mode);
    net.backward(c, w * (c.p - e.y), grad);
    sw += w;
    if (++n === batch) { opt.step(grad, sw); n = 0; sw = 0; }
  }
  if (n) opt.step(grad, sw);
}

function lossOn(net, list, mode) {
  if (!list.length) return NaN;
  let s = 0;
  for (const e of list) {
    const p = Math.min(1 - 1e-7, Math.max(1e-7, net.forward(e, mode).p));
    s += -(e.y ? Math.log(p) : Math.log(1 - p));
  }
  return s / list.length;
}

// Early-stopped training: keeps the numbers that did best on the held-back list.
// It always gets minEpochs passes: reading candles takes a few passes to start paying off, and
// stopping at the first flat stretch would stop it before it learned anything.
export function fitNet(net, train, val, { mode = 'trade', epochs = DEEP.epochs, patience = DEEP.patience, minEpochs = 0, lr = DEEP.lr, wd = DEEP.wd, batch = DEEP.batch, dropout = 0, seed = 1, onEpoch = () => {} } = {}) {
  const rng = mulberry32(seed);
  const opt = new Adam(net, { lr, wd });
  const grad = net.newGrad();
  let best = { loss: lossOn(net, val, mode), theta: net.theta.slice(), epoch: -1 };
  for (let ep = 0; ep < epochs; ep++) {
    epoch(net, opt, grad, train, mode, batch, rng, dropout);
    const l = lossOn(net, val, mode);
    onEpoch(ep, l);
    if (l < best.loss - 1e-5) best = { loss: l, theta: net.theta.slice(), epoch: ep };
    else if (ep + 1 >= minEpochs && ep - best.epoch >= patience) break;
  }
  net.theta.set(best.theta);
  return { bestEpoch: best.epoch, loss: round(best.loss) };
}

// A training example for the network from a saved trade: scaled senses, its candles (if any),
// and which expert its market starts with.
export function asExample(e, sc) {
  const tk = unpackTokens(e) || { tok: new Float64Array(0), slots: [] };
  return {
    tok: tk.tok, slots: tk.slots,
    x: Array.isArray(e.x) && e.x.length === N_FEATURES ? (sc ? scale(e.x, sc) : Float64Array.from(e.x)) : null,
    market: expertOf(e.symbol, SYMBOLS[e.symbol]?.assetClass),
    y: e.r > 0 ? 1 : 0,
    src: e,
  };
}

// A network loaded for judging: chance, expected R, and everything the Brain tab draws.
export function judgeWith(net, stats) {
  return (ex, desk) => {
    const c = net.forward(ex, 'trade');
    const s = stats[desk] || stats['*'] || { win: 1, loss: 1 };
    return { p: c.p, expR: c.p * s.win - (1 - c.p) * s.loss, cache: c };
  };
}

// How a judge did on trades it never learned from.
export function scoreOn(judge, list, { bar = DEEP.bar } = {}) {
  if (!list.length) return null;
  const js = list.map((ex) => ({ ex, ...judge(ex) }));
  const y = js.map((q) => q.ex.y);
  const p = js.map((q) => q.p);
  const picked = js.filter((q) => q.expR >= bar);
  const a = list.length >= 20 ? auc(y, p) : NaN;
  return {
    n: list.length,
    auc: Number.isFinite(a) ? round(a, 3) : null,
    logLoss: round(logLoss(y, p), 4),
    allR: round(js.reduce((s, q) => s + q.ex.src.r, 0) / js.length, 3),
    picked: picked.length,
    pickedR: picked.length ? round(picked.reduce((s, q) => s + q.ex.src.r, 0) / picked.length, 3) : null,
  };
}

// The whole lesson. job: { history | historyDir, replayCache, shipped (array) | shippedFile, own,
// champion (saved deep brain or null), mlp (the neural brain's saved model or null), seed, now,
// settings }. progress({ stage, pct, text }) is told how it goes.
export async function learn(job, progress = () => {}) {
  const S = { ...DEEP, ...(job.settings || {}), pretrain: { ...DEEP.pretrain, ...(job.settings?.pretrain || {}) }, weights: { ...DEEP.weights, ...(job.settings?.weights || {}) } };
  const seed = job.seed || 1;
  const now = job.now || Date.now();
  progress({ stage: 'prices', pct: 0, text: 'Reading your saved prices…' });
  const history = job.history || loadHistory(job.historyDir);
  const markets = Object.fromEntries(Object.entries(history).map(([id, b]) => [id, { bars: b.length, days: round(daysOf(b), 1) }]));
  const practice = job.replays
    ? { examples: job.replays, desks: new Set(job.replays.map((e) => e.desk)).size }
    : await practiceTrades(history, { cacheFile: job.replayCache, seed, progress, replayFn: job.replayFn, settings: S });
  const replays = practice.examples.filter((e) => Array.isArray(e.x) && e.x.length === N_FEATURES && Number.isFinite(e.r));
  const own = (job.own || []).filter((e) => Array.isArray(e.x) && e.x.length === N_FEATURES && Number.isFinite(e.r)).map((e) => ({ ...e, src: 'own' }));
  let shipped = job.shipped;
  if (!shipped && job.shippedFile) {
    try {
      const raw = JSON.parse(zlib.gunzipSync(fs.readFileSync(job.shippedFile)).toString('utf8'));
      shipped = raw?.v === 1 && Array.isArray(raw.examples) ? raw.examples : [];
    } catch { shipped = []; }
  }
  shipped = (shipped || []).filter((e) => Array.isArray(e.x) && e.x.length === N_FEATURES && Number.isFinite(e.r)).map((e) => ({ ...e, src: 'history' }));
  const withCandles = [...replays, ...own].filter((e) => Array.isArray(e.slots) && e.slots.length);
  const data = { markets, replayDesks: practice.desks, replays: replays.length, own: own.length, shipped: shipped.length, withCandles: withCandles.length };
  if (withCandles.length < S.minCandleTrades) {
    return { ok: false, data, error: `it needs at least ${S.minCandleTrades} trades replayed on your saved prices to learn from, and has ${withCandles.length}. It tries again as the history grows (each market needs ${S.minHistoryDays} days of saved prices).` };
  }

  // The network: the current one to start from, or a new one.
  let champ = null;
  if (job.champion) {
    try { champ = DeepNet.from(job.champion); } catch { champ = null; }
  }
  const net = champ ? DeepNet.from(job.champion) : new DeepNet({ senses: N_FEATURES, feats: FEATS, slots: SLOTS, ...(S.arch || {}) }, { seed });
  const sc = champ?.scaler || scaler([...replays, ...own, ...shipped].map((e) => e.x));
  net.scaler = sc;

  // 2. Pre-training: learning to read candles.
  let pretrainedAt = job.champion?.pretrainedAt ?? null;
  let pretrain = job.champion?.pretrain ?? null;
  if (!pretrainedAt || now - pretrainedAt > S.pretrain.maxAgeDays * DAY) {
    const rng = mulberry32(seed + 11);
    let samples = [];
    for (const [id, bars] of Object.entries(history)) {
      progress({ stage: 'pretrain', pct: 0, text: `Reading candles from your ${id} prices…` });
      samples.push(...pretrainSamples(bars, { n: S.pretrain.perMarket, rng }));
    }
    samples = shuffle(samples, rng);
    if (samples.length >= 500) {
      const cut = Math.floor(samples.length * 0.9);
      const r = fitNet(net, samples.slice(0, cut), samples.slice(cut), {
        mode: 'pretrain', epochs: S.pretrain.epochs, patience: 2, lr: S.pretrain.lr, batch: S.pretrain.batch, seed: seed + 3,
        onEpoch: (ep) => progress({ stage: 'pretrain', pct: (ep + 1) / S.pretrain.epochs, text: `Learning to read candles, like a language model learns words: lesson ${ep + 1} of ${S.pretrain.epochs} (${samples.length.toLocaleString('en-US')} moments)` }),
      });
      const val = samples.slice(cut);
      const hit = val.reduce((s, e) => s + ((net.forward(e, 'pretrain').p >= 0.5) === (e.y === 1) ? 1 : 0), 0) / Math.max(1, val.length);
      pretrain = { n: samples.length, loss: r.loss, hit: round(hit, 3) };
      pretrainedAt = now;
    }
  }

  // 3. Learning trades, with the newest trades with candles kept back for the fair test.
  const byTime = withCandles.slice().sort((a, b) => a.t - b.t);
  const k = Math.min(Math.floor(byTime.length / 2), Math.max(30, Math.floor(byTime.length * S.valShare)));
  const heldSet = new Set(byTime.slice(-k));
  const heldFrom = byTime[byTime.length - k].t;
  const trainRaw = [...shipped, ...replays, ...own].filter((e) => !heldSet.has(e) && e.t < heldFrom);
  const weightOf = (e) => S.weights[e.src] ?? 1;
  const train = trainRaw.map((e) => ({ ...asExample(e, sc), w: weightOf(e) }));
  const held = [...heldSet].map((e) => asExample(e, sc));
  const stats = deskStats(trainRaw);
  const fit = fitNet(net, train, held, {
    epochs: S.epochs, patience: S.patience, minEpochs: S.minEpochs, lr: S.lr, wd: S.wd, batch: S.batch, dropout: S.dropout, seed: seed + 5,
    onEpoch: (ep, l) => progress({ stage: 'learn', pct: (ep + 1) / S.epochs, text: `Learning which trades won: pass ${ep + 1} (${train.length.toLocaleString('en-US')} trades, kept-back loss ${l.toFixed(3)})` }),
  });

  // 4. The fair test on the kept-back trades.
  progress({ stage: 'test', pct: 1, text: 'Testing on trades it never learned from…' });
  const challenger = scoreOn((ex) => judgeWith(net, stats)(ex, ex.src.desk), held, { bar: S.bar });
  let champion = null;
  if (champ) {
    const cs = champ.scaler || sc;
    const cStats = job.champion.desks || stats;
    champion = scoreOn((ex) => judgeWith(champ, cStats)({ ...ex, x: Array.isArray(ex.src.x) ? scale(ex.src.x, cs) : null }, ex.src.desk), held, { bar: S.bar });
  }
  let mlp = null;
  if (job.mlp) {
    try {
      const m = loadMlp(job.mlp);
      mlp = scoreOn((ex) => m.judge(ex.src.x, ex.src.desk), held, { bar: S.bar });
    } catch { mlp = null; }
  }
  const adopted = !champion || (challenger.logLoss < champion.logLoss - 0.001 && (challenger.pickedR ?? -Infinity) >= (champion.pickedR ?? -Infinity) - 0.02);
  const validation = { n: held.length, from: heldFrom, challenger, champion, mlp, bestPass: fit.bestEpoch + 1 };
  if (!adopted) return { ok: true, adopted: false, data, validation };

  // The kept network learns from the kept-back trades too before it goes live.
  const allTrain = [...trainRaw, ...heldSet].map((e) => ({ ...asExample(e, sc), w: weightOf(e) }));
  if (fit.bestEpoch >= 0) {
    progress({ stage: 'learn', pct: 1, text: 'Adding the newest trades to what it learned…' });
    fitNet(net, allTrain, held, { epochs: Math.max(1, Math.min(3, fit.bestEpoch + 1)), patience: 99, lr: S.lr * 0.5, wd: S.wd, batch: S.batch, dropout: S.dropout, seed: seed + 7 });
  }
  const finalStats = deskStats([...trainRaw, ...heldSet]);

  // 5. Memory: every trade's vector, and the galaxy.
  progress({ stage: 'memory', pct: 1, text: 'Building its memory of past trades…' });
  const rngM = mulberry32(seed + 13);
  const withC = [...replays, ...own];
  const memSrc = [...withC, ...shuffle(shipped.slice(), rngM).slice(0, Math.max(0, S.memory.min - withC.length))];
  const memory = buildMemory(net, memSrc, sc, { galaxy: S.galaxy, rng: rngM });
  const model = { ...net.toJSON(), desks: finalStats, trainedAt: now, pretrainedAt, pretrain, data, validation };
  return { ok: true, adopted: true, data, validation, model, memory };
}

// Vectors for a set of trades, the galaxy's axes, and a sample of the galaxy to draw.
export function buildMemory(net, trades, sc, { galaxy = DEEP.galaxy, rng = Math.random } = {}) {
  const d = net.c.d;
  const vecs = new Float32Array(trades.length * d);
  const meta = [];
  trades.forEach((e, i) => {
    const ex = asExample(e, sc);
    const c = net.forward(ex, 'trade');
    vecs.set(unit(c.h), i * d);
    meta.push([e.desk, e.symbol, e.t, round(e.r, 3), e.src === 'own' ? 'own' : e.src === 'replay' ? 'replay' : 'history', e.side ?? null]);
  });
  const pca = trades.length >= 10 ? pca3(vecs, d) : { mean: new Array(d).fill(0), basis: [0, 1, 2].map((k) => Array.from({ length: d }, (_, j) => (j === k ? 1 : 0))), scale: 6 };
  const idx = trades.map((_, i) => i);
  const ownIdx = idx.filter((i) => meta[i][4] === 'own');
  const rest = shuffle(idx.filter((i) => meta[i][4] !== 'own'), rng).slice(0, Math.max(0, galaxy - ownIdx.length));
  const points = [...rest, ...ownIdx].map((i) => {
    const p = project(pca, vecs.subarray(i * d, (i + 1) * d));
    return [round(p[0], 2), round(p[1], 2), round(p[2], 2), meta[i][3] > 0 ? 1 : 0, meta[i][4] === 'own' ? 2 : meta[i][4] === 'replay' ? 1 : 0];
  });
  return { d, n: trades.length, vecs: packVecs(vecs), meta, pca, galaxy: points };
}

