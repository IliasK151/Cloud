import path from 'node:path';
import { Worker } from 'node:worker_threads';
import { EventEmitter } from 'node:events';
import { fileURLToPath } from 'node:url';
import { SYMBOLS } from '../market/symbols.js';
import { hashString } from '../util/random.js';
import { research } from './search.js';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const JOB_TIMEOUT_MS = 180_000;

// The research lab: a queue of research jobs (one desk × one market each) run one at a
// time in a worker thread. Desks ask for research; the lab reports progress and results.
export class ResearchLab extends EventEmitter {
  constructor({ history, calendar = null, mode = 'live', log = console, inline = false, WorkerImpl = Worker }) {
    super();
    this.history = history;
    this.calendar = calendar;
    this.mode = mode;
    this.log = log;
    this.inline = inline;
    this.WorkerImpl = WorkerImpl;
    this.queue = [];
    this.running = null;
    this.worker = null;
    this.seq = 0;
    this.completed = 0;
  }

  isBusy(agentId) {
    return this.running?.agentId === agentId || this.queue.some((j) => j.agentId === agentId);
  }

  request(agentId, symbol, { reason = '', budget = 360 } = {}) {
    if (this.running?.agentId === agentId && this.running.symbol === symbol) return false;
    if (this.queue.some((j) => j.agentId === agentId && j.symbol === symbol)) return false;
    this.queue.push({ id: ++this.seq, agentId, symbol, reason, budget, queuedAt: Date.now() });
    setImmediate(() => this.#pump());
    return true;
  }

  cancel(agentId) {
    this.queue = this.queue.filter((j) => j.agentId !== agentId);
  }

  #payload(job) {
    const bars = this.history.bars(job.symbol);
    const from = bars.length ? bars[0].time * 1000 : 0;
    const to = bars.length ? bars[bars.length - 1].time * 1000 + 60_000 : 0;
    const windows = this.calendar && bars.length ? this.calendar.windows(job.symbol, from, to) : [];
    const mode = this.mode === 'sim' ? 'sim' : 'live';
    return {
      id: job.id, symbol: job.symbol, bars, mode, windows,
      spreadBps: SYMBOLS[job.symbol].spreadBps, budget: job.budget,
      seed: hashString(`${job.agentId}-${job.symbol}-${job.id}-${bars.length}`),
    };
  }

  #pump() {
    if (this.running || !this.queue.length || !this.history.ready) return;
    const job = this.queue.shift();
    this.running = { ...job, stage: 'Loading history', done: 0, total: 1, startedAt: Date.now() };
    this.emit('progress', this.#progressView());
    let payload;
    try {
      payload = this.#payload(job);
    } catch (err) {
      return this.#finish(job, null, err.message);
    }
    if (this.inline) {
      setImmediate(() => {
        try {
          const result = research({ ...payload, onProgress: (p) => this.#progress(job.id, p) });
          this.#finish(job, result);
        } catch (err) {
          this.#finish(job, null, err.message);
        }
      });
      return;
    }
    const w = this.#ensureWorker();
    this.timer = setTimeout(() => {
      this.log.warn?.(`[research] ${job.agentId}/${job.symbol} took too long; restarting the research worker`);
      this.worker?.terminate();
      this.worker = null;
      this.#finish(job, null, 'Research took too long');
    }, JOB_TIMEOUT_MS);
    w.postMessage(payload);
  }

  #ensureWorker() {
    if (this.worker) return this.worker;
    const w = new this.WorkerImpl(path.join(HERE, 'worker.js'));
    w.on('message', (m) => {
      if (!this.running || m.id !== this.running.id) return;
      if (m.type === 'progress') this.#progress(m.id, m);
      else if (m.type === 'result') this.#finish(this.running, m.result);
      else if (m.type === 'error') this.#finish(this.running, null, m.message);
    });
    w.on('error', (err) => {
      this.log.warn?.(`[research] worker crashed: ${err.message}`);
      if (this.worker === w) this.worker = null;
      if (this.running) this.#finish(this.running, null, `Research worker crashed: ${err.message}`);
    });
    w.unref?.();
    this.worker = w;
    return w;
  }

  #progress(id, p) {
    if (!this.running || this.running.id !== id) return;
    Object.assign(this.running, { stage: p.stage, done: p.done, total: p.total });
    this.emit('progress', this.#progressView());
  }

  #progressView() {
    const r = this.running;
    return r ? { agentId: r.agentId, symbol: r.symbol, stage: r.stage, done: r.done, total: r.total } : null;
  }

  #finish(job, result, error = null) {
    clearTimeout(this.timer);
    this.running = null;
    this.completed++;
    if (error) this.log.warn?.(`[research] ${job.agentId}/${job.symbol}: ${error.split('\n')[0]}`);
    this.emit('result', { agentId: job.agentId, symbol: job.symbol, reason: job.reason, result, error });
    setImmediate(() => this.#pump());
  }

  // Called when history finishes loading.
  start() {
    this.#pump();
  }

  view() {
    return {
      running: this.#progressView(),
      queue: this.queue.map((j) => ({ agentId: j.agentId, symbol: j.symbol })),
      ready: !!this.history.ready,
      completed: this.completed,
    };
  }

  stop() {
    clearTimeout(this.timer);
    this.worker?.terminate();
    this.worker = null;
  }
}
