#!/usr/bin/env node
// Which desks really make money, and is the floor ready for a paid challenge?
//
// Replays every trading desk, minute by minute, through the floor's own code (strategy,
// committee, costs as FTMO charges them, the desk's learning) on the real 1-minute bars the
// floor saved in data/history (your MT5 broker's prices once MT5 prices a market). Each desk
// is judged on its results after costs: trades, win rate, average R with a 90% confidence
// range, and whether both halves of the history agree. Then thousands of FTMO challenges are
// played out with the trades of the desks that show an edge, at several risk sizes, to give
// the chance of passing.
//
//   npm run edge                          every desk, on data/history
//   npm run edge -- --desk amara          one desk
//   npm run edge -- --dir path/to/history a folder of <SYMBOL>.json files
//   npm run edge -- --program 2-step      the challenge to simulate (default: your FTMO
//                                         setup's program, else 1-step)
//   npm run edge -- --seeds 1             faster: one replay per desk (default 3)
//
// It only reads market data: nothing is sent to MT5 and your paper book isn't touched. The
// result is also saved to data/edge-report.json.

import fs from 'node:fs';
import path from 'node:path';
import { ROSTER } from '../server/engine/roster.js';
import { config } from '../server/config.js';
import { mulberry32 } from '../server/util/random.js';
import { riskSweep } from '../server/live/challengeSim.js';
import { replay, loadBars } from './replay.js';

// Desks that can't trade one prop account (pairs, market making) or that research their own
// strategies as they go (the research lab) aren't replayed.
const SKIP = new Set(['kenji', 'isabella']);
export const MIN_TRADES = 15;

const mean = (a) => (a.length ? a.reduce((s, x) => s + x, 0) / a.length : null);

// 90% range of the average R, by resampling the desk's own trades.
export function bootstrapCI(rs, { draws = 2000, seed = 7 } = {}) {
  if (rs.length < 2) return null;
  const rng = mulberry32(seed);
  const avgs = [];
  for (let d = 0; d < draws; d++) {
    let s = 0;
    for (let i = 0; i < rs.length; i++) s += rs[Math.floor(rng() * rs.length)];
    avgs.push(s / rs.length);
  }
  avgs.sort((a, b) => a - b);
  return [avgs[Math.floor(draws * 0.05)], avgs[Math.floor(draws * 0.95)]];
}

// One desk's results, and the verdict.
export function judge(trades, { runs = [] } = {}) {
  const rs = trades.map((t) => t.r);
  const n = rs.length;
  const avg = mean(runs.length ? runs : rs);
  const ci = bootstrapCI(rs);
  const half = Math.floor(n / 2);
  const h1 = mean(rs.slice(0, half));
  const h2 = mean(rs.slice(half));
  const wins = rs.filter((r) => r > 0);
  const losses = rs.filter((r) => r <= 0);
  const gl = -losses.reduce((s, r) => s + r, 0);
  let verdict;
  if (n < MIN_TRADES) verdict = 'too few trades to tell';
  else if (ci && ci[0] > 0) verdict = 'EDGE';
  else if (avg > 0.05 && h1 > 0 && h2 > 0) verdict = 'promising';
  else if (avg <= 0) verdict = 'no edge';
  else verdict = 'unclear';
  return {
    n, avgR: avg, totalR: rs.reduce((s, r) => s + r, 0), winRate: n ? wins.length / n : null,
    profitFactor: gl > 0 ? wins.reduce((s, r) => s + r, 0) / gl : null, ci, halves: [h1, h2], verdict,
  };
}

// Replay a desk with a fixed seed for the paper broker's random slippage, so runs repeat.
function seededReplay(args, seed) {
  const random = Math.random;
  Math.random = mulberry32(seed);
  try {
    return replay(args);
  } finally {
    Math.random = random;
  }
}

export function edgeReport({ dir, deskId = null, seeds = 3, program = '1-step', size = 10_000, log = () => {} }) {
  const desks = ROSTER.filter((p) => !p.lab && !SKIP.has(p.id) && (!deskId || p.id === deskId));
  const out = [];
  // Trades of the desks that show an edge (for the challenge simulation), and of every desk,
  // with each desk's own trades per day: crypto trades seven days a week, the rest five, and a
  // market saved for three days isn't slower than one saved for three weeks.
  const pool = { rs: [], perDay: 0 };
  const all = { rs: [], perDay: 0 };
  let maxDays = 0;
  for (const p of desks) {
    const symbol = p.symbols[0];
    const base = { id: p.id, name: p.name, desk: p.desk, symbol };
    const file = path.join(dir, `${symbol}.json`);
    if (!fs.existsSync(file)) {
      out.push({ ...base, verdict: 'no saved history', n: 0 });
      continue;
    }
    // One unreadable file or one desk's replay failing must not sink every other desk's review.
    let bars;
    try {
      bars = loadBars(file);
    } catch (err) {
      out.push({ ...base, verdict: 'history file unreadable', n: 0, error: err.message });
      continue;
    }
    if (bars.length < 1500) {
      out.push({ ...base, verdict: `only ${bars.length} bars saved`, n: 0 });
      continue;
    }
    log(`  ${p.name} on ${symbol} (${bars.length.toLocaleString('en-US')} bars)…`);
    let first = null;
    const runAvgs = [];
    try {
      for (let s = 1; s <= seeds; s++) {
        const res = seededReplay({ profile: p, bars }, s);
        const trades = res.trades.filter((t) => Number.isFinite(t.r)).map((t) => ({ r: t.r, time: t.closeTime ?? t.openTime }));
        if (!first) first = trades;
        if (trades.length) runAvgs.push(mean(trades.map((t) => t.r)));
      }
    } catch (err) {
      out.push({ ...base, verdict: 'replay failed', n: 0, error: err.message });
      continue;
    }
    const days = tradingDaysOf(bars);
    maxDays = Math.max(maxDays, days);
    const j = judge(first, { runs: runAvgs });
    out.push({ ...base, bars: bars.length, from: bars[0].time, to: bars.at(-1).time, days, ...j });
    const rs = first.map((t) => t.r);
    all.rs.push(...rs);
    all.perDay += rs.length / days;
    if (j.verdict === 'EDGE' || j.verdict === 'promising') {
      pool.rs.push(...rs);
      pool.perDay += rs.length / days;
    }
  }
  const sim = (g) => (g.rs.length ? { trades: g.rs.length, avgR: mean(g.rs), tradesPerDay: g.perDay, ...riskSweep({ samples: g.rs, tradesPerDay: g.perDay, program, size }) } : null);
  return {
    at: Date.now(), program, size, tradingDays: maxDays, seeds,
    desks: out,
    withEdge: sim(pool),
    everyone: sim(all),
  };
}

// Days with a real session in the history: at least an hour of minutes (a few stray bars on
// a closed day don't count).
export function tradingDaysOf(bars) {
  const perDay = new Map();
  for (const b of bars) {
    const d = new Date(b.time * 1000).toISOString().slice(0, 10);
    perDay.set(d, (perDay.get(d) || 0) + 1);
  }
  return [...perDay.values()].filter((n) => n >= 60).length || 1;
}

// ---- printing ------------------------------------------------------------------------------------
const fr = (x) => (x == null ? '—' : `${x >= 0 ? '+' : ''}${x.toFixed(2)}R`);
const pct = (x) => (x == null ? '—' : `${Math.round(x * 100)}%`);

function printSim(label, s) {
  if (!s) return;
  console.log(`\n  ${label}: ${s.trades} trades, ${fr(s.avgR)} a trade, about ${s.tradesPerDay.toFixed(1)} a day`);
  // A pass time only means something when passing does: one lucky run in thousands has no median.
  for (const r of s.rows) console.log(`    risk ${String(r.riskPct).padEnd(4)}% a trade → passes ${pct(r.passed).padStart(4)} · fails ${pct(r.failed).padStart(4)} · still going after 60 trading days ${pct(r.open).padStart(4)}${r.medianDays && r.passed >= 0.005 ? ` · median ${r.medianDays} days to pass` : ''}`);
}

export function printReport(rep) {
  console.log(`\n  Edge report · your saved history · ${rep.tradingDays} trading days · FTMO ${rep.program} $${rep.size.toLocaleString('en-US')}\n`);
  for (const d of rep.desks) {
    if (!d.n && d.verdict !== 'too few trades to tell') {
      console.log(`  ${d.name.padEnd(17)} ${d.symbol.padEnd(7)} ${d.verdict}`);
      continue;
    }
    const range = d.ci ? `${fr(d.ci[0])} to ${fr(d.ci[1])}` : '—';
    console.log(`  ${d.name.padEnd(17)} ${d.symbol.padEnd(7)} ${String(d.n).padStart(3)} trades · won ${pct(d.winRate).padStart(4)} · ${fr(d.avgR).padStart(7)} a trade (90%: ${range}) · halves ${fr(d.halves[0])} / ${fr(d.halves[1])} · ${d.verdict}`);
  }
  printSim('The desks with an edge, as a challenge', rep.withEdge);
  printSim('Every desk, as a challenge (for comparison)', rep.everyone);
  const best = rep.withEdge?.best;
  console.log('');
  if (!rep.withEdge) {
    console.log('  Verdict: no desk shows an edge on this history yet. Keep training on the Free Trial; don\'t pay for a challenge on these results.');
  } else if (best.passed >= 0.6) {
    console.log(`  Verdict: the desks with an edge pass ${pct(best.passed)} of simulated challenges at ${best.riskPct}% risk a trade. Confirm it on the Free Trial (same desks, same risk) before paying for one.`);
  } else {
    console.log(`  Verdict: even the best desks pass only ${pct(best.passed)} of simulated challenges (best at ${best.riskPct}% risk). Not ready for a paid challenge yet.`);
  }
  console.log('  This is history, not a promise: the market changes, and a few weeks of data is a small sample. More history (keep the floor running with MT5) makes it sharper.\n');
}

async function main() {
  const args = process.argv.slice(2);
  const opt = (k, d = null) => {
    const i = args.indexOf(`--${k}`);
    return i >= 0 ? args[i + 1] : d;
  };
  const dir = opt('dir') || path.join(config.dataDir, 'history');
  // The challenge to simulate: as asked, else the program of your FTMO setup, else 1-Step.
  let program = opt('program');
  let size = Number(opt('size')) || null;
  if (!program || !size) {
    try {
      const live = JSON.parse(fs.readFileSync(path.join(config.dataDir, 'live.json'), 'utf8'));
      // The account set up or changed most recently: the one MT5 trades now.
      const p = Object.values(live.profiles || {}).sort((a, b) => (b?.updatedAt || 0) - (a?.updatedAt || 0))[0];
      program ||= p?.program || null;
      size ||= p?.size || null;
    } catch { /* no FTMO setup yet */ }
  }
  program = ['1-step', '2-step'].includes(program) ? program : '1-step';
  size ||= 10_000;
  console.log(`\n  Replaying every trading desk on ${dir} (takes a few minutes)…`);
  const rep = edgeReport({ dir, deskId: opt('desk'), seeds: Math.max(1, Number(opt('seeds')) || 3), program, size, log: (s) => console.log(s) });
  printReport(rep);
  // Written whole and then moved into place: a running floor picks it up (within a minute) and
  // must never read it half-written.
  try {
    const file = path.join(config.dataDir, 'edge-report.json');
    fs.writeFileSync(`${file}.cli.tmp`, JSON.stringify(rep, null, 1));
    fs.renameSync(`${file}.cli.tmp`, file);
    console.log('  Saved to data/edge-report.json: a running floor uses it within a minute.\n');
  } catch { /* read-only data folder: the printout is the report */ }
}

if (process.argv[1] && path.resolve(process.argv[1]) === path.resolve(new URL(import.meta.url).pathname)) {
  main().catch((err) => {
    console.error(`  The edge report failed: ${err.stack || err.message}`);
    process.exitCode = 1;
  });
}
