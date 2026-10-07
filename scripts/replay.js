// The floor's own code on real history: replays one desk, minute by minute, through the exact
// code the floor runs (strategy, top-down read, broker, risk manager and committee) on real
// 1-minute bars. npm run daytrade-test, npm run edge, npm run baseline, npm run brain and
// npm run weekend all replay desks with it. It only reads: nothing is sent to MT5 and your
// floor's paper book isn't touched.

import fs from 'node:fs';
import { ROSTER } from '../server/engine/roster.js';
import { MarketData } from '../server/market/marketData.js';
import { Session } from '../server/market/session.js';
import { Broker } from '../server/engine/broker.js';
import { RiskManager } from '../server/engine/risk.js';
import { MarketBrain } from '../server/brain/market.js';
import { Committee, departmentFor } from '../server/brain/committee.js';
import { config } from '../server/config.js';
import { TopDownBook } from '../server/engine/topdown.js';

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

// Replay one desk over `bars` (real 1-minute bars, oldest first). `warmup` bars go in as
// history before the desk starts deciding.
// neural: optional (agent, env) => { judge, observe }, the floor's neural brain or a recorder
// that collects what it sensed at each entry and how the trade turned out (npm run brain).
// topDown: false replays the desk without the top-down read (its trades against the bias too).
// ownWay: as on the floor by default, the desk trades its own way (no committee, no cost
// stretching, the neural brain has no say); false puts the floor's outside layers back.
export function replay({ profile, bars, committee = 'on', warmup = 600, brainOptions = {}, neural = null, topDown = true, ownWay = true }) {
  const symbol = profile.symbols[0];
  const clock = { mode: 'live', speed: 1, t: bars[0].time * 1000, now() { return this.t; } };
  const md = new MarketData(clock);
  const session = new Session(clock);
  const broker = new Broker(md, clock);
  const risk = new RiskManager(config.risk, session);
  const env = { md, clock, session, broker, risk, news: null, lab: null, committee: null, allocation: config.startingCapital / ROSTER.length, emit: () => {}, ownWay: () => ownWay };
  // The market's top-down read, built from the bars as they are played (as on the floor, where
  // the research store's months of history seed it).
  const book = new TopDownBook(symbol);
  env.topDown = topDown ? (sym) => (sym === symbol ? book : null) : null;
  const agent = new profile.Strategy(profile, env);
  // The desk's department reviews its ideas, as on the floor.
  const agents = new Map([[agent.id, agent]]);
  for (const id of departmentFor(symbol)?.members || []) {
    const p = ROSTER.find((r) => r.id === id);
    if (p && id !== agent.id) agents.set(id, { id, profile: p, symbols: p.symbols, lifetime: {}, setup: {} });
  }
  // On the floor the market brain reads days of history (the research store), not just the 15
  // hours the live feed keeps; the replay gives it the same, up to the bar being played.
  let cursor = 0;
  const history = { ready: true, recent: (sym, n) => (sym === symbol ? bars.slice(Math.max(0, cursor - n), cursor) : []) };
  env.marketBrain = new MarketBrain({ md, session, clock, history, ...brainOptions });
  if (committee !== 'off') {
    env.committee = new Committee({ brain: env.marketBrain, agents, clock, shadow: committee === 'shadow' });
  }
  if (neural) env.neural = neural(agent, env);
  const debates = [];
  env.committee?.on('debate', (d) => { if (d.proposer === agent.id) debates.push(d); });
  // Every closed trade, as it closes: the broker's own book only keeps the latest 400, and a
  // long history has more.
  const closed = [];
  broker.on('trade', (t) => {
    if (t.agentId === agent.id) closed.push(t);
    agent.onTradeClosed(t);
  });
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
  for (const b of bars.slice(0, n0)) book.feed(b);
  let day = session.tradingDay(bars[n0]?.time * 1000);

  md.on('bar', (id, bar) => { if (id === symbol) book.feed(bar); });
  md.on('tick', (id, px) => agent.onTick(id, px));
  md.on('bar', (id, bar) => agent.onBar(id, bar));

  for (let i = n0; i < bars.length; i++) {
    cursor = i; // bars before this one are closed
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

  const trades = closed.filter((t) => t.r != null);
  // A day trader's funnel: days, sweeps, shifts and why they didn't trade (engine/daytrade.js).
  return { agent, trades, entries, debates, funnel: agent.pb?.stats ?? null, notes: agent.allNotes };
}

