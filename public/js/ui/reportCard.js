import { api } from '../net.js';
import { money, escapeHtml, signClass } from '../format.js';

// The daily report card on the Dashboard: one FTMO server day at a time. Each desk's
// trades on the account, what stayed on paper and why, and what happened to the account.
// Today's card updates through the day; past days are final.

const hhmm = (ms) => new Date(ms).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
const r2 = (x) => (x == null ? '—' : `${x >= 0 ? '+' : '−'}${Math.abs(x).toFixed(2)}R`);
const EVENT_ICONS = { guard: '🛑', arm: '🟢', disarm: '⏸', kill: '⛔', disconnect: '🔌', reconnect: '✅', reject: '⚠️' };

export class ReportCard {
  constructor(el) {
    this.el = el;
    this.day = null; // null = the newest
    this.days = [];
    this.timer = null;
    el.addEventListener('change', (e) => {
      if (e.target.id !== 'rep-day') return;
      this.day = e.target.value;
      this.refresh();
    });
  }

  start() {
    this.refresh();
    clearInterval(this.timer);
    this.timer = setInterval(() => this.refresh(), 60_000);
  }

  stop() {
    clearInterval(this.timer);
  }

  async refresh() {
    try {
      const list = await api('/api/reports');
      this.days = list.days || [];
      if (!this.days.length) {
        this.el.hidden = false;
        this.el.innerHTML = `<h2>Daily report card</h2><p class="sub">Starts with the first day the desks trade your FTMO account: every desk's trades, what stayed on paper and why, and what happened to the account. One card per FTMO trading day, kept in <code>data/reports/</code>.</p>`;
        return;
      }
      const day = this.day && this.days.some((d) => d.day === this.day) ? this.day : this.days[0].day;
      const res = await api(`/api/reports/${encodeURIComponent(day)}`);
      if (!res.ok) return;
      this.el.hidden = false;
      this.el.innerHTML = this.#html(res.report, res.summary, day);
    } catch {
      /* the floor restarting; the next refresh will do */
    }
  }

  #html(r, s, day) {
    const acc = r.account;
    const options = this.days.map((d) => `<option value="${escapeHtml(d.day)}" ${d.day === day ? 'selected' : ''}>${escapeHtml(d.day)}${d.final ? '' : ' (today)'} · ${money(d.dayPnl ?? 0, { sign: true })}</option>`).join('');
    const tile = (label, value, cls = '', foot = '') => `<div class="rep-tile"><span>${label}</span><b class="${cls}">${value}</b>${foot ? `<small>${foot}</small>` : ''}</div>`;
    const desks = Object.entries(r.desks || {}).map(([id, d]) => ({ id, ...d }));
    desks.sort((a, b) => (b.trades ? 1 : 0) - (a.trades ? 1 : 0) || b.pnl - a.pnl || b.skipped - a.skipped);
    const paper = r.paper || {};
    for (const [id, p] of Object.entries(paper)) if (!desks.some((d) => d.id === id)) desks.push({ id, name: p.name, desk: p.desk || '', trades: 0, wins: 0, losses: 0, pnl: 0, countR: 0, sumR: 0, skipped: 0 });
    const rows = desks.map((d) => {
      const pp = paper[d.id];
      return `<tr>
        <td><b>${escapeHtml(d.name)}</b><small>${escapeHtml(d.desk || '')}</small></td>
        <td class="r">${d.trades || '<span class="muted">0</span>'}</td>
        <td class="r">${d.trades ? `${d.wins} / ${d.losses}` : '<span class="muted">—</span>'}</td>
        <td class="r ${signClass(d.pnl)}"><b>${d.trades ? money(d.pnl, { sign: true }) : '<span class="muted">—</span>'}</b></td>
        <td class="r">${d.countR ? r2(d.sumR / d.countR) : '<span class="muted">—</span>'}</td>
        <td class="r">${d.skipped || '<span class="muted">0</span>'}</td>
        <td class="r muted">${pp ? `${pp.trades} (${pp.wins} won)` : '—'}</td>
      </tr>`;
    }).join('');
    const reasons = Object.entries(r.skipped || {}).sort((a, b) => b[1] - a[1]);
    const maxN = Math.max(1, ...reasons.map(([, n]) => n));
    const reasonHtml = reasons.length
      ? reasons.map(([k, n]) => `<div class="rep-reason"><span>${escapeHtml(k)}</span><i style="width:${Math.round((n / maxN) * 100)}%"></i><b>${n}</b></div>`).join('')
      : '<p class="muted">Nothing was held back.</p>';
    const samples = (r.skipSamples || []).slice(-6).reverse().map((x) => `<li><span class="muted">${hhmm(x.at)}</span> ${escapeHtml(desks.find((d) => d.id === x.agentId)?.name?.split(' ')[0] || x.agentId)} · ${escapeHtml(x.symbol)}: ${escapeHtml(x.reason)}</li>`).join('');
    const events = (r.events || []).slice().reverse().map((e) => `<li><span class="muted">${hhmm(e.at)}</span> ${EVENT_ICONS[e.kind] || '•'} ${escapeHtml(e.text)}</li>`).join('');
    const trades = (r.trades || []).filter((t) => t.closedAt).slice().reverse().slice(0, 12).map((t) => `<tr>
        <td class="muted">${hhmm(t.closedAt)}</td>
        <td>${escapeHtml(desks.find((d) => d.id === t.agentId)?.name?.split(' ')[0] || t.agentId)}</td>
        <td>${escapeHtml(t.side)} ${escapeHtml(t.symbol)}</td>
        <td class="r ${signClass(t.pnl)}">${money(t.pnl, { sign: true })}</td>
        <td class="r">${r2(t.r)}</td>
      </tr>`).join('');
    return `
      <div class="rep-head">
        <div><h2>Daily report card</h2>
        <p class="sub">${acc ? `FTMO ${escapeHtml(acc.type || '')} ${escapeHtml(String(acc.login))} · ` : ''}${r.final ? 'final' : 'today so far, updates through the day'} · FTMO server day ${escapeHtml(day)}</p></div>
        <label class="rep-pick">Day <select id="rep-day">${options}</select></label>
      </div>
      <div class="rep-tiles">
        ${tile('Day P&amp;L', money(s.dayPnl ?? 0, { sign: true }), signClass(s.dayPnl ?? 0), acc ? `${money(acc.startBalance)} → ${money(acc.equity)}` : '')}
        ${tile('Trades on FTMO', String(s.trades), '', s.trades ? `${s.wins} won · ${s.losses} lost` : 'none closed yet')}
        ${tile('Win rate', s.winRate == null ? '—' : `${Math.round(s.winRate * 100)}%`)}
        ${tile('Average R', r2(s.avgR), s.avgR == null ? '' : signClass(s.avgR))}
        ${tile('Held back on paper', String(s.skipped), '', s.topReasons[0] ? `mostly: ${escapeHtml(s.topReasons[0][0].toLowerCase())}` : '')}
        ${tile('Daily loss used', acc?.dailyUsedPct != null ? `${acc.dailyUsedPct}%` : '—', acc?.dailyUsedPct >= 60 ? 'neg' : '', acc?.maxUsedPct != null ? `max loss used ${acc.maxUsedPct}%` : '')}
      </div>
      <div class="rep-grid">
        <div>
          <h3>By desk</h3>
          <div class="table-wrap" style="max-height:none"><table class="table compact rep-desks">
            <thead><tr><th>Desk</th><th class="r">FTMO trades</th><th class="r">Won / lost</th><th class="r">P&amp;L</th><th class="r">Avg R</th><th class="r">Held back</th><th class="r">Paper trades</th></tr></thead>
            <tbody>${rows || '<tr><td colspan="7" class="muted">No desk activity yet.</td></tr>'}</tbody>
          </table></div>
          ${trades ? `<h3>Closed trades</h3><div class="table-wrap"><table class="table compact"><tbody>${trades}</tbody></table></div>` : ''}
        </div>
        <div>
          <h3>Why trades stayed on paper</h3>
          ${reasonHtml}
          ${samples ? `<ul class="rep-list">${samples}</ul>` : ''}
          <h3>Account events</h3>
          ${events ? `<ul class="rep-list">${events}</ul>` : '<p class="muted">Nothing unusual.</p>'}
        </div>
      </div>`;
  }
}
