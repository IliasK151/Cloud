import { isMainThread, parentPort, workerData } from 'node:worker_threads';
import { fit, load, score, insights } from './train.js';
import { loadShippedExamples } from './brain.js';

// The brain learning, in a worker thread so the floor keeps trading while it trains.
//
// The current brain learned from every trade up to its last lesson. Of the floor's trades since
// then, the newest share (settings.holdout, at least 20) is kept back; a challenger learns from
// the long history plus all the floor's trades before those. Then both judge the kept-back
// trades, which neither learned from. The challenger wins only if its chances fit what
// happened better (lower log loss) and the trades it would have taken did at least as well.
// If it wins, the brain is retrained on everything (the newest trades too) and that becomes
// the next version, with a fresh "what each desk learned". If not, the next lesson has more
// new trades to go on.

const MIN_HELD = 20;

export function learn({ examplesFile, own, champion, settings, seed = 2 }) {
  let base = [];
  try {
    base = loadShippedExamples(examplesFile);
  } catch {
    base = []; // no long history shipped: it learns from its own trades only
  }
  const sorted = own.filter((e) => Array.isArray(e.x) && Number.isFinite(e.r)).sort((a, b) => a.t - b.t);
  const seenTo = champion?.trainedOn?.to ?? -Infinity;
  const unseen = sorted.filter((e) => e.t > seenTo).length;
  if (unseen < MIN_HELD) return { ok: false, error: `only ${unseen} trades it hasn't learned from yet (it needs ${MIN_HELD} to test a new version fairly)` };
  const k = Math.min(unseen, Math.max(MIN_HELD, Math.floor(unseen * settings.holdout)));
  const held = sorted.slice(-k);
  const mine = (list) => list.map((e) => ({ ...e, own: true }));
  const weight = (e) => (e.own ? settings.ownWeight : 1);
  const challengerModel = fit([...base, ...mine(sorted.slice(0, -k))], { seed, weight });
  const champ = load(champion);
  const chal = load(challengerModel);
  const sChamp = score(champ, held, { bar: settings.bar });
  const sChal = score(chal, held, { bar: settings.bar });
  const better = sChal.logLoss < sChamp.logLoss - 0.001 && (sChal.pickedR ?? -Infinity) >= (sChamp.pickedR ?? -Infinity) - 0.02;
  if (!better) return { ok: true, adopted: false, held: k, champion: sChamp, challenger: sChal };
  const all = [...base, ...mine(sorted)];
  const model = fit(all, { seed, weight });
  model.insights = insights(load(model), all, { bar: settings.bar });
  return { ok: true, adopted: true, held: k, champion: sChamp, challenger: sChal, model };
}

if (!isMainThread && workerData?.examplesFile !== undefined && parentPort) {
  try {
    parentPort.postMessage(learn(workerData));
  } catch (err) {
    parentPort.postMessage({ ok: false, error: err.message });
  }
}
