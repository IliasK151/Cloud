import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import express from 'express';
import WebSocket from 'ws';

import { LocalGuard, parseHost, isLoopbackAddress } from '../server/security/localGuard.js';
import { WebhookFirewall, TRADINGVIEW_IPS } from '../server/security/webhookFirewall.js';
import { parseBody, normalizeAlert, alertSecret } from '../server/tradingview/webhook.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const quiet = { info() {}, warn() {} };

// Raw HTTP so tests can send exactly what a browser (or an attacker) would, Host included.
function request(port, { method = 'GET', path: p = '/', headers = {}, body = null } = {}) {
  return new Promise((resolve, reject) => {
    const req = http.request({ host: '127.0.0.1', port, method, path: p, headers }, (res) => {
      let data = '';
      res.setEncoding('utf8');
      res.on('data', (c) => { data += c; });
      res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, body: data }));
    });
    req.on('error', reject);
    if (body != null) req.write(body);
    req.end();
  });
}

function listen(app) {
  return new Promise((resolve) => {
    const server = http.createServer(app).listen(0, '127.0.0.1', () => resolve(server));
  });
}

// ---- the local firewall ------------------------------------------------------------------------
async function guarded(options = {}) {
  const probe = await listen(express());
  const port = probe.address().port;
  probe.close();
  const guard = new LocalGuard({ port, ...options });
  const app = express();
  app.use(guard.middleware({ exempt: ['/api/bridge/sync'] }));
  app.get('/', (req, res) => guard.sendIndex(req, res, '<!doctype html><html><head><script type="importmap">{}</script></head><body><script type="module" src="/x.js"></script></body></html>'));
  app.get('/api/secret-stuff', (req, res) => res.json({ ok: true, token: 'bridge-token' }));
  app.post('/api/live/kill', (req, res) => res.json({ ok: true, killed: true }));
  app.post('/api/bridge/sync', (req, res) => res.type('text').send('OK'));
  const server = await new Promise((resolve) => { const s = http.createServer(app).listen(port, '127.0.0.1', () => resolve(s)); });
  const host = `127.0.0.1:${port}`;
  return { guard, server, port, host, close: () => server.close() };
}

test('local firewall: DNS rebinding, cross-site requests and missing keys are refused', async () => {
  const g = await guarded();
  try {
    // A rebound domain pointing at 127.0.0.1 still says so in its Host header.
    assert.equal((await request(g.port, { headers: { Host: `evil.example:${g.port}` } })).status, 403);
    assert.equal((await request(g.port, { path: '/api/secret-stuff', headers: { Host: `evil.example:${g.port}`, 'X-Floor-Key': g.guard.key } })).status, 403);
    // The page itself carries the key, a script nonce and strict headers.
    const page = await request(g.port, { headers: { Host: g.host } });
    assert.equal(page.status, 200);
    assert.match(page.body, new RegExp(`name="floor-key" content="${g.guard.key}"`));
    const nonce = page.headers['content-security-policy'].match(/'nonce-([^']+)'/)[1];
    assert.equal((page.body.match(new RegExp(`<script nonce="${nonce.replace(/[+/=]/g, '\\$&')}"`, 'g')) || []).length, 2);
    assert.match(page.headers['content-security-policy'], /frame-ancestors 'none'/);
    assert.doesNotMatch(page.headers['content-security-policy'], /script-src[^;]*unsafe-inline/);
    assert.equal(page.headers['x-frame-options'], 'DENY');
    assert.equal(page.headers['referrer-policy'], 'no-referrer');
    // API: no key, wrong key, or another site's request → refused.
    assert.equal((await request(g.port, { path: '/api/secret-stuff', headers: { Host: g.host } })).status, 401);
    assert.equal((await request(g.port, { path: '/api/secret-stuff', headers: { Host: g.host, 'X-Floor-Key': 'guess' } })).status, 401);
    const csrf = await request(g.port, { method: 'POST', path: '/api/live/kill', headers: { Host: g.host, Origin: 'http://evil.example', 'Content-Type': 'text/plain', 'X-Floor-Key': g.guard.key }, body: 'x' });
    assert.equal(csrf.status, 403);
    assert.equal((await request(g.port, { method: 'POST', path: '/api/live/kill', headers: { Host: g.host, 'Sec-Fetch-Site': 'cross-site', 'X-Floor-Key': g.guard.key } })).status, 403);
    // The page's own requests work.
    const ok = await request(g.port, { method: 'POST', path: '/api/live/kill', headers: { Host: g.host, Origin: `http://${g.host}`, 'Sec-Fetch-Site': 'same-origin', 'X-Floor-Key': g.guard.key } });
    assert.equal(ok.status, 200);
    assert.equal(ok.headers['cache-control'], 'no-store');
    // The MT5 bridge has its own token and is exempt from the floor key.
    assert.equal((await request(g.port, { method: 'POST', path: '/api/bridge/sync', headers: { Host: g.host } })).status, 200);
    // localhost and ::1 are the same Mac.
    assert.equal((await request(g.port, { path: '/api/secret-stuff', headers: { Host: `localhost:${g.port}`, 'X-Floor-Key': g.guard.key } })).status, 200);
  } finally {
    g.close();
  }
});

test('local firewall: the live feed needs this page\'s origin and the key', () => {
  const guard = new LocalGuard({ port: 3000 });
  const req = (url, headers) => ({ url, headers: { host: '127.0.0.1:3000', ...headers }, socket: { remoteAddress: '127.0.0.1' } });
  assert.equal(guard.upgradeOk(req(`/ws?key=${guard.key}`, { origin: 'http://evil.example' })), 'origin');
  assert.equal(guard.upgradeOk(req(`/ws?key=${guard.key}`, {})), 'origin', 'browsers always send an Origin');
  assert.equal(guard.upgradeOk(req('/ws?key=nope', { origin: 'http://127.0.0.1:3000' })), 'key');
  assert.equal(guard.upgradeOk(req(`/ws?key=${guard.key}`, { origin: 'http://127.0.0.1:3000', host: 'rebound.example:3000' })), 'host');
  assert.equal(guard.upgradeOk(req(`/ws?key=${guard.key}`, { origin: 'http://127.0.0.1:3000' })), null);
  assert.equal(guard.upgradeOk(req(`/other?key=${guard.key}`, { origin: 'http://127.0.0.1:3000' })), 'not found');
  assert.deepEqual(parseHost('[::1]:3000'), { name: '::1', port: 3000 });
  assert.equal(isLoopbackAddress('::ffff:127.0.0.1'), true);
  assert.equal(isLoopbackAddress('192.168.1.4'), false);
});

test('other machines reach only the MT5 bridge unless a password is set; a Host without port is fine', async () => {
  const probe = await listen(express());
  const port = probe.address().port;
  probe.close();
  const guard = new LocalGuard({ port, isLocal: () => false, networkPaths: ['/api/bridge/sync'] });
  const app = express();
  app.use(guard.middleware());
  app.get('/', (req, res) => guard.sendIndex(req, res, '<html><head></head><body></body></html>'));
  app.post('/api/bridge/sync', (req, res) => res.type('text').send('OK'));
  const server = await new Promise((resolve) => { const s = http.createServer(app).listen(port, '127.0.0.1', () => resolve(s)); });
  try {
    // MT5 in a Windows VM: any Host, the bridge answers (it checks its own token).
    assert.equal((await request(port, { method: 'POST', path: '/api/bridge/sync', headers: { Host: `10.211.55.2:${port}` } })).status, 200);
    const page = await request(port, { headers: { Host: `127.0.0.1:${port}` } });
    assert.equal(page.status, 403);
    assert.match(page.body, /only opens on the Mac/);
    assert.equal(guard.refusals().at(-1).kind, 'network');
  } finally {
    server.close();
  }
  const local = new LocalGuard({ port: 3000 });
  assert.equal(local.hostOk({ headers: { host: '127.0.0.1' } }), true, 'no port in the Host header');
  assert.equal(local.hostOk({ headers: { host: 'evil.example' } }), false);
  assert.equal(local.hostOk({ headers: { host: '127.0.0.1:4444' } }), false);
});

test('Wi-Fi access needs the password; wrong passwords lock the device out', async () => {
  const g = await guarded({ password: 'correct horse battery', isLocal: () => false });
  const form = (password) => request(g.port, { method: 'POST', path: '/login', headers: { Host: g.host, Origin: `http://${g.host}`, 'Content-Type': 'application/x-www-form-urlencoded' }, body: `password=${encodeURIComponent(password)}` });
  try {
    const home = await request(g.port, { headers: { Host: g.host } });
    assert.equal(home.status, 303);
    assert.equal(home.headers.location, '/login');
    assert.equal((await request(g.port, { path: '/api/secret-stuff', headers: { Host: g.host, 'X-Floor-Key': g.guard.key } })).status, 401, 'even with the key');
    assert.equal((await form('nope')).status, 401);
    const good = await form('correct horse battery');
    assert.equal(good.status, 303);
    const cookie = good.headers['set-cookie'][0];
    assert.match(cookie, /HttpOnly; SameSite=Strict/);
    const sid = cookie.split(';')[0];
    const page = await request(g.port, { headers: { Host: g.host, Cookie: sid } });
    assert.equal(page.status, 200);
    assert.match(page.body, /floor-key/);
    // Five wrong passwords: locked out, even with the right one.
    for (let i = 0; i < 5; i++) await form('wrong');
    assert.equal((await form('correct horse battery')).status, 429);
  } finally {
    g.close();
  }
});

// ---- the webhook firewall ----------------------------------------------------------------------
test('webhook firewall: real client address behind the tunnel, never spoofable from outside', () => {
  const fw = new WebhookFirewall({ log: quiet });
  const req = (remoteAddress, headers = {}) => ({ socket: { remoteAddress }, headers });
  assert.deepEqual(fw.clientIp(req('127.0.0.1', { 'cf-connecting-ip': '52.89.214.238' })), { ip: '52.89.214.238', local: false, via: 'cloudflare' });
  assert.equal(fw.clientIp(req('127.0.0.1', { 'x-forwarded-for': '1.1.1.1, 203.0.113.5' })).ip, '203.0.113.5', 'the proxy\'s own entry, not the client-supplied one');
  assert.equal(fw.clientIp(req('127.0.0.1')).local, true);
  // From another machine the forwarding headers are ignored.
  assert.deepEqual(fw.clientIp(req('192.168.1.50', { 'cf-connecting-ip': '52.89.214.238' })), { ip: '192.168.1.50', local: false, via: 'direct' });
});

test('webhook firewall: wrong secrets get banned, leaked secrets raise the alarm, TradingView trades pass', () => {
  let t = 1_000_000;
  const file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'fw-')), 'security-log.json');
  const fw = new WebhookFirewall({ log: quiet, now: () => t, file });
  const attacker = { ip: '203.0.113.9', local: false };
  for (let i = 0; i < 4; i++) assert.equal(fw.badSecret(attacker).status, 401);
  assert.equal(fw.admit(attacker).ok, true);
  fw.badSecret(attacker);
  assert.equal(fw.admit(attacker).status, 403, 'banned after 5 wrong secrets');
  assert.equal(fw.view().bans[0].ip, attacker.ip);
  t += 61 * 60_000;
  assert.equal(fw.admit(attacker).ok, true, 'the ban lasts an hour');

  // The right secret from somewhere that isn't TradingView: refused, alarm raised.
  const alarms = [];
  fw.on('alarm', (a) => alarms.push(a));
  assert.equal(fw.authorize({ ip: '198.51.100.7', local: false }, 'buy').status, 403);
  assert.equal(alarms.length, 1);
  assert.equal(fw.view().status, 'alarm');
  assert.equal(fw.authorize({ ip: '198.51.100.7', local: false }, 'ping').ok, true, 'connection checks work from anywhere');
  assert.equal(fw.authorize({ ip: TRADINGVIEW_IPS[0], local: false }, 'buy').ok, true);
  assert.equal(fw.authorize({ ip: '127.0.0.1', local: true }, 'buy').ok, true, 'tests from this Mac');
  fw.secretRotated();
  assert.equal(fw.view().alarm, null);

  // Flood limit per address.
  const flood = { ip: '203.0.113.77', local: false };
  let limited = 0;
  for (let i = 0; i < 40; i++) if (fw.admit(flood).status === 429) limited++;
  assert.equal(limited, 10);

  // The setting and the log survive a restart.
  fw.setSettings({ tradingViewOnly: false });
  fw.flush();
  const again = new WebhookFirewall({ log: quiet, file });
  assert.equal(again.settings.tradingViewOnly, false);
  assert.ok(again.view().events.some((e) => e.kind === 'ban'));
  assert.equal(fs.statSync(file).mode & 0o777, 0o600);
});

test('alert parsing: crafted keys and actions are plain data, prices must be real numbers', () => {
  const raw = parseBody('{"secret":"s","action":"constructor","__proto__":{"action":"buy"}}');
  assert.equal(normalizeAlert(raw).ok, false);
  assert.equal(normalizeAlert({ secret: 's', action: 'toString' }).ok, false);
  assert.equal({}.action, undefined, 'no prototype pollution');
  const a = normalizeAlert({ secret: 's', action: 'buy', stop: -5, target: 'NaN', price: '1,234.5', comment: 'x'.repeat(500), symbol: 'Y'.repeat(300) });
  assert.equal(a.ok, true);
  assert.equal(a.alert.stop, undefined);
  assert.equal(a.alert.target, undefined);
  assert.equal(a.alert.price, 1234.5);
  assert.equal(a.alert.comment.length, 120);
  assert.equal(a.alert.rawSymbol.length, 40);
  assert.equal(alertSecret({ PassPhrase: 'abc' }), 'abc');
  assert.equal(alertSecret({ secret: { $gt: '' } }), '', 'only strings count as a secret');
  assert.equal(parseBody('[1,2,3]'), null);
});

// ---- the whole floor, attacked from outside ------------------------------------------------------
test('the running floor refuses the attacks end to end', { timeout: 90_000 }, async () => {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'floor-sec-'));
  const base = 42_000 + Math.floor(Math.random() * 2000) * 3;
  const env = { ...process.env, DATA_DIR: dataDir, PORT: String(base), WEBHOOK_PORT: String(base + 1), WIDGET_PORT: String(base + 2), OPEN_BROWSER: '0', CI: '1', FEED: 'sim', HOST: '0.0.0.0', FLOOR_PASSWORD: '' };
  const child = spawn(process.execPath, [path.join(ROOT, 'server/index.js')], { env, stdio: ['ignore', 'pipe', 'pipe'] });
  let out = '';
  child.stdout.on('data', (d) => { out += d; });
  child.stderr.on('data', (d) => { out += d; });
  try {
    const deadline = Date.now() + 60_000;
    while (!/Floor & dashboard/.test(out) && Date.now() < deadline) await new Promise((r) => setTimeout(r, 200));
    assert.match(out, /stays on this Mac/, 'no password: the dashboard is not opened to the network');
    assert.doesNotMatch(out, new RegExp(fs.readFileSync(path.join(dataDir, 'webhook-secret.txt'), 'utf8').trim()), 'the secret stays off the terminal');
    const host = `127.0.0.1:${base}`;
    const page = await request(base, { headers: { Host: host } });
    const key = page.body.match(/name="floor-key" content="([^"]+)"/)[1];
    const secret = fs.readFileSync(path.join(dataDir, 'webhook-secret.txt'), 'utf8').trim();

    // A web page trying to fire a trade, kill positions or read the bridge token.
    assert.equal((await request(base, { method: 'POST', path: '/api/tradingview/test', headers: { Host: host, Origin: 'http://evil.example', 'Content-Type': 'text/plain' }, body: 'x' })).status, 403);
    assert.equal((await request(base, { method: 'POST', path: '/api/live/kill', headers: { Host: host } })).status, 401);
    assert.equal((await request(base, { path: '/api/live', headers: { Host: `evil.example:${base}` } })).status, 403);
    const ws = await new Promise((resolve) => {
      const s = new WebSocket(`ws://127.0.0.1:${base}/ws`, { headers: { Origin: 'http://evil.example' } });
      s.on('unexpected-response', (q, res) => resolve(res.statusCode));
      s.on('open', () => resolve('open'));
      s.on('error', () => resolve('error'));
    });
    assert.equal(ws, 403);
    // The page itself works.
    const live = await request(base, { path: '/api/live', headers: { Host: host, 'X-Floor-Key': key } });
    assert.equal(live.status, 200);

    // The internet side: the webhook port only.
    const hook = (ip, body) => request(base + 1, { method: 'POST', path: '/webhook', headers: { 'CF-Connecting-IP': ip, 'Content-Type': 'text/plain' }, body: JSON.stringify(body) });
    assert.equal((await request(base + 1, { path: '/api/live' })).status, 404);
    assert.equal((await hook('198.51.100.7', { secret, action: 'buy', agent: 'chen' })).status, 403, 'right secret, not TradingView');
    assert.equal((await hook(TRADINGVIEW_IPS[1], { secret, action: 'ping' })).status, 200);
    // Through the firewall to the desk (whether the desk trades it depends on the market).
    const fromTv = await hook(TRADINGVIEW_IPS[1], { secret, action: 'buy', agent: 'chen' });
    assert.equal(fromTv.status, 200);
    assert.equal(typeof JSON.parse(fromTv.body).result, 'string', 'answered by the desk, not refused by the firewall');
    for (let i = 0; i < 5; i++) await hook('203.0.113.9', { secret: 'guess', action: 'buy' });
    assert.equal((await hook('203.0.113.9', { secret, action: 'ping' })).status, 403, 'banned');
    const big = await request(base + 1, { method: 'POST', path: '/webhook', headers: { 'CF-Connecting-IP': TRADINGVIEW_IPS[0], 'Content-Type': 'text/plain' }, body: 'x'.repeat(20_000) });
    assert.equal(big.status, 413);
    const untyped = await request(base + 1, { method: 'POST', path: '/webhook', headers: { 'CF-Connecting-IP': TRADINGVIEW_IPS[0] }, body: 'x'.repeat(20_000) });
    assert.equal(untyped.status, 401, 'not even read');
    assert.doesNotMatch(big.body, /at |node_modules|Error:/, 'no stack traces');

    // MT5: a wrong token says why (FTMO tab / doctor) and never locks the right one out.
    const sync = (token) => request(base, { method: 'POST', path: '/api/bridge/sync', headers: { Host: host, 'Content-Type': 'application/json' }, body: JSON.stringify({ token, account: { login: 1, server: 'X' } }) });
    for (let i = 0; i < 25; i++) assert.equal((await sync('wrong')).status, 401);
    const issue = JSON.parse((await request(base, { path: '/api/live', headers: { Host: host, 'X-Floor-Key': key } })).body).bridgeIssue;
    assert.equal(issue.kind, 'token');
    assert.match(issue.text, /bridge token is wrong/);
    const bridgeToken = fs.readFileSync(path.join(dataDir, 'bridge-token.txt'), 'utf8').trim();
    assert.equal((await sync(bridgeToken)).status, 200, 'the right token works straight away');
    assert.equal(JSON.parse((await request(base, { path: '/api/live', headers: { Host: host, 'X-Floor-Key': key } })).body).bridgeIssue, null);

    // Secrets on disk: readable by this user only.
    assert.equal(fs.statSync(dataDir).mode & 0o777, 0o700);
    assert.equal(fs.statSync(path.join(dataDir, 'webhook-secret.txt')).mode & 0o777, 0o600);
  } finally {
    child.kill('SIGINT');
    await new Promise((r) => child.once('exit', r));
  }
});

test('the non-stop service: a LaunchAgent that runs node directly, restarts it, never opens a browser', async () => {
  const { plistFor, LABEL } = await import('../scripts/service.js');
  const xml = plistFor({ root: '/Users/me/Desktop/trading & floor', node: '/opt/homebrew/bin/node', logDir: '/Users/me/Desktop/trading & floor/data/logs' });
  assert.match(xml, new RegExp(`<string>${LABEL.replace(/\./g, '\\.')}</string>`));
  // node itself is the program (a stop reaches it, so it closes its FTMO positions cleanly).
  assert.match(xml, /<array>\s*<string>\/opt\/homebrew\/bin\/node<\/string>\s*<string>\/Users\/me\/Desktop\/trading &amp; floor\/server\/index\.js<\/string>\s*<\/array>/);
  assert.match(xml, /<key>KeepAlive<\/key>\s*<true\/>/);
  assert.match(xml, /<key>RunAtLoad<\/key>\s*<true\/>/);
  assert.match(xml, /<key>OPEN_BROWSER<\/key>\s*<string>0<\/string>/);
  assert.match(xml, /<key>FLOOR_SERVICE<\/key>\s*<string>1<\/string>/);
  assert.match(xml, /trading &amp; floor\/data\/logs\/floor\.log/);
  assert.ok(!/trading & floor/.test(xml), 'paths are XML-escaped');
});
