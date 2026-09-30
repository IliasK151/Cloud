import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { spawn, execFile } from 'node:child_process';
import { EventEmitter } from 'node:events';

// Gives the webhook-only port a public HTTPS address so TradingView can reach it.
//
//  - "cloudflare": a Cloudflare quick tunnel. No account needed. Uses the `cloudflared` app
//    (found on the Mac, or downloaded once from Cloudflare's official GitHub releases into
//    data/bin). The address changes each time the tunnel starts.
//  - "ngrok": a free ngrok account's static domain through the @ngrok/ngrok SDK. The address
//    never changes, so TradingView alerts never need editing.
//
// Only the webhook port (POST /webhook) is exposed; the dashboard and its controls stay local.

export const QUICK_URL = /https:\/\/[-a-z0-9]+\.trycloudflare\.com/i;

const ASSETS = {
  'darwin-arm64': 'cloudflared-darwin-arm64.tgz',
  'darwin-x64': 'cloudflared-darwin-amd64.tgz',
  'linux-x64': 'cloudflared-linux-amd64',
  'linux-arm64': 'cloudflared-linux-arm64',
  'win32-x64': 'cloudflared-windows-amd64.exe',
};
const RELEASES = 'https://github.com/cloudflare/cloudflared/releases/latest/download/';
const RELEASE_API = 'https://api.github.com/repos/cloudflare/cloudflared/releases/latest';
const OFFICIAL = 'https://github.com/cloudflare/cloudflared/releases/download/';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

export class TunnelManager extends EventEmitter {
  constructor({ dataDir, port, secret, log = console, fetchImpl = globalThis.fetch, spawnImpl = spawn }) {
    super();
    this.dataDir = dataDir;
    this.port = port;
    this.secret = secret;
    this.log = log;
    this.fetch = fetchImpl;
    this.spawn = spawnImpl;
    this.file = path.join(dataDir, 'tradingview.json');
    this.binDir = path.join(dataDir, 'bin');
    this.settings = { provider: null, autoStart: false, ngrok: { authtoken: '', domain: '' }, lastUrl: null, lastAlertAt: null, lastAlert: null, reachedAt: null };
    try {
      Object.assign(this.settings, JSON.parse(fs.readFileSync(this.file, 'utf8')));
    } catch {
      /* first run */
    }
    this.state = { status: 'off', url: null, error: null, progress: null, urlChanged: false, check: { status: 'idle', at: null, error: null } };
    this.child = null;
    this.listener = null;
    this.restarts = 0;
    this.stopping = false;
    this.logTail = [];
    process.on('exit', () => this.child?.kill());
  }

  #save() {
    try {
      fs.writeFileSync(this.file, JSON.stringify(this.settings, null, 1), { mode: 0o600 });
    } catch (err) {
      this.log.warn?.('[tunnel] could not save settings:', err.message);
    }
  }

  #set(patch) {
    Object.assign(this.state, patch);
    this.emit('change', this.view());
  }

  get webhookUrl() {
    return this.state.url ? `${this.state.url}/webhook` : null;
  }

  view() {
    const s = this.settings;
    return {
      ...this.state,
      webhookUrl: this.webhookUrl,
      provider: s.provider,
      autoStart: s.autoStart,
      ngrok: { hasToken: !!s.ngrok?.authtoken, domain: s.ngrok?.domain || '' },
      reachedAt: s.reachedAt,
      lastAlertAt: s.lastAlertAt,
      lastAlert: s.lastAlert,
      lastAlertUrl: s.lastAlertUrl || null,
      cloudflaredInstalled: !!this.findCloudflared(),
      log: this.logTail.slice(-6),
    };
  }

  // Start again on launch if the boss switched the tunnel on before.
  async init() {
    if (this.settings.autoStart && this.settings.provider) {
      try {
        await this.start(this.settings.provider);
      } catch (err) {
        this.log.warn?.(`[tunnel] could not start: ${err.message}`);
      }
    }
  }

  findCloudflared() {
    const exe = process.platform === 'win32' ? 'cloudflared.exe' : 'cloudflared';
    if (process.env.CLOUDFLARED && fs.existsSync(process.env.CLOUDFLARED)) return process.env.CLOUDFLARED;
    const dirs = [this.binDir, ...(process.env.PATH || '').split(path.delimiter), '/opt/homebrew/bin', '/usr/local/bin'];
    for (const d of dirs) {
      if (!d) continue;
      const p = path.join(d, exe);
      try {
        fs.accessSync(p, fs.constants.X_OK);
        return p;
      } catch {
        /* keep looking */
      }
    }
    return null;
  }

  // The release's own download link and SHA-256 checksum, as published on GitHub.
  async #releaseInfo(asset) {
    try {
      const res = await this.fetch(RELEASE_API, { headers: { Accept: 'application/vnd.github+json', 'User-Agent': 'trading-floor' } });
      if (!res.ok) return null;
      const rel = await res.json();
      const a = (rel.assets || []).find((x) => x.name === asset);
      if (!a || !String(a.browser_download_url).startsWith(OFFICIAL)) return null;
      const m = String(a.digest || '').match(/^sha256:([0-9a-f]{64})$/i);
      return { url: a.browser_download_url, sha256: m ? m[1].toLowerCase() : null, version: rel.tag_name };
    } catch {
      return null;
    }
  }

  async #download() {
    const asset = ASSETS[`${process.platform}-${process.arch}`];
    if (!asset) throw new Error(`No cloudflared download for ${process.platform}/${process.arch}. Install it yourself (brew install cloudflared).`);
    fs.mkdirSync(this.binDir, { recursive: true });
    this.#set({ status: 'installing', progress: 0, error: null });
    this.log.info?.(`[tunnel] downloading Cloudflare's tunnel app (${asset})…`);
    const release = await this.#releaseInfo(asset);
    if (!release?.sha256) this.log.warn?.('[tunnel] GitHub did not publish a checksum for this download; relying on HTTPS from github.com');
    const res = await this.fetch(release?.url || RELEASES + asset, { redirect: 'follow' });
    if (!res.ok || !res.body) throw new Error(`Download failed (HTTP ${res.status}). Check your internet connection, or install it with: brew install cloudflared`);
    const total = Number(res.headers.get('content-length')) || 0;
    const tmp = path.join(this.binDir, `${asset}.part`);
    const out = fs.createWriteStream(tmp);
    let loaded = 0;
    let lastEmit = 0;
    const hash = crypto.createHash('sha256');
    for await (const chunk of res.body) {
      loaded += chunk.length;
      hash.update(chunk);
      if (!out.write(chunk)) await new Promise((r) => out.once('drain', r));
      if (total && Date.now() - lastEmit > 250) {
        lastEmit = Date.now();
        this.#set({ progress: loaded / total });
      }
    }
    await new Promise((r, j) => out.end((err) => (err ? j(err) : r())));
    // Integrity: the file must be exactly the one Cloudflare published, or it never runs.
    const got = hash.digest('hex');
    if (release?.sha256 && got !== release.sha256) {
      fs.rmSync(tmp, { force: true });
      throw new Error('The downloaded tunnel app failed its integrity check (checksum mismatch), so it was deleted and not run. Try again, or install it with: brew install cloudflared');
    }
    if (release?.sha256) this.log.info?.(`[tunnel] checksum verified (cloudflared ${release.version})`);
    const exe = path.join(this.binDir, process.platform === 'win32' ? 'cloudflared.exe' : 'cloudflared');
    if (asset.endsWith('.tgz')) {
      await new Promise((resolve, reject) => execFile('tar', ['-xzf', tmp, '-C', this.binDir], (err) => (err ? reject(new Error(`Could not unpack cloudflared: ${err.message}`)) : resolve())));
      fs.unlinkSync(tmp);
    } else {
      fs.renameSync(tmp, exe);
    }
    fs.chmodSync(exe, 0o755);
    this.#set({ progress: 1 });
    return exe;
  }

  async start(provider = 'cloudflare', opts = {}) {
    if (provider !== 'cloudflare' && provider !== 'ngrok') throw new Error('Unknown tunnel provider');
    if (provider === 'ngrok') {
      const authtoken = (opts.authtoken ?? this.settings.ngrok.authtoken ?? '').trim();
      const domain = (opts.domain ?? this.settings.ngrok.domain ?? '').trim().replace(/^https?:\/\//, '').replace(/\/.*$/, '');
      if (!authtoken) throw new Error('Paste your ngrok authtoken first.');
      this.settings.ngrok = { authtoken, domain };
    }
    await this.stop({ keepAuto: true });
    this.settings.provider = provider;
    this.settings.autoStart = true;
    this.#save();
    this.stopping = false;
    this.restarts = 0;
    this.logTail = [];
    this.#set({ status: 'starting', url: null, error: null, progress: null, check: { status: 'idle', at: null, error: null } });
    try {
      if (provider === 'ngrok') await this.#startNgrok();
      else await this.#startCloudflare();
    } catch (err) {
      this.#set({ status: 'error', error: err.message, progress: null });
      throw err;
    }
    return this.view();
  }

  async #startCloudflare() {
    let bin = this.findCloudflared();
    if (!bin) bin = await this.#download();
    this.#set({ status: 'starting', progress: null });
    this.#spawnCloudflared(bin);
  }

  #spawnCloudflared(bin) {
    const child = this.spawn(bin, ['tunnel', '--no-autoupdate', '--url', `http://127.0.0.1:${this.port}`], { stdio: ['ignore', 'pipe', 'pipe'] });
    this.child = child;
    const timer = setTimeout(() => {
      if (this.child === child && !this.state.url) {
        this.#set({ status: 'error', error: 'Cloudflare did not hand out an address within 45 seconds. Check your internet connection and try again.' });
        child.kill();
      }
    }, 45_000);
    const onData = (buf) => {
      for (const line of String(buf).split('\n')) {
        const clean = line.replace(/^\S+\s+(INF|WRN|ERR)\s+/, '').replace(/[|+]/g, '').trim();
        if (clean && !/^-+$/.test(clean)) {
          this.logTail.push(clean.slice(0, 200));
          if (this.logTail.length > 20) this.logTail.shift();
        }
        const m = line.match(QUICK_URL);
        if (m && this.child === child && this.state.url !== m[0]) {
          clearTimeout(timer);
          this.#gotUrl(m[0]);
        }
      }
    };
    child.stdout?.on('data', onData);
    child.stderr?.on('data', onData);
    child.on('error', (err) => {
      clearTimeout(timer);
      if (this.child !== child) return;
      this.child = null;
      this.#set({ status: 'error', error: `Could not run cloudflared: ${err.message}` });
    });
    child.on('exit', (code) => {
      clearTimeout(timer);
      if (this.child !== child) return;
      this.child = null;
      if (this.stopping) return;
      const wasRunning = this.state.status === 'running';
      if (wasRunning && this.restarts < 5) {
        // Dropped (sleep, Wi-Fi change…): bring it back. Quick tunnels get a new address.
        this.restarts++;
        this.log.warn?.('[tunnel] the tunnel stopped; restarting…');
        this.#set({ status: 'starting', url: null });
        setTimeout(() => !this.stopping && this.#spawnCloudflared(bin), 3000 * this.restarts);
        return;
      }
      const tail = this.logTail.slice(-3).join(' · ');
      const refused = /provisioning failed|status 4\d\d|status 5\d\d|Too Many Requests/i.test(tail);
      const offline = /no such host|dial tcp|network is unreachable|connection refused|i\/o timeout/i.test(tail);
      const error = refused
        ? `Cloudflare would not create a free address just now (${tail.match(/status \d+|Too Many Requests/i)?.[0] || 'refused'}). Try again in a minute, or use a permanent ngrok address below.`
        : offline
          ? 'Could not reach Cloudflare. Check your internet connection and try again.'
          : `The tunnel stopped (exit ${code}).${tail ? ` ${tail}` : ''}`;
      if (this.state.status !== 'error') this.#set({ status: 'error', url: null, error });
    });
  }

  async #startNgrok() {
    let ngrok;
    try {
      ngrok = await import('@ngrok/ngrok');
    } catch {
      throw new Error('The ngrok add-on is not installed. Run npm install in the trading-floor folder (or double-click start.command), then try again.');
    }
    const { authtoken, domain } = this.settings.ngrok;
    try {
      this.listener = await ngrok.forward({ addr: `127.0.0.1:${this.port}`, authtoken, domain: domain || undefined });
    } catch (err) {
      const msg = String(err?.message || err);
      if (/authtoken|ERR_NGROK_10[57]/i.test(msg)) throw new Error('ngrok rejected the authtoken. Copy it again from dashboard.ngrok.com → Your Authtoken.');
      if (/domain|ERR_NGROK_3(19|20)/i.test(msg)) throw new Error(`ngrok would not give you that domain. Check it under dashboard.ngrok.com → Domains. (${msg.slice(0, 140)})`);
      throw new Error(`ngrok could not start: ${msg.slice(0, 200)}`);
    }
    this.#gotUrl(this.listener.url());
  }

  #gotUrl(url) {
    const s = this.settings;
    const changed = !!(s.lastUrl && s.lastUrl !== url && s.lastAlertAt);
    s.lastUrl = url;
    this.#save();
    this.#set({ status: 'running', url, error: null, progress: null, urlChanged: this.state.urlChanged || changed });
    this.log.info?.(`[tunnel] TradingView webhook URL: ${url}/webhook`);
    // New quick-tunnel addresses take a few seconds to resolve worldwide.
    setTimeout(() => this.check().catch(() => {}), this.settings.provider === 'cloudflare' ? 4000 : 500).unref?.();
  }

  // The floor is shutting down. Ctrl+C in Terminal also reaches cloudflared directly, so it
  // may exit before stop() runs: that's not a dropped tunnel to restart.
  shuttingDown() {
    this.stopping = true;
  }

  async stop({ keepAuto = false } = {}) {
    this.stopping = true;
    if (!keepAuto) {
      this.settings.autoStart = false;
      this.#save();
    }
    const child = this.child;
    this.child = null;
    if (child) {
      child.kill();
      await Promise.race([new Promise((r) => child.once('exit', r)), sleep(2000)]);
    }
    if (this.listener) {
      try {
        await this.listener.close();
      } catch {
        /* already closed */
      }
      this.listener = null;
    }
    if (!keepAuto) this.#set({ status: 'off', url: null, error: null, progress: null, check: { status: 'idle', at: null, error: null } });
  }

  // Send a harmless ping through the public address to prove TradingView can reach us.
  async check({ attempts = 6 } = {}) {
    const url = this.webhookUrl;
    if (!url) throw new Error('Start the public address first.');
    const started = Date.now();
    this.#set({ check: { status: 'checking', at: started, error: null } });
    let lastErr = null;
    for (let i = 0; i < attempts; i++) {
      if (this.webhookUrl !== url) return this.state.check;
      if (this.settings.reachedAt >= started) return this.state.check; // a ping already came through
      try {
        const ctrl = new AbortController();
        const t = setTimeout(() => ctrl.abort(), 10_000);
        const res = await this.fetch(url, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ secret: this.secret, action: 'ping' }), signal: ctrl.signal });
        clearTimeout(t);
        const body = await res.json().catch(() => ({}));
        if (res.ok && body.ok) {
          this.#set({ check: { status: 'ok', at: Date.now(), error: null } });
          return this.state.check;
        }
        lastErr = `HTTP ${res.status}${body.error ? ` (${body.error})` : ''}`;
      } catch (err) {
        lastErr = err.name === 'AbortError' ? 'timed out' : err.cause?.code || err.message;
      }
      await sleep(i < 2 ? 2500 : 5000);
    }
    if (this.settings.reachedAt >= started) return this.state.check;
    this.#set({ check: { status: 'failed', at: Date.now(), error: lastErr } });
    return this.state.check;
  }

  // The webhook saw a ping that came in over the internet.
  markReached() {
    this.settings.reachedAt = Date.now();
    this.#save();
    if (this.state.url) this.#set({ check: { status: 'ok', at: this.settings.reachedAt, error: null } });
    else this.emit('change', this.view());
  }

  // A real (non-ping) alert arrived through the public address.
  noteAlert(alert, result) {
    this.settings.lastAlertAt = Date.now();
    this.settings.lastAlert = { action: alert.action, symbol: alert.symbol || alert.rawSymbol, agent: alert.agent, ok: !!result?.ok };
    this.settings.lastAlertUrl = this.state.url;
    this.#save();
    this.emit('change', this.view());
  }

  ackUrlChange() {
    this.#set({ urlChanged: false });
  }
}
