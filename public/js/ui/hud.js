import { money, nyTime, signClass, escapeHtml } from '../format.js';

// Top bar KPIs, the desk rail on the left and the scrolling event tape.
export class Hud {
  constructor(store, { onSelect }) {
    this.store = store;
    this.onSelect = onSelect;
    this.el = {
      fundName: document.getElementById('fund-name'),
      nav: document.getElementById('kpi-nav'),
      day: document.getElementById('kpi-day'),
      total: document.getElementById('kpi-total'),
      gross: document.getElementById('kpi-gross'),
      open: document.getElementById('kpi-open'),
      clock: document.getElementById('clock-time'),
      session: document.getElementById('clock-session'),
      mode: document.getElementById('mode-badge'),
      conn: document.getElementById('conn'),
      list: document.getElementById('desk-list'),
      tape: document.getElementById('tape-inner'),
    };
    this.rows = new Map();
    store.on('conn', (s) => this.setConn(s));
  }

  init() {
    const s = this.store;
    this.el.fundName.textContent = s.config.fundName;
    document.title = `${s.config.fundName} · Trading Floor`;
    const live = s.config.mode === 'live';
    this.el.mode.textContent = live ? 'LIVE' : `SIM ${s.config.speed}×`;
    this.el.mode.className = `mode-badge ${live ? 'live' : 'sim'}`;
    this.el.mode.title = live ? 'Live market data (Binance + Yahoo Finance), paper execution' : 'Simulated markets on an accelerated clock';
    this.el.list.innerHTML = '';
    this.rows.clear();
    s.profiles.forEach((p, i) => {
      const li = document.createElement('li');
      li.className = 'desk-item';
      li.innerHTML = `
        <span class="key" style="background:${p.accent}">${(i + 1) % 10}</span>
        <span class="nm">${escapeHtml(p.name)}</span>
        <span class="pnl num">—</span>
        <span class="sub">${escapeHtml(p.desk)} · ${escapeHtml(p.symbols.join('/'))}</span>
        <span class="st">—</span>`;
      li.addEventListener('click', () => this.onSelect(p.id));
      this.el.list.appendChild(li);
      this.rows.set(p.id, { li, pnl: li.querySelector('.pnl'), st: li.querySelector('.st') });
    });
    this.renderTape();
    this.update();
  }

  setConn(state) {
    const labels = { ok: 'Live link', connecting: 'Connecting', down: 'Reconnecting' };
    this.el.conn.className = `conn ${state}`;
    this.el.conn.querySelector('span').textContent = labels[state] || state;
  }

  update() {
    const s = this.store;
    const f = s.fund;
    if (!f) return;
    this.el.nav.textContent = money(f.nav);
    this.el.day.textContent = money(f.dayPnl, { sign: true });
    this.el.day.className = `kpi-value ${signClass(f.dayPnl)}`;
    this.el.total.textContent = money(f.totalPnl, { sign: true, compact: true });
    this.el.total.className = `kpi-value ${signClass(f.totalPnl)}`;
    this.el.gross.textContent = money(f.grossExposure, { compact: true });
    this.el.open.textContent = String(f.openPositions);
    this.el.clock.textContent = nyTime(f.marketTime, true);
    this.el.session.textContent = f.session;
    for (const [id, row] of this.rows) {
      const a = s.agents[id];
      if (!a) continue;
      row.pnl.textContent = money(a.pnl.day, { sign: true, compact: Math.abs(a.pnl.day) >= 1e5 });
      row.pnl.className = `pnl num ${signClass(a.pnl.day)}`;
      const color = { 'IN TRADE': '#3987e5', ARMED: '#fab219', HALTED: '#d03b3b', PAUSED: '#7d8594', COOLDOWN: '#ec835a' }[a.status] || '#0ca30c';
      row.st.innerHTML = `<i class="st-dot" style="background:${color}"></i>${escapeHtml(a.status)}`;
      row.li.classList.toggle('active', s.selected === id);
    }
  }

  renderTape() {
    const items = this.store.events.slice(-14).reverse();
    this.el.tape.innerHTML = items
      .map((e) => {
        const who = e.agentId ? this.store.profileById[e.agentId]?.name.split(' ')[0] : 'Floor';
        return `<span class="tape-item"><time>${nyTime(e.time)}</time><b>${escapeHtml(who)}</b> ${escapeHtml(e.text)}</span>`;
      })
      .join('');
  }
}
