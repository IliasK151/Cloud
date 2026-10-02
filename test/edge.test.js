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

// ---- the nightly review ---------------------------------------------------------------------------
import { EdgeReview, REVIEW, reviewText, VERDICT_EFFECT, validReport } from '../server/live/review.js';
import { tradingDaysOf } from '../scripts/edge-report.js';

function historyDir() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'review-'));
  const hist = path.join(dir, 'history');
  fs.mkdirSync(hist);
  const bars = [];
  let p = 1.34;
  const t0 = Date.UTC(2026, 8, 28) / 1000;
  for (let i = 0; i < 2 * 1440; i++) {
    const o = p;
    p += Math.sin(i / 37) * 0.00004 + ((i * 7919) % 13 - 6) * 0.000004;
    bars.push([t0 + i * 60, o, Math.max(o, p) + 0.00006, Math.min(o, p) - 0.00006, p, 1]);
  }
  fs.writeFileSync(path.join(hist, 'GBPUSD.json'), JSON.stringify({ v: 2, level: 'mt5', bars }));
  return { dir, hist };
}

const quiet = { info() {}, warn() {} };

test('the nightly review runs after the New York close or at the weekend, at most once a day', () => {
  const { dir } = historyDir();
  let t = Date.UTC(2026, 9, 1, 16, 0); // Thursday 12:00 New York
  const rv = new EdgeReview({ dataDir: dir, log: quiet, now: () => t });
  assert.equal(rv.isDue(), false, 'the first review waits for the floor to have run a while');
  t += REVIEW.firstAfterMs;
  assert.equal(rv.isDue(), true, 'then the first one runs straight away');
  rv.report = { at: t, desks: [] };
  t += 3_600_000;
  assert.equal(rv.isDue(), false, 'not again the same day');
  t = Date.UTC(2026, 9, 2, 16, 30); // Friday 12:30 New York: a day later, but the market is open
  assert.equal(rv.isDue(), false);
  t = Date.UTC(2026, 9, 2, 21, 10); // Friday 17:10 New York: after the close
  assert.equal(rv.isDue(), true);
  rv.report = { at: Date.UTC(2026, 9, 2, 21, 10), desks: [] };
  t = Date.UTC(2026, 9, 3, 20, 0); // Saturday, 23 h later
  assert.equal(rv.isDue(), true, 'at the weekend any time');
  // An old review is flagged, but its verdicts keep deciding: a desk taken off the account
  // doesn't drift back just because the reviews stopped.
  rv.report = { at: t - REVIEW.freshMs - 1, desks: [{ id: 'jake', n: 30, avgR: -0.2, verdict: 'no edge' }] };
  assert.equal(rv.current(), null, 'not fresh');
  assert.equal(rv.verdictFor('jake').verdict, 'no edge');
  // No saved history: nothing to review.
  const empty = new EdgeReview({ dataDir: fs.mkdtempSync(path.join(os.tmpdir(), 'review-')), log: quiet, now: () => t });
  assert.equal(empty.isDue(), false);
  assert.match(empty.run().error, /No saved market history yet/);
});

test('a review runs in a worker thread, is saved, and its summary reads well on the phone', async () => {
  const { dir } = historyDir();
  const rv = new EdgeReview({ dataDir: dir, log: quiet, settings: () => ({ program: '1-step', size: 10_000, riskPct: 0.5 }) });
  const done = new Promise((resolve) => rv.once('report', resolve));
  assert.equal(rv.run('asked').ok, true);
  assert.equal(rv.run('asked').ok, false, 'one at a time');
  assert.ok(rv.view().running);
  const rep = await done;
  assert.equal(rv.view().running, null);
  assert.ok(rep.desks.some((d) => d.id === 'jake'), 'Jake was replayed on his GBPUSD');
  assert.ok(rep.desks.find((d) => d.id === 'amara').verdict === 'no saved history');
  assert.ok(fs.existsSync(path.join(dir, 'edge-report.json')), 'saved for the next start');
  const again = new EdgeReview({ dataDir: dir, log: quiet });
  assert.equal(again.report.at, rep.at);
  // The phone summary.
  const text = reviewText({
    tradingDays: 18, program: '1-step',
    desks: [
      { name: 'Nico Rossi', verdict: 'EDGE', avgR: 0.42, n: 31 },
      { name: 'Mia Torres', verdict: 'promising', avgR: 0.2, n: 18 },
      { name: 'Marcus Reid', verdict: 'no edge', avgR: -0.56, n: 21 },
      { name: 'Amara Okafor', verdict: 'unclear', avgR: 0.03, n: 40 },
    ],
    withEdge: { rows: [{ riskPct: 0.5, passed: 0.71 }, { riskPct: 0.75, passed: 0.74 }], best: { riskPct: 0.75, passed: 0.74 } },
  }, { riskPct: 0.5 });
  assert.match(text, /replayed on 18 trading days of your prices/);
  assert.match(text, /✅ Edge: Nico \+0\.42R \(31 trades\), Mia \+0\.20R \(18 trades, not proven yet\)/);
  assert.match(text, /⛔ No edge, paper only: Marcus −0\.56R/);
  assert.match(text, /➗ Unclear, half size: Amara \+0\.03R/);
  assert.match(text, /🎯 FTMO 1-step odds: 71% at your 0\.5% risk · best 74% at 0\.75%/);
  assert.match(text, /Verdict: the desks with an edge pass most simulated challenges/);
  // Sizes that all fail have no "best" (one lucky pass in 4,000 isn't advice).
  const losing = reviewText({ tradingDays: 5, program: '1-step', desks: [], withEdge: null, everyone: { rows: [{ riskPct: 0.5, passed: 0 }, { riskPct: 1.5, passed: 0.00025 }], best: { riskPct: 1.5, passed: 0.00025 } } }, { riskPct: 0.5 });
  assert.match(losing, /odds \(every desk\): 0% at your 0\.5% risk · under 1% at every risk size/);
  assert.deepEqual(Object.keys(VERDICT_EFFECT).sort(), ['EDGE', 'no edge', 'promising', 'unclear']);
});

test('a failed review isn\'t retried every minute, a vanished worker isn\'t "running", and shutdown stops it', async () => {
  const { dir } = historyDir();
  let t = Date.UTC(2026, 9, 3, 18, 0); // Saturday: any time is a review window
  const failures = [];
  // A worker that dies without a word.
  class DyingWorker {
    constructor() { this.h = {}; }
    on(ev, fn) { this.h[ev] = fn; return this; }
    postMessage() { setImmediate(() => this.h.exit?.(1)); }
    terminate() { return Promise.resolve(); }
  }
  const rv = new EdgeReview({ dataDir: dir, log: quiet, now: () => t, WorkerImpl: DyingWorker });
  rv.on('failed', (f) => failures.push(f));
  t += REVIEW.firstAfterMs;
  rv.tick();
  assert.ok(rv.running, 'started');
  await new Promise((r) => setImmediate(r));
  assert.equal(rv.running, null, 'not left "running" after the worker vanished');
  assert.match(rv.lastError.text, /stopped unexpectedly \(exit code 1\)/);
  assert.deepEqual(failures.map((f) => f.reason), ['nightly']);
  assert.equal(rv.view().retryAt, t + REVIEW.retryMs, 'the FTMO tab says when it tries again');
  // The next minute: no new attempt, not for half an hour.
  t += 60_000;
  assert.equal(rv.isDue(), false);
  t += REVIEW.retryMs;
  assert.equal(rv.isDue(), true);
  // You can always ask for one.
  assert.equal(rv.run('asked').ok, true);
  await new Promise((r) => setImmediate(r));
  // Failing again: the floor waits twice as long (a review that keeps failing mustn't keep a
  // core busy all day), and says so.
  assert.equal(rv.failures, 2);
  assert.equal(failures.at(-1).retryInMs, 2 * REVIEW.retryMs);
  t += REVIEW.retryMs;
  assert.equal(rv.isDue(), false);
  t += REVIEW.retryMs;
  assert.equal(rv.isDue(), true);
  for (let i = 0; i < 10; i++) rv.failures++;
  assert.equal(rv.retryInMs(), REVIEW.retryMaxMs, 'never more than a few hours apart');

  // A nightly review that times out at 17:45 New York is retried that evening, not tomorrow.
  t = Date.UTC(2026, 9, 6, 21, 0); // Tuesday 17:00 New York
  const rv3 = new EdgeReview({ dataDir: dir, log: quiet, now: () => t, WorkerImpl: DyingWorker });
  rv3.report = { at: t - 24 * 3_600_000, desks: [] };
  assert.equal(rv3.isDue(), true, 'in the window');
  rv3.tick();
  await new Promise((r) => setImmediate(r));
  assert.ok(rv3.lastError);
  t += 45 * 60_000; // 17:45: the failure; 18:15 is outside the window
  rv3.failedAt = t;
  t += REVIEW.retryMs;
  assert.equal(rv3.isDue(), true, 'retried at 18:15 although the window has closed');
  // Without a failure, a due review still waits for the window.
  rv3.failedAt = null;
  rv3.failures = 0;
  assert.equal(rv3.isDue(), false);
  // Shutting down stops a review in progress.
  class HangingWorker {
    constructor() { this.terminated = false; HangingWorker.last = this; }
    on() { return this; }
    postMessage() {}
    terminate() { this.terminated = true; return Promise.resolve(); }
  }
  const rv2 = new EdgeReview({ dataDir: dir, log: quiet, WorkerImpl: HangingWorker });
  rv2.run('asked');
  rv2.stop();
  assert.equal(HangingWorker.last.terminated, true);
  assert.equal(rv2.running, null);
});

test('a review written by npm run edge reaches the running floor; a broken file is ignored', () => {
  const { dir } = historyDir();
  const file = path.join(dir, 'edge-report.json');
  const rv = new EdgeReview({ dataDir: dir, log: quiet });
  assert.equal(rv.report, null);
  const good = { at: Date.now(), program: '1-step', size: 10_000, tradingDays: 12, desks: [{ id: 'nico', name: 'Nico Rossi', desk: 'Scalping', symbol: 'NAS100', n: 30, avgR: 0.4, verdict: 'EDGE' }], withEdge: null, everyone: null };
  fs.writeFileSync(file, JSON.stringify(good));
  rv.tick();
  assert.equal(rv.verdictFor('nico').verdict, 'EDGE', 'picked up within a tick');
  // Half-written, or the wrong shape: the floor keeps the review it has and the FTMO tab works.
  fs.writeFileSync(file, '{"at": 1, "desks": [');
  fs.utimesSync(file, new Date(), new Date(Date.now() + 5000));
  rv.tick();
  assert.equal(rv.verdictFor('nico').verdict, 'EDGE');
  fs.writeFileSync(file, JSON.stringify({ at: Date.now() + 1, desks: 'everyone' }));
  fs.utimesSync(file, new Date(), new Date(Date.now() + 10_000));
  rv.tick();
  assert.equal(rv.verdictFor('nico').verdict, 'EDGE');
  assert.equal(validReport({ at: 1, desks: [{ id: 'x', name: 'X', verdict: 'EDGE' }] }), false, 'a verdict needs its numbers');
  assert.equal(validReport(good), true);
  // The browser only ever gets numbers for the odds.
  rv.report = { ...good, withEdge: { trades: 5, avgR: 0.2, tradesPerDay: 2, rows: [{ riskPct: '0.5" onclick="x', passed: 0.5 }, { riskPct: 0.5, passed: 0.7 }], best: { riskPct: 0.5, passed: 0.7 } } };
  const v = rv.view();
  assert.deepEqual(v.report.withEdge.rows.map((r) => r.riskPct), [0.5]);
  // A "best" risk that isn't a number never becomes a "Use 0% risk" button.
  rv.report.withEdge.best = { riskPct: 'lots', passed: 0.9 };
  assert.equal(rv.view().report.withEdge.best, null);
});

test('one unreadable history file doesn\'t sink the review, and each market counts its own trading days', () => {
  const { dir, hist } = historyDir();
  fs.writeFileSync(path.join(hist, 'XAUUSD.json'), '{ not json');
  const rep = edgeReport({ dir: hist, seeds: 1 });
  assert.equal(rep.desks.find((d) => d.id === 'amara').verdict, 'history file unreadable');
  assert.ok(rep.desks.find((d) => d.id === 'jake').verdict !== 'history file unreadable', 'Jake was still replayed');
  // Two full days and a few stray bars on a third: two trading days.
  const t0 = Date.UTC(2026, 8, 28) / 1000;
  const bars = [...Array(2 * 1440).keys()].map((i) => ({ time: t0 + i * 60 })).concat([{ time: t0 + 3 * 86_400 }, { time: t0 + 3 * 86_400 + 60 }]);
  assert.equal(tradingDaysOf(bars), 2);
  assert.equal(tradingDaysOf([]), 1);
});
