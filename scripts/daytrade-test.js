#!/usr/bin/env node
// The Day Trading Desk on real history: replays each day trader, minute by minute, through the
// exact code the floor runs (top-down read, playbook, broker, risk manager) on real 1-minute
// bars, and prints what happened and why: days with a bias, sweeps, shifts, what stopped a
// shift from becoming a trade, trades, win rate and R.
//
//   npm run daytrade-test                        every day trader, on the real bars the floor
//                                                saved in data/history (your MT5 broker's prices
//                                                once MT5 is connected)
//   npm run daytrade-test -- --desk tyler        one desk
//   npm run daytrade-test -- --dir path/to/history
//                                                a folder of <SYMBOL>.json 1-minute bars
//   npm run daytrade-test -- --file bars.json --symbol NAS100 [--desk tyler]
//                                                your own bars: [[time, o, h, l, c, v], …] or
//                                                [{ time, open, high, low, close }], time in
//                                                seconds (UTC), or { bars: [...] }
//   --set minRR=4,zones=ny                       try other playbook rules (engine/daytrade.js)
//
// The weekly structure needs months of bars behind it: with a few weeks the desk reads the
// daily and 4-hour only. It only reads: nothing is sent to MT5 and your paper book isn't touched.

import fs from 'node:fs';
import path from 'node:path';
import { ROSTER } from '../server/engine/roster.js';
import { config } from '../server/config.js';
import { replay, loadBars } from './replay.js';

// Fewer calendar days of bars than this and the replay mostly measures the read warming up.
const SHORT_TEST_DAYS = 42;
const pct = (x) => (x == null ? '—' : `${Math.round(x * 100)}%`);
const fmtR = (x) => (x == null ? '—' : `${x >= 0 ? '+' : ''}${x.toFixed(2)}R`);

export function summarize({ trades, funnel }) {
  const n = trades.length;
  const sumR = trades.reduce((s, t) => s + t.r, 0);
  const gw = trades.filter((t) => t.r > 0).reduce((s, t) => s + t.r, 0);
  const gl = -trades.filter((t) => t.r <= 0).reduce((s, t) => s + t.r, 0);
  let eq = 0;
  let peak = 0;
  let dd = 0;
  for (const t of trades) {
    eq += t.r;
    peak = Math.max(peak, eq);
    dd = Math.max(dd, peak - eq);
  }
  return {
    funnel,
    trades: n,
    winRate: n ? trades.filter((t) => t.r > 0).length / n : null,
    avgR: n ? sumR / n : null,
    sumR,
    pf: gl > 0 ? gw / gl : gw > 0 ? Infinity : null,
    maxDD: dd,
    exits: trades.reduce((m, t) => ({ ...m, [t.exitReason]: (m[t.exitReason] || 0) + 1 }), {}),
  };
}

function print(p, s, bars, symbol) {
  const days = new Set(bars.map((b) => new Date(b.time * 1000).toISOString().slice(0, 10))).size;
  const from = new Date(bars[0].time * 1000).toISOString().slice(0, 10);
  const to = new Date(bars.at(-1).time * 1000).toISOString().slice(0, 10);
  const f = s.funnel || {};
  const span = Math.round((bars.at(-1).time - bars[0].time) / 86_400);
  console.log(`\n  ${p.name} · ${p.desk} · ${symbol} · ${bars.length.toLocaleString('en-US')} real 1-minute bars, ${days} days (${from} → ${to})`);
  console.log(`    Days with a top-down bias: ${f.biasDays ?? 0} of ${f.days ?? 0}`);
  // The read needs 3–4 weeks of bars before it gives a bias: on less, the test says little.
  if (span < SHORT_TEST_DAYS) console.log(`    ⚠ Only ${span} days of history: the top-down read needs about 3–4 weeks before it gives a bias, so most of these days had none and this result says little. Let MT5 send months of history (npm run doctor shows how far it is) and run this again.`);
  console.log(`    Liquidity swept against the bias: ${f.sweeps ?? 0} · ran through (a breakdown, not a sweep): ${f.deep ?? 0} · never shifted: ${f.stale ?? 0}`);
  console.log(`    5-minute shifts: ${f.shifts ?? 0} · outside the killzones: ${f.outside ?? 0} · no displacement: ${f.weak ?? 0} · no fair value gap: ${f.noGap ?? 0} · already traded that day: ${f.busy ?? 0}${f.costly ? ` · costs too high for the stop: ${f.costly}` : ''}`);
  console.log(`    Setups: ${f.orders ?? 0}`);
  console.log(`    Trades: ${s.trades} · win rate ${pct(s.winRate)} · average ${fmtR(s.avgR)} · total ${fmtR(s.sumR)} · profit factor ${s.pf == null ? '—' : s.pf === Infinity ? '∞' : s.pf.toFixed(2)} · worst drawdown ${s.maxDD.toFixed(1)}R`);
  const e = Object.entries(s.exits).sort((a, b) => b[1] - a[1]);
  if (e.length) console.log(`    Exits: ${e.map(([k, v]) => `${k} ×${v}`).join('; ')}`);
}

async function main() {
  const args = process.argv.slice(2);
  const opt = (k, d = null) => {
    const i = args.indexOf(`--${k}`);
    return i >= 0 ? args[i + 1] : d;
  };
  const set = Object.fromEntries((opt('set') || '').split(',').filter(Boolean).map((kv) => {
    const [k, v] = kv.split('=');
    return [k, Number.isFinite(Number(v)) && v !== '' ? Number(v) : v];
  }));
  const traders = ROSTER.filter((p) => p.dayTrader);
  const deskId = opt('desk');
  const file = opt('file');
  const symbol = opt('symbol');
  let runs = [];
  if (file) {
    const bars = loadBars(file);
    const sym = symbol || JSON.parse(fs.readFileSync(file, 'utf8')).symbol;
    let desks = deskId ? traders.filter((p) => p.id === deskId) : traders.filter((p) => p.symbols[0] === sym);
    // A market no day trader trades: run the Nasdaq desk's method on it.
    if (!desks.length && sym) desks = traders.filter((p) => p.id === 'tyler');
    runs = desks.map((p) => ({ profile: p.symbols[0] === sym ? p : { ...p, symbols: [sym] }, bars, symbol: sym }));
  } else {
    const dir = opt('dir') || path.join(config.dataDir, 'history');
    for (const p of traders.filter((x) => !deskId || x.id === deskId)) {
      const f = path.join(dir, `${p.symbols[0]}.json`);
      if (!fs.existsSync(f)) {
        console.log(`\n  ${p.name}: no saved history for ${p.symbols[0]} yet (${path.relative(process.cwd(), f)}). Run the floor with MT5 connected for a while first.`);
        continue;
      }
      runs.push({ profile: p, bars: loadBars(f), symbol: p.symbols[0] });
    }
  }
  if (!runs.length) {
    console.log('\n  Nothing to test.\n');
    return;
  }
  console.log(`\n  Day Trading Desk on real history${Object.keys(set).length ? ` · ${Object.entries(set).map(([k, v]) => `${k}=${v}`).join(', ')}` : ''}`);
  let trades = 0;
  let sumR = 0;
  for (const run of runs) {
    if (run.bars.length < 3000) {
      console.log(`\n  ${run.profile.name}: only ${run.bars.length} bars of ${run.symbol}, not enough to test (needs a few days: 3,000+).`);
      continue;
    }
    const res = replay({ profile: { ...run.profile, rules: { ...run.profile.rules, ...set } }, bars: run.bars });
    const s = summarize(res);
    print(run.profile, s, run.bars, run.symbol);
    trades += s.trades;
    sumR += s.sumR;
  }
  console.log(`\n  All day traders: ${trades} trades, ${trades ? `${sumR >= 0 ? '+' : ''}${sumR.toFixed(2)}R in total` : 'no trades'}`);
  // R is what one trade risks (its stop): at 0.25% risk per trade, −4R is −1% of the account.
  if (trades) console.log(`  (1R = what one trade risks, from entry to stop. At the account's default 0.25% per trade, ${sumR >= 0 ? '+' : ''}${sumR.toFixed(1)}R is ${sumR >= 0 ? '+' : '−'}${(Math.abs(sumR) * 0.25).toFixed(1)}% of the account. A replay on saved prices: nothing was traded.)`);
  if (trades && trades < 30) console.log(`  ${trades} trades is far too few to judge a method: it takes about 100 before the total means much.`);
  console.log('');
}

if (process.argv[1] && path.resolve(process.argv[1]) === path.resolve(new URL(import.meta.url).pathname)) {
  main().catch((err) => {
    console.error(`  The day trading test failed: ${err.stack || err.message}`);
    process.exitCode = 1;
  });
}
