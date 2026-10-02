import { toColumns, minuteContext, TfContext, classifyRegime } from './context.js';
import { FAMILIES, EXIT_SPACE, TIMEFRAMES, genomeKey, strategyName, describe } from './families.js';
import { backtest, costModel, monteCarlo, metrics } from './backtest.js';
import { mulberry32 } from '../util/random.js';

// The research pipeline a quant desk runs before a strategy may trade:
//
//   1. Read the market: what condition is it in (trending, ranging, squeeze, volatile)?
//   2. Generate strategy ideas that suit that condition (and some that don't, to compare).
//   3. In-sample search: backtest them on the first 60% of the history, refine the best.
//   4. Out-of-sample test on the next 25%, data the search never saw.
//   5. Robustness: neighbouring parameters must also work, it must survive double costs,
//      and a Monte Carlo reshuffle must stay profitable with a tolerable drawdown.
//   6. Final holdout on the last 15%, looked at once, for the finalist only.
//
// Only a strategy that passes every gate is deployed; if nothing passes, the desk doesn't
// trade. Numbers are in R after costs.

export const CRITERIA = {
  minBars: 2500,
  split: [0.6, 0.85],
  isMinTrades: { 1: 30, 3: 24, 5: 18, 15: 12 },
  isMinExp: 0.1,
  isMinPf: 1.2,
  finalists: 4,
  oosMinTrades: { 1: 15, 3: 12, 5: 10, 15: 8 },
  oosMinExp: 0.08,
  oosMinPf: 1.2,
  oosMinT: 1.0,
  oosMaxDD: 6,
  keepRatio: 0.3,
  neighbourPass: 0.6,
  costStressMinExp: 0.02,
  mcMinPositive: 0.9,
  mcMaxDD: 10,
  holdoutMinTrades: 3,
  unseenMinTrades: 20,
  unseenMinT: 2.0,
};

const CONDITION = { 'trend-up': 'trend', 'trend-down': 'trend', range: 'range', squeeze: 'squeeze', volatile: 'volatile', unknown: 'range' };

const GATE_WEIGHTS = {
  trend: { trend: 4.5, any: 3.5, squeeze: 1, notrend: 0.5, range: 0.5 },
  range: { range: 4, notrend: 2.5, any: 3, squeeze: 0.5, trend: 0.5 },
  squeeze: { squeeze: 4, any: 3, notrend: 1.5, trend: 1, range: 0.5 },
  volatile: { any: 5, trend: 2, range: 1, notrend: 1, squeeze: 0.5 },
};

function weighted(rng, weights) {
  const entries = Object.entries(weights).filter(([, w]) => w > 0);
  let total = 0;
  for (const [, w] of entries) total += w;
  let x = rng() * total;
  for (const [k, w] of entries) {
    x -= w;
    if (x <= 0) return k;
  }
  return entries[entries.length - 1][0];
}

const pick = (rng, list) => list[Math.floor(rng() * list.length)];

function slim(s) {
  if (!s) return null;
  const r = (x, d = 3) => Math.round(x * 10 ** d) / 10 ** d;
  return { n: s.n, winRate: r(s.winRate), avgR: r(s.avgR), sumR: r(s.sumR, 2), pf: r(Math.min(s.pf, 99), 2), maxDD: r(s.maxDD, 2), t: r(s.t, 2) };
}

export class GenomeSampler {
  constructor(rng, condition, { mode, trendDir = 0, tfs = TIMEFRAMES }) {
    this.rng = rng;
    this.condition = condition;
    this.mode = mode;
    this.trendDir = trendDir;
    this.tfs = tfs;
  }

  sample() {
    const rng = this.rng;
    const famW = {};
    for (const [id, f] of Object.entries(FAMILIES)) famW[id] = Math.max(0.35, f.fits[this.condition] ?? 1);
    const family = weighted(rng, famW);
    const fam = FAMILIES[family];
    const p = {};
    for (const [k, vals] of Object.entries(fam.space)) p[k] = pick(rng, vals);
    const tfW = { 1: 0.8, 3: 1, 5: 1.2, 15: 0.9 };
    const tf = Number(weighted(rng, Object.fromEntries(this.tfs.map((t) => [t, tfW[t] ?? 1]))));
    const gate = weighted(rng, GATE_WEIGHTS[this.condition] || GATE_WEIGHTS.range);
    const sideW = { both: 6, long: 2, short: 2 };
    if (this.condition === 'trend' && this.trendDir) {
      sideW[this.trendDir > 0 ? 'long' : 'short'] = 3.5;
      sideW[this.trendDir > 0 ? 'short' : 'long'] = 0.8;
    }
    const side = weighted(rng, sideW);
    const hours = this.mode === 'sim' ? 'all' : weighted(rng, { all: 5, us: 3, euus: 2 });
    const target = pick(rng, fam.targets);
    const g = {
      family, tf, side, gate, hours, p,
      stopAtr: pick(rng, EXIT_SPACE.stopAtr),
      target,
      rr: target === 'rr' ? pick(rng, EXIT_SPACE.rr) : null,
      partialAt: pick(rng, EXIT_SPACE.partialAt),
      trail: target === 'none' ? pick(rng, EXIT_SPACE.trail.filter(Boolean)) : pick(rng, EXIT_SPACE.trail),
      timeStop: pick(rng, EXIT_SPACE.timeStop),
    };
    return g;
  }

  // One or two small changes to a good strategy.
  mutate(g) {
    const rng = this.rng;
    const out = { ...g, p: { ...g.p } };
    const fam = FAMILIES[g.family];
    const steps = 1 + (rng() < 0.4 ? 1 : 0);
    for (let s = 0; s < steps; s++) {
      const r = rng();
      if (r < 0.45) {
        const k = pick(rng, Object.keys(fam.space));
        out.p[k] = step(fam.space[k], out.p[k], rng);
      } else if (r < 0.6) out.stopAtr = step(EXIT_SPACE.stopAtr, out.stopAtr, rng);
      else if (r < 0.7 && out.target === 'rr') out.rr = step(EXIT_SPACE.rr, out.rr, rng);
      else if (r < 0.8) out.trail = out.target === 'none' ? step(EXIT_SPACE.trail.filter(Boolean), out.trail, rng) : step(EXIT_SPACE.trail, out.trail, rng);
      else if (r < 0.87) out.partialAt = out.partialAt ? null : 1;
      else if (r < 0.94) out.timeStop = step(EXIT_SPACE.timeStop, out.timeStop, rng);
      else out.gate = pick(rng, Object.keys(GATE_WEIGHTS.range));
    }
    return out;
  }
}

function step(list, value, rng) {
  const i = Math.max(0, list.indexOf(value));
  const j = Math.min(list.length - 1, Math.max(0, i + (rng() < 0.5 ? -1 : 1)));
  return list[j === i ? (i === 0 ? Math.min(1, list.length - 1) : i - 1) : j];
}

// Every strategy one parameter step away (for the robustness check).
export function neighbours(g) {
  const fam = FAMILIES[g.family];
  const out = [];
  const around = (list, v, set) => {
    const i = list.indexOf(v);
    if (i < 0) return;
    if (i > 0) out.push(set(list[i - 1]));
    if (i < list.length - 1) out.push(set(list[i + 1]));
  };
  for (const [k, vals] of Object.entries(fam.space)) around(vals, g.p[k], (v) => ({ ...g, p: { ...g.p, [k]: v } }));
  around(EXIT_SPACE.stopAtr, g.stopAtr, (v) => ({ ...g, stopAtr: v }));
  if (g.target === 'rr') around(EXIT_SPACE.rr, g.rr, (v) => ({ ...g, rr: v }));
  if (g.trail) around(EXIT_SPACE.trail.filter(Boolean), g.trail, (v) => ({ ...g, trail: v }));
  return out;
}

export function research({ bars, symbol, mode = 'live', windows = [], spreadBps = 1, feeBps, budget = 360, seed = 1, onProgress = () => {} }) {
  const started = Date.now();
  const C = CRITERIA;
  const regime = classifyRegime(bars);
  const base = { symbol, regime, bars: bars.length, from: bars[0]?.time ?? null, to: bars[bars.length - 1]?.time ?? null, criteria: C };
  if (bars.length < C.minBars) {
    return { ...base, ok: false, outcome: 'data', summary: `Not enough history yet: ${bars.length.toLocaleString('en-US')} of ${C.minBars.toLocaleString('en-US')} one-minute bars.`, funnel: null, durationMs: Date.now() - started };
  }
  const rng = mulberry32(seed);
  const cols = toColumns(bars);
  const m = minuteContext(cols, { mode, windows });
  const N = cols.n;
  // Timeframes need enough bars to say anything.
  const tfs = TIMEFRAMES.filter((tf) => N / tf >= 400);
  const ctx = new Map(tfs.map((tf) => [tf, new TfContext(cols, tf, m.nyMin)]));
  const cost = costModel(spreadBps, feeBps);
  const warm = Math.min(600, Math.floor(N * 0.05));
  const isTo = Math.floor(N * C.split[0]);
  const oosTo = Math.floor(N * C.split[1]);
  const run = (g, from, to, opts = {}) => backtest(m, ctx.get(g.tf), g, { from, to, cost, ...opts });

  const condition = CONDITION[regime.key] || 'range';
  const sampler = new GenomeSampler(rng, condition, { mode, trendDir: regime.dir, tfs });
  const seen = new Map();
  const reasons = {};
  const reject = (why) => { reasons[why] = (reasons[why] || 0) + 1; };
  const total = budget;
  let tested = 0;

  const evaluate = (g) => {
    const key = genomeKey(g);
    if (seen.has(key)) return seen.get(key);
    const s = run(g, warm, isTo);
    const minN = C.isMinTrades[g.tf];
    const eligible = s.n >= minN && s.avgR >= C.isMinExp && s.pf >= C.isMinPf;
    const rec = { g, key, is: s, eligible, score: s.n >= minN ? s.t : -99 };
    seen.set(key, rec);
    tested++;
    if (tested % 20 === 0) onProgress({ stage: 'In-sample search', done: tested, total });
    return rec;
  };

  // 1) explore
  const explore = Math.round(budget * 0.6);
  let guard = 0;
  while (seen.size < explore && guard++ < explore * 4) evaluate(sampler.sample());
  // 2) refine around the best ideas
  const seeds = [...seen.values()].sort((a, b) => b.score - a.score).slice(0, 10);
  guard = 0;
  while (seen.size < budget && guard++ < budget * 4) {
    const s = seeds[Math.floor(rng() * seeds.length)];
    if (!s) break;
    evaluate(sampler.mutate(s.g));
  }
  const all = [...seen.values()];
  for (const r of all) {
    if (r.eligible) continue;
    if (r.is.n < C.isMinTrades[r.g.tf]) reject('too few trades in-sample');
    else reject('no in-sample edge after costs');
  }

  // Finalists: best in-sample ideas, one per family/timeframe/filter.
  const eligible = all.filter((r) => r.eligible).sort((a, b) => b.score - a.score);
  const finalists = [];
  const kinds = new Set();
  for (const r of eligible) {
    const kind = `${r.g.family}|${r.g.tf}|${r.g.gate}|${r.g.side}`;
    if (kinds.has(kind)) continue;
    kinds.add(kind);
    finalists.push(r);
    if (finalists.length >= C.finalists) break;
  }

  const funnel = { tested: all.length, inSample: eligible.length, outOfSample: 0, robust: 0, holdout: 0 };
  const survivors = [];
  let nearMiss = null;
  const miss = (r, stage, why) => {
    reject(why);
    if (!nearMiss || STAGE_RANK[stage] > STAGE_RANK[nearMiss.stage] || (stage === nearMiss.stage && r.score > nearMiss.score)) {
      nearMiss = { stage, why, score: r.score, name: strategyName(r.g), is: slim(r.is), oos: slim(r.oos) };
    }
  };

  finalists.forEach((r, idx) => {
    onProgress({ stage: 'Out-of-sample test', done: idx + 1, total: finalists.length });
    // 3) out of sample
    const oos = run(r.g, isTo, oosTo);
    r.oos = oos;
    const minN = C.oosMinTrades[r.g.tf];
    if (oos.n < minN) return miss(r, 'oos', 'too few trades out-of-sample');
    if (oos.avgR < C.oosMinExp || oos.pf < C.oosMinPf || oos.t < C.oosMinT) return miss(r, 'oos', 'edge disappeared out-of-sample');
    if (oos.avgR < C.keepRatio * r.is.avgR) return miss(r, 'oos', 'out-of-sample far weaker than in-sample (overfit)');
    if (oos.maxDD > C.oosMaxDD) return miss(r, 'oos', 'drawdown too deep out-of-sample');
    funnel.outOfSample++;

    // 4) robustness, on out-of-sample data only (in-sample numbers are flattered by the search)
    onProgress({ stage: 'Robustness checks', done: idx + 1, total: finalists.length });
    const nb = neighbours(r.g);
    let ok = 0;
    for (const n of nb) {
      const s = run(n, isTo, oosTo);
      if (s.avgR > 0 && s.pf > 1) ok++;
    }
    const nbRatio = nb.length ? ok / nb.length : 1;
    const stressed = run(r.g, isTo, oosTo, { costMult: 2 });
    const mc = monteCarlo(oos.rs, rng, 500);
    r.robust = { neighbours: Math.round(nbRatio * 100) / 100, neighboursTested: nb.length, doubleCostsAvgR: Math.round(stressed.avgR * 1000) / 1000, mc: { pPositive: mc.pPositive, ddP95: Math.round(mc.ddP95 * 100) / 100 } };
    if (nbRatio < C.neighbourPass) return miss(r, 'robust', 'fragile: neighbouring settings lose money');
    if (stressed.avgR < C.costStressMinExp) return miss(r, 'robust', 'does not survive double trading costs');
    if (mc.pPositive < C.mcMinPositive) return miss(r, 'robust', 'Monte Carlo: too likely to lose by luck');
    if (mc.ddP95 > C.mcMaxDD) return miss(r, 'robust', 'Monte Carlo: drawdown risk too high');
    funnel.robust++;
    survivors.push(r);
  });

  // 5) final holdout, finalists that passed everything else only
  onProgress({ stage: 'Final holdout', done: 0, total: 1 });
  let best = null;
  for (const r of survivors) {
    const ho = run(r.g, oosTo, N);
    r.holdout = ho;
    if (ho.n < C.holdoutMinTrades) { miss(r, 'holdout', 'too few trades in the final holdout'); continue; }
    if (ho.sumR <= 0) { miss(r, 'holdout', 'lost money on the final holdout'); continue; }
    // All data the search never saw, together: is the edge statistically real?
    r.unseen = metrics([...r.oos.rs, ...ho.rs]);
    if (r.unseen.n < C.unseenMinTrades) { miss(r, 'holdout', 'too few trades on unseen data to trust'); continue; }
    if (r.unseen.t < C.unseenMinT) { miss(r, 'holdout', 'edge not statistically significant on unseen data'); continue; }
    funnel.holdout++;
    const score = r.unseen.t;
    if (!best || score > best.final) best = Object.assign(r, { final: score });
  }

  const result = { ...base, funnel, reasons, tested: all.length, durationMs: 0 };
  if (!best) {
    result.ok = false;
    result.outcome = 'no-edge';
    result.nearMiss = nearMiss;
    result.summary = `Tested ${all.length} strategy ideas; none passed every validation gate.`;
    result.durationMs = Date.now() - started;
    return result;
  }
  const g = best.g;
  const curveRun = run(g, warm, N, { keepTrades: true });
  let cum = 0;
  const curve = curveRun.trades.map((tr) => ({ time: tr.out, r: Math.round((cum += tr.r) * 100) / 100 }));
  const liveRs = [...best.oos.rs, ...best.holdout.rs];
  const expect = liveRs.reduce((s, x) => s + x, 0) / liveRs.length;
  const sd = Math.sqrt(liveRs.reduce((s, x) => s + (x - expect) ** 2, 0) / Math.max(1, liveRs.length - 1));
  result.ok = true;
  result.outcome = 'deploy';
  result.strategy = {
    genome: g, key: best.key, name: strategyName(g), rules: describe(g),
    is: slim(best.is), oos: slim(best.oos), holdout: slim(best.holdout), unseen: slim(best.unseen), all: slim(curveRun),
    robust: best.robust,
    expectation: { avgR: Math.round(expect * 1000) / 1000, sd: Math.round(sd * 1000) / 1000, ddP95: best.robust.mc.ddP95 },
    tradesPerDay: Math.round((curveRun.n / Math.max(1, (m.day[N - 1] - m.day[warm]) + 1)) * 10) / 10,
    curve, splits: { isTo: cols.t[isTo], oosTo: cols.t[oosTo] },
  };
  result.summary = `Tested ${all.length} strategy ideas; ${strategyName(g)} passed every gate.`;
  result.durationMs = Date.now() - started;
  return result;
}

const STAGE_RANK = { oos: 1, robust: 2, holdout: 3 };
