import crypto from 'node:crypto';
import os from 'node:os';

// The local firewall: who may use the floor's dashboard, API and live feed.
//
// The floor runs on your Mac and is not reachable from the internet (only the
// TradingView webhook is, through its own listener). The realistic attacks are from
// web pages open in your own browser, which can send requests to localhost:
//   - cross-site request forgery: a page POSTs to /api/... to place, close or arm trades;
//   - cross-site WebSocket hijacking: a page opens ws://localhost/ws and reads the account;
//   - DNS rebinding: a page's own domain is re-pointed at 127.0.0.1 so it looks same-origin;
//   - clickjacking: a page frames the floor and tricks you into clicking "Arm".
// Defences, all enforced here:
//   1. Host allowlist: only localhost / 127.0.0.1 / ::1 (plus this Mac's own names and
//      addresses when you open it on your Wi-Fi). Anything else is refused (DNS rebinding).
//   2. A random floor key, new on every launch, delivered only inside the dashboard page.
//      Every API call and the live feed must carry it. Other sites can't read the page
//      (same-origin policy), so they can't get the key.
//   3. Origin / Sec-Fetch-Site checks: requests started by another site are refused.
//   4. Strict security headers: CSP (no inline or third-party scripts), no framing, no
//      referrer, no MIME sniffing, cross-origin isolation.
//   5. Opened from another device on your Wi-Fi: a password login (FLOOR_PASSWORD),
//      with lockout after repeated wrong passwords. Without a password the floor refuses
//      to listen on the network at all.

const LOOPBACK_NAMES = new Set(['localhost', '127.0.0.1', '::1']);
const SESSION_COOKIE = 'floor_sid';
const SESSION_TTL_MS = 12 * 3_600_000;
const LOGIN_MAX_FAILS = 5;
const LOGIN_LOCK_MS = 15 * 60_000;

export function isLoopbackAddress(addr = '') {
  const a = String(addr).replace(/^::ffff:/, '');
  return a === '::1' || a.startsWith('127.');
}

export function isLoopbackBind(host) {
  return LOOPBACK_NAMES.has(String(host).toLowerCase()) || String(host).startsWith('127.');
}

// "name:port" or "[v6]:port" → { name, port }
export function parseHost(value) {
  const h = String(value || '').trim().toLowerCase();
  if (!h) return null;
  const m = h.match(/^\[([^\]]+)\](?::(\d+))?$/) || h.match(/^([^:]+)(?::(\d+))?$/);
  return m ? { name: m[1], port: m[2] ? Number(m[2]) : 80 } : null;
}

const safeEqual = (a, b) => {
  const x = Buffer.from(String(a ?? ''));
  const y = Buffer.from(String(b ?? ''));
  return x.length === y.length && x.length > 0 && crypto.timingSafeEqual(x, y);
};

function lanNames() {
  const names = new Set();
  const host = os.hostname().toLowerCase();
  names.add(host);
  names.add(host.endsWith('.local') ? host : `${host}.local`);
  for (const list of Object.values(os.networkInterfaces())) {
    for (const i of list || []) names.add(String(i.address).toLowerCase().replace(/%.*$/, ''));
  }
  return names;
}

export class LocalGuard {
  constructor({ port, lan = false, extraHosts = [], password = null, widgetPort = null, key = null, now = () => Date.now(), isLocal = isLoopbackAddress }) {
    this.port = port;
    this.isLocal = isLocal;
    this.widgetPort = widgetPort;
    this.key = key || crypto.randomBytes(32).toString('base64url');
    this.now = now;
    this.lan = lan;
    this.names = new Set([...LOOPBACK_NAMES, ...extraHosts.map((h) => String(h).toLowerCase())]);
    if (lan) for (const n of lanNames()) this.names.add(n);
    // Only a hash of the password is kept in memory.
    this.salt = crypto.randomBytes(16);
    this.pwHash = password ? crypto.scryptSync(String(password), this.salt, 32) : null;
    this.sessions = new Map(); // sid → expiry
    this.logins = new Map(); // ip → { fails, lockedUntil }
    this.blocked = { host: 0, origin: 0, key: 0, login: 0 };
  }

  // ---- checks ---------------------------------------------------------------------------------
  hostOk(req) {
    const h = parseHost(req.headers.host);
    return !!h && this.names.has(h.name) && h.port === this.port;
  }

  // Started by this page (or by a non-browser client on this Mac), not by another site.
  originOk(req, { requireOrigin = false } = {}) {
    const origin = req.headers.origin;
    if (origin) {
      if (origin === 'null') return false;
      let u;
      try {
        u = new URL(origin);
      } catch {
        return false;
      }
      if (u.protocol !== 'http:' && u.protocol !== 'https:') return false;
      if (u.host.toLowerCase() !== String(req.headers.host || '').toLowerCase()) return false;
    } else if (requireOrigin) {
      return false;
    }
    const site = req.headers['sec-fetch-site'];
    return !site || site === 'same-origin' || site === 'none';
  }

  keyOk(given) {
    return safeEqual(given, this.key);
  }

  // Devices on your Wi-Fi must log in; this Mac itself never has to.
  needsLogin(req) {
    return !!this.pwHash && !this.isLocal(req.socket?.remoteAddress);
  }

  sessionOk(req) {
    const sid = cookie(req.headers.cookie, SESSION_COOKIE);
    const exp = sid ? this.sessions.get(sid) : null;
    if (!exp) return false;
    if (exp < this.now()) {
      this.sessions.delete(sid);
      return false;
    }
    return true;
  }

  // ---- HTTP -----------------------------------------------------------------------------------
  // exempt: paths with their own authentication (MT5 bridge token, webhook secret).
  middleware({ exempt = [] } = {}) {
    return (req, res, next) => {
      this.headers(res, req);
      if (!this.hostOk(req)) {
        this.blocked.host++;
        return res.status(403).type('text').send('Blocked: this address is not allowed to open the floor.');
      }
      const path = req.path;
      if (path === '/login') return this.#login(req, res);
      if (this.needsLogin(req) && !this.sessionOk(req) && !exempt.includes(path)) {
        if (path.startsWith('/api/')) return res.status(401).json({ ok: false, error: 'login required' });
        return res.redirect(303, '/login');
      }
      if (path.startsWith('/api/')) {
        res.setHeader('Cache-Control', 'no-store');
        if (exempt.includes(path)) return next();
        if (!this.originOk(req)) {
          this.blocked.origin++;
          return res.status(403).json({ ok: false, error: 'cross-site request blocked' });
        }
        if (!this.keyOk(req.headers['x-floor-key'])) {
          this.blocked.key++;
          return res.status(401).json({ ok: false, error: 'floor key missing or out of date: reload the page' });
        }
      } else if (req.method !== 'GET' && req.method !== 'HEAD') {
        return res.status(405).type('text').send('Method not allowed');
      }
      next();
    };
  }

  // The live feed (WebSocket): same rules, and the browser always sends an Origin.
  upgradeOk(req) {
    let url;
    try {
      url = new URL(req.url, 'http://x');
    } catch {
      return 'bad url';
    }
    if (url.pathname !== '/ws') return 'not found';
    if (!this.hostOk(req)) return (this.blocked.host++, 'host');
    if (!this.originOk(req, { requireOrigin: true })) return (this.blocked.origin++, 'origin');
    if (this.needsLogin(req) && !this.sessionOk(req)) return (this.blocked.login++, 'login');
    if (!this.keyOk(url.searchParams.get('key'))) return (this.blocked.key++, 'key');
    return null;
  }

  // ---- headers & page ---------------------------------------------------------------------------
  headers(res, req, nonce = null) {
    const host = String(req.headers.host || `localhost:${this.port}`);
    const h = parseHost(host);
    const hostName = h?.name.includes(':') ? `[${h.name}]` : h?.name;
    const frame = this.widgetPort && hostName ? ` http://${hostName}:${this.widgetPort}` : '';
    res.setHeader('Content-Security-Policy', [
      "default-src 'self'",
      `script-src 'self'${nonce ? ` 'nonce-${nonce}'` : ''}`,
      "style-src 'self' 'unsafe-inline'",
      "img-src 'self' data: blob:",
      "font-src 'self' data:",
      `connect-src 'self' ws://${host} wss://${host}`,
      "media-src 'self' blob: data:",
      "worker-src 'self' blob:",
      `frame-src${frame || " 'none'"}`,
      "frame-ancestors 'none'",
      "base-uri 'none'",
      "form-action 'self'",
      "object-src 'none'",
    ].join('; '));
    res.setHeader('X-Frame-Options', 'DENY');
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('Referrer-Policy', 'no-referrer');
    res.setHeader('Cross-Origin-Opener-Policy', 'same-origin');
    res.setHeader('Cross-Origin-Resource-Policy', 'same-origin');
    res.setHeader('Permissions-Policy', 'camera=(), microphone=(), geolocation=(), payment=(), usb=(), serial=(), bluetooth=()');
  }

  // The dashboard page: the floor key and a script nonce are added on the way out.
  sendIndex(req, res, html) {
    const nonce = crypto.randomBytes(16).toString('base64');
    this.headers(res, req, nonce);
    res.setHeader('Cache-Control', 'no-store');
    const page = html
      .replace('<head>', `<head>\n  <meta name="floor-key" content="${this.key}">${this.widgetPort ? `\n  <meta name="floor-widget-port" content="${this.widgetPort}">` : ''}`)
      .replace(/<script(?=[\s>])/g, `<script nonce="${nonce}"`);
    res.type('html').send(page);
  }

  // ---- Wi-Fi login ------------------------------------------------------------------------------
  #login(req, res) {
    if (!this.pwHash || !this.needsLogin(req)) return res.redirect(303, '/');
    const ip = req.socket.remoteAddress;
    const rec = this.logins.get(ip) || { fails: 0, lockedUntil: 0 };
    const locked = rec.lockedUntil > this.now();
    if (req.method === 'POST') {
      if (locked || !this.originOk(req)) {
        this.blocked.login++;
        return res.status(429).type('html').send(loginPage('Too many wrong passwords. Try again in 15 minutes.'));
      }
      let body = '';
      req.setEncoding('utf8');
      req.on('data', (c) => { body += c; if (body.length > 2048) req.destroy(); });
      req.on('end', () => {
        const given = new URLSearchParams(body).get('password') || '';
        const ok = safeEqual(crypto.scryptSync(given, this.salt, 32).toString('hex'), this.pwHash.toString('hex'));
        if (!ok) {
          rec.fails++;
          if (rec.fails >= LOGIN_MAX_FAILS) {
            rec.lockedUntil = this.now() + LOGIN_LOCK_MS;
            rec.fails = 0;
          }
          this.logins.set(ip, rec);
          this.blocked.login++;
          return res.status(401).type('html').send(loginPage('Wrong password.'));
        }
        this.logins.delete(ip);
        const sid = crypto.randomBytes(32).toString('base64url');
        this.sessions.set(sid, this.now() + SESSION_TTL_MS);
        res.setHeader('Set-Cookie', `${SESSION_COOKIE}=${sid}; HttpOnly; SameSite=Strict; Path=/; Max-Age=${SESSION_TTL_MS / 1000}`);
        res.redirect(303, '/');
      });
      return undefined;
    }
    return res.type('html').send(loginPage(locked ? 'Too many wrong passwords. Try again in 15 minutes.' : ''));
  }

  view() {
    return { lan: this.lan, passwordSet: !!this.pwHash, blocked: { ...this.blocked }, sessions: this.sessions.size };
  }
}

function cookie(header, name) {
  for (const part of String(header || '').split(';')) {
    const i = part.indexOf('=');
    if (i > 0 && part.slice(0, i).trim() === name) return part.slice(i + 1).trim();
  }
  return null;
}

function loginPage(message) {
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>Trading floor · sign in</title>
<style>body{margin:0;min-height:100vh;display:grid;place-items:center;background:#0b0c0e;color:#f2f2f0;font:14px -apple-system,BlinkMacSystemFont,system-ui,sans-serif}
form{width:min(340px,90vw);padding:28px;border:1px solid rgba(255,255,255,.1);border-radius:14px;background:#141518}
h1{font-size:18px;margin:0 0 6px}p{color:#b3b5ba;margin:0 0 18px;line-height:1.45}input{width:100%;box-sizing:border-box;padding:11px 12px;border-radius:9px;border:1px solid rgba(255,255,255,.15);background:#1a1b1f;color:#fff;font-size:15px}
button{margin-top:14px;width:100%;padding:11px;border:0;border-radius:9px;background:#4c8dff;color:#fff;font-weight:700;font-size:14px;cursor:pointer}.err{color:#f0707a;margin:12px 0 0}</style></head>
<body><form method="post" action="/login"><h1>Trading floor</h1><p>This floor is protected. Enter the password set in <code>FLOOR_PASSWORD</code> on the Mac.</p>
<input type="password" name="password" autocomplete="current-password" autofocus required aria-label="Password"><button type="submit">Sign in</button>${message ? `<p class="err">${message}</p>` : ''}</form></body></html>`;
}
