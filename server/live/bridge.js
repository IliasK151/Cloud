import { EventEmitter } from 'node:events';

// Server side of the MT5 bridge. The MeridianBridge EA POSTs a sync every ~500ms with
// account, positions, deals, quotes and acknowledgements. The reply is plain text,
// one command per line, which the EA executes:
//   watch|SYM1,SYM2          prices + bars to include in every sync
//   history|SYM|600          one-off 1-minute history request
//   symbols                  send the full symbol list
//   open|id|SYM|BUY|vol|slDist|tpDist|magic|comment
//   close|id|ticket|fraction
//   modify|id|ticket|sl|tp
//   closeall|id|bridge
// Commands are re-sent until acknowledged; the EA de-duplicates by id.

const STALE_MS = 5000;
const RESEND_MS = 8000;
const COMMAND_TTL_MS = 60_000;

let seq = 0;

export class Mt5Bridge extends EventEmitter {
  constructor() {
    super();
    this.lastSync = 0;
    this.version = null;
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
  }

  get connected() {
    return Date.now() - this.lastSync < STALE_MS;
  }

  // Process one sync from the EA and return the reply body.
  handleSync(msg) {
    const now = Date.now();
    this.lastSync = now;
    this.version = msg.version ?? this.version;
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
        this.historyWanted.delete(sym);
        this.emit('history', sym, this.toBars(rows));
      }
    }
    this.emit('sync', this);
    return this.#reply(now);
  }

  #reply(now) {
    const lines = ['OK'];
    if (this.watchList.length) lines.push(`watch|${this.watchList.join(',')}`);
    if (this.wantSymbols || !this.symbols.length) lines.push('symbols');
    let asked = 0;
    for (const [sym, h] of this.historyWanted) {
      if (asked >= 2) break;
      if (now - h.lastAsked < 10_000) continue;
      h.lastAsked = now;
      lines.push(`history|${sym}|${h.count}`);
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

  requestHistory(symbol, count = 600) {
    if (!this.historyWanted.has(symbol)) this.historyWanted.set(symbol, { count, lastAsked: 0 });
  }

  requestSymbols() {
    this.wantSymbols = true;
  }

  #queue(kind, fields, meta) {
    const id = `c${Date.now().toString(36)}${(++seq).toString(36)}`;
    const clean = fields.map((f) => String(f).replace(/[|\n\r]/g, ' '));
    this.pending.set(id, { id, kind, line: [kind, id, ...clean].join('|'), createdAt: Date.now(), sentAt: 0, meta });
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
