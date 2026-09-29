import crypto from 'node:crypto';
import { resolveSymbol } from '../market/symbols.js';

// TradingView alert → normalised order instruction.
//
// Accepted message (JSON, put this in the alert's "Message" box):
//   {"secret":"…","agent":"amara","symbol":"{{ticker}}","action":"buy","price":{{close}},"stop":2310.5,"target":2340}
//
// action: buy | long | sell | short | close | exit | flat
// Strategy alerts also work: "action":"{{strategy.order.action}}","position":"{{strategy.market_position}}"
// Plain-text fallback: "BUY XAUUSD agent=amara secret=…"

const ACTIONS = {
  buy: 'buy', long: 'buy', 'entry long': 'buy', enter_long: 'buy',
  sell: 'sell', short: 'sell', 'entry short': 'sell', enter_short: 'sell',
  close: 'close', exit: 'close', flat: 'close', flatten: 'close', 'close all': 'close',
};

function parseText(text) {
  const out = {};
  const tokens = text.trim().split(/\s+/);
  for (const tok of tokens) {
    const eq = tok.indexOf('=');
    if (eq > 0) out[tok.slice(0, eq).toLowerCase()] = tok.slice(eq + 1);
    else if (!out.action && ACTIONS[tok.toLowerCase()]) out.action = tok;
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
    if (obj && typeof obj === 'object') return obj;
  } catch {
    /* fall through to text */
  }
  return parseText(text);
}

const num = (v) => {
  const n = typeof v === 'string' ? Number(v.replace(/,/g, '')) : Number(v);
  return Number.isFinite(n) ? n : undefined;
};

export function normalizeAlert(raw) {
  if (!raw) return { ok: false, error: 'Empty alert body' };
  const lower = {};
  for (const [k, v] of Object.entries(raw)) lower[k.toLowerCase()] = v;
  let action = ACTIONS[String(lower.action ?? lower.side ?? lower.signal ?? '').toLowerCase().trim()];
  const position = String(lower.position ?? lower.market_position ?? '').toLowerCase();
  if (position === 'flat') action = 'close';
  if (!action) return { ok: false, error: `Unknown action "${lower.action ?? ''}"` };
  const rawSymbol = lower.symbol ?? lower.ticker ?? lower.instrument ?? '';
  return {
    ok: true,
    alert: {
      secret: lower.secret ?? lower.passphrase ?? lower.key ?? '',
      agent: lower.agent ? String(lower.agent).toLowerCase().trim() : null,
      rawSymbol: String(rawSymbol),
      symbol: resolveSymbol(rawSymbol),
      action,
      price: num(lower.price),
      stop: num(lower.stop ?? lower.sl ?? lower.stop_loss),
      target: num(lower.target ?? lower.tp ?? lower.take_profit),
      comment: lower.comment ? String(lower.comment).slice(0, 120) : '',
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
