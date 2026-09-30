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
const dashboard = new Dashboard(store, document.getElementById('dashboard-view'), {
  onSelect: (id, opts) => select(id, opts),
  onBookChange: () => bookChanged(),
  onView: (v) => setView(v),
});
const tvView = new TradingViewView(store, document.getElementById('tv-view'));
const liveView = new LiveView(store, document.getElementById('live-view'));
let view = 'floor';

// ---- selection -------------------------------------------------------------------------
function select(id, { tab } = {}) {
  if (!store.profileById[id]) return;
  if (view !== 'floor') setView('floor');
  store.select(id);
  floor?.focusAgent(id);
  panel.open(id);
  if (tab) panel.showTab(tab);
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

// ---- settings: voices, graphics, tour ------------------------------------------------------
const settingsBtn = document.getElementById('btn-settings');
const settings = document.getElementById('settings');
const voiceSeg = document.getElementById('set-voice');
const voiceNote = document.getElementById('set-voice-note');
const voiceBar = document.getElementById('set-voice-progress');
const hqBox = document.getElementById('set-hq');

function openSettings(open) {
  settings.hidden = !open;
  settingsBtn.setAttribute('aria-expanded', String(open));
}
settingsBtn.addEventListener('click', (e) => {
  e.stopPropagation();
  openSettings(settings.hidden);
});
document.addEventListener('pointerdown', (e) => {
  if (!settings.hidden && !settings.contains(e.target) && !settingsBtn.contains(e.target)) openSettings(false);
});

const mb = (n) => `${Math.round(n / 1e6)} MB`;
function voiceNoteText(st) {
  const n = st.neural;
  if (st.engine === 'off') return 'Traders answer in text only.';
  if (st.engine === 'natural') {
    if (n.state === 'ready') return `Realistic voices are ready. They run on this Mac, and nothing you hear is sent anywhere.${n.lastError ? ` (Last problem: ${n.lastError}; Mac voices filled in.)` : ''}`;
    if (n.state === 'installing') return `${n.step} Mac voices fill in meanwhile.`;
    if (n.state === 'loading') return n.total ? `${n.step} ${mb(n.loaded)} of ${mb(n.total)}. Mac voices fill in meanwhile.` : `${n.step || 'Starting the voice engine…'} Mac voices fill in meanwhile.`;
    if (n.state === 'error') return `Realistic voices aren't working: ${n.error} Mac voices are used meanwhile. Pick Realistic again to retry.`;
    return 'Setting up realistic voices… The first time, the floor installs its voice engine (about 400 MB) and downloads the voice model (about 90 MB). After that they start in seconds.';
  }
  const names = [...new Set(Object.values(st.assigned))];
  if (!st.systemVoices) return 'No English system voices found in this browser.';
  const basic = names.every((x) => !/premium|enhanced|natural|google/i.test(x));
  return `Using ${names.slice(0, 4).join(', ')}${names.length > 4 ? '…' : ''}.${basic ? ' For better Mac voices open System Settings → Accessibility → Spoken Content → System voice → Manage Voices and add Premium voices such as Zoe, Ava, Evan or Serena.' : ''}`;
}
function syncVoiceUi(st = voice.status()) {
  voiceSeg.querySelectorAll('button').forEach((b) => b.setAttribute('aria-checked', String(b.dataset.engine === st.engine)));
  voiceNote.textContent = voiceNoteText(st);
  const busy = st.engine === 'natural' && (st.neural.state === 'loading' || st.neural.state === 'installing');
  voiceBar.hidden = !busy;
  voiceBar.classList.toggle('indeterminate', busy && st.neural.progress == null);
  voiceBar.firstElementChild.style.width = st.neural.progress == null ? '35%' : `${Math.round(st.neural.progress * 100)}%`;
  document.getElementById('set-voice-preview').disabled = st.engine === 'off';
  welcome.syncVoice(st);
}
voiceSeg.addEventListener('click', (e) => {
  const b = e.target.closest('[data-engine]');
  if (b) setVoiceEngine(b.dataset.engine);
});
function setVoiceEngine(engine) {
  voice.unlock();
  if (engine !== 'off') try { localStorage.setItem('floor.voiceLast', engine); } catch { /* ignore */ }
  voice.setEngine(engine);
}
function previewVoice() {
  voice.unlock();
  const p = store.profileById[store.selected] || store.profiles[0];
  if (p) voice.preview(p);
}
document.getElementById('set-voice-preview').addEventListener('click', previewVoice);
voice.on((st) => syncVoiceUi(st));
store.on('voices', (st) => voice.setServerStatus(st));

let hq = true;
try { hq = localStorage.getItem('floor.hq') !== 'off'; } catch { /* ignore */ }
if (params.get('hq') === '0') hq = false;
floor?.setQuality(hq);
hqBox.checked = hq;
hqBox.addEventListener('change', () => floor?.setQuality(hqBox.checked));
floor?.on('quality', (on) => {
  hqBox.checked = on;
  try { localStorage.setItem('floor.hq', on ? 'on' : 'off'); } catch { /* ignore */ }
});
if (params.get('hq') === '1' && floor) floor.autoQuality = false; // pin high quality (skip auto-downgrade)

// ---- first-run welcome ----------------------------------------------------------------------
const welcome = (() => {
  const el = document.getElementById('welcome');
  const steps = [...el.querySelectorAll('section[data-step]')];
  const dots = [...el.querySelectorAll('.wc-dots i')];
  let step = 0;
  const show = (i) => {
    step = i;
    steps.forEach((sec, k) => { sec.hidden = k !== i; });
    dots.forEach((d, k) => d.classList.toggle('on', k <= i));
  };
  const finish = () => {
    el.hidden = true;
    try { localStorage.setItem('floor.welcomed', '1'); } catch { /* ignore */ }
  };
  el.addEventListener('click', (e) => {
    const opt = e.target.closest('.wc-opt');
    if (opt) {
      setVoiceEngine(opt.dataset.engine);
      return;
    }
    const act = e.target.closest('[data-wc]')?.dataset.wc;
    if (act === 'next') show(Math.min(steps.length - 1, step + 1));
    else if (act === 'skip' || act === 'done') finish();
    else if (act === 'preview') previewVoice();
    else if (act === 'ftmo') {
      finish();
      setView('ftmo');
    }
  });
  return {
    open() {
      openSettings(false);
      show(0);
      el.hidden = false;
    },
    get seen() {
      try { return localStorage.getItem('floor.welcomed') === '1'; } catch { return true; }
    },
    syncVoice(st) {
      el.querySelectorAll('.wc-opt').forEach((b) => b.setAttribute('aria-checked', String(b.dataset.engine === st.engine)));
      const note = document.getElementById('wc-voice-note');
      if (note) note.textContent = st.engine === 'natural' ? voiceNoteText(st) : '';
    },
  };
})();
document.getElementById('set-tour').addEventListener('click', () => welcome.open());
syncVoiceUi();
voice.prepare();

// ---- keyboard --------------------------------------------------------------------------
window.addEventListener('keydown', (e) => {
  if (e.target.closest('input, select, textarea') || e.metaKey || e.ctrlKey) return;
  if (!document.getElementById('welcome').hidden) return;
  const ids = store.profiles.map((p) => p.id);
  if (/^[0-9]$/.test(e.key) && ids.length) {
    const idx = e.key === '0' ? 9 : Number(e.key) - 1;
    if (ids[idx]) select(ids[idx]);
  } else if (e.key === 'Escape') {
    if (!settings.hidden) return openSettings(false);
    deselect();
  } else if (e.key === 'ArrowRight' || e.key === 'ArrowLeft') {
    if (!store.selected || view !== 'floor') return;
    const i = ids.indexOf(store.selected);
    select(ids[(i + (e.key === 'ArrowRight' ? 1 : ids.length - 1)) % ids.length]);
  } else if (e.key.toLowerCase() === 'd') setView('dashboard');
  else if (e.key.toLowerCase() === 'f') setView('floor');
  else if (e.key.toLowerCase() === 't') setView('tradingview');
  else if (e.key.toLowerCase() === 'l') setView('ftmo');
  else if (e.key.toLowerCase() === 'v') {
    let last = 'system';
    try { last = localStorage.getItem('floor.voiceLast') || 'system'; } catch { /* ignore */ }
    setVoiceEngine(voice.enabled ? 'off' : last);
  } else if (e.key.toLowerCase() === 'q') floor?.setQuality(!floor.quality);
});

// ---- data flow -------------------------------------------------------------------------
function hideHint() {
  document.getElementById('floor-hint').style.opacity = '0';
}

store.on('init', ({ first }) => {
  if (first) {
    floor?.buildDesks(store.profiles);
    voice.setProfiles(store.profiles);
    hud.init();
    setTimeout(() => document.getElementById('loading').classList.add('done'), 400);
    setTimeout(hideHint, 14000);
    const pre = params.get('agent');
    if (pre) setTimeout(() => select(pre), 900);
    if (params.get('view')) setView(params.get('view'));
    if (!welcome.seen && !pre && !params.get('view')) setTimeout(() => welcome.open(), 900);
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
  if (!['entry', 'exit', 'partial', 'halt', 'signal', 'alert', 'learn'].includes(ev.kind) && !liveFill) return;
  if (floor.bubbles.size >= 3 && !['halt', 'alert', 'learn'].includes(ev.kind)) return;
  const p = store.profileById[ev.agentId];
  const learned = ev.kind === 'learn';
  floor.showBubble(ev.agentId, `<b>${escapeHtml(p.name.split(' ')[0])}${learned ? ' · 💡 learned something' : ''}</b>${escapeHtml(learned ? ev.text.replace(/^Lesson learned — /, '') : ev.text)}`, { duration: learned ? 9000 : 4500 });
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
    document.getElementById('live-modal-title').textContent = v.isFtmo ? 'New FTMO account detected' : 'New MT5 account detected';
    document.getElementById('live-modal-body').innerHTML = `Account <b>${escapeHtml(String(acc.login))}</b> on <b>${escapeHtml(acc.server)}</b> (${escapeHtml(acc.name || '')}, balance ${money(acc.balance)}) just connected through MetaTrader 5. ` +
      (v.isFtmo
        ? 'Is it a Free Trial or a Challenge? Set it up, then pick which desks may trade it.'
        : 'This doesn’t look like an FTMO account. To trade FTMO, log MT5 into the account from your FTMO Client Area (File → Login to Trade Account).');
    liveModal.hidden = false;
  }
  hud.setLive(v);
  panel.setLive(v);
  hud.update();
  floor?.sync();
  dashboard.render();
});
// The FTMO / Paper switch (top bar or dashboard) re-renders everything that shows P&L.
function bookChanged() {
  hud.update();
  floor?.sync();
  panel.update();
  dashboard.render(true);
}
hud.onBookChange = bookChanged;

// Handy for tinkering from the browser console: floorApp.select('amara')
window.floorApp = { store, floor, panel, select, deselect, setView };

connect();
