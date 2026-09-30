import fs from 'node:fs';
import crypto from 'node:crypto';
import { EventEmitter } from 'node:events';
import { isLoopbackAddress } from './localGuard.js';

// The internet-facing firewall for the TradingView webhook: the only part of the floor
// reachable from the internet (through the tunnel). Every request passes, in order:
//   1. Ban list: an address that sent too many wrong secrets is refused for an hour.
//   2. Rate limits per address and overall, so nobody can flood the floor.
//   3. Size and shape: small bodies only, parsed as data, never executed.
//   4. The secret, compared in constant time. Wrong secret: counted toward a ban.
//   5. Trades only from TradingView's own servers (their published webhook addresses).
//      Connection checks ("ping") may come from anywhere with the right secret.
//   6. The right secret from an address that is not TradingView is treated as a leaked
//      secret: the alert is refused, the floor raises a security alarm and asks you to
//      rotate the secret.
// Everything refused is written to the security log (data/security-log.json).

// TradingView's published webhook source addresses
// (https://www.tradingview.com/support/solutions/43000529348/).
export const TRADINGVIEW_IPS = ['52.89.214.238', '34.212.75.30', '54.218.53.128', '52.32.178.7'];

const MINUTE = 60_000;
const BAN_AFTER_FAILS = 5;
const FAIL_WINDOW_MS = 15 * MINUTE;
const BAN_MS = 60 * MINUTE;
const PER_IP_PER_MIN = 30;
const GLOBAL_PER_MIN = 600;
const LOG_KEEP = 200;

const clean = (ip) => String(ip || '').trim().replace(/^::ffff:/, '');

export class WebhookFirewall extends EventEmitter {
  constructor({ file = null, log = console, now = () => Date.now(), tradingViewIps = TRADINGVIEW_IPS } = {}) {
    super();
    this.file = file;
    this.log = log;
    this.now = now;
    this.tvIps = new Set(tradingViewIps);
    this.fails = new Map(); // ip → [times]
    this.bans = new Map(); // ip → until
    this.hits = new Map(); // ip → { start, n }
    this.global = { start: now(), n: 0 };
    this.stats = { allowed: 0, blocked: 0, badSecret: 0, banned: 0, notTradingView: 0, rateLimited: 0 };
    const saved = this.#load();
    this.settings = { tradingViewOnly: saved.settings?.tradingViewOnly !== false };
    this.events = Array.isArray(saved.events) ? saved.events.slice(-LOG_KEEP) : [];
    this.alarm = saved.alarm || null; // leaked-secret alarm, until the secret is rotated
  }

  #load() {
    if (!this.file) return {};
    try {
      return JSON.parse(fs.readFileSync(this.file, 'utf8'));
    } catch {
      return {};
    }
  }

  #save() {
    if (!this.file) return;
    clearTimeout(this.saveTimer);
    this.saveTimer = setTimeout(() => this.flush(), 500);
    this.saveTimer.unref?.();
  }

  flush() {
    if (!this.file) return;
    clearTimeout(this.saveTimer);
    try {
      fs.writeFileSync(`${this.file}.tmp`, JSON.stringify({ settings: this.settings, alarm: this.alarm, events: this.events.slice(-LOG_KEEP) }), { mode: 0o600 });
      fs.renameSync(`${this.file}.tmp`, this.file);
    } catch (err) {
      this.log.warn?.(`[security] could not save the security log: ${err.message}`);
    }
  }

  // The real sender. Behind the tunnel the connection comes from the tunnel app on this
  // Mac, which reports the true address (Cloudflare: CF-Connecting-IP, which Cloudflare
  // overwrites; ngrok: the last X-Forwarded-For entry, which ngrok adds). Those headers are
  // trusted only on connections from this Mac, never from anywhere else.
  clientIp(req) {
    const remote = clean(req.socket?.remoteAddress);
    if (!isLoopbackAddress(remote)) return { ip: remote, local: false, via: 'direct' };
    const cf = req.headers['cf-connecting-ip'];
    if (cf) return { ip: clean(cf), local: false, via: 'cloudflare' };
    const xff = req.headers['x-forwarded-for'];
    if (xff) {
      const parts = String(xff).split(',').map((x) => clean(x)).filter(Boolean);
      if (parts.length) return { ip: parts[parts.length - 1], local: false, via: 'proxy' };
    }
    return { ip: remote, local: true, via: 'local' };
  }

  record(kind, ip, text, extra = {}) {
    const ev = { time: this.now(), kind, ip, text, ...extra };
    this.events.push(ev);
    if (this.events.length > LOG_KEEP * 1.5) this.events.splice(0, this.events.length - LOG_KEEP);
    this.#save();
    this.emit('event', ev);
    return ev;
  }

  // Before the body is even looked at: bans and rate limits.
  admit(client) {
    const now = this.now();
    const { ip, local } = client;
    const until = this.bans.get(ip);
    if (until && until > now) {
      this.stats.blocked++;
      this.stats.banned++;
      return { ok: false, status: 403, error: 'blocked' };
    }
    if (until) this.bans.delete(ip);
    if (now - this.global.start > MINUTE) this.global = { start: now, n: 0 };
    this.global.n++;
    let h = this.hits.get(ip);
    if (!h || now - h.start > MINUTE) {
      h = { start: now, n: 0 };
      this.hits.set(ip, h);
    }
    h.n++;
    if (this.hits.size > 5000) this.#prune(now);
    if (!local && (h.n > PER_IP_PER_MIN || this.global.n > GLOBAL_PER_MIN)) {
      this.stats.blocked++;
      this.stats.rateLimited++;
      if (h.n === PER_IP_PER_MIN + 1) this.record('rate', ip, `Too many requests from ${ip}: slowed down for a minute`);
      return { ok: false, status: 429, error: 'rate limited' };
    }
    return { ok: true };
  }

  #prune(now) {
    for (const [ip, h] of this.hits) if (now - h.start > MINUTE) this.hits.delete(ip);
    for (const [ip, t] of this.fails) if (!t.some((x) => now - x < FAIL_WINDOW_MS)) this.fails.delete(ip);
  }

  // A wrong secret: after a few from the same address, it is banned for an hour.
  badSecret(client) {
    const now = this.now();
    const { ip, local } = client;
    this.stats.blocked++;
    this.stats.badSecret++;
    const list = (this.fails.get(ip) || []).filter((t) => now - t < FAIL_WINDOW_MS);
    list.push(now);
    this.fails.set(ip, list);
    if (!local && list.length >= BAN_AFTER_FAILS) {
      this.bans.set(ip, now + BAN_MS);
      this.fails.delete(ip);
      this.record('ban', ip, `Banned ${ip} for an hour after ${BAN_AFTER_FAILS} wrong secrets`);
    } else {
      this.record('bad-secret', ip, `Wrong secret from ${ip}${local ? ' (this Mac)' : ''}`);
    }
    return { ok: false, status: 401, error: 'unauthorized' };
  }

  // Right secret. May this address trade?
  authorize(client, action) {
    const { ip, local } = client;
    if (action === 'ping' || local || !this.settings.tradingViewOnly || this.tvIps.has(ip)) {
      this.stats.allowed++;
      return { ok: true };
    }
    this.stats.blocked++;
    this.stats.notTradingView++;
    // Someone who is not TradingView knows the secret: raise the alarm.
    this.alarm = { time: this.now(), ip, text: `A ${action} alert with your correct webhook secret came from ${ip}, which is not a TradingView server. It was refused. Rotate the secret now.` };
    this.record('leak', ip, this.alarm.text);
    this.log.warn?.(`[security] ${this.alarm.text}`);
    this.emit('alarm', this.alarm);
    return { ok: false, status: 403, error: 'trade alerts are only accepted from TradingView' };
  }

  setSettings({ tradingViewOnly } = {}) {
    if (typeof tradingViewOnly === 'boolean' && tradingViewOnly !== this.settings.tradingViewOnly) {
      this.settings.tradingViewOnly = tradingViewOnly;
      this.record('setting', 'local', tradingViewOnly ? 'Trade alerts: TradingView servers only (recommended)' : 'Trade alerts: accepted from any address with the secret');
    }
    return this.view();
  }

  // After the secret was rotated: old alarms no longer apply.
  secretRotated() {
    this.alarm = null;
    this.fails.clear();
    this.record('rotate', 'local', 'Webhook secret rotated: the old one stops working immediately');
  }

  unban(ip) {
    this.bans.delete(ip);
    this.fails.delete(ip);
  }

  view() {
    const now = this.now();
    const bans = [...this.bans].filter(([, t]) => t > now).map(([ip, until]) => ({ ip, until }));
    const hourAgo = now - 60 * MINUTE;
    const recentBad = this.events.filter((e) => e.time > hourAgo && ['bad-secret', 'ban', 'leak', 'rate'].includes(e.kind)).length;
    return {
      settings: { ...this.settings },
      tradingViewIps: [...this.tvIps],
      stats: { ...this.stats },
      bans,
      alarm: this.alarm,
      status: this.alarm ? 'alarm' : recentBad >= 20 ? 'under-attack' : recentBad ? 'watching' : 'quiet',
      recentBad,
      events: this.events.slice(-30).reverse(),
    };
  }
}

export function newSecret() {
  return crypto.randomBytes(16).toString('hex');
}
