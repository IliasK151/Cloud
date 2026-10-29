import { api } from '../net.js';
import { escapeHtml } from '../format.js';

// Claude, the floor's LLM brain, in the Brain tab (server/llm/brain.js).
//
// The node brain: Claude in the middle, what it reads around it (the top-down read, the
// liquidity, the news, the floor memory, the neural brain, its lesson book, its own record),
// and the desks on the outer ring. When a desk's setup arms, the setup flows from the desk
// through what Claude reads into Claude, it thinks, and its verdict flows back (green: take,
// grey: skip). When the trade closes, the result comes back (green: Claude was right, red:
// wrong) and the lessons it relied on flash. Next to it: its latest verdicts, its record,
// the lesson book it keeps, and a chat to ask it anything about the floor.
//
// Draws only while something moves.

const CLAUDE = '#d97757';
const GREEN = '#2fbf71';
const RED = '#e5534b';
const GREY = '#8b93a1';
const GOLD = '#ffd166';
const SOURCES = [
  ['td', 'Top-down'],
  ['liq', 'Liquidity'],
  ['news', 'News'],
  ['mem', 'Memory'],
  ['nn', 'Neural net'],
  ['book', 'Lessons'],
  ['rec', 'Record'],
];
const pct = (x) => (x == null ? '—' : `${Math.round(x * 100)}%`);
const fmtR = (x) => (x == null ? '—' : `${x >= 0 ? '+' : '−'}${Math.abs(x).toFixed(2)}R`);
const usd = (x) => `$${(x ?? 0).toFixed(x >= 10 ? 0 : 2)}`;
const ago = (t) => {
  const s = Math.round((Date.now() - t) / 1000);
  return s < 60 ? 'just now' : s < 3600 ? `${Math.round(s / 60)} min ago` : s < 86400 ? `${Math.round(s / 3600)} h ago` : `${Math.round(s / 86400)} d ago`;
};
const STATUS = {
  off: ['Not connected', GREY],
  ready: ['Ready', GREEN],
  budget: ['Budget spent for today', '#f2b01e'],
  error: ['Problem', RED],
};

export class LlmBrainPanel {
  constructor(store, root, { onSelect } = {}) {
    this.store = store;
    this.root = root;
    this.onSelect = onSelect;
    this.visible = false;
    this.built = false;
    this.pulses = [];
    this.glow = 0;
    this.thinking = 0;
    this.raf = null;
    this.flash = new Map(); // node id → { color, t0 }
    store.on('llm', () => this.visible && this.render());
    store.on('llm-event', (ev) => this.visible && this.#event(ev));
  }

  // ---- skeleton -------------------------------------------------------------------------------
  #build() {
    this.root.innerHTML = `
      <div class="llm-head">
        <div><h2>Claude <span class="llm-sub">LLM brain</span></h2>
        <p class="sub">Reads every setup before it fills, the way a senior trader would, and gives a calibrated verdict. It's scored on every result, keeps a lesson book it prunes by results, reflects after the close and answers your questions about the floor. Its say grows only with its record.</p></div>
        <div class="llm-status" id="llm-status"></div>
      </div>
      <div id="llm-connect"></div>
      <div class="llm-main" id="llm-main" hidden>
        <div class="llm-left">
          <canvas class="llm-canvas" id="llm-canvas" aria-label="Claude's node brain: what it reads and the desks it advises"></canvas>
          <div class="llm-record" id="llm-record"></div>
          <div class="llm-settings" id="llm-settings"></div>
        </div>
        <div class="llm-right">
          <div class="llm-tabs" role="tablist">
            <button role="tab" data-llm-tab="thoughts" aria-selected="true">Verdicts</button>
            <button role="tab" data-llm-tab="lessons" aria-selected="false">Lesson book</button>
            <button role="tab" data-llm-tab="chat" aria-selected="false">Ask Claude</button>
          </div>
          <div class="llm-pane" id="llm-thoughts"></div>
          <div class="llm-pane" id="llm-lessons" hidden></div>
          <div class="llm-pane" id="llm-chat" hidden>
            <div class="llm-msgs" id="llm-msgs"></div>
            <form class="llm-ask" id="llm-ask">
              <textarea id="llm-q" rows="2" placeholder="Ask anything about the floor: why didn't Marcus trade today? How is gold set up for London? What did we learn this week?"></textarea>
              <div class="llm-ask-row"><button class="btn primary" type="submit">Ask</button><button class="btn" type="button" data-llm="new-chat">New conversation</button><span class="fine" id="llm-busy"></span></div>
            </form>
          </div>
        </div>
      </div>`;
    this.canvas = this.root.querySelector('#llm-canvas');
    this.root.addEventListener('click', (e) => this.#click(e));
    this.root.addEventListener('change', (e) => this.#change(e));
    this.root.querySelector('#llm-ask').addEventListener('submit', (e) => {
      e.preventDefault();
      this.#ask();
    });
    this.root.querySelector('#llm-q').addEventListener('keydown', (e) => {
      if (e.key === 'Enter' && !e.shiftKey) {
        e.preventDefault();
        this.#ask();
      }
    });
    // Click a desk on the node brain to open it.
    this.canvas.addEventListener('click', (e) => {
      const rect = this.canvas.getBoundingClientRect();
      const x = e.clientX - rect.left;
      const y = e.clientY - rect.top;
      for (const n of this.nodes?.values() || []) {
        if (n.desk && Math.hypot(n.x - x, n.y - y) <= n.r + 8) return this.onSelect?.(n.desk, { tab: 'brain' });
      }
    });
    this.resize = new ResizeObserver(() => this.#draw());
    this.resize.observe(this.canvas);
    this.built = true;
  }

  show() {
    if (!this.built) this.#build();
    this.visible = true;
    if (!this.store.llm) api('/api/llm').then((v) => this.store.setLlm(v)).catch(() => {});
    this.render();
  }

  hide() {
    this.visible = false;
  }

  async #post(action, body = {}) {
    try {
      const res = await api(`/api/llm/${action}`, { method: 'POST', body: JSON.stringify(body) });
      if (res.llm) this.store.setLlm(res.llm);
      return res;
    } catch (err) {
      return { ok: false, error: err.message };
    }
  }

  // ---- interaction ----------------------------------------------------------------------------
  async #click(e) {
    const tab = e.target.closest('[data-llm-tab]');
    if (tab) {
      this.tab = tab.dataset.llmTab;
      for (const b of this.root.querySelectorAll('[data-llm-tab]')) b.setAttribute('aria-selected', String(b === tab));
      for (const id of ['thoughts', 'lessons', 'chat']) this.root.querySelector(`#llm-${id}`).hidden = id !== this.tab;
      if (this.tab === 'chat') this.#scrollChat();
      return;
    }
    const desk = e.target.closest('[data-agent]');
    if (desk) return this.onSelect?.(desk.dataset.agent, { tab: 'brain' });
    const btn = e.target.closest('[data-llm]');
    if (!btn) return;
    const act = btn.dataset.llm;
    if (act === 'connect') {
      const input = this.root.querySelector('#llm-key');
      const msg = this.root.querySelector('#llm-key-msg');
      btn.disabled = true;
      msg.textContent = 'Checking the key with Anthropic…';
      const res = await this.#post('key', { apiKey: input.value });
      btn.disabled = false;
      if (res.ok) input.value = '';
      msg.textContent = res.ok ? '✓ Connected.' : `✗ ${res.error}`;
    } else if (act === 'forget') {
      if (confirm('Disconnect Claude? The key is deleted from this computer. The lesson book and record stay.')) await this.#post('forget');
    } else if (act === 'reflect') {
      btn.disabled = true;
      btn.textContent = 'Reflecting…';
      const res = await this.#post('reflect');
      btn.disabled = false;
      btn.textContent = 'Reflect on today now';
      if (!res.ok) alert(res.error);
    } else if (act === 'teach') {
      const input = this.root.querySelector('#llm-teach');
      const res = await this.#post('teach', { text: input.value, symbol: this.root.querySelector('#llm-teach-sym').value });
      if (res.ok) input.value = '';
      else alert(res.error);
    } else if (act === 'retire') {
      await this.#post('forget-lesson', { id: btn.dataset.id });
    } else if (act === 'new-chat') {
      await this.#post('new-chat');
    } else if (act === 'mode') {
      if (btn.dataset.mode === 'veto' && !confirm('Let Claude hold back trades?\n\nOnly once its record has earned it: enough trades judged, and the trades it said to skip clearly worse than the ones it said to take. Even then, only setups it gives under 30% are held back, and they are followed on paper so it keeps learning. It can never add a trade or make one bigger.')) return;
      await this.#post('settings', { mode: btn.dataset.mode });
    }
  }

  async #change(e) {
    if (e.target.id === 'llm-model') await this.#post('settings', { model: e.target.value });
    if (e.target.id === 'llm-budget') await this.#post('settings', { budgetUsd: Number(e.target.value) });
  }

  async #ask() {
    const q = this.root.querySelector('#llm-q');
    const text = q.value.trim();
    if (!text) return;
    q.value = '';
    const res = await this.#post('ask', { question: text });
    if (!res.ok && res.error) this.root.querySelector('#llm-busy').textContent = res.error;
  }

  // ---- rendering ------------------------------------------------------------------------------
  render() {
    if (!this.built) return;
    const v = this.store.llm;
    if (!v) return;
    const [label, color] = v.busy?.chat || v.busy?.reflecting || v.busy?.reviews ? ['Thinking…', CLAUDE] : STATUS[v.status] || STATUS.ready;
    this.root.querySelector('#llm-status').innerHTML = `
      <span class="pill" style="border-color:${color};color:${color}">${escapeHtml(label)}</span>
      ${v.connected ? `<span class="fine">${escapeHtml(v.models.find((m) => m.id === v.model)?.label || v.model)} · ${usd(v.spend.today)} of ${usd(v.budgetUsd)} today · ${usd(v.spend.month)} this month</span>` : ''}`;
    this.#connect(v);
    this.root.querySelector('#llm-main').hidden = !v.connected && !v.reviews.length && !v.lessons.length;
    this.#record(v);
    this.#settings(v);
    this.#thoughts(v);
    this.#lessons(v);
    this.#chat(v);
    this.#draw();
  }

  #connect(v) {
    const el = this.root.querySelector('#llm-connect');
    const key = v.connected ? null : `
      <div class="llm-connect">
        <ol class="steps">
          <li>Create an API key at <a href="https://console.anthropic.com/settings/keys" target="_blank" rel="noopener">console.anthropic.com → API keys</a> and add some credit (Billing). The API is paid per use, separate from a Claude subscription.</li>
          <li>Paste the key here. It's checked with Anthropic, then kept on this computer only (<code>data/llm/key.json</code>) and never shown again.</li>
          <li>Set a daily budget below once connected (default $2). A review costs about 2-6 cents with Opus, a fraction of a cent with Haiku.</li>
          <li>What Claude is sent: the setups, prices, trades, lessons and the account's balance and status it needs to judge. Never a key, token or password.</li>
        </ol>
        <div class="field"><input type="password" id="llm-key" placeholder="sk-ant-…" autocomplete="off" spellcheck="false"><button class="btn primary" data-llm="connect">Connect Claude</button></div>
        <p class="fine" id="llm-key-msg">${v.liveOnly ? 'Demo mode: Claude reviews setups and reflects on real prices only (npm start); you can still chat with it here.' : ''}</p>
      </div>`;
    const err = v.lastError && Date.now() - v.lastError.at < 30 * 60_000 ? `<p class="llm-error">Last problem (${escapeHtml(v.lastError.what)}, ${ago(v.lastError.at)}): ${escapeHtml(v.lastError.text)}</p>` : '';
    const html = (key || '') + err;
    if (el.dataset.html !== html) {
      el.dataset.html = html;
      el.innerHTML = html;
    }
  }

  #record(v) {
    const r = v.record;
    const trust = r.trusted
      ? `<b class="ok">Earned its say</b>: the trades it said to skip lost ${fmtR(r.skips.avgR)} on average, the ones it said to take ${fmtR(r.takes.avgR)}.${v.mode === 'veto' ? ' In veto mode it holds back the clear skips.' : ' Switch to veto mode to let it hold back clear skips.'}`
      : `<b>Earning its say</b>: ${escapeHtml(r.toTrust || '')}. Until then it only advises.`;
    this.root.querySelector('#llm-record').innerHTML = `
      <div class="llm-stats">
        <div><span class="kpi-label">Trades judged</span><b>${r.n}</b></div>
        <div><span class="kpi-label">Said take</span><b>${r.takes.n} · ${fmtR(r.takes.avgR)}</b></div>
        <div><span class="kpi-label">Said skip</span><b>${r.skips.n} · ${fmtR(r.skips.avgR)}</b></div>
        <div><span class="kpi-label">Right</span><b>${pct(r.right)}</b></div>
        <div title="Brier score: how far its chances were from what happened (0 is perfect, 0.25 is a coin)"><span class="kpi-label">Calibration</span><b>${r.brier ?? '—'}</b></div>
      </div>
      <p class="fine">${trust}</p>`;
  }

  #settings(v) {
    const el = this.root.querySelector('#llm-settings');
    if (!v.connected) {
      el.innerHTML = '';
      return;
    }
    const modes = [['off', 'Off'], ['advise', 'Advise'], ['veto', 'Veto']];
    const html = `
      <div class="llm-set-row"><span class="kpi-label">Say</span>
        <div class="book-switch">${modes.map(([id, l]) => `<button data-llm="mode" data-mode="${id}" aria-pressed="${v.mode === id}">${l}</button>`).join('')}</div>
        <span class="fine">${v.mode === 'off' ? 'No reviews (chat still works).' : v.mode === 'advise' ? 'Reviews every setup and learns; never holds a trade back.' : `May hold back setups it gives under ${Math.round(v.vetoBelow * 100)}%, once its record has earned it.`}</span></div>
      <div class="llm-set-row"><span class="kpi-label">Model</span>
        <select id="llm-model">${v.models.map((m) => `<option value="${m.id}" ${m.id === v.model ? 'selected' : ''}>${escapeHtml(m.label)} · $${m.input}/$${m.output} per M tokens</option>`).join('')}</select></div>
      <div class="llm-set-row"><span class="kpi-label">Daily budget</span>
        <input id="llm-budget" type="number" min="0" max="100" step="0.5" value="${v.budgetUsd}"> <span class="fine">US$ a day; Claude pauses until tomorrow when it's spent.</span></div>
      <div class="llm-set-row"><span class="fine">Key ${escapeHtml(v.keyHint || '')} (${v.keySource === 'env' ? 'from .env' : 'saved on this computer'})</span>${v.keySource === 'saved' ? '<button class="mini-btn" data-llm="forget">Disconnect</button>' : ''}</div>`;
    // Don't redraw the inputs while the boss is typing in them.
    if (el.dataset.html === html || el.contains(document.activeElement)) return;
    el.dataset.html = html;
    el.innerHTML = html;
  }

  #thoughts(v) {
    const el = this.root.querySelector('#llm-thoughts');
    if (!v.reviews.length) {
      el.innerHTML = `<p class="muted">No verdicts yet. ${v.connected ? (v.liveOnly ? 'Claude reviews setups on real prices only (npm start).' : v.mode === 'off' ? 'Reviews are off (Say: Advise).' : 'The next setup a desk arms is reviewed here, live.') : 'Connect Claude above.'}</p>`;
      return;
    }
    el.innerHTML = v.reviews.map((r) => {
      const verdict = r.status === 'done'
        ? `<span class="pill" style="border-color:${r.verdict === 'take' ? GREEN : GREY};color:${r.verdict === 'take' ? GREEN : GREY}">${r.verdict === 'take' ? 'TAKE' : 'SKIP'} ${pct(r.p)}</span>`
        : r.status === 'thinking' || r.status === 'queued' ? `<span class="pill" style="border-color:${CLAUDE};color:${CLAUDE}">${r.status === 'queued' ? 'queued' : 'thinking…'}</span>`
          : `<span class="pill muted">${escapeHtml(r.status)}</span>`;
      const outcome = r.status !== 'done' ? '' : r.outcome
        ? `<span class="${r.outcome.r > 0 ? 'ok' : 'no'}">${fmtR(r.outcome.r)}${r.outcome.how === 'held back' ? ' on paper' : ''}</span>${r.right != null ? ` · Claude was <b class="${r.right ? 'ok' : 'no'}">${r.right ? 'right' : 'wrong'}</b>` : ''}`
        : r.vetoed ? '<span class="warn">held back, followed on paper</span>' : r.linked ? '<span class="muted">trade open</span>' : Date.now() - r.at > 3 * 3_600_000 ? '<span class="muted">never filled</span>' : '<span class="muted">waiting for the fill</span>';
      return `<div class="llm-rev">
        <div class="llm-rev-head">${verdict} <a href="#" data-agent="${escapeHtml(r.desk)}">${escapeHtml(r.name?.split(' ')[0] || r.desk)}</a> ${r.side === 'LONG' ? '▲' : '▼'} ${escapeHtml(r.symbol)} ${r.rr ? `· ${r.rr}R` : ''} <span class="fine">${ago(r.at)}</span></div>
        ${r.reasons.length ? `<ul>${r.reasons.slice(0, 3).map((x) => `<li>${escapeHtml(x)}</li>`).join('')}</ul>` : r.note ? `<p class="fine">${escapeHtml(r.note)}</p>` : ''}
        ${r.risks.length ? `<p class="fine">Risks: ${r.risks.map(escapeHtml).join(' · ')}</p>` : ''}
        <div class="fine">${outcome}${r.lessonsUsed.length ? ` · lessons ${r.lessonsUsed.map(escapeHtml).join(', ')}` : ''}${r.cost != null ? ` · ${usd(r.cost)}` : ''}</div>
      </div>`;
    }).join('');
  }

  #lessons(v) {
    const el = this.root.querySelector('#llm-lessons');
    if (el.contains(document.activeElement)) return;
    const live = v.lessons.filter((l) => !l.retired);
    const retired = v.lessons.filter((l) => l.retired);
    const syms = Object.keys(this.store.symbols || {});
    const last = v.reflections?.[0];
    const row = (l) => `<div class="llm-lesson ${l.retired ? 'retired' : ''}">
      <span class="pill llm-kind-${l.kind}">${l.kind}</span>
      <span>${escapeHtml(l.text)}</span>
      <span class="fine">${l.id}${l.symbol ? ` · ${escapeHtml(l.symbol)}` : ''}${l.session ? ` · ${l.session}` : ''} · ${l.source === 'boss' ? 'from you' : 'learned'} · used ${l.used || 0}, right ${l.right || 0}, wrong ${l.wrong || 0}${l.retired ? ` · retired: ${escapeHtml(l.retiredWhy || '')}` : ''}</span>
      ${l.retired ? '' : `<button class="mini-btn" data-llm="retire" data-id="${l.id}">Retire</button>`}
    </div>`;
    el.innerHTML = `
      ${last ? `<div class="llm-reflection"><b>${last.ok ? `Claude on ${escapeHtml(last.day)}` : `Reflection on ${escapeHtml(last.day)} failed`}</b> <span class="fine">${ago(last.at)}${last.ok ? ` · ${last.added.length} new, ${last.retired.length} retired` : ''}</span><p>${escapeHtml(last.ok ? last.summary : last.error || '')}</p></div>` : '<p class="muted">After the New York close Claude reads the day and writes its lessons here.</p>'}
      <div class="llm-set-row"><button class="btn" data-llm="reflect" ${v.connected ? '' : 'disabled'}>${v.busy?.reflecting ? 'Reflecting…' : 'Reflect on today now'}</button></div>
      <div class="llm-teach"><input id="llm-teach" placeholder="Teach Claude a rule, e.g. Don't take gold longs into the US CPI release" maxlength="400">
        <select id="llm-teach-sym"><option value="">Any market</option>${syms.map((s) => `<option>${s}</option>`).join('')}</select>
        <button class="btn" data-llm="teach">Teach</button></div>
      ${live.length ? live.map(row).join('') : '<p class="muted">No lessons yet.</p>'}
      ${retired.length ? `<details><summary>${retired.length} retired</summary>${retired.map(row).join('')}</details>` : ''}`;
  }

  #chat(v) {
    const el = this.root.querySelector('#llm-msgs');
    const busy = v.busy?.chat;
    const html = (v.chat.length || busy ? '' : '<p class="muted">Ask Claude anything about the floor. It looks at the live data before it answers, and can\'t change anything.</p>')
      + v.chat.map((m) => `<div class="llm-msg ${m.role}${m.error ? ' error' : ''}">${m.role === 'assistant' ? '<b>Claude</b>' : '<b>You</b>'}<div>${escapeHtml(m.text).replace(/\n/g, '<br>')}</div>${m.steps?.length ? `<span class="fine">looked at: ${[...new Set(m.steps)].map((s) => s.replace(/_/g, ' ')).join(', ')}${m.cost != null ? ` · ${usd(m.cost)}` : ''}</span>` : ''}</div>`).join('')
      + (busy ? `<div class="llm-msg assistant thinking"><b>Claude</b><div>Thinking${busy.steps.length ? `, looking at ${escapeHtml([...new Set(busy.steps)].map((s) => s.replace(/_/g, ' ')).join(', '))}` : ''}…</div></div>` : '');
    if (el.dataset.html !== html) {
      el.dataset.html = html;
      el.innerHTML = html;
      this.#scrollChat();
    }
    this.root.querySelector('#llm-busy').textContent = busy ? 'Claude is answering…' : '';
  }

  #scrollChat() {
    const el = this.root.querySelector('#llm-msgs');
    el.scrollTop = el.scrollHeight;
  }

  // ---- the node brain -------------------------------------------------------------------------
  #layout(w, h) {
    const cx = w / 2;
    const cy = h / 2;
    const R = Math.min(w, h) / 2;
    const nodes = new Map();
    nodes.set('claude', { x: cx, y: cy, r: Math.max(16, R * 0.13), label: 'Claude', color: CLAUDE });
    SOURCES.forEach(([id, label], i) => {
      const a = (i / SOURCES.length) * Math.PI * 2 - Math.PI / 2;
      nodes.set(id, { x: cx + Math.cos(a) * R * 0.42, y: cy + Math.sin(a) * R * 0.42, r: Math.max(6, R * 0.05), label, color: '#a371f7' });
    });
    const desks = this.store.profiles || [];
    desks.forEach((p, i) => {
      const a = (i / desks.length) * Math.PI * 2 - Math.PI / 2 + 0.08;
      nodes.set(`desk:${p.id}`, { x: cx + Math.cos(a) * R * 0.86, y: cy + Math.sin(a) * R * 0.86, r: Math.max(4, R * 0.035), label: p.name.split(' ')[0], color: p.accent || '#3987e5', desk: p.id });
    });
    return nodes;
  }

  #event(ev) {
    const desk = `desk:${ev.desk}`;
    const now = performance.now();
    if (ev.kind === 'review' && (ev.status === 'thinking' || ev.status === 'queued')) {
      // The setup flows in: desk → what Claude reads → Claude.
      SOURCES.forEach(([id], i) => {
        this.pulses.push({ from: desk, to: id, color: '#c9ccd3', t0: now + i * 60, ms: 900 });
        this.pulses.push({ from: id, to: 'claude', color: '#a371f7', t0: now + 700 + i * 60, ms: 900 });
      });
      this.thinking = now + 2500;
    } else if (ev.kind === 'review' && ev.status === 'done') {
      this.pulses.push({ from: 'claude', to: desk, color: ev.verdict === 'take' ? GREEN : GREY, t0: now, ms: 1200 });
      this.flash.set('claude', { color: ev.verdict === 'take' ? GREEN : GREY, t0: now });
    } else if (ev.kind === 'outcome') {
      const c = ev.right == null ? (ev.r > 0 ? GREEN : RED) : ev.right ? GREEN : RED;
      this.pulses.push({ from: desk, to: 'claude', color: c, t0: now, ms: 1200 });
      this.pulses.push({ from: 'claude', to: 'book', color: GOLD, t0: now + 1100, ms: 900 });
      this.pulses.push({ from: 'claude', to: 'rec', color: c, t0: now + 1100, ms: 900 });
      this.flash.set('book', { color: GOLD, t0: now + 1900 });
    }
    this.#animate();
  }

  #animate() {
    if (this.raf) return;
    const step = () => {
      this.raf = null;
      this.#draw();
      const now = performance.now();
      this.pulses = this.pulses.filter((p) => now < p.t0 + p.ms);
      const busy = this.pulses.length || now < this.thinking || [...this.flash.values()].some((f) => now - f.t0 < 1200) || this.store.llm?.busy?.chat || this.store.llm?.busy?.reflecting;
      if (busy && this.visible) this.raf = requestAnimationFrame(step);
    };
    this.raf = requestAnimationFrame(step);
  }

  #draw() {
    const c = this.canvas;
    if (!c || !this.visible) return;
    const dpr = Math.min(2, window.devicePixelRatio || 1);
    const w = c.clientWidth;
    const h = c.clientHeight;
    if (!w || !h) return;
    if (c.width !== Math.round(w * dpr) || c.height !== Math.round(h * dpr)) {
      c.width = Math.round(w * dpr);
      c.height = Math.round(h * dpr);
    }
    const g = c.getContext('2d');
    g.setTransform(dpr, 0, 0, dpr, 0, 0);
    g.clearRect(0, 0, w, h);
    const nodes = this.#layout(w, h);
    this.nodes = nodes;
    const now = performance.now();
    const v = this.store.llm;
    const active = v?.connected && v.mode !== 'off';
    // Wiring: desks to what Claude reads, what it reads to Claude.
    g.lineWidth = 1;
    const claude = nodes.get('claude');
    for (const [id] of SOURCES) {
      const s = nodes.get(id);
      g.strokeStyle = 'rgba(163,113,247,0.22)';
      g.beginPath();
      g.moveTo(s.x, s.y);
      g.lineTo(claude.x, claude.y);
      g.stroke();
    }
    for (const [id, n] of nodes) {
      if (!n.desk) continue;
      g.strokeStyle = 'rgba(255,255,255,0.05)';
      g.beginPath();
      g.moveTo(n.x, n.y);
      g.lineTo(claude.x, claude.y);
      g.stroke();
    }
    // Pulses in flight.
    for (const p of this.pulses) {
      const a = nodes.get(p.from);
      const b = nodes.get(p.to);
      const t = (now - p.t0) / p.ms;
      if (!a || !b || t < 0 || t > 1) continue;
      const x = a.x + (b.x - a.x) * t;
      const y = a.y + (b.y - a.y) * t;
      g.strokeStyle = p.color;
      g.globalAlpha = 0.5 * (1 - t);
      g.beginPath();
      g.moveTo(a.x, a.y);
      g.lineTo(x, y);
      g.stroke();
      g.globalAlpha = 1;
      g.fillStyle = p.color;
      g.beginPath();
      g.arc(x, y, 3, 0, Math.PI * 2);
      g.fill();
    }
    // Nodes.
    g.font = '11px system-ui, -apple-system, sans-serif';
    g.textAlign = 'center';
    for (const [id, n] of nodes) {
      const f = this.flash.get(id);
      const fl = f && now - f.t0 >= 0 && now - f.t0 < 1200 ? 1 - (now - f.t0) / 1200 : 0;
      g.fillStyle = n.color;
      g.globalAlpha = id === 'claude' ? (active ? 1 : 0.45) : 0.9;
      g.beginPath();
      g.arc(n.x, n.y, n.r + fl * 4, 0, Math.PI * 2);
      g.fill();
      if (fl) {
        g.strokeStyle = f.color;
        g.lineWidth = 2;
        g.beginPath();
        g.arc(n.x, n.y, n.r + 4 + fl * 6, 0, Math.PI * 2);
        g.stroke();
        g.lineWidth = 1;
      }
      g.globalAlpha = 1;
      g.fillStyle = id === 'claude' ? '#fff' : 'rgba(242,242,240,0.75)';
      if (id === 'claude') {
        g.font = 'bold 12px system-ui, -apple-system, sans-serif';
        g.fillText('Claude', n.x, n.y + 4);
        g.font = '11px system-ui, -apple-system, sans-serif';
      } else g.fillText(n.label, n.x, n.y + n.r + 12);
    }
    // Thinking: an arc turning around Claude.
    if (now < this.thinking || v?.busy?.chat || v?.busy?.reflecting || v?.busy?.reviews) {
      const a = (now / 400) % (Math.PI * 2);
      g.strokeStyle = CLAUDE;
      g.lineWidth = 2;
      g.beginPath();
      g.arc(claude.x, claude.y, claude.r + 7, a, a + Math.PI * 0.7);
      g.stroke();
      g.lineWidth = 1;
      this.#animate();
    }
  }
}
