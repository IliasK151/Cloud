import { api } from '../net.js';
import { money, escapeHtml, signClass } from '../format.js';
import { dailyStopSwitch, onPlanSwitch } from './planSwitch.js';

// FTMO tab: connect MT5, set the account up, pick desks, arm, and watch the rules.
export class LiveView {
  constructor(store, root) {
    this.store = store;
    this.root = root;
    this.visible = false;
    this.built = false;
    this.editing = false;
    this.formLogin = null;
    store.on('live', () => this.visible && this.render());
  }

  show({ focusSetup = false } = {}) {
    this.visible = true;
    this.root.hidden = false;
    if (focusSetup) this.editing = true;
    this.render(true);
    if (focusSetup) this.root.querySelector('#live-setup')?.scrollIntoView({ block: 'start' });
  }

  hide() {
    this.visible = false;
    this.root.hidden = true;
  }

  #build() {
    this.root.innerHTML = `
      <h1>FTMO live trading</h1>
      <p class="lede">Let the desks trade your FTMO account through MetaTrader 5. Every order carries a stop-loss, lots are sized for your account, and nothing trades for real until you arm it. Your FTMO password stays in MT5.</p>
      <div class="card steps-card" id="live-steps"></div>
      <div id="live-warnings"></div>
      <div class="grid live-top">
        <div class="card" id="live-status"></div>
        <div class="card" id="live-rules"></div>
      </div>
      <div class="card" id="live-connect" style="margin-top:14px"></div>
      <div class="card" id="live-setup" style="margin-top:14px"></div>
      <div class="card" id="live-desks-card" style="margin-top:14px">
        <h2>Desks on the account</h2>
        <p class="sub">Switch on the desks that may trade FTMO. Everyone keeps paper trading either way. Your TradingView alerts reach the account through Chen's TradingView Signals desk, or through any desk named in the alert.</p>
        <div class="table-wrap" style="max-height:none"><table class="table" id="live-desks"></table></div>
      </div>
      <div class="grid dash-row-3" style="margin-top:14px">
        <div class="card">
          <h2>Positions on MT5</h2>
          <p class="sub">Live from your terminal · floor positions carry magic 7710xx</p>
          <div class="table-wrap"><table class="table compact" id="live-positions"></table></div>
        </div>
        <div class="card">
          <h2>Live activity</h2>
          <p class="sub">Orders, fills, skips and risk actions</p>
          <ol class="live-log" id="live-log"></ol>
        </div>
      </div>`;
    this.root.addEventListener('click', (e) => this.#onClick(e));
    this.root.addEventListener('change', (e) => {
      const t = e.target;
      if (t.matches('[data-desk]')) this.#post('desk', { agentId: t.dataset.desk, enabled: t.checked });
      if (t.id === 'lv-type') this.#applyPreset(t.value);
      if (t.matches('[data-plan-switch]')) onPlanSwitch(t);
    });
    this.built = true;
  }

  async #post(action, body = {}) {
    try {
      const res = await api(`/api/live/${action}`, { method: 'POST', body: JSON.stringify(body) });
      if (!res.ok) alert(res.error || 'Request failed');
      return res;
    } catch (err) {
      alert(`Could not reach the floor: ${err.message}`);
      return { ok: false };
    }
  }

  async #onClick(e) {
    const btn = e.target.closest('[data-act]');
    if (!btn) return;
    const v = this.store.live;
    const act = btn.dataset.act;
    if (act === 'arm') {
      const type = v.profile?.type;
      const label = v.types?.[type]?.label ?? 'account';
      let confirmText = '';
      if (type === 'trial') {
        if (!confirm(`Arm live trading on ${label} ${v.account.login}?\n\nEnabled desks will send real orders to this MT5 account.`)) return;
      } else {
        confirmText = prompt(`Arm live trading on your ${label} ${v.account.login}.\n\nThis account costs real money if it fails. Type the account number to confirm:`) || '';
        if (!confirmText) return;
      }
      await this.#post('arm', { confirm: confirmText });
    } else if (act === 'disarm') {
      await this.#post('disarm');
    } else if (act === 'kill') {
      if (confirm('Close every floor position on the FTMO account now and disarm?')) await this.#post('kill');
    } else if (act === 'goto') {
      if (btn.dataset.target === 'setup') this.editing = true;
      this.render(true);
      this.root.querySelector(`#live-${btn.dataset.target}`)?.scrollIntoView({ block: 'start', behavior: 'smooth' });
    } else if (act === 'edit') {
      this.editing = true;
      this.formLogin = null;
      this.render(true);
      this.root.querySelector('#live-setup')?.scrollIntoView({ block: 'start', behavior: 'smooth' });
    } else if (act === 'cancel-edit') {
      this.editing = false;
      this.render(true);
    } else if (act === 'save') {
      const res = await this.#post('setup', this.#readForm());
      if (res.ok) {
        this.editing = false;
        this.formLogin = null;
      }
    } else if (act === 'close') {
      if (confirm(`Close position #${btn.dataset.ticket} on MT5?`)) await this.#post('close', { ticket: btn.dataset.ticket });
    } else if (act === 'reset-halt') {
      if (confirm('Clear the halt? Trading stays disarmed until you arm it again.')) await this.#post('reset-halt');
    } else if (act === 'enable-all') {
      for (const d of v.desks.filter((x) => x.eligible && !x.enabled)) await this.#post('desk', { agentId: d.id, enabled: true });
    } else if (act === 'copy-ea') {
      try {
        const code = await (await fetch('/mt5/MeridianBridge.mq5')).text();
        await navigator.clipboard.writeText(code);
        btn.textContent = 'Copied ✓ — now paste in MetaEditor';
        setTimeout(() => { btn.textContent = 'Copy EA code'; }, 4000);
      } catch {
        window.open('/mt5/MeridianBridge.mq5', '_blank');
      }
    } else if (act === 'copy-token') {
      try {
        await navigator.clipboard.writeText(v.token);
        btn.textContent = 'Copied ✓';
        setTimeout(() => { btn.textContent = 'Copy'; }, 1400);
      } catch {
        prompt('Bridge token:', v.token);
      }
    }
  }

  #applyPreset(type) {
    const preset = this.store.live?.types?.[type];
    if (!preset) return;
    const set = (id, val) => {
      const el = this.root.querySelector(id);
      if (el) el.value = val ?? '';
    };
    set('#lv-target', preset.targetPct);
    set('#lv-daily', preset.dailyLossPct);
    set('#lv-max', preset.maxLossPct);
  }

  #readForm() {
    const q = (id) => this.root.querySelector(id);
    const symbolMap = {};
    this.root.querySelectorAll('[data-map]').forEach((el) => { symbolMap[el.dataset.map] = el.value || null; });
    const target = q('#lv-target').value;
    return {
      type: q('#lv-type').value,
      size: Number(q('#lv-size').value),
      targetPct: target === '' ? null : Number(target),
      dailyLossPct: Number(q('#lv-daily').value),
      maxLossPct: Number(q('#lv-max').value),
      guardPct: Number(q('#lv-guard').value),
      riskPerTradePct: Number(q('#lv-risk').value),
      maxOpenRiskPct: Number(q('#lv-openrisk').value),
      maxPositions: Number(q('#lv-maxpos').value),
      stopAtTarget: q('#lv-stop-target').checked,
      minGrade: q('#lv-grade').value,
      dailyStopPct: Number(q('#lv-daystop').value),
      dailyStopOn: q('#lv-daystop-on').checked,
      maxTradesPerDay: Number(q('#lv-maxtrades').value),
      streakStop: Number(q('#lv-streak').value),
      symbolMap,
    };
  }

  // Five-step checklist that ticks itself off as MT5 connects and the account is set up.
  #renderSteps(v) {
    const acc = v.account;
    const p = v.profile;
    const steps = [
      { t: 'Connect MT5', d: 'Install the bridge EA and attach it to a chart', done: !!acc && v.connected },
      { t: 'Allow algo trading', d: 'Algo Trading button on in MT5', done: !!acc && v.connected && acc.algoAllowed && acc.tradeAllowed },
      { t: 'Set up the account', d: 'Free Trial or Challenge, and its limits', done: !!p },
      { t: 'Choose desks', d: 'Pick who may trade the account', done: !!p && v.desks.some((d) => d.enabled) },
      { t: 'Arm', d: 'Start live trading', done: v.armed },
    ];
    const now = steps.findIndex((x) => !x.done);
    const next = [
      { text: acc ? 'MT5 has stopped talking to the floor. Make sure MT5 is open and the MeridianBridge EA is on a chart.' : 'Follow the steps below to install the bridge in MetaTrader 5. This page ticks off each step by itself.', btn: ['connect', 'Show the steps'] },
      { text: 'Turn on the Algo Trading button in the MT5 toolbar, and tick "Allow Algo Trading" in the EA settings (click the chart, press F7).', btn: null },
      { text: 'Tell the floor what kind of account this is so it can respect FTMO\'s loss limits.', btn: ['setup', 'Set up the account'] },
      { text: 'Switch on the desks that may trade your account. Everyone keeps paper trading either way.', btn: ['desks-card', 'Choose desks'] },
      { text: v.mode === 'live' ? 'Ready. Arm live trading when you want the enabled desks to start trading.' : 'Restart the floor with npm start (live mode) to trade the account.', btn: v.mode === 'live' ? ['arm', 'Arm live trading'] : null },
    ][now] || { text: 'All set: enabled desks are trading your account. Close all & disarm is always one click away.', btn: null };
    const btn = next.btn
      ? next.btn[0] === 'arm'
        ? `<button class="btn arm" data-act="arm">${next.btn[1]}</button>`
        : `<button class="btn primary" data-act="goto" data-target="${next.btn[0]}">${next.btn[1]}</button>`
      : '';
    this.root.querySelector('#live-steps').innerHTML = `
      <h2>${now < 0 ? 'Your FTMO account is live' : 'Setup'}</h2>
      <ol class="stepper">${steps.map((x, i) => `<li class="${x.done ? 'done' : i === now ? 'now' : ''}"><b><span class="n">${x.done ? '✓' : i + 1}</span>${x.t}</b>${x.d}</li>`).join('')}</ol>
      <div class="next-step"><span>${escapeHtml(next.text)}</span>${btn}</div>`;
  }

  render(force = false) {
    const v = this.store.live;
    if (!v) return;
    if (!this.built) this.#build();
    const $ = (id) => this.root.querySelector(id);
    const acc = v.account;
    const p = v.profile;

    this.#renderSteps(v);

    $('#live-warnings').innerHTML = [
      ...(v.halt ? [`<div class="banner crit">⛔ <span><b>Trading halted:</b> ${escapeHtml(v.halt.reason)}.${v.halt.kind === 'daily' ? ' It resets at the start of the next FTMO server day.' : ''} <button class="mini-btn" data-act="reset-halt">Clear halt</button></span></div>`] : []),
      ...v.warnings.map((w) => `<div class="banner ${/demo mode/.test(w) ? 'info' : 'crit'}">${/demo mode/.test(w) ? 'ℹ︎' : '▲'} ${escapeHtml(w)}</div>`),
    ].join('');

    // Status card
    const connDot = v.connected ? 'ok' : acc ? 'bad' : 'warn';
    const since = v.lastSync ? Math.max(0, Math.round((Date.now() - v.lastSync) / 1000)) : null;
    const typeLabel = p ? v.types[p.type].label : 'not set up';
    const liveState = v.halt ? '<span class="dot bad"></span>Halted' : v.armed ? '<span class="dot bad"></span><span class="armed-banner">ARMED — LIVE</span>' : '<span class="dot"></span>Disarmed';
    const canArm = v.connected && p && !v.halt && !v.armed && v.mode === 'live' && v.desks.some((d) => d.enabled);
    $('#live-status').innerHTML = `
      <h2>Connection</h2>
      <p class="sub">MetaTrader 5 ⇄ MeridianBridge EA ⇄ this floor</p>
      <div class="status-rows">
        <div><span>MT5 bridge</span><b><span class="dot ${connDot}"></span>${v.connected ? `Connected${v.eaVersion ? ` · EA ${escapeHtml(v.eaVersion)}` : ''}` : acc ? `Lost contact${since != null ? ` (${since}s ago)` : ''}` : 'Waiting for MT5…'}</b></div>
        <div><span>Account</span><b>${acc ? `${escapeHtml(String(acc.login))} · ${escapeHtml(acc.server)}` : '—'}</b></div>
        <div><span>Account type</span><b>${escapeHtml(typeLabel)}${p ? ` · ${money(p.size)}` : ''}</b></div>
        <div><span>Market data</span><b>${p && v.mode === 'live' ? 'Priced from your MT5 feed' : 'Public feeds'}</b></div>
        <div><span>Live execution</span><b>${liveState}</b></div>
      </div>
      <div class="btn-row">
        ${v.armed ? '<button class="btn" data-act="disarm">Disarm</button>' : `<button class="btn arm" data-act="arm" ${canArm ? '' : 'disabled'}>Arm live trading</button>`}
        <button class="btn danger" data-act="kill" ${v.connected ? '' : 'disabled'}>Close all & disarm</button>
        ${acc ? '<button class="btn" data-act="edit">Edit setup</button>' : ''}
      </div>
      ${!canArm && !v.armed && acc ? `<p class="fine">${!p ? 'Save the account setup below to continue.' : !v.desks.some((d) => d.enabled) ? 'Switch on at least one desk below, then arm.' : v.mode !== 'live' ? 'Restart the floor with npm start to trade live.' : ''}</p>` : ''}`;

    // Rules card
    const m = v.metrics;
    if (acc && p && m) {
      const pct = (x) => `${Math.round(Math.max(0, x) * 100)}%`;
      const guardAt = p.guardPct / 100;
      const meter = (label, used, detail, foot, kind) => {
        const cls = kind || (used >= guardAt ? 'crit' : used >= guardAt * 0.6 ? 'warn' : '');
        const icon = cls === 'crit' ? ' ⛔' : cls === 'warn' ? ' ▲' : '';
        return `<div class="meter-row ${cls}"><div class="m-head"><span>${label}${icon}</span><b>${detail}</b></div>
          <div class="meter-track"><i style="width:${Math.min(100, Math.max(0, used * 100)).toFixed(1)}%"></i>${kind === 'good' ? '' : `<span class="guard" style="left:${guardAt * 100}%"></span>`}</div>
          <div class="m-foot">${foot}</div></div>`;
      };
      const today = acc.equity - m.dayStartBalance;
      $('#live-rules').innerHTML = `
        <h2>Account vs FTMO rules</h2>
        <p class="sub">${escapeHtml(v.types[p.type].label)} · limits ${p.dailyLossPct}% daily / ${p.maxLossPct}% max${p.targetPct ? ` · target ${p.targetPct}%` : ''} · the guard acts at ${p.guardPct}% of each limit (white marker)</p>
        <div class="mini-tiles">
          <div><span>Balance</span><b class="num">${money(acc.balance)}</b></div>
          <div><span>Equity</span><b class="num">${money(acc.equity)}</b></div>
          <div><span>Today</span><b class="num ${signClass(today)}">${money(today, { sign: true })}</b></div>
          <div><span>Open risk</span><b class="num">${money(v.openRisk)}</b></div>
        </div>
        <div class="meters">
          ${m.targetEquity ? meter('Profit target', Math.max(0, m.targetProgress), `${money(m.profit, { sign: true })} of ${money(m.targetEquity - p.size)}`, p.stopAtTarget ? 'Trading stops automatically when the target is reached.' : 'Keeps trading after the target.', 'good') : ''}
          ${meter('Daily loss used', m.dailyUsed, `${money(-m.dailyLoss)} of ${money(-m.dailyLimit)} · ${pct(m.dailyUsed)}`, `Measured from today's starting balance ${money(m.dayStartBalance)}. Stops at ${money(-m.dailyGuard)}.`)}
          ${meter('Max loss used', m.maxUsed, `${money(-m.totalLoss)} of ${money(-m.maxLimit)} · ${pct(m.maxUsed)}`, `Account may not fall below ${money(p.size - m.maxLimit)}. Stops at ${money(p.size - m.maxGuard)}.`)}
        </div>
        ${dailyStopSwitch(v.plan)}`;
    } else {
      $('#live-rules').innerHTML = `<h2>Account vs FTMO rules</h2><p class="sub">Once MT5 is connected and the account is set up, balance, equity, profit target and the daily and max loss limits show here.</p>`;
    }

    // Connect instructions: shown until MT5 has connected at least once.
    const origin = `http://127.0.0.1:${location.port || 80}`;
    $('#live-connect').hidden = !!acc;
    if (!acc) {
      $('#live-connect').innerHTML = `
        <h2>Connect your FTMO MetaTrader 5 account</h2>
        <p class="sub">About 5 minutes, once. Do it with your Free Trial first.</p>
        <ol class="steps">
          <li>In your <b>FTMO Client Area</b>, start a Free Trial or Challenge on <b>MetaTrader 5</b>. Download MT5 for Mac and log in with the account number, password and server shown there.</li>
          <li>In MT5: <b>Tools → Options → Expert Advisors</b>. Tick <b>Allow algorithmic trading</b> and <b>Allow WebRequest for listed URL</b>, then add<div class="code-block">${origin}</div></li>
          <li>Install the bridge Expert Advisor. On a Mac, drag-and-drop into MT5's folders usually doesn't work, so use one of these:
            <ul class="steps">
              <li><b>Easiest:</b> in MT5 open <b>MetaEditor</b> (F4 or the IDE button). Choose <b>File → New → Expert Advisor (template)</b>, name it <code>MeridianBridge</code>, and click Next until Finish. Select all the template code and delete it. Then <button class="mini-btn" data-act="copy-ea">Copy EA code</button> and paste it in (Cmd+V, or Ctrl+V / right-click → Paste if that doesn't work). Press <b>Compile</b>.</li>
              <li><b>Or with one command:</b> quit MT5, then run <code>npm run install-ea</code> in Terminal inside the trading-floor folder. Reopen MT5, right-click <b>Expert Advisors → Refresh</b> in the Navigator, then right-click MeridianBridge → <b>Modify</b> → <b>Compile</b>.</li>
              <li>Or <a href="/mt5/MeridianBridge.mq5" download>download MeridianBridge.mq5</a> and copy it into <b>MQL5 → Experts</b> via <b>File → Open Data Folder</b>.</li>
            </ul></li>
          <li>In the Navigator, drag <b>MeridianBridge</b> onto any chart.${origin.endsWith(':3000') ? '' : ` Set its <b>Floor bridge URL</b> input to <code>${origin}/api/bridge/sync</code>.`} On the <b>Inputs</b> tab, paste this bridge token: <span class="field" style="display:inline-flex"><span class="code">${escapeHtml(v.token)}</span><button class="mini-btn" data-act="copy-token">Copy</button></span> On the Common tab, tick <b>Allow Algo Trading</b>.</li>
          <li>Switch on the <b>Algo Trading</b> button in the MT5 toolbar. This page detects the account within a second.</li>
        </ol>
        <p class="fine">Keep MT5 open and your Mac awake while the desks trade. No MT5 at hand? Run <code>npm run mock-mt5</code> to try the whole flow with a pretend account.</p>`;
    }

    // Setup form: when there is no profile yet or the boss is editing.
    const showForm = acc && (!p || this.editing);
    $('#live-setup').hidden = !showForm;
    if (showForm && (force || this.formLogin !== acc.login)) {
      this.formLogin = acc.login;
      const cur = p || { type: 'trial', size: acc.initialDeposit || acc.balance, ...v.types.trial, ...v.defaults };
      const map = p?.symbolMap || v.suggestedMap;
      const typeOpts = Object.entries(v.types).map(([k, t]) => `<option value="${k}" ${k === cur.type ? 'selected' : ''}>${escapeHtml(t.label)}</option>`).join('');
      const mapRows = Object.keys(v.suggestedMap).map((id) => {
        const opts = [...new Set([...(v.candidates[id] || []), ...(map[id] ? [map[id]] : [])])];
        return `<label><span>${id}</span><select data-map="${id}"><option value="">Not traded</option>${opts.map((o) => `<option ${o === map[id] ? 'selected' : ''}>${escapeHtml(o)}</option>`).join('')}</select></label>`;
      }).join('');
      $('#live-setup').innerHTML = `
        <h2>${p ? 'Edit account setup' : `Set up account ${escapeHtml(String(acc.login))}`}</h2>
        <p class="sub">Is this a Free Trial or a Challenge? The FTMO limits below are pre-filled with FTMO's standard 2-Step values. <b>Check them against your account in the FTMO Client Area</b> and change them if your program differs.</p>
        <div class="form-grid">
          <label>Account type<select id="lv-type">${typeOpts}</select></label>
          <label>Account size (${escapeHtml(acc.currency || 'USD')})<input type="number" id="lv-size" min="1000" step="1000" value="${Math.round(cur.size)}"><span class="hint">Detected starting balance: ${money(acc.initialDeposit || acc.balance)}</span></label>
          <label>Profit target %<input type="number" id="lv-target" step="0.5" value="${cur.targetPct ?? ''}"><span class="hint">Empty = no target (funded account)</span></label>
          <label>Max daily loss %<input type="number" id="lv-daily" step="0.5" value="${cur.dailyLossPct}"></label>
          <label>Max loss %<input type="number" id="lv-max" step="0.5" value="${cur.maxLossPct}"></label>
          <label>Guard acts at % of a limit<input type="number" id="lv-guard" min="30" max="100" step="5" value="${cur.guardPct}"><span class="hint">80 = stop at $4,000 of a $5,000 daily limit</span></label>
          <label>Risk per trade % of balance<input type="number" id="lv-risk" min="0.01" max="2" step="0.05" value="${cur.riskPerTradePct}"><span class="hint">Loss if a trade's stop-loss is hit</span></label>
          <label>Max open risk %<input type="number" id="lv-openrisk" min="0.05" max="10" step="0.25" value="${cur.maxOpenRiskPct}"></label>
          <label>Max live positions<input type="number" id="lv-maxpos" min="1" max="20" step="1" value="${cur.maxPositions}"></label>
          <label class="check"><input type="checkbox" id="lv-stop-target" ${cur.stopAtTarget ? 'checked' : ''}> Stop trading when the target is hit</label>
        </div>
        <h3 style="margin-top:18px">The account plan</h3>
        <p class="fine">How the account brain protects this account. The desks keep trading on paper either way; these rules decide what reaches real money.</p>
        <div class="form-grid">
          <label>Trades on the account<select id="lv-grade"><option value="A" ${cur.minGrade !== 'B' ? 'selected' : ''}>Committee A-grade only (recommended)</option><option value="B" ${cur.minGrade === 'B' ? 'selected' : ''}>A and B-grade</option></select></label>
          <label>Daily stop %<input type="number" id="lv-daystop" min="0.25" max="10" step="0.25" value="${cur.dailyStopPct ?? 1.5}"><span class="hint">Done for the day at this loss, far before FTMO's daily limit</span></label>
          <label class="check"><input type="checkbox" id="lv-daystop-on" ${cur.dailyStopOn !== false ? 'checked' : ''}> Daily stop on (off: keep trading after a losing day; FTMO's daily guard still applies)</label>
          <label>Max trades per day<input type="number" id="lv-maxtrades" min="1" max="50" step="1" value="${cur.maxTradesPerDay ?? 6}"></label>
          <label>Stop after losses in a row<input type="number" id="lv-streak" min="2" max="10" step="1" value="${cur.streakStop ?? 3}"><span class="hint">Two in a row already halves the risk</span></label>
        </div>
        <h3 style="margin-top:18px">Symbols on your account</h3>
        <p class="fine">The floor's markets matched to your MT5 symbols (${v.brokerSymbolCount} available). Markets set to "Not traded" stay paper only.</p>
        <div class="map-grid">${mapRows}</div>
        <div class="btn-row" style="margin-top:16px"><button class="btn primary" data-act="save">Save setup</button>${p ? '<button class="btn" data-act="cancel-edit">Cancel</button>' : ''}</div>`;
    }

    // Desks
    const desksTable = $('#live-desks');
    if (!desksTable.contains(document.activeElement) || force) {
      desksTable.innerHTML = `<thead><tr><th>Desk</th><th>Market → MT5</th><th>Trade FTMO</th><th>Live position</th><th class="r">Live P&amp;L today</th></tr></thead><tbody>${
        v.desks.map((d) => {
          const prof = this.store.profileById[d.id];
          return `<tr>
            <td><span class="desk-cell"><i style="background:${prof?.accent ?? '#888'}"></i><span>${escapeHtml(d.name)}<small>${escapeHtml(d.desk)}</small></span></span></td>
            <td>${escapeHtml(d.symbols[0])} → ${d.brokerSymbol ? `<b>${escapeHtml(d.brokerSymbol)}</b>` : '<span class="muted">not mapped</span>'}${d.id === 'chen' ? '<br><span class="muted">+ your TradingView alerts</span>' : ''}${prof?.lab ? '<br><span class="muted">market follows its research · half size while on probation</span>' : ''}</td>
            <td>${d.eligible ? `<label class="switch" title="${d.enabled ? 'Trading FTMO' : 'Paper only'}"><input type="checkbox" data-desk="${d.id}" ${d.enabled ? 'checked' : ''} ${p ? '' : 'disabled'} aria-label="${escapeHtml(d.name)} trades FTMO"><span></span></label>` : `<span class="muted" title="${escapeHtml(d.reason)}">Paper only ⓘ</span>`}</td>
            <td>${d.live ? `${d.live.side} ${d.live.volume} ${escapeHtml(d.live.symbol)}` : '<span class="muted">—</span>'}</td>
            <td class="r ${signClass(d.pnlToday)}">${d.pnlToday ? money(d.pnlToday, { sign: true }) : '<span class="muted">—</span>'}</td>
          </tr>`;
        }).join('')
      }</tbody>`;
    }
    if (p && v.desks.some((d) => d.eligible && !d.enabled)) {
      if (!this.root.querySelector('[data-act="enable-all"]')) desksTable.insertAdjacentHTML('beforebegin', '<button class="btn" data-act="enable-all" style="margin-bottom:10px">Enable all eligible desks</button>');
    } else {
      this.root.querySelector('[data-act="enable-all"]')?.remove();
    }

    $('#live-positions').innerHTML = `<thead><tr><th>Ticket</th><th>Desk</th><th>Symbol</th><th>Side</th><th class="r">Lots</th><th class="r">Open</th><th class="r">SL</th><th class="r">TP</th><th class="r">P&amp;L</th><th></th></tr></thead><tbody>${
      v.positions.map((x) => `<tr><td>${x.ticket}</td><td>${x.agentId ? escapeHtml(this.store.profileById[x.agentId]?.name.split(' ')[0] ?? x.agentId) : '<span class="muted">manual</span>'}</td><td>${escapeHtml(x.symbol)}</td><td>${x.side}</td><td class="r">${x.volume}</td><td class="r">${x.open}</td><td class="r">${x.sl || '—'}</td><td class="r">${x.tp || '—'}</td><td class="r ${signClass(x.profit)}">${money(x.profit, { sign: true })}</td><td>${x.floor ? `<button class="mini-btn" data-act="close" data-ticket="${x.ticket}">Close</button>` : ''}</td></tr>`).join('') ||
      '<tr><td colspan="10" class="muted">No open positions on the account.</td></tr>'
    }</tbody>`;

    $('#live-log').innerHTML = v.events.map((e) => `<li class="k-${e.kind}"><time>${new Date(e.time).toLocaleTimeString()}</time>${escapeHtml(e.text)}</li>`).join('') || '<li class="muted">Nothing yet.</li>';
  }
}
