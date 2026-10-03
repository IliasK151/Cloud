import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { ROSTER } from '../server/engine/roster.js';
import { LiquidityScalp, KILLZONES } from '../server/engine/strategies/ajScalp.js';
import { MarketData } from '../server/market/marketData.js';
import { Session, nyWallToMs } from '../server/market/session.js';
import { resolveSymbol } from '../server/market/symbols.js';
import { SYMBOL_CURRENCIES } from '../server/market/calendar.js';
import { Broker } from '../server/engine/broker.js';
import { RiskManager } from '../server/engine/risk.js';
import { departmentFor } from '../server/brain/committee.js';
import { styleKey } from '../server/brain/personas.js';
import { GROUPS } from '../server/live/accountBrain.js';
import { autoMap } from '../server/live/symbolMap.js';
import { config } from '../server/config.js';

const SYM = 'GBPUSD';
const jake = ROSTER.find((p) => p.id === 'jake');

// A live-mode desk on a hand-built GBPUSD tape. `at(h, m)` is New York time on 14 Oct 2026.
function desk(profile = jake) {
  const clock = { mode: 'live', speed: 1, t: 0, now() { return this.t; } };
  const md = new MarketData(clock);
  const session = new Session(clock);
  const broker = new Broker(md, clock);
  const risk = new RiskManager(config.risk, session);
  const notes = [];
  const env = { md, clock, session, broker, risk, news: null, committee: null, allocation: 5_000_000, emit: (e) => notes.push(e) };
  const agent = new LiquidityScalp(profile, env);
  const bars = [];
  const sec = (h, m, day = 14) => Math.floor(nyWallToMs(2026, 10, day, h, m) / 1000);
  // Feed one closed 1-minute bar and let the desk evaluate it.
  const step = (b) => {
    bars.push(b);
    md.seed(SYM, bars);
    clock.t = (b.time + 60) * 1000;
    agent.onBar(SYM, b);
  };
  const bar = (time, o, h, l, c) => ({ time, open: o, high: h, low: l, close: c, volume: 100 });
  // Asia (19:00 the evening before → 02:00): a range between 1.34000 and 1.34400.
  for (let t = sec(18, 0, 13); t < sec(2, 0); t += 60) {
    const k = (t - sec(18, 0, 13)) / 60;
    const mid = 1.342 + 0.0017 * Math.sin(k / 23);
    let hi = mid + 0.00015;
    let lo = mid - 0.00015;
    if (k === 200) hi = 1.344;
    if (k === 300) lo = 1.34;
    bars.push(bar(t, mid - 0.00005, hi, lo, mid + 0.00005));
  }
  md.seed(SYM, bars);
  return { agent, md, clock, broker, bars, notes, step, bar, sec };
}

// Into the London killzone: a quiet opening range, then a run through the Asia low that
// closes back inside and engulfs the sweep candle.
function londonSweep(d) {
  const { step, bar, sec } = d;
  for (let m = 0; m < 30; m++) step(bar(sec(2, m), 1.3417, 1.3419 + (m === 5 ? 0.0006 : 0), 1.3415 - (m === 9 ? 0.0003 : 0), 1.3418));
  step(bar(sec(2, 30), 1.3412, 1.3413, 1.3401, 1.3403));
  step(bar(sec(2, 31), 1.3403, 1.3404, 1.3396, 1.3398)); // through the Asia low
  step(bar(sec(2, 32), 1.3398, 1.3399, 1.3394, 1.3397)); // the run's extreme
  step(bar(sec(2, 33), 1.3397, 1.3408, 1.3396, 1.3406)); // back inside, engulfs the sweep candle
}

test('the scalping desk: five AJ-style scalpers appended after the original fifteen', () => {
  const first = ['marcus', 'sofia', 'kenji', 'amara', 'viktor', 'isabella', 'james', 'priya', 'lucas', 'chen', 'elena', 'arjun', 'hannah', 'omar', 'mei'];
  // A desk's place in the roster is its MT5 magic number: the old desks keep theirs.
  assert.deepEqual(ROSTER.slice(0, 15).map((p) => p.id), first);
  const scalpers = ROSTER.slice(15);
  assert.equal(scalpers.length, 5);
  for (const p of scalpers) {
    assert.equal(p.Strategy, LiquidityScalp, p.id);
    assert.ok(p.scalper && KILLZONES[p.scalp.killzone], p.id);
    assert.equal(styleKey(p.id), 'scalper');
    assert.ok(departmentFor(p.symbols[0])?.members.includes(p.id), `${p.id} sits in its market's department`);
  }
  assert.deepEqual(scalpers.map((p) => p.symbols[0]), ['GBPUSD', 'EURUSD', 'XAUUSD', 'XAUUSD', 'NAS100']);
  // GBPUSD is a full market: TradingView, news, the FX department and group, MT5.
  assert.equal(resolveSymbol('FX:GBPUSD'), 'GBPUSD');
  assert.deepEqual(SYMBOL_CURRENCIES.GBPUSD, ['GBP', 'USD']);
  assert.equal(departmentFor('GBPUSD').id, 'fx');
  assert.equal(GROUPS.GBPUSD, 'FX');
  assert.equal(autoMap(['EURUSD', 'GBPUSD.r']).GBPUSD, 'GBPUSD.r');
});

test('a London run of the Asia low, trapped and shifted, is bought on the pullback with a tight stop', () => {
  const d = desk();
  londonSweep(d);
  const { agent } = d;
  assert.equal(agent.ctx.kz.active, true);
  const p = agent.pending;
  assert.ok(p, 'a pending pullback entry');
  assert.equal(p.side, 'LONG');
  assert.ok(p.stop < 1.3394, `stop below the run's extreme (${p.stop})`);
  assert.ok(Math.abs(p.entry - 1.34) < 1e-9, `entry at the middle of the move off the sweep (${p.entry})`);
  assert.ok(p.entry - p.stop <= 0.0010 + 1e-9, `stop within the 10-pip scalp stop (${((p.entry - p.stop) * 1e4).toFixed(1)} pips)`);
  assert.ok((p.target - p.entry) / (p.entry - p.stop) >= 2, 'target at least 2R');
  assert.match(p.reason, /London scalp: ran the Asia low/);
  assert.ok(agent.setup.checklist.every((c) => c.ok), JSON.stringify(agent.setup.checklist));

  // The pullback fills it; half comes off at 1R with the stop to breakeven.
  d.md.applyTick(SYM, p.entry, 1, d.clock.t);
  agent.onTick(SYM, p.entry);
  const plan = agent.plan;
  assert.ok(plan && !agent.pending);
  assert.equal(plan.partialAt, 1);
  assert.equal(plan.timeStopBars, 30);
  const oneR = plan.entry + plan.risk * 1.05;
  d.md.applyTick(SYM, oneR, 1, d.clock.t);
  agent.onTick(SYM, oneR);
  assert.equal(agent.plan.partialDone, true);
  assert.equal(agent.plan.stop, agent.plan.entry);
});

test('a scalp that turns into a hold is closed after 45 minutes', () => {
  const d = desk();
  londonSweep(d);
  const p = d.agent.pending;
  d.md.applyTick(SYM, p.entry, 1, d.clock.t);
  d.agent.onTick(SYM, p.entry);
  const plan = d.agent.plan;
  // Drifting at +0.6R: not enough for the 1R scale-out, enough to skip the 20-minute stop.
  const px = plan.entry + 0.6 * plan.risk;
  for (let m = 34; m < 34 + 46 && d.agent.position(SYM); m++) {
    const t = d.sec(2, 0) + m * 60;
    d.step(d.bar(t, px, px + 0.00002, px - 0.00002, px));
  }
  assert.equal(d.agent.position(SYM), null);
  const trade = d.broker.book('jake').trades.at(-1);
  assert.match(trade.exitReason, /Scalp time limit \(45 min\)/);
});

test('a pending entry is let go when price jumps through it, and nothing trades outside the killzone', () => {
  const d = desk();
  londonSweep(d);
  const p = d.agent.pending;
  const jump = p.entry - 0.6 * (p.entry - p.stop);
  d.md.applyTick(SYM, jump, 1, d.clock.t);
  d.agent.onTick(SYM, jump);
  assert.equal(d.agent.pending, null);
  assert.equal(d.agent.position(SYM), null);
  assert.ok(d.agent.log.some((l) => /jumped through the entry/.test(l.text)));

  // The same run at 02:30 New York is outside a New York desk's killzone (08:00–11:00).
  const ny = desk({ ...jake, id: 'ny', scalp: { killzone: 'newyork' } });
  londonSweep(ny);
  assert.equal(ny.agent.ctx.kz.active, false);
  assert.equal(ny.agent.pending, null);
  assert.equal(ny.agent.position(SYM), null);
  assert.match(ny.agent.setup.stage, /Waiting for the New York killzone/);
});

test('a run too deep for the scalp stop is skipped, not chased', () => {
  const d = desk();
  const { step, bar, sec } = d;
  for (let m = 0; m < 30; m++) step(bar(sec(2, m), 1.3417, 1.3419, 1.3415, 1.3418));
  step(bar(sec(2, 30), 1.3412, 1.3413, 1.3401, 1.3403));
  step(bar(sec(2, 31), 1.3403, 1.3404, 1.3360, 1.3365)); // 40 pips through the Asia low
  step(bar(sec(2, 32), 1.3365, 1.3368, 1.3355, 1.3366));
  step(bar(sec(2, 33), 1.3366, 1.3412, 1.3365, 1.3410));
  assert.equal(d.agent.pending, null);
  assert.equal(d.agent.position(SYM), null);
  assert.ok(d.agent.log.some((l) => /too deep for a scalp stop/.test(l.text)), d.agent.log.map((l) => l.text).join('\n'));
});

test('npm run scalp-test replays a scalper through the floor\'s own code on a run of 1-minute bars', async () => {
  const { replay, loadBars } = await import('../scripts/scalp-test.js');
  // The same London morning as above, as plain bars.
  const d = desk();
  londonSweep(d);
  const after = d.bars.at(-1).time;
  for (let m = 1; m <= 60; m++) d.bars.push(d.bar(after + m * 60, 1.3406, 1.3409, 1.3398, 1.3401));
  const file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'scalp-')), 'GBPUSD.json');
  fs.writeFileSync(file, JSON.stringify({ symbol: 'GBPUSD', bars: d.bars.map((b) => [b.time, b.open, b.high, b.low, b.close, 1]) }));
  const bars = loadBars(file);
  assert.equal(bars.length, d.bars.length);
  const res = replay({ profile: jake, bars, committee: 'off', warmup: 450 });
  assert.ok(res.funnel.sessions >= 1, 'saw the London killzone');
  assert.ok(res.funnel.swept >= 1, 'saw the run of the Asia low');
  assert.ok(res.entries.length >= 1, 'took the pullback entry');
  assert.equal(res.entries[0].side, 'LONG');
  assert.ok(res.trades.length >= 1, 'and closed it by the end');
});

test('more setups: each desk\'s entry rules come from its strategy, the roster tunes them, and a longer killzone runs an hour past the usual end', () => {
  const byId = (id) => ROSTER.find((p) => p.id === id);
  // The looser rules that passed on 22 months of real prices (README "More setups").
  assert.deepEqual(byId('marcus').rules, { minWidth: 1.0, maxWidth: 12, volume: 0 });
  assert.deepEqual(byId('james').rules, { band: 1.5, rsi: 12, maxAdx: 32 });
  assert.deepEqual(byId('priya').rules, { minBars: 4 });
  for (const id of ['jake', 'layla', 'ryan', 'mia']) assert.equal(byId(id).scalp.pools, 'all', id);
  assert.equal(byId('nico').scalp.pools, undefined, 'the one desk the account still takes: only what made it better');
  for (const id of ['ryan', 'mia', 'nico']) assert.equal(byId(id).rules.extend, 60, id);
  for (const id of ['jake', 'layla', 'amara', 'lucas']) assert.equal(byId(id).rules?.extend, undefined, id);
  assert.equal(byId('amara').rules, undefined, 'its looser rules made the trades worse');
  assert.equal(byId('lucas').rules, undefined);

  // A desk's rules: the strategy's own, with the roster's on top.
  const plain = desk();
  assert.deepEqual(plain.agent.rules, LiquidityScalp.RULES);
  const late = desk({ ...jake, id: 'late', rules: { extend: 60 } });
  assert.equal(late.agent.rules.extend, 60);
  assert.equal(late.agent.rules.perZone, LiquidityScalp.RULES.perZone);
  // 05:30 New York: London's killzone (02:00–05:00) is over, unless it runs an hour longer.
  for (const d of [plain, late]) {
    for (let m = 0; m <= 210; m++) d.step(d.bar(d.sec(2, 0) + m * 60, 1.3417, 1.3419, 1.3415, 1.3418));
  }
  assert.equal(plain.agent.ctx.kz.active, false);
  assert.equal(late.agent.ctx.kz.active, true);
  assert.match(late.agent.ctx.kz.local, /07:00–10:00 London, plus an hour/);
  assert.equal(plain.agent.ctx.kz.local, KILLZONES.london.local);
});
