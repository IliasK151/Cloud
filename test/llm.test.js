import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import Anthropic from '@anthropic-ai/sdk';

import { LlmBrain, LLM, explainApiError } from '../server/llm/brain.js';
import { costOf, MODELS, DEFAULT_MODEL } from '../server/llm/models.js';
import { REVIEW_SCHEMA, REFLECT_SCHEMA } from '../server/llm/prompts.js';
import { CHAT_TOOLS, runTool } from '../server/llm/tools.js';
import { FloorMemory } from '../server/brain/memory.js';
import { MarketClock, Session, nyWallToMs } from '../server/market/session.js';
import { MarketData } from '../server/market/marketData.js';
import { Broker } from '../server/engine/broker.js';
import { RiskManager } from '../server/engine/risk.js';
import { Fund } from '../server/engine/fund.js';

const KEY = 'sk-ant-api03-TESTKEYtestkeyTESTKEY1234';
const tick = () => new Promise((r) => setImmediate(r));
const until = async (f, ms = 2000) => {
  const end = Date.now() + ms;
  while (!f() && Date.now() < end) await new Promise((r) => setTimeout(r, 5));
  return f();
};

// A stand-in for Anthropic's API: answers from a script, records every request.
function fakeAnthropic(answer) {
  const calls = [];
  const create = (beta) => async (body) => {
    calls.push({ beta, body: structuredClone(body) });
    const out = await answer(body, calls.length);
    if (out instanceof Error) throw out;
    return { model: body.model, stop_reason: 'end_turn', usage: { input_tokens: 2000, output_tokens: 400 }, ...out };
  };
  return {
    calls,
    models: { retrieve: async (id) => ({ id }) },
    messages: { create: create(false) },
    beta: { messages: { create: create(true) } },
  };
}
const text = (obj) => ({ content: [{ type: 'thinking', thinking: '', signature: 'sig' }, { type: 'text', text: typeof obj === 'string' ? obj : JSON.stringify(obj) }] });

// A small floor: one desk with a top-down read, a market, a memory.
function floorWith({ memory = null } = {}) {
  const notes = [];
  const agent = {
    id: 'amara', symbol: 'XAUUSD',
    profile: { name: 'Amara Okafor', desk: 'Gold', rules: { zones: 'londonday' } },
    pb: { view: () => ({ kz: 'London session', levels: [{ label: 'Asia low', price: 3790, side: 'below' }, { label: 'Previous day high', price: 3840, side: 'above' }], sweep: { level: { label: 'Asia low', price: 3790 }, extreme: 3788 } }) },
    learner: { context: () => ({ trend: 'with', vol: 'normal', session: 'london' }), summary: () => ({ last: { title: 'Gold fades after the London open' } }) },
    env: { topDown: () => ({ read: () => ({ ready: true, bias: 'LONG', text: 'W ▲ · D ▲ · 4H ▲: bullish bias', strength: 3, aois: [{ tf: 'D', lo: 3770, hi: 3780 }], atrD: 40, zone: { word: 'discount' } }) }) },
    lifetime: { trades: 12, countR: 12, sumR: 3.6 },
    log: [],
    day: { ideas: 2, entries: 1, skipped: 0, vetoed: 0 },
    note: (t, k) => notes.push({ t, k }),
    dayStory: () => ({ text: 'Traded the London sweep' }),
    snapshot: () => ({ status: 'watching', setup: { stage: 'Waiting for the pullback' }, topDown: { text: 'W ▲ · D ▲ · 4H ▲' }, today: { ideas: 2, entries: 1, skipped: 0, vetoed: 0, whyNot: null, story: { text: 'Traded the London sweep' } }, positions: [], stats: { trades: 12, winRate: 0.4, avgR: 0.3 } }),
  };
  const fund = { agents: [agent], byId: new Map([['amara', agent]]), broker: { book: () => ({ trades: [] }) }, clock: { now: () => Date.now() } };
  const md = { price: () => 3800, get: () => ({ status: 'LIVE' }) };
  return { floor: { fund, md, memory, news: null, neural: null, live: null, feeds: { reasons: () => [] } }, agent, notes };
}

function brainWith({ answer, floor, mode = 'live', model = DEFAULT_MODEL, now = () => Date.now(), dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'llm-')) } = {}) {
  const fake = fakeAnthropic(answer);
  const brain = new LlmBrain({ dataDir, mode, floor, log: { info() {}, warn() {} }, now, clientFactory: () => fake, env: {} });
  return { brain, fake, dataDir };
}

const ORDER = { side: 'LONG', entry: 3800, stop: 3790, target: 3830, reason: 'D ▲ bullish bias · London: swept the Asia low, 5-minute shift; target the previous day high (3.0R)', swept: 'Asia low', sweptPrice: 3790, extreme: 3788, targetLabel: 'Previous day high' };
const VERDICT = { verdict: 'take', p_win: 0.42, expected_r: 0.55, reasons: ['Swept the Asia low into the daily AOI at 3770-3780', 'Target at the previous day high, nothing in between'], risks: ['US data at 08:30'], lessons_used: [] };

test('the API key: checked with Anthropic, kept on this computer only, never shown again', async () => {
  const { floor } = floorWith();
  const { brain, dataDir } = brainWith({ floor, answer: () => text(VERDICT) });
  assert.equal(brain.view().status, 'off');
  assert.match((await brain.setKey('hello')).error, /starts with sk-ant-/);
  assert.equal((await brain.setKey(KEY)).ok, true);
  const file = path.join(dataDir, 'llm', 'key.json');
  assert.equal(JSON.parse(fs.readFileSync(file, 'utf8')).apiKey, KEY);
  if (process.platform !== 'win32') assert.equal(fs.statSync(file).mode & 0o777, 0o600, 'readable by this user only');
  const v = brain.view();
  assert.equal(v.status, 'ready');
  assert.equal(v.keyHint, '…1234');
  assert.ok(!JSON.stringify(v).includes(KEY), 'the key never goes to the browser');
  // A key Anthropic rejects isn't kept.
  const bad = new LlmBrain({ dataDir: fs.mkdtempSync(path.join(os.tmpdir(), 'llm-')), floor, log: { info() {}, warn() {} }, env: {}, clientFactory: () => ({ models: { retrieve: async () => { throw new Anthropic.AuthenticationError(401, { error: { message: 'invalid x-api-key' } }, 'invalid x-api-key', new Headers()); } } }) });
  assert.match((await bad.setKey(KEY)).error, /rejected the API key/);
  assert.equal(bad.connected, false);
  // Forget: gone from disk.
  brain.forgetKey();
  assert.equal(fs.existsSync(file), false);
  assert.equal(brain.view().status, 'off');
  // ANTHROPIC_API_KEY in .env works too.
  const env = new LlmBrain({ floor, log: { info() {}, warn() {} }, env: { ANTHROPIC_API_KEY: KEY }, clientFactory: () => fakeAnthropic(() => text(VERDICT)) });
  assert.equal(env.view().keySource, 'env');
});

test('every setup is reviewed before it fills, with the right request, and scored on the result', async () => {
  const memory = new FloorMemory({ mode: 'live' });
  const { floor, agent, notes } = floorWith({ memory });
  const { brain, fake } = brainWith({ floor, answer: () => text(VERDICT) });
  await brain.setKey(KEY);
  const id = brain.onSetup(agent, ORDER);
  assert.ok(id);
  await until(() => brain.state.reviews[0].status === 'done');
  const rev = brain.state.reviews[0];
  assert.equal(rev.verdict, 'take');
  assert.equal(rev.p, 0.42);
  assert.equal(rev.rr, 3);
  assert.equal(rev.reasons.length, 2);
  assert.ok(rev.cost > 0, 'its cost is counted');
  assert.match(notes.at(-1).t, /Claude on my XAUUSD setup: take it \(42% chance of profit\): Swept the Asia low/);
  // The request: Opus 5.5, adaptive thinking (its default), structured output, cached system
  // prompt, server-side fallback on a refusal.
  const req = fake.calls[0];
  assert.equal(req.beta, true);
  assert.equal(req.body.model, 'claude-opus-5-5');
  assert.deepEqual(req.body.betas, ['server-side-fallback-2026-07-01']);
  assert.equal(req.body.fallbacks, 'default');
  assert.equal(req.body.output_config.effort, 'medium');
  assert.deepEqual(req.body.output_config.format, { type: 'json_schema', schema: REVIEW_SCHEMA });
  assert.equal(req.body.system[0].cache_control.type, 'ephemeral');
  assert.equal(req.body.thinking, undefined, 'no thinking setting: Opus 5.5 thinks adaptively by default');
  assert.equal(req.body.temperature, undefined);
  const msg = req.body.messages[0].content;
  assert.match(msg, /Amara Okafor's buy setup on XAUUSD just armed/);
  assert.match(msg, /"swept":"Asia low"/);
  assert.match(msg, /"inAoi"|"aois"/);
  assert.match(msg, /Gold fades after the London open/, 'what the desk itself learned');
  // The entry fills: the review goes with the trade.
  const g = brain.gate(agent, { symbol: 'XAUUSD', side: 'LONG', entry: 3800.5, stop: 3790 });
  assert.deepEqual(g, { take: true, id: rev.id, verdict: 'take', p: 0.42 });
  assert.equal(brain.gate(agent, { symbol: 'XAUUSD', side: 'LONG', entry: 3800.5, stop: 3790 }), null, 'one fill per review');
  // It closes at +3R: Claude was right.
  brain.observe(agent, { llm: { id: rev.id }, r: 2.9, exitReason: 'Target hit', closeTime: Date.now() });
  assert.equal(rev.right, true);
  assert.equal(rev.outcome.r, 2.9);
  const r = brain.record();
  assert.equal(r.n, 1);
  assert.equal(r.takes.avgR, 2.9);
  assert.equal(r.trusted, false);
  // The floor memory saw it all: the review and how it went.
  assert.ok(memory.events.some((e) => e.kind === 'review' && e.verdict === 'take'));
  assert.ok(memory.events.some((e) => e.kind === 'review-outcome' && e.right === true));
});

test('Haiku has no server-side fallback, and demo mode reviews nothing', async () => {
  const { floor, agent } = floorWith();
  const { brain, fake } = brainWith({ floor, answer: () => text(VERDICT) });
  await brain.setKey(KEY);
  brain.configure({ model: 'claude-haiku-5-5' });
  brain.onSetup(agent, ORDER);
  await until(() => brain.state.reviews[0]?.status === 'done');
  assert.equal(fake.calls[0].beta, false);
  assert.equal(fake.calls[0].body.fallbacks, undefined);
  assert.equal(fake.calls[0].body.model, 'claude-haiku-5-5');
  const demo = brainWith({ floor, mode: 'sim', answer: () => text(VERDICT) });
  await demo.brain.setKey(KEY);
  assert.equal(demo.brain.onSetup(agent, ORDER), null, 'made-up prices teach it nothing');
  brain.configure({ mode: 'off' });
  assert.equal(brain.onSetup(agent, ORDER), null);
});

test('the daily budget: spent, and Claude waits for tomorrow', async () => {
  const { floor, agent } = floorWith();
  const { brain, fake } = brainWith({ floor, answer: () => text(VERDICT) });
  await brain.setKey(KEY);
  brain.configure({ budgetUsd: 0 });
  brain.onSetup(agent, ORDER);
  await until(() => brain.state.reviews[0].status !== 'queued' && brain.state.reviews[0].status !== 'thinking');
  assert.equal(brain.state.reviews[0].status, 'skipped');
  assert.match(brain.state.reviews[0].note, /budget/);
  assert.equal(fake.calls.length, 0, 'nothing was sent');
  assert.equal(brain.view().status, 'budget');
  // What one answer costs: Opus 5.5 at $4 / $20 a million tokens.
  assert.equal(Math.round(costOf('claude-opus-5-5', { input_tokens: 1e6, output_tokens: 1e5 }) * 100) / 100, 6);
  assert.ok(costOf('claude-haiku-5-5', { input_tokens: 1e6 }) < costOf('claude-opus-5-5', { input_tokens: 1e6 }) / 10);
});

test('veto mode: only once its record has earned it, only clear skips, and it follows them on paper', async () => {
  const { floor, agent } = floorWith();
  let answer = { ...VERDICT, verdict: 'skip', p_win: 0.2, reasons: ['Entering into the daily AOI from below'] };
  const { brain } = brainWith({ floor, answer: () => text(answer) });
  await brain.setKey(KEY);
  brain.configure({ mode: 'veto' });
  brain.onSetup(agent, ORDER);
  await until(() => brain.state.reviews[0].status === 'done');
  // Not earned yet: it advises, the trade goes on.
  assert.equal(brain.gate(agent, { symbol: 'XAUUSD', side: 'LONG', entry: 3800, stop: 3790 }).take, true);
  // A record that earns it: its skips lost, its takes won.
  for (let i = 0; i < 30; i++) {
    const skip = i < 10;
    brain.state.reviews.push({ id: `old${i}`, at: Date.now() - 86_400_000, desk: 'x', symbol: 'XAUUSD', side: 'LONG', status: 'done', verdict: skip ? 'skip' : 'take', p: skip ? 0.2 : 0.4, outcome: { r: skip ? -1 : 0.6, won: !skip } });
  }
  assert.equal(brain.record().trusted, true);
  brain.onSetup(agent, ORDER);
  await until(() => brain.state.reviews.at(-1).status === 'done');
  const held = brain.gate(agent, { symbol: 'XAUUSD', side: 'LONG', entry: 3800, stop: 3790 });
  assert.equal(held.take, false);
  assert.match(held.reason, /Claude held it back \(20% chance of profit\): Entering into the daily AOI/);
  const rev = brain.state.reviews.at(-1);
  assert.equal(rev.vetoed, true);
  // Followed on paper: price runs to the stop. Claude was right to hold it back.
  brain.onBar('XAUUSD', { time: 1, open: 3800, high: 3801, low: 3789, close: 3790 });
  assert.equal(rev.outcome.how, 'held back');
  assert.ok(rev.outcome.r <= -1);
  assert.equal(rev.right, true);
  // A skip it isn't sure of (above 30%) is never held back.
  answer = { ...VERDICT, verdict: 'skip', p_win: 0.34 };
  brain.onSetup(agent, ORDER);
  await until(() => brain.state.reviews.at(-1).status === 'done');
  assert.equal(brain.gate(agent, { symbol: 'XAUUSD', side: 'LONG', entry: 3800, stop: 3790 }).take, true);
  // The boss's own TradingView alerts are never its call.
  assert.equal(brain.gate(agent, { symbol: 'XAUUSD', side: 'LONG', entry: 3800, stop: 3790, tag: 'TV' }), null);
});

test('the lesson book: lessons are scored by results, wrong ones retired, the boss can teach it', async () => {
  const memory = new FloorMemory({ mode: 'live' });
  const { floor, agent } = floorWith({ memory });
  const { brain } = brainWith({ floor, answer: (body) => text({ ...VERDICT, lessons_used: [brain.state.lessons[0]?.id].filter(Boolean) }) });
  await brain.setKey(KEY);
  const taught = brain.teach('Skip gold longs into the US CPI release', { symbol: 'XAUUSD' });
  assert.equal(taught.ok, true);
  assert.equal(brain.teach('Skip gold longs into the US CPI release').ok, false, 'already in the book');
  // It joins the floor memory as Claude's lesson.
  const g = memory.graph([]);
  assert.ok(g.nodes.some((n) => n.id === 'desk:llm' && n.label === 'Claude'));
  assert.ok(g.links.some((l) => l.t === 'desk:llm' && l.kind === 'learned'));
  // Retrieval: a lesson for gold shows up for gold, not for the Nasdaq.
  assert.equal(brain.lessonsFor('XAUUSD', 'london').length, 1);
  assert.equal(brain.lessonsFor('NAS100', 'london').length, 0);
  // Used in reviews that turn out wrong, again and again: retired... unless the boss taught it.
  const lesson = brain.state.lessons[0];
  for (let i = 0; i < 4; i++) {
    brain.onSetup(agent, ORDER);
    await until(() => brain.state.reviews.at(-1).status === 'done');
    const rev = brain.state.reviews.at(-1);
    assert.deepEqual(rev.lessonsUsed, [lesson.id]);
    brain.gate(agent, { symbol: 'XAUUSD', side: 'LONG', entry: 3800, stop: 3790 });
    brain.observe(agent, { llm: { id: rev.id }, r: -1, closeTime: Date.now() });
  }
  assert.equal(lesson.wrong, 4);
  assert.ok(lesson.retired, 'a lesson wrong 3 more times than right is retired');
  assert.equal(brain.lessonsFor('XAUUSD', 'london').length, 0);
});

test('after the New York close Claude reflects on the day once, and keeps its lesson book', async () => {
  const memory = new FloorMemory({ mode: 'live' });
  const { floor, agent, notes } = floorWith({ memory });
  let t = nyWallToMs(2026, 10, 28, 16, 0); // a Wednesday, before the close
  const reflection = { summary: 'A quiet London; Amara caught the Asia-low sweep on gold for +2.9R.', lessons: [{ text: 'Gold London sweeps of the Asia low into a daily AOI worked: prefer them', symbol: 'XAUUSD', session: 'london', kind: 'prefer', confidence: 0.6 }], retire: [], desk_notes: [{ desk: 'amara', note: 'Good patience waiting for the fair value gap.' }] };
  const { brain, fake } = brainWith({ floor, now: () => t, answer: () => text(reflection) });
  await brain.setKey(KEY);
  const reflected = [];
  brain.on('reflection', (r) => reflected.push(r));
  brain.tick();
  await tick();
  assert.equal(fake.calls.length, 0, 'not before the close');
  t = nyWallToMs(2026, 10, 28, 17, 20);
  brain.tick();
  await until(() => reflected.length === 1);
  const r = reflected[0];
  assert.equal(r.day, '2026-10-28');
  assert.match(r.summary, /Amara caught/);
  assert.equal(r.added.length, 1);
  assert.equal(brain.state.lessons[0].kind, 'prefer');
  assert.equal(brain.state.lessons[0].symbol, 'XAUUSD');
  assert.match(notes.at(-1).t, /Note from Claude: Good patience/);
  assert.ok(memory.state.lessons.some((l) => l.agentId === 'llm'));
  const req = fake.calls[0].body;
  assert.equal(req.output_config.effort, 'high');
  assert.deepEqual(req.output_config.format.schema, REFLECT_SCHEMA);
  // Once a day.
  t += 3_600_000;
  brain.tick();
  await tick();
  assert.equal(fake.calls.length, 1);
  // Not on a Saturday.
  const sat = brainWith({ floor, now: () => nyWallToMs(2026, 10, 31, 18, 0), answer: () => text(reflection) });
  await sat.brain.setKey(KEY);
  sat.brain.tick();
  await tick();
  assert.equal(sat.fake.calls.length, 0);
});

test('chat: Claude looks at the floor through read-only tools before it answers', async () => {
  const { floor } = floorWith();
  let round = 0;
  const { brain, fake } = brainWith({
    floor,
    answer: () => {
      round++;
      if (round === 1) return { stop_reason: 'tool_use', content: [{ type: 'thinking', thinking: '', signature: 's' }, { type: 'tool_use', id: 'tu1', name: 'floor_overview', input: {} }, { type: 'tool_use', id: 'tu2', name: 'desk_detail', input: { desk: 'amara' } }] };
      return text('Amara traded the London sweep on gold; the rest had no setup.');
    },
  });
  await brain.setKey(KEY);
  const res = await brain.ask('How did the floor do today?');
  assert.equal(res.ok, true);
  assert.match(res.answer, /Amara traded the London sweep/);
  // Two requests: the tools ran in between, both results in one message.
  assert.equal(fake.calls.length, 2);
  const second = fake.calls[1].body.messages;
  assert.equal(second.length, 3);
  assert.equal(second[1].role, 'assistant');
  assert.equal(second[2].content.length, 2);
  assert.ok(second[2].content.every((b) => b.type === 'tool_result'));
  assert.match(second[2].content[0].content, /"desks":\[\{"id":"amara"/);
  assert.match(second[2].content[1].content, /"name":"Amara Okafor"/);
  // The tools only read, and are strict.
  assert.ok(fake.calls[0].body.tools.every((t) => t.strict === true && t.input_schema.additionalProperties === false));
  assert.deepEqual(CHAT_TOOLS.map((t) => t.name).sort(), ['account', 'desk_detail', 'floor_overview', 'lessons', 'market', 'my_reviews', 'trades']);
  // The conversation: only added to, never edited (a model's thinking is tied to it).
  const before = JSON.stringify(brain.state.chat.messages);
  round = 1;
  await brain.ask('And gold?');
  assert.ok(JSON.stringify(brain.state.chat.messages).startsWith(before.slice(0, -1)), 'the earlier turns are unchanged');
  const ui = brain.view().chat;
  assert.deepEqual(ui.map((m) => m.role), ['user', 'assistant', 'user', 'assistant']);
  assert.deepEqual(ui[1].steps, ['floor_overview', 'desk_detail']);
  // A new conversation starts clean.
  brain.newChat();
  assert.equal(brain.state.chat.messages.length, 0);
  // An unknown desk or market says so instead of failing.
  assert.match(runTool('desk_detail', { desk: 'nobody' }, { floor, brain }).error, /No desk called "nobody"/);
  assert.match(runTool('market', { symbol: 'XYZ' }, { floor, brain }).error, /Unknown market/);
});

test('Anthropic\'s errors are explained in plain words', () => {
  const headers = new Headers();
  assert.match(explainApiError(new Anthropic.AuthenticationError(401, {}, 'invalid x-api-key', headers)).text, /rejected the API key/);
  assert.match(explainApiError(new Anthropic.RateLimitError(429, {}, 'rate limited', headers)).text, /rate-limiting/);
  assert.match(explainApiError(new Anthropic.BadRequestError(400, { error: { message: 'Your credit balance is too low' } }, 'Your credit balance is too low', headers)).text, /credit balance is too low.*Billing/);
  const conn = new Anthropic.APIConnectionError({ cause: Object.assign(new Error('fetch failed'), { cause: { code: 'UNABLE_TO_GET_ISSUER_CERT_LOCALLY' } }) });
  assert.match(explainApiError(conn).text, /Couldn't reach Anthropic: .*intercepted/);
});

test('a failed review is reported, and the floor carries on', async () => {
  const { floor, agent } = floorWith();
  const { brain } = brainWith({ floor, answer: () => new Anthropic.AuthenticationError(401, {}, 'invalid x-api-key', new Headers()) });
  await brain.setKey(KEY);
  brain.onSetup(agent, ORDER);
  await until(() => brain.state.reviews[0].status === 'failed');
  assert.match(brain.state.reviews[0].note, /rejected the API key/);
  assert.equal(brain.view().status, 'error');
  assert.equal(brain.gate(agent, { symbol: 'XAUUSD', side: 'LONG', entry: 3800, stop: 3790 }).take, true, 'no verdict, no say');
});

test('a desk asks Claude at the entry: a hold-back stops the trade, a verdict travels with it', async () => {
  const clock = new MarketClock('live');
  const session = new Session(clock);
  session.isFlattenWindow = () => false;
  const md = new MarketData(clock);
  const broker = new Broker(md, clock);
  const risk = new RiskManager({ riskPerTradePct: 0.005, deskDailyLossPct: 0.02, fundDailyLossPct: 0.012, maxLeverage: 4 }, session);
  const fund = new Fund({ config: { startingCapital: 100_000_000, feed: 'live', fundName: 'Test' }, md, clock, session, broker, risk, committee: 'off' });
  md.applyTick('XAUUSD', 3800.1, 1, clock.now());
  const amara = fund.byId.get('amara');
  amara.againstTopDown = () => null; // these tests don't depend on the market's read
  const seen = [];
  fund.env.llm = {
    gate: (a, x) => (x.side === 'SHORT' ? { take: false, reason: 'Claude held it back (18% chance of profit): into the daily AOI' } : { take: true, id: 'rv9', verdict: 'take', p: 0.45 }),
    observe: (a, t) => seen.push(t),
  };
  assert.equal(amara.openTrade({ side: 'SHORT', stop: 3810, target: 3770, reason: 'test', symbol: 'XAUUSD' }), false);
  assert.match(amara.day.whyNot.text, /Claude held it back/);
  assert.equal(amara.openTrade({ side: 'LONG', stop: 3790, target: 3830, reason: 'test', symbol: 'XAUUSD' }), true);
  amara.closeTrade('XAUUSD', 'Target hit');
  assert.equal(seen.length, 1);
  assert.deepEqual(seen[0].llm, { id: 'rv9', verdict: 'take', p: 0.45 });
});

test('the model table and limits are sane', () => {
  assert.equal(DEFAULT_MODEL, 'claude-opus-5-5');
  assert.deepEqual(Object.keys(MODELS), ['claude-opus-5-5', 'claude-sonnet-5-5', 'claude-haiku-5-5']);
  assert.equal(MODELS['claude-haiku-5-5'].fallbacks, false);
  assert.ok(LLM.trust.minN >= 30 && LLM.vetoBelow <= 0.3);
});
