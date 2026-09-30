import { api } from '../net.js';
import { escapeHtml } from '../format.js';

// TradingView: a guided setup that gives the floor a public webhook address with one click,
// proves TradingView can reach it, and writes the alert message for you. Plus a Pine script,
// a local test button, the received-alerts log and the ticker mapping.
export class TradingViewView {
  constructor(store, root) {
    this.store = store;
    this.root = root;
    this.info = null;
    this.built = false;
    this.visible = false;
    this.busy = null;
    this.error = null;
    store.on('tunnel', () => this.visible && this.#renderTunnel());
    store.on('alert', () => this.visible && this.#renderAlerts());
    store.on('firewall', (msg) => {
      if (!this.info) return;
      this.info.firewall = msg.firewall;
      this.info.guard = msg.guard;
      if (this.visible) this.#renderFirewall();
    });
  }

  async show() {
    this.root.hidden = false;
    this.visible = true;
    try {
      this.info = await api('/api/tradingview/config');
    } catch {
      this.root.innerHTML = '<p class="lede">Could not load the TradingView settings from the local server.</p>';
      return;
    }
    if (this.info.tunnel) this.store.tunnel = this.info.tunnel;
    if (!this.built) this.#build();
    this.#renderTunnel();
    this.#renderAlerts();
    this.#renderFirewall();
  }

  hide() {
    this.root.hidden = true;
    this.visible = false;
  }

  get tunnel() {
    return this.store.tunnel || this.info?.tunnel || { status: 'off', check: {} };
  }

  #build() {
    const i = this.info;
    const agents = i.agents.map((a) => `<option value="${a.id}" ${a.id === 'chen' ? 'selected' : ''}>${escapeHtml(a.name)} — ${escapeHtml(a.desk)} (${a.symbol})</option>`).join('');
    const symbols = i.symbols.map((s) => `<option value="${s.id}">${s.id}</option>`).join('');
    this.root.innerHTML = `
      <h1>TradingView</h1>
      <p class="lede">Your TradingView alerts become orders for the desks: on paper, and on your FTMO account too for desks you've switched on and armed. Charts are already built in: every trader's panel has a live TradingView chart.</p>
      <div id="tv-banner"></div>
      <div class="card steps-card" id="tv-steps"></div>
      <div class="grid tv-grid">
        <div class="card" id="tv-address">
          <h2>1 · Public address</h2>
          <p class="sub">TradingView sends alerts from its servers on the internet, so the floor needs a public web address. One click opens a secure tunnel that only lets alerts in. The dashboard and its controls stay private on your Mac.</p>
          <div id="tv-tunnel"></div>
          <details class="tv-more" id="tv-ngrok">
            <summary>Want an address that never changes? Use a free ngrok account</summary>
            <p class="fine">The free Cloudflare address changes each time the floor starts, so you'd have to edit your TradingView alerts after every restart. A free ngrok account gives you one permanent address instead:</p>
            <ol class="steps">
              <li>Sign up for free at <a href="https://dashboard.ngrok.com/signup" target="_blank" rel="noopener">ngrok.com</a>.</li>
              <li>Copy your <b>authtoken</b> from <a href="https://dashboard.ngrok.com/get-started/your-authtoken" target="_blank" rel="noopener">Your Authtoken</a>.</li>
              <li>Copy your free <b>static domain</b> from <a href="https://dashboard.ngrok.com/domains" target="_blank" rel="noopener">Domains</a> (it looks like <code>something.ngrok-free.app</code>).</li>
            </ol>
            <div class="form-grid">
              <label>Authtoken<input type="password" id="tv-ngrok-token" autocomplete="off" placeholder="Paste your ngrok authtoken"></label>
              <label>Static domain<input type="text" id="tv-ngrok-domain" autocomplete="off" placeholder="something.ngrok-free.app"></label>
            </div>
            <div class="btn-row" style="margin-top:10px"><button class="btn primary" data-act="ngrok">Use ngrok</button></div>
          </details>
        </div>
        <div class="card" id="tv-alert-card">
          <h2>2 · Create the alert in TradingView</h2>
          <p class="sub">Webhook alerts need a paid TradingView plan (Essential or higher), and TradingView asks you to turn on two-factor authentication before it will send them.</p>
          <ol class="steps">
            <li>Open the chart in TradingView and create an alert (the clock icon, or <b>Alt+A</b> / <b>⌥A</b>). Pick the condition: your indicator, your strategy, or a price level.</li>
            <li>In the alert's <b>Message</b> box, paste this message:
              <div class="test-row">
                <select id="tv-agent" aria-label="Desk that trades the alert">${agents}</select>
                <select id="tv-kind" aria-label="Alert type">
                  <option value="buy">Buy</option>
                  <option value="sell">Sell</option>
                  <option value="close">Close the position</option>
                  <option value="strategy">From a strategy (buys, sells and exits automatically)</option>
                </select>
              </div>
              <div class="code-block" id="tv-message"></div>
              <button class="mini-btn" data-copy="message">Copy message</button></li>
            <li>Under <b>Notifications</b>, tick <b>Webhook URL</b> and paste your address:
              <div class="field"><span class="code" id="tv-url-2">Create the public address first (step 1)</span><button class="mini-btn" data-copy="url">Copy</button></div></li>
            <li>Press <b>Create</b>. When the alert fires, the desk trades it and tells you on the floor.</li>
          </ol>
          <p class="fine">The desk sizes the trade with its risk rules. Add <code>"stop"</code> and <code>"target"</code> prices to the message to set them yourself; otherwise it uses a 1.5× ATR stop and a 2R target. TradingView tickers are mapped for you, e.g. OANDA:XAUUSD → XAUUSD and BINANCE:BTCUSDT → BTCUSD.</p>
        </div>
        <div class="card">
          <h2>No indicator of your own? Use ours</h2>
          <p class="sub">A ready-made indicator that sends Supertrend flips as buy and sell alerts, with stop and target prices included.</p>
          <ol class="steps">
            <li>In TradingView open <b>Pine Editor</b>, paste the script and press <b>Add to chart</b>.</li>
            <li>In the indicator's settings, paste your webhook secret <button class="mini-btn" data-copy="secret">Copy secret</button> and pick the desk.</li>
            <li>Create an alert with the condition <b>Meridian Floor — Agent Alert Bridge</b> → <b>Any alert() function call</b>, and add your webhook address under Notifications. The message box can stay empty.</li>
          </ol>
          <div class="btn-row">
            <button class="btn" id="tv-copy-pine">Copy script</button>
            <a class="btn" href="/tradingview/institutional_agents_alerts.pine" download>Download .pine</a>
          </div>
        </div>
        <div class="card">
          <h2>Try it without TradingView</h2>
          <p class="sub">Sends an alert through the same pipeline TradingView uses, straight from this page. Test alerts trade on paper only, never on your FTMO account.</p>
          <div class="test-row">
            <select id="tv-test-agent">${agents}</select>
            <select id="tv-test-action"><option value="buy">Buy</option><option value="sell">Sell</option><option value="close">Close</option></select>
            <select id="tv-test-symbol"><option value="">Desk's market</option>${symbols}</select>
            <button class="btn primary" id="tv-test">Send test alert</button>
          </div>
          <p class="fine" id="tv-test-result"></p>
        </div>
      </div>
      <div class="card fw-card" id="tv-firewall" style="margin-top:14px"></div>
      <div class="grid tv-grid" style="margin-top:14px">
        <div class="card">
          <h2>Received alerts</h2>
          <p class="sub">Newest first</p>
          <div class="table-wrap"><table class="table compact" id="tv-alerts"></table></div>
        </div>
        <div class="card">
          <h2>Tickers</h2>
          <p class="sub">Floor market → TradingView chart · tickers accepted in alerts</p>
          <div class="table-wrap"><table class="table compact">
            <thead><tr><th>Market</th><th>TradingView</th><th>Alert tickers</th></tr></thead>
            <tbody>${i.symbols.map((s) => `<tr><td><b>${s.id}</b></td><td>${escapeHtml(s.tv)}</td><td class="muted" style="white-space:normal">${escapeHtml(s.aliases.join(', '))}</td></tr>`).join('')}</tbody>
          </table></div>
          <details class="tv-more">
            <summary>Prefer to run your own tunnel?</summary>
            <p class="fine">Point any HTTPS tunnel at the webhook-only port <code>http://localhost:${i.webhookPort}</code> and use <code>https://&lt;your-address&gt;/webhook</code> as the Webhook URL. Your secret is in <code>data/webhook-secret.txt</code>, or set <code>WEBHOOK_SECRET</code> in <code>.env</code>.</p>
          </details>
        </div>
      </div>`;

    const $ = (id) => this.root.querySelector(id);
    const renderMessage = () => {
      const agent = $('#tv-agent').value;
      const kind = $('#tv-kind').value;
      const secret = this.info.secret;
      const msg = kind === 'strategy'
        ? `{"secret":"${secret}","agent":"${agent}","symbol":"{{ticker}}","action":"{{strategy.order.action}}","position":"{{strategy.market_position}}","price":{{close}},"comment":"{{strategy.order.comment}}"}`
        : `{"secret":"${secret}","agent":"${agent}","symbol":"{{ticker}}","action":"${kind}","price":{{close}},"comment":"{{interval}} alert"}`;
      $('#tv-message').textContent = msg;
    };
    $('#tv-agent').addEventListener('change', renderMessage);
    $('#tv-kind').addEventListener('change', renderMessage);
    renderMessage();
    this.renderMessage = renderMessage;

    this.root.addEventListener('click', (e) => this.#onClick(e));
    this.root.addEventListener('change', (e) => {
      if (e.target.id === 'fw-tvonly') this.#firewall({ tradingViewOnly: e.target.checked }, e.target);
    });
    $('#tv-copy-pine').addEventListener('click', async (e) => {
      const btn = e.currentTarget;
      const res = await fetch('/tradingview/institutional_agents_alerts.pine');
      copy(await res.text(), btn);
    });
    $('#tv-test').addEventListener('click', async () => {
      const out = $('#tv-test-result');
      out.textContent = 'Sending…';
      try {
        const res = await api('/api/tradingview/test', {
          method: 'POST',
          body: JSON.stringify({ agent: $('#tv-test-agent').value, action: $('#tv-test-action').value, symbol: $('#tv-test-symbol').value || undefined }),
        });
        out.innerHTML = `<span class="pill ${res.ok ? 'ok' : 'no'}">${res.ok ? 'EXECUTED' : 'REJECTED'}</span> ${escapeHtml(res.result || '')}`;
      } catch (err) {
        out.textContent = `Failed: ${err.message}`;
      }
    });
    const d = this.tunnel.ngrok;
    if (d?.domain) $('#tv-ngrok-domain').value = d.domain;
    if (d?.hasToken) $('#tv-ngrok-token').placeholder = 'Saved (paste a new one to replace it)';
    if (this.tunnel.provider === 'ngrok') $('#tv-ngrok').open = true;
    this.built = true;
  }

  async #post(action, body = {}) {
    this.busy = action;
    this.error = null;
    this.#renderTunnel();
    try {
      const res = await api(`/api/tradingview/tunnel/${action}`, { method: 'POST', body: JSON.stringify(body) });
      if (res.tunnel) this.store.setTunnel(res.tunnel);
      if (!res.ok) this.error = res.error;
    } catch (err) {
      this.error = `Could not reach the floor: ${err.message}`;
    }
    this.busy = null;
    this.#renderTunnel();
  }

  async #onClick(e) {
    const btn = e.target.closest('[data-act], [data-copy]');
    if (!btn) return;
    if (btn.dataset.copy) {
      const t = this.tunnel;
      const text = btn.dataset.copy === 'secret' ? this.info.secret : btn.dataset.copy === 'url' ? t.webhookUrl : this.root.querySelector('#tv-message').textContent;
      if (!text) return;
      copy(text, btn);
      return;
    }
    const act = btn.dataset.act;
    if (act === 'start') await this.#post('start', { provider: 'cloudflare' });
    else if (act === 'restart') await this.#post('start', { provider: this.tunnel.provider || 'cloudflare' });
    else if (act === 'stop') await this.#post('stop');
    else if (act === 'check') await this.#post('check');
    else if (act === 'ack') await this.#post('ack');
    else if (act === 'ngrok') {
      const token = this.root.querySelector('#tv-ngrok-token').value.trim();
      const domain = this.root.querySelector('#tv-ngrok-domain').value.trim();
      await this.#post('start', { provider: 'ngrok', authtoken: token || undefined, domain });
    } else if (act === 'rotate') {
      await this.#rotate();
    } else if (act === 'unban') {
      await this.#firewall({ unban: btn.dataset.ip });
    } else if (act === 'goto') {
      const el = this.root.querySelector(`#${btn.dataset.target}`);
      if (el?.tagName === 'DETAILS') el.open = true;
      el?.scrollIntoView({ block: 'start', behavior: 'smooth' });
    }
  }

  #renderTunnel() {
    const t = this.tunnel;
    const $ = (id) => this.root.querySelector(id);
    if (!$('#tv-tunnel')) return;
    const running = t.status === 'running';
    const via = t.provider === 'ngrok' ? 'ngrok (permanent address)' : 'Cloudflare (free, changes when the floor restarts)';
    let status;
    if (this.busy === 'start' && t.status !== 'installing') status = '<span class="dot warn"></span>Starting…';
    else if (t.status === 'installing') status = `<span class="dot warn"></span>Downloading Cloudflare's tunnel app (one time only)… ${Math.round((t.progress || 0) * 100)}%`;
    else if (t.status === 'starting') status = '<span class="dot warn"></span>Opening the tunnel…';
    else if (running) status = `<span class="dot ok"></span>Live through ${via}`;
    else if (t.status === 'error') status = '<span class="dot bad"></span>Not running';
    else status = '<span class="dot"></span>Off';
    const check = t.check || {};
    const checkLine = !running
      ? ''
      : check.status === 'ok'
        ? `<p class="tv-check ok">✓ TradingView can reach your floor. Checked ${new Date(check.at).toLocaleTimeString()}.</p>`
        : check.status === 'checking' || this.busy === 'check'
          ? '<p class="tv-check">Checking that the address works from the internet… (new addresses can take up to half a minute)</p>'
          : check.status === 'failed'
            ? `<p class="tv-check bad">✗ The address didn't answer from the internet (${escapeHtml(check.error || 'no reply')}). New addresses sometimes need a minute. Press Test again; if it keeps failing, turn it off and on.</p>`
            : '';
    const err = this.error || (t.status === 'error' ? t.error : null);
    $('#tv-tunnel').innerHTML = `
      <div class="status-rows">
        <div><span>Status</span><b>${status}</b></div>
        <div><span>Webhook URL</span><b class="tv-url">${running ? `<span class="code">${escapeHtml(t.webhookUrl)}</span> <button class="mini-btn" data-copy="url">Copy</button>` : '<span class="muted">—</span>'}</b></div>
      </div>
      ${err ? `<div class="banner crit">▲ ${escapeHtml(err)}</div>` : ''}
      ${checkLine}
      <div class="btn-row">
        ${running
          ? `<button class="btn" data-act="check" ${this.busy ? 'disabled' : ''}>Test connection</button><button class="btn" data-act="stop" ${this.busy ? 'disabled' : ''}>Turn off</button>`
          : t.status === 'installing' || t.status === 'starting'
            ? '<button class="btn" data-act="stop">Cancel</button>'
            : `<button class="btn primary" data-act="${t.provider === 'ngrok' && t.ngrok?.hasToken ? 'restart' : 'start'}" ${this.busy ? 'disabled' : ''}>${t.status === 'error' ? 'Try again' : 'Create public address'}</button>`}
      </div>
      <p class="fine">${running ? 'The address stays on while the floor runs and comes back automatically the next time you start it.' : 'Free, no account needed. The first time, the floor downloads Cloudflare\'s small tunnel app (about 20–40 MB) from Cloudflare\'s official releases.'}</p>`;
    $('#tv-url-2').textContent = t.webhookUrl || 'Create the public address first (step 1)';
    this.#renderSteps();
    $('#tv-banner').innerHTML = t.urlChanged && running
      ? `<div class="banner crit">▲ <span>Your webhook address changed when the floor restarted. Update the <b>Webhook URL</b> in your TradingView alerts to <code>${escapeHtml(t.webhookUrl)}</code> <button class="mini-btn" data-copy="url">Copy</button> <button class="mini-btn" data-act="ack">Done</button> <button class="mini-btn" data-act="goto" data-target="tv-ngrok">Get a permanent address</button></span></div>`
      : '';
  }

  #renderSteps() {
    const t = this.tunnel;
    const running = t.status === 'running';
    const reached = running && t.check?.status === 'ok';
    // An alert only counts if it came through the current address (quick tunnels change).
    const alerted = !!t.lastAlertAt && (!t.lastAlertUrl || t.lastAlertUrl === t.url);
    const moved = !!t.lastAlertAt && !alerted;
    const steps = [
      { t: 'Public address', d: 'One click, free', done: running },
      { t: 'Connection test', d: 'TradingView can reach you', done: reached || (running && alerted) },
      { t: moved ? 'Update your alerts' : 'Alert in TradingView', d: moved ? 'New address: paste it into your alerts' : 'Paste the URL and message', done: alerted && running },
    ];
    const now = steps.findIndex((x) => !x.done);
    const la = t.lastAlert;
    const next = [
      { text: 'Give the floor a public address so TradingView can reach it.', btn: '<button class="btn primary" data-act="start">Create public address</button>' },
      { text: 'Checking that the address works from the internet.', btn: '<button class="btn" data-act="check">Test connection</button>' },
      moved
        ? { text: 'The public address changed, so paste the new Webhook URL into your TradingView alerts. This ticks itself off when the next alert arrives.', btn: '<button class="btn primary" data-copy="url">Copy new address</button>' }
        : { text: 'Create an alert in TradingView with the address and message from step 2. This ticks itself off when the first alert arrives.', btn: '<button class="btn primary" data-act="goto" data-target="tv-alert-card">Show me how</button>' },
    ][now] || { text: `All set. Last alert: ${la ? `${la.action.toUpperCase()} ${la.symbol || ''}${la.agent ? ` for ${this.store.profileById[la.agent]?.name.split(' ')[0] ?? la.agent}` : ''}` : ''} at ${new Date(t.lastAlertAt).toLocaleString()}.`, btn: '' };
    const busy = t.status === 'installing' || t.status === 'starting' || !!this.busy;
    this.root.querySelector('#tv-steps').innerHTML = `
      <h2>${now < 0 ? 'TradingView is connected' : 'Setup'}</h2>
      <ol class="stepper three">${steps.map((x, k) => `<li class="${x.done ? 'done' : k === now ? 'now' : ''}"><b><span class="n">${x.done ? '✓' : k + 1}</span>${x.t}</b>${x.d}</li>`).join('')}</ol>
      <div class="next-step"><span>${escapeHtml(next.text)}</span>${busy && now < 2 ? '' : next.btn}</div>`;
  }

  async #firewall(body, input = null) {
    if (body.tradingViewOnly === false && !confirm('Accept trade alerts from any internet address that knows your secret?\n\nOnly do this if your alerts come from somewhere other than TradingView. With it on, a leaked secret can\'t be used to trade and the floor raises an alarm instead.')) {
      if (input) input.checked = true;
      return;
    }
    try {
      const res = await api('/api/tradingview/firewall', { method: 'POST', body: JSON.stringify(body) });
      if (res.firewall) this.info.firewall = res.firewall;
    } catch (err) {
      if (input) input.checked = !input.checked;
      alert(`Could not reach the floor: ${err.message}`);
    }
    this.#renderFirewall();
  }

  async #rotate() {
    if (!confirm('Make a new webhook secret?\n\nThe old secret stops working immediately. You then paste the new alert message (step 2) into each of your TradingView alerts, and the new secret into our Pine indicator if you use it.')) return;
    try {
      const res = await api('/api/tradingview/rotate-secret', { method: 'POST' });
      if (!res.ok) return alert(res.error || 'Could not rotate the secret');
      this.info = res;
      this.renderMessage?.();
      this.#renderFirewall();
      alert('New secret made. Now update the message in your TradingView alerts (step 2 → Copy message).');
    } catch (err) {
      alert(`Could not reach the floor: ${err.message}`);
    }
    return undefined;
  }

  // The firewall: what protects the floor, and what it has blocked.
  #renderFirewall() {
    const el = this.root.querySelector('#tv-firewall');
    const fw = this.info?.firewall;
    if (!el || !fw) return;
    const g = this.info.guard || { blocked: {} };
    const caps = this.store.live?.eaCaps;
    const acc = this.store.live?.account;
    const st = fw.status;
    const pill = st === 'alarm' ? ['no', 'ALARM'] : st === 'under-attack' ? ['no', 'UNDER ATTACK'] : st === 'watching' ? ['warn', 'WATCHING'] : ['ok', 'ALL QUIET'];
    const localBlocked = Object.values(g.blocked || {}).reduce((a, b) => a + b, 0);
    const time = (t) => new Date(t).toLocaleString([], { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' });
    const kinds = { 'bad-secret': 'Wrong secret', ban: 'Banned', leak: 'Secret used outside TradingView', rate: 'Too many requests', setting: 'Setting', rotate: 'Secret rotated' };
    const protections = [
      [true, g.lan ? 'Dashboard open on your Wi-Fi with a password; controls never reachable from the internet' : 'Dashboard and controls only on this Mac, never reachable from the internet'],
      [true, 'Every dashboard request carries a key that changes each launch, so other websites can\'t place trades, read your account or change settings'],
      [true, 'The internet reaches one thing only, the webhook: secret checked first, 5 wrong secrets from one address = banned for an hour, flood limits'],
      [fw.settings.tradingViewOnly, fw.settings.tradingViewOnly ? 'Trade alerts only from TradingView\'s own servers' : 'Trade alerts accepted from any address with the secret (TradingView-only is off)'],
      [!!caps, caps ? `MT5 EA safety caps: every order needs a stop-loss, at most ${caps.maxRiskPct}% risk per order and ${caps.maxPositions} floor positions, and it never touches your own trades` : acc ? 'Update the MeridianBridge EA to get its built-in safety caps (FTMO tab, step "Install the bridge")' : 'MT5 EA safety caps: every order needs a stop-loss and a capped risk, and your own trades are never touched'],
      [true, 'Your FTMO password never leaves MT5; secrets on disk are readable by your Mac user only'],
      [true, 'TradingView\'s chart runs isolated in its own sandbox, away from your account data'],
    ];
    el.innerHTML = `
      <div class="plan-head"><div><h2>Firewall</h2><p class="sub">Everything that protects the floor and your FTMO account, live.</p></div><span class="plan-status ${pill[0]}">${pill[1]}</span></div>
      ${fw.alarm ? `<div class="banner crit">⛔ <span><b>Security alarm:</b> ${escapeHtml(fw.alarm.text)} <button class="mini-btn" data-act="rotate">Rotate secret now</button></span></div>` : ''}
      ${st === 'under-attack' ? `<div class="banner crit">▲ <span>${fw.recentBad} blocked attempts on the webhook in the last hour. They're being refused and banned automatically. If you're worried, rotate the secret or turn the public address off.</span></div>` : ''}
      <div class="fw-grid">
        <div>
          <ul class="plan-rules">${protections.map(([ok, text]) => `<li class="${ok ? 'ok' : 'warn'}">${escapeHtml(text)}</li>`).join('')}</ul>
          <div class="plan-switch ${fw.settings.tradingViewOnly ? '' : 'off'}" style="margin-top:14px">
            <label class="switch safe"><input type="checkbox" id="fw-tvonly" ${fw.settings.tradingViewOnly ? 'checked' : ''} aria-label="Trade alerts only from TradingView"><span></span></label>
            <div><b>Trade alerts only from TradingView's servers: ${fw.settings.tradingViewOnly ? 'ON' : 'OFF'}</b><small>TradingView sends webhooks from ${fw.tradingViewIps.map(escapeHtml).join(', ')}. Connection tests work from anywhere. If TradingView ever adds a server and a real alert gets refused, the log below shows its address.</small></div>
          </div>
          <div class="btn-row" style="margin-top:12px">
            <button class="btn" data-act="rotate">Rotate webhook secret</button>
          </div>
          ${config(this.info)}
        </div>
        <div>
          <div class="mini-tiles fw-tiles">
            <div><span>Alerts let in</span><b class="num">${fw.stats.allowed}</b></div>
            <div><span>Blocked (internet)</span><b class="num ${fw.stats.blocked ? 'neg' : ''}">${fw.stats.blocked}</b></div>
            <div><span>Wrong secrets</span><b class="num">${fw.stats.badSecret}</b></div>
            <div><span>Blocked (other websites)</span><b class="num ${localBlocked ? 'neg' : ''}">${localBlocked}</b></div>
          </div>
          ${fw.bans.length ? `<h3>Banned now</h3><div class="fw-bans">${fw.bans.map((b) => `<span class="fw-ban"><code>${escapeHtml(b.ip)}</code> until ${new Date(b.until).toLocaleTimeString()} <button class="mini-btn" data-act="unban" data-ip="${escapeHtml(b.ip)}">Unban</button></span>`).join('')}</div>` : ''}
          <h3>Security log</h3>
          <div class="table-wrap" style="max-height:220px"><table class="table compact"><tbody>${
            fw.events.map((e) => `<tr><td class="muted">${time(e.time)}</td><td>${escapeHtml(kinds[e.kind] || e.kind)}</td><td style="white-space:normal">${escapeHtml(e.text)}</td></tr>`).join('') || '<tr><td class="muted">Nothing blocked yet.</td></tr>'
          }</tbody></table></div>
        </div>
      </div>`;
  }

  #renderAlerts() {
    const el = this.root.querySelector('#tv-alerts');
    if (!el) return;
    const s = this.store;
    el.innerHTML = `<thead><tr><th>Time</th><th>Desk</th><th>Alert</th><th>Result</th></tr></thead><tbody>${
      s.alerts.slice().reverse().slice(0, 30).map((a) => `<tr><td>${new Date(a.time).toLocaleTimeString()}</td><td>${escapeHtml(s.profileById[a.agentId]?.name ?? '—')}</td><td>${escapeHtml(a.action.toUpperCase())} ${escapeHtml(a.symbol || '')}${a.comment ? ` <span class="muted">${escapeHtml(a.comment)}</span>` : ''}</td><td><span class="pill ${a.ok ? 'ok' : 'no'}">${a.ok ? 'OK' : 'REJECTED'}</span> ${escapeHtml(a.result || '')}</td></tr>`).join('') ||
      '<tr><td colspan="4" class="muted">No alerts received yet.</td></tr>'
    }</tbody>`;
  }
}

function config(info) {
  return info.secretFromEnv ? '<p class="fine">Your secret is set in <code>.env</code> (WEBHOOK_SECRET): change it there to rotate it.</p>' : '';
}

async function copy(text, btn) {
  try {
    await navigator.clipboard.writeText(text);
    const old = btn.textContent;
    btn.textContent = 'Copied ✓';
    setTimeout(() => { btn.textContent = old; }, 1400);
  } catch {
    prompt('Copy this:', text);
  }
}
