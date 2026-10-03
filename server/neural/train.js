import { Net, scaler, scale, auc, logLoss, calibration } from './net.js';
import { FEATURES, N_FEATURES } from './features.js';

// Training the neural brain, and testing it honestly.
//
// An example is one trade a desk took: what the brain sensed at entry (x), which desk, when,
// and how it turned out (r, in R after costs). The network learns the chance a trade ends in
// profit; the brain turns that into an expected R with the desk's own average win and loss:
//   expected R = p × average win − (1 − p) × average loss.
//
// walkForward() is the honest test: every month the brain is retrained on everything before
// it and then judges that month's trades, which it has never seen, exactly as the floor does
// when it retrains every night.

export const ARCH = { hidden: [24, 12] };
export const TRAIN = { epochs: 200, lr: 0.003, batch: 128, l2: 1e-3, patience: 15, valShare: 0.15, minExamples: 300 };
export const MODEL_VERSION = 1;
const DAY = 86_400_000;

// Average win and average loss per desk (in R), pulled towards the floor's overall average
// when a desk has few trades.
export function deskStats(examples, prior = 30) {
  const all = { n: 0, w: 0, wn: 0, l: 0, ln: 0 };
  const by = new Map();
  for (const e of examples) {
    const s = by.get(e.desk) || { n: 0, w: 0, wn: 0, l: 0, ln: 0 };
    for (const t of [s, all]) {
      t.n++;
      if (e.r > 0) { t.w += e.r; t.wn++; } else { t.l += -e.r; t.ln++; }
    }
    by.set(e.desk, s);
  }
  const W = all.wn ? all.w / all.wn : 1;
  const Lo = all.ln ? all.l / all.ln : 1;
  const out = { '*': { n: all.n, win: round(W), loss: round(Lo), winRate: round(all.n ? all.wn / all.n : 0.5) } };
  for (const [d, s] of by) {
    out[d] = {
      n: s.n,
      win: round((s.w + prior * W) / (s.wn + prior)),
      loss: round((s.l + prior * Lo) / (s.ln + prior)),
      winRate: round((s.wn + prior * (all.wn / Math.max(1, all.n))) / (s.n + prior)),
    };
  }
  return out;
}

const round = (x, d = 4) => Math.round(x * 10 ** d) / 10 ** d;

// Train a brain on examples (any order). weight(e): how much each trade counts (the floor's own
// trades on your broker count more than the long history). Returns the saved form (plain JSON).
export function fit(examples, { seed = 1, hidden = ARCH.hidden, weight = null, ...opts } = {}) {
  const o = { ...TRAIN, ...opts };
  const ex = examples.filter((e) => Array.isArray(e.x) && e.x.length === N_FEATURES && Number.isFinite(e.r)).sort((a, b) => a.t - b.t);
  if (ex.length < o.minExamples) throw new Error(`only ${ex.length} trades to learn from (needs ${o.minExamples})`);
  const cut = Math.floor(ex.length * (1 - o.valShare));
  const trainEx = ex.slice(0, cut);
  const valEx = ex.slice(cut);
  const sc = scaler(trainEx.map((e) => e.x));
  const X = trainEx.map((e) => scale(e.x, sc));
  const y = trainEx.map((e) => (e.r > 0 ? 1 : 0));
  const w = weight ? trainEx.map(weight) : null;
  const net = new Net([N_FEATURES, ...hidden, 1], { seed });
  const res = net.train(X, y, { w, valX: valEx.map((e) => scale(e.x, sc)), valY: valEx.map((e) => (e.r > 0 ? 1 : 0)), epochs: o.epochs, lr: o.lr, batch: o.batch, l2: o.l2, patience: o.patience, seed });
  return {
    v: MODEL_VERSION,
    at: Date.now(),
    features: FEATURES.map((f) => f.key),
    scaler: sc,
    net: net.toJSON(),
    desks: deskStats(trainEx),
    trainedOn: { n: ex.length, from: ex[0].t, to: ex[ex.length - 1].t, epochs: res.epochs, bestEpoch: res.best.epoch, valLoss: round(res.best.valLoss) },
  };
}

// A trained brain, ready to judge: { p, expR } for senses x from a desk.
export function load(model) {
  if (!model || model.v !== MODEL_VERSION || !Array.isArray(model.features)) throw new Error('not a saved brain');
  if (model.features.length !== N_FEATURES || model.features.some((k, i) => k !== FEATURES[i].key)) throw new Error('the brain was trained on different senses');
  const net = Net.from(model.net);
  if (net.sizes[0] !== N_FEATURES) throw new Error('input size mismatch');
  const sc = model.scaler;
  if (!Array.isArray(sc?.mean) || !Array.isArray(sc?.sd) || sc.mean.length !== N_FEATURES || sc.sd.length !== N_FEATURES) throw new Error('scaler damaged');
  const stats = (desk) => model.desks?.[desk] || model.desks?.['*'] || { win: 1, loss: 1 };
  return {
    model,
    net,
    judge(x, desk) {
      const xs = scale(x, sc);
      const p = net.predict(xs);
      const s = stats(desk);
      return { p, expR: p * s.win - (1 - p) * s.loss, xs };
    },
    flows(x) {
      return net.flows(scale(x, sc));
    },
  };
}

// Every month: retrain on all trades before it (a day's gap so nothing leaks), then judge that
// month. Returns one prediction per example from firstTestMonth on.
export function walkForward(examples, { firstTest = null, seed = 1, log = () => {}, ...opts } = {}) {
  const ex = examples.filter((e) => Array.isArray(e.x) && Number.isFinite(e.r)).sort((a, b) => a.t - b.t);
  if (!ex.length) return { preds: [], months: [] };
  const monthOf = (t) => { const d = new Date(t); return Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), 1); };
  const start = firstTest ?? monthOf(ex[0].t + 270 * DAY); // about nine months to learn from first
  const months = [...new Set(ex.map((e) => monthOf(e.t)))].filter((m) => m >= start).sort((a, b) => a - b);
  const preds = [];
  const out = [];
  for (const m of months) {
    const next = new Date(m);
    const end = Date.UTC(next.getUTCFullYear(), next.getUTCMonth() + 1, 1);
    const train = ex.filter((e) => e.t < m - DAY);
    const test = ex.filter((e) => e.t >= m && e.t < end);
    if (!test.length || train.length < (opts.minExamples ?? TRAIN.minExamples)) continue;
    const brain = load(fit(train, { seed, ...opts }));
    for (const e of test) {
      const j = brain.judge(e.x, e.desk);
      preds.push({ e, p: j.p, expR: j.expR });
    }
    out.push({ month: new Date(m).toISOString().slice(0, 7), trained: train.length, tested: test.length });
    log(`  ${new Date(m).toISOString().slice(0, 7)}: learned from ${train.length.toLocaleString('en-US')} trades, judged ${test.length}`);
  }
  return { preds, months: out };
}

// What the brain's picks were worth on trades it had never seen: every trade, against the
// trades it would have taken (expected R at or above the bar), overall and desk by desk.
export function evaluate(preds, { bar = 0 } = {}) {
  const mean = (a) => (a.length ? a.reduce((s, x) => s + x, 0) / a.length : null);
  const summary = (list) => {
    const picked = list.filter((q) => q.expR >= bar);
    const y = list.map((q) => (q.e.r > 0 ? 1 : 0));
    const p = list.map((q) => q.p);
    return {
      n: list.length,
      allR: round(mean(list.map((q) => q.e.r)) ?? 0, 3),
      picked: picked.length,
      pickedR: picked.length ? round(mean(picked.map((q) => q.e.r)), 3) : null,
      skippedR: list.length > picked.length ? round(mean(list.filter((q) => q.expR < bar).map((q) => q.e.r)), 3) : null,
      auc: list.length > 20 ? round(auc(y, p), 3) : null,
      logLoss: list.length ? round(logLoss(y, p), 3) : null,
    };
  };
  const desks = {};
  for (const d of [...new Set(preds.map((q) => q.e.desk))]) desks[d] = summary(preds.filter((q) => q.e.desk === d));
  // Halves of the tested period: does the improvement hold in both?
  const sorted = preds.slice().sort((a, b) => a.e.t - b.e.t);
  const half = Math.floor(sorted.length / 2);
  return {
    bar,
    all: summary(preds),
    halves: [summary(sorted.slice(0, half)), summary(sorted.slice(half))],
    desks,
    calibration: calibration(preds.map((q) => (q.e.r > 0 ? 1 : 0)), preds.map((q) => q.p), 5).map((c) => ({ ...c, said: round(c.said, 3), won: round(c.won, 3) })),
  };
}

// A brain judged on trades it didn't learn from: how well its chances fit what happened (log
// loss: lower is better), and what the trades it would have taken made.
export function score(brain, examples, { bar = 0 } = {}) {
  if (!examples.length) return null;
  const js = examples.map((e) => ({ e, ...brain.judge(e.x, e.desk) }));
  const y = js.map((q) => (q.e.r > 0 ? 1 : 0));
  const picked = js.filter((q) => q.expR >= bar);
  const a = auc(y, js.map((q) => q.p));
  return {
    n: examples.length,
    logLoss: round(logLoss(y, js.map((q) => q.p)), 4),
    auc: Number.isFinite(a) ? round(a, 3) : null,
    picked: picked.length,
    pickedR: picked.length ? round(picked.reduce((s, q) => s + q.e.r, 0) / picked.length, 3) : null,
    allR: round(examples.reduce((s, e) => s + e.r, 0) / examples.length, 3),
  };
}

// What each desk's brain has learned, in words: the senses that raise or lower its chance of
// a winning trade the most (each set high vs low across the desk's own trades), the hours it
// does best and worst, and how many of the desk's ideas it takes. Only the senses a person can
// picture; the market and style inputs just say which desk is asking.
const EXPLAIN = ['htf', 'trend', 'structure', 'momentum', 'ret15', 'ret60', 'ret240', 'stretch', 'vwapZ', 'location', 'room', 'dayPos', 'prevHigh', 'prevLow', 'volPct', 'atrRatio', 'regimeWith', 'regimeRange', 'regimeSqueeze', 'side', 'stopAtr', 'rr', 'costR', 'form', 'streak', 'tradesToday'];
const PHRASE = {
  htf: ['the hourly trend is with the trade', 'the hourly trend is against it'],
  trend: ['the 15-minute trend is with the trade', 'the 15-minute trend is against it'],
  structure: ['swing structure agrees', 'swing structure disagrees'],
  momentum: ['momentum is with the trade', 'momentum is against it'],
  ret15: ['the last 15 minutes already moved its way', 'the last 15 minutes moved against it'],
  ret60: ['the last hour already moved its way', 'the last hour moved against it'],
  ret240: ['the last 4 hours moved its way', 'the last 4 hours moved against it'],
  stretch: ['price is at a fair level', 'it would be chasing'],
  vwapZ: ['price is stretched in the trade\'s direction', 'price is stretched against the trade'],
  location: ['there\'s a level right behind the entry', 'there\'s no level behind the entry'],
  room: ['there\'s room to run', 'a level is in the way'],
  dayPos: ['price is near the day\'s extreme in the trade\'s direction', 'price is near the opposite end of the day\'s range'],
  prevHigh: ['it has broken through the prior day\'s high', 'it\'s below the prior day\'s high'],
  prevLow: ['it\'s above the prior day\'s low', 'it has broken through the prior day\'s low'],
  volPct: ['volatility is high for the time of day', 'the market is quiet for the time of day'],
  atrRatio: ['the last minutes are livelier than usual', 'the last minutes are calmer than usual'],
  regimeWith: ['the market is trending its way', 'the market is trending against it'],
  regimeRange: ['the market is ranging', 'the market isn\'t ranging'],
  regimeSqueeze: ['volatility is squeezed', 'there\'s no squeeze'],
  side: ['it\'s a long', 'it\'s a short'],
  stopAtr: ['the stop is wide', 'the stop is tight'],
  rr: ['the target is far', 'the target is close'],
  costR: ['costs are high', 'costs are low'],
  form: ['the desk is in form', 'the desk is out of form'],
  streak: ['after several losses', 'with no recent losses'],
  tradesToday: ['it has traded a lot today', 'it\'s an early trade of the day'],
};

export function insights(brain, examples, { bar = 0, perDesk = 400 } = {}) {
  const idx = new Map(FEATURES.map((f, i) => [f.key, i]));
  const byDesk = new Map();
  for (const e of examples) {
    if (!byDesk.has(e.desk)) byDesk.set(e.desk, []);
    byDesk.get(e.desk).push(e);
  }
  const out = {};
  for (const [desk, list] of byDesk) {
    if (list.length < 50) continue;
    const sample = list.slice(-perDesk);
    const meanP = (xs) => xs.reduce((s, x) => s + brain.judge(x, desk).p, 0) / xs.length;
    const effects = [];
    for (const k of EXPLAIN) {
      const i = idx.get(k);
      const hi = sample.map((e) => { const x = e.x.slice(); x[i] = 1; return x; });
      const lo = sample.map((e) => { const x = e.x.slice(); x[i] = -1; return x; });
      effects.push({ key: k, effect: round(meanP(hi) - meanP(lo), 3) });
    }
    // Each sense's effect, said the way it helps: "+6 points when the hourly trend is with the
    // trade" (positive effect) or "+6 points when it is against it" (negative effect).
    const ranked = effects.filter((f) => Math.abs(f.effect) >= 0.02).sort((a, b) => Math.abs(b.effect) - Math.abs(a.effect));
    const said = (f, helps) => ({ key: f.key, text: PHRASE[f.key][(f.effect > 0) === helps ? 0 : 1], points: round(Math.abs(f.effect) * 100, 1) });
    // Hours (New York) it trades in, best and worst by the brain's chance.
    const hs = idx.get('hourSin');
    const hc = idx.get('hourCos');
    const hours = new Map();
    for (const e of sample) {
      const m = Math.round(((Math.atan2(e.x[hs], e.x[hc]) / (2 * Math.PI)) * 1440 + 1440) % 1440);
      const h = Math.floor(m / 60);
      if (!hours.has(h)) hours.set(h, []);
      hours.get(h).push(e.x);
    }
    const hourly = [...hours.entries()].filter(([, xs]) => xs.length >= 8).map(([h, xs]) => ({ hour: h, p: round(meanP(xs), 3), n: xs.length })).sort((a, b) => b.p - a.p);
    const judged = sample.map((e) => brain.judge(e.x, desk));
    out[desk] = {
      n: list.length,
      takes: round(judged.filter((j) => j.expR >= bar).length / judged.length, 3),
      meanP: round(judged.reduce((s, j) => s + j.p, 0) / judged.length, 3),
      // The six strongest senses: the first three said as what raises its chance, the next
      // three as what lowers it.
      helps: ranked.slice(0, 3).map((f) => said(f, true)),
      hurts: ranked.slice(3, 6).map((f) => said(f, false)),
      bestHours: hourly.slice(0, 2).map((h) => h.hour),
      worstHours: hourly.slice(-2).reverse().map((h) => h.hour),
    };
  }
  return out;
}
