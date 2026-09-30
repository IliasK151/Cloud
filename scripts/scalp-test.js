#!/usr/bin/env node
// The Scalping Desk on real history: replays each scalper, minute by minute, through the
// exact code the floor runs (strategy, broker, risk manager and investment committee) on
// real 1-minute bars, and prints what happened and why: sessions, liquidity runs, setups,
// what stopped a setup from becoming a trade, trades, win rate and R.
//
//   npm run scalp-test                          every scalper, on the real bars the floor
//                                               saved in data/history (your MT5 broker's
//                                               prices once MT5 is connected)
//   npm run scalp-test -- --desk jake           one scalper
//   npm run scalp-test -- --file bars.json --symbol EURUSD [--desk layla]
//                                               your own bars: [[time, o, h, l, c, v], …] or
//                                               [{ time, open, high, low, close }], time in
//                                               seconds (UTC), or { bars: [...] }
//   --committee on|shadow|off                   on (default): as on the floor; shadow: every
//                                               idea graded but none blocked; off: none
//
// It only reads: nothing is sent to MT5 and your floor's paper book isn't touched.

import fs from 'node:fs';
import path from 'node:path';
import { ROSTER } from '../server/engine/roster.js';
import { MarketData } from '../server/market/marketData.js';
import { Session } from '../server/market/session.js';
import { Broker } from '../server/engine/broker.js';
import { RiskManager } from '../server/engine/risk.js';
import { MarketBrain } from '../server/brain/market.js';
import { Committee, departmentFor } from '../server/brain/committee.js';
import { config } from '../server/config.js';

const toBar = (b) => (Array.isArray(b)
  ? { time: b[0], open: b[1], high: b[2], low: b[3], close: b[4], volume: b[5] || 1 }
  : { time: b.time, open: b.open, high: b.high, low: b.low, close: b.close, volume: b.volume || 1 });

export function loadBars(file) {
  const raw = JSON.parse(fs.readFileSync(file, 'utf8'));
  const rows = Array.isArray(raw) ? raw : raw.bars || [];
  return rows.map(toBar).filter((b) => [b.time, b.open, b.high, b.low, b.close].every(Number.isFinite)).sort((a, b) => a.time - b.time);
}

// Price path inside a minute: open, then one extreme, the other, and the close (a down bar
// usually went up first), walked in small steps so stops and entries fill near their level,
// as they do on the account, not at the far end of the bar.
const STEPS = 8;
function pathOf(b) {
  const pts = b.close < b.open ? [b.open, b.high, b.low, b.close] : [b.open, b.low, b.high, b.close];
  const out = [pts[0]];
  for (let i = 1; i < pts.length; i++) {
    for (let k = 1; k <= STEPS; k++) out.push(pts[i - 1] + ((pts[i] - pts[i - 1]) * k) / STEPS);
  }
  return out;
}

// Replay one scalper over `bars` (real 1-minute bars, oldest first). `warmup` bars go in
// as history before the desk starts deciding.
export function replay({ profile, bars, committee = 'on', warmup = 600 }) {
  const symbol = profile.symbols[0];
  const clock = { mode: 'live', speed: 1, t: bars[0].time * 1000, now() { return this.t; } };
  const md = new MarketData(clock);
  const session = new Session(clock);
  const broker = new Broker(md, clock);
  const risk = new RiskManager(config.risk, session);
  const env = { md, clock, session, broker, risk, news: null, lab: null, committee: null, allocation: config.startingCapital / ROSTER.length, emit: () => {} };
  const agent = new profile.Strategy(profile, env);
  // The desk's department reviews its ideas, as on the floor.
  const agents = new Map([[agent.id, agent]]);
  for (const id of departmentFor(symbol)?.members || []) {
    const p = ROSTER.find((r) => r.id === id);
    if (p && id !== agent.id) agents.set(id, { id, profile: p, symbols: p.symbols, lifetime: {}, setup: {} });
  }
  if (committee !== 'off') {
    env.committee = new Committee({ brain: new MarketBrain({ md, session, clock }), agents, clock, shadow: committee === 'shadow' });
  }
  const debates = [];
  env.committee?.on('debate', (d) => { if (d.proposer === agent.id) debates.push(d); });
  broker.on('trade', (t) => agent.onTradeClosed(t));
  // Every entry with its plan (stop, target), for the analysis.
  const entries = [];
  const open = agent.openTrade.bind(agent);
  agent.openTrade = (o) => {
    const ok = open(o);
    const plan = ok ? agent.plans.get(o.symbol || symbol) : null;
    if (plan) entries.push({ at: clock.t, side: plan.side, entry: plan.entry, stop: plan.initialStop, target: plan.target, risk: plan.risk, atr: agent.atrNow(), reason: plan.reason, grade: plan.grade });
    return ok;
  };

  const n0 = Math.min(warmup, Math.max(0, bars.length - 1));
  md.seed(symbol, bars.slice(0, n0));
  md.setStatus(symbol, 'LIVE', 'history');
  let day = session.tradingDay(bars[n0]?.time * 1000);
  const zones = new Set();
  const funnel = { killzoneMinutes: 0, swept: 0, trapped: 0, shifted: 0 };
  let prev = { swept: false, trapped: false, shifted: false };

  md.on('tick', (id, px) => agent.onTick(id, px));
  md.on('bar', (id, bar) => {
    agent.onBar(id, bar);
    const kz = agent.ctx?.kz;
    if (kz?.active) {
      funnel.killzoneMinutes++;
      zones.add(kz.key);
      const c = agent.setup.checklist || [];
      const now = { swept: !!c[3]?.ok, trapped: !!c[4]?.ok, shifted: !!c[5]?.ok };
      if (now.swept && !prev.swept) funnel.swept++;
      if (now.trapped && !prev.trapped) funnel.trapped++;
      if (now.shifted && !prev.shifted) funnel.shifted++;
      prev = now;
    }
  });

  for (let i = n0; i < bars.length; i++) {
    const b = bars[i];
    const t0 = b.time * 1000;
    const d = session.tradingDay(t0);
    if (d !== day) {
      day = d;
      agent.resetDay();
    }
    const pts = pathOf(b);
    pts.forEach((px, k) => {
      clock.t = t0 + Math.floor((k * 59_000) / pts.length);
      md.applyTick(symbol, px, (b.volume || 1) / pts.length, clock.t);
    });
    // Flat into the daily close, like the floor.
    if (session.isFlattenWindow(clock.t) && agent.book.positions.size) agent.flatten('End-of-day flat');
  }
  clock.t += 60_000;
  md.applyTick(symbol, bars.at(-1).close, 0, clock.t); // close the last bar
  if (agent.book.positions.size) agent.flatten('End of the data');

  const trades = broker.book(agent.id).trades.filter((t) => t.r != null);
  return { agent, trades, entries, debates, funnel: { ...funnel, sessions: zones.size }, notes: agent.allNotes };
}

// Keep every note (the desk's own log only holds the latest 80).
function captureNotes(Strategy) {
  const orig = Strategy.prototype.note;
  Strategy.prototype.note = function note(text, kind, data) {
    (this.allNotes ||= []).push({ text, kind });
    return orig.call(this, text, kind, data);
  };
}

function summary({ agent, trades, debates, funnel }) {
  const notes = agent.allNotes || [];
  const count = (re) => notes.filter((n) => re.test(n.text)).length;
  const reasons = (re) => {
    const out = {};
    for (const n of notes) {
      const m = n.text.match(re);
      if (m) out[m[1]] = (out[m[1]] || 0) + 1;
    }
    return out;
  };
  const wins = trades.filter((t) => t.pnl > 0).length;
  const sumR = trades.reduce((s, t) => s + t.r, 0);
  const gw = trades.filter((t) => t.pnl > 0).reduce((s, t) => s + t.pnl, 0);
  const gl = -trades.filter((t) => t.pnl <= 0).reduce((s, t) => s + t.pnl, 0);
  const grades = {};
  for (const d of debates) grades[d.grade] = (grades[d.grade] || 0) + 1;
  return {
    desk: agent.profile.desk,
    sessions: funnel.sessions,
    swept: funnel.swept,
    trapped: funnel.trapped,
    shifted: funnel.shifted,
    setups: count(/setup on /) + notes.filter((n) => n.kind === 'entry' && !/pullback/.test(n.text)).length,
    tooDeep: count(/too deep for a scalp stop/),
    cancelled: reasons(/^Setup cancelled: (.*)$/),
    committee: reasons(/^Committee said no: (.*?)(?: \(\d+th percentile\))?$/),
    blocked: reasons(/^Signal skipped — (.*)$/),
    grades,
    trades: trades.length,
    winRate: trades.length ? wins / trades.length : null,
    avgR: trades.length ? sumR / trades.length : null,
    sumR,
    pf: gl > 0 ? gw / gl : gw > 0 ? Infinity : null,
    exits: trades.reduce((m, t) => ({ ...m, [t.exitReason]: (m[t.exitReason] || 0) + 1 }), {}),
  };
}

function print(s, bars, symbol) {
  const pct = (x) => (x == null ? '—' : `${Math.round(x * 100)}%`);
  const r = (x) => (x == null ? '—' : `${x >= 0 ? '+' : ''}${x.toFixed(2)}R`);
  const days = new Set(bars.map((b) => new Date(b.time * 1000).toISOString().slice(0, 10))).size;
  const from = new Date(bars[0].time * 1000).toISOString().slice(0, 10);
  const to = new Date(bars.at(-1).time * 1000).toISOString().slice(0, 10);
  console.log(`\n  ${s.desk} · ${symbol} · ${bars.length.toLocaleString('en-US')} real 1-minute bars, ${days} days (${from} → ${to})`);
  console.log(`    Killzone sessions seen: ${s.sessions}`);
  console.log(`    Liquidity runs: ${s.swept} · trapped (closed back inside): ${s.trapped} · shifted: ${s.shifted}`);
  console.log(`    Setups: ${s.setups} · too deep for the scalp stop: ${s.tooDeep}`);
  const line = (label, obj) => {
    const e = Object.entries(obj).sort((a, b) => b[1] - a[1]);
    if (e.length) console.log(`    ${label}: ${e.map(([k, v]) => `${k} ×${v}`).join('; ')}`);
  };
  line('Pullback entries let go', s.cancelled);
  line('Committee said no', s.committee);
  line('Risk desk said no', s.blocked);
  line('Committee grades', s.grades);
  console.log(`    Trades: ${s.trades} · win rate ${pct(s.winRate)} · average ${r(s.avgR)} · total ${r(s.sumR)} · profit factor ${s.pf == null ? '—' : s.pf === Infinity ? '∞' : s.pf.toFixed(2)}`);
  line('Exits', s.exits);
}

// ---- command line ------------------------------------------------------------------------------
async function main() {
  const args = process.argv.slice(2);
  const opt = (k, d = null) => {
    const i = args.indexOf(`--${k}`);
    return i >= 0 ? args[i + 1] : d;
  };
  const committee = opt('committee', 'on');
  // --set entry=pullback,pools=major … : try other scalp settings (see strategies/ajScalp.js).
  const set = Object.fromEntries((opt('set') || '').split(',').filter(Boolean).map((kv) => {
    const [k, v] = kv.split('=');
    return [k, Number.isFinite(Number(v)) && v !== '' ? Number(v) : v];
  }));
  const scalpers = ROSTER.filter((p) => p.scalper);
  const deskId = opt('desk');
  const file = opt('file');
  const symbol = opt('symbol');
  for (const p of scalpers) captureNotes(p.Strategy);

  let runs = [];
  if (file) {
    const bars = loadBars(file);
    const sym = symbol || JSON.parse(fs.readFileSync(file, 'utf8')).symbol;
    let desks = deskId ? scalpers.filter((p) => p.id === deskId) : scalpers.filter((p) => p.symbols[0] === sym);
    // A market no scalper trades (e.g. S&P futures for the index desk): run the index desk's
    // method on it.
    if (!desks.length && sym) desks = scalpers.filter((p) => p.symbols[0] === 'NAS100').map((p) => ({ ...p, symbols: [sym] }));
    runs = desks.map((p) => ({ profile: p.symbols[0] === sym ? p : { ...p, symbols: [sym] }, bars, symbol: sym }));
  } else {
    const dir = path.join(config.dataDir, 'history');
    for (const p of scalpers.filter((x) => !deskId || x.id === deskId)) {
      const f = path.join(dir, `${p.symbols[0]}.json`);
      if (!fs.existsSync(f)) {
        console.log(`\n  ${p.desk}: no saved history for ${p.symbols[0]} yet (data/history/${p.symbols[0]}.json). Run the floor with MT5 connected for a while first.`);
        continue;
      }
      runs.push({ profile: p, bars: loadBars(f), symbol: p.symbols[0] });
    }
  }
  if (!runs.length) {
    console.log('\n  Nothing to test.\n');
    return;
  }
  console.log(`\n  Scalping Desk on real history · committee ${committee}${Object.keys(set).length ? ` · ${Object.entries(set).map(([k, v]) => `${k}=${v}`).join(', ')}` : ''}`);
  const all = [];
  for (const run of runs) {
    if (run.bars.length < 700) {
      console.log(`\n  ${run.profile.desk}: only ${run.bars.length} bars of ${run.symbol}, not enough to test (needs 700+).`);
      continue;
    }
    const res = replay({ profile: { ...run.profile, scalp: { ...run.profile.scalp, ...set } }, bars: run.bars, committee });
    const s = summary(res);
    print(s, run.bars, run.symbol);
    all.push(s);
  }
  const trades = all.reduce((x, s) => x + s.trades, 0);
  const sumR = all.reduce((x, s) => x + s.sumR, 0);
  console.log(`\n  All scalpers: ${trades} trades, ${trades ? `${sumR >= 0 ? '+' : ''}${sumR.toFixed(2)}R in total` : 'no trades'}\n`);
}

if (process.argv[1] && path.resolve(process.argv[1]) === path.resolve(new URL(import.meta.url).pathname)) {
  main().catch((err) => {
    console.error(`  The scalp test failed: ${err.stack || err.message}`);
    process.exitCode = 1;
  });
}
