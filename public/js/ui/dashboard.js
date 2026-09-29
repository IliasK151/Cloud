import { command } from '../net.js';
import { equityChart } from './charts.js';
import { money, price as fmtPrice, qty as fmtQty, pct, signClass, nyTime, escapeHtml } from '../format.js';

// Full-screen fund dashboard: KPIs, fund equity, desk P&L, desk table, risk, blotter.
export class Dashboard {
  constructor(store, root, { onSelect }) {
    this.store = store;
    this.root = root;
    this.onSelect = onSelect;
    this.visible = false;
    this.built = false;
    this.lastRender = 0;
    this.chart = null;
  }

  #build() {
    this.root.innerHTML = `
      <div id="dash-banner"></div>
      <h1>Paper fund dashboard</h1>
      <p class="lede" id="dash-lede"></p>
      <div class="grid tiles" id="dash-tiles"></div>
      <div class="grid dash-row" style="margin-top:14px">
        <div class="card">
          <h2>Fund equity (NAV)</h2>
          <p class="sub">Sampled every market minute · dashed line = starting capital · hover for values</p>
          <div class="equity-box" id="dash-equity"></div>
        </div>
        <div class="card">
          <h2>Desk P&amp;L — today</h2>
          <p class="sub">Realized + unrealized, per desk</p>
          <div class="bars" id="dash-bars"></div>
        </div>
      </div>
      <div class="card" style="margin-top:14px">
        <h2>Desks</h2>
        <p class="sub">Click a row to talk to the trader · sparkline = today's P&amp;L path</p>
        <div class="table-wrap" style="max-height:none"><table class="table" id="dash-table"></table></div>
      </div>
      <div class="grid dash-row-3" style="margin-top:14px">
        <div class="card">
          <h2>Risk — daily loss limit used</h2>
          <p class="sub" id="dash-risk-sub"></p>
          <div id="dash-risk"></div>
        </div>
        <div class="card">
          <h2>Markets</h2>
          <p class="sub">Change on the trading day · feed status per instrument</p>
          <div class="market-grid" id="dash-markets"></div>
        </div>
      </div>
      <div class="grid dash-row-3" style="margin-top:14px">
        <div class="card">
          <h2>Trade blotter</h2>
          <p class="sub">Most recent closed round trips across the floor</p>
          <div class="table-wrap"><table class="table compact" id="dash-blotter"></table></div>
        </div>
        <div class="card">
          <h2>Floor controls</h2>
          <p class="sub">Paper desks — for your FTMO account use Close all &amp; disarm in the FTMO tab</p>
          <div class="test-row">
            <button class="btn" data-cmd="pause-all">Pause all desks</button>
            <button class="btn" data-cmd="resume-all">Resume all desks</button>
            <button class="btn danger" data-cmd="flatten">Flatten the floor</button>
            <button class="btn" data-cmd="reset-paper">Reset paper P&amp;L</button>
          </div>
          <h2 style="margin-top:18px">TradingView alerts</h2>
          <p class="sub">Latest webhook alerts received</p>
          <div class="table-wrap"><table class="table compact" id="dash-alerts"></table></div>
        </div>
      </div>`;
    this.root.querySelectorAll('[data-cmd]').forEach((b) => b.addEventListener('click', () => {
      if (b.dataset.cmd === 'flatten' && !confirm('Flatten every desk now?')) return;
      if (b.dataset.cmd === 'reset-paper' && !confirm('Reset the paper P&L, trade history and stats to zero? Open trades keep running. Your FTMO account is not affected.')) return;
      command(b.dataset.cmd);
    }));
    this.root.querySelector('#dash-table').addEventListener('click', (e) => {
      const btn = e.target.closest('[data-act]');
      if (btn) {
        e.stopPropagation();
        command(btn.dataset.act, btn.dataset.id);
        return;
      }
      const row = e.target.closest('tr[data-id]');
      if (row) this.onSelect(row.dataset.id);
    });
    this.built = true;
  }

  show() {
    if (!this.built) this.#build();
    this.visible = true;
    this.root.hidden = false;
    if (!this.chart) {
      this.chart = equityChart(this.root.querySelector('#dash-equity'));
    }
    this.chart.setData(this.store.equity, this.store.config.startingCapital);
    this.render(true);
  }

  hide() {
    this.visible = false;
    this.root.hidden = true;
  }

  onEquity(sample) {
    if (this.visible && this.chart) this.chart.update({ time: sample.time, value: sample.nav });
  }

  render(force = false) {
    if (!this.visible || !this.store.fund) return;
    const now = performance.now();
    if (!force && now - this.lastRender < 1000) return;
    this.lastRender = now;
    const s = this.store;
    const f = s.fund;
    const r = s.config.risk;

    const ftmoNote = s.live?.profile && s.live?.account
      ? `<div class="banner info">ℹ︎ This dashboard is the <b>paper fund</b> (practice money that every desk trades). Your real FTMO account ${escapeHtml(String(s.live.account.login))} and its P&amp;L are in the FTMO tab, and on the floor when the top-bar switch is on FTMO.</div>`
      : '';
    this.root.querySelector('#dash-banner').innerHTML = ftmoNote + (f.riskOff
      ? `<div class="banner crit">⛔ <b>Fund risk-off.</b> ${escapeHtml(f.riskOff.reason)}. All desks are halted until the next trading day.</div>`
      : f.mode === 'sim'
        ? `<div class="banner info">ℹ︎ Simulation mode — markets are simulated at ${f.speed}× speed. Run <code>npm run live</code> for real market data.</div>`
        : '');
    this.root.querySelector('#dash-lede').textContent = `${f.name} · trading day ${f.dayKey} · ${f.session} session · ${nyTime(f.marketTime, true)} ET · ${s.profiles.length} desks × ${money(s.config.allocation, { compact: true })} allocation`;

    const usedFund = f.dayPnl < 0 ? -f.dayPnl / f.fundLossLimit : 0;
    const tiles = [
      ['Net asset value', money(f.nav), `Start ${money(f.startingCapital, { compact: true })}`, ''],
      ['Day P&L', money(f.dayPnl, { sign: true }), `${pct(f.dayPnl / (f.nav - f.dayPnl))} · realized ${money(f.realizedDay, { sign: true, compact: true })}`, signClass(f.dayPnl)],
      ['Since inception', money(f.totalPnl, { sign: true }), pct(f.totalPnl / f.startingCapital), signClass(f.totalPnl)],
      ['Unrealized', money(f.unrealized, { sign: true }), `${f.openPositions} open position${f.openPositions === 1 ? '' : 's'}`, signClass(f.unrealized)],
      ['Gross exposure', money(f.grossExposure, { compact: true }), `${(f.grossExposure / f.nav).toFixed(2)}× NAV`, ''],
      ['Trades today', String(f.tradesDay), f.winRateDay == null ? 'No closed trades yet' : `Win rate ${Math.round(f.winRateDay * 100)}%`, ''],
      ['Fund loss limit', `${Math.round(usedFund * 100)}% used`, `Stop at ${money(-f.fundLossLimit, { compact: true })} (${(r.fundDailyLossPct * 100).toFixed(1)}% NAV)`, usedFund > 0.75 ? 'neg' : ''],
    ];
    this.root.querySelector('#dash-tiles').innerHTML = tiles.map(([l, v, foot, cls]) => `
      <div class="card tile"><div class="t-label">${l}</div><div class="t-value ${cls}">${v}</div><div class="t-foot">${foot}</div></div>`).join('');

    // Desk P&L bars (diverging around zero, value labels on every row).
    const rows = s.profiles.map((p) => ({ p, a: s.agents[p.id] })).filter((x) => x.a);
    const maxAbs = Math.max(1, ...rows.map((x) => Math.abs(x.a.pnl.day)));
    this.root.querySelector('#dash-bars').innerHTML = rows.map(({ p, a }) => {
      const v = a.pnl.day;
      const w = (Math.abs(v) / maxAbs) * 50;
      return `<div class="bar-row" title="${escapeHtml(p.name)} — ${escapeHtml(p.strategy)}: ${money(v, { sign: true })} today">
        <span class="nm">${escapeHtml(p.desk)}</span>
        <div class="bar-track"><span class="zero"></span><span class="fill ${v >= 0 ? 'p' : 'n'}" style="width:${w}%"></span></div>
        <span class="v ${signClass(v)}">${money(v, { sign: true, compact: Math.abs(v) >= 1e5 })}</span></div>`;
    }).join('');

    // Desk table
    const dec = (sym) => s.symbols[sym]?.decimals ?? 2;
    this.root.querySelector('#dash-table').innerHTML = `
      <thead><tr><th>#</th><th>Desk · strategy</th><th>Trader</th><th>Market</th><th>Status</th><th>Position</th><th class="r">Unrealized</th><th class="r">Day P&amp;L</th><th>Today</th><th class="r">Since inception</th><th class="r">Win %</th><th class="r">Trades</th><th></th></tr></thead>
      <tbody>${rows.map(({ p, a }, i) => {
        const pos = a.positions.map((x) => `${x.side === 'LONG' ? 'L' : 'S'} ${fmtQty(x.qty)} ${x.symbol} @ ${fmtPrice(x.avg, dec(x.symbol))}`).join('<br>') || '<span class="muted">Flat</span>';
        const st = a.stats;
        return `<tr class="clickable" data-id="${p.id}">
          <td class="muted">${(i + 1) % 10}</td>
          <td><span class="desk-cell"><i style="background:${p.accent}"></i><span>${escapeHtml(p.desk)}<small>${escapeHtml(p.strategy)}</small></span></span></td>
          <td>${escapeHtml(p.name)}</td>
          <td>${escapeHtml(p.symbols.join(' / '))}</td>
          <td>${escapeHtml(a.status)}</td>
          <td>${pos}</td>
          <td class="r ${signClass(a.pnl.unrealized)}">${money(a.pnl.unrealized, { sign: true })}</td>
          <td class="r ${signClass(a.pnl.day)}"><b>${money(a.pnl.day, { sign: true })}</b></td>
          <td>${sparkline(s.dayCurves[p.id] || [])}</td>
          <td class="r ${signClass(a.pnl.total)}">${money(a.pnl.total, { sign: true })}</td>
          <td class="r">${st.winRate == null ? '—' : Math.round(st.winRate * 100) + '%'}</td>
          <td class="r">${st.tradesDay} / ${st.trades}</td>
          <td><button class="mini-btn" data-act="flatten" data-id="${p.id}">Flatten</button> <button class="mini-btn" data-act="${a.paused ? 'resume' : 'pause'}" data-id="${p.id}">${a.paused ? 'Resume' : 'Pause'}</button></td>
        </tr>`;
      }).join('')}</tbody>`;

    // Risk utilisation: sequential single-hue bars; warning/critical carry an icon + label.
    this.root.querySelector('#dash-risk-sub').textContent = `Each desk is halted for the day at −${(r.deskDailyLossPct * 100).toFixed(1)}% of its allocation (${money(s.config.allocation * r.deskDailyLossPct, { compact: true })}). Risk per trade ${(r.riskPerTradePct * 100).toFixed(2)}%.`;
    this.root.querySelector('#dash-risk').innerHTML = rows.map(({ p, a }) => {
      const used = a.pnl.day < 0 ? Math.min(1, -a.pnl.day / a.lossLimit) : 0;
      const cls = a.halted ? 'crit' : used > 0.75 ? 'crit' : used > 0.5 ? 'warn' : '';
      const flag = a.halted ? '<span class="flag">⛔ halted</span>' : used > 0.75 ? '<span class="flag">▲ critical</span>' : used > 0.5 ? '<span class="flag">▲ warning</span>' : '';
      return `<div class="risk-row ${cls}"><span>${escapeHtml(p.desk)}</span><div class="track"><i style="width:${(used * 100).toFixed(1)}%"></i></div><span class="v">${Math.round(used * 100)}%${flag}</span></div>`;
    }).join('');

    this.root.querySelector('#dash-markets').innerHTML = Object.values(s.symbols).map((sym) => {
      const q = s.quotes[sym.id];
      return `<div class="mkt"><div class="s"><span>${sym.id}</span><span class="${q?.change > 0 ? 'pos' : q?.change < 0 ? 'neg' : ''}">${pct(q?.change)}</span></div>
        <div class="p">${fmtPrice(q?.price, sym.decimals)}</div>
        <div class="src src-${(q?.status || '').toLowerCase()}">${escapeHtml(q?.status ?? '')} · ${escapeHtml(sym.tv)}</div></div>`;
    }).join('');

    this.root.querySelector('#dash-blotter').innerHTML = `<thead><tr><th>Closed</th><th>Desk</th><th>Side</th><th>Mkt</th><th class="r">Qty</th><th class="r">Entry</th><th class="r">Exit</th><th class="r">P&amp;L</th><th>Exit reason</th></tr></thead><tbody>${
      s.blotter.slice(0, 30).map((t) => `<tr><td>${nyTime(t.closeTime)}</td><td>${escapeHtml(s.profileById[t.agentId]?.desk ?? t.agentId)}</td><td>${t.side}</td><td>${t.symbol}</td><td class="r">${fmtQty(t.qty)}</td><td class="r">${fmtPrice(t.entry, dec(t.symbol))}</td><td class="r">${fmtPrice(t.exit, dec(t.symbol))}</td><td class="r ${signClass(t.pnl)}">${money(t.pnl, { sign: true })}</td><td class="muted">${escapeHtml(t.exitReason || '')}</td></tr>`).join('') ||
      '<tr><td colspan="9" class="muted">No closed trades yet — the desks are working their setups.</td></tr>'
    }</tbody>`;

    this.root.querySelector('#dash-alerts').innerHTML = `<thead><tr><th>Time</th><th>Desk</th><th>Action</th><th>Result</th></tr></thead><tbody>${
      s.alerts.slice().reverse().slice(0, 12).map((al) => `<tr><td>${new Date(al.time).toLocaleTimeString()}</td><td>${escapeHtml(s.profileById[al.agentId]?.name ?? '—')}</td><td>${escapeHtml(al.action.toUpperCase())} ${escapeHtml(al.symbol || '')}</td><td><span class="pill ${al.ok ? 'ok' : 'no'}">${al.ok ? 'OK' : 'REJECTED'}</span> ${escapeHtml(al.result || '')}</td></tr>`).join('') ||
      '<tr><td colspan="4" class="muted">No alerts yet. See the TradingView tab to connect your alerts.</td></tr>'
    }</tbody>`;
  }
}

function sparkline(points, w = 110, h = 26) {
  if (points.length < 2) return '<span class="muted">—</span>';
  const vals = points.map((p) => p.value);
  const lo = Math.min(0, ...vals);
  const hi = Math.max(0, ...vals);
  const span = hi - lo || 1;
  const x = (i) => (i / (vals.length - 1)) * (w - 2) + 1;
  const y = (v) => h - 2 - ((v - lo) / span) * (h - 4);
  const d = vals.map((v, i) => `${i ? 'L' : 'M'}${x(i).toFixed(1)},${y(v).toFixed(1)}`).join('');
  const last = vals[vals.length - 1];
  const color = last >= 0 ? '#0ca30c' : '#d03b3b';
  return `<svg class="spark" width="${w}" height="${h}" viewBox="0 0 ${w} ${h}" aria-label="Today's P&L path"><line x1="0" x2="${w}" y1="${y(0).toFixed(1)}" y2="${y(0).toFixed(1)}" stroke="rgba(255,255,255,0.15)" stroke-width="1"/><path d="${d}" fill="none" stroke="${color}" stroke-width="2" stroke-linejoin="round" stroke-linecap="round"/></svg>`;
}
