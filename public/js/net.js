import { store } from './store.js';

// WebSocket link to the local server with automatic reconnect.
let ws = null;
let retry = 0;

// The floor key: new on every launch of the floor, handed to this page only. Every API
// call and the live feed carry it, so other websites can't drive the floor.
export const floorKey = document.querySelector('meta[name="floor-key"]')?.content || '';
export const widgetPort = Number(document.querySelector('meta[name="floor-widget-port"]')?.content) || null;

// The floor was restarted (new key): load the page again to pick it up.
async function reloadIfKeyStale() {
  try {
    const res = await fetch('/api/session', { headers: { 'X-Floor-Key': floorKey } });
    if (res.status === 401 && !sessionStorage.getItem('floor.reloaded')) {
      sessionStorage.setItem('floor.reloaded', '1');
      location.reload();
    }
  } catch {
    /* floor not running yet: keep retrying */
  }
}

export function connect() {
  const proto = location.protocol === 'https:' ? 'wss' : 'ws';
  ws = new WebSocket(`${proto}://${location.host}/ws?key=${encodeURIComponent(floorKey)}`);
  store.emit('conn', 'connecting');

  ws.onopen = () => {
    retry = 0;
    try { sessionStorage.removeItem('floor.reloaded'); } catch { /* private mode */ }
    store.emit('conn', 'ok');
  };
  ws.onmessage = (e) => {
    let msg;
    try {
      msg = JSON.parse(e.data);
    } catch {
      return;
    }
    switch (msg.type) {
      case 'init': store.init(msg); store.setLive(msg.live); store.setTunnel(msg.tunnel); store.emit('voices', msg.voices); store.setNews(msg.news); store.setBrain(msg.brain); break;
      case 'news': store.setNews(msg.news); break;
      case 'brain': store.setBrain(msg.brain); break;
      case 'memory': store.emit('memory', msg.event); break;
      case 'neural': store.emit('neural', msg.event); break;
      case 'voices': store.emit('voices', msg.voices); break;
      case 'tunnel': store.setTunnel(msg.tunnel); break;
      case 'live': store.setLive(msg.live); break;
      case 'firewall': store.emit('firewall', msg); break;
      case 'snapshot': if (store.ready) store.snapshot(msg); break;
      case 'event': store.addEvent(msg.event); break;
      case 'equity': store.addEquity(msg.sample); break;
      case 'trade': store.addTrade(msg.trade); break;
      case 'alert': store.addAlert(msg.alert); break;
      case 'command-result': store.emit('command-result', msg); break;
      default: break;
    }
  };
  ws.onclose = () => {
    store.emit('conn', 'down');
    retry++;
    if (retry >= 2) reloadIfKeyStale();
    setTimeout(connect, Math.min(8000, 500 * 2 ** Math.min(retry, 4)));
  };
  ws.onerror = () => ws.close();
}

export function command(cmd, agentId) {
  if (ws && ws.readyState === 1) ws.send(JSON.stringify({ type: 'command', cmd, agentId }));
}

// fetch() for the floor's API, with the floor key.
export async function apiFetch(path, opts = {}) {
  const res = await fetch(path, { ...opts, headers: { ...(opts.headers || {}), 'X-Floor-Key': floorKey } });
  if (res.status === 401) reloadIfKeyStale();
  return res;
}

export async function api(path, opts = {}) {
  const res = await apiFetch(path, {
    ...opts,
    headers: { 'Content-Type': 'application/json', ...(opts.headers || {}) },
  });
  if (!res.ok) {
    // This page is read from disk, the floor's code was loaded when it started: after a git
    // pull the page knows buttons the running floor doesn't yet.
    let body = null;
    try { body = await res.json(); } catch { /* not JSON */ }
    if (res.status === 404 && body?.error === 'unknown action') {
      throw new Error('the floor is still running its old code (from before your last git pull), so it doesn\'t know this button yet. In Terminal: cd ~/trading-floor && npm run service -- restart, then reload this page');
    }
    throw new Error(body?.error ? `${res.status}: ${body.error}` : `${res.status} ${res.statusText}`);
  }
  return res.json();
}
