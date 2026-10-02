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
  freshMs: 4 * 86_400_000, // an older review no longer moves money: the market has moved on
  firstAfterMs: 10 * 60_000, // the very first review, once the floor has run a while
  timeoutMs: 45 * 60_000,
  seeds: 2, // replays per desk (the paper broker's slippage is random)
};

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
    lines.push(`🎯 FTMO ${rep.program} odds${rep.withEdge ? '' : ' (every desk)'}: ${mine ? `${pct(mine.passed)} at your ${riskPct}% risk · ` : ''}best ${pct(sim.best.passed)} at ${sim.best.riskPct}%`);
  }
  lines.push(!rep.withEdge
    ? 'Verdict: no proven edge yet. Keep training on the Free Trial.'
    : rep.withEdge.best.passed >= 0.6
      ? 'Verdict: the desks with an edge pass most simulated challenges. Confirm it on the Free Trial first.'
      : 'Verdict: not ready for a paid challenge yet.');
  return lines.join('\n');
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
    this.seq = 0;
    this.report = null;
    try {
      const r = JSON.parse(fs.readFileSync(this.file, 'utf8'));
      if (r?.desks && Number.isFinite(r.at)) this.report = r;
    } catch { /* no review yet */ }
  }

  // The latest review, if it's recent enough to move money.
  current() {
    return this.report && this.now() - this.report.at <= REVIEW.freshMs ? this.report : null;
  }

  // A desk's verdict from the latest review, or null.
  verdictFor(agentId) {
    const d = this.current()?.desks?.find((x) => x.id === agentId);
    return d && d.n ? d : null;
  }

  // After the New York close on a weekday (the desks are flat), or at the weekend.
  #windowOpen(now) {
    const p = nyParts(now);
    return p.weekday === 'Sat' || p.weekday === 'Sun' || p.hour === 17;
  }

  isDue(now = this.now()) {
    if (this.running || !this.#hasHistory()) return false;
    if (!this.report) return now - this.startedAt >= REVIEW.firstAfterMs;
    return now - this.report.at >= REVIEW.everyMs && this.#windowOpen(now);
  }

  tick() {
    if (this.isDue()) this.run('nightly');
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
    w.on('message', (m) => {
      if (m.id !== job.id) return;
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
    if (error || !report) {
      this.lastError = { text: (error || 'no result').split('\n')[0], at: this.now() };
      this.log.warn?.(`[review] failed: ${this.lastError.text}`);
      this.emit('change');
      return;
    }
    report.at = this.now();
    report.tookMs = took;
    this.report = report;
    if (this.file) {
      try {
        fs.writeFileSync(`${this.file}.tmp`, JSON.stringify(report, null, 1));
        fs.renameSync(`${this.file}.tmp`, this.file);
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
      fresh: !!this.current(),
      report: rep ? {
        at: rep.at, tookMs: rep.tookMs ?? null, program: rep.program, size: rep.size, tradingDays: rep.tradingDays,
        desks: rep.desks.map((d) => ({ id: d.id, name: d.name, desk: d.desk, symbol: d.symbol, n: d.n, winRate: d.winRate ?? null, avgR: d.avgR ?? null, ci: d.ci ?? null, halves: d.halves ?? null, verdict: d.verdict })),
        withEdge: rep.withEdge ? { trades: rep.withEdge.trades, avgR: rep.withEdge.avgR, tradesPerDay: rep.withEdge.tradesPerDay, rows: rep.withEdge.rows, best: rep.withEdge.best } : null,
        everyone: rep.everyone ? { trades: rep.everyone.trades, avgR: rep.everyone.avgR, tradesPerDay: rep.everyone.tradesPerDay, rows: rep.everyone.rows, best: rep.everyone.best } : null,
      } : null,
    };
  }
}
