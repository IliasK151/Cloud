import fs from 'node:fs';
import path from 'node:path';
import { EventEmitter } from 'node:events';
import { GROUPS } from '../live/accountBrain.js';

// The floor's memory: one knowledge graph the whole floor shares. Every desk's own learner
// only remembers its own trades; this remembers every trade on real prices by situation
// (the market, with or against the trend, how wild it was, the session), what each desk
// has learned, and who reviewed whose ideas in the committee. Before a trade the committee
// asks it "how did trades like this go, across the floor?" (the memory factor), and the
// Brain tab shows it as a live 3D graph.
//
// Situations fade with time (each new trade in a situation counts more than the old ones),
// so the memory follows the market as it changes.

const DECAY = 0.97; // weight kept per new trade in the same situation (half-life ≈ 23 trades)
const PRIOR = 6; // pseudo-trades at 0R: small samples say little
const MIN_N = 6; // weighted trades before the committee listens to a situation
const LESSONS_KEPT = 80;
const EVENTS_KEPT = 60;

export const TREND_LABEL = { with: 'with the trend', against: 'against the trend', flat: 'no clear trend' };
export const SESSION_LABEL = { asia: 'Asia', london: 'London', 'ny-open': 'New York open', 'ny-midday': 'New York midday', 'ny-late': 'New York afternoon' };
const fmtR = (x) => `${x >= 0 ? '+' : '−'}${Math.abs(x).toFixed(2)}R`;
const round2 = (x) => Math.round(x * 100) / 100;
const clamp = (x, lo = -1, hi = 1) => Math.max(lo, Math.min(hi, x));

export function situationKey(symbol, ctx) {
  if (!symbol || !ctx) return null;
  return `${symbol}|${ctx.trend || 'flat'}|${ctx.vol || 'normal'}|${ctx.session || 'asia'}`;
}

export function situationLabel(key) {
  const [symbol, trend, vol, session] = key.split('|');
  return { symbol, text: `${TREND_LABEL[trend] || trend}, ${vol}, ${SESSION_LABEL[session] || session}` };
}

const blank = () => ({ v: 1, seeded: false, trades: 0, situations: {}, lessons: [], reviews: {}, updatedAt: 0 });

export class FloorMemory extends EventEmitter {
  constructor({ file = null, mode = 'live', log = console, now = () => Date.now() } = {}) {
    super();
    this.file = file;
    this.mode = mode;
    this.log = log;
    this.now = now;
    this.state = blank();
    this.events = [];
    this.seq = 0;
    if (file) {
      try {
        const s = JSON.parse(fs.readFileSync(file, 'utf8'));
        if (s?.v === 1) this.state = { ...blank(), ...s };
      } catch { /* first run */ }
    }
  }

  // ---- what happens on the floor ----------------------------------------------------------
  // A desk closed a trade. Only trades on real prices count (demo mode keeps its own file).
  onTrade(agent, trade, ctx) {
    if (!agent || !trade || trade.r == null || !ctx) return;
    if (this.mode === 'live' && trade.simFeed) return;
    const key = this.#record(agent.id, trade.symbol, ctx, trade.r);
    this.#event({ kind: 'trade', agentId: agent.id, key, r: round2(trade.r), symbol: trade.symbol });
  }

  onLesson(agent, lesson) {
    if (!agent || !lesson?.title) return;
    const L = this.state.lessons;
    if (L.some((l) => l.id === lesson.id)) return;
    L.push({ id: lesson.id, agentId: agent.id, title: lesson.title, time: lesson.time ?? this.now(), status: lesson.status || 'noted' });
    if (L.length > LESSONS_KEPT) L.shift();
    this.#touch();
    this.#event({ kind: 'lesson', agentId: agent.id, id: lesson.id, text: lesson.title });
  }

  // The committee met: who reviewed whose idea, and how they leaned.
  onDebate(d) {
    if (!d?.proposer) return;
    const reviewers = (d.messages || []).filter((m) => m.role === 'reviews' && m.from !== d.proposer);
    for (const m of reviewers) {
      const k = `${m.from}>${d.proposer}`;
      const r = (this.state.reviews[k] ||= { n: 0, agree: 0, cautious: 0, disagree: 0 });
      r.n++;
      if (r[m.stance] != null) r[m.stance]++;
    }
    if (reviewers.length) this.#touch();
    this.#event({ kind: 'debate', agentId: d.proposer, symbol: d.symbol, verdict: d.verdict, grade: d.grade, reviewers: reviewers.map((m) => ({ id: m.from, stance: m.stance })) });
  }

  #record(agentId, symbol, ctx, r, t = this.now()) {
    const key = situationKey(symbol, ctx);
    const s = (this.state.situations[key] ||= { n: 0, sum: 0, wins: 0, trades: 0, first: t, last: t, byDesk: {} });
    s.n = s.n * DECAY + 1;
    s.sum = s.sum * DECAY + clamp(r, -3, 6);
    s.wins = s.wins * DECAY + (r > 0 ? 1 : 0);
    s.trades++;
    s.last = Math.max(s.last, t);
    const d = (s.byDesk[agentId] ||= { trades: 0, sumR: 0 });
    d.trades++;
    d.sumR = round2(d.sumR + r);
    this.state.trades++;
    this.#touch();
    return key;
  }

  // The memory starts from what the desks already remember: their learners' journals.
  seedFromJournals(agents) {
    if (this.state.seeded) return 0;
    let n = 0;
    for (const a of agents) {
      if (a.profile?.lab) continue; // research desks move between markets; the journal doesn't say which
      for (const rec of a.learner?.state?.journal || []) {
        if (rec?.ctx && Number.isFinite(rec.r)) {
          this.#record(a.id, a.symbol, rec.ctx, rec.r, rec.t || this.now());
          n++;
        }
      }
    }
    this.state.seeded = true;
    this.#touch();
    return n;
  }

  // ---- what it remembers -------------------------------------------------------------------
  // Trades like this one, across the whole floor.
  recall(symbol, ctx) {
    const key = situationKey(symbol, ctx);
    const s = key && this.state.situations[key];
    if (!s) return { key, n: 0, ready: false };
    const avgR = s.sum / (s.n + PRIOR);
    const winRate = s.n > 0 ? s.wins / s.n : null;
    const { text } = situationLabel(key);
    const ready = s.n >= MIN_N;
    return {
      key, n: round2(s.n), trades: s.trades, avgR: round2(avgR), winRate, ready,
      value: ready ? clamp(avgR / 0.25) : 0,
      text: `the floor's memory: ${s.trades} trade${s.trades === 1 ? '' : 's'} like this (${symbol}, ${text}) averaged ${fmtR(s.sum / Math.max(1e-9, s.n))}, ${Math.round((winRate || 0) * 100)}% won`,
    };
  }

  // The knowledge graph for the Brain tab.
  graph(agents = []) {
    const nodes = [];
    const links = [];
    const has = new Set();
    const add = (n) => {
      if (has.has(n.id)) return;
      has.add(n.id);
      nodes.push(n);
    };
    const markets = new Set();
    for (const a of agents) {
      add({ id: `desk:${a.id}`, type: 'desk', agentId: a.id, label: a.profile.name.split(' ')[0], sub: a.profile.desk });
      for (const sym of a.profile.lab ? [] : a.symbols.slice(0, 1)) {
        markets.add(sym);
        links.push({ s: `desk:${a.id}`, t: `mkt:${sym}`, kind: 'trades' });
      }
    }
    for (const [key, s] of Object.entries(this.state.situations)) markets.add(key.split('|')[0]);
    for (const sym of markets) add({ id: `mkt:${sym}`, type: 'market', label: sym });
    const syms = [...markets];
    for (let i = 0; i < syms.length; i++) {
      for (let j = i + 1; j < syms.length; j++) {
        if (GROUPS[syms[i]] && GROUPS[syms[i]] === GROUPS[syms[j]]) links.push({ s: `mkt:${syms[i]}`, t: `mkt:${syms[j]}`, kind: 'correlated' });
      }
    }
    for (const [key, s] of Object.entries(this.state.situations)) {
      const { symbol, text } = situationLabel(key);
      const avg = s.sum / Math.max(1e-9, s.n);
      add({ id: `sit:${key}`, type: 'situation', label: text, symbol, trades: s.trades, n: round2(s.n), avgR: round2(avg), shrunk: round2(s.sum / (s.n + PRIOR)), winRate: s.n ? round2(s.wins / s.n) : null, last: s.last, ready: s.n >= MIN_N });
      links.push({ s: `sit:${key}`, t: `mkt:${symbol}`, kind: 'of' });
      for (const [id, d] of Object.entries(s.byDesk)) {
        if (has.has(`desk:${id}`)) links.push({ s: `desk:${id}`, t: `sit:${key}`, kind: 'took', trades: d.trades, avgR: round2(d.sumR / d.trades) });
      }
    }
    for (const l of this.state.lessons) {
      if (!has.has(`desk:${l.agentId}`)) continue;
      add({ id: `lesson:${l.id}`, type: 'lesson', label: l.title, agentId: l.agentId, time: l.time, status: l.status });
      links.push({ s: `lesson:${l.id}`, t: `desk:${l.agentId}`, kind: 'learned' });
    }
    for (const [k, r] of Object.entries(this.state.reviews)) {
      const [from, to] = k.split('>');
      if (has.has(`desk:${from}`) && has.has(`desk:${to}`)) links.push({ s: `desk:${from}`, t: `desk:${to}`, kind: 'reviews', n: r.n, agree: r.agree, disagree: r.disagree });
    }
    const sits = nodes.filter((n) => n.type === 'situation');
    const strongest = sits.filter((n) => n.ready).sort((a, b) => Math.abs(b.shrunk) - Math.abs(a.shrunk)).slice(0, 6);
    return {
      nodes, links, events: this.events.slice(-20),
      stats: { trades: this.state.trades, situations: sits.length, ready: sits.filter((n) => n.ready).length, lessons: this.state.lessons.length, reviews: Object.values(this.state.reviews).reduce((s, r) => s + r.n, 0) },
      strongest: strongest.map((n) => ({ id: n.id, symbol: n.symbol, label: n.label, trades: n.trades, avgR: n.avgR, winRate: n.winRate })),
      minN: MIN_N,
    };
  }

  // ---- housekeeping -------------------------------------------------------------------------
  #event(e) {
    const ev = { id: ++this.seq, t: this.now(), ...e };
    this.events.push(ev);
    if (this.events.length > EVENTS_KEPT) this.events.shift();
    this.emit('event', ev);
  }

  #touch() {
    this.state.updatedAt = this.now();
    if (!this.file || this.timer) return;
    this.timer = setTimeout(() => {
      this.timer = null;
      this.save();
    }, 5000);
    this.timer.unref?.();
  }

  save() {
    if (!this.file) return;
    try {
      fs.mkdirSync(path.dirname(this.file), { recursive: true });
      const tmp = `${this.file}.tmp`;
      fs.writeFileSync(tmp, JSON.stringify(this.state), { mode: 0o600 });
      fs.renameSync(tmp, this.file);
    } catch (err) {
      this.log.warn?.(`[memory] could not save: ${err.message}`);
    }
  }

  flush() {
    clearTimeout(this.timer);
    this.timer = null;
    this.save();
  }
}
