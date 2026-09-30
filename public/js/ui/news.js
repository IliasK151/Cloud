import { escapeHtml, nyTime } from '../format.js';

// Economic calendar rendering, shared by the dashboard, the agent panel and the top bar.

export function until(ms) {
  const m = Math.round(ms / 60_000);
  if (m <= 0) return 'now';
  if (m < 60) return `in ${m} min`;
  const h = Math.floor(m / 60);
  return m % 60 ? `in ${h}h ${m % 60}m` : `in ${h}h`;
}

export function sourceText(n) {
  if (!n) return 'Loading the economic calendar…';
  if (!n.settings?.enabled) return 'News protection is switched off in Settings: desks trade through releases.';
  if (n.mode === 'sim') return 'Simulated calendar: the simulator moves the markets on every release.';
  if (n.status === 'live') return `Forex Factory calendar, updated ${new Date(n.updatedAt).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}.`;
  if (n.status === 'cached') return `Saved copy of the Forex Factory calendar (${escapeHtml(n.error || 'offline')}).`;
  if (n.status === 'schedule') return 'The live calendar is unreachable, so desks stand aside around the usual US release times (08:30 and 10:00 ET).';
  return 'Loading the economic calendar…';
}

export function nextHigh(n, now) {
  return n?.events?.find((e) => e.time > now && e.high?.length) || null;
}

const impactDot = (e) => `<i class="imp imp-${e.impact}" title="${escapeHtml(e.impact)} impact"></i>`;

// Upcoming (and just-released) events that matter to the floor's markets.
export function newsRows(n, now, limit = 14) {
  if (!n?.events) return [];
  const rel = n.events.filter((e) => e.markets.length && e.time >= now - 3 * 3_600_000);
  const past = rel.filter((e) => e.time <= now).slice(-3);
  const next = rel.filter((e) => e.time > now).slice(0, limit - past.length);
  return [...past, ...next];
}

export function newsTable(n, now, limit = 14) {
  const rows = newsRows(n, now, limit);
  if (!rows.length) return '<p class="fine">No market-moving releases scheduled in the next day and a half.</p>';
  return `<div class="table-wrap"><table class="table compact news-table"><thead><tr><th>ET</th><th></th><th>Event</th><th class="r">Actual</th><th class="r">Forecast</th><th class="r">Previous</th><th>Markets</th><th></th></tr></thead><tbody>${
    rows.map((e) => {
      const past = e.time <= now;
      const markets = e.markets.length > 6 ? 'All USD markets' : e.markets.length > 4 ? `${e.markets.length} markets` : e.markets.join(' ');
      return `<tr class="${past ? 'past' : ''}">
        <td class="num">${nyTime(e.time)}</td><td>${impactDot(e)}</td>
        <td>${escapeHtml(e.label)}${e.source === 'schedule' ? ' <span class="muted">(usual time)</span>' : ''}</td>
        <td class="r num"><b>${escapeHtml(e.actual || (past ? '—' : ''))}</b></td>
        <td class="r num muted">${escapeHtml(e.forecast || '')}</td>
        <td class="r num muted">${escapeHtml(e.previous || '')}</td>
        <td class="mk" title="${escapeHtml(e.markets.join(', '))}">${escapeHtml(markets)}</td>
        <td class="when">${past ? 'out' : until(e.time - now)}</td></tr>`;
    }).join('')
  }</tbody></table></div>`;
}

export function blackoutChips(n) {
  const groups = new Map();
  for (const [sym, b] of Object.entries(n?.blackouts || {})) {
    const key = `${b.label}|${b.until}`;
    if (!groups.has(key)) groups.set(key, { ...b, symbols: [] });
    groups.get(key).symbols.push(sym);
  }
  if (!groups.size) return '';
  return `<div class="news-holds">${[...groups.values()].map((g) =>
    `<span class="hold imp-${g.impact}"><b>${escapeHtml(g.label)}</b>: ${g.symbols.join(', ')} standing aside until ${nyTime(g.until)} ET</span>`).join('')}</div>`;
}

// One line for a desk: what's coming for its market.
export function deskNewsLine(a, now) {
  const nw = a?.news;
  if (!nw) return null;
  if (nw.hold) {
    return nw.hold.phase === 'before'
      ? `📅 Standing aside: ${nw.hold.label} at ${nyTime(nw.hold.time)} ET (${nw.hold.impact} impact), back ${nyTime(nw.hold.until)}`
      : `📅 ${nw.hold.label} just released: letting the spike settle until ${nyTime(nw.hold.until)}`;
  }
  if (nw.next && nw.next.time - now < 6 * 3_600_000) return `📅 Next: ${nw.next.label} at ${nyTime(nw.next.time)} ET (${nw.next.impact}), ${until(nw.next.time - now)}`;
  return null;
}
