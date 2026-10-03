import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';
import { EventEmitter } from 'node:events';
import { Worker } from 'node:worker_threads';
import { fileURLToPath } from 'node:url';
import { nyParts } from '../market/session.js';
import { senseTrade, toArray, FEATURES } from './features.js';
import { load, MODEL_VERSION } from './train.js';
import { auc } from './net.js';

// The floor's neural brain: one network every desk asks before it takes a trade, and that
// learns from how its trades turn out.
//
//   judge   a desk wants to trade: the brain senses the moment (neural/features.js), gives the
//           chance the trade ends in profit and the R it expects.
//   observe a trade closed: what the brain sensed and how it turned out becomes a new
//           example (real prices only, never simulated ones), and its calibration is updated.
//   retrain after the New York close (or when asked), in a worker: a challenger brain learns
//           from the long history plus the floor's own trades. It replaces the current brain
//           only if it judges the newest trades better than the current brain did, trades
//           neither of them learned from. Every version is kept in the history.
//
// The brain earns its say (skill()). Until it can tell winners from losers on trades it had
// not learned from, it is LEARNING: every idea still trades on paper as the desk wants, the
// brain only watches, judges and learns (and the desks trade all the time). Once its record
// on unseen trades shows real skill it is TRUSTED: below its bar a desk passes, except now and
// then (explore) on paper at small size, because a brain that only ever sees the trades it
// likes never learns whether the ones it passes on were really bad. It never puts a trade on
// the FTMO account that the account's own rules hold back; trusted, it only holds more back.
//
// It starts from the brain trained on long real history that ships with the floor
// (server/research/brain.json, `npm run brain`), and keeps what it learns in data/neural/.

const HERE = path.dirname(fileURLToPath(import.meta.url));
export const SHIPPED_BRAIN = path.join(HERE, '..', 'research', 'brain.json');
export const SHIPPED_EXAMPLES = path.join(HERE, '..', 'research', 'brain-examples.json.gz');

export const NEURAL = {
  bar: 0, // the expected R (after costs) a desk's idea needs for the brain to take it
  explore: 0.25, // trusted: share of the ideas it passes on that still trade, on paper only
  exploreSize: 0.25, // at this fraction of the desk's size
  thoughts: 40, // recent judgements kept for the Brain tab
  minNew: 30, // new real-price trades before the brain tries to learn from them
  holdout: 0.5, // newest share of the trades the current brain never learned from, kept back to judge a challenger
  ownWeight: 3, // the floor's own trades (your broker, this market) count 3× the long history
  // When it has earned a say, on trades it had not learned from: enough of them, a ranking
  // skill (AUC) well above a coin's 0.5, and picks clearly better than taking every trade.
  trust: { minN: 300, minAuc: 0.55, minPicks: 60, minLift: 0.05, window: 1000 },
  maxOwn: 20_000,
  everyMs: 20 * 3_600_000,
  retryMs: 2 * 3_600_000,
  timeoutMs: 30 * 60_000,
  versionsKept: 30,
};

const round = (x, d = 3) => (Number.isFinite(x) ? Math.round(x * 10 ** d) / 10 ** d : null);
const readJson = (file) => JSON.parse(fs.readFileSync(file, 'utf8'));

export class NeuralBrain extends EventEmitter {
  constructor({ dataDir = null, mode = 'live', shipped = SHIPPED_BRAIN, shippedExamples = SHIPPED_EXAMPLES, log = console, now = () => Date.now(), rng = Math.random, WorkerImpl = Worker, inline = false } = {}) {
    super();
    this.dir = dataDir ? path.join(dataDir, 'neural') : null;
    this.mode = mode;
    this.shippedFile = shipped;
    this.shippedExamples = shippedExamples;
    this.log = log;
    this.now = now;
    this.rng = rng;
    this.WorkerImpl = WorkerImpl;
    this.inline = inline;
    this.active = null; // { model, net, judge, flows }
    this.shipped = null; // the shipped brain's saved form (its long-history test results)
    this.thoughts = [];
    this.own = []; // the floor's own trades: { desk, symbol, t, x, r, p, explore }
    this.state = { version: 0, versions: [], lastTrainAt: 0, failedAt: null, lastError: null, calib: [], ownAtTrain: 0 };
    this.running = null;
    this.saveTimer = null;
    this.#loadAll();
  }

  // ---- files -------------------------------------------------------------------------------
  #file(name) {
    return this.dir ? path.join(this.dir, name) : null;
  }

  #loadAll() {
    try {
      this.shipped = readJson(this.shippedFile);
    } catch (err) {
      if (err.code !== 'ENOENT') this.log.warn?.(`[neural] the shipped brain can't be read: ${err.message}`);
    }
    try {
      const st = this.dir ? readJson(this.#file('state.json')) : null;
      if (st && typeof st === 'object') this.state = { ...this.state, ...st, versions: Array.isArray(st.versions) ? st.versions : [], calib: Array.isArray(st.calib) ? st.calib : [] };
    } catch { /* first run */ }
    try {
      const own = this.dir ? readJson(this.#file('examples.json')) : null;
      if (Array.isArray(own?.examples)) this.own = own.examples.filter((e) => Array.isArray(e?.x) && e.x.length === FEATURES.length && Number.isFinite(e.r));
    } catch { /* none yet */ }
    // The brain it learned on this Mac, else the one that ships with the floor.
    let learned = null;
    try {
      learned = this.dir ? readJson(this.#file('model.json')) : null;
    } catch { /* none yet */ }
    for (const [model, from] of [[learned, 'learned'], [this.shipped, 'shipped']]) {
      if (!model) continue;
      try {
        this.active = load(model);
        this.activeFrom = from;
        if (!this.state.version) this.state.version = 1;
        break;
      } catch (err) {
        this.log.warn?.(`[neural] ${from === 'learned' ? 'data/neural/model.json' : 'the shipped brain'} can't be used (${err.message})`);
      }
    }
  }

  #save() {
    if (!this.dir) return;
    clearTimeout(this.saveTimer);
    this.saveTimer = setTimeout(() => this.flush(), 2000);
    this.saveTimer.unref?.();
  }

  flush() {
    if (!this.dir) return;
    clearTimeout(this.saveTimer);
    try {
      fs.mkdirSync(this.dir, { recursive: true });
      const write = (name, data) => {
        const f = this.#file(name);
        fs.writeFileSync(`${f}.tmp`, JSON.stringify(data));
        fs.renameSync(`${f}.tmp`, f);
      };
      write('state.json', this.state);
      write('examples.json', { v: 1, examples: this.own.slice(-NEURAL.maxOwn) });
    } catch (err) {
      this.log.warn?.(`[neural] saving failed: ${err.message}`);
    }
  }

  get ready() {
    return !!this.active;
  }

  get trust() {
    return NEURAL.trust;
  }

  // ---- a desk asks -------------------------------------------------------------------------
  judge(agent, { symbol, side, entry, stop, target = null, reason = '', external = false }) {
    const env = agent.env;
    if (!this.active || !env?.marketBrain) return { take: true };
    let x;
    try {
      x = senseTrade({ brain: env.marketBrain, agent, symbol, side, entry, stop, target, now: env.clock.now() });
    } catch (err) {
      this.log.warn?.(`[neural] sensing failed: ${err.message}`);
      return { take: true };
    }
    if (!x) return { take: true };
    const j = this.active.judge(x, agent.id);
    const arr = toArray(x);
    const would = j.expR >= NEURAL.bar ? 'take' : 'pass';
    const base = { x: arr, p: round(j.p, 4), expR: round(j.expR, 4), version: this.state.version, would };
    let out;
    if (external) out = { ...base, take: true, verdict: 'yours' };
    // Not trusted yet: it judges and learns, the desk decides.
    else if (!this.skill().trusted) out = { ...base, take: true, verdict: 'learning' };
    else if (would === 'take') out = { ...base, take: true, verdict: 'take' };
    else if (this.rng() < NEURAL.explore) out = { ...base, take: true, explore: true, sizeMult: NEURAL.exploreSize, verdict: 'explore' };
    else out = { ...base, take: false, verdict: 'pass', reason: `it gives this ${symbol} ${side.toLowerCase()} a ${Math.round(j.p * 100)}% chance, ${j.expR >= 0 ? '+' : '−'}${Math.abs(j.expR).toFixed(2)}R expected after costs` };
    this.#thought(agent, { symbol, side, reason }, j, out, x);
    return out;
  }

  // Has the brain earned a say? Judged only on trades it had not learned from: its own record
  // on real prices (each trade judged at entry, before anyone knew how it would end) once there
  // are enough of them, until then the walk-forward test on long history it shipped with.
  // Explorations stand in for all the ideas it passed on, so they count 1/explore each.
  skill() {
    if (this.skillCache) return this.skillCache;
    const T = NEURAL.trust;
    const rec = this.own.filter((e) => Number.isFinite(e.p) && Number.isFinite(e.expR)).slice(-T.window);
    let s;
    if (rec.length >= T.minN) {
      const w = rec.map((e) => (e.explore ? 1 / NEURAL.explore : 1));
      const wmean = (idx) => {
        let sw = 0;
        let sr = 0;
        for (const i of idx) { sw += w[i]; sr += w[i] * rec[i].r; }
        return sw ? sr / sw : null;
      };
      const all = rec.map((_, i) => i);
      const picks = all.filter((i) => rec[i].expR >= NEURAL.bar);
      const a = auc(rec.map((e) => (e.r > 0 ? 1 : 0)), rec.map((e) => e.p), w);
      s = { source: 'live', n: rec.length, auc: round(a), allR: round(wmean(all)), picked: picks.length, pickedR: picks.length ? round(wmean(picks)) : null };
    } else if (this.shipped?.validation?.all) {
      const v = this.shipped.validation.all;
      s = { source: 'history', n: v.n, auc: v.auc, allR: v.allR, picked: v.picked, pickedR: v.pickedR, live: rec.length };
    } else {
      s = { source: 'none', n: rec.length, auc: null, allR: null, picked: 0, pickedR: null };
    }
    s.lift = s.pickedR != null && s.allR != null ? round(s.pickedR - s.allR) : null;
    s.trusted = s.n >= T.minN && s.auc >= T.minAuc && s.picked >= T.minPicks && s.lift >= T.minLift;
    s.text = skillText(s);
    this.skillCache = s;
    return s;
  }

  // Each judgement, for the Brain tab: the activations let it light the network's lines.
  #thought(agent, idea, j, out, x) {
    const { acts } = this.active.flows(x);
    const t = {
      at: this.now(), desk: agent.id, name: agent.profile?.name?.split(' ')[0] ?? agent.id, symbol: idea.symbol, side: idea.side,
      p: out.p, expR: out.expR, verdict: out.verdict, would: out.would, version: this.state.version,
      acts: acts.map((a) => Array.from(a, (v) => Math.round(v * 1000) / 1000)),
    };
    this.thoughts.push(t);
    if (this.thoughts.length > NEURAL.thoughts) this.thoughts.shift();
    this.emit('thought', t);
  }

  // ---- a trade closed ----------------------------------------------------------------------
  observe(agent, trade) {
    try {
      const n = trade?.neural;
      if (!Array.isArray(n?.x) || n.x.length !== FEATURES.length || !Number.isFinite(trade.r)) return;
      // Only real prices teach it: demo mode and simulated stand-in prices never do.
      if (this.mode === 'sim' || trade.simFeed) return;
      const e = { desk: agent.id, symbol: trade.symbol, t: trade.openTime, x: n.x, r: round(trade.r, 4), p: n.p, expR: Number.isFinite(n.expR) ? n.expR : null, explore: !!n.explore };
      this.own.push(e);
      if (this.own.length > NEURAL.maxOwn + 500) {
        const drop = this.own.length - NEURAL.maxOwn;
        this.own.splice(0, drop);
        this.state.ownAtTrain = Math.max(0, (this.state.ownAtTrain || 0) - drop);
      }
      this.skillCache = null;
      if (Number.isFinite(n.p)) {
        // Calibration in five bands of what it said: { n, said, won } running sums.
        const b = Math.min(4, Math.floor(n.p * 5));
        const c = this.state.calib[b] || { n: 0, said: 0, won: 0 };
        c.n++;
        c.said += n.p;
        c.won += trade.r > 0 ? 1 : 0;
        this.state.calib[b] = c;
      }
      this.emit('outcome', { at: this.now(), desk: agent.id, symbol: trade.symbol, p: n.p, r: e.r, won: trade.r > 0, explore: e.explore });
      this.#save();
    } catch (err) {
      this.log.warn?.(`[neural] learning from a trade failed: ${err.message}`);
    }
  }

  // ---- learning ----------------------------------------------------------------------------
  newSinceTrain() {
    return Math.max(0, this.own.length - (this.state.ownAtTrain || 0));
  }

  isDue(now = this.now()) {
    if (this.running || !this.active) return false;
    if (this.newSinceTrain() < NEURAL.minNew) return false;
    if (this.state.failedAt && now - this.state.failedAt < NEURAL.retryMs) return false;
    if (now - (this.state.lastTrainAt || 0) < NEURAL.everyMs) return false;
    // After the New York close (the desks are flat), or at the weekend.
    const p = nyParts(now);
    return p.weekday === 'Sat' || p.weekday === 'Sun' || p.hour === 17;
  }

  tick() {
    if (this.isDue()) this.retrain('nightly');
  }

  // Learn from the floor's own trades. Returns { ok } or { ok: false, error }.
  retrain(reason = 'asked') {
    if (this.running) return { ok: false, error: 'The brain is already learning' };
    if (!this.active) return { ok: false, error: 'No brain to start from (server/research/brain.json is missing)' };
    if (this.own.length < NEURAL.minNew) return { ok: false, error: `It learns once it has ${NEURAL.minNew} trades on real prices of its own (${this.own.length} so far)` };
    const job = { id: Date.now(), reason, examplesFile: this.shippedExamples, own: this.own, champion: this.active.model, settings: NEURAL, seed: (this.state.version || 1) + 1 };
    this.running = { reason, startedAt: this.now() };
    this.emit('learning', { at: this.now(), reason, own: this.own.length });
    if (this.inline) {
      import('./worker.js').then(({ learn }) => {
        try {
          this.#finish(job, learn(job));
        } catch (err) {
          this.#finish(job, { ok: false, error: err.message });
        }
      });
      return { ok: true };
    }
    let w;
    try {
      w = new this.WorkerImpl(path.join(HERE, 'worker.js'), { workerData: job });
    } catch (err) {
      this.#finish(job, { ok: false, error: `could not start learning: ${err.message}` });
      return { ok: false, error: this.state.lastError };
    }
    this.worker = w;
    const timer = setTimeout(() => {
      w.terminate();
      this.#finish(job, { ok: false, error: 'took too long and was stopped' });
    }, NEURAL.timeoutMs);
    timer.unref?.();
    let done = false;
    w.on('message', (m) => { done = true; clearTimeout(timer); w.terminate(); this.#finish(job, m); });
    w.on('error', (err) => { clearTimeout(timer); if (!done) this.#finish(job, { ok: false, error: err.message }); });
    w.on('exit', (code) => { clearTimeout(timer); if (!done) this.#finish(job, { ok: false, error: `learning stopped unexpectedly (exit code ${code})` }); });
    return { ok: true };
  }

  #finish(job, res) {
    if (!this.running) return;
    this.running = null;
    this.worker = null;
    const now = this.now();
    if (!res?.ok) {
      this.state.failedAt = now;
      this.state.lastError = { text: String(res?.error || 'no result').split('\n')[0], at: now };
      this.log.warn?.(`[neural] learning failed: ${this.state.lastError.text}`);
      this.emit('learned', { at: now, adopted: false, failed: true, text: this.state.lastError.text });
      this.#save();
      return;
    }
    this.state.failedAt = null;
    this.state.lastError = null;
    this.state.lastTrainAt = now;
    this.state.ownAtTrain = job.own.length;
    const rec = { at: now, reason: job.reason, adopted: !!res.adopted, own: job.own.length, held: res.held, champion: res.champion, challenger: res.challenger };
    let changes = null;
    if (res.adopted) {
      let next;
      try {
        next = load(res.model);
      } catch (err) {
        rec.adopted = false;
        rec.note = `the new brain couldn't be loaded (${err.message})`;
      }
      if (next) {
        changes = weightChanges(this.active.model.net, res.model.net);
        this.active = next;
        this.activeFrom = 'learned';
        this.state.version = (this.state.version || 1) + 1;
        rec.version = this.state.version;
        if (this.dir) {
          try {
            fs.mkdirSync(this.dir, { recursive: true });
            const f = this.#file('model.json');
            fs.writeFileSync(`${f}.tmp`, JSON.stringify(res.model));
            fs.renameSync(`${f}.tmp`, f);
          } catch (err) {
            this.log.warn?.(`[neural] saving the new brain failed: ${err.message}`);
          }
        }
      }
    }
    this.state.versions.push(rec);
    if (this.state.versions.length > NEURAL.versionsKept) this.state.versions.shift();
    this.log.info?.(`[neural] ${rec.adopted ? `learned: brain v${rec.version}` : 'kept the current brain'} (${job.own.length} trades of its own; on the newest ${res.held}: ${fmtScore(res.challenger)} vs ${fmtScore(res.champion)})`);
    this.emit('learned', { ...rec, changes, text: learnedText(rec) });
    this.#save();
    this.flush();
  }

  stop() {
    this.worker?.terminate?.();
    this.worker = null;
    this.running = null;
    this.flush();
  }

  // ---- for the Brain tab -------------------------------------------------------------------
  view() {
    const m = this.active?.model;
    const calib = this.state.calib.map((c, i) => (c && c.n ? { band: i, n: c.n, said: round(c.said / c.n), won: round(c.won / c.n) } : null)).filter(Boolean);
    const skill = this.active ? this.skill() : null;
    return {
      ready: !!this.active,
      version: this.state.version,
      from: this.activeFrom || null,
      mode: skill?.trusted ? 'trusted' : 'learning',
      skill,
      settings: { bar: NEURAL.bar, explore: NEURAL.explore, exploreSize: NEURAL.exploreSize, minNew: NEURAL.minNew, trust: NEURAL.trust },
      features: FEATURES.map((f) => ({ key: f.key, label: f.label, group: f.group })),
      network: m ? { sizes: m.net.sizes, W: m.net.W.map((a) => a.map((v) => Math.round(v * 1000) / 1000)), b: m.net.b.map((a) => a.map((v) => Math.round(v * 1000) / 1000)) } : null,
      trainedOn: m?.trainedOn ?? null,
      insights: m?.insights ?? this.shipped?.insights ?? null,
      // How the brain trained on long history did on months it never saw (npm run brain).
      tested: this.shipped?.validation ? { all: this.shipped.validation.all, halves: this.shipped.validation.halves, desks: this.shipped.validation.desks, calibration: this.shipped.validation.calibration, months: this.shipped.validation.months?.length ?? 0, source: this.shipped.source ?? null } : null,
      own: { n: this.own.length, newSinceTrain: this.newSinceTrain(), explored: this.own.filter((e) => e.explore).length },
      calibration: calib,
      learning: this.running ? { since: this.running.startedAt, reason: this.running.reason } : null,
      lastError: this.state.lastError,
      versions: this.state.versions.slice(-12),
      thoughts: this.thoughts.slice(-12).map(({ acts, ...t }) => t),
      lastThought: this.thoughts.at(-1) ?? null,
    };
  }
}

const fmtScore = (s) => (s ? `log loss ${s.logLoss}, picks ${s.pickedR == null ? '—' : `${s.pickedR >= 0 ? '+' : ''}${s.pickedR}R`}` : '—');
const fmtR = (x) => (x == null ? '—' : `${x >= 0 ? '+' : '−'}${Math.abs(x).toFixed(2)}R`);

function skillText(s) {
  const T = NEURAL.trust;
  if (s.source === 'none') return `No test yet: it earns a say once it has judged ${T.minN} trades on real prices before knowing how they ended (${s.n} so far)`;
  const where = s.source === 'live'
    ? `On its last ${s.n.toLocaleString('en-US')} trades on real prices, each judged before it ended`
    : `On ${s.n.toLocaleString('en-US')} trades from months it had never seen`;
  const what = `ranking skill ${s.auc ?? '—'} (0.5 is a coin), its picks ${fmtR(s.pickedR)} a trade against ${fmtR(s.allR)} for every trade`;
  if (s.trusted) return `${where}: ${what}. It has earned a say: ideas it expects to lose are passed (a quarter still trade small on paper, so it keeps learning)`;
  const until = s.source === 'history' && s.live < T.minN ? ` Its own record takes over after ${T.minN} trades on real prices (${s.live} so far).` : '';
  return `${where}: ${what}. Not yet better than taking every trade, so it learns and doesn't decide: every idea still trades on paper. It earns a say at skill ${T.minAuc}+ with picks ${T.minLift.toFixed(2)}R better.${until}`;
}

function learnedText(rec) {
  const c = rec.challenger;
  const k = rec.champion;
  if (!rec.adopted) {
    return `The brain studied ${rec.own} trades of its own and kept what it knew: the new version didn't judge the newest ${rec.held} trades better (${fmtScore(c)} vs ${fmtScore(k)}).`;
  }
  return `The brain learned (v${rec.version}): on the newest ${rec.held} trades, which neither version had seen, it judged better (${fmtScore(c)} vs ${fmtScore(k)}).`;
}

// Which connections changed most between two brains (the 3D view flashes them).
export function weightChanges(oldNet, newNet, top = 120) {
  const out = [];
  for (let l = 0; l < Math.min(oldNet.W.length, newNet.W.length); l++) {
    const a = oldNet.W[l];
    const b = newNet.W[l];
    if (a.length !== b.length) continue;
    const nIn = newNet.sizes[l];
    for (let k = 0; k < b.length; k++) out.push({ l, i: k % nIn, j: Math.floor(k / nIn), d: Math.round((b[k] - a[k]) * 1000) / 1000 });
  }
  return out.sort((x, y) => Math.abs(y.d) - Math.abs(x.d)).slice(0, top);
}

export function loadShippedExamples(file = SHIPPED_EXAMPLES) {
  const raw = JSON.parse(zlib.gunzipSync(fs.readFileSync(file)).toString('utf8'));
  if (raw?.v !== 1 || !Array.isArray(raw.examples)) throw new Error('not a saved set of brain examples');
  return raw.examples;
}

export { MODEL_VERSION };
