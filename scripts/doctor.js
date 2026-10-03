#!/usr/bin/env node
// Connection doctor: checks every link the floor depends on and says, in plain words, what
// is wrong and how to fix it. Run it while the floor is running (npm start in another
// Terminal window):  npm run doctor
//
// It only reads. It never sends anything to MT5 or TradingView and never places a trade.

import http from 'node:http';
import WebSocket from 'ws';
import { config, ROOT } from '../server/config.js';

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
      bad(`The floor is not running on port ${PORT}, so MT5 has nothing to connect to.`);
      const fs = await import('node:fs');
      const service = process.platform === 'darwin' ? await import('./service.js') : null;
      if (service && fs.existsSync(service.plistPath())) {
        tip('The background service is installed but the floor isn\'t up. See why with: npm run service -- status');
        if (service.protectedFolder(ROOT)) tip(`Fix: npm run service -- install   (macOS doesn't let services run from your ${service.protectedFolder(ROOT)}; this moves the floor to your home folder)`);
      } else tip('Start it with: npm start   (or run it non-stop: npm run service -- install), then run npm run doctor again');
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
  if (process.platform === 'darwin') {
    const { plistPath } = await import('./service.js');
    const fs = await import('node:fs');
    if (h.service) good('It runs non-stop as a background service: starts at login, restarts itself if it stops.');
    else if (fs.existsSync(plistPath())) warn('It runs in a Terminal window, not as the background service you installed: closing that window stops it. Check the service: npm run service -- status');
    else warn('It runs in a Terminal window only: closing that window stops the floor. To run it non-stop: npm run service -- install');
  }
  for (const n of h.notes || []) if (/Waiting for real prices/.test(n)) warn(n);

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
      else if (!live.armed) {
        const why = live.profile.stayArmed
          ? (live.rememberedArmed ? ' yet (Stay armed is on: it arms again by itself once every check passes)' : '')
          : ' (after a restart it waits for you, unless "Stay armed after a restart" is on)';
        warn(`Live trading is not armed${why}: FTMO tab → Arm live trading.`);
      } else good('Live trading is armed.');
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
    // Old code and "not trading at all" are said below, with the rest of what the floor is doing.
    const said = (x) => /demo mode|still running the code from before your last git pull|aren't trading at all/.test(x);
    for (const w of (live.warnings || []).filter((x) => !said(x)).slice(0, 4)) {
      if (live.bridgeIssue && w === live.bridgeIssue.text) continue;
      // The waiting markets are listed above; only the advice on fixing them is new here.
      if (/^No real prices/.test(w)) {
        const fix = w.match(/[^.]* mapped to a symbol on your broker[^.]*\./)?.[0];
        if (fix) tip(fix.trim());
        continue;
      }
      warn(w);
    }
  }

  // 5. Is it doing its job: trades reaching FTMO, and whatever stops them.
  console.log('');
  if (h.stale) {
    bad('The floor is still running the code from before your last git pull (the page is already the new one), so new buttons answer "404".');
    fixes.push('Load the new code: npm run service -- restart   (without the service: Ctrl+C in the floor window, then npm start)');
  }
  if (live?.mode === 'live' && live.connected && live.profile) {
    if (live.ftmoOnly) good('FTMO only is on: every trade the desks take goes to the FTMO account, nothing trades on paper.');
    else if (live.ftmoOnly === false) warn('FTMO only is off: the desks trade on paper too, and only some of their trades go to FTMO (FTMO tab → FTMO only).');
    if (live.ftmoOnlyBlock) {
      bad(`The desks aren't trading at all: ${live.ftmoOnlyBlock}.`);
      fixes.push(/armed/.test(live.ftmoOnlyBlock) ? 'FTMO tab → Arm live trading, and switch on "Stay armed after a restart" so restarts don\'t disarm it again.' : `FTMO tab: ${live.ftmoOnlyBlock}.`);
    }
    if (!live.profile.stayArmed) {
      warn('"Stay armed after a restart" is off: every restart (a git pull, the Mac restarting) leaves trading disarmed until you arm it again.');
      fixes.push('FTMO tab → switch on "Stay armed after a restart".');
    }
    const open = (live.positions || []).filter((x) => x.floor);
    if (open.length) good(`${open.length} floor position${open.length === 1 ? '' : 's'} open on MT5 now: ${open.map((x) => `${x.side} ${x.volume} ${x.symbol}`).join(', ')}.`);
    const t = live.today;
    if (t) {
      if (t.sent) good(`${t.sent} trade${t.sent === 1 ? '' : 's'} sent to FTMO today${t.failed ? `, ${t.failed} rejected by MT5` : ''}.`);
      else warn(`No trades sent to FTMO yet today${t.failed ? ` (${t.failed} rejected by MT5)` : ''}. A desk trades when its setup appears; the busy hours are the London and New York opens.`);
      if (t.held) {
        console.log(`      Held back today (${t.held}), most often:`);
        for (const [why, n] of (t.reasons || []).slice(0, 4)) console.log(`        ${String(n).padStart(4)} × ${why}`);
      }
    }
    // Each desk's market right now (crypto at the weekend) has to exist on the broker.
    for (const d of (live.desks || []).filter((x) => x.enabled && x.eligible && !x.brokerSymbol)) {
      warn(`${d.name} trades ${d.symbols?.[0] ?? 'a market'} right now, but it isn't mapped to a symbol on your broker, so it can't trade (FTMO tab → Edit setup → markets).`);
    }
  }
  const vault = json(await get('/api/vault', auth));
  if (vault?.enabled) {
    if (vault.lastError) {
      bad(`The Obsidian vault isn't being written: ${vault.lastError.text}`);
    } else if (vault.live) good(`The Obsidian vault is live: ${vault.notes.toLocaleString('en-US')} notes, last written ${vault.lastWrite ? ago(vault.lastWrite) : 'not yet'} (${vault.dir}).`);
  }
  const alerts = json(await get('/api/alerts', auth));
  if (alerts && !alerts.hasToken) warn('Phone alerts aren\'t set up (optional): FTMO tab → Alerts on your phone.');
  else if (alerts && !alerts.enabled) warn('Phone alerts are set up but switched off (FTMO tab → Alerts on your phone).');
  else if (alerts) good(`Phone alerts are on${alerts.chatName ? ` (to ${alerts.chatName})` : ''}.`);

  // 6. TradingView.
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
