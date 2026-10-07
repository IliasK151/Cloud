#!/usr/bin/env node
// Train the floor's neural brain on long real history, and test it honestly.
//
// 1. Replays every trading desk, minute by minute, through the floor's own code on a folder of
//    real 1-minute bars, and records what the brain senses at every entry (neural/features.js)
//    and how the trade turned out.
// 2. Walk-forward test: every month the brain is retrained on everything before it and judges
//    that month's trades, which it has never seen. Its picks are compared with taking every
//    trade, desk by desk.
// 3. Trains the brain on all of it and saves it, its examples and the test results where the
//    floor reads them (server/research/brain.json and brain-examples.json.gz).
//
//   npm run brain -- --dir path/to/history [--jobs 4] [--seed 1] [--source "…"]
//   npm run brain -- --examples file.json.gz      skip the replays, retrain on saved examples
//
// It only reads market data: nothing is sent to MT5 and your paper book isn't touched.

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import zlib from 'node:zlib';
import { Worker, isMainThread, parentPort, workerData } from 'node:worker_threads';
import { fileURLToPath } from 'node:url';
import { ROSTER } from '../server/engine/roster.js';
import { mulberry32 } from '../server/util/random.js';
import { senseTrade, toArray } from '../server/neural/features.js';
import { fit, load, walkForward, evaluate, insights } from '../server/neural/train.js';
import { replay, loadBars } from './replay.js';

const HERE = path.dirname(fileURLToPath(import.meta.url));
export const BRAIN_FILE = path.join(HERE, '..', 'server', 'research', 'brain.json');
export const EXAMPLES_FILE = path.join(HERE, '..', 'server', 'research', 'brain-examples.json.gz');
const SKIP = new Set(['kenji', 'isabella']);

// ---- one desk's trades with what the brain sensed, in a worker ------------------------------------
export function recordDesk({ id, file, seed = 1, bars = null }) {
  const profile = ROSTER.find((r) => r.id === id);
  const data = bars || loadBars(file);
  const examples = [];
  const random = Math.random;
  Math.random = mulberry32(seed);
  try {
    replay({
      profile, bars: data,
      neural: (agent, env) => ({
        judge(a, idea) {
          const x = senseTrade({ brain: env.marketBrain, agent: a, ...idea, now: env.clock.now() });
          return x ? { take: true, x: toArray(x) } : { take: true };
        },
        observe(a, trade) {
          if (Array.isArray(trade.neural?.x) && Number.isFinite(trade.r)) {
            examples.push({ desk: a.id, symbol: trade.symbol, t: trade.openTime, x: trade.neural.x, r: Math.round(trade.r * 1e4) / 1e4 });
          }
        },
      }),
    });
  } finally {
    Math.random = random;
  }
  return { id, bars: data.length, from: data[0]?.time ?? null, to: data.at(-1)?.time ?? null, examples };
}

if (!isMainThread && workerData?.brainJob) {
  try {
    parentPort.postMessage({ ok: true, result: recordDesk(workerData.brainJob) });
  } catch (err) {
    parentPort.postMessage({ ok: false, error: err.message });
  }
}

function runInWorker(job) {
  return new Promise((resolve) => {
    const w = new Worker(fileURLToPath(import.meta.url), { workerData: { brainJob: job }, resourceLimits: { maxOldGenerationSizeMb: 3072 } });
    let done = false;
    w.on('message', (m) => { done = true; resolve(m.ok ? m.result : { id: job.id, error: m.error }); });
    w.on('error', (err) => { if (!done) { done = true; resolve({ id: job.id, error: err.message }); } });
    w.on('exit', (code) => { if (!done) resolve({ id: job.id, error: `stopped (exit code ${code})` }); });
  });
}

export async function collect({ dir, jobs = Math.max(1, Math.min(4, os.cpus().length)), seed = 1, log = () => {} }) {
  const desks = ROSTER.filter((p) => !p.lab && !SKIP.has(p.id));
  const queue = desks.map((p) => ({ id: p.id, symbol: p.symbols[0], file: path.join(dir, `${p.symbols[0]}.json`), seed })).filter((j) => fs.existsSync(j.file));
  const running = new Set();
  const examples = [];
  const failed = [];
  while (queue.length || running.size) {
    while (queue.length && running.size < jobs) {
      const job = queue.shift();
      log(`  replaying ${job.id} on ${job.symbol}…`);
      const pr = runInWorker(job).then((r) => {
        running.delete(pr);
        if (r.error) { failed.push(`${job.id}: ${r.error}`); log(`  ${job.id}: failed (${r.error})`); return; }
        examples.push(...r.examples);
        log(`  ${job.id}: ${r.examples.length} trades`);
      });
      running.add(pr);
    }
    await Promise.race(running);
  }
  return { examples: examples.sort((a, b) => a.t - b.t), failed };
}

export function saveExamples(examples, file = EXAMPLES_FILE) {
  fs.writeFileSync(`${file}.tmp`, zlib.gzipSync(JSON.stringify({ v: 1, examples })));
  fs.renameSync(`${file}.tmp`, file);
}

export function loadExamples(file = EXAMPLES_FILE) {
  const raw = JSON.parse(zlib.gunzipSync(fs.readFileSync(file)).toString('utf8'));
  if (raw?.v !== 1 || !Array.isArray(raw.examples)) throw new Error('not a saved set of brain examples');
  return raw.examples;
}

const fr = (x) => (x == null ? '—' : `${x >= 0 ? '+' : ''}${x.toFixed(3)}R`);

export function printEval(ev, title) {
  console.log(`\n  ${title}`);
  const row = (name, s) => console.log(`  ${name.padEnd(10)} ${String(s.n).padStart(6)} trades ${fr(s.allR).padStart(8)} each · brain picks ${String(s.picked).padStart(5)} (${s.n ? Math.round((100 * s.picked) / s.n) : 0}%) ${fr(s.pickedR).padStart(8)} each · passed on ${fr(s.skippedR).padStart(8)} · AUC ${s.auc ?? '—'}`);
  row('ALL', ev.all);
  row('1st half', ev.halves[0]);
  row('2nd half', ev.halves[1]);
  for (const [d, s] of Object.entries(ev.desks)) row(d, s);
  console.log('  Calibration (when it said … it won …): ' + ev.calibration.map((c) => `${Math.round(c.said * 100)}%→${Math.round(c.won * 100)}% (${c.n})`).join(' · '));
}

async function main() {
  const args = process.argv.slice(2);
  const opt = (k, d = null) => { const i = args.indexOf(`--${k}`); return i >= 0 ? args[i + 1] : d; };
  const t0 = Date.now();
  let examples;
  if (opt('examples')) {
    examples = loadExamples(opt('examples'));
    console.log(`  ${examples.length.toLocaleString('en-US')} saved trades`);
  } else {
    const dir = opt('dir');
    if (!dir) {
      console.error('  Which history? npm run brain -- --dir path/to/history (a folder of <SYMBOL>.json 1-minute bars)');
      process.exitCode = 1;
      return;
    }
    const res = await collect({ dir, jobs: Number(opt('jobs')) || undefined, seed: Number(opt('seed')) || 1, log: (s) => console.log(s) });
    examples = res.examples;
    if (res.failed.length) console.log(`  Failed: ${res.failed.join('; ')}`);
    saveExamples(examples, opt('save-examples') || EXAMPLES_FILE);
  }
  console.log('\n  Walk-forward: every month, retrained on the months before it, then judging that month…');
  const wf = walkForward(examples, { log: (s) => console.log(s) });
  const ev = evaluate(wf.preds, { bar: 0 });
  printEval(ev, 'On trades it had never seen (brain picks = expected R of 0 or better)');
  const model = fit(examples, { seed: Number(opt('seed')) || 1 });
  model.insights = insights(load(model), examples, { bar: 0 });
  const out = { ...model, source: opt('source', 'real 1-minute bars'), validation: { ...ev, months: wf.months } };
  const file = opt('out') || BRAIN_FILE;
  fs.writeFileSync(`${file}.tmp`, `${JSON.stringify(out)}\n`);
  fs.renameSync(`${file}.tmp`, file);
  console.log(`\n  Saved the brain to ${path.relative(process.cwd(), file)} (${examples.length.toLocaleString('en-US')} trades, ${Math.round((Date.now() - t0) / 1000)}s).\n`);
}

if (isMainThread && process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch((err) => {
    console.error(`  Training the brain failed: ${err.stack || err.message}`);
    process.exitCode = 1;
  });
}
