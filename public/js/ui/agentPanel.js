import { api, command } from '../net.js';
import { voice } from '../voice.js';
import { candleChart } from './charts.js';
import { money, price as fmtPrice, qty as fmtQty, signClass, initials, nyTime, escapeHtml } from '../format.js';
import { deskBook } from '../book.js';

// Right-hand drawer: the selected trader greets the boss, explains the setup and P&L.
export class AgentPanel {
  constructor(store, floor) {
    this.store = store;
    this.floor = floor;
    this.id = null;
    this.tab = 'setup';
    this.chart = null;
    this.tvSymbol = null;
    this.typeTimer = null;
    this.bubbleTimer = null;
    this.speakToken = 0;
    const $ = (id) => document.getElementById(id);
    this.el = {
      root: $('agent-panel'), avatar: $('ap-avatar'), name: $('ap-name'), title: $('ap-title'), status: $('ap-status'),
      greet: $('ap-greet'), text: $('ap-text'), replay: $('ap-replay'),
      day: $('ap-day'), unreal: $('ap-unreal'), total: $('ap-total'), limit: $('ap-limit'),
      bias: $('ap-bias'), strategy: $('ap-strategy'), stage: $('ap-stage'), thesis: $('ap-thesis'),
      confBar: $('ap-conf-bar'), conf: $('ap-conf'), checklist: $('ap-checklist'), positions: $('ap-positions'),
      levels: $('ap-levels'), stats: $('ap-stats'), flatten: $('ap-flatten'), pause: $('ap-pause'),
      chartMeta: $('ap-chart-meta'), chartBox: $('ap-chart'), tv: $('ap-tv'), tvLink: $('ap-tv-link'),
      trades: $('ap-trades'), log: $('ap-log'), close: $('ap-close'),
    };
    this.el.root.querySelectorAll('.ap-tabs button').forEach((b) => b.addEventListener('click', () => this.showTab(b.dataset.tab)));
    this.el.replay.addEventListener('click', () => this.brief(true));
    this.el.flatten.addEventListener('click', () => this.id && command('flatten', this.id));
    this.el.pause.addEventListener('click', () => {
      const a = this.store.agents[this.id];
      if (a) command(a.paused ? 'resume' : 'pause', this.id);
    });
    store.on('trade', (t) => {
      if (t.agentId === this.id && this.tab === 'trades') this.#loadTrades();
    });
    store.on('event', (ev) => {
      if (ev.agentId === this.id && this.tab === 'learn' && (ev.kind === 'learn' || ev.kind === 'exit')) this.#loadLearning();
    });
    document.getElementById('ap-learn').addEventListener('click', (e) => {
      if (!e.target.closest('[data-act="reset-learning"]') || !this.id) return;
      const name = this.store.profileById[this.id].name.split(' ')[0];
      if (!confirm(`Make ${name} forget everything learned so far and start fresh?`)) return;
      command('reset-learning', this.id);
      setTimeout(() => this.#loadLearning(), 400);
    });
  }

  // One line about the desk's position on the FTMO account.
  setLive(v) {
    this.liveState = v;
    this.#renderLive();
  }

  #renderLive() {
    const el = document.getElementById('ap-live');
    const d = this.liveState?.desks?.find((x) => x.id === this.id);
    if (!el || !d || !d.enabled) {
      if (el) el.hidden = true;
      return;
    }
    el.hidden = false;
    const armed = this.liveState.armed;
    el.textContent = d.live
      ? `FTMO live: ${d.live.side} ${d.live.volume} ${d.live.symbol} · ${money(d.live.profit, { sign: true })}${d.live.sl ? ` · SL ${d.live.sl}` : ''}`
      : `FTMO: ${armed ? 'armed, flat on the account' : 'enabled, waiting for you to arm'}${d.pnlToday ? ` · today ${money(d.pnlToday, { sign: true })}` : ''}`;
  }

  get isOpen() {
    return !!this.id;
  }

  open(id) {
    const p = this.store.profileById[id];
    if (!p) return;
    voice.unlock();
    this.id = id;
    this.el.root.hidden = false;
    this.el.avatar.textContent = initials(p.name);
    this.el.avatar.style.background = p.accent;
    this.el.name.textContent = p.name;
    this.el.title.textContent = `${p.title} · ${p.desk}`;
    this.el.strategy.textContent = p.strategy;
    this.el.tvLink.href = `https://www.tradingview.com/chart/?symbol=${encodeURIComponent(this.store.symbols[p.symbols[0]]?.tv ?? p.symbols[0])}`;
    this.destroyChart();
    this.tvSymbol = null;
    this.el.tv.innerHTML = '';
    this.showTab(this.tab === 'trades' ? 'setup' : this.tab);
    this.update();
    this.#renderLive();
    this.brief(false);
  }

  close() {
    this.id = null;
    this.el.root.hidden = true;
    this.speakToken++;
    voice.stop();
    clearInterval(this.typeTimer);
    clearInterval(this.bubbleTimer);
    this.destroyChart();
    this.el.tv.innerHTML = '';
  }

  destroyChart() {
    this.chart?.destroy();
    this.chart = null;
  }

  // Fetch a fresh briefing from the desk, type it out, speak it and show it over their head.
  async brief(again) {
    const id = this.id;
    const p = this.store.profileById[id];
    const token = ++this.speakToken;
    clearInterval(this.typeTimer);
    clearInterval(this.bubbleTimer);
    this.el.greet.textContent = '';
    this.el.text.innerHTML = '<span class="caret"></span>';
    let detail;
    try {
      detail = await api(`/api/agents/${id}`);
    } catch {
      this.el.text.textContent = 'Could not reach the desk.';
      return;
    }
    if (token !== this.speakToken) return;
    this.detail = detail;
    const { greeting, lines, text } = detail.briefing;
    const opener = again ? 'Sure, boss.' : greeting;
    this.el.greet.textContent = `${opener} 👋`;

    // Wait for the camera to land and the trader to turn around.
    await new Promise((r) => setTimeout(r, again ? 150 : 1300));
    if (token !== this.speakToken) return;
    this.floor.showBubble(id, `<b>${escapeHtml(p.name)}</b>${escapeHtml(opener)} 👋`, { duration: 0, big: true });

    // Typewriter in the panel.
    let shown = 0;
    this.typeTimer = setInterval(() => {
      if (token !== this.speakToken) return clearInterval(this.typeTimer);
      shown = Math.min(text.length, shown + 2);
      this.el.text.innerHTML = `${escapeHtml(text.slice(0, shown))}${shown < text.length ? '<span class="caret"></span>' : ''}`;
      if (shown >= text.length) clearInterval(this.typeTimer);
    }, 55);

    // The bubble over the trader's head follows the sentence being spoken,
    // or cycles on a timer when voices are muted or unavailable.
    let current = -1;
    const showLine = (i) => {
      if (i === current || token !== this.speakToken || i < 0 || i >= lines.length) return;
      current = i;
      this.floor.updateBubble(id, `<b>${escapeHtml(p.name)}</b>${escapeHtml(lines[i])}`);
    };
    let speaking = false;
    if (!voice.enabled) voice.mimic(id, 1200 + (text.length / 2) * 55);
    if (voice.enabled) {
      voice
        .speakLines([opener, ...lines], p, {
          onLine: (i) => {
            speaking = true;
            if (i > 0) showLine(i - 1);
          },
        })
        .then((ok) => {
          if (ok && token === this.speakToken) setTimeout(() => this.floor.clearBubble(id), 2500);
        });
    }
    let i = -1;
    const step = () => {
      if (token !== this.speakToken) return clearInterval(this.bubbleTimer);
      if (speaking) return;
      i++;
      if (i >= lines.length) {
        clearInterval(this.bubbleTimer);
        setTimeout(() => token === this.speakToken && this.floor.clearBubble(id), 3000);
        return;
      }
      showLine(i);
    };
    setTimeout(step, 1800);
    this.bubbleTimer = setInterval(step, 4200);
  }

  showTab(tab) {
    this.tab = tab;
    this.el.root.querySelectorAll('.ap-tabs button').forEach((b) => b.setAttribute('aria-selected', String(b.dataset.tab === tab)));
    this.el.root.querySelectorAll('.ap-tab').forEach((t) => { t.hidden = t.dataset.tab !== tab; });
    if (tab === 'chart') this.#ensureChart();
    if (tab === 'tv') this.#ensureTradingView();
    if (tab === 'trades') this.#loadTrades();
    if (tab === 'learn') this.#loadLearning();
  }

  async #loadLearning() {
    if (!this.id) return;
    const id = this.id;
    try {
      this.detail = await api(`/api/agents/${id}`);
    } catch {
      return;
    }
    if (id !== this.id) return;
    this.#renderLearning(this.detail.learning);
  }

  #renderLearning(L) {
    const el = document.getElementById('ap-learn');
    const p = this.store.profileById[this.id];
    const first = p.name.split(' ')[0];
    if (!L || !L.enabled) {
      el.innerHTML = `<p class="thesis">${escapeHtml(first)}'s ${escapeHtml(p.strategy.toLowerCase())} book is managed as a whole (hedged pairs or two-sided quotes), so it doesn't use the trade-by-trade learning system.</p>`;
      return;
    }
    const fmtR = (r) => (r == null ? '—' : `${r >= 0 ? '+' : '−'}${Math.abs(r).toFixed(2)}R`);
    const statusChip = { active: ['trying it', 'armed'], kept: ['kept, it helped', 'trade'], reverted: ['undone', 'halted'], noted: ['', ''] };
    const lessons = L.lessons.map((l) => {
      const [chip, cls] = statusChip[l.status] || ['', ''];
      return `<li><div class="lh"><b>${escapeHtml(l.title)}</b>${chip ? `<span class="status-chip ${cls}">${chip}</span>` : ''}</div>
        <p>${escapeHtml(l.text)}</p><time>${new Date(l.time).toLocaleDateString()} · after ${l.studied} trades studied</time></li>`;
    }).join('');
    const rows = L.features.filter((f) => f.n >= 3).map((f) => `<tr class="${f.avoided ? 'avoided' : ''}">
      <td>${escapeHtml(f.label)}${f.avoided ? ' <span class="pill no">SAT OUT</span>' : ''}</td>
      <td class="r">${Math.round(f.n)}</td>
      <td class="r ${f.avgR > 0.05 ? 'pos' : f.avgR < -0.05 ? 'neg' : ''}">${fmtR(f.avgR)}</td>
      <td class="r muted">${fmtR(f.otherR)}</td>
      <td class="r">${f.effect === 1 ? '<span class="muted">—</span>' : `×${f.effect.toFixed(2)}`}</td></tr>`).join('');
    el.innerHTML = `
      <div class="learn-strip">
        <div><span>Trades studied</span><b class="num">${L.studied}</b></div>
        <div><span>Recent average</span><b class="num ${L.recentAvgR > 0 ? 'pos' : L.recentAvgR < 0 ? 'neg' : ''}">${fmtR(L.recentAvgR)}</b></div>
        <div><span>Lessons</span><b class="num">${L.lessons.length}</b></div>
      </div>
      <h3>What ${escapeHtml(first)} does differently now</h3>
      ${L.adjustments.length ? `<ul class="learn-adj">${L.adjustments.map((a) => `<li>${escapeHtml(a)}</li>`).join('')}</ul>` : `<p class="fine">Nothing yet. ${escapeHtml(first)} changes a habit only after enough trades show a clear pattern (about a dozen in the same situation), and never beyond safe limits.</p>`}
      <h3>Lessons</h3>
      ${lessons ? `<ol class="learn-lessons">${lessons}</ol>` : '<p class="fine">No lessons yet. Every closed trade is studied: the situation it was taken in, how far it went for and against, and what the market did after a stop-out.</p>'}
      <h3>Results by situation</h3>
      ${rows ? `<div class="table-wrap"><table class="table compact learn-table"><thead><tr><th>Situation</th><th class="r">Trades</th><th class="r">Avg</th><th class="r">Others</th><th class="r">Size</th></tr></thead><tbody>${rows}</tbody></table></div><p class="fine">Recent trades count most. "Others" is the desk's average on all its other trades; size shows how much bigger or smaller ${escapeHtml(first)} trades that situation now.</p>` : '<p class="fine">Builds up as trades close.</p>'}
      <p class="fine">On your FTMO account, learning can only make a trade smaller, never bigger. Your own TradingView alerts are studied but never skipped or changed.</p>
      <button class="btn" data-act="reset-learning" style="margin-top:6px">Forget what ${escapeHtml(first)} learned</button>`;
  }

  #ensureChart() {
    if (this.chart || !this.id) return;
    const p = this.store.profileById[this.id];
    const sym = p.symbols[0];
    this.chart = candleChart(this.el.chartBox, this.store.symbols[sym]?.decimals ?? 2);
    this.chartSymbol = sym;
    this.chart.setData(this.store.candles[sym] || []);
    this.#chartOverlays();
  }

  #chartOverlays() {
    if (!this.chart) return;
    const a = this.store.agents[this.id];
    const sym = this.chartSymbol;
    const pos = a?.positions.find((x) => x.symbol === sym);
    const lines = [];
    if (pos) {
      lines.push({ price: pos.avg, color: '#2962ff', title: `${pos.side} ${fmtQty(pos.qty)}`, dashed: false, width: 2 });
      if (pos.stop != null) lines.push({ price: pos.stop, color: '#f23645', title: 'Stop' });
      if (pos.target != null) lines.push({ price: pos.target, color: '#089981', title: 'Target' });
    }
    for (const l of (a?.setup.levels || []).slice(0, 4)) lines.push({ price: l.price, color: 'rgba(154,163,178,0.7)', title: l.label });
    this.chart.setLines(lines);
    const trades = (this.detail?.trades || []).filter((t) => t.symbol === sym);
    const bars = this.store.candles[sym] || [];
    const first = bars[0]?.time ?? 0;
    const markers = [];
    for (const t of trades) {
      const open = Math.floor(t.openTime / 60000) * 60;
      const close = Math.floor(t.closeTime / 60000) * 60;
      if (open >= first) markers.push({ time: open, position: t.side === 'LONG' ? 'belowBar' : 'aboveBar', color: t.side === 'LONG' ? '#089981' : '#f23645', shape: t.side === 'LONG' ? 'arrowUp' : 'arrowDown', text: t.side === 'LONG' ? 'Buy' : 'Sell' });
      if (close >= first) markers.push({ time: close, position: 'aboveBar', color: t.pnl >= 0 ? '#9fe3b0' : '#ff9b9b', shape: 'circle', text: money(t.pnl, { sign: true, compact: true }) });
    }
    markers.sort((x, y) => x.time - y.time);
    this.chart.setMarkers(markers);
  }

  // Official TradingView Advanced Chart widget for the desk's market.
  #ensureTradingView() {
    if (!this.id) return;
    const p = this.store.profileById[this.id];
    const tvSym = this.store.symbols[p.symbols[0]]?.tv ?? p.symbols[0];
    if (this.tvSymbol === tvSym) return;
    this.tvSymbol = tvSym;
    const host = this.el.tv;
    host.innerHTML = '<div class="tradingview-widget-container"><div class="tradingview-widget-container__widget"></div></div>';
    const script = document.createElement('script');
    script.src = 'https://s3.tradingview.com/external-embedding/embed-widget-advanced-chart.js';
    script.async = true;
    script.type = 'text/javascript';
    script.textContent = JSON.stringify({
      autosize: true,
      symbol: tvSym,
      interval: '1',
      timezone: 'America/New_York',
      theme: 'dark',
      style: '1',
      locale: 'en',
      allow_symbol_change: true,
      hide_side_toolbar: false,
      studies: ['STD;VWAP'],
      support_host: 'https://www.tradingview.com',
    });
    script.onerror = () => {
      host.innerHTML = '<p class="fine" style="padding:16px">TradingView could not be loaded — check your internet connection. The Chart tab still shows the floor\'s own feed.</p>';
    };
    host.firstChild.appendChild(script);
  }

  async #loadTrades() {
    if (!this.id) return;
    try {
      this.detail = await api(`/api/agents/${this.id}`);
    } catch {
      return;
    }
    const d = this.detail;
    const dec = (s) => this.store.symbols[s]?.decimals ?? 2;
    this.el.trades.innerHTML = `<thead><tr><th>Closed</th><th>Side</th><th>Mkt</th><th class="r">Entry</th><th class="r">Exit</th><th class="r">P&amp;L</th><th class="r">R</th></tr></thead><tbody>${
      d.trades.slice(0, 25).map((t) => `<tr title="${escapeHtml(t.exitReason || '')}"><td>${nyTime(t.closeTime)}</td><td>${t.side}</td><td>${t.symbol}</td><td class="r">${fmtPrice(t.entry, dec(t.symbol))}</td><td class="r">${fmtPrice(t.exit, dec(t.symbol))}</td><td class="r ${signClass(t.pnl)}">${money(t.pnl, { sign: true })}</td><td class="r">${t.r == null ? '—' : t.r.toFixed(2)}</td></tr>`).join('') ||
      '<tr><td colspan="7" class="muted">No closed trades yet.</td></tr>'
    }</tbody>`;
    this.el.log.innerHTML = d.log.slice().reverse().slice(0, 40).map((l) => `<li class="k-${l.kind}"><time>${nyTime(l.time)}</time>${escapeHtml(l.text)}</li>`).join('');
  }

  update() {
    if (!this.id) return;
    const a = this.store.agents[this.id];
    if (!a) return;
    const chip = this.el.status;
    chip.textContent = a.status;
    chip.className = `status-chip ${a.status === 'IN TRADE' ? 'trade' : a.status === 'ARMED' ? 'armed' : a.status === 'HALTED' ? 'halted' : ''}`;
    const setVal = (el, v, opts) => {
      el.textContent = money(v, opts);
      el.className = `val num ${signClass(v)}`;
    };
    const b = deskBook(this.store, this.id);
    const lbl = (id, text) => { document.getElementById(id).textContent = text; };
    if (b.mode === 'ftmo') {
      lbl('ap-day-lbl', 'FTMO today');
      lbl('ap-unreal-lbl', 'FTMO open');
      lbl('ap-total-lbl', 'FTMO total');
      lbl('ap-limit-lbl', 'FTMO trades');
      if (b.na) {
        for (const el of [this.el.day, this.el.unreal, this.el.total]) { el.textContent = '—'; el.className = 'val num muted'; }
        this.el.limit.textContent = 'Paper only';
        this.el.limit.className = 'val muted';
      } else {
        setVal(this.el.day, b.day, { sign: true });
        setVal(this.el.unreal, b.unrealized, { sign: true });
        setVal(this.el.total, b.total, { sign: true });
        this.el.limit.textContent = String(b.trades);
        this.el.limit.className = 'val num';
      }
    } else {
      lbl('ap-day-lbl', 'Paper day');
      lbl('ap-unreal-lbl', 'Unrealized');
      lbl('ap-total-lbl', 'Paper total');
      lbl('ap-limit-lbl', 'Limit used');
      setVal(this.el.day, a.pnl.day, { sign: true, compact: Math.abs(a.pnl.day) >= 1e5 });
      setVal(this.el.unreal, a.pnl.unrealized, { sign: true, compact: Math.abs(a.pnl.unrealized) >= 1e5 });
      setVal(this.el.total, a.pnl.total, { sign: true, compact: true });
      const used = a.pnl.day < 0 ? -a.pnl.day / a.lossLimit : 0;
      this.el.limit.textContent = `${Math.round(used * 100)}%`;
      this.el.limit.className = `val num ${used > 0.75 ? 'neg' : ''}`;
    }

    const st = a.setup;
    this.el.bias.textContent = st.bias;
    this.el.bias.className = `bias ${st.bias}`;
    this.el.stage.textContent = st.stage;
    this.el.thesis.textContent = st.thesis;
    this.el.confBar.style.width = `${st.confidence}%`;
    this.el.conf.textContent = `${st.confidence}%`;
    this.el.checklist.innerHTML = (st.checklist || []).map((c) => `<li class="${c.ok ? 'ok' : ''}">${escapeHtml(c.label)}</li>`).join('');
    const dec = (s) => this.store.symbols[s]?.decimals ?? 2;
    // In FTMO view the P&L tiles are the account's; the cards below stay the paper book.
    lbl('ap-pos-h', b.mode === 'ftmo' ? 'Paper book positions' : 'Positions');
    lbl('ap-perf-h', b.mode === 'ftmo' ? 'Paper book performance' : 'Performance');
    this.el.positions.innerHTML = a.positions.length
      ? a.positions.map((p) => `
        <div class="pos-card">
          <div class="h"><span>${p.side} ${fmtQty(p.qty)} ${p.symbol}</span><span class="${signClass(p.unrealized)}">${money(p.unrealized, { sign: true })}</span></div>
          <div class="c"><span>Entry</span><b>${fmtPrice(p.avg, dec(p.symbol))}</b></div>
          <div class="c"><span>Mark</span><b>${fmtPrice(p.mark, dec(p.symbol))}</b></div>
          <div class="c"><span>R multiple</span><b>${p.r == null ? '—' : p.r.toFixed(2)}</b></div>
          <div class="c"><span>Stop</span><b>${p.stop == null ? '—' : fmtPrice(p.stop, dec(p.symbol))}</b></div>
          <div class="c"><span>Target</span><b>${p.target == null ? 'trail' : fmtPrice(p.target, dec(p.symbol))}</b></div>
          <div class="c"><span>Opened</span><b>${nyTime(p.openTime)}</b></div>
        </div>`).join('')
      : '<p class="muted">Flat — no open risk.</p>';
    const sym = this.store.profileById[this.id].symbols[0];
    this.el.levels.innerHTML = (st.levels || []).map((l) => `<tr><td>${escapeHtml(l.label)}</td><td>${fmtPrice(l.price, dec(sym))}</td></tr>`).join('') || '<tr><td class="muted">No levels yet</td><td></td></tr>';
    const s = a.stats;
    const cells = [
      ['Trades today', `${s.tradesDay}`],
      ['Wins / losses', `${s.winsDay} / ${s.lossesDay}`],
      ['Win rate', s.winRate == null ? '—' : `${Math.round(s.winRate * 100)}%`],
      ['Profit factor', s.profitFactor == null ? '—' : Number.isFinite(s.profitFactor) ? s.profitFactor.toFixed(2) : '∞'],
      ['Avg R', s.avgR == null ? '—' : s.avgR.toFixed(2)],
      ['Max drawdown', money(-s.maxDrawdown, { compact: true })],
    ];
    this.el.stats.innerHTML = cells.map(([k, v]) => `<div><span>${k}</span><b class="num">${v}</b></div>`).join('');
    this.el.pause.textContent = a.paused ? 'Resume desk' : 'Pause desk';

    if (this.chart) {
      const bars = this.store.candles[this.chartSymbol] || [];
      // Push the just-closed bar (final values) and the forming one.
      for (const b of bars.slice(-2)) this.chart.update(b);
      this.#chartOverlays();
      const q = this.store.quotes[this.chartSymbol];
      this.el.chartMeta.innerHTML = `<span><b>${this.chartSymbol}</b> ${fmtPrice(q?.price, dec(this.chartSymbol))}</span><span>Feed <b>${escapeHtml(q?.status ?? '')}</b></span><span>TradingView symbol <b>${escapeHtml(this.store.symbols[this.chartSymbol]?.tv ?? '')}</b></span>`;
    }
  }
}
