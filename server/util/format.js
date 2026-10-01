// Number formatting shared by briefings, logs and the risk desk.

export function round(value, decimals) {
  const f = 10 ** decimals;
  return Math.round(value * f) / f;
}

export function fmtPrice(value, decimals = 2) {
  if (value == null || !Number.isFinite(value)) return '—';
  return value.toLocaleString('en-US', { minimumFractionDigits: decimals, maximumFractionDigits: decimals });
}

export function fmtQty(value) {
  const abs = Math.abs(value);
  if (abs >= 1000) return Math.round(abs).toLocaleString('en-US');
  if (abs >= 10) return abs.toLocaleString('en-US', { maximumFractionDigits: 1 });
  return abs.toLocaleString('en-US', { maximumFractionDigits: 3 });
}

export function fmtUsd(value, { sign = false, cents = false } = {}) {
  if (value == null || !Number.isFinite(value)) return '—';
  const body = '$' + (cents
    ? Math.abs(value).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })
    : Math.abs(Math.round(value)).toLocaleString('en-US'));
  if (cents && Math.abs(value) < 0.005) return body;
  if (value < 0) return '-' + body;
  return sign ? '+' + body : body;
}

// Phrasing for the spoken briefing: "up $12,450" / "down $3,200" / "flat".
export function spokenPnl(value) {
  if (!Number.isFinite(value) || Math.abs(value) < 1) return 'flat';
  return (value > 0 ? 'up ' : 'down ') + fmtUsd(Math.abs(value));
}

export function pct(value, decimals = 1) {
  if (!Number.isFinite(value)) return '—';
  return (value * 100).toFixed(decimals) + '%';
}
