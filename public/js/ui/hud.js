import { money, nyTime, signClass, escapeHtml, STATUS_COLORS } from '../format.js';
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
      clock: document.getElementById('clock-time'),
      session: document.getElementById('clock-session'),
      mode: document.getElementById('mode-badge'),
      conn: document.getElementById('conn'),
      list: document.getElementById('desk-list'),
      tape: document.getElementById('tape-inner'),
      navLabel: document.getElementById('kpi-nav-label'),
      dayLabel: document.getElementById('kpi-day-label'),
      totalLabel: document.getElementById('kpi-total-label'),
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
    this.el.mode.textContent = live ? 'Live' : `Sim ${s.config.speed}×`;
    this.el.mode.className = `mode-badge ${live ? 'live' : 'sim'}`;
    this.el.mode.title = live ? 'Live market data (Binance + Yahoo Finance), paper execution' : 'Simulated markets on an accelerated clock';
    this.el.list.innerHTML = '';
    this.rows.clear();
    s.profiles.forEach((p, i) => {
      if (p.lab && !s.profiles[i - 1]?.lab) {
        const h = document.createElement('li');
        h.className = 'desk-group';
        h.innerHTML = 'Quant Research Lab <small>trades only validated strategies</small>';
        this.el.list.appendChild(h);
      }
      const li = document.createElement('li');
      li.className = `desk-item${p.lab ? ' lab' : ''}`;
      const markets = p.research?.markets || p.symbols;
      li.innerHTML = `
        <span class="key" style="--accent:${p.accent}">${p.lab ? 'Q' : (i + 1) % 10}</span>
        <span class="nm">${escapeHtml(p.name)}</span>
        <span class="pnl num">—</span>
        <span class="sub"><span class="subt">${escapeHtml(p.desk)} · ${escapeHtml(markets.length > 3 ? 'all markets' : markets.join('/'))}</span></span>
        <span class="st">—</span>`;
      li.addEventListener('click', () => this.onSelect(p.id));
      this.el.list.appendChild(li);
      this.rows.set(p.id, { li, pnl: li.querySelector('.pnl'), st: li.querySelector('.st'), subt: li.querySelector('.subt'), lab: !!p.lab, p });
    });
    this.renderTape();
    this.update();
  }

  setConn(state) {
    const labels = { ok: 'Connected', connecting: 'Connecting…', down: 'Reconnecting…' };
    this.el.conn.className = `conn ${state}`;
    this.el.conn.querySelector('span').textContent = labels[state] || state;
    // Lost the floor for more than a few seconds: say what to do instead of spinning.
    if (state === 'ok') {
      clearTimeout(this.connTimer);
      this.connTimer = null;
      document.getElementById('conn-help')?.remove();
    } else if (!this.connTimer) {
      this.connTimer = setTimeout(() => {
        if (document.getElementById('conn-help')) return;
        const el = document.createElement('div');
        el.id = 'conn-help';
        el.className = 'conn-help';
        el.innerHTML = '<b>Can\'t reach the trading floor.</b> Check that the Terminal window running <code>npm start</code> is still open. If it is, reload this page (Cmd+R). Still stuck? Run <code>npm run doctor</code> in a second Terminal window: it tells you exactly what\'s wrong.';
        document.body.appendChild(el);
      }, 6000);
    }
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
    this.el.railSub.textContent = ftmo ? 'FTMO today' : 'Paper today';
    // The FTMO/Paper switch takes room in the top bar, so the paper NAV goes compact beside it.
    this.el.nav.textContent = money(b.nav, { compact: hasFtmo(s) && b.nav >= 1e6 });
    this.el.day.textContent = money(b.day, { sign: true, compact: Math.abs(b.day) >= 1e5 });
    this.el.day.className = `kpi-value ${signClass(b.day)}`;
    this.el.total.textContent = money(b.total, { sign: true, compact: Math.abs(b.total) >= 1e5 });
    this.el.total.className = `kpi-value ${signClass(b.total)}`;
    this.el.clock.textContent = nyTime(f.marketTime, true);
    this.el.session.textContent = f.session;
    for (const [id, row] of this.rows) {
      const a = s.agents[id];
      if (!a) continue;
      const d = deskBook(s, id);
      row.pnl.textContent = d.na ? 'paper' : money(d.day, { sign: true, compact: Math.abs(d.day) >= 1e5 });
      row.pnl.className = `pnl num ${d.na ? 'na' : signClass(d.day)}`;
      row.pnl.title = d.na ? 'Not switched on for the FTMO account' : ftmo ? 'P&L on your FTMO account today' : 'Paper P&L today';
      // In FTMO view a paper position is called what it is, unless it is live on MT5.
      const ld = ftmo ? s.live?.desks?.find((x) => x.id === id) : null;
      const paperTrade = ftmo && a.status === 'IN TRADE' && ld?.status?.state !== 'live';
      const stText = paperTrade ? 'paper trade' : ld?.status?.state === 'live' ? 'live on ftmo' : a.status.toLowerCase();
      const color = paperTrade ? '#8b93a1' : STATUS_COLORS[a.status] || '#3fb950';
      const stKey = `${stText}|${a.news?.hold?.label || ''}`;
      if (row.stKey !== stKey) {
        row.stKey = stKey;
        row.st.innerHTML = `<i class="st-dot" style="background:${color}"></i>${escapeHtml(stText)}`;
        row.st.title = a.news?.hold ? `Standing aside for ${a.news.hold.label}` : paperTrade ? 'This trade is on paper only, not on your FTMO account' : '';
      }
      if (row.lab) {
        const act = a.research?.active;
        const txt = act ? `${act.name} · ${act.symbol}` : `${row.p.desk} · ${(row.p.research?.markets || []).length > 3 ? 'all markets' : (row.p.research?.markets || []).join('/')}`;
        if (row.subt.textContent !== txt) row.subt.textContent = txt;
      }
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
      const state = d.status?.state || 'proving';
      chip.classList.toggle('on', state === 'live');
      chip.classList.toggle('wait', !['live', 'cleared', 'ready', 'probation'].includes(state));
      chip.textContent = state === 'live' ? 'FTMO LIVE' : state === 'probation' ? 'FTMO · ½' : ['cleared', 'ready'].includes(state) ? 'FTMO' : 'FTMO · PAPER';
      chip.title = [d.status?.text || 'Switched on for the FTMO account', d.lastSkip && state !== 'live' ? `Last trade not sent (${d.lastSkip.symbol}): ${d.lastSkip.reason}` : ''].filter(Boolean).join('\n');
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
