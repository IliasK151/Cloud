import { test } from 'node:test';
import assert from 'node:assert/strict';
import { DeskLearner } from '../server/engine/learning.js';
import { nyWallToMs } from '../server/market/session.js';
import { runBacktest } from '../scripts/backtest.js';

// A minimal desk the learner can observe.
function fakeDesk() {
  let now = nyWallToMs(2026, 7, 1, 10, 0);
  const agent = {
    profile: {},
    env: { clock: { now: () => now } },
    bars: () => [],
    setup: { confidence: 60 },
    day: { entries: 0 },
  };
  const learner = new DeskLearner(agent);
  let id = 0;
  return {
    learner,
    at(day, hour, minute = 0) { now = nyWallToMs(2026, 7, day, hour, minute); },
    // Take a trade (if the learner lets us) and close it with the given outcome.
    trade({ r, mfe = Math.max(0, r), mae = r < 0 ? 1 : 0.2, exit = r < 0 ? 'Stop loss' : 'Target hit' }) {
      const info = learner.beforeEntry({ symbol: 'XAUUSD', side: 'LONG', entry: 100, stop: 99, target: 102, partialAt: 1, trail: 2 });
      if (info.skip) return { skipped: true, info };
      const plan = { symbol: 'XAUUSD', side: 'LONG', entry: 100, risk: 1, target: 102, extreme: 100 + mfe, worst: 100 - mae, barsHeld: 6 };
      learner.onOpened(++id, info, plan);
      const lessons = learner.onClosed({ id, r, pnl: r * 1000, exitReason: exit });
      return { skipped: false, info, lessons };
    },
  };
}

test('a desk learns to sit out a situation that keeps losing, and says so', () => {
  const d = fakeDesk();
  let lessons = [];
  for (let i = 0; i < 40; i++) {
    d.at(1 + Math.floor(i / 2), i % 2 ? 15 : 10); // alternate the NY afternoon and the NY open
    const res = d.trade({ r: i % 2 ? -1 : 0.8 });
    lessons.push(...(res.lessons || []));
  }
  assert.ok(d.learner.state.avoid['session:ny-late'], 'the losing afternoon should be sat out');
  assert.ok(!d.learner.state.avoid['session:ny-open'], 'the winning open must not be sat out');
  const lesson = lessons.find((l) => l.key === 'avoid:session:ny-late');
  assert.match(lesson.text, /New York afternoon/);
  // Afternoon signals are now skipped, apart from an occasional small probe.
  d.at(30, 15);
  const next = d.trade({ r: -1 });
  assert.equal(next.skipped, true);
  assert.match(next.info.reason, /sit out the New York afternoon/);
  // Morning trades carry on, sized up a little for the proven edge.
  d.at(30, 10);
  const morning = d.learner.beforeEntry({ symbol: 'XAUUSD', side: 'LONG', entry: 100, stop: 99, target: 102, partialAt: 1, trail: 2 });
  assert.equal(morning.skip, false);
  assert.ok(morning.sizeMult > 1 && morning.sizeMult <= 1.25, `size ${morning.sizeMult}`);
});

test('giving back winners leads to earlier profit-taking, and a change that hurts is rolled back', () => {
  const d = fakeDesk();
  // Many trades run to +1.3R and then close red.
  for (let i = 0; i < 20; i++) {
    d.at(1 + i, 10);
    d.trade(i % 3 === 0 ? { r: 1.5, mfe: 1.8 } : { r: -0.3, mfe: 1.3, mae: 0.6, exit: 'Trailing stop' });
  }
  const p = d.learner.state.params;
  assert.ok(p.partialMult < 1, `partial profits should come sooner (${p.partialMult})`);
  const change = d.learner.state.lessons.find((l) => l.key === 'param:giveback');
  assert.equal(change.status, 'active');
  const info = d.learner.beforeEntry({ symbol: 'XAUUSD', side: 'LONG', entry: 100, stop: 99, target: 102, partialAt: 1, trail: 2 });
  assert.ok(info.partialAt < 1 && info.trail < 2);
  // Results get clearly worse after the change → it is undone at review.
  for (let i = 0; i < 20; i++) {
    d.at(25 + i, 10);
    d.trade({ r: -0.9, mfe: 0.1 });
  }
  const reviewed = d.learner.state.lessons.find((l) => l.key === 'param:giveback');
  assert.equal(reviewed.status, 'reverted');
  assert.ok(d.learner.state.lessons.some((l) => l.key === 'revert:param:giveback'));
});

test('learning is bounded, ignores TradingView alerts and survives a restart', () => {
  const d = fakeDesk();
  for (let i = 0; i < 60; i++) {
    d.at(1 + i, 12);
    d.trade({ r: -1, mfe: 0.1 });
  }
  const info = d.learner.beforeEntry({ symbol: 'XAUUSD', side: 'LONG', entry: 100, stop: 99, target: 102, partialAt: 1, trail: 2 });
  assert.ok(info.sizeMult >= 0.5 && info.sizeMult <= 1.25);
  const p = d.learner.state.params;
  assert.ok(p.stopMult >= 0.75 && p.stopMult <= 1.6 && p.targetMult >= 0.7 && p.partialMult >= 0.6);
  // The boss's own alerts are never skipped or resized.
  const tv = d.learner.beforeEntry({ symbol: 'XAUUSD', side: 'LONG', entry: 100, stop: 99, target: 102, partialAt: 1, trail: 2, external: true });
  assert.deepEqual([tv.skip, tv.sizeMult, tv.stop, tv.target], [false, 1, 99, 102]);
  // Round-trip through the saved state.
  const saved = JSON.parse(JSON.stringify(d.learner.serialize()));
  const again = fakeDesk();
  again.learner.restore(saved);
  assert.deepEqual(again.learner.view().params, d.learner.view().params);
  assert.equal(again.learner.state.studied, 60);
});

test('learning runs inside a simulated multi-day session without errors', () => {
  const fund = runBacktest({ sessions: 4, seed: 5, quiet: true });
  for (const a of fund.agents) {
    assert.ok(!a.log.some((l) => l.kind === 'error'), `${a.id} logged an error`);
    const v = a.learner.view();
    if (a.profile.learning === false) assert.equal(v.studied, 0);
    else assert.ok(v.studied > 0 || a.lifetime.trades === 0, `${a.id} studied its trades`);
    for (const f of v.features) assert.ok(f.effect >= 0.7 && f.effect <= 1.15);
  }
  const saved = fund.serialize();
  assert.ok(saved.agents.amara.learning.version >= 1);
});
