import fs from 'node:fs';
import path from 'node:path';
import { EventEmitter } from 'node:events';
import Anthropic from '@anthropic-ai/sdk';
import { MODELS, DEFAULT_MODEL, costOf } from './models.js';
import { REVIEW_SYSTEM, REFLECT_SYSTEM, CHAT_SYSTEM, REVIEW_SCHEMA, REFLECT_SCHEMA } from './prompts.js';
import { setupBrief, tradesSince, accountBrief } from './context.js';
import { CHAT_TOOLS, runTool } from './tools.js';
import { netReason } from '../util/net.js';
import { nyParts, nyDateKey } from '../market/session.js';
import { sessionOf } from '../engine/roster.js';
import { tradeCostR } from '../market/symbols.js';

// The floor's LLM brain: Claude, reading the floor the way a senior trader would, next to the
// neural brain (numbers it learned from thousands of trades) and the floor memory (how each
// situation went).
//
//   review   a desk's setup arms: Claude reads the setup, the market's top-down read, the
//            liquidity around it, the news ahead, the floor's memory of trades like it, its own
//            lesson book and its past calls on that desk, and gives a calibrated verdict
//            (take or skip, the chance of profit, the R it expects, why). Before the entry
//            fills, so it never slows a trade down.
//   score    the trade closes: the verdict is scored against what happened, and so is every
//            lesson it relied on. Its record says whether its skips really lose and its takes
//            really win.
//   reflect  after the New York close: it reads the day (trades, setups, what was held back,
//            its own calls and how they did) and keeps its lesson book honest: new lessons
//            where the evidence supports one, lessons the evidence contradicts retired. The
//            lessons go into the floor memory too.
//   chat     the boss asks it anything in the Brain tab; it looks at the floor's live data
//            through read-only tools before it answers.
//
// It learns the way large language models learn after their training: it can't be retrained
// on this computer, but it reads its own experience before every decision (a lesson book
// that is scored and pruned by results, and its past calls on the same desk with how they
// turned out), and its say grows only with its measured record. It advises by default. In
// veto mode, which the boss switches on, it may hold back a setup it calls a clear skip, and
// only once its record has earned it (see LLM.trust); it can never add a trade, make one
// bigger or touch the account's own rules. Trades it held back are followed on paper to the
// stop or the target, so it keeps learning whether it was right.
//
// The API key is the boss's own (console.anthropic.com), kept in data/llm/key.json (readable
// by this user only) or ANTHROPIC_API_KEY in .env, and never sent to the browser. Spending
// stops at a daily cap the boss sets.

export const LLM = {
  budgetUsd: 2, // default daily cap on what the brain may spend (US dollars)
  modes: ['off', 'advise', 'veto'],
  queueMaxAgeMs: 10 * 60_000, // a setup still waiting in the queue after this isn't reviewed
  concurrency: 2,
  matchMs: 3 * 3_600_000, // a review applies to a fill this long after it
  // When its verdicts have earned a say: enough trades judged, enough skips among them, and
  // the trades it said to skip clearly worse than the ones it said to take (and losing).
  trust: { minN: 30, minSkips: 8, minLift: 0.3 },
  vetoBelow: 0.3, // veto mode: a skip below this chance of profit holds the trade back
  lessonsKept: 60,
  lessonsInReview: 12,
  retireAfterWrong: 3, // a lesson wrong this many times more than it was right is retired
  reviewsKept: 400,
  chatMessages: 80, // a conversation longer than this starts afresh (it's never edited)
  chatToolRounds: 8,
  reflectAt: 17 * 60 + 10, // New York minutes: after the 17:00 close
  virtualMaxMs: 24 * 3_600_000, // a held-back trade followed on paper this long at most
  maxTokens: { review: 8000, reflect: 16000, chat: 16000 },
  effort: { review: 'medium', reflect: 'high', chat: 'medium' },
  saveMs: 3000,
};

const FALLBACK_BETA = 'server-side-fallback-2026-07-01';
const KEY_RE = /^sk-ant-[A-Za-z0-9_-]{20,}$/;
const round = (x, d = 2) => (Number.isFinite(x) ? Math.round(x * 10 ** d) / 10 ** d : null);
const clamp = (x, lo, hi) => Math.max(lo, Math.min(hi, x));
const mean = (xs) => (xs.length ? xs.reduce((s, x) => s + x, 0) / xs.length : null);
const readJson = (file) => {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch {
    return null;
  }
};

export class LlmError extends Error {
  constructor(text, kind = 'error') {
    super(text);
    this.kind = kind;
  }
}

// A plain explanation of what went wrong talking to Anthropic, and whether to try again later.
export function explainApiError(err) {
  if (err instanceof LlmError) return { text: err.message, kind: err.kind };
  if (err instanceof Anthropic.AuthenticationError) return { text: 'Anthropic rejected the API key (it was deleted or mistyped). Paste a current key from console.anthropic.com.', kind: 'key' };
  if (err instanceof Anthropic.PermissionDeniedError) return { text: 'This API key has no access to the chosen model. Pick another model, or check the key\'s workspace in console.anthropic.com.', kind: 'key' };
  if (err instanceof Anthropic.NotFoundError) return { text: 'Anthropic doesn\'t know that model. Pick another one.', kind: 'model' };
  if (err instanceof Anthropic.RateLimitError) return { text: 'Anthropic is rate-limiting this key; the brain tries again on the next setup.', kind: 'rate' };
  if (err instanceof Anthropic.BadRequestError) return { text: `Anthropic refused the request: ${err.error?.error?.message || err.message}${/credit/i.test(err.message) ? ' (add credit in console.anthropic.com → Billing)' : ''}`, kind: 'request' };
  if (err instanceof Anthropic.APIConnectionError) return { text: `Couldn't reach Anthropic: ${netReason(err.cause || err).text}`, kind: 'network' };
  if (err instanceof Anthropic.APIError) return { text: `Anthropic had a problem (HTTP ${err.status ?? '?'}); the brain tries again later.`, kind: 'server' };
  return { text: err?.message || String(err), kind: 'error' };
}

const blankState = () => ({ v: 1, seq: 0, reviews: [], lessons: [], virtual: [], spend: { day: null, usd: 0, calls: 0, month: null, monthUsd: 0, total: 0 }, reflections: [], chat: { messages: [], at: 0, started: 0 } });

export class LlmBrain extends EventEmitter {
  constructor({ dataDir = null, mode = 'live', floor, log = console, now = () => Date.now(), clientFactory = null, env = process.env } = {}) {
    super();
    this.dir = dataDir ? path.join(dataDir, 'llm') : null;
    this.mode = mode;
    this.floor = floor;
    this.log = log;
    this.now = now;
    this.env = env;
    this.clientFactory = clientFactory || ((apiKey) => new Anthropic({ apiKey, maxRetries: 2, timeout: 180_000 }));
    this.settings = { model: DEFAULT_MODEL, mode: 'advise', budgetUsd: LLM.budgetUsd };
    this.state = blankState();
    this.key = null;
    this.keySource = null;
    this.client = null;
    this.lastError = null;
    this.queue = [];
    this.active = 0;
    this.chatBusy = null;
    this.reflecting = false;
    this.saveTimer = null;
    this.#load();
  }

  // ---- files and key --------------------------------------------------------------------------
  #file(name) {
    return this.dir ? path.join(this.dir, name) : null;
  }

  #load() {
    const st = this.dir ? readJson(this.#file('state.json')) : null;
    if (st && typeof st === 'object') {
      const b = blankState();
      this.state = { ...b, ...st, spend: { ...b.spend, ...st.spend }, chat: { ...b.chat, ...st.chat } };
      for (const k of ['reviews', 'lessons', 'virtual', 'reflections']) if (!Array.isArray(this.state[k])) this.state[k] = [];
      if (!Array.isArray(this.state.chat.messages)) this.state.chat.messages = [];
    }
    const s = this.dir ? readJson(this.#file('settings.json')) : null;
    if (s) this.#applySettings(s);
    const k = this.dir ? readJson(this.#file('key.json')) : null;
    if (k?.apiKey && KEY_RE.test(k.apiKey)) {
      this.key = k.apiKey;
      this.keySource = 'saved';
    } else if (this.env.ANTHROPIC_API_KEY) {
      this.key = this.env.ANTHROPIC_API_KEY;
      this.keySource = 'env';
    }
  }

  #applySettings(s = {}) {
    if (MODELS[s.model]) this.settings.model = s.model;
    if (LLM.modes.includes(s.mode)) this.settings.mode = s.mode;
    const b = Number(s.budgetUsd);
    if (Number.isFinite(b)) this.settings.budgetUsd = clamp(Math.round(b * 100) / 100, 0, 100);
  }

  #save(now = false) {
    if (!this.dir) return;
    const write = () => {
      this.saveTimer = null;
      try {
        fs.mkdirSync(this.dir, { recursive: true, mode: 0o700 });
        const tmp = this.#file('state.json.tmp');
        fs.writeFileSync(tmp, JSON.stringify(this.state), { mode: 0o600 });
        fs.renameSync(tmp, this.#file('state.json'));
        fs.writeFileSync(this.#file('settings.json'), JSON.stringify(this.settings, null, 2), { mode: 0o600 });
      } catch (err) {
        this.log.warn?.(`[llm] couldn't save: ${err.message}`);
      }
    };
    if (now) {
      clearTimeout(this.saveTimer);
      return write();
    }
    if (this.saveTimer) return;
    this.saveTimer = setTimeout(write, LLM.saveMs);
    this.saveTimer.unref?.();
  }

  #changed() {
    this.#save();
    this.emit('update');
  }

  #api() {
    if (!this.key) throw new LlmError('Claude isn\'t connected: add your Anthropic API key in the Brain tab.', 'off');
    if (!this.client) this.client = this.clientFactory(this.key);
    return this.client;
  }

  get connected() {
    return !!this.key;
  }

  // Check a key with Anthropic (it reads the model's details, which costs nothing), then keep it.
  async setKey(apiKey) {
    const key = String(apiKey || '').trim();
    if (!KEY_RE.test(key)) return { ok: false, error: 'That doesn\'t look like an Anthropic API key (it starts with sk-ant-). Create one at console.anthropic.com → API keys.' };
    try {
      await this.clientFactory(key).models.retrieve(this.settings.model);
    } catch (err) {
      return { ok: false, error: explainApiError(err).text };
    }
    this.key = key;
    this.keySource = 'saved';
    this.client = null;
    this.lastError = null;
    if (this.dir) {
      fs.mkdirSync(this.dir, { recursive: true, mode: 0o700 });
      fs.writeFileSync(this.#file('key.json'), JSON.stringify({ apiKey: key, at: this.now() }), { mode: 0o600 });
    }
    this.log.info?.('[llm] Claude connected');
    this.#changed();
    return { ok: true };
  }

  forgetKey() {
    if (this.dir) fs.rmSync(this.#file('key.json'), { force: true });
    this.key = this.env.ANTHROPIC_API_KEY || null;
    this.keySource = this.key ? 'env' : null;
    this.client = null;
    this.#changed();
    return { ok: true };
  }

  configure(body = {}) {
    const before = this.settings.model;
    this.#applySettings(body);
    if (this.settings.model !== before) this.client = null;
    this.#changed();
    return { ok: true };
  }

  // ---- spending -------------------------------------------------------------------------------
  #rollSpend() {
    const t = this.now();
    const day = nyDateKey(t);
    const month = day.slice(0, 7);
    const s = this.state.spend;
    if (s.day !== day) Object.assign(s, { day, usd: 0, calls: 0 });
    if (s.month !== month) Object.assign(s, { month, monthUsd: 0 });
    return s;
  }

  get budgetLeft() {
    return Math.max(0, this.settings.budgetUsd - this.#rollSpend().usd);
  }

  // One request to Claude, with the floor's rules around it: the daily cap, the cost counted,
  // a refusal or a cut-off answer reported as such.
  async #call(kind, { system, messages, tools = null, schema = null }) {
    const client = this.#api();
    if (this.budgetLeft <= 0) throw new LlmError(`Today's budget ($${this.settings.budgetUsd.toFixed(2)}) is spent; Claude is back tomorrow (raise it in the Brain tab).`, 'budget');
    const model = this.settings.model;
    const body = {
      model,
      max_tokens: LLM.maxTokens[kind],
      system: [{ type: 'text', text: system, cache_control: { type: 'ephemeral' } }],
      messages,
      output_config: { effort: LLM.effort[kind], ...(schema ? { format: { type: 'json_schema', schema } } : {}) },
      ...(tools ? { tools } : {}),
    };
    const t0 = this.now();
    // A request the model declines is re-run on Anthropic's recommended fallback model (Opus
    // and Sonnet; Haiku has none).
    const res = MODELS[model].fallbacks
      ? await client.beta.messages.create({ ...body, betas: [FALLBACK_BETA], fallbacks: 'default' })
      : await client.messages.create(body);
    const cost = costOf(MODELS[res.model] ? res.model : model, res.usage || {});
    const s = this.#rollSpend();
    s.usd += cost;
    s.calls++;
    s.monthUsd += cost;
    s.total = (s.total || 0) + cost;
    if (res.stop_reason === 'refusal') throw new LlmError('Claude declined to answer this one.', 'refusal');
    return { res, cost, ms: this.now() - t0 };
  }

  #json(res) {
    if (res.stop_reason === 'max_tokens') throw new LlmError('Claude\'s answer was cut off.', 'cut');
    const text = res.content.filter((b) => b.type === 'text').map((b) => b.text).join('');
    try {
      return JSON.parse(text);
    } catch {
      throw new LlmError('Claude\'s answer wasn\'t in the expected form.', 'format');
    }
  }

  #failed(err, what) {
    const e = explainApiError(err);
    this.lastError = { text: e.text, kind: e.kind, what, at: this.now() };
    if (e.kind !== 'budget') this.log.warn?.(`[llm] ${what}: ${e.text}`);
    return e;
  }

  // ---- reviews --------------------------------------------------------------------------------
  // Reviews run on real prices only, with Claude connected and the brain not off.
  get reviewing() {
    return this.mode === 'live' && this.connected && this.settings.mode !== 'off';
  }

  // A desk's setup just armed (engine/strategies/dayTrader.js). The review runs in the
  // background; the desk carries on.
  onSetup(agent, order) {
    if (!this.reviewing || !agent || !order) return null;
    const t = this.now();
    const risk = Math.abs(order.entry - order.stop);
    const rev = {
      id: `rv${++this.state.seq}`,
      at: t,
      desk: agent.id,
      name: agent.profile.name,
      symbol: agent.symbol,
      side: order.side,
      entry: order.entry,
      stop: order.stop,
      target: order.target ?? null,
      rr: order.target != null && risk > 0 ? round(Math.abs(order.target - order.entry) / risk) : null,
      costR: round(tradeCostR(agent.symbol, order.entry, order.stop)),
      reason: order.reason,
      session: sessionOf(agent.profile),
      status: 'queued',
    };
    this.state.reviews.push(rev);
    if (this.state.reviews.length > LLM.reviewsKept) this.state.reviews.splice(0, this.state.reviews.length - LLM.reviewsKept);
    this.queue.push({ rev, agent, order });
    this.emit('review', rev);
    this.#changed();
    this.#pump();
    return rev.id;
  }

  #pump() {
    while (this.active < LLM.concurrency && this.queue.length) {
      const job = this.queue.shift();
      if (this.now() - job.rev.at > LLM.queueMaxAgeMs) {
        Object.assign(job.rev, { status: 'skipped', note: 'waited too long in the queue' });
        continue;
      }
      this.active++;
      this.#review(job).finally(() => {
        this.active--;
        this.#pump();
      });
    }
  }

  async #review({ rev, agent, order }) {
    rev.status = 'thinking';
    this.emit('review', rev);
    try {
      const brief = setupBrief(this.floor, agent, order);
      const lessons = this.lessonsFor(rev.symbol, rev.session).map((l) => ({ id: l.id, kind: l.kind, text: l.text, right: l.right, wrong: l.wrong }));
      const past = this.state.reviews.filter((r) => r !== rev && r.outcome && r.verdict && (r.desk === rev.desk || r.symbol === rev.symbol)).slice(-6)
        .map((r) => ({ desk: r.desk, side: r.side, said: r.verdict, p: r.p, result: `${r.outcome.r >= 0 ? '+' : ''}${r.outcome.r}R`, how: r.outcome.how, why: r.reasons?.[0] || null }));
      const rec = this.record();
      const content = [
        `${rev.name}'s ${rev.side === 'LONG' ? 'buy' : 'sell'} setup on ${rev.symbol} just armed. Judge it before the entry fills.`,
        `<setup>${JSON.stringify(brief)}</setup>`,
        `<lesson_book>${JSON.stringify(lessons)}</lesson_book>`,
        `<your_past_calls_on_this_desk_or_market>${JSON.stringify(past)}</your_past_calls_on_this_desk_or_market>`,
        `<your_record>${JSON.stringify({ judged: rec.n, takes: rec.takes, skips: rec.skips })}</your_record>`,
      ].join('\n\n');
      const { res, cost, ms } = await this.#call('review', { system: REVIEW_SYSTEM, messages: [{ role: 'user', content }], schema: REVIEW_SCHEMA });
      const out = this.#json(res);
      const known = new Set(this.state.lessons.map((l) => l.id));
      Object.assign(rev, {
        status: 'done',
        verdict: out.verdict === 'skip' ? 'skip' : 'take',
        p: round(clamp(Number(out.p_win) || 0, 0.01, 0.99)),
        expR: round(Number(out.expected_r)),
        reasons: (out.reasons || []).slice(0, 4).map(String),
        risks: (out.risks || []).slice(0, 3).map(String),
        lessonsUsed: (out.lessons_used || []).filter((id) => known.has(id)).slice(0, 6),
        model: res.model || this.settings.model,
        cost: round(cost, 4),
        ms,
      });
      for (const l of this.state.lessons) if (rev.lessonsUsed.includes(l.id)) l.used = (l.used || 0) + 1;
      const pct = Math.round(rev.p * 100);
      agent.note?.(`Claude on my ${rev.symbol} setup: ${rev.verdict === 'take' ? 'take it' : 'skip it'} (${pct}% chance of profit)${rev.reasons[0] ? `: ${rev.reasons[0]}` : ''}`, 'llm');
      this.floor.memory?.onLlmReview?.(rev);
    } catch (err) {
      const e = this.#failed(err, 'review');
      Object.assign(rev, { status: e.kind === 'budget' ? 'skipped' : 'failed', note: e.text });
    }
    this.emit('review', rev);
    this.#changed();
  }

  // The desk is about to take a trade (engine/agent.js openTrade): link it to the review of
  // its setup, and in veto mode, once Claude has earned it, hold back a clear skip.
  gate(agent, { symbol, side, entry, stop, tag = '' } = {}) {
    if (tag === 'TV' || !agent) return null;
    const t = this.now();
    const risk = Math.abs(entry - stop) || 1;
    let rev = null;
    for (let i = this.state.reviews.length - 1; i >= 0; i--) {
      const r = this.state.reviews[i];
      if (t - r.at > LLM.matchMs) break;
      if (r.desk === agent.id && r.symbol === symbol && r.side === side && !r.linked && Math.abs(r.entry - entry) <= 0.5 * risk) {
        rev = r;
        break;
      }
    }
    if (!rev) return null;
    rev.linked = t;
    const veto = this.settings.mode === 'veto' && this.record().trusted && rev.status === 'done' && rev.verdict === 'skip' && rev.p < LLM.vetoBelow;
    if (veto) {
      rev.vetoed = true;
      this.state.virtual.push({ id: rev.id, symbol, side, entry, stop: rev.stop, target: rev.target, costR: rev.costR || 0, from: t });
      this.#changed();
      return { take: false, id: rev.id, reason: `Claude held it back (${Math.round(rev.p * 100)}% chance of profit)${rev.reasons?.[0] ? `: ${rev.reasons[0]}` : ''}` };
    }
    this.#changed();
    return { take: true, id: rev.id, verdict: rev.verdict ?? null, p: rev.p ?? null };
  }

  // A trade closed (engine/agent.js): score the review it was linked to.
  observe(agent, trade) {
    const id = trade?.llm?.id;
    if (!id || trade.simFeed || trade.cancelled || !Number.isFinite(trade.r)) return;
    const rev = this.state.reviews.find((r) => r.id === id);
    if (!rev || rev.outcome) return;
    this.#settle(rev, { r: trade.r, exit: trade.exitReason || null, at: trade.closeTime ?? this.now(), how: 'traded' });
  }

  #settle(rev, { r, exit, at, how }) {
    rev.outcome = { r: round(r), won: r > 0, exit, at, how };
    if (rev.verdict) {
      rev.right = (rev.verdict === 'take') === (r > 0);
      for (const l of this.state.lessons) {
        if (!rev.lessonsUsed?.includes(l.id)) continue;
        if (rev.right) l.right = (l.right || 0) + 1;
        else l.wrong = (l.wrong || 0) + 1;
        if (!l.retired && (l.wrong || 0) - (l.right || 0) >= LLM.retireAfterWrong) Object.assign(l, { retired: at, retiredWhy: 'kept being wrong' });
      }
    }
    this.emit('outcome', rev);
    this.floor.memory?.onLlmOutcome?.(rev);
    this.#changed();
  }

  // Trades it held back, followed on paper to the stop or the target: the brain learns from
  // the trades it vetoes too (a stop and a target in the same bar count as the stop).
  onBar(symbol, bar) {
    const open = this.state.virtual;
    if (!open.length) return;
    let changed = false;
    for (let i = open.length - 1; i >= 0; i--) {
      const v = open[i];
      if (v.symbol !== symbol || !bar) continue;
      const long = v.side === 'LONG';
      const risk = Math.abs(v.entry - v.stop) || 1;
      let r = null;
      let exit = null;
      if (long ? bar.low <= v.stop : bar.high >= v.stop) { r = -1; exit = 'Stop loss (on paper)'; } else if (v.target != null && (long ? bar.high >= v.target : bar.low <= v.target)) { r = Math.abs(v.target - v.entry) / risk; exit = 'Target hit (on paper)'; } else if (this.now() - v.from > LLM.virtualMaxMs) { r = ((long ? 1 : -1) * (bar.close - v.entry)) / risk; exit = 'Closed after a day (on paper)'; }
      if (r == null) continue;
      open.splice(i, 1);
      const rev = this.state.reviews.find((x) => x.id === v.id);
      if (rev && !rev.outcome) this.#settle(rev, { r: r - (v.costR || 0), exit, at: this.now(), how: 'held back' });
      changed = true;
    }
    if (changed) this.#changed();
  }

  // Its record: are the trades it says to skip really worse than the ones it says to take?
  record() {
    const judged = this.state.reviews.filter((r) => r.verdict && r.outcome);
    const side = (v) => {
      const xs = judged.filter((r) => r.verdict === v);
      return { n: xs.length, avgR: round(mean(xs.map((r) => r.outcome.r))), winRate: xs.length ? round(xs.filter((r) => r.outcome.won).length / xs.length) : null };
    };
    const takes = side('take');
    const skips = side('skip');
    const lift = takes.avgR != null && skips.avgR != null ? round(takes.avgR - skips.avgR) : null;
    const brier = judged.length ? round(mean(judged.map((r) => (r.p - (r.outcome.won ? 1 : 0)) ** 2)), 3) : null;
    const T = LLM.trust;
    const trusted = judged.length >= T.minN && skips.n >= T.minSkips && lift != null && lift >= T.minLift && skips.avgR < 0;
    return {
      n: judged.length, takes, skips, lift, brier,
      right: judged.length ? round(judged.filter((r) => r.right).length / judged.length) : null,
      trusted,
      toTrust: trusted ? null : `${Math.min(judged.length, T.minN)} of ${T.minN} trades judged, ${Math.min(skips.n, T.minSkips)} of ${T.minSkips} skips${lift != null ? `, its takes ${lift >= 0 ? `${lift}R better` : `${-lift}R worse`} than its skips (needs ${T.minLift}R better, with the skips losing)` : ''}`,
    };
  }

  // ---- lessons --------------------------------------------------------------------------------
  // The lessons that apply here, best first.
  lessonsFor(symbol, session) {
    const score = (l) => (l.right || 0) - (l.wrong || 0) + (l.confidence || 0.5) + (l.source === 'boss' ? 2 : 0);
    return this.state.lessons
      .filter((l) => !l.retired && (!l.symbol || l.symbol === symbol) && (!l.session || l.session === session))
      .sort((a, b) => score(b) - score(a))
      .slice(0, LLM.lessonsInReview);
  }

  #addLesson({ text, symbol = '', session = '', kind = 'note', confidence = 0.5, source = 'reflection' }) {
    const clean = String(text || '').trim().slice(0, 400);
    if (!clean) return null;
    const same = this.state.lessons.find((l) => !l.retired && l.text.toLowerCase() === clean.toLowerCase());
    if (same) return null;
    const lesson = {
      id: `L${++this.state.seq}`, text: clean,
      symbol: String(symbol || '').toUpperCase(), session: ['london', 'ny', 'asia'].includes(session) ? session : '',
      kind: ['avoid', 'prefer', 'note'].includes(kind) ? kind : 'note', confidence: round(clamp(Number(confidence) || 0.5, 0, 1)),
      source, created: this.now(), used: 0, right: 0, wrong: 0, retired: null,
    };
    this.state.lessons.push(lesson);
    // Room for new lessons: the retired ones go first, then the weakest.
    while (this.state.lessons.length > LLM.lessonsKept) {
      const i = this.state.lessons.findIndex((l) => l.retired);
      this.state.lessons.splice(i >= 0 ? i : 0, 1);
    }
    this.floor.memory?.onLlmLesson?.(lesson);
    return lesson;
  }

  // The boss teaches it something directly: kept first in line.
  teach(text, { symbol = '', session = '' } = {}) {
    const l = this.#addLesson({ text, symbol, session, kind: 'note', confidence: 0.8, source: 'boss' });
    if (!l) return { ok: false, error: 'Nothing new to learn there (empty, or already in the book).' };
    this.#changed();
    return { ok: true, lesson: l };
  }

  forgetLesson(id) {
    const l = this.state.lessons.find((x) => x.id === id);
    if (!l) return { ok: false, error: 'No such lesson.' };
    Object.assign(l, { retired: this.now(), retiredWhy: 'retired by the boss' });
    this.#changed();
    return { ok: true };
  }

  // ---- reflection -----------------------------------------------------------------------------
  // Once a trading day, after the New York close (weekdays, real prices only).
  tick() {
    if (!this.reviewing || this.reflecting) return;
    const t = this.now();
    const p = nyParts(t);
    if (/^(Sat|Sun)/.test(p.weekday) || p.hour * 60 + p.minute < LLM.reflectAt) return;
    const day = nyDateKey(t);
    if (this.state.reflections.some((r) => r.day === day && r.ok)) return;
    const tried = this.state.reflections.findLast?.((r) => r.day === day) ?? null;
    if (tried && t - tried.at < 2 * 3_600_000) return;
    this.reflect('evening').catch(() => {});
  }

  async reflect(why = 'asked') {
    if (this.reflecting) return { ok: false, error: 'Claude is already reflecting.' };
    if (!this.connected) return { ok: false, error: 'Connect Claude first (Anthropic API key).' };
    this.reflecting = true;
    this.emit('update');
    const t = this.now();
    const day = nyDateKey(t);
    try {
      const since = t - 24 * 3_600_000;
      const fund = this.floor.fund;
      const reviews = this.state.reviews.filter((r) => r.at >= since).map((r) => ({ id: r.id, desk: r.desk, symbol: r.symbol, side: r.side, rr: r.rr, said: r.verdict ?? r.status, p: r.p ?? null, reasons: r.reasons ?? [], held: !!r.vetoed, result: r.outcome ? { r: r.outcome.r, exit: r.outcome.exit, how: r.outcome.how } : r.linked ? 'still open' : 'never filled' }));
      const input = {
        day,
        trades: tradesSince(fund, since, { max: 80 }),
        desks: fund.agents.map((a) => ({ id: a.id, name: a.profile.name, market: a.symbol, session: sessionOf(a.profile), ideas: a.day.ideas, entries: a.day.entries, heldBack: a.day.vetoed + a.day.skipped, story: a.dayStory?.()?.text ?? null })),
        account: (() => { const a = accountBrief(this.floor.live); return a ? { mt5: a.mt5, armed: a.armed, today: a.today, warnings: a.warnings } : null; })(),
        yourVerdictsToday: reviews,
        yourRecord: this.record(),
        lessonBook: this.state.lessons.filter((l) => !l.retired).map((l) => ({ id: l.id, kind: l.kind, text: l.text, symbol: l.symbol, session: l.session, used: l.used, right: l.right, wrong: l.wrong, from: l.source })),
      };
      const content = `The trading day ${day} is over (${why === 'asked' ? 'the boss asked for your review now' : 'evening review'}). Here it is:\n\n<day>${JSON.stringify(input)}</day>`;
      const { res, cost } = await this.#call('reflect', { system: REFLECT_SYSTEM, messages: [{ role: 'user', content }], schema: REFLECT_SCHEMA });
      const out = this.#json(res);
      const added = [];
      for (const l of (out.lessons || []).slice(0, 5)) {
        const lesson = this.#addLesson({ ...l, source: 'reflection' });
        if (lesson) added.push(lesson.id);
      }
      const retired = [];
      for (const id of out.retire || []) {
        const l = this.state.lessons.find((x) => x.id === id && !x.retired);
        if (l && l.source !== 'boss') {
          Object.assign(l, { retired: t, retiredWhy: 'the evidence turned against it' });
          retired.push(id);
        }
      }
      for (const n of (out.desk_notes || []).slice(0, 10)) fund.byId.get(String(n.desk || '').toLowerCase())?.note?.(`Note from Claude: ${String(n.note).slice(0, 300)}`, 'llm');
      const entry = { day, at: t, ok: true, why, summary: String(out.summary || '').slice(0, 1500), added, retired, cost: round(cost, 4) };
      this.state.reflections.push(entry);
      if (this.state.reflections.length > 60) this.state.reflections.shift();
      this.emit('reflection', entry);
      return { ok: true, reflection: entry };
    } catch (err) {
      const e = this.#failed(err, 'reflection');
      this.state.reflections.push({ day, at: t, ok: false, why, error: e.text });
      if (this.state.reflections.length > 60) this.state.reflections.shift();
      return { ok: false, error: e.text };
    } finally {
      this.reflecting = false;
      this.#changed();
    }
  }

  // ---- chat -----------------------------------------------------------------------------------
  // The boss asks; Claude looks at the floor through read-only tools and answers. The
  // conversation is only ever added to (never edited), and starts afresh when it gets long.
  async ask(question) {
    const q = String(question || '').trim().slice(0, 4000);
    if (!q) return { ok: false, error: 'Ask something.' };
    if (this.chatBusy) return { ok: false, error: 'Claude is still answering the last question.' };
    if (!this.connected) return { ok: false, error: 'Connect Claude first (Anthropic API key).' };
    if (this.state.chat.messages.length > LLM.chatMessages) this.newChat();
    const chat = this.state.chat;
    if (!chat.messages.length) chat.started = this.now();
    // Each turn is stored as sent: the user's text, Claude's full answer blocks, tool results.
    const thread = chat.messages;
    const ui = (chat.ui ||= []);
    thread.push({ role: 'user', content: q });
    ui.push({ role: 'user', text: q, at: this.now() });
    this.chatBusy = { question: q, steps: [], at: this.now() };
    this.emit('update');
    let cost = 0;
    let answer = '';
    try {
      const tools = CHAT_TOOLS.map((t) => ({ ...t, strict: true }));
      for (let round = 0; round < LLM.chatToolRounds; round++) {
        const { res, cost: c } = await this.#call('chat', { system: CHAT_SYSTEM, messages: thread, tools });
        cost += c;
        thread.push({ role: 'assistant', content: res.content });
        if (res.stop_reason === 'pause_turn') continue;
        const uses = res.content.filter((b) => b.type === 'tool_use');
        if (res.stop_reason !== 'tool_use' || !uses.length) {
          answer = res.content.filter((b) => b.type === 'text').map((b) => b.text).join('\n').trim();
          break;
        }
        const results = uses.map((u) => {
          this.chatBusy.steps.push(u.name);
          this.emit('update');
          try {
            return { type: 'tool_result', tool_use_id: u.id, content: JSON.stringify(runTool(u.name, u.input || {}, { floor: this.floor, brain: this })) };
          } catch (err) {
            return { type: 'tool_result', tool_use_id: u.id, is_error: true, content: `The tool failed: ${err.message}` };
          }
        });
        thread.push({ role: 'user', content: results });
      }
      if (!answer) answer = 'I looked through the floor but ran out of steps before I could answer. Ask again, or ask something narrower.';
      ui.push({ role: 'assistant', text: answer, at: this.now(), cost: round(cost, 4), steps: this.chatBusy.steps.slice() });
      return { ok: true, answer, cost: round(cost, 4) };
    } catch (err) {
      const e = this.#failed(err, 'chat');
      // The question stays answered with the error, so the conversation stays well-formed.
      if (thread.at(-1)?.role === 'user') thread.push({ role: 'assistant', content: [{ type: 'text', text: `(No answer: ${e.text})` }] });
      ui.push({ role: 'assistant', text: `No answer: ${e.text}`, at: this.now(), error: true });
      return { ok: false, error: e.text };
    } finally {
      chat.at = this.now();
      this.chatBusy = null;
      this.#changed();
    }
  }

  newChat() {
    if (this.chatBusy) return { ok: false, error: 'Claude is still answering.' };
    this.state.chat = { messages: [], ui: [], at: this.now(), started: this.now() };
    this.#changed();
    return { ok: true };
  }

  // ---- what the Brain tab shows --------------------------------------------------------------
  reviewsView(n = 20) {
    return this.state.reviews.slice(-n).reverse().map((r) => ({
      id: r.id, at: r.at, desk: r.desk, name: r.name, symbol: r.symbol, side: r.side, rr: r.rr, reason: r.reason, status: r.status,
      verdict: r.verdict ?? null, p: r.p ?? null, expR: r.expR ?? null, reasons: r.reasons ?? [], risks: r.risks ?? [], lessonsUsed: r.lessonsUsed ?? [],
      vetoed: !!r.vetoed, linked: !!r.linked, outcome: r.outcome ?? null, right: r.right ?? null, note: r.note ?? null, cost: r.cost ?? null, model: r.model ?? null,
    }));
  }

  lessonsView() {
    return this.state.lessons.slice().reverse().map((l) => ({ id: l.id, text: l.text, symbol: l.symbol, session: l.session, kind: l.kind, source: l.source, created: l.created, used: l.used, right: l.right, wrong: l.wrong, retired: l.retired, retiredWhy: l.retiredWhy ?? null }));
  }

  view() {
    const s = this.#rollSpend();
    const status = !this.connected ? 'off' : this.budgetLeft <= 0 ? 'budget' : this.lastError && this.now() - this.lastError.at < 30 * 60_000 && ['key', 'network', 'request', 'model'].includes(this.lastError.kind) ? 'error' : 'ready';
    return {
      status,
      connected: this.connected,
      keySource: this.keySource,
      keyHint: this.key ? `…${this.key.slice(-4)}` : null,
      model: this.settings.model,
      models: Object.entries(MODELS).map(([id, m]) => ({ id, label: m.label, input: m.input, output: m.output })),
      mode: this.settings.mode,
      liveOnly: this.mode !== 'live',
      budgetUsd: this.settings.budgetUsd,
      spend: { today: round(s.usd, 3), calls: s.calls, month: round(s.monthUsd, 2), total: round(s.total || 0, 2) },
      record: this.record(),
      trust: LLM.trust,
      vetoBelow: LLM.vetoBelow,
      busy: { chat: this.chatBusy ? { question: this.chatBusy.question, steps: this.chatBusy.steps } : null, reflecting: this.reflecting, reviews: this.active + this.queue.length },
      reviews: this.reviewsView(25),
      lessons: this.lessonsView(),
      reflections: this.state.reflections.slice(-7).reverse(),
      chat: (this.state.chat.ui || []).slice(-40),
      lastError: this.lastError,
    };
  }

  stop() {
    this.#save(true);
  }
}
