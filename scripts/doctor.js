#!/usr/bin/env node
// Connection doctor: checks every link the floor depends on and says, in plain words, what
// is wrong and how to fix it. Run it while the floor is running (npm start in another
// Terminal window):  npm run doctor
//
// It only reads. It never sends anything to MT5 or TradingView and never places a trade.

import http from 'node:http';
import WebSocket from 'ws';
import { config } from '../server/config.js';

const PORT = config.port;
const HOST = `127.0.0.1:${PORT}`;
const good = (t) => console.log(`  ✓ ${t}`);
const warn = (t) => console.log(`  ▲ ${t}`);
const bad = (t) => console.log(`  ✗ ${t}`);
const tip = (t) => console.log(`      → ${t}`);
const fixes = [];

function get(path, headers = {}) {
  return new Promise((resolve) => {
    const req = http.request({ host: '127.0.0.1', port: PORT, path, headers: { Host: HOST, ...headers }, timeout: 8000 }, (res) => {
      let body = '';
      res.setEncoding('utf8');
      res.on('data', (c) => { body += c; });
      res.on('end', () => resolve({ status: res.statusCode, body }));
    });
    req.on('timeout', () => req.destroy(new Error('timed out')));
    req.on('error', (err) => resolve({ error: err }));
    req.end();
  });
}

const json = (r) => {
  try {
    return JSON.parse(r.body);
  } catch {
    return null;
  }
};
const ago = (t) => {
  const s = Math.round((Date.now() - t) / 1000);
  return s < 90 ? `${s}s ago` : s < 5400 ? `${Math.round(s / 60)} min ago` : `${Math.round(s / 3600)} h ago`;
};

async function main() {
  console.log(`\n  Trading floor · connection doctor (port ${PORT})\n`);

  // 1. Is the floor running?
  const health = await get('/api/health');
  if (health.error) {
    if (health.error.code === 'ECONNREFUSED') {
      bad(`The floor is not running on port ${PORT}.`);
      tip('Start it in another Terminal window with: npm start   (then run npm run doctor again)');
    } else bad(`Could not reach the floor: ${health.error.message}`);
    return;
  }
  const h = json(health);
  if (!h?.ok) {
    bad(`Something else is answering on port ${PORT} (HTTP ${health.status}), not the floor.`);
    tip(`Quit the other app, or start the floor on another port: PORT=3100 npm start`);
    return;
  }
  good(`The floor is running (${h.mode === 'sim' ? 'demo mode, simulated prices' : 'live mode'}, up ${Math.round(h.uptime / 60)} min).`);
  for (const n of h.notes || []) if (/Simulated/.test(n)) warn(n);

  // 2. The dashboard page and its key.
  const page = await get('/');
  const key = page.body?.match(/name="floor-key" content="([^"]+)"/)?.[1];
  if (!key) {
    bad(`The dashboard page did not load properly (HTTP ${page.status}).`);
    if (page.body) tip(page.body.slice(0, 200));
    return;
  }
  good('The dashboard page loads.');
  const auth = { 'X-Floor-Key': key };

  // 3. The live feed your browser uses.
  const ws = await new Promise((resolve) => {
    const sock = new WebSocket(`ws://${HOST}/ws?key=${encodeURIComponent(key)}`, { headers: { Origin: `http://${HOST}` } });
    const timer = setTimeout(() => { sock.terminate(); resolve('timed out'); }, 8000);
    sock.on('message', () => { clearTimeout(timer); sock.close(); resolve('ok'); });
    sock.on('unexpected-response', (q, res) => { clearTimeout(timer); resolve(`refused (HTTP ${res.statusCode})`); });
    sock.on('error', (err) => { clearTimeout(timer); resolve(err.message); });
  });
  if (ws === 'ok') good('The live feed (what your browser connects to) works.');
  else {
    bad(`The live feed does not connect: ${ws}.`);
    fixes.push('Reload the dashboard in your browser (Cmd+R). If it still says connecting, quit the browser tab and open http://localhost:' + PORT);
  }
  const guard = json(await get('/api/tradingview/config', auth));
  const recent = (guard?.guard?.recent || []).filter((r) => Date.now() - r.at < 15 * 60_000);
  const browserRefusals = recent.filter((r) => ['key', 'host', 'origin', 'network'].includes(r.kind));
  if (browserRefusals.length) {
    const r = browserRefusals.at(-1);
    const why = {
      key: 'a page with an old floor key (a tab opened before the floor restarted)',
      host: `an address the floor doesn't accept ("${r.host}")`,
      origin: 'another website (blocked on purpose)',
      network: `another device on your network (${r.ip})`,
    }[r.kind];
    warn(`${browserRefusals.length} request(s) refused in the last 15 min, last one from ${why}, ${ago(r.at)}.`);
    if (r.kind === 'key') fixes.push('Reload the dashboard tab (Cmd+R) so it picks up the new key.');
    if (r.kind === 'host') fixes.push(`Open the floor at http://localhost:${PORT} (not by another name or IP).`);
    if (r.kind === 'network') fixes.push('To open the dashboard from another device, set HOST=0.0.0.0 and FLOOR_PASSWORD=<10+ characters> in .env, then restart.');
  }

  // 4. MT5.
  const live = json(await get('/api/live', auth));
  if (!live) bad('Could not read the FTMO / MT5 status.');
  else {
    const url = `http://127.0.0.1:${PORT}/api/bridge/sync`;
    if (live.connected) {
      good(`MT5 is connected: account ${live.account?.login} on ${live.account?.server}, last sync ${ago(live.lastSync)}, EA ${live.eaVersion || 'unknown'}.`);
      if (!live.eaCaps) warn('The EA is an older version without the safety caps. Update it from the FTMO tab (Copy EA code → MetaEditor → Compile).');
      if (!live.profile) warn('The account is not set up yet: FTMO tab → Set up the account.');
      else if (!live.armed) warn('Live trading is not armed (it never is after a restart): FTMO tab → Arm live trading.');
      else good('Live trading is armed.');
      const desks = (live.desks || []).filter((d) => d.enabled);
      if (live.profile && !desks.length) warn('No desk is switched on for the account (FTMO tab → Desks on the account).');
      for (const d of desks) {
        const st = d.status;
        if (st) console.log(`      ${d.name.padEnd(18)} ${st.label}${st.state === 'live' || st.state === 'cleared' ? '' : `: ${st.text.replace(/^Paper only for now: /, '')}`}`);
      }
    } else if (live.bridgeIssue) {
      bad(`MT5 is reaching the floor but is being turned away: ${live.bridgeIssue.text}`);
      console.log(`      Bridge token: ${config.bridgeToken}`);
    } else if (live.lastSync) {
      bad(`MT5 was connected but stopped syncing ${ago(live.lastSync)}.`);
      fixes.push('Check that MT5 is open, logged in, the MeridianBridge EA is still on a chart (smiley face top-right), and Algo Trading is on.');
    } else {
      bad('MT5 has not connected since the floor started.');
      fixes.push(
        'In MT5, check each of these:\n'
        + `        1. Tools → Options → Expert Advisors: "Allow WebRequest for listed URL" is ticked and the list contains http://127.0.0.1:${PORT}\n`
        + '        2. The MeridianBridge EA is on a chart (drag it from Navigator → Expert Advisors) and shows a smiley/blue hat, top-right of the chart\n'
        + `        3. EA Inputs: Floor bridge URL = ${url}\n`
        + `        4. EA Inputs: Bridge token = ${config.bridgeToken}\n`
        + '        5. The "Algo Trading" button in the MT5 toolbar is on (green)\n'
        + '        6. The chart comment of the EA (top-left of the chart) says what went wrong, e.g. "WebRequest is blocked"',
      );
    }
    for (const w of (live.warnings || []).filter((x) => !/simulated prices|demo mode/.test(x)).slice(0, 4)) {
      if (live.bridgeIssue && w === live.bridgeIssue.text) continue;
      warn(w);
    }
  }

  // 5. TradingView.
  const tv = guard;
  if (tv) {
    const t = tv.tunnel || {};
    if (t.status === 'running') {
      good(`TradingView public address is up: ${t.webhookUrl}`);
      if (t.check?.status === 'failed') warn(`But the last connection test failed (${t.check.error}). TradingView tab → Test connection.`);
      if (t.urlChanged) warn('The address changed since your alerts were made: update the Webhook URL in your TradingView alerts.');
    } else if (t.status === 'error') {
      bad(`The TradingView public address is not running: ${t.error}`);
      fixes.push('TradingView tab → Try again (or use a permanent ngrok address).');
    } else warn('No public address for TradingView yet (TradingView tab → Create public address). Only needed for TradingView alerts.');
    const fw = tv.firewall;
    if (fw?.alarm) bad(`Security alarm: ${fw.alarm.text}`);
    const refused = (fw?.events || []).filter((e) => Date.now() - e.time < 24 * 3_600_000 && e.kind === 'leak');
    if (refused.length && !fw.alarm) warn(`${refused.length} alert(s) with your secret came from outside TradingView today and were refused (TradingView tab → Firewall).`);
  }

  if (fixes.length) {
    console.log('\n  What to do:');
    for (const f of fixes) console.log(`   • ${f}`);
  } else console.log('\n  Everything the floor can check from here looks fine.');
  console.log('');
}

main().catch((err) => {
  console.error(`  The doctor itself failed: ${err.message}`);
  process.exitCode = 1;
});
