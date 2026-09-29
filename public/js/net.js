import { store } from './store.js';

// WebSocket link to the local server with automatic reconnect.
let ws = null;
let retry = 0;

export function connect() {
  const proto = location.protocol === 'https:' ? 'wss' : 'ws';
  ws = new WebSocket(`${proto}://${location.host}/ws`);
  store.emit('conn', 'connecting');

  ws.onopen = () => {
    retry = 0;
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
      case 'init': store.init(msg); break;
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
    setTimeout(connect, Math.min(8000, 500 * 2 ** Math.min(retry, 4)));
  };
  ws.onerror = () => ws.close();
}

export function command(cmd, agentId) {
  if (ws && ws.readyState === 1) ws.send(JSON.stringify({ type: 'command', cmd, agentId }));
}

export async function api(path, opts = {}) {
  const res = await fetch(path, {
    ...opts,
    headers: { 'Content-Type': 'application/json', ...(opts.headers || {}) },
  });
  if (!res.ok) throw new Error(`${res.status} ${res.statusText}`);
  return res.json();
}
