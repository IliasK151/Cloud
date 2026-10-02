import { EventEmitter } from 'node:events';

// Server side of the MT5 bridge. The MeridianBridge EA POSTs a sync every ~500ms with
// account, positions, deals, quotes and acknowledgements. The reply is plain text,
// one command per line, which the EA executes:
//   watch|SYM1,SYM2          prices + bars to include in every sync
//   history|SYM|600[|START]  one-off 1-minute history request: COUNT closed bars, the newest
//                            START bars back (EA 1.3+; older EAs ignore START and send the
//                            latest bars, which the floor notices and stops paging)
//   symbols                  send the full symbol list
//   open|id|SYM|BUY|vol|slDist|tpDist|magic|comment
//   close|id|ticket|fraction
//   modify|id|ticket|sl|tp
//   closeall|id|bridge
//   pace|ms                  how soon to sync again (EA 1.2+; older EAs ignore it)
// Commands are re-sent until acknowledged; the EA de-duplicates by id.
//
// The pace saves a MacBook's battery: MT5 runs through a Windows layer on a Mac, and each
// sync wakes it up. Twice a second only while orders are on their way, once a second while
// positions are open or a desk is about to trade, every 2 seconds otherwise.

// FTMO allows 2,000 order actions (opens, closes, stop changes) a day. The floor normally
// sends about a hundred; these are seatbelts in case something ever loops.
export const ACTION_LIMITS = { ftmo: 2000, newTrades: 1000, stopMoves: 1500 };

const STALE_MS = 5000;
export const PACE = { busy: 500, active: 1000, idle: 2000 };
const RESEND_MS = 8000;
const HISTORY_PAGE_GIVEUP_MS = 90_000;
const COMMAND_TTL_MS = 60_000;

let seq = 0;

export class Mt5Bridge extends EventEmitter {
  constructor() {
    super();
    this.lastSync = 0;
    this.version = null;
    this.caps = null;
    this.maxBars = null;
    this.account = null;
    this.positions = [];
    this.deals = [];
    this.quotes = {};
    this.symbols = [];
    this.gmtOffset = 0;
    this.serverDay = null;
    this.pending = new Map(); // id -> { id, line, createdAt, sentAt, meta }
    this.watchList = [];
    this.historyWanted = new Map(); // brokerSymbol -> { count, lastAsked }
    this.wantSymbols = false;
    this.lastCommandAt = 0;
    this.urgent = false; // set by the live trader: a desk is about to trade the account
    this.actions = { day: null, n: 0 }; // order actions sent on this server day
  }

  // Order actions sent to MT5 on this server day (FTMO counts every order request).
  actionsToday() {
    return this.actions.day === this.serverDay ? this.actions.n : 0;
  }

  get connected() {
    return Date.now() - this.lastSync < STALE_MS;
  }

  // Process one sync from the EA and return the reply body.
  handleSync(msg) {
    const now = Date.now();
    this.lastSync = now;
    this.version = msg.version ?? this.version;
    // The EA's own safety caps (EA 1.1+): max risk per order and max floor positions.
    if (msg.caps && typeof msg.caps === 'object') this.caps = { maxRiskPct: Number(msg.caps.maxRiskPct) || 0, maxPositions: Number(msg.caps.maxPositions) || 0 };
    // MT5's "Max bars in chart" (EA 1.3+): how far back it can hand over history.
    if (Number.isFinite(msg.maxBars) && msg.maxBars > 0) this.maxBars = msg.maxBars;
    const prevLogin = this.account?.login;
    this.account = msg.account ?? this.account;
    this.positions = Array.isArray(msg.positions) ? msg.positions : [];
    this.deals = Array.isArray(msg.deals) ? msg.deals : [];
    this.quotes = msg.quotes && typeof msg.quotes === 'object' ? msg.quotes : {};
    // Broker server time offset from UTC, rounded to the nearest 15 minutes.
    if (Number.isFinite(msg.gmtOffset)) this.gmtOffset = Math.round(msg.gmtOffset / 900) * 900;
    this.serverDay = msg.serverDay ?? this.serverDay;
    if (Array.isArray(msg.symbols)) {
      this.symbols = msg.symbols;
      this.wantSymbols = false;
      this.emit('symbols', this.symbols);
    }
    if (this.account && this.account.login !== prevLogin) this.emit('account', this.account);

    for (const ack of msg.acks || []) {
      const cmd = this.pending.get(ack.id);
      if (!cmd) continue;
      this.pending.delete(ack.id);
      if (ack.msg === 'duplicate') continue;
      this.emit('ack', { ...ack, meta: cmd.meta, kind: cmd.kind });
    }
    if (msg.history && typeof msg.history === 'object') {
      for (const [sym, rows] of Object.entries(msg.history)) {
        const asked = this.historyWanted.get(sym);
        this.historyWanted.delete(sym);
        this.emit('history', sym, this.toBars(rows), { start: asked?.start ?? 1, count: asked?.count ?? null });
      }
    }
    // A page further back that MT5 never answers has nothing to give (beyond the history it
    // holds): stop asking once it has been asked a few times over a while without an answer.
    // Time MT5 was away (asleep, restarting) doesn't count: it wasn't asked then. The first
    // request for a market waits for MT5 to download its history, however long that takes.
    for (const [sym, h] of this.historyWanted) {
      if (h.start > 1 && h.asks >= 3 && now - h.firstAsked > HISTORY_PAGE_GIVEUP_MS) {
        this.historyWanted.delete(sym);
        this.emit('history-missing', sym, { start: h.start, count: h.count });
      }
    }
    this.emit('sync', this);
    return this.#reply(now);
  }

  pace(now = Date.now()) {
    // History MT5 can't give (yet) doesn't keep it busy for more than a minute.
    const history = [...this.historyWanted.values()].some((h) => now - h.since < 60_000);
    if (this.pending.size || history || this.wantSymbols || !this.symbols.length || now - this.lastCommandAt < 15_000) return PACE.busy;
    if (this.positions.length || this.urgent) return PACE.active;
    return PACE.idle;
  }

  #reply(now) {
    const lines = ['OK'];
    if (this.watchList.length) lines.push(`watch|${this.watchList.join(',')}`);
    if (this.wantSymbols || !this.symbols.length) lines.push('symbols');
    let asked = 0;
    let pages = 0;
    for (const [sym, h] of this.historyWanted) {
      if (asked >= 2) break;
      if (now - h.lastAsked < 10_000) continue;
      // Paging back through history is background work: one page a sync, and never while an
      // order is on its way (MT5 builds the reply before it does anything else).
      if (h.start > 1 && (pages >= 1 || this.pending.size)) continue;
      if (h.start > 1) pages++;
      h.lastAsked = now;
      h.firstAsked ??= now;
      h.asks = (h.asks || 0) + 1;
      lines.push(`history|${sym}|${h.count}${h.start > 1 ? `|${h.start}` : ''}`);
      asked++;
    }
    for (const [id, cmd] of this.pending) {
      if (now - cmd.createdAt > COMMAND_TTL_MS) {
        this.pending.delete(id);
        this.emit('ack', { id, ok: false, retcode: 0, msg: 'Timed out waiting for MT5', meta: cmd.meta, kind: cmd.kind });
        continue;
      }
      if (!cmd.sentAt || now - cmd.sentAt > RESEND_MS) {
        cmd.sentAt = now;
        lines.push(cmd.line);
      }
    }
    // After the commands above, so this sync's own new commands count.
    lines.push(`pace|${this.pace(now)}`);
    return lines.join('\n') + '\n';
  }

  // Broker bars arrive in server time; convert to UTC seconds.
  toBars(rows = []) {
    return rows
      .filter((r) => Array.isArray(r) && r.length >= 5)
      .map(([t, o, h, l, c, v]) => ({ time: t - this.gmtOffset, open: o, high: h, low: l, close: c, volume: v || 0 }));
  }

  watch(symbols) {
    this.watchList = [...new Set(symbols.filter(Boolean))];
  }

  // COUNT closed 1-minute bars, the newest START bars back from now (1: the latest closed bar).
  requestHistory(symbol, count = 600, start = 1) {
    if (!this.historyWanted.has(symbol)) this.historyWanted.set(symbol, { count, start: Math.max(1, Math.round(start) || 1), lastAsked: 0, since: Date.now() });
  }

  // Is a history request for this symbol on its way?
  historyPending(symbol) {
    return this.historyWanted.has(symbol);
  }

  requestSymbols() {
    this.wantSymbols = true;
  }

  #queue(kind, fields, meta) {
    const id = `c${Date.now().toString(36)}${(++seq).toString(36)}`;
    if (this.actions.day !== this.serverDay) this.actions = { day: this.serverDay, n: 0 };
    // Closing everything is one request per position on the server.
    this.actions.n += kind === 'closeall' ? Math.max(1, this.positions.length) : 1;
    const clean = fields.map((f) => String(f).replace(/[|\n\r]/g, ' '));
    this.pending.set(id, { id, kind, line: [kind, id, ...clean].join('|'), createdAt: Date.now(), sentAt: 0, meta });
    this.lastCommandAt = Date.now();
    return id;
  }

  open({ symbol, side, volume, slDistance, tpDistance = 0, magic, comment }, meta) {
    return this.#queue('open', [symbol, side, volume, slDistance, tpDistance, magic, comment], meta);
  }

  close(ticket, fraction = 1, meta) {
    return this.#queue('close', [ticket, fraction], meta);
  }

  modify(ticket, sl, tp = 'keep', meta) {
    return this.#queue('modify', [ticket, sl, tp], meta);
  }

  closeAll(meta) {
    return this.#queue('closeall', ['bridge'], meta);
  }

  hasPending(predicate) {
    for (const cmd of this.pending.values()) if (predicate(cmd)) return true;
    return false;
  }
}
