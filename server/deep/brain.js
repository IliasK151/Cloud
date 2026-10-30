import fs from 'node:fs';
import path from 'node:path';
import { EventEmitter } from 'node:events';
import { Worker } from 'node:worker_threads';
import { fileURLToPath } from 'node:url';
import { nyParts } from '../market/session.js';
import { SYMBOLS } from '../market/symbols.js';
import { senseTrade, toArray, N_FEATURES } from '../neural/features.js';
import { auc, scale } from '../neural/net.js';
import { NEURAL, SHIPPED_EXAMPLES } from '../neural/brain.js';
import { DeepNet } from './model.js';
import { candleTokens, expertOf, packTokens, EXPERTS, TIMEFRAMES } from './tokens.js';
import { unit, nearest, project, unpackVecs } from './memory.js';
import { judgeWith, DEEP } from './train.js';

// The deep brain: a transformer that reads the candles themselves, a router with five market
// experts, and a memory of every past trade (deep/model.js, tokens.js, memory.js, train.js).
// It sits next to the neural brain, and every desk asks it before a trade.
//
//   It watches first. It judges every idea and learns from every trade on real prices, but
//   decides nothing until it has earned a say, by the same rule as the neural brain: on trades
//   it hadn't learned from, a ranking skill of 0.55+ and picks clearly better than taking every
//   trade. Then it passes ideas it expects to lose; a quarter of those still trade small on
//   paper (never on your account), so it keeps learning whether passing was right. It never
//   adds a trade or makes one bigger.
//   It learns on this computer, from real prices only: the first time as soon as the floor has
//   saved enough history (3 weeks for a market), then after the New York close once it has 30
//   new trades or a week of new prices. Demo mode never teaches it.
//
// Everything it keeps is in data/deep/.

const HERE = path.dirname(fileURLToPath(import.meta.url));
export const DEEP_BRAIN = {
  bar: 0,
  explore: 0.25,
  exploreSize: 0.25,
  trust: NEURAL.trust,
  near: 12,
  thoughts: 30,
  minNew: 30,
  refreshDays: 7, // relearn with a week of new prices even without new trades of its own
  everyMs: 20 * 3_600_000,
  retryMs: 6 * 3_600_000,
  timeoutMs: 75 * 60_000,
  maxOwn: 6000,
  liveMemory: 6000,
  pendingKept: 400,
  versionsKept: 30,
};
const DAY = 86_400_000;
const round = (x, d = 3) => (Number.isFinite(x) ? Math.round(x * 10 ** d) / 10 ** d : null);
const readJson = (file) => JSON.parse(fs.readFileSync(file, 'utf8'));
const sig = (x) => (Number.isFinite(x) ? Number(x.toPrecision(7)) : null);
const fmtR = (x) => (x == null ? '—' : `${x >= 0 ? '+' : '−'}${Math.abs(x).toFixed(2)}R`);

export class DeepBrain extends EventEmitter {
  constructor({ dataDir = null, mode = 'live', history = null, neural = null, historyDir = undefined, shippedExamples = SHIPPED_EXAMPLES, log = console, now = () => Date.now(), rng = Math.random, WorkerImpl = Worker, inline = false, trainer = null, settings = {} } = {}) {
    super();
    this.dir = dataDir ? path.join(dataDir, 'deep') : null;
    this.historyDir = historyDir !== undefined ? historyDir : dataDir ? path.join(dataDir, 'history') : null;
    this.mode = mode;
    this.history = history;
    this.neural = neural;
    this.shippedExamples = shippedExamples;
    this.log = log;
    this.now = now;
    this.rng = rng;
    this.WorkerImpl = WorkerImpl;
    this.inline = inline;
    this.trainer = trainer; // inline only: (job, onProgress) => result (tests)
    this.settings = settings; // training settings (tests make it small)
    this.net = null;
    this.model = null;
    this.memory = null; // { d, vecs, meta, pca, galaxy }
    this.own = []; // the floor's own trades: { desk, symbol, side, t, x, tok, slots, r, p, expR, explore }
    this.liveMem = []; // their vectors, added as they close: { v, m: [desk, symbol, t, r, 'own', side], pos }
    this.pending = new Map(); // judged ideas waiting for their trade to close
    this.thoughts = [];
    this.state = { version: 0, versions: [], lastTrainAt: 0, failedAt: null, lastError: null, ownAtTrain: 0 };
    this.running = null;
    this.progress = null;
    this.#loadAll();
  }

  // ---- files -------------------------------------------------------------------------------
  #file(name) {
    return this.dir ? path.join(this.dir, name) : null;
  }

  #loadAll() {
    if (!this.dir) return;
    try {
      const st = readJson(this.#file('state.json'));
      if (st && typeof st === 'object') {
        this.state = { ...this.state, ...st.state, versions: Array.isArray(st.state?.versions) ? st.state.versions : [] };
        this.pending = new Map(Array.isArray(st.pending) ? st.pending.filter((p) => p?.id).map((p) => [p.id, p]) : []);
        this.thoughts = Array.isArray(st.thoughts) ? st.thoughts.slice(-DEEP_BRAIN.thoughts) : [];
      }
    } catch { /* first run */ }
    try {
      const own = readJson(this.#file('own.json'));
      this.own = Array.isArray(own?.own) ? own.own.filter((e) => Array.isArray(e?.x) && e.x.length === N_FEATURES && Number.isFinite(e.r)) : [];
      this.liveMem = Array.isArray(own?.liveMem) ? own.liveMem.filter((e) => Array.isArray(e?.v)) : [];
    } catch { /* none yet */ }
    try {
      this.#use(readJson(this.#file('model.json')), readJson(this.#file('memory.json')));
    } catch (err) {
      if (err.code !== 'ENOENT') this.log.warn?.(`[deep] the saved deep brain can't be used (${err.message})`);
    }
  }

  #use(model, memory) {
    const net = DeepNet.from(model);
    if (net.c.senses !== N_FEATURES) throw new Error('it was trained on different senses');
    const vecs = memory?.vecs ? unpackVecs(memory.vecs) : new Float32Array(0);
    if (memory && vecs.length !== memory.n * memory.d) throw new Error('its memory is damaged');
    this.net = net;
    this.model = model;
    this.memory = memory ? { ...memory, vecs } : null;
    this.judgeFn = judgeWith(net, model.desks || { '*': { win: 1, loss: 1 } });
    this.skillCache = null;
  }

  #save() {
    if (!this.dir) return;
    clearTimeout(this.saveTimer);
    this.saveTimer = setTimeout(() => this.flush(), 3000);
    this.saveTimer.unref?.();
  }

  // The small state after every idea; its own trades (months of them, with their candles) only
  // when one has closed, so a busy floor never waits on a big write.
  flush() {
    if (!this.dir) return;
    clearTimeout(this.saveTimer);
    try {
      fs.mkdirSync(this.dir, { recursive: true });
      this.#write('state.json', { state: this.state, pending: [...this.pending.values()], thoughts: this.thoughts });
      if (this.ownDirty) {
        this.#write('own.json', { own: this.own, liveMem: this.liveMem });
        this.ownDirty = false;
      }
    } catch (err) {
      this.log.warn?.(`[deep] saving failed: ${err.message}`);
    }
  }

  #write(name, data) {
    const f = this.#file(name);
    fs.writeFileSync(`${f}.tmp`, JSON.stringify(data));
    fs.renameSync(`${f}.tmp`, f);
  }

  get ready() {
    return !!this.net;
  }

  get trust() {
    return DEEP_BRAIN.trust;
  }

  // ---- a desk asks -------------------------------------------------------------------------
  // x: the senses the neural brain already measured (sensed here when it didn't). noSay: the
  // desks trade their own way, so it watches and learns but has no say.
  judge(agent, { symbol, side, entry, stop, target = null, x = null, external = false, noSay = false }) {
    if (!this.net) return null;
    try {
      const env = agent.env || {};
      const bars = this.history?.recent?.(symbol, 420) || env.md?.bars?.(symbol) || [];
      const tk = candleTokens(bars, { side, entry });
      let raw = Array.isArray(x) && x.length === N_FEATURES ? x : null;
      if (!raw && env.marketBrain) {
        const sx = senseTrade({ brain: env.marketBrain, agent, symbol, side, entry, stop, target, now: env.clock.now() });
        raw = sx ? toArray(sx) : null;
      }
      if (!tk && !raw) return null;
      const ex = { tok: tk?.tok || new Float64Array(0), slots: tk?.slots || [], x: raw && this.net.scaler ? scale(raw, this.net.scaler) : null, market: expertOf(symbol, SYMBOLS[symbol]?.assetClass) };
      const j = this.judgeFn(ex, agent.id);
      const c = j.cache;
      const would = j.expR >= DEEP_BRAIN.bar ? 'take' : 'pass';
      const skill = this.skill();
      const id = `${agent.id}-${this.now().toString(36)}-${Math.floor(this.rng() * 1e6).toString(36)}`;
      const base = { id, p: round(j.p, 4), expR: round(j.expR, 4), version: this.state.version, would };
      let out;
      if (external) out = { ...base, take: true, verdict: 'yours' };
      else if (noSay || !skill.trusted) out = { ...base, take: true, verdict: 'learning' };
      else if (would === 'take') out = { ...base, take: true, verdict: 'take' };
      else if (this.rng() < DEEP_BRAIN.explore) out = { ...base, take: true, explore: true, sizeMult: DEEP_BRAIN.exploreSize, verdict: 'explore' };
      else out = { ...base, take: false, verdict: 'pass', reason: `it gives this ${symbol} ${side.toLowerCase()} a ${Math.round(j.p * 100)}% chance, ${fmtR(j.expR)} expected after costs` };
      // Its memory: the past trades most like this one.
      const vec = unit(c.h);
      const near = this.#nearest(vec);
      const pos = this.memory?.pca ? project(this.memory.pca, vec).map((v) => round(v, 2)) : [0, 0, 0];
      this.pending.set(id, {
        id, desk: agent.id, symbol, side, t: this.now(), x: raw, ...(packTokens(tk) || {}),
        p: out.p, expR: out.expR, verdict: out.verdict, v: Array.from(vec, (v) => round(v, 4)), pos,
      });
      if (this.pending.size > DEEP_BRAIN.pendingKept) this.#prunePending();
      this.#thought(agent, { symbol, side, entry }, out, c, tk, near, pos);
      this.#save();
      return out;
    } catch (err) {
      this.log.warn?.(`[deep] judging failed: ${err.message}`);
      return null;
    }
  }

  #prunePending() {
    const cut = this.now() - 3 * DAY;
    for (const [k, p] of this.pending) if (p.t < cut) this.pending.delete(k);
    while (this.pending.size > DEEP_BRAIN.pendingKept) this.pending.delete(this.pending.keys().next().value);
  }

  #nearest(vec) {
    const out = [];
    const d = vec.length;
    if (this.memory?.vecs?.length) {
      // Trades with candles are compared with trades with candles once there are enough of them:
      // the long history's trades (senses only) were seen without any.
      const meta = this.memory.meta;
      const withCandles = meta.reduce((n, m) => n + (m[4] !== 'history' ? 1 : 0), 0);
      const skip = withCandles >= 50 ? (i) => meta[i][4] === 'history' : null;
      for (const h of nearest(this.memory.vecs, d, vec, DEEP_BRAIN.near, skip)) {
        const m = this.memory.meta[h.i];
        out.push({ s: h.s, m, v: this.memory.vecs.subarray(h.i * d, (h.i + 1) * d) });
      }
    }
    if (this.liveMem.length) {
      const flat = new Float32Array(this.liveMem.length * d);
      this.liveMem.forEach((e, i) => flat.set(e.v.length === d ? e.v : new Array(d).fill(0), i * d));
      for (const h of nearest(flat, d, vec, DEEP_BRAIN.near)) out.push({ s: h.s, m: this.liveMem[h.i].m, v: flat.subarray(h.i * d, (h.i + 1) * d) });
    }
    return out.sort((a, b) => b.s - a.s).slice(0, DEEP_BRAIN.near).map((h) => ({
      desk: h.m[0], symbol: h.m[1], t: h.m[2], r: h.m[3], src: h.m[4], sim: round(h.s, 3),
      pos: this.memory?.pca ? project(this.memory.pca, h.v).map((v) => round(v, 2)) : [0, 0, 0],
    }));
  }

  // What it thought, for the Brain tab: the candles it read, where it looked, which experts
  // it asked, and the closest past trades.
  #thought(agent, idea, out, c, tk, near, pos) {
    const attn = this.net.attention(c).map((L) => L.map((h) => h.map((w) => round(w, 3))));
    const last = attn.at(-1) || [];
    const avg = (tk?.meta || []).map((m, j) => ({ slot: m.slot, tf: m.tf, t: m.t, w: last.reduce((s, h) => s + (h[j] || 0), 0) / Math.max(1, last.length) }));
    const won = near.filter((n) => n.r > 0).length;
    const t = {
      at: this.now(), id: out.id, desk: agent.id, name: agent.profile?.name?.split(' ')[0] ?? agent.id, symbol: idea.symbol, side: idea.side,
      p: out.p, expR: out.expR, verdict: out.verdict, would: out.would, version: this.state.version,
      candles: (tk?.meta || []).map((m) => [m.slot, m.tf, m.t, sig(m.o), sig(m.h), sig(m.l), sig(m.c)]),
      entry: sig(idea.entry),
      attn,
      top: avg.sort((a, b) => b.w - a.w).slice(0, 3).map((a) => ({ ...a, w: round(a.w, 3) })),
      gates: Array.from(c.gates, (g) => round(g, 3)),
      experts: Array.from(c.z, (z) => round(1 / (1 + Math.exp(-z)), 3)),
      pos, near,
      nearWon: won,
      nearAvgR: near.length ? round(near.reduce((s, n) => s + (n.r || 0), 0) / near.length, 2) : null,
    };
    this.thoughts.push(t);
    if (this.thoughts.length > DEEP_BRAIN.thoughts) this.thoughts.shift();
    this.emit('thought', t);
  }

  // Has it earned a say? On trades it hadn't learned from: its own record on real prices once
  // there are enough (each judged at entry), until then the fair test from its last lesson.
  // Explorations stand in for all the ideas it passed on (they count 1/explore each).
  skill() {
    if (this.skillCache) return this.skillCache;
    const T = DEEP_BRAIN.trust;
    const rec = this.own.filter((e) => Number.isFinite(e.p) && Number.isFinite(e.expR)).slice(-T.window);
    let s;
    if (rec.length >= T.minN) {
      const w = rec.map((e) => (e.explore ? 1 / DEEP_BRAIN.explore : 1));
      const wmean = (idx) => {
        let sw = 0;
        let sr = 0;
        for (const i of idx) { sw += w[i]; sr += w[i] * rec[i].r; }
        return sw ? sr / sw : null;
      };
      const all = rec.map((_, i) => i);
      const picks = all.filter((i) => rec[i].expR >= DEEP_BRAIN.bar);
      const a = auc(rec.map((e) => (e.r > 0 ? 1 : 0)), rec.map((e) => e.p), w);
      s = { source: 'live', n: rec.length, auc: round(a), allR: round(wmean(all)), picked: picks.length, pickedR: picks.length ? round(wmean(picks)) : null };
    } else if (this.model?.validation?.challenger) {
      const v = this.model.validation.challenger;
      s = { source: 'test', n: v.n, auc: v.auc, allR: v.allR, picked: v.picked, pickedR: v.pickedR, live: rec.length };
    } else {
      s = { source: 'none', n: rec.length, auc: null, allR: null, picked: 0, pickedR: null };
    }
    s.lift = s.pickedR != null && s.allR != null ? round(s.pickedR - s.allR) : null;
    s.trusted = !!this.net && s.n >= T.minN && s.auc >= T.minAuc && s.picked >= T.minPicks && s.lift >= T.minLift;
    s.text = skillText(s);
    this.skillCache = s;
    return s;
  }

  // ---- a trade closed ----------------------------------------------------------------------
  observe(agent, trade) {
    try {
      const d = trade?.deep;
      if (!d?.id) return;
      const pd = this.pending.get(d.id);
      this.pending.delete(d.id);
      if (!pd || !Number.isFinite(trade.r)) return;
      // Only real prices teach it: demo mode and stand-in prices never do.
      const learns = this.mode !== 'sim' && !trade.simFeed && Array.isArray(pd.x);
      if (learns) {
        const e = { desk: pd.desk, symbol: pd.symbol, side: pd.side, t: pd.t, x: pd.x, tok: pd.tok, slots: pd.slots, r: round(trade.r, 4), p: pd.p, expR: pd.expR, explore: !!d.explore };
        this.own.push(e);
        if (this.own.length > DEEP_BRAIN.maxOwn + 200) {
          const drop = this.own.length - DEEP_BRAIN.maxOwn;
          this.own.splice(0, drop);
          this.state.ownAtTrain = Math.max(0, (this.state.ownAtTrain || 0) - drop);
        }
        this.liveMem.push({ v: pd.v, m: [pd.desk, pd.symbol, pd.t, round(trade.r, 3), 'own', pd.side], pos: pd.pos });
        if (this.liveMem.length > DEEP_BRAIN.liveMemory) this.liveMem.splice(0, this.liveMem.length - DEEP_BRAIN.liveMemory);
        this.skillCache = null;
        this.ownDirty = true;
      }
      this.emit('outcome', { at: this.now(), id: d.id, desk: agent.id, symbol: trade.symbol, p: pd.p, r: round(trade.r, 3), won: trade.r > 0, explore: !!d.explore, pos: pd.pos, kept: learns });
      this.#save();
    } catch (err) {
      this.log.warn?.(`[deep] learning from a trade failed: ${err.message}`);
    }
  }

  // ---- learning ----------------------------------------------------------------------------
  newSinceTrain() {
    return Math.max(0, this.own.length - (this.state.ownAtTrain || 0));
  }

  // Enough saved real history to learn from? (A market with 3 weeks of prices.)
  #hasHistory() {
    if (!this.history?.span) return !!this.historyDir;
    const need = (DEEP.minHistoryDays * 86_400);
    return Object.keys(SYMBOLS).some((id) => {
      if (this.history.isReal && !this.history.isReal(id)) return false;
      const s = this.history.span(id);
      const last = this.history.recent?.(id, 1)?.[0]?.time;
      return s?.from != null && last != null && last - s.from >= need;
    });
  }

  isDue(now = this.now()) {
    if (this.running || this.mode === 'sim') return false;
    if (this.state.failedAt && now - this.state.failedAt < DEEP_BRAIN.retryMs) return false;
    if (!this.net) return this.#hasHistory(); // its first lesson: as soon as there's enough history
    if (now - (this.state.lastTrainAt || 0) < DEEP_BRAIN.everyMs) return false;
    const stale = now - (this.model?.trainedAt || 0) > DEEP_BRAIN.refreshDays * DAY;
    if (this.newSinceTrain() < DEEP_BRAIN.minNew && !stale) return false;
    // After the New York close (the desks are flat), or at the weekend.
    const p = nyParts(now);
    return p.weekday === 'Sat' || p.weekday === 'Sun' || p.hour === 17;
  }

  tick() {
    if (this.isDue()) this.retrain(this.net ? 'nightly' : 'first');
  }

  retrain(reason = 'asked') {
    if (this.running) return { ok: false, error: 'The deep brain is already learning' };
    if (this.mode === 'sim') return { ok: false, error: 'It learns from real prices only: demo mode never teaches it' };
    // The latest prices on disk first: the lesson reads them from data/history.
    try { this.history?.save?.(); } catch { /* the saved copy is a little older */ }
    const job = {
      deepJob: true, reason,
      historyDir: this.historyDir,
      replayCache: this.#file('replays.json.gz'),
      shippedFile: this.shippedExamples,
      own: this.own,
      champion: this.model,
      mlp: this.neural?.active?.model ?? null,
      seed: (this.state.version || 0) + 1,
      now: this.now(),
      settings: this.settings,
    };
    this.running = { reason, startedAt: this.now() };
    this.progress = { stage: 'start', pct: 0, text: 'Starting…' };
    this.emit('learning', { at: this.now(), reason, own: this.own.length });
    const onProgress = (p) => {
      this.progress = { stage: p.stage, pct: round(p.pct ?? 0, 3), text: p.text };
      const t = this.now();
      if (t - (this.lastProgressAt || 0) > 1500) {
        this.lastProgressAt = t;
        this.emit('progress', { at: t, ...this.progress });
      }
    };
    if (this.inline) {
      const run = this.trainer || ((j, p) => import('./train.js').then(({ learn }) => learn(j, p)));
      Promise.resolve().then(() => run(job, onProgress))
        .then((res) => this.#finish(job, res))
        .catch((err) => this.#finish(job, { ok: false, error: err.message }));
      return { ok: true };
    }
    let w;
    try {
      w = new this.WorkerImpl(path.join(HERE, 'worker.js'), { workerData: job });
    } catch (err) {
      this.#finish(job, { ok: false, error: `could not start learning: ${err.message}` });
      return { ok: false, error: this.state.lastError?.text };
    }
    this.worker = w;
    let done = false;
    const timer = setTimeout(() => {
      done = true;
      w.terminate();
      this.#finish(job, { ok: false, error: 'took too long and was stopped' });
    }, DEEP_BRAIN.timeoutMs);
    timer.unref?.();
    w.on('message', (m) => {
      if (m?.type === 'progress') return onProgress(m);
      done = true;
      clearTimeout(timer);
      w.terminate();
      this.#finish(job, m);
    });
    w.on('error', (err) => { clearTimeout(timer); if (!done) { done = true; this.#finish(job, { ok: false, error: err.message }); } });
    w.on('exit', (code) => { clearTimeout(timer); if (!done) { done = true; this.#finish(job, { ok: false, error: `learning stopped unexpectedly (exit code ${code})` }); } });
    return { ok: true };
  }

  #finish(job, res) {
    if (!this.running) return;
    this.running = null;
    this.progress = null;
    this.worker = null;
    const now = this.now();
    if (!res?.ok) {
      this.state.failedAt = now;
      this.state.lastError = { text: String(res?.error || 'no result').split('\n')[0], at: now, data: res?.data ?? null };
      this.log.warn?.(`[deep] learning didn't finish: ${this.state.lastError.text}`);
      this.emit('learned', { at: now, adopted: false, failed: true, text: `The deep brain didn't learn this time: ${this.state.lastError.text}` });
      this.flush();
      return;
    }
    this.state.failedAt = null;
    this.state.lastError = null;
    this.state.lastTrainAt = now;
    this.state.ownAtTrain = job.own.length;
    const rec = { at: now, reason: job.reason, adopted: !!res.adopted, own: job.own.length, held: res.validation?.n ?? 0, challenger: res.validation?.challenger ?? null, champion: res.validation?.champion ?? null, mlp: res.validation?.mlp ?? null, data: res.data ?? null };
    if (res.adopted) {
      try {
        this.#use(res.model, res.memory);
        // Its own trades so far are in the new memory: the live additions start again.
        this.liveMem = [];
        this.ownDirty = true;
        this.state.version = (this.state.version || 0) + 1;
        rec.version = this.state.version;
        if (this.dir) {
          fs.mkdirSync(this.dir, { recursive: true });
          this.#write('model.json', res.model);
          this.#write('memory.json', res.memory);
        }
      } catch (err) {
        rec.adopted = false;
        rec.note = `the new version couldn't be used (${err.message})`;
      }
    }
    this.state.versions.push(rec);
    if (this.state.versions.length > DEEP_BRAIN.versionsKept) this.state.versions.shift();
    const text = learnedText(rec);
    this.log.info?.(`[deep] ${text}`);
    this.emit('learned', { ...rec, text });
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
    const m = this.model;
    const skill = this.net ? this.skill() : null;
    return {
      ready: !!this.net,
      demo: this.mode === 'sim',
      status: this.running ? 'training' : !this.net ? 'untrained' : skill?.trusted ? 'trusted' : 'learning',
      version: this.state.version,
      trainedAt: m?.trainedAt ?? null,
      design: {
        layers: this.net?.c.layers ?? 2, heads: this.net?.c.heads ?? 4, width: this.net?.c.d ?? 32, params: this.net?.size ?? null,
        experts: EXPERTS, timeframes: TIMEFRAMES.map((g) => ({ tf: g.tf, n: g.n, label: g.label })),
      },
      skill,
      settings: { bar: DEEP_BRAIN.bar, explore: DEEP_BRAIN.explore, exploreSize: DEEP_BRAIN.exploreSize, minNew: DEEP_BRAIN.minNew, trust: DEEP_BRAIN.trust, minHistoryDays: DEEP.minHistoryDays },
      data: m?.data ?? this.state.lastError?.data ?? null,
      validation: m?.validation ?? null,
      pretrain: m?.pretrain ?? null,
      memory: { n: (this.memory?.n ?? 0) + this.liveMem.length },
      history: this.#historyDays(),
      own: { n: this.own.length, newSinceTrain: this.newSinceTrain(), explored: this.own.filter((e) => e.explore).length },
      learning: this.running ? { since: this.running.startedAt, reason: this.running.reason, ...this.progress } : null,
      lastError: this.state.lastError ? { text: this.state.lastError.text, at: this.state.lastError.at } : null,
      versions: this.state.versions.slice(-8).map(({ data, ...v }) => v),
      thoughts: this.thoughts.slice(-12),
    };
  }

  // Days of real prices saved per market (it learns once one has DEEP.minHistoryDays).
  #historyDays() {
    if (!this.history?.span) return null;
    const out = {};
    for (const id of Object.keys(SYMBOLS)) {
      const s = this.history.span(id);
      const last = this.history.recent?.(id, 1)?.[0]?.time;
      out[id] = { days: s?.from != null && last != null ? round((last - s.from) / 86_400, 1) : 0, real: this.history.isReal ? !!this.history.isReal(id) : null };
    }
    return out;
  }

  // The galaxy: a sample of its memory on three axes ([x, y, z, won, source: 0 long history,
  // 1 replayed on your prices, 2 the floor's own]).
  galaxy() {
    const pts = (this.memory?.galaxy || []).slice();
    for (const e of this.liveMem) if (Array.isArray(e.pos)) pts.push([...e.pos, e.m[3] > 0 ? 1 : 0, 2]);
    return { n: (this.memory?.n ?? 0) + this.liveMem.length, points: pts };
  }
}

function skillText(s) {
  const T = DEEP_BRAIN.trust;
  if (s.source === 'none') return `No test yet: it earns a say once it has judged ${T.minN} trades on real prices before knowing how they ended (${s.n} so far)`;
  const where = s.source === 'live'
    ? `On its last ${s.n.toLocaleString('en-US')} trades on real prices, each judged before it ended`
    : `On the newest ${s.n.toLocaleString('en-US')} trades of its last lesson, which it never learned from`;
  const what = `ranking skill ${s.auc ?? '—'} (0.5 is a coin), its picks ${fmtR(s.pickedR)} a trade against ${fmtR(s.allR)} for every trade`;
  if (s.trusted) return `${where}: ${what}. It has earned a say: ideas it expects to lose are passed (a quarter still trade small on paper, so it keeps learning)`;
  const until = s.source === 'test' ? ` Its own record takes over after ${T.minN} trades on real prices (${s.live} so far).` : '';
  return `${where}: ${what}. Not yet better than taking every trade, so it watches and learns and doesn't decide. It earns a say at skill ${T.minAuc}+ with picks ${T.minLift.toFixed(2)}R better.${until}`;
}

const fmtScore = (s) => (s ? `skill ${s.auc ?? '—'}, picks ${fmtR(s.pickedR)}` : '—');

function learnedText(rec) {
  if (!rec.adopted) {
    return `The deep brain studied and kept what it knew: the new version didn't judge the newest ${rec.held} trades better (${fmtScore(rec.challenger)} vs ${fmtScore(rec.champion)})${rec.note ? `; ${rec.note}` : ''}.`;
  }
  if (!(rec.held >= 30) || rec.challenger?.auc == null) return `The deep brain learned (v${rec.version}). Its test on trades it never learned from waits for more of them (${rec.held} so far).`;
  const vs = rec.champion ? ` against ${fmtScore(rec.champion)} for the version before` : rec.mlp ? ` (the neural brain: ${fmtScore(rec.mlp)})` : '';
  return `The deep brain learned (v${rec.version}): on the newest ${rec.held} trades, which it never learned from, ${fmtScore(rec.challenger)}${vs}.`;
}
