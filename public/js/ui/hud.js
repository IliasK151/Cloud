import { money, nyTime, signClass, escapeHtml } from '../format.js';
import { fundBook, deskBook, hasFtmo, bookMode, setBookPref } from '../book.js';

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
      navLabel: document.getElementById('kpi-nav-label'),
      dayLabel: document.getElementById('kpi-day-label'),
      totalLabel: document.getElementById('kpi-total-label'),
      grossLabel: document.getElementById('kpi-gross-label'),
      railSub: document.getElementById('rail-sub'),
      bookSwitch: document.getElementById('book-switch'),
    };
    this.el.bookSwitch.addEventListener('click', (e) => {
      const b = e.target.closest('[data-book]');
      if (!b) return;
      setBookPref(b.dataset.book);
      this.update();
      this.onBookChange?.();
    });
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
    const b = fundBook(s);
    const ftmo = b.mode === 'ftmo';
    this.el.bookSwitch.hidden = !hasFtmo(s);
    this.el.bookSwitch.querySelectorAll('button').forEach((x) => x.setAttribute('aria-pressed', String(x.dataset.book === bookMode(s))));
    this.el.navLabel.textContent = b.navLabel;
    this.el.dayLabel.textContent = ftmo ? 'Today' : 'Day P&L';
    this.el.totalLabel.textContent = b.totalLabel;
    this.el.grossLabel.textContent = b.exposureLabel;
    this.el.railSub.textContent = ftmo ? 'FTMO today' : 'Paper today';
    // The FTMO/Paper switch takes room in the top bar, so the paper NAV goes compact beside it.
    this.el.nav.textContent = money(b.nav, { compact: hasFtmo(s) && b.nav >= 1e6 });
    this.el.day.textContent = money(b.day, { sign: true });
    this.el.day.className = `kpi-value ${signClass(b.day)}`;
    this.el.total.textContent = money(b.total, { sign: true, compact: Math.abs(b.total) >= 1e5 });
    this.el.total.className = `kpi-value ${signClass(b.total)}`;
    this.el.gross.textContent = money(b.exposure, { compact: !ftmo });
    this.el.open.textContent = String(b.open);
    this.el.clock.textContent = nyTime(f.marketTime, true);
    this.el.session.textContent = f.session;
    for (const [id, row] of this.rows) {
      const a = s.agents[id];
      if (!a) continue;
      const d = deskBook(s, id);
      row.pnl.textContent = d.na ? 'paper' : money(d.day, { sign: true, compact: Math.abs(d.day) >= 1e5 });
      row.pnl.className = `pnl num ${d.na ? 'na' : signClass(d.day)}`;
      row.pnl.title = d.na ? 'Not switched on for the FTMO account' : ftmo ? 'P&L on your FTMO account today' : 'Paper P&L today';
      const color = { 'IN TRADE': '#3987e5', ARMED: '#fab219', HALTED: '#d03b3b', PAUSED: '#7d8594', COOLDOWN: '#ec835a' }[a.status] || '#0ca30c';
      row.st.innerHTML = `<i class="st-dot" style="background:${color}"></i>${escapeHtml(a.status)}`;
      row.li.classList.toggle('active', s.selected === id);
    }
  }

  // Mark desks that trade the FTMO account (red when a live position is open).
  setLive(v) {
    for (const d of v.desks || []) {
      const row = this.rows.get(d.id);
      if (!row) continue;
      let chip = row.li.querySelector('.ftmo');
      if (!d.enabled) {
        chip?.remove();
        continue;
      }
      if (!chip) {
        chip = document.createElement('span');
        chip.className = 'ftmo';
        chip.textContent = 'FTMO';
        row.li.querySelector('.sub').prepend(chip);
      }
      chip.classList.toggle('on', !!(d.live && v.armed));
      chip.title = d.live ? `Live on FTMO: ${d.live.side} ${d.live.volume} ${d.live.symbol}` : 'Allowed to trade the FTMO account';
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
