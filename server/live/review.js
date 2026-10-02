import fs from 'node:fs';
import path from 'node:path';
import { EventEmitter } from 'node:events';
import { Worker } from 'node:worker_threads';
import { fileURLToPath } from 'node:url';
import { nyParts } from '../market/session.js';
import { edgeReport } from '../../scripts/edge-report.js';

// The nightly review: the floor checks its own desks against your market every day.
//
// After the New York close (17:00, when the desks are flat for the daily roll-over), or at
// the weekend, it replays every trading desk on the real 1-minute bars it has saved (your
// MT5 broker's prices) through the floor's own code, with FTMO's costs, and plays out
// thousands of challenges with the desks that show an edge (scripts/edge-report.js). The
// result decides who trades the account (live/accountBrain.js): a desk with no edge on your
// prices stays on paper, an unproven one trades at half size. It runs in a worker thread so
// the floor keeps trading, and the summary goes to your phone.

const HERE = path.dirname(fileURLToPath(import.meta.url));

export const REVIEW = {
  everyMs: 22 * 3_600_000, // at most once a day
  freshMs: 4 * 86_400_000, // older than this, the floor warns that the reviews have stopped
  firstAfterMs: 10 * 60_000, // the very first review, once the floor has run a while
  retryMs: 30 * 60_000, // after a failed review, before the floor tries again by itself...
  retryMaxMs: 6 * 3_600_000, // ...doubling each time it fails again, up to this
  timeoutMs: 45 * 60_000,
  seeds: 2, // replays per desk (the paper broker's slippage is random)
};

const VERDICTS = new Set(['EDGE', 'promising', 'unclear', 'no edge']);

// A review read from disk (the floor's own, or one written by npm run edge) is only used if
// it has the shape the floor relies on: anything else (a half-written or hand-edited file) is
// ignored rather than allowed to break the FTMO tab or move money.
export function validReport(r) {
  if (!r || typeof r !== 'object' || !Number.isFinite(r.at) || !Array.isArray(r.desks)) return false;
  return r.desks.every((d) => d && typeof d.id === 'string' && typeof d.name === 'string' && typeof d.verdict === 'string'
    && (!VERDICTS.has(d.verdict) || (Number.isFinite(d.n) && Number.isFinite(d.avgR))));
}

// Desks the review judges (the floor's trading desks; the research lab tests its own).
export const VERDICT_EFFECT = {
  EDGE: { mult: 1, label: 'Full size' },
  promising: { mult: 1, label: 'Full size' },
  unclear: { mult: 0.5, label: 'Half size' },
  'no edge': { mult: 0, label: 'Paper only' },
};

const fr = (x) => (x == null ? '—' : `${x >= 0 ? '+' : '−'}${Math.abs(x).toFixed(2)}R`);
const pct = (x) => `${Math.round((x || 0) * 100)}%`;

// The review in a few lines, for the phone.
export function reviewText(rep, { riskPct = null } = {}) {
  if (!rep) return '';
  const by = (v) => rep.desks.filter((d) => d.verdict === v);
  const name = (d) => d.name.split(' ')[0];
  const lines = [`🔎 Nightly review: every desk replayed on ${rep.tradingDays} trading days of your prices`];
  const edge = [...by('EDGE'), ...by('promising')];
  lines.push(edge.length ? `✅ Edge: ${edge.map((d) => `${name(d)} ${fr(d.avgR)} (${d.n} trades${d.verdict === 'promising' ? ', not proven yet' : ''})`).join(', ')}` : '✅ Edge: no desk yet');
  const none = by('no edge');
  if (none.length) lines.push(`⛔ No edge, paper only: ${none.map((d) => `${name(d)} ${fr(d.avgR)}`).join(', ')}`);
  const unclear = by('unclear');
  if (unclear.length) lines.push(`➗ Unclear, half size: ${unclear.map((d) => `${name(d)} ${fr(d.avgR)}`).join(', ')}`);
  const sim = rep.withEdge || rep.everyone;
  if (sim?.best) {
    const mine = riskPct != null ? sim.rows.find((r) => Math.abs(r.riskPct - riskPct) < 1e-9) : null;
    const best = sim.best.passed >= 0.005 ? `best ${pct(sim.best.passed)} at ${sim.best.riskPct}%` : 'under 1% at every risk size';
    lines.push(`🎯 FTMO ${rep.program} odds${rep.withEdge ? '' : ' (every desk)'}: ${mine ? `${pct(mine.passed)} at your ${riskPct}% risk · ` : ''}${best}`);
  }
  lines.push(!rep.withEdge?.best
    ? 'Verdict: no proven edge yet. Keep training on the Free Trial.'
    : rep.withEdge.best.passed >= 0.6
      ? 'Verdict: the desks with an edge pass most simulated challenges. Confirm it on the Free Trial first.'
      : 'Verdict: not ready for a paid challenge yet.');
  return lines.join('\n');
}

// A challenge simulation for the browser: numbers only (the file may have been written by
// another program).
const num = (x) => (Number.isFinite(Number(x)) ? Number(x) : null);
function simView(sim) {
  if (!sim || !Array.isArray(sim.rows) || !sim.rows.length) return null;
  const row = (r) => ({ riskPct: num(r?.riskPct), passed: num(r?.passed) ?? 0, failed: num(r?.failed) ?? 0, open: num(r?.open) ?? 0, medianDays: num(r?.medianDays) });
  const rows = sim.rows.map(row).filter((r) => r.riskPct != null);
  const best = sim.best ? row(sim.best) : null;
  return rows.length ? { trades: num(sim.trades) ?? 0, avgR: num(sim.avgR), tradesPerDay: num(sim.tradesPerDay) ?? 0, rows, best: best?.riskPct != null ? best : null } : null;
}

export class EdgeReview extends EventEmitter {
  // settings(): the FTMO setup the challenge is simulated for ({ program, size, riskPct }).
  constructor({ dataDir, historyDir = dataDir ? path.join(dataDir, 'history') : null, log = console, now = () => Date.now(), WorkerImpl = Worker, inline = false, settings = () => ({}) }) {
    super();
    this.file = dataDir ? path.join(dataDir, 'edge-report.json') : null;
    this.historyDir = historyDir;
    this.log = log;
    this.now = now;
    this.WorkerImpl = WorkerImpl;
    this.inline = inline;
    this.settings = settings;
    this.startedAt = now();
    this.running = null;
    this.lastError = null;
    this.failedAt = null;
    this.failures = 0; // in a row
    this.seq = 0;
    this.report = null;
    this.loadedMtime = 0;
    this.#reload();
  }

  // The saved review: at start, and whenever the file changes (npm run edge while the floor
  // runs writes the same file, and takes effect within a minute).
  #reload() {
    if (!this.file) return false;
    let mtime;
    try {
      mtime = fs.statSync(this.file).mtimeMs;
    } catch {
      return false; // no review yet
    }
    if (mtime === this.loadedMtime) return false;
    let r;
    try {
      r = JSON.parse(fs.readFileSync(this.file, 'utf8'));
    } catch {
      return false; // being written right now: read again on the next tick
    }
    this.loadedMtime = mtime;
    if (!validReport(r)) {
      this.log.warn?.('[review] ignoring data/edge-report.json: it isn\'t a complete review');
      return false;
    }
    if (this.report && r.at <= this.report.at) return false;
    this.report = r;
    this.emit('change');
    return true;
  }

  // The latest review, if it's recent (the reviews are running as they should).
  current() {
    return this.report && this.now() - this.report.at <= REVIEW.freshMs ? this.report : null;
  }

  // A desk's verdict from the latest review, or null. The latest review keeps deciding until
  // a newer one replaces it: if the reviews stopped (the Mac asleep after the close, a broken
  // file), desks it took off the account mustn't drift back by themselves. An old review is
  // flagged in the FTMO tab and the rules list instead.
  verdictFor(agentId) {
    const d = this.report?.desks?.find((x) => x.id === agentId);
    return d && d.n ? d : null;
  }

  // After the New York close on a weekday (the desks are flat), or at the weekend.
  #windowOpen(now) {
    const p = nyParts(now);
    return p.weekday === 'Sat' || p.weekday === 'Sun' || p.hour === 17;
  }

  // How long the floor waits after a failed review before trying again by itself.
  retryInMs() {
    return Math.min(REVIEW.retryMs * 2 ** Math.max(0, this.failures - 1), REVIEW.retryMaxMs);
  }

  isDue(now = this.now()) {
    if (this.running || !this.#hasHistory()) return false;
    // A review that failed isn't retried every minute: the floor waits a while first, longer
    // each time it fails again (a review that keeps timing out mustn't keep a core busy all day).
    if (this.failedAt != null && now - this.failedAt < this.retryInMs()) return false;
    if (!this.report) return now - this.startedAt >= REVIEW.firstAfterMs;
    if (now - this.report.at < REVIEW.everyMs) return false;
    // The retry of a failed review doesn't wait for tomorrow's window: one that times out at
    // 17:45 would otherwise leave yesterday's verdicts in charge for another day.
    return this.failedAt != null || this.#windowOpen(now);
  }

  tick() {
    this.#reload();
    if (this.isDue()) this.run('nightly');
  }

  // The floor is shutting down: stop a review in progress (it runs again after the restart).
  stop() {
    clearTimeout(this.timer);
    this.timer = null;
    const w = this.worker;
    this.worker = null;
    this.running = null;
    if (w) w.terminate().catch?.(() => {});
  }

  #hasHistory() {
    try {
      return !!this.historyDir && fs.readdirSync(this.historyDir).some((f) => f.endsWith('.json'));
    } catch {
      return false;
    }
  }

  run(reason = 'asked') {
    if (this.running) return { ok: false, error: 'The review is already running' };
    if (!this.#hasHistory()) return { ok: false, error: 'No saved market history yet: the floor saves it every 15 minutes while it runs. Try again later.' };
    const s = this.settings() || {};
    const job = { id: ++this.seq, dir: this.historyDir, seeds: REVIEW.seeds, program: s.program === '2-step' ? '2-step' : '1-step', size: s.size || 10_000 };
    this.running = { id: job.id, reason, startedAt: this.now(), line: 'Starting', i: 0 };
    this.lastReason = reason;
    this.lastError = null;
    this.log.info?.(`[review] ${reason === 'nightly' ? 'Nightly review' : 'Review'} started: replaying every desk on the saved history`);
    this.emit('change');
    if (this.inline) {
      try {
        this.#finish(job.id, edgeReport({ ...job, log: (line) => this.#progress(job.id, line) }));
      } catch (err) {
        this.#finish(job.id, null, err.message);
      }
      return { ok: true };
    }
    let w;
    try {
      w = new this.WorkerImpl(path.join(HERE, 'reviewWorker.js'));
    } catch (err) {
      this.#finish(job.id, null, `could not start the review: ${err.message}`);
      return { ok: false, error: this.lastError };
    }
    this.worker = w;
    const timer = setTimeout(() => {
      w.terminate();
      this.#finish(job.id, null, 'took too long and was stopped');
    }, REVIEW.timeoutMs);
    timer.unref?.();
    this.timer = timer;
    w.on('message', (m) => {
      if (m?.id !== job.id) return;
      if (m.type === 'progress') this.#progress(job.id, m.line);
      else {
        clearTimeout(timer);
        w.terminate();
        if (m.type === 'result') this.#finish(job.id, m.report);
        else this.#finish(job.id, null, m.message);
      }
    });
    w.on('error', (err) => {
      clearTimeout(timer);
      this.#finish(job.id, null, `the review crashed: ${err.message}`);
    });
    // Gone without a word (killed, out of memory): not "running" for the next 45 minutes.
    w.on('exit', (code) => {
      clearTimeout(timer);
      this.#finish(job.id, null, `the review stopped unexpectedly (exit code ${code})`);
    });
    w.postMessage(job);
    return { ok: true };
  }

  #progress(id, line) {
    if (this.running?.id !== id) return;
    this.running.line = String(line || '').trim();
    this.running.i++;
    this.emit('change');
  }

  #finish(id, report, error = null) {
    if (this.running?.id !== id) return;
    const took = this.now() - this.running.startedAt;
    this.running = null;
    this.worker = null;
    clearTimeout(this.timer);
    this.timer = null;
    if (!error && report) {
      report.at = this.now();
      report.tookMs = took;
      if (!validReport(report)) error = 'the review came back incomplete';
    }
    if (error || !report) {
      this.lastError = { text: String(error || 'no result').split('\n')[0], at: this.now() };
      this.failedAt = this.now();
      this.failures++;
      this.log.warn?.(`[review] failed: ${this.lastError.text}`);
      this.emit('failed', { ...this.lastError, reason: this.lastReason, retryInMs: this.retryInMs() });
      this.emit('change');
      return;
    }
    this.failedAt = null;
    this.failures = 0;
    this.report = report;
    if (this.file) {
      try {
        fs.writeFileSync(`${this.file}.tmp`, JSON.stringify(report, null, 1));
        fs.renameSync(`${this.file}.tmp`, this.file);
        this.loadedMtime = fs.statSync(this.file).mtimeMs;
      } catch (err) {
        this.log.warn?.(`[review] could not save: ${err.message}`);
      }
    }
    this.log.info?.(`[review] done in ${Math.round(took / 1000)}s: ${report.desks.filter((d) => d.verdict === 'EDGE' || d.verdict === 'promising').length} desk(s) with an edge`);
    this.emit('report', report);
    this.emit('change');
  }

  // For the FTMO tab.
  view() {
    const rep = this.report;
    return {
      running: this.running ? { startedAt: this.running.startedAt, line: this.running.line, i: this.running.i, reason: this.running.reason } : null,
      lastError: this.lastError,
      // When the floor tries again by itself (only while a review is due).
      retryAt: this.failedAt != null && !this.running && (!this.report || this.now() - this.report.at >= REVIEW.everyMs) ? this.failedAt + this.retryInMs() : null,
      fresh: !!this.current(),
      report: rep ? {
        at: rep.at, program: rep.program === '2-step' ? '2-step' : '1-step',
        desks: rep.desks.map((d) => ({
          id: d.id, name: d.name, desk: String(d.desk ?? ''), symbol: String(d.symbol ?? ''), verdict: d.verdict,
          n: num(d.n) ?? 0, winRate: num(d.winRate), avgR: num(d.avgR),
          ci: Array.isArray(d.ci) && d.ci.length === 2 && d.ci.every((x) => num(x) != null) ? d.ci.map(Number) : null,
          halves: Array.isArray(d.halves) ? d.halves.map(num) : null,
        })),
        tradingDays: num(rep.tradingDays) ?? 0, size: num(rep.size), tookMs: num(rep.tookMs),
        withEdge: simView(rep.withEdge),
        everyone: simView(rep.everyone),
      } : null,
    };
  }
}
