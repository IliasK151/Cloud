import { command, api } from '../net.js';
import { equityChart } from './charts.js';
import { money, price as fmtPrice, qty as fmtQty, pct, signClass, nyTime, escapeHtml } from '../format.js';
import { bookMode, hasFtmo, setBookPref, deskBook } from '../book.js';
import { labRows } from './research.js';
import { newsTable, sourceText, blackoutChips } from './news.js';

// Full-screen dashboard. It follows the FTMO / Paper switch: the paper fund (every desk's
// practice book) or the connected FTMO account (real equity, rules, live trades).
export class Dashboard {
  constructor(store, root, { onSelect, onBookChange, onView }) {
    this.store = store;
    this.root = root;
    this.onSelect = onSelect;
    this.onBookChange = onBookChange;
    this.onView = onView;
    this.visible = false;
    this.built = false;
    this.lastRender = 0;
    this.chart = null;
    this.chartMode = null;
    this.controlsMode = null;
  }

  #build() {
    this.root.innerHTML = `
      <div id="dash-banner"></div>
      <div class="dash-head">
        <div><h1 id="dash-title">Dashboard</h1><p class="lede" id="dash-lede"></p></div>
        <div class="book-switch big" id="dash-book" role="group" aria-label="Which book to show" hidden>
          <button data-book="ftmo" aria-pressed="false">FTMO account</button>
          <button data-book="paper" aria-pressed="false">Paper fund</button>
        </div>
      </div>
      <div class="grid tiles" id="dash-tiles"></div>
      <div class="grid dash-row" style="margin-top:14px">
        <div class="card">
          <h2 id="dash-eq-title">Equity</h2>
          <p class="sub" id="dash-eq-sub"></p>
          <div class="equity-box" id="dash-equity"></div>
        </div>
        <div class="card">
          <h2 id="dash-bars-title">Desk P&amp;L — today</h2>
          <p class="sub" id="dash-bars-sub"></p>
          <div class="bars" id="dash-bars"></div>
        </div>
      </div>
      <div class="card" id="dash-lab-card" style="margin-top:14px">
        <h2>Quant Research Lab</h2>
        <p class="sub">Five researchers build strategies for today's market conditions and trade only what survives out-of-sample, stress and holdout tests. Click a row for the full research.</p>
        <div class="table-wrap" style="max-height:none"><table class="table" id="dash-lab"></table></div>
      </div>
      <div class="card" id="dash-news-card" style="margin-top:14px">
        <h2>Economic calendar</h2>
        <p class="sub" id="dash-news-sub"></p>
        <div id="dash-news-holds"></div>
        <div id="dash-news"></div>
      </div>
      <div class="card" style="margin-top:14px">
        <h2>Desks</h2>
        <p class="sub" id="dash-table-sub"></p>
        <div class="table-wrap" style="max-height:none"><table class="table" id="dash-table"></table></div>
      </div>
      <div class="grid dash-row-3" style="margin-top:14px">
        <div class="card">
          <h2 id="dash-risk-title">Risk</h2>
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
          <h2 id="dash-blotter-title">Trade blotter</h2>
          <p class="sub" id="dash-blotter-sub"></p>
          <div class="table-wrap"><table class="table compact" id="dash-blotter"></table></div>
        </div>
        <div class="card">
          <div id="dash-controls"></div>
          <h2 style="margin-top:18px">TradingView alerts</h2>
          <p class="sub">Latest webhook alerts received</p>
          <div class="table-wrap"><table class="table compact" id="dash-alerts"></table></div>
        </div>
      </div>
      <div class="card lessons-card" style="margin-top:14px">
        <h2>What the desks have learned</h2>
        <p class="sub">Every desk studies its own trades and adjusts, within safe limits. Click a desk to see its lessons.</p>
        <div class="table-wrap" style="max-height:none"><table class="table" id="dash-learning"></table></div>
      </div>`;
    this.root.addEventListener('click', async (e) => {
      const b = e.target.closest('[data-cmd], [data-live], [data-goto], #dash-book [data-book]');
      if (!b) return;
      if (b.dataset.book) {
        setBookPref(b.dataset.book);
        this.onBookChange?.();
        this.render(true);
      } else if (b.dataset.cmd) {
        if (b.dataset.cmd === 'flatten' && !confirm('Flatten every paper desk now?')) return;
        if (b.dataset.cmd === 'reset-paper' && !confirm('Reset the paper P&L, trade history and stats to zero? Open trades keep running. Your FTMO account is not affected.')) return;
        command(b.dataset.cmd);
      } else if (b.dataset.live === 'kill') {
        if (!confirm('Close every floor position on the FTMO account now and disarm?')) return;
        await api('/api/live/kill', { method: 'POST', body: '{}' }).catch(() => {});
      } else if (b.dataset.goto) {
        this.onView?.(b.dataset.goto);
      }
    });
    this.root.querySelector('#dash-lab').addEventListener('click', (e) => {
      const btn = e.target.closest('[data-research]');
      if (btn) {
        e.stopPropagation();
        command('research', btn.dataset.research);
        btn.disabled = true;
        return;
      }
      const row = e.target.closest('tr[data-id]');
      if (row) this.onSelect(row.dataset.id, { tab: 'research' });
    });
    this.root.querySelector('#dash-learning').addEventListener('click', (e) => {
      const row = e.target.closest('tr[data-id]');
      if (row) this.onSelect(row.dataset.id, { tab: 'learn' });
    });
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
    if (!this.chart) this.chart = equityChart(this.root.querySelector('#dash-equity'));
    this.chartMode = null;
    this.render(true);
  }

  hide() {
    this.visible = false;
    this.root.hidden = true;
  }

  onEquity(sample) {
    if (this.visible && this.chart && this.chartMode === 'paper') this.chart.update({ time: sample.time, value: sample.nav });
  }

  // Point the equity chart at the paper fund or the FTMO account.
  #syncChart(mode) {
    if (!this.chart) return;
    const s = this.store;
    if (mode === 'ftmo') {
      const pts = s.live?.equityHistory || [];
      if (this.chartMode !== 'ftmo') {
        this.chart.setData(pts, s.live.profile.size, { compact: false });
      } else if (pts.length) {
        this.chart.update(pts[pts.length - 1]);
      }
    } else if (this.chartMode !== 'paper') {
      this.chart.setData(s.equity, s.config.startingCapital, { compact: true });
    }
    this.chartMode = mode;
  }

  render(force = false) {
    if (!this.visible || !this.store.fund) return;
    const now = performance.now();
    if (!force && now - this.lastRender < 1000) return;
    this.lastRender = now;
    const s = this.store;
    const mode = bookMode(s);
    const sw = this.root.querySelector('#dash-book');
    sw.hidden = !hasFtmo(s);
    sw.querySelectorAll('button').forEach((b) => b.setAttribute('aria-pressed', String(b.dataset.book === mode)));
    this.#syncChart(mode);
    this.#renderControls(mode);
    this.#renderMarketsAndAlerts();
    this.#renderLearning();
    this.#renderLabAndNews();
    if (mode === 'ftmo') this.#renderFtmo();
    else this.#renderPaper();
  }

  #renderLabAndNews() {
    const s = this.store;
    const $ = (id) => this.root.querySelector(id);
    const lab = labRows(s);
    if (lab !== this.labHtml) {
      this.labHtml = lab;
      $('#dash-lab').innerHTML = lab;
    }
    const now = s.fund.marketTime;
    $('#dash-news-sub').textContent = sourceText(s.news);
    $('#dash-news-holds').innerHTML = blackoutChips(s.news, now);
    $('#dash-news').innerHTML = s.news?.settings?.enabled === false ? '' : newsTable(s.news, now, 12);
  }

  focusNews() {
    this.root.querySelector('#dash-news-card')?.scrollIntoView({ behavior: 'smooth', block: 'center' });
  }

  #renderLearning() {
    const s = this.store;
    const rows = s.profiles.map((p) => ({ p, a: s.agents[p.id] })).filter((x) => x.a?.learning && !x.p.lab);
    this.root.querySelector('#dash-learning').innerHTML = `<thead><tr><th>Desk</th><th class="r">Trades studied</th><th class="r">Lessons</th><th class="r">Habits changed</th><th>Latest lesson</th></tr></thead><tbody>${
      rows.map(({ p, a }) => {
        const L = a.learning;
        const off = p.learning === false;
        return `<tr class="clickable" data-id="${p.id}">
          <td><span class="desk-cell"><i style="background:${p.accent}"></i><span>${escapeHtml(p.name)}<small>${escapeHtml(p.desk)}</small></span></span></td>
          <td class="r">${off ? '<span class="muted">—</span>' : L.studied}</td>
          <td class="r">${off ? '<span class="muted">—</span>' : L.lessons}</td>
          <td class="r">${off ? '<span class="muted">—</span>' : L.adjustments}</td>
          <td>${off ? '<span class="muted">Hedged book, not trade by trade</span>' : L.last ? `${escapeHtml(L.last.title)} <span class="muted">· ${new Date(L.last.time).toLocaleDateString()}</span>` : `<span class="muted">${L.studied ? 'Nothing to change yet' : 'Waiting for its first closed trades'}</span>`}</td>
        </tr>`;
      }).join('')
    }</tbody>`;
  }

  #renderControls(mode) {
    if (this.controlsMode === mode) return;
    this.controlsMode = mode;
    this.root.querySelector('#dash-controls').innerHTML = mode === 'ftmo'
      ? `<h2>FTMO controls</h2>
         <p class="sub">Arming, desks and limits live in the FTMO tab. This closes every floor position on the account at once.</p>
         <div class="test-row">
           <button class="btn danger" data-live="kill">Close all &amp; disarm</button>
           <button class="btn" data-goto="ftmo">Open the FTMO tab</button>
         </div>`
      : `<h2>Floor controls</h2>
         <p class="sub">Paper desks. For your FTMO account, switch the dashboard to FTMO or use the FTMO tab.</p>
         <div class="test-row">
           <button class="btn" data-cmd="pause-all">Pause all desks</button>
           <button class="btn" data-cmd="resume-all">Resume all desks</button>
           <button class="btn danger" data-cmd="flatten">Flatten the floor</button>
           <button class="btn" data-cmd="reset-paper">Reset paper P&amp;L</button>
         </div>`;
  }

  #renderMarketsAndAlerts() {
    const s = this.store;
    this.root.querySelector('#dash-markets').innerHTML = Object.values(s.symbols).map((sym) => {
      const q = s.quotes[sym.id];
      return `<div class="mkt"><div class="s"><span>${sym.id}</span><span class="${q?.change > 0 ? 'pos' : q?.change < 0 ? 'neg' : ''}">${pct(q?.change)}</span></div>
        <div class="p">${fmtPrice(q?.price, sym.decimals)}</div>
        <div class="src src-${(q?.status || '').toLowerCase()}">${escapeHtml(q?.status ?? '')} · ${escapeHtml(sym.tv)}</div></div>`;
    }).join('');
    this.root.querySelector('#dash-alerts').innerHTML = `<thead><tr><th>Time</th><th>Desk</th><th>Action</th><th>Result</th></tr></thead><tbody>${
      s.alerts.slice().reverse().slice(0, 12).map((al) => `<tr><td>${new Date(al.time).toLocaleTimeString()}</td><td>${escapeHtml(s.profileById[al.agentId]?.name ?? '—')}</td><td>${escapeHtml(al.action.toUpperCase())} ${escapeHtml(al.symbol || '')}</td><td><span class="pill ${al.ok ? 'ok' : 'no'}">${al.ok ? 'OK' : 'REJECTED'}</span> ${escapeHtml(al.result || '')}</td></tr>`).join('') ||
      '<tr><td colspan="4" class="muted">No alerts yet. See the TradingView tab to connect your alerts.</td></tr>'
    }</tbody>`;
  }

  // ---- FTMO account ---------------------------------------------------------------------
  #renderFtmo() {
    const s = this.store;
    const v = s.live;
    const acc = v.account;
    const p = v.profile;
    const m = v.metrics || {};
    const st = v.stats || { closedToday: 0, winsToday: 0, closedTotal: 0, winsTotal: 0, floating: 0 };
    const typeLabel = v.types?.[p.type]?.label ?? 'FTMO account';
    const $ = (id) => this.root.querySelector(id);

    const banners = [];
    if (v.halt) banners.push(`<div class="banner crit">⛔ <span><b>Trading halted:</b> ${escapeHtml(v.halt.reason)}.</span></div>`);
    if (!v.connected) banners.push(`<div class="banner crit">▲ MT5 is not connected right now, so these numbers are from the last sync${v.lastSync ? ` (${new Date(v.lastSync).toLocaleTimeString()})` : ''}. Open MT5 with the MeridianBridge EA on a chart.</div>`);
    else if (!v.armed && !v.halt) banners.push('<div class="banner info">ℹ︎ Disarmed: the desks are not sending new trades to this account. Arm live trading in the FTMO tab when you are ready.</div>');
    $('#dash-banner').innerHTML = banners.join('');
    $('#dash-title').textContent = 'FTMO account dashboard';
    $('#dash-lede').textContent = `${typeLabel} ${money(p.size)} · account ${acc.login} on ${acc.server} · ${v.armed ? 'armed — desks are trading it' : 'disarmed'} · ${v.desks.filter((d) => d.enabled).length} desks switched on`;

    const today = acc.equity - (m.dayStartBalance ?? acc.balance);
    const total = acc.equity - p.size;
    const openCount = v.positions.filter((x) => x.floor).length;
    const dailyUsed = m.dailyUsed || 0;
    const tiles = [
      ['Account equity', money(acc.equity), `Balance ${money(acc.balance)}`, ''],
      ['Today', money(today, { sign: true }), `From ${money(m.dayStartBalance ?? acc.balance)} at the day's start`, signClass(today)],
      ['Since start', money(total, { sign: true }), `${pct(total / p.size)} of ${money(p.size, { compact: true })}`, signClass(total)],
      ['Open P&L', money(st.floating, { sign: true }), `${openCount} floor position${openCount === 1 ? '' : 's'} on MT5`, signClass(st.floating)],
      ['Open risk', money(v.openRisk || 0), `${((v.openRisk || 0) / acc.balance * 100).toFixed(2)}% of balance · cap ${p.maxOpenRiskPct}%`, ''],
      ['Floor trades today', String(st.closedToday), st.closedToday ? `${st.winsToday} winner${st.winsToday === 1 ? '' : 's'} · win rate ${Math.round((st.winsToday / st.closedToday) * 100)}%` : 'No closed trades yet today', ''],
      ['Daily loss used', `${Math.round(dailyUsed * 100)}%`, `The guard stops trading at ${money(-(m.dailyGuard ?? 0))}`, dailyUsed >= 0.6 ? 'neg' : ''],
      ...(m.targetEquity ? [['Profit target', `${Math.round(Math.max(0, m.targetProgress || 0) * 100)}%`, `${money(m.profit, { sign: true })} of ${money(m.targetEquity - p.size)}`, (m.targetProgress || 0) > 0 ? 'pos' : '']] : []),
    ];
    $('#dash-tiles').innerHTML = tiles.map(([l, val, foot, cls]) => `
      <div class="card tile"><div class="t-label">${l}</div><div class="t-value ${cls}">${val}</div><div class="t-foot">${foot}</div></div>`).join('');

    $('#dash-eq-title').textContent = 'Account equity';
    $('#dash-eq-sub').textContent = (v.equityHistory || []).length > 1 ? 'Sampled every minute while MT5 is connected · dashed line = account size' : 'Builds up minute by minute while MT5 is connected';
    $('#dash-bars-title').textContent = 'Desk P&L on FTMO — today';
    $('#dash-bars-sub').textContent = 'Closed + open trades on the account, per desk';

    const rows = s.profiles.map((pr) => ({ pr, d: v.desks.find((x) => x.id === pr.id), b: deskBook(s, pr.id) })).filter((x) => x.d);
    const maxAbs = Math.max(1, ...rows.filter((x) => !x.b.na).map((x) => Math.abs(x.b.day)));
    $('#dash-bars').innerHTML = rows.map(({ pr, b }) => {
      if (b.na) return `<div class="bar-row" title="Not switched on for the FTMO account"><span class="nm">${escapeHtml(pr.desk)}</span><div class="bar-track"><span class="zero"></span></div><span class="v muted">paper only</span></div>`;
      const w = (Math.abs(b.day) / maxAbs) * 50;
      return `<div class="bar-row" title="${escapeHtml(pr.name)} on FTMO today: ${money(b.day, { sign: true })}">
        <span class="nm">${escapeHtml(pr.desk)}</span>
        <div class="bar-track"><span class="zero"></span><span class="fill ${b.day >= 0 ? 'p' : 'n'}" style="width:${w}%"></span></div>
        <span class="v ${signClass(b.day)}">${money(b.day, { sign: true })}</span></div>`;
    }).join('');

    $('#dash-table-sub').textContent = 'Click a row to talk to the trader · switch desks on or off in the FTMO tab';
    $('#dash-table').innerHTML = `
      <thead><tr><th>#</th><th>Desk · strategy</th><th>Trader</th><th>Market → MT5</th><th>On FTMO</th><th>Live position</th><th class="r">Open P&amp;L</th><th class="r">Today</th><th class="r">Since start</th><th class="r">Trades today</th></tr></thead>
      <tbody>${rows.map(({ pr, d }, i) => `<tr class="clickable" data-id="${pr.id}">
          <td class="muted">${pr.lab ? 'Q' : (i + 1) % 10}</td>
          <td><span class="desk-cell"><i style="background:${pr.accent}"></i><span>${escapeHtml(pr.desk)}<small>${escapeHtml(pr.strategy)}</small></span></span></td>
          <td>${escapeHtml(pr.name)}</td>
          <td>${escapeHtml(d.symbols[0])} → ${d.brokerSymbol ? escapeHtml(d.brokerSymbol) : '<span class="muted">not mapped</span>'}</td>
          <td>${d.enabled ? `<span class="pill ${v.armed ? 'no' : 'ok'}">${v.armed ? 'LIVE' : 'ON'}</span>` : `<span class="muted">${d.eligible ? 'off' : 'paper only'}</span>`}</td>
          <td>${d.live ? `${d.live.side} ${d.live.volume} ${escapeHtml(d.live.symbol)}` : '<span class="muted">Flat</span>'}</td>
          <td class="r ${signClass(d.live?.profit ?? 0)}">${d.live ? money(d.live.profit, { sign: true }) : '<span class="muted">—</span>'}</td>
          <td class="r ${signClass(d.pnlToday)}"><b>${d.enabled || d.pnlToday ? money(d.pnlToday, { sign: true }) : '<span class="muted">—</span>'}</b></td>
          <td class="r ${signClass(d.pnlTotal)}">${d.enabled || d.pnlTotal ? money(d.pnlTotal, { sign: true }) : '<span class="muted">—</span>'}</td>
          <td class="r">${d.tradesToday || 0}</td>
        </tr>`).join('')}</tbody>`;

    $('#dash-risk-title').textContent = 'FTMO rules';
    $('#dash-risk-sub').textContent = `Limits ${p.dailyLossPct}% daily / ${p.maxLossPct}% max${p.targetPct ? ` · target ${p.targetPct}%` : ''}. The guard closes the floor's positions at ${p.guardPct}% of a limit (white marker).`;
    const guardAt = p.guardPct / 100;
    const meter = (label, used, detail, kind) => {
      const cls = kind || (used >= guardAt ? 'crit' : used >= guardAt * 0.6 ? 'warn' : '');
      return `<div class="meter-row ${cls}"><div class="m-head"><span>${label}</span><b>${detail}</b></div>
        <div class="meter-track"><i style="width:${Math.min(100, Math.max(0, used * 100)).toFixed(1)}%"></i>${kind === 'good' ? '' : `<span class="guard" style="left:${guardAt * 100}%"></span>`}</div></div>`;
    };
    $('#dash-risk').innerHTML = `<div class="meters">
      ${m.targetEquity ? meter('Profit target', Math.max(0, m.targetProgress || 0), `${money(m.profit, { sign: true })} of ${money(m.targetEquity - p.size)}`, 'good') : ''}
      ${meter('Daily loss used', m.dailyUsed || 0, `${money(-(m.dailyLoss || 0))} of ${money(-(m.dailyLimit || 0))}`)}
      ${meter('Max loss used', m.maxUsed || 0, `${money(-(m.totalLoss || 0))} of ${money(-(m.maxLimit || 0))}`)}
    </div>`;

    $('#dash-blotter-title').textContent = 'FTMO trades';
    $('#dash-blotter-sub').textContent = `The floor's trades on account ${acc.login}, newest first · ${st.closedTotal} closed${st.closedTotal ? `, ${Math.round((st.winsTotal / st.closedTotal) * 100)}% winners` : ''}`;
    $('#dash-blotter').innerHTML = `<thead><tr><th>Opened</th><th>Desk</th><th>Side</th><th>Symbol</th><th class="r">Lots</th><th>Status</th><th class="r">P&amp;L</th><th>Why</th></tr></thead><tbody>${
      (v.trades || []).map((t) => `<tr><td>${new Date(t.openedAt).toLocaleTimeString()}</td><td>${escapeHtml(s.profileById[t.agentId]?.desk ?? t.agentId)}</td><td>${t.side}</td><td>${escapeHtml(t.symbol)}</td><td class="r">${t.volume}</td><td>${t.state === 'closed' ? `closed ${t.closedAt ? new Date(t.closedAt).toLocaleTimeString() : ''}` : '<span class="pill ok">OPEN</span>'}</td><td class="r ${signClass(t.pnl)}">${money(t.pnl, { sign: true })}</td><td class="thesis-cell">${t.grade ? `<span class="verdict ok">${t.grade}</span> ` : ''}${escapeHtml(t.thesis || t.reason)}</td></tr>`).join('') ||
      '<tr><td colspan="8" class="muted">No trades on this account yet. They show up here as soon as an enabled desk trades while armed.</td></tr>'
    }</tbody>`;
  }

  // ---- paper fund ---------------------------------------------------------------------------
  #renderPaper() {
    const s = this.store;
    const f = s.fund;
    const r = s.config.risk;
    const $ = (id) => this.root.querySelector(id);
    $('#dash-title').textContent = 'Paper fund dashboard';
    $('#dash-eq-title').textContent = 'Fund equity (NAV)';
    $('#dash-eq-sub').textContent = 'Sampled every market minute · dashed line = starting capital · hover for values';
    $('#dash-bars-title').textContent = 'Desk P&L — today';
    $('#dash-bars-sub').textContent = 'Realized + unrealized, per desk (paper)';
    $('#dash-table-sub').textContent = "Click a row to talk to the trader · sparkline = today's P&L path";
    $('#dash-risk-title').textContent = 'Risk — daily loss limit used';
    $('#dash-blotter-title').textContent = 'Trade blotter';
    $('#dash-blotter-sub').textContent = 'Most recent closed round trips across the floor (paper)';

    this.root.querySelector('#dash-banner').innerHTML = (f.riskOff
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
          <td class="muted">${p.lab ? 'Q' : (i + 1) % 10}</td>
          <td><span class="desk-cell"><i style="background:${p.accent}"></i><span>${escapeHtml(p.desk)}<small>${escapeHtml(p.lab && a.research?.active ? a.research.active.name : p.strategy)}</small></span></span></td>
          <td>${escapeHtml(p.name)}</td>
          <td>${escapeHtml(p.lab ? (a.research?.active ? a.symbol : 'none yet') : p.symbols.join(' / '))}</td>
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


    this.root.querySelector('#dash-blotter').innerHTML = `<thead><tr><th>Closed</th><th>Desk</th><th>Side</th><th>Mkt</th><th class="r">Qty</th><th class="r">Entry</th><th class="r">Exit</th><th class="r">P&amp;L</th><th>Exit reason</th></tr></thead><tbody>${
      s.blotter.slice(0, 30).map((t) => `<tr><td>${nyTime(t.closeTime)}</td><td>${escapeHtml(s.profileById[t.agentId]?.desk ?? t.agentId)}</td><td>${t.side}</td><td>${t.symbol}</td><td class="r">${fmtQty(t.qty)}</td><td class="r">${fmtPrice(t.entry, dec(t.symbol))}</td><td class="r">${fmtPrice(t.exit, dec(t.symbol))}</td><td class="r ${signClass(t.pnl)}">${money(t.pnl, { sign: true })}</td><td class="muted">${escapeHtml(t.exitReason || '')}</td></tr>`).join('') ||
      '<tr><td colspan="9" class="muted">No closed trades yet — the desks are working their setups.</td></tr>'
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
