import { SYMBOLS, tradeCostR } from '../market/symbols.js';
import { sessionOf } from '../engine/roster.js';
import { fmtNyTime } from '../market/session.js';

// What the LLM brain reads about the floor: small, plain summaries built from the floor's
// own objects (the same numbers the dashboard shows), never the whole state. Nothing here
// carries a secret: no tokens, no keys, no passwords.

const r2 = (x) => (Number.isFinite(x) ? Math.round(x * 100) / 100 : null);
export const px = (symbol, x) => (Number.isFinite(x) ? Number(x.toFixed(SYMBOLS[symbol]?.decimals ?? 2)) : null);
const nyTime = (ms) => (Number.isFinite(ms) ? fmtNyTime(ms) : null);

export function deskOf(fund, idOrName) {
  const key = String(idOrName || '').toLowerCase().trim();
  return fund.byId.get(key) || fund.agents.find((a) => a.profile.name.toLowerCase().startsWith(key) || a.profile.name.toLowerCase().includes(key)) || null;
}

// One desk in a few lines: what it trades, when, where its day stands and why.
export function deskBrief(agent) {
  const s = agent.snapshot();
  const pos = s.positions?.[0] || null;
  return {
    id: agent.id,
    name: agent.profile.name,
    market: agent.symbol,
    session: sessionOf(agent.profile),
    status: s.status,
    stage: s.setup?.stage || null,
    topDown: s.topDown?.text || null,
    today: { ideas: s.today.ideas, entries: s.today.entries, skipped: s.today.skipped, heldBack: s.today.vetoed, whyNot: s.today.whyNot?.text || null, story: s.today.story?.text || null },
    position: pos ? { side: pos.side, entry: px(agent.symbol, pos.avg), stop: px(agent.symbol, pos.stop), target: px(agent.symbol, pos.target), unrealizedUsd: r2(pos.unrealized) } : null,
    record: { trades: s.stats.trades, winRate: r2(s.stats.winRate), avgR: r2(s.stats.avgR) },
  };
}

// The market as the desks read it: price, top-down read, nearest areas of interest, news ahead.
export function marketBrief(floor, symbol) {
  const agent = floor.fund.agents.find((a) => a.symbol === symbol);
  const st = floor.md.get(symbol);
  const read = agent?.env.topDown?.(symbol)?.read() ?? null;
  const next = floor.news?.next?.(symbol, floor.fund.clock?.now?.() ?? Date.now(), 6 * 3_600_000);
  return {
    symbol,
    price: px(symbol, floor.md.price(symbol)),
    status: st?.status || null,
    topDown: read ? {
      ready: !!read.ready, bias: read.bias || null, text: read.text, strength: read.strength ?? null,
      zone: read.zone?.word ?? null, inAoi: read.inAoi ? { tf: read.inAoi.both ? 'W+D' : read.inAoi.tf, lo: px(symbol, read.inAoi.lo), hi: px(symbol, read.inAoi.hi) } : null,
      aois: (read.aois || []).slice(0, 4).map((a) => ({ tf: a.both ? 'W+D' : a.tf, lo: px(symbol, a.lo), hi: px(symbol, a.hi) })),
      dailyAtr: px(symbol, read.atrD),
    } : null,
    newsAhead: next ? { event: next.event?.title || next.event?.name || 'news', impact: next.impact, at: nyTime(next.event?.time) } : null,
  };
}

// The setup a desk just armed, with everything a reviewer needs to judge it.
export function setupBrief(floor, agent, order) {
  const symbol = agent.symbol;
  const risk = Math.abs(order.entry - order.stop);
  const rr = order.target != null && risk > 0 ? Math.abs(order.target - order.entry) / risk : null;
  const view = agent.pb?.view?.() || {};
  const price = floor.md.price(symbol);
  const levels = (view.levels || []).filter((l) => !l.swept && Number.isFinite(l.price))
    .sort((a, b) => Math.abs(a.price - price) - Math.abs(b.price - price)).slice(0, 8)
    .map((l) => ({ label: l.label, price: px(symbol, l.price), side: l.side }));
  const ctx = agent.learner?.context?.(symbol, order.side) || null;
  const recall = ctx ? floor.memory?.recall?.(symbol, ctx) : null;
  const L = agent.learner?.summary?.() || null;
  return {
    desk: { id: agent.id, name: agent.profile.name, session: sessionOf(agent.profile), killzone: view.kz || null },
    order: {
      side: order.side, entry: px(symbol, order.entry), stop: px(symbol, order.stop), target: px(symbol, order.target),
      rr: r2(rr), reason: order.reason, costR: r2(tradeCostR(symbol, order.entry, order.stop)), market: !!order.market,
      swept: order.swept ?? null, sweptPrice: px(symbol, order.sweptPrice), sweepExtreme: px(symbol, order.extreme), targetIs: order.targetLabel ?? null,
    },
    market: marketBrief(floor, symbol),
    liquidity: levels,
    sweep: view.sweep?.level ? { level: view.sweep.level.label || null, levelPrice: px(symbol, view.sweep.level.price), extreme: px(symbol, view.sweep.extreme) } : null,
    time: nyTime(floor.fund.clock?.now?.() ?? Date.now()),
    floorMemory: recall?.trades ? { text: recall.text, trades: recall.trades, avgR: recall.avgR, winRate: r2(recall.winRate) } : null,
    deskRecord: { trades: agent.lifetime?.trades ?? 0, avgR: r2(agent.lifetime?.countR ? agent.lifetime.sumR / agent.lifetime.countR : null), lastLesson: L?.last?.title ?? null },
    neuralBrain: floor.neural?.view ? (() => { const v = floor.neural.view(); return { mode: v.mode || null, aucOnUnseenTrades: r2(v.skill?.auc ?? null) }; })() : null,
  };
}

// The closed trades of every desk since a time, newest last.
export function tradesSince(fund, sinceMs, { desk = null, max = 60 } = {}) {
  const out = [];
  for (const a of fund.agents) {
    if (desk && a.id !== desk) continue;
    for (const t of fund.broker.book(a.id).trades) {
      if ((t.closeTime ?? 0) < sinceMs || t.cancelled) continue;
      out.push({ desk: a.id, name: a.profile.name.split(' ')[0], symbol: t.symbol, side: t.side, r: r2(t.r), exit: t.exitReason, opened: nyTime(t.openTime), closed: nyTime(t.closeTime), reason: t.entryReason, claude: t.llm ? `${t.llm.verdict} ${Math.round((t.llm.p ?? 0) * 100)}%` : null });
    }
  }
  return out.sort((a, b) => String(a.closed).localeCompare(String(b.closed))).slice(-max);
}

// The account as the FTMO tab shows it, without anything secret.
export function accountBrief(live) {
  if (!live) return null;
  const v = live.view();
  return {
    mode: v.mode,
    mt5: v.connected ? 'connected' : v.lastSync ? 'stopped syncing' : 'not connected',
    account: v.account ? { server: v.account.server, balance: r2(v.account.balance), equity: r2(v.account.equity), currency: v.account.currency || null } : null,
    setUp: !!v.profile,
    program: v.profile ? `${v.profile.program || ''} ${v.profile.type || ''}`.trim() : null,
    armed: !!v.armed,
    ftmoOnly: v.ftmoOnly ?? null,
    ownWay: v.ownWay ?? null,
    today: v.today ? { sent: v.today.sent, failed: v.today.failed, held: v.today.held, reasons: (v.today.reasons || []).slice(0, 6) } : null,
    warnings: (v.warnings || []).slice(0, 6),
    marketsHistoryDays: (v.history || []).map((h) => ({ market: h.id, days: h.days, short: h.short })),
  };
}
