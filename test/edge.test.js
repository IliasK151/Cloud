import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { simulateChallenge, riskSweep } from '../server/live/challengeSim.js';
import { judge, bootstrapCI, edgeReport, MIN_TRADES } from '../scripts/edge-report.js';

const alternating = (win, loss, n = 100, winEvery = 2) => Array.from({ length: n }, (_, i) => (i % winEvery === 0 ? win : loss));

test('the challenge simulator: a real edge passes, no edge mostly fails, and over-sizing fails 1-Step\'s 3% day', () => {
  const edge = alternating(1.9, -1.1); // +0.4R a trade
  const none = alternating(1, -1); // 0R a trade
  const sw = riskSweep({ samples: edge, tradesPerDay: 3, program: '1-step', runs: 1500 });
  assert.ok(sw.rows.find((r) => r.riskPct === 0.5).passed > 0.9, 'an edge at 0.5% passes almost always');
  assert.ok(sw.rows.find((r) => r.riskPct === 1.5).failed > 0.5, 'at 1.5% a trade the 3% daily limit fails it');
  assert.equal(sw.best.riskPct <= 0.75, true);
  const flat = riskSweep({ samples: none, tradesPerDay: 3, program: '1-step', runs: 1500 });
  assert.ok(flat.best.passed < 0.35, `no edge: ${flat.best.passed}`);
  // Losing trades never pass.
  assert.equal(simulateChallenge({ samples: [-1], tradesPerDay: 3, riskPct: 0.5, runs: 200 }).passed, 0);
  // 2-Step needs 4 trading days, even when the target comes on the first.
  const quick = simulateChallenge({ samples: [3], tradesPerDay: 20, riskPct: 1, program: '2-step', runs: 50 });
  assert.equal(quick.passed, 1);
  assert.equal(quick.medianDays, 4);
  // 1-Step: one huge day doesn't pass until the Best Day rule is met.
  const oneStep = simulateChallenge({ samples: [3], tradesPerDay: 20, riskPct: 1, program: '1-step', runs: 50 });
  assert.equal(oneStep.passed, 1);
  assert.ok(oneStep.medianDays >= 2, `${oneStep.medianDays}`);
  // Nothing to simulate.
  assert.equal(simulateChallenge({ samples: [], tradesPerDay: 3, riskPct: 0.5 }).passed, 0);
});

test('the edge report judges a desk only on enough trades, with a confidence range and both halves', () => {
  const t = (rs) => rs.map((r) => ({ r }));
  assert.equal(judge(t([1, -1, 1])).verdict, 'too few trades to tell');
  assert.equal(judge(t(alternating(2, -1, 60))).verdict, 'EDGE', '+0.5R a trade over 60 trades: clearly above zero');
  assert.equal(judge(t(alternating(1.5, -1, 40))).verdict, 'promising', '+0.25R over 40 trades could still be luck');
  assert.equal(judge(t(alternating(1, -1.2, 40))).verdict, 'no edge');
  const j = judge(t(alternating(2, -1, 60)));
  assert.ok(j.ci[0] > 0 && j.ci[1] > j.ci[0]);
  assert.equal(j.n, 60);
  assert.ok(Math.abs(j.winRate - 0.5) < 1e-9);
  assert.deepEqual(bootstrapCI([1, 2, 3]), bootstrapCI([1, 2, 3]), 'the same every run');
  assert.ok(MIN_TRADES >= 10);
});

test('npm run edge replays the desks on the saved history and says when there isn\'t any', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'edge-'));
  // Two quiet days of GBPUSD minutes for Jake: enough to run, too few trades to judge.
  const bars = [];
  let p = 1.34;
  const t0 = Date.UTC(2026, 8, 28) / 1000;
  for (let i = 0; i < 2 * 1440; i++) {
    const o = p;
    p += Math.sin(i / 37) * 0.00004 + ((i * 7919) % 13 - 6) * 0.000004;
    bars.push([t0 + i * 60, o, Math.max(o, p) + 0.00006, Math.min(o, p) - 0.00006, p, 1]);
  }
  fs.writeFileSync(path.join(dir, 'GBPUSD.json'), JSON.stringify({ v: 2, level: 'mt5', bars }));
  const rep = edgeReport({ dir, deskId: 'jake', seeds: 1, program: '1-step' });
  assert.equal(rep.desks.length, 1);
  assert.equal(rep.desks[0].id, 'jake');
  assert.ok(['too few trades to tell', 'no edge', 'unclear', 'promising', 'EDGE'].includes(rep.desks[0].verdict));
  const none = edgeReport({ dir, deskId: 'amara', seeds: 1 });
  assert.equal(none.desks[0].verdict, 'no saved history');
  assert.equal(none.withEdge, null);
});
