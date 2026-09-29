import { store } from './store.js';
import { connect } from './net.js';
import { voice } from './voice.js';
import { TradingFloor } from './floor/floor.js';
import { Hud } from './ui/hud.js';
import { AgentPanel } from './ui/agentPanel.js';
import { Dashboard } from './ui/dashboard.js';
import { TradingViewView } from './ui/tvView.js';
import { LiveView } from './ui/liveView.js';
import { escapeHtml, money } from './format.js';

const app = document.getElementById('app');
const params = new URLSearchParams(location.search);

let floor;
try {
  floor = new TradingFloor(document.getElementById('floor-canvas'), document.getElementById('overlay-layer'), store);
} catch (err) {
  document.getElementById('loading-text').textContent = 'WebGL is not available in this browser — the dashboard still works.';
  console.error(err);
}

const hud = new Hud(store, { onSelect: (id) => select(id) });
const panel = new AgentPanel(store, floor);
const dashboard = new Dashboard(store, document.getElementById('dashboard-view'), { onSelect: (id) => select(id) });
const tvView = new TradingViewView(store, document.getElementById('tv-view'));
const liveView = new LiveView(store, document.getElementById('live-view'));
let view = 'floor';

// ---- selection -------------------------------------------------------------------------
function select(id) {
  if (!store.profileById[id]) return;
  if (view !== 'floor') setView('floor');
  store.select(id);
  floor?.focusAgent(id);
  panel.open(id);
  hud.update();
  hideHint();
}

function deselect() {
  if (!store.selected) return;
  const id = store.selected;
  store.select(null);
  panel.close();
  floor?.clearBubble(id);
  floor?.overview();
  hud.update();
}

document.getElementById('ap-close').addEventListener('click', deselect);
floor?.on('select', (id) => select(id));

// ---- views -----------------------------------------------------------------------------
function setView(next, opts = {}) {
  view = next;
  app.dataset.view = next;
  document.querySelectorAll('.tabs button').forEach((b) => b.setAttribute('aria-selected', String(b.dataset.view === next)));
  floor?.setActive(next === 'floor');
  if (next === 'dashboard') dashboard.show();
  else dashboard.hide();
  if (next === 'tradingview') tvView.show();
  else tvView.hide();
  if (next === 'ftmo') liveView.show(opts);
  else liveView.hide();
  if (next !== 'floor' && store.selected) deselect();
}
document.querySelectorAll('.tabs button').forEach((b) => b.addEventListener('click', () => setView(b.dataset.view)));

// ---- toggles ---------------------------------------------------------------------------
const voiceBtn = document.getElementById('btn-voice');
const qualityBtn = document.getElementById('btn-quality');
const syncVoice = () => {
  voiceBtn.setAttribute('aria-pressed', String(voice.enabled));
  voiceBtn.title = voice.supported ? `Agent voices ${voice.enabled ? 'on' : 'off'} (V)` : 'Speech is not supported in this browser';
};
voiceBtn.addEventListener('click', () => {
  voice.setEnabled(!voice.enabled);
  syncVoice();
});
syncVoice();
let hq = true;
try { hq = localStorage.getItem('floor.hq') !== 'off'; } catch { /* ignore */ }
if (params.get('hq') === '0') hq = false;
floor?.setQuality(hq);
qualityBtn.setAttribute('aria-pressed', String(hq));
qualityBtn.addEventListener('click', () => floor?.setQuality(!floor.quality));
floor?.on('quality', (on) => {
  qualityBtn.setAttribute('aria-pressed', String(on));
  try { localStorage.setItem('floor.hq', on ? 'on' : 'off'); } catch { /* ignore */ }
});
if (params.get('hq') === '1' && floor) floor.autoQuality = false; // pin high quality (skip auto-downgrade)

// ---- keyboard --------------------------------------------------------------------------
window.addEventListener('keydown', (e) => {
  if (e.target.closest('input, select, textarea') || e.metaKey || e.ctrlKey) return;
  const ids = store.profiles.map((p) => p.id);
  if (/^[0-9]$/.test(e.key) && ids.length) {
    const idx = e.key === '0' ? 9 : Number(e.key) - 1;
    if (ids[idx]) select(ids[idx]);
  } else if (e.key === 'Escape') {
    deselect();
  } else if (e.key === 'ArrowRight' || e.key === 'ArrowLeft') {
    if (!store.selected || view !== 'floor') return;
    const i = ids.indexOf(store.selected);
    select(ids[(i + (e.key === 'ArrowRight' ? 1 : ids.length - 1)) % ids.length]);
  } else if (e.key.toLowerCase() === 'd') setView('dashboard');
  else if (e.key.toLowerCase() === 'f') setView('floor');
  else if (e.key.toLowerCase() === 't') setView('tradingview');
  else if (e.key.toLowerCase() === 'l') setView('ftmo');
  else if (e.key.toLowerCase() === 'v') voiceBtn.click();
  else if (e.key.toLowerCase() === 'q') qualityBtn.click();
});

// ---- data flow -------------------------------------------------------------------------
function hideHint() {
  document.getElementById('floor-hint').style.opacity = '0';
}

store.on('init', ({ first }) => {
  if (first) {
    floor?.buildDesks(store.profiles);
    hud.init();
    setTimeout(() => document.getElementById('loading').classList.add('done'), 400);
    setTimeout(hideHint, 14000);
    const pre = params.get('agent');
    if (pre) setTimeout(() => select(pre), 900);
    if (params.get('view')) setView(params.get('view'));
  } else {
    hud.init();
  }
  floor?.sync();
});

store.on('snapshot', () => {
  floor?.sync();
  hud.update();
  panel.update();
  dashboard.render();
});

// Floor chatter: short bubbles over a trader's head when they trade.
store.on('event', (ev) => {
  hud.renderTape();
  if (!ev.agentId || !floor || view !== 'floor') return;
  if (ev.agentId === store.selected) return;
  const liveFill = ev.kind === 'live' && /filled|closed/.test(ev.text);
  if (!['entry', 'exit', 'partial', 'halt', 'signal', 'alert'].includes(ev.kind) && !liveFill) return;
  if (floor.bubbles.size >= 3 && !['halt', 'alert'].includes(ev.kind)) return;
  const p = store.profileById[ev.agentId];
  floor.showBubble(ev.agentId, `<b>${escapeHtml(p.name.split(' ')[0])}</b>${escapeHtml(ev.text)}`, { duration: 4500 });
});

store.on('equity', (sample) => dashboard.onEquity(sample));

// ---- FTMO live trading: top-bar pill, new-account prompt, desk chips ------------------------
const livePill = document.getElementById('live-pill');
const liveModal = document.getElementById('live-modal');
const promptedLogins = new Set();
livePill.addEventListener('click', () => setView('ftmo'));
document.getElementById('live-modal-later').addEventListener('click', () => { liveModal.hidden = true; });
document.getElementById('live-modal-setup').addEventListener('click', () => {
  liveModal.hidden = true;
  setView('ftmo', { focusSetup: true });
});

store.on('live', (v) => {
  const acc = v.account;
  let cls = '';
  let text = 'Connect FTMO';
  if (v.halt) { cls = 'halted'; text = 'FTMO · halted'; }
  else if (v.armed) { cls = 'armed'; text = `FTMO LIVE · ${money(acc?.equity)}`; }
  else if (acc && v.connected && !v.profile) { cls = 'setup'; text = 'FTMO · set up'; }
  else if (acc && v.connected) { cls = 'connected'; text = `FTMO · ${money(acc.equity)}`; }
  else if (acc) { text = 'FTMO · MT5 offline'; }
  livePill.className = `live-pill ${cls}`;
  livePill.querySelector('span').textContent = text;
  livePill.title = acc ? `Account ${acc.login} on ${acc.server}${v.armed ? ' — desks are trading it live' : ''}` : 'Connect your FTMO MetaTrader 5 account';

  // "It asks me to connect": a newly seen MT5 account prompts for its setup.
  if (acc && v.connected && !v.profile && !promptedLogins.has(acc.login) && view !== 'ftmo') {
    promptedLogins.add(acc.login);
    document.getElementById('live-modal-body').innerHTML = `Account <b>${escapeHtml(String(acc.login))}</b> on <b>${escapeHtml(acc.server)}</b> (${escapeHtml(acc.name || '')}, balance ${money(acc.balance)}) just connected through MetaTrader 5. Is it a Free Trial or a Challenge? Set it up, then pick which desks may trade it.`;
    liveModal.hidden = false;
  }
  hud.setLive(v);
  panel.setLive(v);
});

// Handy for tinkering from the browser console: floorApp.select('amara')
window.floorApp = { store, floor, panel, select, deselect, setView };

connect();
