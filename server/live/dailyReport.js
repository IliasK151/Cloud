import fs from 'node:fs';
import path from 'node:path';

// The daily report card for the prop account: what each desk did on FTMO that day (trades,
// wins, profit, R), which trades were held back on paper and why, and what happened to the
// account (start and end balance, the loss guard, arming, MT5 dropping out). One file per
// FTMO server day in data/reports/, kept up to date through the day and finalised when the
// server day rolls over (or on the first sync after it, if the floor was off at midnight).
// It keeps its own record, so it doesn't depend on how many orders the live trader remembers.

const VERSION = 1;
const SAMPLES = 40;
const EVENTS = 60;

// Why a trade stayed on paper, grouped the way the boss thinks about it.
const CATEGORIES = [
  // FTMO only: the account couldn't take anything, so the desk didn't trade at all.
  [/MT5 isn't connected/i, 'MT5 not connected'],
  [/account isn't set up/i, 'FTMO account not set up'],
  [/isn't armed/i, 'FTMO trading not armed'],
  [/account is halted/i, 'Account halted'],
  [/switched off for the FTMO account/i, 'Desk switched off for FTMO'],
  [/Pairs trades|Market making relies/i, 'Can\'t trade a prop account'],
  [/neural brain passed/i, 'Neural brain\'s paper experiment'],
  [/weekend crypto:/i, 'Weekend crypto: enough positions open'],
  [/against the top-down/i, 'Against the top-down bias'],
  [/one desk per market/i, 'Another desk is in that market'],
  [/the most at once/i, 'Enough trades open at once'],
  [/Best Day rule/i, 'FTMO Best Day rule'],
  [/cool-off/i, 'Cool-off after a losing streak'],
  [/out of form/i, 'Desk out of form'],
  [/over the long run/i, 'Loses over the long run'],
  [/trades paper first/i, 'New strategy proving itself on paper'],
  [/nightly review found no edge/i, 'No edge on your prices'],
  [/desk loss limit/i, 'Desk loss limit'],
  [/no flipping/i, 'No flipping right after a loss'],
  [/costs would eat/i, 'Costs too high for the stop'],
  [/order actions/i, 'FTMO order-action limit'],
  [/committee grade/i, 'Committee grade too low'],
  [/correlated group/i, 'Correlated position already open'],
  [/live positions \(max/i, 'Max open positions reached'],
  [/open-risk budget/i, 'Open-risk budget full'],
  [/news blackout/i, 'News blackout'],
  [/isn't cleared|needs \d+|proving|no validated|probation|edge/i, 'Desk not proven yet'],
  [/daily stop|losses in a row|trades today/i, 'Account plan stopped for the day'],
  [/loss guard/i, 'No room under the loss guard'],
  [/lot minimum/i, 'Below the broker\'s minimum lot'],
  [/no FTMO symbol|no MT5 price/i, 'Market not on MT5'],
  [/Algo Trading/i, 'Algo Trading off in MT5'],
  [/test alert/i, 'TradingView test alert'],
  [/simulated/i, 'No real prices'],
];

export function skipCategory(reason = '') {
  for (const [re, label] of CATEGORIES) if (re.test(reason)) return label;
  return 'Other';
}

const fileDay = (day) => String(day).replace(/[^0-9A-Za-z]+/g, '-');
const round2 = (x) => Math.round(x * 100) / 100;

function blank(day) {
  return {
    v: VERSION, day, final: false, createdAt: Date.now(), updatedAt: Date.now(),
    account: null, desks: {}, trades: [], skipped: {}, skipSamples: [], events: [], paper: {},
  };
}

export class DailyReports {
  constructor({ dataDir, log = console, now = () => Date.now() }) {
    this.dir = path.join(dataDir, 'reports');
    this.log = log;
    this.now = now;
    this.current = null;
    this.onFinal = null; // (report) => void, e.g. the Telegram summary
    try {
      fs.mkdirSync(this.dir, { recursive: true });
    } catch { /* read-only: reports stay in memory */ }
    this.current = this.#latestOpen();
  }

  // The newest report that isn't final yet: the floor may have stopped before midnight.
  #latestOpen() {
    const list = this.list();
    const last = list[0] ? this.get(list[0].day) : null;
    return last && !last.final ? last : null;
  }

  // The report for `day`, starting it (and finalising the previous one) when the day changes.
  #for(day) {
    if (!day) return null;
    if (this.current && this.current.day !== day) this.finalize();
    if (!this.current) this.current = this.get(day) || blank(day);
    if (this.current.final) this.current.final = false; // the day is still going after all
    return this.current;
  }

  #desk(r, agentId, info = {}) {
    r.desks[agentId] ||= { name: info.name || agentId, desk: info.desk || '', trades: 0, wins: 0, losses: 0, pnl: 0, sumR: 0, countR: 0, best: null, worst: null, skipped: 0 };
    const d = r.desks[agentId];
    if (info.name) d.name = info.name;
    if (info.desk) d.desk = info.desk;
    return d;
  }

  // ---- what happened ------------------------------------------------------------------------
  opened(day, t) {
    const r = this.#for(day);
    if (!r) return;
    this.#desk(r, t.agentId, t);
    r.trades.push({ key: t.key, agentId: t.agentId, symbol: t.symbol, side: t.side, volume: t.volume, entry: t.entry ?? null, risk: round2(t.risk || 0), grade: t.grade ?? null, openedAt: this.now(), closedAt: null, pnl: null, r: null });
    this.#touch();
  }

  closed(day, t) {
    const r = this.#for(day);
    if (!r) return;
    const d = this.#desk(r, t.agentId, t);
    let row = r.trades.find((x) => x.key === t.key && x.closedAt == null);
    if (!row) {
      // Opened on an earlier day (or before this report existed): it counts on the day it closed.
      row = { key: t.key, agentId: t.agentId, symbol: t.symbol, side: t.side, volume: t.volume, entry: t.entry ?? null, risk: round2(t.risk || 0), grade: t.grade ?? null, openedAt: t.openedAt ?? null, carried: true };
      r.trades.push(row);
    }
    row.closedAt = this.now();
    row.pnl = round2(t.pnl || 0);
    row.r = t.risk > 0 ? round2(t.pnl / t.risk) : null;
    d.trades++;
    if (row.pnl > 0) d.wins++;
    else d.losses++;
    d.pnl = round2(d.pnl + row.pnl);
    if (row.r != null) { d.sumR = round2(d.sumR + row.r); d.countR++; }
    d.best = d.best == null ? row.pnl : Math.max(d.best, row.pnl);
    d.worst = d.worst == null ? row.pnl : Math.min(d.worst, row.pnl);
    this.#touch();
  }

  skipped(day, s) {
    const r = this.#for(day);
    if (!r) return;
    const d = this.#desk(r, s.agentId, s);
    d.skipped++;
    const cat = skipCategory(s.reason);
    r.skipped[cat] = (r.skipped[cat] || 0) + 1;
    r.skipSamples.push({ agentId: s.agentId, symbol: s.symbol, reason: s.reason, category: cat, at: this.now() });
    if (r.skipSamples.length > SAMPLES) r.skipSamples.shift();
    this.#touch();
  }

  event(day, kind, text) {
    const r = this.#for(day);
    if (!r) return;
    r.events.push({ kind, text, at: this.now() });
    if (r.events.length > EVENTS) r.events.shift();
    this.#touch();
  }

  // Where the account stands (every sync, cheap) and how the paper desks are doing.
  snapshot(day, account, paper = null) {
    const r = this.#for(day);
    if (!r || !account) return;
    const first = r.account;
    r.account = {
      login: account.login, server: account.server, type: account.type ?? first?.type ?? null, size: account.size ?? first?.size ?? null,
      startBalance: round2(first?.startBalance ?? account.startBalance),
      balance: round2(account.balance), equity: round2(account.equity),
      dayPnl: round2(account.equity - (first?.startBalance ?? account.startBalance)),
      dailyUsedPct: account.dailyUsedPct ?? null, maxUsedPct: account.maxUsedPct ?? null,
      lowEquity: round2(Math.min(first?.lowEquity ?? account.equity, account.equity)),
      highEquity: round2(Math.max(first?.highEquity ?? account.equity, account.equity)),
    };
    if (paper) r.paper = paper;
    r.updatedAt = this.now();
    this.#touch(10_000);
  }

  // ---- files ------------------------------------------------------------------------------------
  #touch(delay = 2000) {
    if (this.saveTimer) return;
    this.saveTimer = setTimeout(() => {
      this.saveTimer = null;
      this.save();
    }, delay);
    this.saveTimer.unref?.();
  }

  save(report = this.current) {
    if (!report) return;
    report.updatedAt = this.now();
    try {
      const file = path.join(this.dir, `${fileDay(report.day)}.json`);
      fs.writeFileSync(`${file}.tmp`, JSON.stringify(report, null, 1));
      fs.renameSync(`${file}.tmp`, file);
    } catch (err) {
      this.log.warn?.(`[reports] saving the daily report failed: ${err.message}`);
    }
  }

  finalize() {
    const r = this.current;
    if (!r) return null;
    clearTimeout(this.saveTimer);
    this.saveTimer = null;
    r.final = true;
    this.save(r);
    this.current = null;
    try {
      this.onFinal?.(summarize(r), r);
    } catch (err) {
      this.log.warn?.(`[reports] daily summary failed: ${err.message}`);
    }
    return r;
  }

  flush() {
    clearTimeout(this.saveTimer);
    this.saveTimer = null;
    this.save();
  }

  list() {
    let files = [];
    try {
      files = fs.readdirSync(this.dir).filter((f) => f.endsWith('.json'));
    } catch {
      return [];
    }
    const out = [];
    for (const f of files) {
      try {
        const r = JSON.parse(fs.readFileSync(path.join(this.dir, f), 'utf8'));
        if (r?.v !== VERSION) continue;
        const s = summarize(r);
        out.push({ day: r.day, final: !!r.final, dayPnl: s.dayPnl, trades: s.trades, wins: s.wins, skipped: s.skipped });
      } catch { /* not a report */ }
    }
    if (this.current && !out.some((x) => x.day === this.current.day)) {
      const s = summarize(this.current);
      out.push({ day: this.current.day, final: false, dayPnl: s.dayPnl, trades: s.trades, wins: s.wins, skipped: s.skipped });
    }
    return out.sort((a, b) => String(b.day).localeCompare(String(a.day)));
  }

  // One account's balance at the start and end of every day the floor saw it, oldest first
  // (for 1-Step's trailing max loss and Best Day rule).
  balances(login) {
    const out = [];
    for (const { day } of this.list()) {
      const a = this.get(day)?.account;
      if (!a || String(a.login) !== String(login) || !Number.isFinite(a.startBalance) || !Number.isFinite(a.balance)) continue;
      out.push({ day, startBalance: a.startBalance, balance: a.balance });
    }
    return out.reverse();
  }

  get(day) {
    if (this.current?.day === day) return this.current;
    try {
      const r = JSON.parse(fs.readFileSync(path.join(this.dir, `${fileDay(day)}.json`), 'utf8'));
      return r?.v === VERSION ? r : null;
    } catch {
      return null;
    }
  }
}

// The headline numbers of a report.
// A report's closed trades, oldest first, with each desk's first name (for the phone).
export function closedTrades(r) {
  return (r?.trades || [])
    .filter((t) => t.closedAt != null && Number.isFinite(t.pnl))
    .sort((a, b) => a.closedAt - b.closedAt)
    .map((t) => ({ name: (r.desks?.[t.agentId]?.name || t.agentId || '').split(' ')[0], symbol: t.symbol, pnl: t.pnl, r: t.r }));
}

export function summarize(r) {
  const desks = Object.entries(r.desks || {}).map(([id, d]) => ({ id, ...d, avgR: d.countR ? round2(d.sumR / d.countR) : null }));
  const trades = desks.reduce((s, d) => s + d.trades, 0);
  const wins = desks.reduce((s, d) => s + d.wins, 0);
  const sumR = desks.reduce((s, d) => s + d.sumR, 0);
  const countR = desks.reduce((s, d) => s + d.countR, 0);
  const realized = round2(desks.reduce((s, d) => s + d.pnl, 0));
  const skipped = Object.values(r.skipped || {}).reduce((s, n) => s + n, 0);
  const ranked = desks.filter((d) => d.trades).sort((a, b) => b.pnl - a.pnl);
  return {
    day: r.day,
    dayPnl: r.account ? r.account.dayPnl : realized,
    realized,
    trades, wins, losses: trades - wins,
    winRate: trades ? wins / trades : null,
    avgR: countR ? round2(sumR / countR) : null,
    skipped,
    topReasons: Object.entries(r.skipped || {}).sort((a, b) => b[1] - a[1]).slice(0, 3),
    best: ranked[0] || null,
    worst: ranked.length > 1 ? ranked[ranked.length - 1] : null,
    halted: (r.events || []).some((e) => e.kind === 'guard'),
    list: closedTrades(r),
  };
}
