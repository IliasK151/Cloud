#!/usr/bin/env node
// The weekend record: every desk that day-trades crypto at the weekend (profile.weekendSymbol),
// replayed through the floor's own code on real 1-minute crypto prices, trading only from
// Friday 18:00 to Sunday 18:00 New York, flat by 16:50 each day, as on the floor. Written to
// server/research/weekend.json; on the weekend the account brain judges a desk by it the way
// it judges it by its long-run record on its own market during the week.
//
//   npm run weekend -- --dir path/to/crypto [--symbol BTCUSD] [--jobs 4] [--source "…"]
//
// --dir holds <SYMBOL>.json 1-minute bars, or folders of them (one per series: different
// exchanges or years are replayed separately and pooled). Every desk is replayed on the same
// --symbol, whichever coin it trades at the weekend.

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Worker, isMainThread, parentPort, workerData } from 'node:worker_threads';
import { fileURLToPath } from 'node:url';
import { ROSTER } from '../server/engine/roster.js';
import { isWeekendDay } from '../server/engine/fund.js';
import { nyDateKey } from '../server/market/session.js';
import { mulberry32 } from '../server/util/random.js';
import { replay, loadBars } from './scalp-test.js';
import { judgeLong } from './baseline.js';

const HERE = path.dirname(fileURLToPath(import.meta.url));
export const WEEKEND_FILE = path.join(HERE, '..', 'server', 'research', 'weekend.json');

// The floor's trading day starts at 18:00 New York the evening before.
export const weekendAt = (ms) => isWeekendDay(nyDateKey(ms + 6 * 3_600_000));

function replayDesk({ id, file, symbol, seed }) {
  const p = ROSTER.find((r) => r.id === id);
  // The desk only decides at the weekend; during the week it just watches the market go by.
  const proto = p.Strategy.prototype;
  const evaluate = proto.evaluate;
  proto.evaluate = function weekendOnly(...a) {
    return weekendAt(this.env.clock.now()) ? evaluate.apply(this, a) : undefined;
  };
  const bars = loadBars(file);
  const random = Math.random;
  Math.random = mulberry32(seed);
  let res;
  try {
    res = replay({ profile: { ...p, symbols: [symbol] }, bars });
  } finally {
    Math.random = random;
    proto.evaluate = evaluate;
  }
  const trades = res.trades.filter((t) => Number.isFinite(t.r) && weekendAt(t.openTime)).map((t) => ({ r: t.r, time: t.openTime }));
  const days = new Set(bars.filter((b) => weekendAt(b.time * 1000)).map((b) => nyDateKey(b.time * 1000 + 6 * 3_600_000)));
  return { id, from: bars[0]?.time ?? null, to: bars.at(-1)?.time ?? null, weekends: days.size / 2, trades };
}

if (!isMainThread && workerData?.weekendJob) {
  try {
    parentPort.postMessage({ ok: true, result: replayDesk(workerData.weekendJob) });
  } catch (err) {
    parentPort.postMessage({ ok: false, error: err.message });
  }
}

function runInWorker(job) {
  return new Promise((resolve) => {
    const w = new Worker(fileURLToPath(import.meta.url), { workerData: { weekendJob: job }, resourceLimits: { maxOldGenerationSizeMb: 3072 } });
    let done = false;
    w.on('message', (m) => { done = true; resolve(m.ok ? m.result : { id: job.id, error: m.error }); });
    w.on('error', (err) => { if (!done) { done = true; resolve({ id: job.id, error: err.message }); } });
    w.on('exit', (code) => { if (!done) resolve({ id: job.id, error: `stopped (exit code ${code})` }); });
  });
}

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
const monthText = (sec) => { const d = new Date(sec * 1000); return `${MONTHS[d.getUTCMonth()]} ${d.getUTCFullYear()}`; };
const NAMES = { BTCUSD: 'Bitcoin', ETHUSD: 'Ether', SOLUSD: 'Solana' };

export async function weekendRecord({ dir, symbol = 'BTCUSD', jobs = Math.max(1, Math.min(4, os.cpus().length)), seed = 1, source = 'real 1-minute bars', log = () => {} }) {
  const files = [];
  if (fs.existsSync(path.join(dir, `${symbol}.json`))) files.push(path.join(dir, `${symbol}.json`));
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    if (e.isDirectory() && fs.existsSync(path.join(dir, e.name, `${symbol}.json`))) files.push(path.join(dir, e.name, `${symbol}.json`));
  }
  if (!files.length) throw new Error(`no ${symbol}.json in ${dir}`);
  const desks = ROSTER.filter((p) => p.weekendSymbol);
  const queue = desks.flatMap((p) => files.map((file) => ({ id: p.id, file, symbol, seed })));
  const results = [];
  const running = new Set();
  while (queue.length || running.size) {
    while (queue.length && running.size < jobs) {
      const job = queue.shift();
      log(`  replaying ${job.id} on ${symbol} weekends (${path.basename(path.dirname(job.file))})…`);
      const pr = runInWorker(job).then((r) => { running.delete(pr); results.push(r); log(`  ${job.id}: ${r.error ? `failed (${r.error})` : `${r.trades.length} weekend trades`}`); });
      running.add(pr);
    }
    await Promise.race(running);
  }
  const out = desks.map((p) => {
    const mine = results.filter((r) => r.id === p.id);
    const failed = mine.find((r) => r.error);
    if (failed) return { id: p.id, name: p.name, symbol, market: p.weekendSymbol, verdict: 'replay failed', n: 0, error: failed.error };
    const trades = mine.flatMap((r) => r.trades).sort((a, b) => a.time - b.time);
    const from = Math.min(...mine.map((r) => r.from));
    const to = Math.max(...mine.map((r) => r.to));
    const weekends = Math.round(mine.reduce((s, r) => s + r.weekends, 0));
    return {
      id: p.id, name: p.name, symbol, market: p.weekendSymbol, from, to, weekends,
      label: `${weekends} ${NAMES[symbol] || symbol} weekends (${monthText(from)} – ${monthText(to)})`,
      ...judgeLong(trades),
    };
  });
  return { v: 1, at: Date.now(), source, seed, symbol, desks: out };
}

async function main() {
  const args = process.argv.slice(2);
  const opt = (k, d = null) => { const i = args.indexOf(`--${k}`); return i >= 0 ? args[i + 1] : d; };
  const dir = opt('dir');
  if (!dir) {
    console.error('  Which history? npm run weekend -- --dir path/to/crypto (BTCUSD.json 1-minute bars, or folders of them)');
    process.exitCode = 1;
    return;
  }
  const t0 = Date.now();
  const rep = await weekendRecord({ dir, symbol: opt('symbol', 'BTCUSD'), jobs: Number(opt('jobs')) || undefined, seed: Number(opt('seed')) || 1, source: opt('source', 'real 1-minute bars'), log: (s) => console.log(s) });
  const fmt = (x) => (x == null ? '—' : `${x >= 0 ? '+' : ''}${x.toFixed(2)}R`);
  console.log('');
  for (const d of rep.desks) {
    if (!d.n) { console.log(`  ${d.name.padEnd(17)} ${d.verdict}`); continue; }
    console.log(`  ${d.name.padEnd(17)} ${String(d.n).padStart(5)} trades on ${d.label} · ${fmt(d.avgR).padStart(7)} a trade (90%: ${fmt(d.ci?.[0])} to ${fmt(d.ci?.[1])}) · ${d.verdict}`);
  }
  const file = opt('out') || WEEKEND_FILE;
  fs.writeFileSync(`${file}.tmp`, `${JSON.stringify(rep, null, 1)}\n`);
  fs.renameSync(`${file}.tmp`, file);
  console.log(`\n  Saved to ${path.relative(process.cwd(), file)} in ${Math.round((Date.now() - t0) / 1000)}s.\n`);
}

if (isMainThread && process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch((err) => {
    console.error(`  The weekend record failed: ${err.stack || err.message}`);
    process.exitCode = 1;
  });
}
