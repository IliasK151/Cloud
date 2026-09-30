import crypto from 'node:crypto';
import { resolveSymbol } from '../market/symbols.js';

// TradingView alert → normalised order instruction.
//
// Accepted message (JSON, put this in the alert's "Message" box):
//   {"secret":"…","agent":"amara","symbol":"{{ticker}}","action":"buy","price":{{close}},"stop":2310.5,"target":2340}
//
// action: buy | long | sell | short | close | exit | flat  (ping = connection check, no trade)
// Strategy alerts also work: "action":"{{strategy.order.action}}","position":"{{strategy.market_position}}"
// Plain-text fallback: "BUY XAUUSD agent=amara secret=…"

const ACTIONS = {
  buy: 'buy', long: 'buy', 'entry long': 'buy', enter_long: 'buy',
  sell: 'sell', short: 'sell', 'entry short': 'sell', enter_short: 'sell',
  close: 'close', exit: 'close', flat: 'close', flatten: 'close', 'close all': 'close',
  ping: 'ping', // connection check: answered, never traded
};

// Keys are copied into prototype-free objects, so a crafted "__proto__" key is plain data.
const FORBIDDEN_KEYS = new Set(['__proto__', 'constructor', 'prototype']);

function lowerKeys(raw) {
  const out = Object.create(null);
  for (const [k, v] of Object.entries(raw)) {
    const key = String(k).toLowerCase();
    if (!FORBIDDEN_KEYS.has(key)) out[key] = v;
  }
  return out;
}

const str = (v, max) => String(v ?? '').replace(/[\u0000-\u001f\u007f]/g, ' ').trim().slice(0, max);

function parseText(text) {
  const out = Object.create(null);
  const tokens = text.trim().split(/\s+/);
  for (const tok of tokens) {
    const eq = tok.indexOf('=');
    if (eq > 0) {
      const key = tok.slice(0, eq).toLowerCase();
      if (!FORBIDDEN_KEYS.has(key)) out[key] = tok.slice(eq + 1);
    }
    else if (!out.action && Object.hasOwn(ACTIONS, tok.toLowerCase())) out.action = tok;
    else if (!out.symbol) out.symbol = tok;
  }
  return out;
}

export function parseBody(body) {
  if (body && typeof body === 'object' && !Buffer.isBuffer(body)) return body;
  const text = Buffer.isBuffer(body) ? body.toString('utf8') : String(body ?? '');
  if (!text.trim()) return null;
  try {
    const obj = JSON.parse(text);
    if (obj && typeof obj === 'object' && !Array.isArray(obj)) return obj;
    if (obj && typeof obj === 'object') return null;
  } catch {
    /* fall through to text */
  }
  return parseText(text);
}

// Prices must be real positive numbers; anything else is ignored.
const num = (v) => {
  if (typeof v !== 'number' && typeof v !== 'string') return undefined;
  const n = typeof v === 'string' ? Number(v.replace(/,/g, '').slice(0, 32)) : v;
  return Number.isFinite(n) && n > 0 && n < 1e9 ? n : undefined;
};

// The secret an alert carries (looked at before anything else in it).
export function alertSecret(raw) {
  if (!raw || typeof raw !== 'object') return '';
  const lower = lowerKeys(raw);
  const s = lower.secret ?? lower.passphrase ?? lower.key ?? '';
  return typeof s === 'string' || typeof s === 'number' ? String(s).slice(0, 200) : '';
}

export function normalizeAlert(raw) {
  if (!raw) return { ok: false, error: 'Empty alert body' };
  const lower = lowerKeys(raw);
  const actKey = String(lower.action ?? lower.side ?? lower.signal ?? '').toLowerCase().trim();
  // Own keys only: "constructor" or "toString" are not actions.
  let action = Object.hasOwn(ACTIONS, actKey) ? ACTIONS[actKey] : undefined;
  const position = String(lower.position ?? lower.market_position ?? '').toLowerCase();
  if (position === 'flat') action = 'close';
  if (!action) return { ok: false, error: `Unknown action "${str(lower.action, 24)}"` };
  const rawSymbol = str(lower.symbol ?? lower.ticker ?? lower.instrument ?? '', 40);
  return {
    ok: true,
    alert: {
      secret: alertSecret(raw),
      agent: lower.agent ? str(lower.agent, 32).toLowerCase() : null,
      rawSymbol,
      symbol: resolveSymbol(rawSymbol),
      action,
      price: num(lower.price),
      stop: num(lower.stop ?? lower.sl ?? lower.stop_loss),
      target: num(lower.target ?? lower.tp ?? lower.take_profit),
      comment: lower.comment ? str(lower.comment, 120) : '',
    },
  };
}

export function secretMatches(given, expected) {
  const a = Buffer.from(String(given ?? ''));
  const b = Buffer.from(String(expected ?? ''));
  if (a.length !== b.length || !b.length) return false;
  return crypto.timingSafeEqual(a, b);
}

// Tiny fixed-window rate limiter so a runaway alert can't spam the desks.
export function rateLimiter(limit = 30, windowMs = 60_000) {
  let windowStart = Date.now();
  let count = 0;
  return () => {
    const now = Date.now();
    if (now - windowStart > windowMs) {
      windowStart = now;
      count = 0;
    }
    count++;
    return count <= limit;
  };
}
