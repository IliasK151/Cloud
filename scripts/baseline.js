#!/usr/bin/env node
// Every trading desk on long real history: the long-run record the floor ships with.
//
// Replays each desk, minute by minute, through the floor's own code (strategy, committee,
// learning, costs) on a folder of real 1-minute bars covering many months, and judges it on
// thousands of trades rather than the few weeks the floor has saved from your MT5. The result
// goes to server/research/baseline.json, which the account brain reads: a desk that lost
// money with statistical confidence over the long run trades paper only, unless the nightly
// review finds a real edge on your own recent prices (live/accountBrain.js).
//
//   npm run baseline -- --dir path/to/history                 <SYMBOL>.json files, the floor's
//                                                             history format or [[t,o,h,l,c,v],…]
//   npm run baseline -- --dir … --source "Oanda 1-minute bars" where the bars came from
//   npm run baseline -- --dir … --jobs 4 --seed 1 --out file  parallel replays, slippage seed,
//                                                             where to write (default: the
//                                                             file the floor reads)
//   npm run baseline -- --dir … --no-topdown --out file       the desks without the top-down
//                                                             rule, to compare
//
// It only reads market data: nothing is sent to MT5 and your paper book isn't touched.

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Worker, isMainThread, parentPort, workerData } from 'node:worker_threads';
import { fileURLToPath } from 'node:url';
import { ROSTER } from '../server/engine/roster.js';
import { mulberry32 } from '../server/util/random.js';
import { bootstrapCI } from './edge-report.js';
import { replay, loadBars } from './replay.js';

const HERE = path.dirname(fileURLToPath(import.meta.url));
export const BASELINE_FILE = path.join(HERE, '..', 'server', 'research', 'baseline.json');
// Desks that can't trade one prop account (pairs, market making) and the research desks (they
// test their own strategies as they go) aren't replayed.
const SKIP = new Set(['kenji', 'isabella']);
export const LONG_MIN_TRADES = 100;

const mean = (a) => (a.length ? a.reduce((s, x) => s + x, 0) / a.length : null);
const round = (x, d = 3) => (x == null ? null : Math.round(x * 10 ** d) / 10 ** d);

// The long-run verdict. "loses" needs confidence: the whole 90% range below zero.
export function judgeLong(trades) {
  const rs = trades.map((t) => t.r);
  const n = rs.length;
  const avg = mean(rs);
  const ci = n >= 2 ? bootstrapCI(rs, { draws: 2000, seed: 11 }) : null;
  const half = Math.floor(n / 2);
  const halves = [mean(rs.slice(0, half)), mean(rs.slice(half))];
  // Calendar quarters it made money in (consistency, not one lucky stretch).
  const byQ = new Map();
  for (const t of trades) {
    const d = new Date(t.time);
    const q = `${d.getUTCFullYear()}-Q${Math.floor(d.getUTCMonth() / 3) + 1}`;
    byQ.set(q, (byQ.get(q) || 0) + t.r);
  }
  let verdict;
  if (n < LONG_MIN_TRADES) verdict = 'too few trades';
  else if (ci && ci[1] < 0) verdict = 'loses';
  else if (ci && ci[0] > 0 && halves[0] > 0 && halves[1] > 0) verdict = 'edge';
  else if (avg <= 0) verdict = 'no edge';
  else verdict = 'unclear';
  return {
    n, avgR: round(avg), totalR: round(rs.reduce((s, r) => s + r, 0), 1), winRate: round(n ? rs.filter((r) => r > 0).length / n : null),
    ci: ci ? ci.map((x) => round(x)) : null, halves: halves.map((x) => round(x)),
    quarters: { positive: [...byQ.values()].filter((x) => x > 0).length, total: byQ.size },
    grossR: round(mean(trades.map((t) => t.grossR).filter(Number.isFinite))), costR: round(mean(trades.map((t) => t.costR).filter(Number.isFinite))),
    verdict,
  };
}

// ---- one desk, in a worker ---------------------------------------------------------------------
function replayDesk({ id, file, seed, topDown = true }) {
  const p = ROSTER.find((r) => r.id === id);
  const bars = loadBars(file);
  const random = Math.random;
  Math.random = mulberry32(seed);
  let res;
  try {
    res = replay({ profile: p, bars, topDown });
  } finally {
    Math.random = random;
  }
  const trades = res.trades.filter((t) => Number.isFinite(t.r)).map((t) => {
    const risk = t.r ? t.pnl / t.r : null;
    return { r: t.r, time: t.openTime, grossR: risk ? t.gross / risk : null, costR: risk ? t.fees / risk : null };
  });
  return { id, bars: bars.length, from: bars[0]?.time ?? null, to: bars.at(-1)?.time ?? null, trades };
}

if (!isMainThread && workerData?.baselineJob) {
  try {
    parentPort.postMessage({ ok: true, result: replayDesk(workerData.baselineJob) });
  } catch (err) {
    parentPort.postMessage({ ok: false, error: err.message });
  }
}

function runInWorker(job) {
  return new Promise((resolve) => {
    const w = new Worker(fileURLToPath(import.meta.url), { workerData: { baselineJob: job }, resourceLimits: { maxOldGenerationSizeMb: 3072 } });
    let done = false;
    w.on('message', (m) => { done = true; resolve(m.ok ? m.result : { id: job.id, error: m.error }); });
    w.on('error', (err) => { if (!done) { done = true; resolve({ id: job.id, error: err.message }); } });
    w.on('exit', (code) => { if (!done) resolve({ id: job.id, error: `stopped (exit code ${code})` }); });
  });
}

export async function baseline({ dir, jobs = Math.max(1, Math.min(4, os.cpus().length)), seed = 1, source = 'real 1-minute bars', topDown = true, log = () => {} }) {
  const desks = ROSTER.filter((p) => !p.lab && !SKIP.has(p.id));
  const queue = [];
  const out = [];
  for (const p of desks) {
    const symbol = p.symbols[0];
    const file = path.join(dir, `${symbol}.json`);
    if (fs.existsSync(file)) queue.push({ id: p.id, file, seed, symbol, topDown });
    else out.push({ id: p.id, name: p.name, symbol, verdict: 'no history', n: 0 });
  }
  const running = new Set();
  const results = [];
  while (queue.length || running.size) {
    while (queue.length && running.size < jobs) {
      const job = queue.shift();
      log(`  replaying ${job.id} on ${job.symbol}…`);
      const pr = runInWorker(job).then((r) => { running.delete(pr); results.push({ ...r, symbol: job.symbol }); log(`  ${job.id}: ${r.error ? `failed (${r.error})` : `${r.trades.length} trades`}`); });
      running.add(pr);
    }
    await Promise.race(running);
  }
  for (const r of results) {
    const p = ROSTER.find((x) => x.id === r.id);
    if (r.error) { out.push({ id: r.id, name: p.name, symbol: r.symbol, verdict: 'replay failed', n: 0, error: r.error }); continue; }
    const days = Math.max(1, Math.round((r.to - r.from) / 86_400));
    out.push({ id: r.id, name: p.name, symbol: r.symbol, bars: r.bars, from: r.from, to: r.to, tradesPerWeek: round(r.trades.length / (days / 7), 1), ...judgeLong(r.trades) });
  }
  out.sort((a, b) => desks.findIndex((p) => p.id === a.id) - desks.findIndex((p) => p.id === b.id));
  return { v: 1, at: Date.now(), source, seed, topDown, desks: out };
}

async function main() {
  const args = process.argv.slice(2);
  const opt = (k, d = null) => {
    const i = args.indexOf(`--${k}`);
    return i >= 0 ? args[i + 1] : d;
  };
  const dir = opt('dir');
  if (!dir) {
    console.error('  Which history? npm run baseline -- --dir path/to/history (a folder of <SYMBOL>.json 1-minute bars)');
    process.exitCode = 1;
    return;
  }
  const t0 = Date.now();
  // --no-topdown: the desks without the top-down rule (to see what it changes).
  const rep = await baseline({ dir, jobs: Number(opt('jobs')) || undefined, seed: Number(opt('seed')) || 1, source: opt('source', 'real 1-minute bars'), topDown: !args.includes('--no-topdown'), log: (s) => console.log(s) });
  const fmt = (x) => (x == null ? '—' : `${x >= 0 ? '+' : ''}${x.toFixed(2)}R`);
  console.log('');
  for (const d of rep.desks) {
    if (!d.n) { console.log(`  ${d.name.padEnd(17)} ${String(d.symbol).padEnd(7)} ${d.verdict}`); continue; }
    console.log(`  ${d.name.padEnd(17)} ${d.symbol.padEnd(7)} ${String(d.n).padStart(5)} trades · ${fmt(d.avgR).padStart(7)} a trade (90%: ${fmt(d.ci?.[0])} to ${fmt(d.ci?.[1])}) · ${d.quarters.positive}/${d.quarters.total} quarters up · ${d.verdict}`);
  }
  const file = opt('out') || BASELINE_FILE;
  fs.writeFileSync(`${file}.tmp`, `${JSON.stringify(rep, null, 1)}\n`);
  fs.renameSync(`${file}.tmp`, file);
  console.log(`\n  Saved to ${path.relative(process.cwd(), file)} in ${Math.round((Date.now() - t0) / 1000)}s.\n`);
}

if (isMainThread && process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch((err) => {
    console.error(`  The baseline failed: ${err.stack || err.message}`);
    process.exitCode = 1;
  });
}
