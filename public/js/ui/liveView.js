import { api } from '../net.js';
import { money, escapeHtml, signClass } from '../format.js';
import { planSwitches, onPlanSwitch, provingNote, setPlanSwitch } from './planSwitch.js';
import { ftmoStatus } from '../book.js';
import { renderToday } from './todayCard.js';
import { renderReview } from './reviewCard.js';

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
    this.#loadAlerts();
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
      <div class="card program-card" id="live-program" hidden></div>
      <div class="card today-card" id="live-today" hidden></div>
      <div class="card review-card" id="live-review" hidden></div>
      <div class="card ea-card" id="live-ea" hidden></div>
      <div id="live-warnings"></div>
      <div class="grid live-top">
        <div class="card" id="live-status"></div>
        <div class="card" id="live-rules"></div>
      </div>
      <div class="card" id="live-alerts" style="margin-top:14px"></div>
      <div class="card" id="live-connect" style="margin-top:14px"></div>
      <div class="card" id="live-setup" style="margin-top:14px"></div>
      <div class="card" id="live-desks-card" style="margin-top:14px">
        <h2>Desks on the account</h2>
        <p class="sub" id="live-desks-sub">Switch on the desks that may trade FTMO. Everyone keeps paper trading either way. Switched on isn't the same as trading the account: a desk's own trades only go to MT5 once the account brain has cleared it (10+ trades on real prices with a positive edge, and A-grade trades). "Status on the account" shows where each desk stands. Your own TradingView alerts go to the account through Chen's TradingView Signals desk, or any desk named in the alert, straight away. The committee can still veto them, and every risk rule applies.</p>
        <div class="rail-note wide" id="live-proving" hidden></div>
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
      if (t.id === 'lv-type' || t.id === 'lv-program') this.#applyPreset(this.root.querySelector('#lv-type').value);
      if (t.matches('[data-plan-switch]')) onPlanSwitch(t, this.store.live?.plan);
      if (t.matches('[data-stay-armed]')) this.#onStayArmed(t);
      if (t.id === 'tg-enabled') this.#alertsPost('settings', { enabled: t.checked }).then((r) => this.#afterAlerts(r));
      if (t.matches('[data-tg-kind]')) this.#alertsPost('settings', { kinds: { [t.dataset.tgKind]: t.checked } }).then((r) => this.#afterAlerts(r));
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

  async #onStayArmed(input) {
    const on = input.checked;
    if (on && !confirm('Stay armed after a restart?\n\nIf the floor, the Mac or MT5 restarts while live trading is armed, the floor arms it again by itself once MT5 is back and every check passes (the same account, Algo Trading on, no risk-guard stop).\n\nDisarm, Close all & disarm and a risk-guard stop always stay off until you arm again yourself.')) {
      input.checked = false;
      return;
    }
    const res = await this.#post('stay-armed', { on });
    if (!res.ok) input.checked = !on;
  }

  // ---- Telegram alerts ------------------------------------------------------------------------
  async #loadAlerts() {
    try {
      this.alerts = await api('/api/alerts');
    } catch {
      this.alerts = null;
    }
    this.#renderAlerts();
  }

  async #alertsPost(action, body = {}) {
    try {
      const res = await api(`/api/alerts/${action}`, { method: 'POST', body: JSON.stringify(body) });
      if (res.alerts) this.alerts = res.alerts;
      return res;
    } catch (err) {
      return { ok: false, error: `Could not reach the floor: ${err.message}` };
    }
  }

  #afterAlerts(res, okText = null) {
    this.tgMsg = res.ok ? (okText ? { ok: true, text: okText } : null) : { ok: false, text: res.error || 'That didn\'t work' };
    this.#renderAlerts();
  }

  #renderAlerts() {
    const el = this.root.querySelector('#live-alerts');
    if (!el) return;
    const a = this.alerts;
    const key = JSON.stringify([a, this.tgMsg]);
    if (el.dataset.key === key) return; // keep what the boss is typing
    el.dataset.key = key;
    const title = '<h2>Alerts on your phone (Telegram)</h2>';
    const msg = this.tgMsg ? `<p class="tg-msg ${this.tgMsg.ok ? 'good' : 'bad'}">${escapeHtml(this.tgMsg.text)}</p>` : '';
    if (!a) {
      el.innerHTML = `${title}<p class="sub">Loading…</p>`;
      return;
    }
    if (!a.hasToken) {
      el.innerHTML = `${title}
        <p class="sub">A message when a trade opens or closes on FTMO, when the loss guard steps in, when MT5 disconnects, and a report at the end of the day. It uses your own free Telegram bot and takes about 2 minutes. The bot token stays on this Mac.</p>
        <ol class="tg-steps">
          <li>In Telegram, open <b>@BotFather</b>, send <code>/newbot</code>, and pick any name and username for your bot.</li>
          <li>BotFather answers with a <b>token</b> (it looks like <code>123456789:AAH…</code>). Paste it here:
            <div class="tg-row"><input type="password" id="tg-token" placeholder="Bot token from @BotFather" autocomplete="off" spellcheck="false"><button class="btn primary" data-act="tg-token">Connect bot</button></div></li>
          <li>Open your new bot in Telegram and press <b>Start</b>. Then come back here for the last click.</li>
        </ol>${msg}`;
      return;
    }
    const bot = escapeHtml(a.botName || 'your bot');
    if (!a.chatId) {
      el.innerHTML = `${title}
        <p class="sub">Bot ${bot} is connected. Last step: open ${bot} in Telegram and press <b>Start</b> (or send it "hi"), then:</p>
        <div class="tg-row"><button class="btn primary" data-act="tg-find">Find my chat</button><button class="btn" data-act="tg-forget">Use another bot</button></div>${msg}`;
      return;
    }
    el.innerHTML = `${title}
      <p class="sub">To ${escapeHtml(a.chatName || `chat ${a.chatId}`)} through ${bot}.</p>
      <div class="plan-switch ${a.enabled ? '' : 'off'}">
        <label class="switch safe"><input type="checkbox" id="tg-enabled" ${a.enabled ? 'checked' : ''} aria-label="Telegram alerts"><span></span></label>
        <div><b>Alerts: ${a.enabled ? 'ON' : 'PAUSED'}</b><small>${a.enabled ? 'Messages go out as things happen.' : 'Nothing is sent until you switch them back on.'}</small></div>
      </div>
      <div class="tg-kinds">${Object.entries(a.kindLabels).map(([k, label]) => `<label><input type="checkbox" data-tg-kind="${k}" ${a.kinds[k] ? 'checked' : ''}> ${escapeHtml(label)}</label>`).join('')}</div>
      <div class="tg-row"><button class="btn" data-act="tg-test">Send a test message</button><button class="btn" data-act="tg-forget">Disconnect</button></div>
      ${a.lastError ? `<p class="tg-msg bad">Last error: ${escapeHtml(a.lastError.text)}</p>` : ''}${msg}`;
  }

  async #onClick(e) {
    const btn = e.target.closest('[data-act]');
    if (!btn) return;
    const v = this.store.live;
    const act = btn.dataset.act;
    if (act.startsWith('tg-')) {
      btn.disabled = true;
      if (act === 'tg-token') {
        const res = await this.#alertsPost('token', { token: this.root.querySelector('#tg-token')?.value || '' });
        this.#afterAlerts(res, res.ok ? `Connected to ${res.botName}. Now open it in Telegram, press Start, then "Find my chat".` : null);
      } else if (act === 'tg-find') {
        const res = await this.#alertsPost('find-chat');
        this.#afterAlerts(res, res.ok ? `Done: alerts go to ${res.chatName}. Telegram should show a hello message.` : null);
      } else if (act === 'tg-test') {
        const res = await this.#alertsPost('test');
        this.#afterAlerts(res, res.ok ? 'Sent. Check Telegram.' : null);
      } else if (act === 'tg-forget') {
        if (confirm('Disconnect the Telegram bot? Alerts stop until you connect one again.')) this.#afterAlerts(await this.#alertsPost('forget'));
      }
      btn.disabled = false;
      return;
    }
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
    } else if (act === 'let-trade') {
      btn.disabled = true;
      await setPlanSwitch('provenOnly', false, v.plan);
      btn.disabled = false;
    } else if (act === 'review-run') {
      btn.disabled = true;
      await this.#post('review');
    } else if (act === 'use-risk') {
      const risk = Number(btn.dataset.risk);
      if (!confirm(`Set the risk per trade to ${risk}%?\n\nThat's the size the nightly review found gives the best chance of passing. Every trade on the account is sized from it; the loss guard and every rule stay the same.`)) return;
      await this.#post('risk', { riskPct: risk });
    } else if (act === 'program') {
      const prog = v.programs?.[btn.dataset.program];
      if (!prog) return;
      if (!confirm(`Set account ${v.account.login} to FTMO ${prog.label}?\n\n${btn.dataset.program === '1-step' ? '3% daily loss, 10% max loss trailing the best end-of-day balance, and the Best Day rule.' : '5% daily loss, 10% max loss fixed at the starting balance.'}\n\nCheck it matches your account in the FTMO Client Area (MetriX).`)) return;
      await this.#post('program', { program: btn.dataset.program });
    } else if (act === 'hide-connect') {
      this.showConnect = false;
      this.render(true);
    } else if (act === 'goto') {
      if (btn.dataset.target === 'setup') this.editing = true;
      if (btn.dataset.target === 'connect') this.showConnect = true;
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
    } else if (act === 'install-ea') {
      btn.disabled = true;
      const res = await this.#post('install-ea');
      this.eaMsg = res.ok ? `✓ Copied into MT5 (${res.folders.length} folder${res.folders.length === 1 ? '' : 's'}). Now do step 2.` : res.error ? `✗ ${res.error}` : null;
      this.render(true);
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
    const program = this.store.live?.programs?.[this.root.querySelector('#lv-program')?.value];
    const base = this.store.live?.types?.[type];
    if (!base) return;
    // The program sets the loss limits (no program yet: the stricter 1-Step daily limit).
    const strict = this.store.live?.programs?.['1-step'];
    const preset = { ...base, ...(program ? { dailyLossPct: program.dailyLossPct, maxLossPct: program.maxLossPct } : strict ? { dailyLossPct: Math.min(base.dailyLossPct, strict.dailyLossPct) } : {}) };
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
      program: q('#lv-program')?.value || null,
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

  // The EA in MT5 is older than the one this floor ships: a short, doable update, right here.
  #renderEa(v) {
    const el = this.root.querySelector('#live-ea');
    const ea = v.ea;
    if (!ea || (!ea.outdated && !ea.updated)) {
      el.hidden = true;
      el.dataset.key = '';
      return;
    }
    el.hidden = false;
    const key = `${ea.outdated}|${ea.version}|${this.eaMsg || ''}`;
    if (el.dataset.key === key) return; // stable while the boss works through the steps
    el.dataset.key = key;
    if (!ea.outdated) {
      const c = ea.caps;
      el.classList.add('done');
      el.innerHTML = `<h2>✓ MeridianBridge EA updated to ${escapeHtml(ea.version)}</h2><p class="sub">MT5 now syncs only as often as the floor needs: every 2 seconds when nothing is happening, faster while a desk trades. That's much less work for MT5 and your battery. It also enforces the safety caps itself: every order needs a stop-loss${c ? `, at most ${c.maxRiskPct}% risk per order and ${c.maxPositions} floor positions` : ''}, and the EA never touches your own trades.</p>`;
      return;
    }
    el.classList.remove('done');
    el.innerHTML = `
      <h2>Update the MT5 bridge EA <span class="pill warn">${escapeHtml(ea.version || 'old')} → ${escapeHtml(ea.latest || 'new')}</span></h2>
      <p class="sub">${ea.caps
        ? 'The new version saves battery: MT5 syncs only as often as the floor needs (every 2 seconds when nothing is happening, twice a second while orders go through), reads the account history only after a trade, and stops redrawing its chart twice a second.'
        : 'The new version adds safety limits inside MT5 itself, as a last line of defence: every order must carry a stop-loss, the risk per order and the number of floor positions are capped, it never touches your own trades, and it can\'t open the same order twice. It also saves battery: MT5 syncs only as often as the floor needs.'} Takes about a minute. Disarm first and arm again afterwards; open positions keep their stop-loss.</p>
      <ol class="steps ea-steps">
        <li><button class="btn primary" data-act="install-ea">Put the update into MT5</button> <span class="fine">${escapeHtml(this.eaMsg || 'Copies the new code into MT5\'s Expert Advisors folder on this Mac.')}</span></li>
        <li>In MT5, in the <b>Navigator</b> panel, open <b>Expert Advisors</b>, right-click <b>MeridianBridge</b> → <b>Modify</b>. MetaEditor opens the EA${this.eaMsg?.startsWith('✓') ? ' (if it asks, reload the file)' : ''}.</li>
        <li>Press <b>Compile</b> (the button in MetaEditor's toolbar, or F7). MT5 reloads the EA on your chart by itself, keeping your bridge token. This box turns green within a second.</li>
      </ol>
      <p class="fine">Step 1 says it can't find MT5 (e.g. MT5 runs in Parallels or on another PC)? <button class="mini-btn" data-act="copy-ea">Copy EA code</button> then, in MetaEditor after step 2, select all (Cmd+A), paste (Cmd+V) and press Compile.</p>`;
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
    ][now] || { text: v.plan?.training
      ? 'All set: live trading is armed and the desks are training on FTMO. Every trade they take goes to your account, and so do your TradingView alerts. Close all & disarm is always one click away.'
      : 'All set: live trading is armed. Your TradingView alerts go to the account; each desk\'s own trades go once the account brain has cleared it (see "Status on the account" below). Close all & disarm is always one click away.', btn: null };
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

  // Which FTMO program is the account on? Until the boss says, the guard follows the stricter
  // 1-Step limits; one click sets it.
  #renderProgram(v) {
    const el = this.root.querySelector('#live-program');
    const show = !!v.profile && !!v.plan && !v.plan.program && !!v.programs;
    el.hidden = !show;
    if (!show) return;
    const size = v.profile.size;
    const usd = (pct) => money(size * pct / 100);
    const html = `
      <h2>Which FTMO program is this account?</h2>
      <p class="sub">FTMO's two programs have different rules, and a Free Trial comes in both. Until you choose, the guard follows the stricter one (1-Step), so nothing can breach either.</p>
      <div class="program-pick">
        <button class="program-opt" data-act="program" data-program="2-step"><b>2-Step</b>
          <span>Max daily loss ${usd(5)} (5%) · max loss ${usd(10)} (10%), fixed at the starting balance · no Best Day rule</span></button>
        <button class="program-opt" data-act="program" data-program="1-step"><b>1-Step</b>
          <span>Max daily loss ${usd(3)} (3%) · max loss ${usd(10)} (10%) that trails your best end-of-day balance · Best Day rule: no day over 50% of the profit</span></button>
      </div>
      <p class="fine">Not sure? In the FTMO Client Area open this account's <b>MetriX</b>: "Max Daily Loss" of ${usd(5)} means 2-Step, ${usd(3)} means 1-Step.</p>`;
    if (el.dataset.html === html) return;
    el.dataset.html = html;
    el.innerHTML = html;
  }

  // The nightly review: who has an edge on your prices, and the chance of passing.
  #renderReview(v) {
    const el = this.root.querySelector('#live-review');
    // Minutes in "ago" change the html each minute; the rest only when the review does.
    const html = renderReview(v, { now: Math.floor(Date.now() / 60_000) * 60_000 });
    el.hidden = !html;
    if (el.dataset.html === html) return;
    el.dataset.html = html;
    el.innerHTML = html;
  }

  // Today on the account: are the desks trading, and if not, why not?
  #renderToday() {
    const el = this.root.querySelector('#live-today');
    const html = renderToday(this.store);
    el.hidden = !html;
    if (el.dataset.html === html) return;
    el.dataset.html = html;
    el.innerHTML = html;
  }

  render(force = false) {
    const v = this.store.live;
    if (!v) return;
    if (!this.built) this.#build();
    const $ = (id) => this.root.querySelector(id);
    const acc = v.account;
    const p = v.profile;

    this.#renderSteps(v);
    this.#renderProgram(v);
    this.#renderToday();
    this.#renderReview(v);
    this.#renderEa(v);
    this.#renderAlerts();

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
        ${acc ? '<button class="btn" data-act="edit">Edit setup</button><button class="btn" data-act="goto" data-target="connect">MT5 bridge setup</button>' : ''}
      </div>
      ${!canArm && !v.armed && acc ? `<p class="fine">${!p ? 'Save the account setup below to continue.' : !v.desks.some((d) => d.enabled) ? 'Switch on at least one desk below, then arm.' : v.mode !== 'live' ? 'Restart the floor with npm start to trade live.' : ''}</p>` : ''}
      ${p ? `<div class="plan-switch stay-armed">
        <label class="switch"><input type="checkbox" data-stay-armed ${p.stayArmed ? 'checked' : ''} aria-label="Stay armed after a restart"><span></span></label>
        <div><b>Stay armed after a restart: ${p.stayArmed ? 'ON' : 'OFF'}</b><small>${p.stayArmed
          ? (!v.armed && v.rememberedArmed ? 'Arming again by itself as soon as MT5 is connected and every check passes.' : 'If the floor, the Mac or MT5 restarts while armed, it arms again by itself once MT5 is back and every check passes. Disarm, Close all and a risk-guard stop stay off until you arm again.')
          : 'After a restart (floor, Mac or MT5), live trading waits for you to arm it again.'}</small></div>
      </div>` : ''}`;

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
        <p class="sub">${escapeHtml(v.types[p.type].label)}${v.plan?.program ? ` · ${escapeHtml(v.plan.programLabel)}` : ''} · limits ${p.dailyLossPct}% daily / ${p.maxLossPct}% max${m.trailing ? ' (trailing)' : ''}${p.targetPct ? ` · target ${p.targetPct}%` : ''} · the guard acts at ${p.guardPct}% of each limit (white marker)</p>
        <div class="mini-tiles">
          <div><span>Balance</span><b class="num">${money(acc.balance)}</b></div>
          <div><span>Equity</span><b class="num">${money(acc.equity)}</b></div>
          <div><span>Today</span><b class="num ${signClass(today)}">${money(today, { sign: true })}</b></div>
          <div><span>Open risk</span><b class="num">${money(v.openRisk)}</b></div>
        </div>
        <div class="meters">
          ${m.targetEquity ? meter('Profit target', Math.max(0, m.targetProgress), `${money(m.profit, { sign: true })} of ${money(m.targetEquity - p.size)}`, p.stopAtTarget ? 'Trading stops automatically when the target is reached.' : 'Keeps trading after the target.', 'good') : ''}
          ${meter('Daily loss used', m.dailyUsed, `${money(-m.dailyLoss)} of ${money(-m.dailyLimit)} · ${pct(m.dailyUsed)}`, `Measured from today's starting balance ${money(m.dayStartBalance)}. Stops at ${money(-m.dailyGuard)}.`)}
          ${meter('Max loss used', m.maxUsed, `${money(-m.totalLoss)} of ${money(-m.maxLimit)} · ${pct(m.maxUsed)}`, m.trailing
            ? `Trailing (1-Step${v.plan?.program ? '' : ' rules, until you set the program'}): equity may not fall below ${money(m.maxFloor)}, ${p.maxLossPct}% under the best end-of-day balance ${money(m.maxBase)}. The line moves up with new highs, never above ${money(p.size)}. The guard stops at ${money(m.maxBase - m.maxGuard)}.`
            : `Account may not fall below ${money(m.maxFloor)}. Stops at ${money(m.maxBase - m.maxGuard)}.`)}
        </div>
        ${planSwitches(v.plan)}`;
    } else {
      $('#live-rules').innerHTML = `<h2>Account vs FTMO rules</h2><p class="sub">Once MT5 is connected and the account is set up, balance, equity, profit target and the daily and max loss limits show here.</p>`;
    }

    // MT5 connection help: shown until MT5 first connects, whenever it stops talking to the
    // floor, and on request ("Show the steps", "MT5 bridge setup").
    const origin = `http://127.0.0.1:${location.port || 80}`;
    const connected = !!acc && v.connected;
    if (!connected) this.showConnect = false; // shown anyway; "Hide" is only for the connected case
    const showConnect = !connected || this.showConnect;
    const conn = $('#live-connect');
    conn.hidden = !showConnect;
    const connKey = `${showConnect}|${!!acc}|${connected}|${v.token}|${origin}|${acc?.login}`;
    if (showConnect && (force || conn.dataset.key !== connKey)) {
      conn.dataset.key = connKey;
      const token = `<span class="field" style="display:inline-flex"><span class="code">${escapeHtml(v.token)}</span><button class="mini-btn" data-act="copy-token">Copy</button></span>`;
      const install = `
        <ol class="steps">
          <li>In your <b>FTMO Client Area</b>, start a Free Trial or Challenge on <b>MetaTrader 5</b>. Download MT5 for Mac and log in with the account number, password and server shown there.</li>
          <li>In MT5: <b>Tools → Options → Expert Advisors</b>. Tick <b>Allow algorithmic trading</b> and <b>Allow WebRequest for listed URL</b>, then add<div class="code-block">${origin}</div></li>
          <li>Install the bridge Expert Advisor. On a Mac, drag-and-drop into MT5's folders usually doesn't work, so use one of these:
            <ul class="steps">
              <li><b>Easiest:</b> in MT5 open <b>MetaEditor</b> (F4 or the IDE button). Choose <b>File → New → Expert Advisor (template)</b>, name it <code>MeridianBridge</code>, and click Next until Finish. Select all the template code and delete it. Then <button class="mini-btn" data-act="copy-ea">Copy EA code</button> and paste it in (Cmd+V, or Ctrl+V / right-click → Paste if that doesn't work). Press <b>Compile</b>.</li>
              <li><b>Or with one command:</b> quit MT5, then run <code>npm run install-ea</code> in Terminal inside the trading-floor folder. Reopen MT5, right-click <b>Expert Advisors → Refresh</b> in the Navigator, then right-click MeridianBridge → <b>Modify</b> → <b>Compile</b>.</li>
              <li>Or <a href="/mt5/MeridianBridge.mq5" download>download MeridianBridge.mq5</a> and copy it into <b>MQL5 → Experts</b> via <b>File → Open Data Folder</b>.</li>
            </ul></li>
          <li>In the Navigator, drag <b>MeridianBridge</b> onto any chart.${origin.endsWith(':3000') ? '' : ` Set its <b>Floor bridge URL</b> input to <code>${origin}/api/bridge/sync</code>.`} On the <b>Inputs</b> tab, paste this bridge token: ${token} On the Common tab, tick <b>Allow Algo Trading</b>.</li>
          <li>Switch on the <b>Algo Trading</b> button in the MT5 toolbar. This page detects the account within a second.</li>
        </ol>
        <p class="fine">Keep MT5 open and your Mac awake while the desks trade. No MT5 at hand? Run <code>npm run mock-mt5</code> to try the whole flow with a pretend account.</p>`;
      if (!acc) {
        conn.innerHTML = `
          <h2>Connect your FTMO MetaTrader 5 account</h2>
          <p class="sub">About 5 minutes, once. Do it with your Free Trial first.</p>${install}`;
      } else if (!connected) {
        conn.innerHTML = `
          <h2>Reconnect MetaTrader 5</h2>
          <p class="sub">Account ${escapeHtml(String(acc.login))} was connected${v.lastSync ? ` until ${new Date(v.lastSync).toLocaleTimeString()}` : ''} and stopped talking to the floor. Check these in MT5, in order. This page reconnects by itself within a second of MT5 syncing again.</p>
          <ol class="steps">
            <li>MT5 is open and logged in: the bottom-right corner of MT5 shows a connection, not "No connection".</li>
            <li>The <b>MeridianBridge</b> EA is on a chart, with a blue hat (or smiley) in the chart's top-right corner. If it isn't there, drag it from <b>Navigator → Expert Advisors</b> onto a chart.</li>
            <li>Read the EA's message at the top-left of that chart: it says what's wrong, e.g. "WebRequest is blocked" or "Floor refused the sync".</li>
            <li>The <b>Algo Trading</b> button in the MT5 toolbar is on (green).</li>
            <li>Just updated the EA? In MetaEditor, <b>Compile</b> must finish with <b>0 errors</b> (bottom panel, "Errors" tab). If it shows errors, send a screenshot of them.</li>
            <li>If you removed and re-added the EA, paste the bridge token into its <b>Inputs</b> again (right-click the chart → Expert list → MeridianBridge → Properties): ${token}</li>
          </ol>
          <p class="fine">Still stuck? Run <code>npm run doctor</code> in a second Terminal window: it checks every connection and says what to fix.</p>
          <details class="tv-more"><summary>Full install steps</summary>${install}</details>`;
      } else {
        conn.innerHTML = `
          <div class="plan-head"><div><h2>MT5 bridge setup</h2><p class="sub">MT5 is connected. The steps and your bridge token, for re-installing the EA or moving it to another chart.</p></div><button class="btn" data-act="hide-connect">Hide</button></div>${install}`;
      }
    }

    // Setup form: when there is no profile yet or the boss is editing.
    const showForm = acc && (!p || this.editing);
    $('#live-setup').hidden = !showForm;
    if (showForm && (force || this.formLogin !== acc.login)) {
      this.formLogin = acc.login;
      const cur = p || { type: 'trial', size: acc.initialDeposit || acc.balance, ...v.types.trial, ...v.defaults };
      const map = p?.symbolMap || v.suggestedMap;
      const programOpts = `<option value="" ${cur.program ? '' : 'selected'}>Not sure yet (the stricter 1-Step limits apply)</option>${Object.entries(v.programs || {}).map(([k, t]) => `<option value="${k}" ${k === cur.program ? 'selected' : ''}>${escapeHtml(t.label)}</option>`).join('')}`;
      const typeOpts = Object.entries(v.types).map(([k, t]) => `<option value="${k}" ${k === cur.type ? 'selected' : ''}>${escapeHtml(t.label)}</option>`).join('');
      const mapRows = Object.keys(v.suggestedMap).map((id) => {
        const opts = [...new Set([...(v.candidates[id] || []), ...(map[id] ? [map[id]] : [])])];
        return `<label><span>${id}</span><select data-map="${id}"><option value="">Not traded</option>${opts.map((o) => `<option ${o === map[id] ? 'selected' : ''}>${escapeHtml(o)}</option>`).join('')}</select></label>`;
      }).join('');
      $('#live-setup').innerHTML = `
        <h2>${p ? 'Edit account setup' : `Set up account ${escapeHtml(String(acc.login))}`}</h2>
        <p class="sub">Is this a Free Trial or a Challenge, 2-Step or 1-Step? The FTMO limits below are pre-filled with FTMO's standard values for the program you pick. <b>Check them against your account in the FTMO Client Area</b> and change them if yours differ.</p>
        <div class="form-grid">
          <label>FTMO program<select id="lv-program">${programOpts}</select><span class="hint">MetriX shows it: max daily loss 5% = 2-Step, 3% = 1-Step</span></label>
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

    $('#live-desks-sub').textContent = v.plan?.training
      ? 'Training on FTMO is on: every trade a switched-on desk takes goes to your FTMO account, sized by its committee grade (A full, B smaller, C smallest), so the desks learn on FTMO itself. Kenji\'s pairs trades and Isabella\'s market making can\'t be copied onto one account, so those two stay paper. Your TradingView alerts go through Chen\'s desk, or any desk named in the alert.'
      : 'Switch on the desks that may trade FTMO. Everyone keeps paper trading either way. Switched on isn\'t the same as trading the account: a desk\'s own trades only go to MT5 once the account brain has cleared it (10+ trades on real prices with a positive edge, and A-grade trades). "Status on the account" shows where each desk stands. Your own TradingView alerts go to the account through Chen\'s TradingView Signals desk, or any desk named in the alert, straight away. The committee can still veto them, and every risk rule applies.';

    // Desks still proving themselves: their trades stay on paper (say so, offer the switch).
    const provingHtml = provingNote(v);
    const pv = $('#live-proving');
    if (pv.dataset.html !== provingHtml) {
      pv.dataset.html = provingHtml;
      pv.innerHTML = provingHtml;
      pv.hidden = !provingHtml;
    }

    // Desks
    const desksTable = $('#live-desks');
    if (!desksTable.contains(document.activeElement) || force) {
      desksTable.innerHTML = `<thead><tr><th>Desk</th><th>Market → MT5</th><th>Trade FTMO</th><th>Status on the account</th><th>Live position</th><th class="r">Live P&amp;L today</th></tr></thead><tbody>${
        v.desks.map((d) => {
          const prof = this.store.profileById[d.id];
          return `<tr>
            <td><span class="desk-cell"><i style="background:${prof?.accent ?? '#888'}"></i><span>${escapeHtml(d.name)}<small>${escapeHtml(d.desk)}</small></span></span></td>
            <td>${escapeHtml(d.symbols[0])} → ${d.brokerSymbol ? `<b>${escapeHtml(d.brokerSymbol)}</b>` : '<span class="muted">not mapped</span>'}${d.id === 'chen' ? '<br><span class="muted">+ your TradingView alerts</span>' : ''}${prof?.lab ? '<br><span class="muted">market follows its research · half size while on probation</span>' : ''}${prof?.scalper ? `<br><span class="muted">scalps ${prof.scalp?.killzone === 'newyork' ? '08:00–11:00 New York' : '07:00–10:00 London'} · tight stops</span>` : ''}</td>
            <td>${d.eligible ? `<label class="switch" title="${d.enabled ? 'Trading FTMO' : 'Paper only'}"><input type="checkbox" data-desk="${d.id}" ${d.enabled ? 'checked' : ''} ${p ? '' : 'disabled'} aria-label="${escapeHtml(d.name)} trades FTMO"><span></span></label>` : `<span class="muted" title="${escapeHtml(d.reason)}">Paper only ⓘ</span>`}</td>
            <td class="ftmo-status">${d.enabled && d.eligible ? ftmoStatus(d, { detail: true }) : '<span class="muted">—</span>'}</td>
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
      v.positions.map((x) => `<tr><td>${x.ticket}</td><td>${x.agentId ? escapeHtml(this.store.profileById[x.agentId]?.name.split(' ')[0] ?? x.agentId) : '<span class="muted">manual</span>'}</td><td>${escapeHtml(x.symbol)}</td><td>${x.side}</td><td class="r">${x.volume}</td><td class="r">${x.open}</td><td class="r">${x.sl || '—'}</td><td class="r">${x.tp || '—'}</td><td class="r ${signClass(x.profit)}">${money(x.profit, { sign: true })}</td><td>${x.chart ? `<button class="mini-btn" data-chart="${escapeHtml(x.chart)}" data-title="${escapeHtml(`${x.side} ${x.volume} ${x.symbol}`)}">📈 Setup</button> ` : ''}${x.floor ? `<button class="mini-btn" data-act="close" data-ticket="${x.ticket}">Close</button>` : ''}</td></tr>`).join('') ||
      '<tr><td colspan="10" class="muted">No open positions on the account.</td></tr>'
    }</tbody>`;

    $('#live-log').innerHTML = v.events.map((e) => `<li class="k-${e.kind}"><time>${new Date(e.time).toLocaleTimeString()}</time>${escapeHtml(e.text)}</li>`).join('') || '<li class="muted">Nothing yet.</li>';
  }
}
