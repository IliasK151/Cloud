import http from 'node:http';
import fs from 'node:fs';
import crypto from 'node:crypto';
import path from 'node:path';
import { spawn } from 'node:child_process';
import express from 'express';
import { WebSocketServer } from 'ws';

import { config, ROOT } from './config.js';
import { MarketClock, Session } from './market/session.js';
import { MarketData } from './market/marketData.js';
import { FeedManager } from './market/feedManager.js';
import { NewsCalendar } from './market/calendar.js';
import { HistoryStore } from './research/history.js';
import { ResearchLab } from './research/lab.js';
import { SYMBOLS } from './market/symbols.js';
import { Broker } from './engine/broker.js';
import { RiskManager } from './engine/risk.js';
import { Fund } from './engine/fund.js';
import { Store } from './store.js';
import { parseBody, normalizeAlert, alertSecret, secretMatches, rateLimiter } from './tradingview/webhook.js';
import { LocalGuard, isLoopbackBind, isLoopbackAddress } from './security/localGuard.js';
import { WebhookFirewall, newSecret } from './security/webhookFirewall.js';
import { TunnelManager } from './tradingview/tunnel.js';
import { VoiceEngine, toWav } from './voices/engine.js';
import { Mt5Bridge } from './live/bridge.js';
import { LiveTrader } from './live/liveTrader.js';
import { summarize } from './live/dailyReport.js';
import { TelegramNotifier } from './notify/telegram.js';

// As a background service (npm run service) the log files grow forever: start each run
// with a fresh one, keeping the previous run's as .old.
if (process.env.FLOOR_SERVICE === '1') {
  for (const name of ['floor.log', 'floor-error.log']) {
    const f = path.join(config.dataDir, 'logs', name);
    try {
      if (fs.statSync(f).size > 5 * 1024 * 1024) {
        fs.copyFileSync(f, `${f}.old`);
        fs.truncateSync(f, 0);
      }
    } catch { /* no log yet */ }
  }
}

const log = {
  info: (...a) => console.log(...a),
  warn: (...a) => console.warn(...a),
};

// ---- engine ------------------------------------------------------------------------------
const clock = new MarketClock(config.feed, config.simSpeed);
const session = new Session(clock);
const md = new MarketData(clock);
const broker = new Broker(md, clock);
const risk = new RiskManager(config.risk, session);
const news = new NewsCalendar({ clock, mode: config.feed, dataDir: config.dataDir, log });
const history = new HistoryStore({ md, mode: config.feed, dataDir: config.dataDir, calendar: news, log });
const lab = new ResearchLab({ history, calendar: news, mode: config.feed, log });
const fund = new Fund({ config, md, clock, session, broker, risk, news, lab });
const store = new Store(config.dataDir, config.feed);
const feeds = new FeedManager({ md, clock, mode: config.feed, log, calendar: news });

// FTMO / MT5 live execution (idle until the MeridianBridge EA connects and you arm it).
const bridge = new Mt5Bridge();
const live = new LiveTrader({ fund, md, bridge, clock, mode: config.feed, dataDir: config.dataDir, token: config.bridgeToken, log });
// Alerts on the boss's phone (Telegram), from the live trader's big moments.
const notifier = new TelegramNotifier({ dataDir: config.dataDir, log });
live.on('alert', (a) => notifier.notify(a));

feeds.onSession({
  sessionClose: () => fund.flattenAll('Session close'),
  sessionOpen: () => fund.housekeeping(),
});
feeds.on('recovered', (id, source) => {
  const via = { mt5: 'your broker\'s MT5 prices', binance: 'live Binance prices' }[source] || 'live Yahoo Finance prices';
  fund.pushEvent({ kind: 'info', text: `${id} has real prices again, from ${via}. Its desks can trade it.` });
});

// ---- security --------------------------------------------------------------------------------
// HOST=0.0.0.0 listens on your network. Other devices get the dashboard only with a password
// (FLOOR_PASSWORD); without one they can reach nothing but the MT5 bridge, which has its own
// token (for MT5 in a Windows VM, e.g. Parallels, or on another PC).
const bindHost = config.host;
const networkBind = !isLoopbackBind(bindHost);
const lanMode = networkBind && config.floorPassword.length >= 10;
if (networkBind && !lanMode) {
  log.warn(`\n  [security] HOST=${bindHost}: MT5 can connect from other machines (bridge token required), but the dashboard`);
  log.warn('  [security] stays on this Mac. Set FLOOR_PASSWORD (10+ characters) in .env to open it on other devices.\n');
}
const guard = new LocalGuard({
  port: config.port, lan: lanMode, extraHosts: config.allowedHosts,
  password: lanMode ? config.floorPassword : null, widgetPort: config.widgetPort,
  networkPaths: ['/api/bridge/sync'],
});
const secrets = { webhook: config.webhookSecret };
const firewall = new WebhookFirewall({ file: path.join(config.dataDir, 'security-log.json'), log });
const INDEX_HTML = fs.readFileSync(path.join(ROOT, 'public', 'index.html'), 'utf8');

// ---- HTTP ----------------------------------------------------------------------------------
const app = express();
app.disable('x-powered-by');
app.set('etag', false);
// The local firewall runs first: host allowlist, floor key, origin checks, headers, login.
app.use(guard.middleware({ exempt: ['/api/bridge/sync', '/api/tradingview/webhook', '/api/health'] }));
app.get(['/', '/index.html'], (req, res) => guard.sendIndex(req, res, INDEX_HTML));

// Requests arriving through a tunnel (cloudflared / ngrok) carry forwarding headers.
// Control endpoints only answer direct local requests.
const isDirect = (req) => !req.headers['x-forwarded-for'] && !req.headers['cf-connecting-ip'] && !req.headers.forwarded;
const localOnly = (req, res, next) => (isDirect(req) ? next() : res.status(403).json({ ok: false, error: 'local only' }));

const nm = (p) => path.join(ROOT, 'node_modules', p);
app.use('/vendor/three', express.static(nm('three'), { maxAge: '1d' }));
app.use('/vendor/lightweight-charts', express.static(nm('lightweight-charts/dist'), { maxAge: '1d' }));
app.use('/tradingview', express.static(path.join(ROOT, 'tradingview')));
app.use('/mt5', express.static(path.join(ROOT, 'mt5'), { setHeaders: (res) => res.setHeader('Content-Disposition', 'attachment') }));
app.use(express.static(path.join(ROOT, 'public'), { index: false }));

// The page checks its floor key here after the floor restarts (a new key means reload).
app.get('/api/session', (req, res) => res.json({ ok: true }));
app.get('/api/health', (req, res) => res.json({ ok: true, mode: config.feed, uptime: process.uptime(), service: process.env.FLOOR_SERVICE === '1', notes: feeds.notes }));
app.get('/api/state', localOnly, (req, res) => res.json(fund.initPayload()));
app.get('/api/agents/:id', localOnly, (req, res) => {
  const detail = fund.agentDetail(req.params.id);
  return detail ? res.json(detail) : res.status(404).json({ ok: false, error: 'unknown agent' });
});
app.get('/api/candles/:symbol', localOnly, (req, res) => {
  const id = req.params.symbol.toUpperCase();
  if (!SYMBOLS[id]) return res.status(404).json({ ok: false, error: 'unknown symbol' });
  const limit = Math.min(900, Number(req.query.limit) || 300);
  return res.json(md.bars(id, { includeCurrent: true }).slice(-limit));
});
app.post('/api/command', localOnly, express.json(), (req, res) => {
  res.json(fund.command(req.body?.cmd, req.body?.agentId));
});

// Economic calendar (news the desks stand aside for).
app.get('/api/news', localOnly, (req, res) => res.json(news.view()));
app.get('/api/brain', localOnly, (req, res) => res.json(brainView()));
app.post('/api/news/settings', localOnly, express.json(), (req, res) => res.json(news.setSettings(req.body || {})));
app.post('/api/news/refresh', localOnly, async (req, res) => {
  await news.refresh();
  res.json({ ok: !news.error, error: news.error, news: news.view() });
});

// ---- MT5 bridge + FTMO live trading --------------------------------------------------------
// Why MT5 last failed to connect: shown in the FTMO tab, printed here (once a minute at
// most) and reported by `npm run doctor`.
function noteBridgeIssue(kind, text) {
  const now = Date.now();
  const prev = live.bridgeIssue;
  const loud = !prev || prev.kind !== kind || now - prev.loggedAt > 60_000;
  live.bridgeIssue = { kind, text, at: now, count: prev?.kind === kind ? prev.count + 1 : 1, loggedAt: loud ? now : prev.loggedAt };
  if (loud) {
    log.warn(`[bridge] ${text}`);
    pushLive(true);
  }
}
const bridgeStrikes = new Map(); // other machines only: wrong tokens → slowed down
app.post('/api/bridge/sync', express.text({ type: '*/*', limit: '4mb' }), (req, res) => {
  const ip = String(req.socket.remoteAddress || '');
  if (!isDirect(req)) return res.status(403).type('text').send('ERR the bridge only accepts MT5 directly, not through a tunnel');
  // MT5 never sends an Origin header; a web page always does.
  if (req.headers.origin || /site/.test(req.headers['sec-fetch-site'] || '')) return res.status(403).type('text').send('ERR browsers may not use the bridge');
  const strikes = bridgeStrikes.get(ip);
  if (strikes && strikes.n >= 20 && Date.now() - strikes.since < 60_000) return res.status(429).type('text').send('ERR too many wrong bridge tokens from this machine, wait a minute');
  let msg;
  try {
    msg = JSON.parse(req.body);
  } catch {
    noteBridgeIssue('json', 'MT5 sent something the floor could not read. Re-install the MeridianBridge EA from the FTMO tab.');
    return res.status(400).type('text').send('ERR bad json');
  }
  const token = req.headers['x-bridge-token'] || msg?.token;
  if (!secretMatches(token, config.bridgeToken)) {
    if (!isLoopbackAddress(ip)) {
      const st = strikes && Date.now() - strikes.since < 60_000 ? strikes : { n: 0, since: Date.now() };
      st.n++;
      bridgeStrikes.set(ip, st);
    }
    noteBridgeIssue('token', token
      ? 'MT5 is reaching the floor, but the EA\'s bridge token is wrong. Copy the token from the FTMO tab and paste it into the EA\'s Inputs (right-click the chart → Expert list → MeridianBridge → Properties → Inputs → Bridge token).'
      : 'MT5 is reaching the floor, but the EA\'s bridge token is empty. Copy the token from the FTMO tab and paste it into the EA\'s Inputs (right-click the chart → Expert list → MeridianBridge → Properties → Inputs → Bridge token).');
    return res.status(401).type('text').send('ERR bad bridge token — copy it from the FTMO tab');
  }
  bridgeStrikes.delete(ip);
  if (live.bridgeIssue) {
    live.bridgeIssue = null;
    log.info('[bridge] MT5 connected');
  }
  // The reply must never fail because of something else on the floor.
  let reply;
  try {
    reply = bridge.handleSync(msg);
  } catch (err) {
    log.warn(`[bridge] error while handling MT5's sync: ${err.stack || err.message}`);
    reply = 'OK';
  }
  res.type('text').send(reply);
});
app.get('/api/live', localOnly, (req, res) => res.json(live.view()));
app.post('/api/live/:action', localOnly, express.json(), (req, res) => {
  const b = req.body || {};
  const actions = {
    setup: () => live.setup(b),
    desk: () => live.setDesk(b.agentId, b.enabled),
    arm: () => live.arm(b),
    disarm: () => live.disarm(),
    kill: () => live.kill(),
    close: () => live.closeTicket(b.ticket),
    'reset-halt': () => live.resetHalt(),
    plan: () => live.setPlan(b),
    'install-ea': () => live.installEa(),
    'stay-armed': () => live.setStayArmed(b.on),
  };
  const fn = Object.hasOwn(actions, req.params.action) ? actions[req.params.action] : null;
  if (!fn) return res.status(404).json({ ok: false, error: 'unknown action' });
  const result = fn();
  pushLive(true);
  res.json(result);
});

// ---- daily report card -------------------------------------------------------------------
app.get('/api/reports', localOnly, (req, res) => res.json({ days: live.reports.list(), today: live.reports.current?.day ?? null }));
app.get('/api/reports/:day', localOnly, (req, res) => {
  const day = String(req.params.day);
  if (!/^[0-9]{4}[.-][0-9]{2}[.-][0-9]{2}$/.test(day)) return res.status(400).json({ ok: false, error: 'bad day' });
  const report = live.reports.get(day);
  if (!report) return res.status(404).json({ ok: false, error: 'no report for that day' });
  res.json({ ok: true, report, summary: summarize(report) });
});

// ---- Telegram alerts ------------------------------------------------------------------------
app.get('/api/alerts', localOnly, (req, res) => res.json(notifier.view()));
app.post('/api/alerts/:action', localOnly, express.json({ limit: '4kb' }), async (req, res) => {
  const b = req.body || {};
  const actions = {
    token: () => notifier.setToken(b.token),
    'find-chat': () => notifier.findChat(),
    test: () => notifier.test(),
    settings: () => notifier.settings(b),
    forget: () => notifier.forget(),
  };
  const fn = Object.hasOwn(actions, req.params.action) ? actions[req.params.action] : null;
  if (!fn) return res.status(404).json({ ok: false, error: 'unknown action' });
  try {
    const result = await fn();
    res.json({ ...result, alerts: notifier.view() });
  } catch (err) {
    res.json({ ok: false, error: err.message, alerts: notifier.view() });
  }
});

const tunnel = new TunnelManager({ dataDir: config.dataDir, port: config.webhookPort, secret: config.webhookSecret, log });
const voices = new VoiceEngine({ dataDir: config.dataDir, log });

// Realistic voices: generated here on the Mac, played by the browser.
app.get('/api/voices', localOnly, (req, res) => res.json(voices.status()));
app.post('/api/voices/setup', localOnly, (req, res) => {
  voices.setup();
  res.json({ ok: true, voices: voices.status() });
});
app.post('/api/voices/disable', localOnly, (req, res) => {
  voices.disable();
  res.json({ ok: true, voices: voices.status() });
});
app.post('/api/voices/speak', localOnly, express.json({ limit: '8kb' }), async (req, res) => {
  const { text, voice } = req.body || {};
  if (!text || !/^[ab][fm]_[a-z]+$/.test(String(voice))) return res.status(400).json({ ok: false, error: 'text and a Kokoro voice id are required' });
  try {
    const out = await voices.speak(text, voice);
    res.type('audio/wav').send(toWav(out.samples, out.rate));
  } catch (err) {
    res.status(503).json({ ok: false, error: err.message });
  }
});

const tvInfo = () => ({
  tunnel: tunnel.view(),
  webhookPath: '/api/tradingview/webhook',
  localUrl: `http://localhost:${config.port}/api/tradingview/webhook`,
  webhookPort: config.webhookPort,
  secret: secrets.webhook,
  secretFromEnv: config.webhookSecretFromEnv,
  firewall: firewall.view(),
  guard: guard.view(),
  agents: fund.agents.map((a) => ({ id: a.id, name: a.profile.name, desk: a.profile.desk, symbol: a.symbol })),
  symbols: Object.values(SYMBOLS).map((s) => ({ id: s.id, tv: s.tv, aliases: s.aliases })),
  alerts: fund.alerts.slice(-30).reverse(),
});
app.get('/api/tradingview/config', localOnly, (req, res) => res.json(tvInfo()));

// The TradingView webhook, behind the internet firewall (security/webhookFirewall.js).
const allowAlert = rateLimiter(40, 60_000); // authenticated trade alerts: runaway protection
const reply = (res, status, body) => res.status(status).json(body);
function webhookHandler(req, res) {
  res.setHeader('Cache-Control', 'no-store');
  const client = firewall.clientIp(req);
  // TradingView and the tunnels never send an Origin header; a web page always does.
  if (req.headers.origin || /site/.test(req.headers['sec-fetch-site'] || '')) return reply(res, 403, { ok: false, error: 'forbidden' });
  const gate = firewall.admit(client);
  if (!gate.ok) return reply(res, gate.status, { ok: false, error: gate.error });
  const raw = parseBody(req.body);
  // The secret first: nothing about the alert is examined or answered without it.
  if (!secretMatches(alertSecret(raw), secrets.webhook)) {
    const r = firewall.badSecret(client);
    if (client.local) log.warn('[tradingview] rejected alert with a bad secret');
    return reply(res, r.status, { ok: false, error: r.error });
  }
  const parsed = normalizeAlert(raw);
  if (!parsed.ok) return reply(res, 400, { ok: false, error: parsed.error });
  const auth = firewall.authorize(client, parsed.alert.action);
  if (!auth.ok) return reply(res, auth.status, { ok: false, error: auth.error });
  const remote = !client.local;
  if (parsed.alert.action === 'ping') {
    if (remote) tunnel.markReached();
    return res.json({ ok: true, result: 'Connection OK. The floor received this check and placed no trade.' });
  }
  if (!allowAlert()) return reply(res, 429, { ok: false, error: 'rate limited' });
  const result = fund.handleAlert(parsed.alert);
  if (remote) tunnel.noteAlert(parsed.alert, result);
  return res.json({ ok: result.ok, result: result.ok ? result.text : result.reason });
}
const textBody = express.text({ type: '*/*', limit: '8kb' });
app.post('/api/tradingview/webhook', textBody, webhookHandler);

// Firewall controls (local, floor key required like every API call).
app.post('/api/tradingview/firewall', localOnly, express.json(), (req, res) => {
  const b = req.body || {};
  if (typeof b.unban === 'string') firewall.unban(b.unban);
  res.json({ ok: true, firewall: firewall.setSettings({ tradingViewOnly: b.tradingViewOnly }) });
  pushFirewall();
});
// New webhook secret: the old one stops working at once (update your TradingView alerts).
app.post('/api/tradingview/rotate-secret', localOnly, (req, res) => {
  if (config.webhookSecretFromEnv) return res.json({ ok: false, error: 'The secret is set in .env (WEBHOOK_SECRET). Change it there and restart the floor.' });
  const next = newSecret();
  try {
    fs.writeFileSync(path.join(config.dataDir, 'webhook-secret.txt'), `${next}\n`, { mode: 0o600 });
  } catch (err) {
    return res.json({ ok: false, error: `Could not save the new secret: ${err.message}` });
  }
  secrets.webhook = next;
  tunnel.secret = next;
  firewall.secretRotated();
  fund.pushEvent({ kind: 'risk', text: 'SECURITY · Webhook secret rotated. Paste the new alert message into your TradingView alerts.' });
  res.json({ ok: true, ...tvInfo() });
  pushFirewall();
});

// Public address for TradingView (one-click tunnel), local controls only.
app.post('/api/tradingview/tunnel/:action', localOnly, express.json(), async (req, res) => {
  const b = req.body || {};
  try {
    if (req.params.action === 'start') await tunnel.start(b.provider || 'cloudflare', { authtoken: b.authtoken, domain: b.domain });
    else if (req.params.action === 'stop') await tunnel.stop();
    else if (req.params.action === 'check') await tunnel.check();
    else if (req.params.action === 'ack') tunnel.ackUrlChange();
    else return res.status(404).json({ ok: false, error: 'unknown action' });
    res.json({ ok: true, tunnel: tunnel.view() });
  } catch (err) {
    res.json({ ok: false, error: err.message, tunnel: tunnel.view() });
  }
});

// Test button in the UI: fires a signed alert without needing TradingView.
app.post('/api/tradingview/test', localOnly, express.json(), (req, res) => {
  const { agent = 'chen', action = 'buy', symbol } = req.body || {};
  const parsed = normalizeAlert({ agent, action, symbol: symbol || fund.byId.get(agent)?.symbol, comment: 'UI test alert' });
  if (!parsed.ok) return res.status(400).json(parsed);
  // A test from this page trades paper only, never the FTMO account.
  const result = fund.handleAlert({ ...parsed.alert, test: true });
  res.json({ ok: result.ok, result: result.ok ? result.text : result.reason });
});

const server = http.createServer(app);

// Dedicated webhook-only listener: point your tunnel (cloudflared / ngrok) at this port so
// TradingView can reach the webhook without exposing the dashboard or its controls.
const hookApp = express();
hookApp.disable('x-powered-by');
hookApp.set('etag', false);
hookApp.use((req, res, next) => {
  res.setHeader('Content-Security-Policy', "default-src 'none'; frame-ancestors 'none'");
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('Referrer-Policy', 'no-referrer');
  res.setHeader('Cache-Control', 'no-store');
  next();
});
hookApp.post(['/', '/webhook', '/api/tradingview/webhook'], textBody, webhookHandler);
hookApp.use((req, res) => res.status(404).json({ ok: false, error: 'not found' }));
// Never an error page or stack trace to the internet.
hookApp.use((err, req, res, next) => res.status(err.status === 413 ? 413 : 400).json({ ok: false, error: err.status === 413 ? 'too large' : 'bad request' })); // eslint-disable-line no-unused-vars
const hookServer = http.createServer(hookApp);
// Slow or half-open connections are cut off quickly.
Object.assign(hookServer, { headersTimeout: 10_000, requestTimeout: 15_000, keepAliveTimeout: 5_000, maxHeadersCount: 60 });
Object.assign(server, { headersTimeout: 20_000, requestTimeout: 60_000 });
app.use((err, req, res, next) => { // eslint-disable-line no-unused-vars
  res.status(err.status && err.status < 500 ? err.status : 500).json({ ok: false, error: err.status === 413 ? 'too large' : 'request failed' });
});

// The TradingView chart widget runs third-party code, so it lives on its own origin (its
// own port) where it can't see the floor's page, key or data.
const widgetServer = http.createServer((req, res) => serveWidget(req, res));
Object.assign(widgetServer, { headersTimeout: 10_000, requestTimeout: 15_000 });
function serveWidget(req, res) {
  let url;
  try {
    url = new URL(req.url, 'http://x');
  } catch {
    url = null;
  }
  const hostOk = guard.names.has(String(req.headers.host || '').toLowerCase().replace(/:\d+$/, '').replace(/^\[|\]$/g, ''));
  const symbol = url?.searchParams.get('symbol') || '';
  if (req.method !== 'GET' || url?.pathname !== '/tv' || !hostOk || !/^[A-Za-z0-9:!._-]{1,40}$/.test(symbol)) {
    res.writeHead(404, { 'Content-Type': 'text/plain', 'X-Content-Type-Options': 'nosniff' });
    return res.end('not found');
  }
  const nonce = crypto.randomBytes(16).toString('base64');
  // CSP host sources can't be IPv6 literals; the floor is opened by name or IPv4 anyway.
  const floorOrigins = [...guard.names].filter((n) => !n.includes(':')).map((n) => `http://${n}:${config.port}`).join(' ');
  const cfg = JSON.stringify({
    autosize: true, symbol, interval: '1', timezone: 'America/New_York', theme: 'dark', style: '1', locale: 'en',
    allow_symbol_change: true, hide_side_toolbar: false, studies: ['STD;VWAP'], support_host: 'https://www.tradingview.com',
  }).replace(/</g, '\\u003c');
  res.writeHead(200, {
    'Content-Type': 'text/html; charset=utf-8',
    'Cache-Control': 'no-store',
    'X-Content-Type-Options': 'nosniff',
    'Content-Security-Policy': `default-src 'none'; script-src 'nonce-${nonce}' https://s3.tradingview.com https://*.tradingview.com; frame-src https:; connect-src https: wss:; img-src https: data:; style-src 'unsafe-inline' https:; font-src https: data:; frame-ancestors ${floorOrigins}; base-uri 'none'; form-action 'none'`,
  });
  return res.end(`<!doctype html><html><head><meta charset="utf-8"><style>html,body{margin:0;height:100%;background:#0b0c0e}</style></head><body>
<div class="tradingview-widget-container" style="height:100%;width:100%"><div class="tradingview-widget-container__widget" style="height:100%;width:100%"></div>
<script nonce="${nonce}" src="https://s3.tradingview.com/external-embedding/embed-widget-advanced-chart.js" async>${cfg}</script></div></body></html>`);
}

// ---- WebSocket -------------------------------------------------------------------------------
// The live feed carries the whole account: same firewall as the API (host, origin, key).
const wss = new WebSocketServer({ noServer: true, maxPayload: 16 * 1024 });
server.on('upgrade', (req, socket, head) => {
  const refused = !isDirect(req) ? 'forwarded' : guard.upgradeOk(req);
  if (refused) {
    const status = refused === 'key' || refused === 'login' ? '401 Unauthorized' : '403 Forbidden';
    socket.end(`HTTP/1.1 ${status}\r\nConnection: close\r\nContent-Length: 0\r\n\r\n`);
    return;
  }
  wss.handleUpgrade(req, socket, head, (ws) => wss.emit('connection', ws, req));
});
const COMMANDS = new Set(['reset-paper', 'research', 'reset-learning', 'flatten', 'pause', 'resume', 'pause-all', 'resume-all']);

function broadcast(msg) {
  if (!wss.clients.size) return;
  const data = JSON.stringify(msg);
  for (const c of wss.clients) if (c.readyState === 1) c.send(data);
}

wss.on('connection', (ws) => {
  ws.send(JSON.stringify({ type: 'init', ...fund.initPayload(), live: live.view(), tunnel: tunnel.view(), voices: voices.status(), news: news.view(), brain: brainView() }));
  let window = { start: Date.now(), n: 0 };
  ws.on('message', (buf) => {
    // At most 20 messages per 10 seconds from one page; anything malformed is ignored.
    if (Date.now() - window.start > 10_000) window = { start: Date.now(), n: 0 };
    if (++window.n > 20) return;
    try {
      const msg = JSON.parse(buf.toString());
      if (msg?.type === 'command' && COMMANDS.has(msg.cmd) && (msg.agentId == null || (typeof msg.agentId === 'string' && fund.byId.has(msg.agentId)))) {
        const result = fund.command(msg.cmd, msg.agentId);
        ws.send(JSON.stringify({ type: 'command-result', cmd: msg.cmd, agentId: msg.agentId, ...result }));
      }
    } catch {
      /* ignore */
    }
  });
});

const closedBars = [];
md.on('bar', (symbol, bar) => closedBars.push({ symbol, bar }));
fund.on('event', (event) => broadcast({ type: 'event', event }));
fund.on('equity', (sample) => broadcast({ type: 'equity', sample }));
fund.on('alert', (alert) => broadcast({ type: 'alert', alert }));
fund.on('reset', () => {
  store.save(fund.serialize());
  for (const c of wss.clients) if (c.readyState === 1) c.send(JSON.stringify({ type: 'init', ...fund.initPayload(), live: live.view(), tunnel: tunnel.view(), voices: voices.status(), news: news.view(), brain: brainView() }));
});
broker.on('trade', (trade) => broadcast({ type: 'trade', trade }));
tunnel.on('change', (view) => broadcast({ type: 'tunnel', tunnel: view }));
voices.on('change', (st) => broadcast({ type: 'voices', voices: st }));
const pushNews = () => broadcast({ type: 'news', news: news.view() });
// The live brain: every agent's current thinking and the department debates.
const brainView = () => fund.committee?.view() ?? null;
setInterval(() => { if (wss.clients.size) broadcast({ type: 'brain', brain: brainView() }); }, 2000);
fund.committee?.on('debate', () => setImmediate(() => broadcast({ type: 'brain', brain: brainView() })));
news.on('change', pushNews);
news.on('announce', () => setImmediate(pushNews));
setInterval(pushNews, config.feed === 'sim' ? 5000 : 30_000);

// Firewall activity goes to the TradingView tab as it happens; a leaked secret also
// raises an alarm on the floor.
let firewallTimer = null;
function pushFirewall() {
  if (firewallTimer) return;
  firewallTimer = setTimeout(() => {
    firewallTimer = null;
    broadcast({ type: 'firewall', firewall: firewall.view(), guard: guard.view() });
  }, 250);
}
firewall.on('event', pushFirewall);
firewall.on('alarm', (a) => fund.pushEvent({ kind: 'risk', text: `SECURITY ALARM · ${a.text}` }));

// Push the FTMO panel state when it changes (and at least every few seconds).
let lastLive = '';
let lastLiveAt = 0;
function pushLive(force = false) {
  if (!wss.clients.size) return;
  let view;
  try {
    view = live.view();
  } catch (err) {
    log.warn(`[live] could not build the FTMO panel: ${err.stack || err.message}`);
    return;
  }
  const key = JSON.stringify({ ...view, lastSync: 0 });
  if (!force && key === lastLive && Date.now() - lastLiveAt < 5000) return;
  lastLive = key;
  lastLiveAt = Date.now();
  broadcast({ type: 'live', live: view });
}
setInterval(() => pushLive(), 1000);

setInterval(() => {
  if (!wss.clients.size) {
    closedBars.length = 0;
    return;
  }
  const bars = {};
  for (const id of Object.keys(SYMBOLS)) bars[id] = md.currentBar(id);
  broadcast({ type: 'snapshot', ...fund.snapshot(), closed: closedBars.splice(0), bars });
}, 500);

// ---- lifecycle -----------------------------------------------------------------------------
function openBrowser(url) {
  const cmd = process.platform === 'darwin' ? 'open' : process.platform === 'win32' ? 'cmd' : 'xdg-open';
  const args = process.platform === 'win32' ? ['/c', 'start', '', url] : [url];
  try {
    spawn(cmd, args, { stdio: 'ignore', detached: true }).on('error', () => {}).unref();
  } catch {
    /* no browser available */
  }
}

async function main() {
  news.init().catch((err) => log.warn(`[news] ${err.message}`));
  await feeds.start();
  if (fund.restore(store.load())) log.info('  Restored track record from', store.file);
  fund.start();
  setInterval(() => store.save(fund.serialize()), 30_000);
  // The research desks need long history; load it without holding up the floor.
  history.load().then(() => {
    const st = history.status();
    log.info(`  Research lab: ${Object.values(st).reduce((s, x) => s + x.bars, 0).toLocaleString('en-US')} one-minute bars loaded for ${Object.keys(st).length} markets`);
    lab.start();
  }).catch((err) => log.warn(`[research] ${err.message}`));

  server.listen(config.port, bindHost, () => {
    const url = `http://localhost:${config.port}`;
    log.info('');
    log.info(`  ${config.fundName} — Institutional Trading Floor`);
    log.info(`  ─────────────────────────────────────────────`);
    log.info(`  Floor & dashboard:  ${url}`);
    log.info(`  Market data:        ${config.feed === 'sim' ? `SIMULATION (${config.simSpeed}x speed)` : 'LIVE (Binance + Yahoo Finance)'}`);
    for (const n of feeds.notes) log.info(`                      ${n}`);
    log.info(`  TradingView hook:   http://localhost:${config.webhookPort}/webhook   (public address: TradingView tab)`);
    log.info(`  Webhook secret:     ${secrets.webhook.slice(0, 4)}…  (full secret in the TradingView tab, kept off this screen)`);
    log.info(`  Security:           ${lanMode ? 'dashboard open to your network, password required' : networkBind ? 'dashboard on this Mac only, MT5 bridge open to your network (token)' : 'dashboard on this Mac only'} · webhook firewall on · trades from TradingView only: ${firewall.settings.tradingViewOnly ? 'on' : 'OFF'}`);
    log.info('  Trouble connecting? Run: npm run doctor');
    log.info(`  FTMO / MT5 bridge:  http://127.0.0.1:${config.port}/api/bridge/sync  (token in the FTMO tab)`);
    log.info(`  Paper trading unless you connect MT5 and arm live trading in the FTMO tab.`);
    log.info('');
    if (config.openBrowser && !process.env.CI) openBrowser(url);
  });
  // The webhook listener only ever accepts connections from this Mac: the tunnel app runs
  // here and forwards TradingView's requests to it.
  hookServer.listen(config.webhookPort, '127.0.0.1', () => tunnel.init());
  widgetServer.listen(config.widgetPort, lanMode ? bindHost : '127.0.0.1');
  widgetServer.on('error', (err) => {
    guard.widgetPort = null;
    log.warn(`[security] TradingView chart widget port ${config.widgetPort} unavailable (${err.message}); the desk panels link to TradingView instead`);
  });
  voices.init();
  hookServer.on('error', (err) => log.warn(`[webhook] port ${config.webhookPort} unavailable: ${err.message}`));
}

// Keep the Mac awake for as long as the floor runs: caffeinate follows this process and
// ends with it. (A MacBook still sleeps with its lid closed.) KEEP_AWAKE=0 turns it off.
if (process.platform === 'darwin' && config.keepAwake) {
  try {
    spawn('/usr/bin/caffeinate', ['-is', '-w', String(process.pid)], { stdio: 'ignore', detached: true }).on('error', () => {}).unref();
  } catch { /* not fatal */ }
}

let shuttingDown = false;
async function shutdown() {
  if (shuttingDown) return;
  shuttingDown = true;
  tunnel.shuttingDown();
  log.info('\n  Flattening all desks and saving the track record…');
  try {
    const closed = await live.shutdown();
    if (closed === true) log.info('  Closed the floor\'s positions on the FTMO account.');
    else if (live.bridge.positions.length) log.info('  MT5 did not confirm closing the FTMO positions — check MT5 (they keep their stop-loss).');
  } catch (err) {
    log.warn('  Could not close FTMO positions:', err.message);
  }
  try {
    fund.flattenAll('Server shutdown');
    store.save(fund.serialize());
  } catch (err) {
    log.warn('  Save failed:', err.message);
  }
  feeds.stop();
  await tunnel.stop({ keepAuto: true }).catch(() => {});
  voices.stop();
  news.stop();
  lab.stop();
  history.stop();
  firewall.flush();
  process.exit(0);
}
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);

// The port is taken. If it's the floor itself (the background service, or another window),
// say so and open it: a second floor on another port would never see MT5, whose EA talks to
// the first one.
function floorOnPort(port) {
  return new Promise((resolve) => {
    const req = http.get({ host: '127.0.0.1', port, path: '/api/health', headers: { Host: `127.0.0.1:${port}` }, timeout: 3000 }, (res) => {
      let body = '';
      res.on('data', (c) => { body += c; });
      res.on('end', () => {
        try {
          const h = JSON.parse(body);
          resolve(h?.ok ? h : null);
        } catch {
          resolve(null);
        }
      });
    });
    req.on('timeout', () => req.destroy());
    req.on('error', () => resolve(null));
  });
}
server.on('error', async (err) => {
  if (err.code !== 'EADDRINUSE') throw err;
  const url = `http://localhost:${config.port}`;
  const other = await floorOnPort(config.port);
  if (!other) log.warn(`\n  Port ${config.port} is used by another app. Quit that app and start the floor again.\n`);
  else if (process.env.FLOOR_SERVICE === '1') log.warn(`  [service] The floor is already running in a Terminal window on port ${config.port}; the service takes over once that window is closed.`);
  else {
    log.warn(`\n  The floor is already running${other.service ? ' in the background (the service)' : ' in another window'}: ${url}`);
    log.warn('  Opening it. No second floor is started (MT5 talks to the one that\'s running).\n');
    if (config.openBrowser && !process.env.CI) openBrowser(url);
  }
  process.exit(other && process.env.FLOOR_SERVICE !== '1' ? 0 : 1);
});

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
