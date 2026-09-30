import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import crypto from 'node:crypto';
import os from 'node:os';
import path from 'node:path';
import { EventEmitter } from 'node:events';
import { TunnelManager, QUICK_URL } from '../server/tradingview/tunnel.js';
import { normalizeAlert } from '../server/tradingview/webhook.js';

const quiet = { info() {}, warn() {} };
const tmpDir = () => fs.mkdtempSync(path.join(os.tmpdir(), 'tv-'));

// A stand-in for the cloudflared process.
function fakeProcess() {
  const child = new EventEmitter();
  child.stdout = new EventEmitter();
  child.stderr = new EventEmitter();
  child.kill = () => setImmediate(() => child.emit('exit', 0));
  return child;
}

const okFetch = (calls = []) => async (url, opts) => {
  calls.push({ url, body: opts?.body });
  return { ok: true, status: 200, json: async () => ({ ok: true }) };
};

const waitFor = async (fn, ms = 2000) => {
  const t0 = Date.now();
  while (!fn()) {
    if (Date.now() - t0 > ms) throw new Error('timed out');
    await new Promise((r) => setTimeout(r, 10));
  }
};

test('quick tunnel addresses are recognised in cloudflared output', () => {
  const line = '2026-09-30T10:00:00Z INF |  https://calm-river-proud-sun.trycloudflare.com                              |';
  assert.equal(line.match(QUICK_URL)[0], 'https://calm-river-proud-sun.trycloudflare.com');
  assert.equal('INF Requesting new quick Tunnel on trycloudflare.com...'.match(QUICK_URL), null);
});

test('ping alerts are connection checks, never trades', () => {
  const a = normalizeAlert({ secret: 'x', action: 'ping' });
  assert.equal(a.ok, true);
  assert.equal(a.alert.action, 'ping');
});

test('one-click tunnel: starts cloudflared, publishes the webhook URL and checks it', async () => {
  const dir = tmpDir();
  const bin = path.join(dir, 'cloudflared');
  fs.writeFileSync(bin, '#!/bin/sh\n', { mode: 0o755 });
  process.env.CLOUDFLARED = bin;
  const child = fakeProcess();
  const spawned = [];
  const calls = [];
  const t = new TunnelManager({ dataDir: dir, port: 3001, secret: 's3cret', log: quiet, fetchImpl: okFetch(calls), spawnImpl: (b, args) => { spawned.push([b, args]); return child; } });
  await t.start('cloudflare');
  assert.equal(spawned[0][0], bin);
  assert.deepEqual(spawned[0][1], ['tunnel', '--no-autoupdate', '--url', 'http://127.0.0.1:3001']);
  assert.equal(t.state.status, 'starting');
  child.stderr.emit('data', Buffer.from('INF +----+\nINF |  https://abc-def.trycloudflare.com   |\n'));
  assert.equal(t.state.status, 'running');
  assert.equal(t.webhookUrl, 'https://abc-def.trycloudflare.com/webhook');
  const check = await t.check({ attempts: 1 });
  assert.equal(check.status, 'ok');
  assert.equal(calls.at(-1).url, 'https://abc-def.trycloudflare.com/webhook');
  assert.deepEqual(JSON.parse(calls.at(-1).body), { secret: 's3cret', action: 'ping' });
  // Settings persist so the tunnel comes back on the next launch.
  const saved = JSON.parse(fs.readFileSync(path.join(dir, 'tradingview.json'), 'utf8'));
  assert.equal(saved.autoStart, true);
  assert.equal(saved.provider, 'cloudflare');
  assert.equal(saved.lastUrl, 'https://abc-def.trycloudflare.com');
  await t.stop();
  assert.equal(t.state.status, 'off');
  assert.equal(JSON.parse(fs.readFileSync(path.join(dir, 'tradingview.json'), 'utf8')).autoStart, false);
  delete process.env.CLOUDFLARED;
});

test('a dropped tunnel restarts, and a new address after alerts were flowing is flagged', async () => {
  const dir = tmpDir();
  const bin = path.join(dir, 'cloudflared');
  fs.writeFileSync(bin, '#!/bin/sh\n', { mode: 0o755 });
  process.env.CLOUDFLARED = bin;
  const children = [];
  const t = new TunnelManager({ dataDir: dir, port: 3001, secret: 's', log: quiet, fetchImpl: okFetch(), spawnImpl: () => { const c = fakeProcess(); children.push(c); return c; } });
  await t.start('cloudflare');
  children[0].stdout.emit('data', 'https://first-one.trycloudflare.com\n');
  t.noteAlert({ action: 'buy', symbol: 'XAUUSD', agent: 'amara' }, { ok: true });
  assert.equal(t.state.urlChanged, false);
  children[0].emit('exit', 1); // e.g. the Mac slept
  assert.equal(t.state.status, 'starting');
  await waitFor(() => children.length === 2, 5000);
  children[1].stdout.emit('data', 'https://second-one.trycloudflare.com\n');
  assert.equal(t.state.url, 'https://second-one.trycloudflare.com');
  assert.equal(t.state.urlChanged, true);
  t.ackUrlChange();
  assert.equal(t.state.urlChanged, false);
  await t.stop();
  delete process.env.CLOUDFLARED;
});

test('Ctrl+C ends the tunnel quietly: no restart while the floor shuts down', async () => {
  const dir = tmpDir();
  const bin = path.join(dir, 'cloudflared');
  fs.writeFileSync(bin, '#!/bin/sh\n', { mode: 0o755 });
  process.env.CLOUDFLARED = bin;
  const children = [];
  const warnings = [];
  const t = new TunnelManager({ dataDir: dir, port: 3001, secret: 's', log: { info() {}, warn: (m) => warnings.push(m) }, fetchImpl: okFetch(), spawnImpl: () => { const c = fakeProcess(); children.push(c); return c; } });
  await t.start('cloudflare');
  children[0].stdout.emit('data', 'https://first-one.trycloudflare.com\n');
  // Terminal delivers Ctrl+C to cloudflared too, so it can exit before stop() is reached.
  t.shuttingDown();
  children[0].emit('exit', null, 'SIGINT');
  await new Promise((r) => setTimeout(r, 50));
  assert.equal(children.length, 1, 'not restarted');
  assert.equal(warnings.filter((w) => /restarting/.test(w)).length, 0);
  await t.stop({ keepAuto: true });
  assert.equal(JSON.parse(fs.readFileSync(path.join(dir, 'tradingview.json'), 'utf8')).autoStart, true, 'comes back on the next launch');
  delete process.env.CLOUDFLARED;
});

test('cloudflared is downloaded when it is not installed', { skip: process.platform !== 'linux' || process.arch !== 'x64' }, async () => {
  const dir = tmpDir();
  const oldPath = process.env.PATH;
  process.env.PATH = dir; // hide any real cloudflared
  const payload = Buffer.from('#!/bin/sh\necho fake\n');
  const official = 'https://github.com/cloudflare/cloudflared/releases/download/2026.9.0/cloudflared-linux-amd64';
  let digest = crypto.createHash('sha256').update(payload).digest('hex');
  const fetchImpl = async (url) => {
    if (url.includes('api.github.com')) {
      return { ok: true, status: 200, json: async () => ({ tag_name: '2026.9.0', assets: [{ name: 'cloudflared-linux-amd64', browser_download_url: official, digest: `sha256:${digest}` }] }) };
    }
    assert.equal(url, official, 'downloads the exact release file GitHub lists');
    return { ok: true, status: 200, headers: new Map([['content-length', String(payload.length)]]), body: (async function* () { yield payload; })() };
  };
  const child = fakeProcess();
  let spawnedBin = null;
  const t = new TunnelManager({ dataDir: dir, port: 3001, secret: 's', log: quiet, fetchImpl, spawnImpl: (b) => { spawnedBin = b; return child; } });
  t.findCloudflared = function () { return fs.existsSync(path.join(dir, 'bin', 'cloudflared')) ? path.join(dir, 'bin', 'cloudflared') : null; };
  await t.start('cloudflare');
  process.env.PATH = oldPath;
  assert.equal(spawnedBin, path.join(dir, 'bin', 'cloudflared'));
  assert.equal(fs.statSync(spawnedBin).mode & 0o100, 0o100);
  await t.stop();

  // A tampered download (checksum mismatch) is deleted and never run.
  fs.rmSync(path.join(dir, 'bin'), { recursive: true, force: true });
  digest = '0'.repeat(64);
  spawnedBin = null;
  await assert.rejects(() => t.start('cloudflare'), /integrity check/);
  assert.equal(spawnedBin, null);
  assert.equal(fs.existsSync(path.join(dir, 'bin', 'cloudflared')), false);
  assert.deepEqual(fs.readdirSync(path.join(dir, 'bin')), []);
});

test('ngrok needs an authtoken before it starts', async () => {
  const t = new TunnelManager({ dataDir: tmpDir(), port: 3001, secret: 's', log: quiet, fetchImpl: okFetch() });
  await assert.rejects(() => t.start('ngrok', { authtoken: '' }), /authtoken/);
  assert.equal(t.view().ngrok.hasToken, false);
});
