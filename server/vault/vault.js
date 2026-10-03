import fs from 'node:fs';
import path from 'node:path';
import { EventEmitter } from 'node:events';
import { nyParts } from '../market/session.js';
import { SYMBOLS } from '../market/symbols.js';
import { situationLabel } from '../brain/memory.js';
import { summarize, closedTrades } from '../live/dailyReport.js';
import { protectedFolder, folderName } from '../util/macFolders.js';

// The floor's Obsidian vault: everything the desks know, as linked Markdown notes the boss can
// read, search and graph in Obsidian, written live while the floor runs.
//
//   Home.md          the floor today, every desk, the latest trades
//   Desks/           one note per desk: its strategy and rules, its numbers and form, where it
//                    stands with the account, what it has learned (the rules it follows now),
//                    what its neural brain noticed, its situations, its recent trades
//   Trades/YYYY-MM/  one note per closed trade: why it was taken, the committee's grade, the
//                    brain's chance, how it ended, win or loss
//   Now.md           what every desk is doing right now, rewritten every minute
//   Journal/<desk>/  each desk's own running notes for the day, written as it works: what it
//                    is watching, the ideas it took or turned down, the committee's call, its
//                    wins and losses, what it learned, and its review at the end of the day
//   Ideas/           every idea of the day, taken or turned down and why (appended as it happens)
//   Daily/           the day per desk, the lessons learned, the FTMO account's day
//   Lessons/         every lesson a desk learned from its own trades
//   Markets/         each market: the situations the floor remembers there, and who trades it
//   Playbook/        what works and what loses across the floor, in situations with evidence
//   Brain/           the neural brain, the long-run record, the nightly review, the account plan
//
// It mirrors the same knowledge the desks trade on (their learners, the floor memory, the
// neural brain and the evidence), so what you read is what they know. Real prices only: demo
// mode writes its own vault. Nothing secret is ever written (no tokens, no secrets, no keys).
// Anything you write under "Your notes" in a note stays: the floor only rewrites above it.

export const VAULT = {
  refreshMs: 5 * 60_000, // desks, markets, playbook and brains are rewritten this often
  nowMs: 60_000, // Now.md, what every desk is doing, this often
  watchEveryMs: 20 * 60_000, // a desk notes what it's watching at most this often (when it changed)
  journalsKeptDays: 90,
  flushMs: 3000, // notes touched by a trade or a lesson are written this soon after
  tradesKeptDays: 180, // older trade notes are removed (the desks' numbers keep them)
  ideasKeptDays: 60,
  recentTrades: 15,
};

export const NOTES_MARK = '%% Anything you write below this line stays: the floor only rewrites what is above it. %%';

const fmtR = (x) => (Number.isFinite(x) ? `${x >= 0 ? '+' : '−'}${Math.abs(x).toFixed(2)}R` : '—');
const fmtUsd = (x) => (Number.isFinite(x) ? `${x < 0 ? '−' : x > 0 ? '+' : ''}$${Math.abs(x).toLocaleString('en-US', { maximumFractionDigits: 0 })}` : '—');
const pct = (x) => (Number.isFinite(x) ? `${Math.round(x * 100)}%` : '—');
const pad = (n) => String(n).padStart(2, '0');
const cell = (x) => String(x ?? '').replace(/\|/g, '/').replace(/\n/g, ' ');
const first = (agent) => agent.profile.name.split(' ')[0];

// File names Obsidian (and every OS) accepts.
export const safeName = (s) => String(s).replace(/[\\/:*?"<>|#^[\]]/g, '-').replace(/\s+/g, ' ').trim().slice(0, 120);

export function nyStamp(ms) {
  const p = nyParts(ms);
  return { day: `${p.year}-${pad(p.month)}-${pad(p.day)}`, time: `${pad(p.hour)}:${pad(p.minute)}`, compact: `${pad(p.hour)}${pad(p.minute)}` };
}

const yaml = (obj) => `---\n${Object.entries(obj).filter(([, v]) => v != null && v !== '').map(([k, v]) => `${k}: ${Array.isArray(v) ? `[${v.map((x) => JSON.stringify(x)).join(', ')}]` : typeof v === 'string' ? JSON.stringify(v) : v}`).join('\n')}\n---\n`;

export class Vault extends EventEmitter {
  constructor({ dir, mode = 'live', fund, memory = null, live = null, neural = null, log = console, now = null }) {
    super();
    this.dir = dir;
    this.mode = mode;
    this.fund = fund;
    this.memory = memory;
    this.live = live;
    this.neural = neural;
    this.log = log;
    this.now = now || (() => fund.clock.now()); // the floor's clock (demo mode runs its own)
    this.cache = new Map(); // note → the generated part last written
    this.dirty = new Set();
    this.written = 0;
    this.lastWrite = null;
    this.lastError = null;
    this.tradeNames = new Map(); // trade id → note name
    this.timers = [];
  }

  // ---- lifecycle -------------------------------------------------------------------------------
  start() {
    try {
      fs.mkdirSync(this.dir, { recursive: true });
      this.#obsidianConfig();
    } catch (err) {
      this.#fail(err);
      return false;
    }
    // Every trade the books still hold gets its note (a fresh vault starts with them).
    for (const a of this.fund.agents) for (const t of this.fund.broker.book(a.id).trades) this.#tradeNote(a, t, { quiet: true });
    this.refresh();
    this.#prune();
    const f = this.fund;
    f.broker.on('trade', (t) => {
      const a = f.byId.get(t.agentId);
      if (!a) return;
      if (this.#tradeNote(a, t)) this.#touch('home', `desk:${a.id}`, 'daily', `market:${t.symbol}`);
    });
    f.on('event', (e) => {
      this.#idea(e);
      this.#journal(e);
      if (e.kind === 'session' && /^Session close/.test(e.text || '')) this.#endOfDay();
    });
    this.memory?.on('event', (e) => {
      if (e.kind === 'lesson') this.#touch(`desk:${e.agentId}`, 'lessons', 'daily', 'playbook');
    });
    this.neural?.on('learned', () => this.#touch('brain'));
    this.live?.review?.on?.('report', () => this.#touch('review'));
    const every = setInterval(() => this.refresh(), VAULT.refreshMs);
    every.unref?.();
    const daily = setInterval(() => this.#prune(), 24 * 3_600_000);
    daily.unref?.();
    const now = setInterval(() => this.tick(), VAULT.nowMs);
    now.unref?.();
    this.timers.push(every, daily, now);
    this.tick();
    return true;
  }

  // Every minute: the Now note, and what each desk is watching for (when that changes).
  tick() {
    try {
      this.#nowNote();
      this.#watching();
    } catch (err) {
      this.#fail(err);
    }
  }

  stop() {
    for (const t of this.timers) clearInterval(t);
    this.timers = [];
    clearTimeout(this.flushTimer);
    this.#flush();
  }

  view() {
    return { enabled: true, dir: this.dir, mode: this.mode, notes: this.#count(), written: this.written, lastWrite: this.lastWrite, lastError: this.lastError, live: !!this.timers.length };
  }

  // Rewrite everything that summarises (the trade notes are written once, when they close).
  refresh() {
    this.dirty = new Set(['home', 'daily', 'lessons', 'playbook', 'brain', 'review', 'account', 'markets', ...this.fund.agents.map((a) => `desk:${a.id}`)]);
    this.#flush();
  }

  #touch(...keys) {
    for (const k of keys) this.dirty.add(k);
    if (this.flushTimer) return;
    this.flushTimer = setTimeout(() => {
      this.flushTimer = null;
      this.#flush();
    }, VAULT.flushMs);
    this.flushTimer.unref?.();
  }

  #flush() {
    const keys = [...this.dirty];
    this.dirty.clear();
    for (const k of keys) {
      try {
        if (k === 'home') this.#home();
        else if (k === 'daily') this.#daily();
        else if (k === 'lessons') this.#lessons();
        else if (k === 'playbook') this.#playbook();
        else if (k === 'brain') this.#brain();
        else if (k === 'review') this.#review();
        else if (k === 'account') this.#account();
        else if (k === 'markets') for (const s of this.#markets()) this.#market(s);
        else if (k.startsWith('market:')) this.#market(k.slice(7));
        else if (k.startsWith('desk:')) {
          const a = this.fund.byId.get(k.slice(5));
          if (a) this.#desk(a);
        }
      } catch (err) {
        this.#fail(err);
      }
    }
  }

  // ---- writing -------------------------------------------------------------------------------
  // Writes a note if what the floor generates changed, keeping the user's notes below the mark.
  write(rel, body) {
    const file = path.join(this.dir, rel);
    if (this.cache.get(rel) === body) return false;
    let mine = '';
    try {
      const old = fs.readFileSync(file, 'utf8');
      const i = old.indexOf(NOTES_MARK);
      if (i >= 0) {
        mine = old.slice(i + NOTES_MARK.length);
        if (old.slice(0, i).replace(/\n## Your notes\n*$/, '').trimEnd() === body.trimEnd()) {
          this.cache.set(rel, body);
          return false;
        }
      }
    } catch { /* a new note */ }
    const text = `${body.trimEnd()}\n\n## Your notes\n${NOTES_MARK}${mine || '\n'}`;
    try {
      fs.mkdirSync(path.dirname(file), { recursive: true });
      fs.writeFileSync(`${file}.tmp`, text);
      fs.renameSync(`${file}.tmp`, file);
      this.cache.set(rel, body);
      this.written++;
      this.lastWrite = this.now();
      this.lastError = null;
      return true;
    } catch (err) {
      this.#fail(err);
      return false;
    }
  }

  #fail(err) {
    const f = ['EPERM', 'EACCES'].includes(err.code) ? protectedFolder(this.dir) : null;
    const text = f
      ? `The vault can't be written in your ${folderName(f)}: macOS doesn't let the floor's background service write there. Set VAULT_DIR in .env to a folder outside it (e.g. VAULT_DIR=~/Meridian Vault) and restart the floor.`
      : err.message;
    if (this.lastError?.text !== text) this.log.warn?.(`[vault] ${text}`);
    this.lastError = { text, at: this.now() };
  }

  #count() {
    let n = 0;
    const walk = (d) => {
      let list = [];
      try { list = fs.readdirSync(d, { withFileTypes: true }); } catch { return; }
      for (const e of list) {
        if (e.name.startsWith('.')) continue;
        if (e.isDirectory()) walk(path.join(d, e.name));
        else if (e.name.endsWith('.md')) n++;
      }
    };
    walk(this.dir);
    return n;
  }

  // Obsidian's graph in the floor's colours (only when the vault is new: your settings win).
  #obsidianConfig() {
    const cfg = path.join(this.dir, '.obsidian');
    if (fs.existsSync(cfg)) return;
    fs.mkdirSync(cfg, { recursive: true });
    const rgb = (hex) => parseInt(hex.slice(1), 16);
    const graph = {
      showTags: true,
      colorGroups: [
        { query: 'tag:#win', color: { a: 1, rgb: rgb('#2fbf71') } },
        { query: 'tag:#loss', color: { a: 1, rgb: rgb('#e5534b') } },
        { query: 'path:Desks', color: { a: 1, rgb: rgb('#4c8dff') } },
        { query: 'path:Markets', color: { a: 1, rgb: rgb('#f2b01e') } },
        { query: 'path:Lessons', color: { a: 1, rgb: rgb('#a371f7') } },
        { query: 'path:Playbook', color: { a: 1, rgb: rgb('#5ec4d6') } },
      ],
    };
    fs.writeFileSync(path.join(cfg, 'graph.json'), JSON.stringify(graph, null, 2));
    fs.writeFileSync(path.join(cfg, 'app.json'), JSON.stringify({ alwaysUpdateLinks: true, showFrontmatter: false }, null, 2));
  }

  // Old trade and idea notes go (the numbers in the desk notes keep everything).
  #prune() {
    const cutoff = (days) => this.now() - days * 86_400_000;
    const clear = (sub, days, re) => {
      const base = path.join(this.dir, sub);
      let entries = [];
      try { entries = fs.readdirSync(base); } catch { return; }
      for (const name of entries) {
        const m = name.match(re);
        if (!m) continue;
        const at = Date.parse(`${m[1]}${m[1].length === 7 ? '-28' : ''}T23:59:59Z`);
        if (Number.isFinite(at) && at < cutoff(days)) fs.rmSync(path.join(base, name), { recursive: true, force: true });
      }
    };
    try {
      clear('Trades', VAULT.tradesKeptDays, /^(\d{4}-\d{2})$/);
      clear('Ideas', VAULT.ideasKeptDays, /^(\d{4}-\d{2}-\d{2})\.md$/);
      let desks = [];
      try { desks = fs.readdirSync(path.join(this.dir, 'Journal')); } catch { /* none yet */ }
      for (const d of desks) clear(path.join('Journal', d), VAULT.journalsKeptDays, /^(\d{4}-\d{2}-\d{2})\.md$/);
    } catch (err) {
      this.#fail(err);
    }
  }

  // ---- what the floor knows ------------------------------------------------------------------
  #real(t) {
    return !(this.mode === 'live' && t.simFeed) && Number.isFinite(t.r);
  }

  #tradeName(a, t) {
    if (this.tradeNames.has(t.id)) return this.tradeNames.get(t.id);
    const s = nyStamp(t.openTime);
    const name = safeName(`${s.day} ${s.compact} ${first(a)} ${t.symbol} ${t.side === 'LONG' ? 'long' : 'short'} ${String(t.id).slice(-4)}`);
    this.tradeNames.set(t.id, name);
    if (this.tradeNames.size > 20_000) this.tradeNames.delete(this.tradeNames.keys().next().value);
    return name;
  }

  // One closed trade, written once (later only if what the floor knows about it changes).
  #tradeNote(a, t, { quiet = false } = {}) {
    if (!this.#real(t)) return false;
    const name = this.#tradeName(a, t);
    const s = nyStamp(t.openTime);
    const rel = path.join('Trades', s.day.slice(0, 7), `${name}.md`);
    if (quiet && fs.existsSync(path.join(this.dir, rel))) return false;
    const win = t.r > 0;
    const held = Number.isFinite(t.closeTime) ? Math.max(1, Math.round((t.closeTime - t.openTime) / 60_000)) : null;
    const dec = SYMBOLS[t.symbol]?.decimals ?? 2;
    const px = (x) => (Number.isFinite(x) ? x.toFixed(dec) : '—');
    const n = t.neural;
    const body = `${yaml({
      desk: a.id, symbol: t.symbol, side: t.side === 'LONG' ? 'long' : 'short', opened: new Date(t.openTime).toISOString(), closed: Number.isFinite(t.closeTime) ? new Date(t.closeTime).toISOString() : null,
      result: win ? 'win' : 'loss', r: Math.round(t.r * 100) / 100, pnl: Math.round(t.pnl * 100) / 100, grade: t.grade ?? null, exit: t.exitReason ?? null,
      brain_chance: Number.isFinite(n?.p) ? Math.round(n.p * 100) / 100 : null,
      tags: ['trade', win ? 'win' : 'loss', `desk/${a.id}`, `market/${t.symbol}`],
    })}
# ${first(a)} · ${t.symbol} ${t.side === 'LONG' ? 'long' : 'short'} · ${fmtR(t.r)} ${win ? '✅' : '❌'}

- Desk: [[${a.profile.name}]] · Market: [[${t.symbol}]] · Day: [[${s.day}]]
- ${s.day} ${s.time} New York · ${px(t.entry)} → ${px(t.exit)}${held ? ` · held ${held} min` : ''}
- Result: **${fmtR(t.r)}** (${fmtUsd(t.pnl)} on paper, costs included)
- Why: ${cell(t.thesis || t.entryReason || '—')}
${t.grade ? `- Committee grade: **${t.grade}**\n` : ''}${Number.isFinite(n?.p) ? `- Neural brain: ${pct(n.p)} chance, ${fmtR(n.expR)} expected${n.explore ? ' (an exploration: it had passed on this idea)' : ''}\n` : ''}- Exit: ${cell(t.exitReason || '—')}
`;
    return this.write(rel, body);
  }

  // Every idea, taken or turned down, appended to the day's list as it happens.
  #idea(e) {
    if (!e?.agentId || this.mode === 'live' && e.simFeed) return;
    const text = String(e.text || '');
    let what = null;
    if (e.kind === 'entry') what = `**took it**: ${text}`;
    else if (/^(Committee said no|Skipped a signal|Too expensive|Brain passed|Signal skipped —)/.test(text)) what = `turned down: ${text}`;
    if (!what) return;
    const a = this.fund.byId.get(e.agentId);
    if (!a) return;
    const at = Number.isFinite(e.time) ? e.time : this.now();
    const s = nyStamp(at);
    const day = this.fund.session.tradingDay(at);
    const file = path.join(this.dir, 'Ideas', `${day}.md`);
    try {
      fs.mkdirSync(path.dirname(file), { recursive: true });
      if (!fs.existsSync(file)) fs.writeFileSync(file, `${yaml({ day, tags: ['ideas'] })}# Ideas · ${day}\n\nEvery trade idea the desks had today, the ones they took and the ones they turned down, and why. Day: [[${day}]]\n\n`);
      fs.appendFileSync(file, `- ${s.time} [[${a.profile.name}]] · ${a.symbol} · ${cell(what)}\n`);
      this.written++;
      this.lastWrite = this.now();
    } catch (err) {
      this.#fail(err);
    }
  }

  // ---- the desks' own notes ---------------------------------------------------------------------
  #journalFile(a, day) {
    return path.join(this.dir, 'Journal', safeName(a.profile.name), `${day}.md`);
  }

  #append(a, at, line) {
    const day = this.fund.session.tradingDay(at);
    const file = this.#journalFile(a, day);
    try {
      fs.mkdirSync(path.dirname(file), { recursive: true });
      if (!fs.existsSync(file)) {
        fs.writeFileSync(file, `${yaml({ desk: a.id, day, tags: ['journal', `desk/${a.id}`] })}# ${first(a)}'s journal · ${day}\n\nMy own notes as I work today, written as it happens. Me: [[${a.profile.name}]] · The day: [[${day}]] · Every idea on the floor: [[Ideas/${day}|idea log]]\n\n`);
      }
      fs.appendFileSync(file, `- ${nyStamp(at).time} ${line}\n`);
      this.written++;
      this.lastWrite = this.now();
      return true;
    } catch (err) {
      this.#fail(err);
      return false;
    }
  }

  // What a desk notes as it works (from its own log on the floor).
  #journal(e) {
    if (!e?.agentId) return;
    const a = this.fund.byId.get(e.agentId);
    if (!a) return;
    const text = cell(String(e.text || '')).trim();
    if (!text) return;
    const at = Number.isFinite(e.time) ? e.time : this.now();
    let line = null;
    if (e.kind === 'entry') line = `📈 **In:** ${text}`;
    else if (e.kind === 'exit') line = /Closed for a win/.test(text) ? `✅ **Won:** ${text}` : /Took a loss/.test(text) ? `❌ **Lost:** ${text}` : `🏁 ${text}`;
    else if (e.kind === 'partial') line = `💰 ${text}`;
    else if (e.kind === 'learn') line = `💡 **Learned:** ${text.replace(/^Lesson learned — /, '')}`;
    else if (e.kind === 'committee') line = `🏛️ **Committee:** ${text}`;
    else if (e.kind === 'halt' || e.kind === 'risk') line = `⛔ ${text}`;
    else if (e.kind === 'research') line = `🧪 ${text}`;
    else if (e.kind === 'live') line = `🟢 **FTMO:** ${text}`;
    else if (/^(Committee said no|Skipped a signal|Too expensive|Brain passed|Signal skipped —)/.test(text)) line = `🚫 **Turned down:** ${text}`;
    else if (e.kind === 'info' && !/^(Strategy error)/.test(text)) line = `📝 ${text}`;
    if (line) this.#append(a, at, line);
  }

  // Every few minutes each desk notes what it's watching, if that changed (its setup, its plan).
  #watching() {
    const now = this.now();
    this.watch ||= new Map();
    for (const a of this.fund.agents) {
      const stage = cell(a.setup?.stage || '').trim();
      // Starting up isn't worth a line (it would be one after every restart).
      if (!stage || /^(warming up|waiting for market history)/i.test(stage) || a.position?.()) continue;
      const last = this.watch.get(a.id);
      if (last && (last.text === stage || now - last.at < VAULT.watchEveryMs)) continue;
      this.watch.set(a.id, { text: stage, at: now });
      const thesis = cell(a.setup?.thesis || '').trim();
      this.#append(a, now, `👀 ${stage}${thesis && !stage.includes(thesis.slice(0, 30)) ? `. ${thesis}` : ''}`);
    }
  }

  // The close: every desk writes its review of the day into its journal.
  #endOfDay() {
    const day = this.fund.session.tradingDay(this.now());
    for (const a of this.fund.agents) {
      const file = this.#journalFile(a, day);
      try {
        if (fs.existsSync(file) && fs.readFileSync(file, 'utf8').includes('## End of day')) continue;
      } catch { /* write it */ }
      const list = this.#today(this.#trades(a));
      const s = this.#stats(list);
      const ideas = a.day?.ideas ?? 0;
      if (!ideas && !s.n) continue;
      const best = list.slice().sort((x, y) => y.r - x.r)[0];
      const worst = list.slice().sort((x, y) => x.r - y.r)[0];
      const adj = a.learner?.view?.().adjustments || [];
      const lines = [
        `- ${ideas} idea${ideas === 1 ? '' : 's'}: ${a.day?.entries ?? 0} taken, ${(a.day?.vetoed ?? 0) + (a.day?.skipped ?? 0)} turned down`,
        `- ${s.n} trade${s.n === 1 ? '' : 's'}: ${s.wins} won, ${s.n - s.wins} lost, ${fmtR(s.sumR)} (${fmtUsd(s.pnl)})`,
        best && s.n > 1 ? `- Best: [[${this.#tradeName(a, best)}]] ${fmtR(best.r)} · worst: [[${this.#tradeName(a, worst)}]] ${fmtR(worst.r)}` : null,
        `- How I trade now: ${adj.length ? adj.map(cell).join('; ') : 'nothing changed yet, my trades haven\'t shown a pattern worth acting on'}`,
      ].filter(Boolean);
      try {
        fs.mkdirSync(path.dirname(file), { recursive: true });
        if (!fs.existsSync(file)) this.#append(a, this.now(), '📕 Day over.');
        fs.appendFileSync(file, `\n## End of day\n${lines.join('\n')}\n`);
        this.written++;
        this.lastWrite = this.now();
      } catch (err) {
        this.#fail(err);
      }
    }
  }

  // The floor right now, every minute: what each desk is doing.
  #nowNote() {
    const now = this.now();
    const s = nyStamp(now);
    const rows = this.fund.agents.map((a) => {
      const pos = (a.positionsView?.() || []).map((p) => `${p.side === 'LONG' ? 'long' : 'short'} ${p.symbol}${Number.isFinite(p.r) ? ` ${fmtR(p.r)}` : ''} (${fmtUsd(p.unrealized)})`).join(', ');
      const td = this.#stats(this.#today(this.#trades(a)));
      const state = a.halted ? `⛔ ${a.halted}` : a.paused ? 'paused by you' : a.setup?.stage || '—';
      return `| [[${a.profile.name}]] | ${a.symbol}${a.weekend ? ' 🪙' : ''} | ${cell(state)} | ${pos || '—'} | ${td.n} · ${fmtR(td.sumR)} | [[Journal/${safeName(a.profile.name)}/${this.fund.session.tradingDay(now)}|journal]] |`;
    });
    const open = this.fund.agents.reduce((n, a) => n + (a.book?.positions?.size || 0), 0);
    const body = `${yaml({ tags: ['now'] })}
# The floor right now

**Live**: ${s.day} ${s.time} New York (rewritten every minute while the floor runs)${this.fund.weekendOn ? ' · weekend: the desks day-trade crypto 🪙' : ''} · ${open} position${open === 1 ? '' : 's'} open

| Desk | Market | Doing now | Open | Today | Notes |
|---|---|---|---|---|---|
${rows.join('\n')}
`;
    this.write('Now.md', body);
  }

  #trades(a) {
    return this.fund.broker.book(a.id).trades.filter((t) => this.#real(t));
  }

  #stats(list) {
    const n = list.length;
    const wins = list.filter((t) => t.r > 0).length;
    const sumR = list.reduce((s, t) => s + t.r, 0);
    return { n, wins, winRate: n ? wins / n : null, avgR: n ? sumR / n : null, sumR, pnl: list.reduce((s, t) => s + t.pnl, 0) };
  }

  #today(list) {
    const day = this.fund.session.tradingDay(this.now());
    return list.filter((t) => this.fund.session.tradingDay(t.closeTime ?? t.openTime) === day);
  }

  #status(a) {
    try {
      return this.live?.profile ? this.live.brain.deskStatus(a) : null;
    } catch {
      return null;
    }
  }

  #home() {
    const f = this.fund;
    const day = f.session.tradingDay(this.now());
    const rows = f.agents.map((a) => {
      const td = this.#stats(this.#today(this.#trades(a)));
      const all = this.#stats(this.#trades(a));
      const st = this.#status(a);
      return `| [[${a.profile.name}]] | ${a.symbol}${a.weekend ? ' (weekend)' : ''} | ${td.n} | ${td.wins} | ${fmtR(td.sumR)} | ${a.day?.ideas ?? 0} | ${all.n} | ${pct(all.winRate)} | ${fmtR(all.avgR)} | ${cell(st?.label || '—')} |`;
    });
    const recent = f.agents.flatMap((a) => this.#trades(a).map((t) => ({ a, t }))).sort((x, y) => (y.t.closeTime ?? 0) - (x.t.closeTime ?? 0)).slice(0, 20);
    const sk = this.neural?.ready ? this.neural.skill() : null;
    const body = `${yaml({ tags: ['home'], day })}
# Meridian Capital · the floor's vault

Written by the floor while it runs: every trade, win and loss, the ideas the desks took and turned down, what they learned, and what works. It's the same knowledge the desks trade on. Open [[What works]] and [[What loses]] first.

## Today (${day})
| Desk | Market | Trades | Won | R | Ideas | All trades | Won | Avg | On FTMO |
|---|---|---|---|---|---|---|---|---|---|
${rows.join('\n')}

Right now: [[Now|what every desk is doing]] · Ideas today: [[Ideas/${day}|every idea, taken or turned down]] · The day: [[${day}]]

## The floor
- Playbook: [[What works]] · [[What loses]] · [[Rules the desks follow]]
- Markets: ${this.#markets().map((s) => `[[${s}]]`).join(' · ')}
- The brains: [[Neural brain]]${sk ? ` (${sk.trusted ? 'has a say' : 'learning'}, skill ${sk.auc ?? '—'})` : ''} · [[Long-run record]] · [[Nightly review]] · [[FTMO account]]

## Latest trades
${recent.map(({ a, t }) => `- [[${this.#tradeName(a, t)}]] ${fmtR(t.r)} ${t.r > 0 ? '✅' : '❌'}`).join('\n') || '- None yet.'}
`;
    this.write('Home.md', body);
  }

  #desk(a) {
    const p = a.profile;
    const trades = this.#trades(a);
    const all = this.#stats(trades);
    const today = this.#stats(this.#today(trades));
    const L = a.lifetime || {};
    const recent = (L.recentR || []).slice(-20);
    const formR = recent.length ? recent.reduce((s, x) => s + x, 0) / recent.length : null;
    const st = this.#status(a);
    const long = this.live?.baseline?.forDesk?.(a.id) || null;
    const rev = this.live?.review?.verdictFor?.(a.id) || null;
    const ins = this.neural?.view?.().insights?.[a.id] || null;
    const learn = a.learner?.view?.() || null;
    const rules = Object.entries(a.rules || {}).map(([k, v]) => `${k} ${v}`).join(' · ');
    const sits = [];
    for (const [key, s] of Object.entries(this.memory?.state?.situations || {})) {
      const d = s.byDesk?.[a.id];
      if (d?.trades) sits.push({ key, trades: d.trades, avgR: d.sumR / d.trades });
    }
    sits.sort((x, y) => y.trades - x.trades);
    const body = `${yaml({
      desk: a.id, name: p.name, strategy: a.constructor.strategyName, market: a.symbol, home_market: p.symbols?.[0], trades: all.n,
      win_rate: all.winRate != null ? Math.round(all.winRate * 100) / 100 : null, avg_r: all.avgR != null ? Math.round(all.avgR * 1000) / 1000 : null,
      form_r: formR != null ? Math.round(formR * 1000) / 1000 : null, long_run: long?.verdict ?? null, account: st?.label ?? null, tags: ['desk'],
    })}
# ${p.name} · ${p.desk}

**${a.constructor.strategyName}** on [[${p.symbols?.[0]}]]${p.weekendSymbol ? `, and [[${p.weekendSymbol}]] at the weekend (crypto day trading)` : ''}. ${a.constructor.strategyBlurb || ''}
${rules ? `\nEntry rules: ${rules}\n` : ''}
## Where I stand
- On the FTMO account: **${cell(st?.label || 'not set up')}**${st?.text ? `: ${cell(st.text)}` : ''}
- Long-run record: ${long ? `**${long.verdict}**: ${this.live.baseline.recordText(long)}` : 'none for this desk yet'}
- Nightly review on your prices: ${rev ? `**${rev.verdict}**, ${fmtR(rev.avgR)} a trade over ${rev.n} trades` : 'none yet'}
- Form: ${formR != null ? `my last ${recent.length === 1 ? 'trade' : `${recent.length} trades`} on ${this.mode === 'sim' ? 'demo' : 'real'} prices ${recent.length === 1 ? 'made' : 'average'} **${fmtR(formR)}**` : `no trades on ${this.mode === 'sim' ? 'demo' : 'real'} prices yet`}

## My numbers (${this.mode === 'sim' ? 'demo prices' : 'real prices'})
| | Trades | Won | Win rate | Avg | Total | P&L |
|---|---|---|---|---|---|---|
| Today | ${today.n} | ${today.wins} | ${pct(today.winRate)} | ${fmtR(today.avgR)} | ${fmtR(today.sumR)} | ${fmtUsd(today.pnl)} |
| Kept in the book | ${all.n} | ${all.wins} | ${pct(all.winRate)} | ${fmtR(all.avgR)} | ${fmtR(all.sumR)} | ${fmtUsd(all.pnl)} |
| Since I started | ${L.realN ?? 0} | | | ${fmtR(L.realN ? L.realSumR / L.realN : null)} | ${fmtR(L.realSumR ?? null)} | |

Today: ${a.day?.ideas ?? 0} ideas, ${a.day?.entries ?? 0} taken, ${(a.day?.vetoed ?? 0) + (a.day?.skipped ?? 0)} turned down${a.day?.whyNot ? ` (last: ${cell(a.day.whyNot.text)})` : ''}. My notes today: [[Journal/${safeName(p.name)}/${this.fund.session.tradingDay(this.now())}|my journal]] · every idea: [[Ideas/${this.fund.session.tradingDay(this.now())}|today's ideas]].

## The rules I follow now (learned from my own trades)
${learn?.adjustments?.length ? learn.adjustments.map((x) => `- ${cell(x)}`).join('\n') : '- Nothing changed yet: my trades haven\'t shown a pattern worth acting on.'}

## Lessons
${learn?.lessons?.length ? learn.lessons.slice(0, 12).map((l) => `- [[${this.#lessonName(a, l)}]] · ${cell(l.status)}`).join('\n') : '- None yet.'}

## What my neural brain noticed${this.neural?.skill?.().trusted ? '' : ' (hunches until it proves itself)'}
${ins ? [
    ins.helps?.length ? `- More likely to win when ${ins.helps.map((h) => `${h.text} (+${h.points} pts)`).join(', ')}` : null,
    ins.hurts?.length ? `- Less likely when ${ins.hurts.map((h) => `${h.text} (−${h.points} pts)`).join(', ')}` : null,
    ins.bestHours?.length ? `- Best hours ${ins.bestHours.map((h) => `${pad(h)}:00`).join(', ')} New York, worst ${ins.worstHours.map((h) => `${pad(h)}:00`).join(', ')}` : null,
  ].filter(Boolean).join('\n') : '- Nothing yet.'}

## Situations I've traded (floor memory)
| Market | Situation | Trades | Avg |
|---|---|---|---|
${sits.slice(0, 12).map((s) => { const { symbol, text } = situationLabel(s.key); return `| [[${symbol}]] | ${text} | ${s.trades} | ${fmtR(s.avgR)} |`; }).join('\n') || '| | none yet | | |'}

## Recent trades
${trades.slice(-VAULT.recentTrades).reverse().map((t) => `- [[${this.#tradeName(a, t)}]] ${fmtR(t.r)} ${t.r > 0 ? '✅' : '❌'} · ${cell(t.exitReason || '')}`).join('\n') || '- None yet.'}
`;
    this.write(path.join('Desks', `${safeName(p.name)}.md`), body);
  }

  #lessonName(a, l) {
    return safeName(`${first(a)} - ${l.title}`);
  }

  #lessons() {
    for (const a of this.fund.agents) {
      for (const l of a.learner?.state?.lessons || []) {
        const s = nyStamp(l.time ?? this.now());
        const ev = l.evidence ? Object.entries(l.evidence).map(([k, v]) => `${k} ${v}`).join(' · ') : '';
        const body = `${yaml({ desk: a.id, learned: s.day, status: l.status, tags: ['lesson', `desk/${a.id}`] })}
# ${cell(l.title)}

- Desk: [[${a.profile.name}]] · learned ${s.day} ${s.time} New York · status: **${cell(l.status)}**${l.result != null ? ` (since then ${fmtR(l.result)} a trade)` : ''}
${ev ? `- Evidence: ${cell(ev)}\n` : ''}
${cell(l.text)}
`;
        this.write(path.join('Lessons', `${this.#lessonName(a, l)}.md`), body);
      }
    }
  }

  #markets() {
    const set = new Set();
    for (const a of this.fund.agents) {
      if (!a.profile.lab) set.add(a.profile.symbols?.[0]);
      if (a.profile.weekendSymbol) set.add(a.profile.weekendSymbol);
    }
    for (const key of Object.keys(this.memory?.state?.situations || {})) set.add(key.split('|')[0]);
    return [...set].filter((s) => SYMBOLS[s]).sort();
  }

  #market(sym) {
    if (!SYMBOLS[sym]) return;
    const sits = Object.entries(this.memory?.state?.situations || {}).filter(([k]) => k.startsWith(`${sym}|`)).map(([key, s]) => ({ key, ...s, avg: s.sum / Math.max(1e-9, s.n) })).sort((x, y) => y.avg - x.avg);
    const desks = this.fund.agents.filter((a) => a.profile.symbols?.[0] === sym && !a.profile.lab);
    const weekend = this.fund.agents.filter((a) => a.profile.weekendSymbol === sym);
    const body = `${yaml({ symbol: sym, name: SYMBOLS[sym].name, tags: ['market'] })}
# ${sym} · ${SYMBOLS[sym].name}

- Traded by: ${desks.map((a) => `[[${a.profile.name}]]`).join(' · ') || '—'}${weekend.length ? `\n- At the weekend also: ${weekend.map((a) => `[[${a.profile.name}]]`).join(' · ')}` : ''}

## Situations the floor remembers here
Recent trades count more; a situation is trusted from about 6 trades.

| Situation | Trades | Avg | Won |
|---|---|---|---|
${sits.map((s) => `| ${situationLabel(s.key).text} | ${s.trades} | ${fmtR(s.avg)} | ${pct(s.n ? s.wins / s.n : null)} |`).join('\n') || '| none yet | | | |'}
`;
    this.write(path.join('Markets', `${safeName(sym)}.md`), body);
  }

  #playbook() {
    const sits = Object.entries(this.memory?.state?.situations || {}).map(([key, s]) => ({ key, ...s, avg: s.sum / Math.max(1e-9, s.n), shrunk: s.sum / (s.n + 6) })).filter((s) => s.n >= 6);
    const line = (s) => {
      const { symbol, text } = situationLabel(s.key);
      const who = Object.entries(s.byDesk || {}).sort((x, y) => y[1].trades - x[1].trades).slice(0, 3).map(([id]) => this.fund.byId.get(id)).filter(Boolean).map((a) => `[[${a.profile.name}]]`).join(', ');
      return `| [[${symbol}]] | ${text} | ${s.trades} | ${fmtR(s.avg)} | ${pct(s.n ? s.wins / s.n : null)} | ${who} |`;
    };
    const head = '| Market | Situation | Trades | Avg | Won | Who trades it |\n|---|---|---|---|---|---|';
    const works = sits.filter((s) => s.shrunk > 0).sort((x, y) => y.shrunk - x.shrunk).slice(0, 25);
    const loses = sits.filter((s) => s.shrunk < 0).sort((x, y) => x.shrunk - y.shrunk).slice(0, 25);
    this.write(path.join('Playbook', 'What works.md'), `${yaml({ tags: ['playbook'] })}
# What works

Situations where the floor's trades on real prices made money (with enough of them to mean something: about 6 or more, recent ones counting most). See also [[What loses]] and [[Rules the desks follow]].

${works.length ? `${head}\n${works.map(line).join('\n')}` : 'Nothing has earned a place here yet.'}
`);
    this.write(path.join('Playbook', 'What loses.md'), `${yaml({ tags: ['playbook'] })}
# What loses

Situations where the floor's trades on real prices lost money. The committee weighs these before every trade, and the desks sit out the ones their own trades keep losing in.

${loses.length ? `${head}\n${loses.map(line).join('\n')}` : 'Nothing here yet.'}
`);
    const rules = this.fund.agents.map((a) => {
      const adj = a.learner?.view?.().adjustments || [];
      return adj.length ? `### [[${a.profile.name}]]\n${adj.map((x) => `- ${cell(x)}`).join('\n')}` : null;
    }).filter(Boolean);
    let plan = null;
    try {
      plan = this.live?.profile ? this.live.brain.state() : null;
    } catch { /* no account yet */ }
    this.write(path.join('Playbook', 'Rules the desks follow.md'), `${yaml({ tags: ['playbook'] })}
# Rules the desks follow

## Learned by each desk from its own trades
${rules.join('\n\n') || 'No desk has changed how it trades yet.'}

## The account plan (FTMO)
${plan ? plan.rules.map((r) => `- ${r.ok ? '✅' : '⚠️'} ${cell(r.text)}`).join('\n') : '- Not set up yet: connect MT5 and set up the account in the FTMO tab.'}
`);
  }

  #daily() {
    const f = this.fund;
    const day = f.session.tradingDay(this.now());
    const rows = [];
    const won = [];
    const lost = [];
    for (const a of f.agents) {
      const list = this.#today(this.#trades(a));
      if (!list.length && !(a.day?.ideas)) continue;
      const s = this.#stats(list);
      rows.push(`| [[${a.profile.name}]] | ${a.day?.ideas ?? 0} | ${s.n} | ${s.wins} | ${fmtR(s.sumR)} | ${fmtUsd(s.pnl)} |`);
      for (const t of list) (t.r > 0 ? won : lost).push(`- [[${this.#tradeName(a, t)}]] ${fmtR(t.r)}`);
    }
    const lessons = f.agents.flatMap((a) => (a.learner?.state?.lessons || []).filter((l) => f.session.tradingDay(l.time ?? 0) === day).map((l) => `- [[${this.#lessonName(a, l)}]]`));
    let acct = null;
    try {
      const r = this.live?.reports?.current;
      if (r?.day) {
        const s = summarize(r);
        const closed = closedTrades(r);
        acct = `- Day P&L ${fmtUsd(s.dayPnl)} · ${s.trades} trades on FTMO, ${s.wins} won · ${s.skipped} held back\n${closed.map((t) => `- ${cell(t.name || t.agentId)} ${cell(t.symbol || '')} ${fmtUsd(t.pnl)}`).join('\n')}`;
      }
    } catch { /* no account */ }
    this.write(path.join('Daily', `${day}.md`), `${yaml({ day, tags: ['daily'] })}
# ${day}

Every idea today, taken or turned down: [[Ideas/${day}|the idea log]]. Each desk's own notes: ${f.agents.map((a) => `[[Journal/${safeName(a.profile.name)}/${day}|${first(a)}]]`).join(' · ')}.

| Desk | Ideas | Trades | Won | R | P&L |
|---|---|---|---|---|---|
${rows.join('\n') || '| no trades yet | | | | | |'}

## Wins
${won.join('\n') || '- None yet.'}

## Losses
${lost.join('\n') || '- None yet.'}

## Lessons learned today
${lessons.join('\n') || '- None today.'}

## The FTMO account
${acct || '- No account activity today.'}
`);
  }

  #brain() {
    const v = this.neural?.view?.();
    if (!v?.ready) return;
    const sk = v.skill;
    const desks = Object.entries(v.insights || {}).map(([id, s]) => {
      const a = this.fund.byId.get(id);
      return a ? `### [[${a.profile.name}]]\n- ${s.helps?.length ? `More likely to win when ${s.helps.map((h) => h.text).join(', ')}` : 'No strong signs'}\n- ${s.hurts?.length ? `Less likely when ${s.hurts.map((h) => h.text).join(', ')}` : ''}` : null;
    }).filter(Boolean);
    this.write(path.join('Brain', 'Neural brain.md'), `${yaml({ version: v.version, mode: v.mode, skill: sk?.auc ?? null, tags: ['brain'] })}
# Neural brain · version ${v.version}

**${v.mode === 'trusted' ? 'It has a say' : 'Learning: it judges every idea and learns from every trade, the desks decide'}.** ${cell(sk?.text || '')}

- Learned from ${v.trainedOn?.n?.toLocaleString('en-US') ?? '?'} trades, plus ${v.own?.n ?? 0} of the floor's own on real prices (${v.own?.newSinceTrain ?? 0} since its last lesson)
- Lessons: ${(v.versions || []).slice(-8).reverse().map((r) => `${nyStamp(r.at).day} ${r.adopted ? `learned (v${r.version})` : 'kept what it knew'}`).join(' · ') || 'none yet'}

## What it noticed, desk by desk${v.mode === 'trusted' ? '' : ' (hunches until it proves itself)'}
${desks.join('\n\n') || 'Nothing yet.'}
`);
    const base = this.live?.baseline?.view?.();
    if (base) {
      this.write(path.join('Brain', 'Long-run record.md'), `${yaml({ tags: ['brain'] })}
# Long-run record

Every desk replayed on months of real 1-minute prices (${cell(base.source)}). A desk that lost money with confidence trades paper only on a paid challenge.

| Desk | Market | Trades | Per trade | 90% range | Verdict |
|---|---|---|---|---|---|
${base.desks.filter((d) => d.n).map((d) => { const a = this.fund.byId.get(d.id); return `| ${a ? `[[${a.profile.name}]]` : d.name} | [[${d.symbol}]] | ${d.n.toLocaleString('en-US')} | ${fmtR(d.avgR)} | ${d.ci ? `${fmtR(d.ci[0])} to ${fmtR(d.ci[1])}` : '—'} | **${d.verdict}** |`; }).join('\n')}
`);
    }
  }

  #review() {
    const r = this.live?.review?.report;
    if (!r?.desks) return;
    const s = nyStamp(r.at);
    this.write(path.join('Brain', 'Nightly review.md'), `${yaml({ reviewed: s.day, tags: ['brain'] })}
# Nightly review · ${s.day}

Each desk replayed on your own MT5 prices with FTMO's costs (${r.tradingDays ?? '?'} trading days).

| Desk | Trades | Per trade | Verdict |
|---|---|---|---|
${r.desks.filter((d) => d.n).map((d) => { const a = this.fund.byId.get(d.id); return `| ${a ? `[[${a.profile.name}]]` : d.id} | ${d.n} | ${fmtR(d.avgR)} | **${d.verdict}** |`; }).join('\n')}
`);
  }

  #account() {
    let st = null;
    try {
      st = this.live?.profile ? this.live.brain.state() : null;
    } catch { /* not set up */ }
    if (!st) return;
    this.write(path.join('Brain', 'FTMO account.md'), `${yaml({ phase: st.phase, status: st.status, tags: ['brain'] })}
# FTMO account · ${cell(st.phase)}

${cell(st.goal)}

- Equity ${fmtUsd(st.equity).replace('+', '')} · from the start ${fmtUsd(st.profit)} · today ${fmtUsd(st.dayPnl)}
- Status: **${cell(st.status)}**${st.blocked ? ` · ${cell(st.blocked)}` : ''}
- Risk per trade now ${st.riskPct}% · trades today ${st.tradesToday}

## The plan
${st.rules.map((x) => `- ${x.ok ? '✅' : '⚠️'} ${cell(x.text)}`).join('\n')}

Every day's numbers: the daily notes, e.g. [[${this.fund.session.tradingDay(this.now())}]].
`);
  }
}
