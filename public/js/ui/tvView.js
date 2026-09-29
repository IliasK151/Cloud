import { api } from '../net.js';
import { escapeHtml } from '../format.js';

// TradingView integration: webhook setup, alert message builder, Pine script, test alerts.
export class TradingViewView {
  constructor(store, root) {
    this.store = store;
    this.root = root;
    this.info = null;
    this.built = false;
  }

  async show() {
    this.root.hidden = false;
    try {
      this.info = await api('/api/tradingview/config');
    } catch {
      this.root.innerHTML = '<p class="lede">Could not load the TradingView settings from the local server.</p>';
      return;
    }
    if (!this.built) this.#build();
    this.#renderAlerts();
  }

  hide() {
    this.root.hidden = true;
  }

  #build() {
    const i = this.info;
    const agents = i.agents.map((a) => `<option value="${a.id}">${escapeHtml(a.name)} — ${escapeHtml(a.desk)} (${a.symbol})</option>`).join('');
    const symbols = i.symbols.map((s) => `<option value="${s.id}">${s.id}</option>`).join('');
    this.root.innerHTML = `
      <h1>TradingView connection</h1>
      <p class="lede">Your TradingView alerts become orders for the desks. Each desk also has a live TradingView chart in its panel. Alerts trade on paper with house risk sizing, and also on your FTMO account if that desk is enabled and armed in the FTMO tab.</p>
      <div class="grid tv-grid">
        <div class="card">
          <h2>1 · Connect TradingView to the floor</h2>
          <p class="sub">TradingView sends webhooks from the internet, so it needs a public HTTPS address for your Mac. A free tunnel provides one and exposes only the webhook port, never the dashboard.</p>
          <ol class="steps">
            <li>Install a tunnel once: <code>brew install cloudflared</code></li>
            <li>Run it against the webhook-only port:<div class="code-block" id="tv-tunnel">cloudflared tunnel --url http://localhost:${i.webhookPort}</div>It prints an address like <code>https://something.trycloudflare.com</code>.</li>
            <li>In TradingView create an alert → <b>Notifications</b> → enable <b>Webhook URL</b> and paste<div class="code-block">https://&lt;your-tunnel&gt;.trycloudflare.com/webhook</div></li>
            <li>Paste an alert message from step 2 into the alert's <b>Message</b> box.</li>
            <li>Alerts appear in the log below and on the floor. The desk speaks up when it executes one.</li>
          </ol>
          <div class="field"><label>Webhook secret</label><span class="code" id="tv-secret">••••••••••••</span><button class="mini-btn" id="tv-reveal">Show</button><button class="mini-btn" data-copy="secret">Copy</button></div>
          <div class="field"><label>Local test URL</label><span class="code">${escapeHtml(i.localUrl)}</span></div>
          <p class="fine">TradingView webhooks require a paid TradingView plan with webhook alerts enabled. The secret lives in <code>data/webhook-secret.txt</code>, or set <code>WEBHOOK_SECRET</code> in <code>.env</code>. Alerts with a wrong secret are rejected.</p>
        </div>
        <div class="card">
          <h2>2 · Alert message</h2>
          <p class="sub">Choose the desk that should trade the alert. With no <code>agent</code> field, alerts go to the TradingView Signals desk (Chen).</p>
          <div class="test-row">
            <select id="tv-agent">${agents}</select>
            <select id="tv-kind">
              <option value="buy">Indicator alert: BUY</option>
              <option value="sell">Indicator alert: SELL</option>
              <option value="close">Indicator alert: CLOSE</option>
              <option value="strategy">Strategy alert (auto buy/sell/flat)</option>
            </select>
          </div>
          <div class="code-block" id="tv-message"></div>
          <button class="btn" data-copy="message">Copy message</button>
          <p class="fine">Optional fields: <code>stop</code>, <code>target</code> (prices) and <code>comment</code>. Without a stop the desk uses 1.5× ATR, and without a target it uses 2R. <code>{{ticker}}</code> is mapped to the floor's instruments, e.g. OANDA:XAUUSD → XAUUSD and BINANCE:BTCUSDT → BTCUSD.</p>
        </div>
        <div class="card">
          <h2>3 · Pine Script bridge (optional)</h2>
          <p class="sub">A ready-made TradingView indicator (Supertrend flips) that sends properly formatted alerts with stop and target levels.</p>
          <ol class="steps">
            <li>Open TradingView → Pine Editor → paste the script → <b>Add to chart</b>.</li>
            <li>In the indicator settings, enter your webhook secret and pick the desk.</li>
            <li>Create an alert on the indicator with the condition <b>Any alert() function call</b>, then add the webhook URL.</li>
          </ol>
          <div class="test-row">
            <a class="btn" href="/tradingview/institutional_agents_alerts.pine" download>Download .pine</a>
            <button class="btn" id="tv-copy-pine">Copy script</button>
          </div>
        </div>
        <div class="card">
          <h2>4 · Send a test alert</h2>
          <p class="sub">Fires a signed alert through the same pipeline TradingView uses.</p>
          <div class="test-row">
            <select id="tv-test-agent">${agents}</select>
            <select id="tv-test-action"><option value="buy">BUY</option><option value="sell">SELL</option><option value="close">CLOSE</option></select>
            <select id="tv-test-symbol"><option value="">Desk's market</option>${symbols}</select>
            <button class="btn primary" id="tv-test">Send test alert</button>
          </div>
          <p class="fine" id="tv-test-result"></p>
        </div>
      </div>
      <div class="grid tv-grid" style="margin-top:14px">
        <div class="card">
          <h2>Received alerts</h2>
          <p class="sub">Newest first</p>
          <div class="table-wrap"><table class="table compact" id="tv-alerts"></table></div>
        </div>
        <div class="card">
          <h2>Symbol mapping</h2>
          <p class="sub">Floor instrument → TradingView chart symbol · accepted alert tickers</p>
          <div class="table-wrap"><table class="table compact">
            <thead><tr><th>Instrument</th><th>TradingView</th><th>Alert tickers</th></tr></thead>
            <tbody>${i.symbols.map((s) => `<tr><td><b>${s.id}</b></td><td>${escapeHtml(s.tv)}</td><td class="muted" style="white-space:normal">${escapeHtml(s.aliases.join(', '))}</td></tr>`).join('')}</tbody>
          </table></div>
        </div>
      </div>`;

    const $ = (id) => this.root.querySelector(id);
    let revealed = false;
    $('#tv-reveal').addEventListener('click', () => {
      revealed = !revealed;
      $('#tv-secret').textContent = revealed ? i.secret : '••••••••••••';
      $('#tv-reveal').textContent = revealed ? 'Hide' : 'Show';
    });
    const renderMessage = () => {
      const agent = $('#tv-agent').value;
      const kind = $('#tv-kind').value;
      const msg = kind === 'strategy'
        ? `{"secret":"${i.secret}","agent":"${agent}","symbol":"{{ticker}}","action":"{{strategy.order.action}}","position":"{{strategy.market_position}}","price":{{close}},"comment":"{{strategy.order.comment}}"}`
        : `{"secret":"${i.secret}","agent":"${agent}","symbol":"{{ticker}}","action":"${kind}","price":{{close}},"comment":"{{interval}}m alert"}`;
      $('#tv-message').textContent = msg;
    };
    $('#tv-agent').addEventListener('change', renderMessage);
    $('#tv-kind').addEventListener('change', renderMessage);
    renderMessage();

    this.root.querySelectorAll('[data-copy]').forEach((b) => b.addEventListener('click', () => {
      const text = b.dataset.copy === 'secret' ? i.secret : $('#tv-message').textContent;
      copy(text, b);
    }));
    $('#tv-copy-pine').addEventListener('click', async (e) => {
      const res = await fetch('/tradingview/institutional_agents_alerts.pine');
      copy(await res.text(), e.currentTarget);
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
    this.store.on('alert', () => this.#renderAlerts());
    this.built = true;
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
