// Formatting helpers shared by the HUD, dashboard and monitor screens.

export function money(v, { sign = false, compact = false } = {}) {
  if (v == null || !Number.isFinite(v)) return '—';
  const abs = Math.abs(v);
  let body;
  if (compact && abs >= 1e9) body = `$${(abs / 1e9).toFixed(2)}B`;
  else if (compact && abs >= 1e6) body = `$${(abs / 1e6).toFixed(2)}M`;
  else if (compact && abs >= 1e4) body = `$${(abs / 1e3).toFixed(1)}K`;
  else body = `$${Math.round(abs).toLocaleString('en-US')}`;
  if (v < 0 && Math.round(abs) !== 0) return `−${body}`;
  return sign && Math.round(abs) !== 0 ? `+${body}` : body;
}

export function price(v, decimals = 2) {
  if (v == null || !Number.isFinite(v)) return '—';
  return v.toLocaleString('en-US', { minimumFractionDigits: decimals, maximumFractionDigits: decimals });
}

export function qty(v) {
  const a = Math.abs(v);
  if (a >= 1000) return Math.round(a).toLocaleString('en-US');
  if (a >= 10) return a.toLocaleString('en-US', { maximumFractionDigits: 1 });
  return a.toLocaleString('en-US', { maximumFractionDigits: 3 });
}

export function pct(v, decimals = 2, { sign = true } = {}) {
  if (v == null || !Number.isFinite(v)) return '—';
  const s = (v * 100).toFixed(decimals);
  return `${sign && v > 0 ? '+' : v < 0 ? '−' : ''}${s.replace('-', '')}%`;
}

export function signClass(v) {
  if (!Number.isFinite(v) || Math.abs(v) < 0.5) return '';
  return v > 0 ? 'pos' : 'neg';
}

const nyFmt = new Intl.DateTimeFormat('en-US', { timeZone: 'America/New_York', hour: '2-digit', minute: '2-digit', second: '2-digit', hourCycle: 'h23' });
const nyFmtShort = new Intl.DateTimeFormat('en-US', { timeZone: 'America/New_York', hour: '2-digit', minute: '2-digit', hourCycle: 'h23' });

export function nyTime(ms, seconds = false) {
  if (!Number.isFinite(ms)) return '--:--';
  return (seconds ? nyFmt : nyFmtShort).format(new Date(ms));
}

export function zoneTime(ms, timeZone) {
  return new Intl.DateTimeFormat('en-US', { timeZone, hour: '2-digit', minute: '2-digit', hourCycle: 'h23' }).format(new Date(ms));
}

export function initials(name) {
  return name.split(' ').map((p) => p[0]).join('').slice(0, 2).toUpperCase();
}

// The back tier's Day Trading Desk (the crypto day traders keep their seats on the trading rows).
export const isDayDesk = (p) => !!p.dayTrader && !p.crypto;

// The key shown on a desk's badge: 1–0 for the ten trading desks, Q for the research lab,
// D for the day trading desk.
export function deskKey(p, i) {
  return p.lab ? 'Q' : isDayDesk(p) ? 'D' : (i + 1) % 10;
}

export function escapeHtml(s) {
  return String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
}

// Desk status → colour (desk tags, rail, agent panel).
export const STATUS_COLORS = {
  'IN TRADE': '#3d8ef0', ARMED: '#f2b01e', HALTED: '#e5484d', PAUSED: '#8b919c', COOLDOWN: '#ec835a',
  NEWS: '#a371f7', RESEARCHING: '#2dd4bf', 'NO EDGE': '#8b919c', 'LOADING DATA': '#8b919c', 'NO PRICES': '#8b919c',
};
