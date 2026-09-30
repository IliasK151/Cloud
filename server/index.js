import http from 'node:http';
import path from 'node:path';
import { spawn } from 'node:child_process';
import express from 'express';
import { WebSocketServer } from 'ws';

import { config, ROOT } from './config.js';
import { MarketClock, Session } from './market/session.js';
import { MarketData } from './market/marketData.js';
import { FeedManager } from './market/feedManager.js';
import { SYMBOLS } from './market/symbols.js';
import { Broker } from './engine/broker.js';
import { RiskManager } from './engine/risk.js';
import { Fund } from './engine/fund.js';
import { Store } from './store.js';
import { parseBody, normalizeAlert, secretMatches, rateLimiter } from './tradingview/webhook.js';
import { TunnelManager } from './tradingview/tunnel.js';
import { Mt5Bridge } from './live/bridge.js';
import { LiveTrader } from './live/liveTrader.js';

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
const fund = new Fund({ config, md, clock, session, broker, risk });
const store = new Store(config.dataDir, config.feed);
const feeds = new FeedManager({ md, clock, mode: config.feed, log });

// FTMO / MT5 live execution (idle until the MeridianBridge EA connects and you arm it).
const bridge = new Mt5Bridge();
const live = new LiveTrader({ fund, md, bridge, clock, mode: config.feed, dataDir: config.dataDir, token: config.bridgeToken, log });

feeds.onSession({
  sessionClose: () => fund.flattenAll('Session close'),
  sessionOpen: () => fund.housekeeping(),
});

// ---- HTTP ----------------------------------------------------------------------------------
const app = express();
app.disable('x-powered-by');

// Requests arriving through a tunnel (cloudflared / ngrok) carry forwarding headers.
// Control endpoints only answer direct local requests.
const isDirect = (req) => !req.headers['x-forwarded-for'] && !req.headers['cf-connecting-ip'] && !req.headers.forwarded;
const localOnly = (req, res, next) => (isDirect(req) ? next() : res.status(403).json({ ok: false, error: 'local only' }));

const nm = (p) => path.join(ROOT, 'node_modules', p);
app.use('/vendor/three', express.static(nm('three'), { maxAge: '1d' }));
app.use('/vendor/lightweight-charts', express.static(nm('lightweight-charts/dist'), { maxAge: '1d' }));
app.use('/tradingview', express.static(path.join(ROOT, 'tradingview')));
app.use('/mt5', express.static(path.join(ROOT, 'mt5'), { setHeaders: (res) => res.setHeader('Content-Disposition', 'attachment') }));
app.use(express.static(path.join(ROOT, 'public')));

app.get('/api/health', (req, res) => res.json({ ok: true, mode: config.feed, uptime: process.uptime(), notes: feeds.notes }));
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

// ---- MT5 bridge + FTMO live trading --------------------------------------------------------
app.post('/api/bridge/sync', express.text({ type: '*/*', limit: '4mb' }), (req, res) => {
  if (!isDirect(req)) return res.status(403).type('text').send('ERR local only');
  let msg;
  try {
    msg = JSON.parse(req.body);
  } catch {
    return res.status(400).type('text').send('ERR bad json');
  }
  const token = req.headers['x-bridge-token'] || msg.token;
  if (!secretMatches(token, config.bridgeToken)) return res.status(401).type('text').send('ERR bad bridge token — copy it from the FTMO tab');
  res.type('text').send(bridge.handleSync(msg));
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
  };
  const fn = actions[req.params.action];
  if (!fn) return res.status(404).json({ ok: false, error: 'unknown action' });
  const result = fn();
  pushLive(true);
  res.json(result);
});

const tunnel = new TunnelManager({ dataDir: config.dataDir, port: config.webhookPort, secret: config.webhookSecret, log });

const tvInfo = () => ({
  tunnel: tunnel.view(),
  webhookPath: '/api/tradingview/webhook',
  localUrl: `http://localhost:${config.port}/api/tradingview/webhook`,
  webhookPort: config.webhookPort,
  secret: config.webhookSecret,
  agents: fund.agents.map((a) => ({ id: a.id, name: a.profile.name, desk: a.profile.desk, symbol: a.symbol })),
  symbols: Object.values(SYMBOLS).map((s) => ({ id: s.id, tv: s.tv, aliases: s.aliases })),
  alerts: fund.alerts.slice(-30).reverse(),
});
app.get('/api/tradingview/config', localOnly, (req, res) => res.json(tvInfo()));

const allowAlert = rateLimiter(40, 60_000);
function webhookHandler(req, res) {
  if (!allowAlert()) return res.status(429).json({ ok: false, error: 'rate limited' });
  const parsed = normalizeAlert(parseBody(req.body));
  if (!parsed.ok) return res.status(400).json({ ok: false, error: parsed.error });
  if (!secretMatches(parsed.alert.secret, config.webhookSecret)) {
    log.warn('[tradingview] rejected alert with a bad secret');
    return res.status(401).json({ ok: false, error: 'bad secret' });
  }
  const remote = !isDirect(req);
  if (parsed.alert.action === 'ping') {
    if (remote) tunnel.markReached();
    return res.json({ ok: true, result: 'Connection OK. The floor received this check and placed no trade.' });
  }
  const result = fund.handleAlert(parsed.alert);
  if (remote) tunnel.noteAlert(parsed.alert, result);
  return res.json({ ok: result.ok, result: result.ok ? result.text : result.reason });
}
const textBody = express.text({ type: '*/*', limit: '16kb' });
app.post('/api/tradingview/webhook', textBody, webhookHandler);

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
  const result = fund.handleAlert(parsed.alert);
  res.json({ ok: result.ok, result: result.ok ? result.text : result.reason });
});

const server = http.createServer(app);

// Dedicated webhook-only listener: point your tunnel (cloudflared / ngrok) at this port so
// TradingView can reach the webhook without exposing the dashboard or its controls.
const hookApp = express();
hookApp.disable('x-powered-by');
hookApp.post(['/', '/webhook', '/api/tradingview/webhook'], textBody, webhookHandler);
hookApp.use((req, res) => res.status(404).json({ ok: false, error: 'webhook only: POST /webhook' }));
const hookServer = http.createServer(hookApp);

// ---- WebSocket -------------------------------------------------------------------------------
const wss = new WebSocketServer({ noServer: true });
server.on('upgrade', (req, socket, head) => {
  if (!req.url.startsWith('/ws') || !isDirect(req)) return socket.destroy();
  wss.handleUpgrade(req, socket, head, (ws) => wss.emit('connection', ws, req));
});

function broadcast(msg) {
  if (!wss.clients.size) return;
  const data = JSON.stringify(msg);
  for (const c of wss.clients) if (c.readyState === 1) c.send(data);
}

wss.on('connection', (ws) => {
  ws.send(JSON.stringify({ type: 'init', ...fund.initPayload(), live: live.view(), tunnel: tunnel.view() }));
  ws.on('message', (buf) => {
    try {
      const msg = JSON.parse(buf.toString());
      if (msg.type === 'command') {
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
  for (const c of wss.clients) if (c.readyState === 1) c.send(JSON.stringify({ type: 'init', ...fund.initPayload(), live: live.view(), tunnel: tunnel.view() }));
});
broker.on('trade', (trade) => broadcast({ type: 'trade', trade }));
tunnel.on('change', (view) => broadcast({ type: 'tunnel', tunnel: view }));

// Push the FTMO panel state when it changes (and at least every few seconds).
let lastLive = '';
let lastLiveAt = 0;
function pushLive(force = false) {
  if (!wss.clients.size) return;
  const view = live.view();
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
  await feeds.start();
  if (fund.restore(store.load())) log.info('  Restored track record from', store.file);
  fund.start();
  setInterval(() => store.save(fund.serialize()), 30_000);

  server.listen(config.port, config.host, () => {
    const url = `http://localhost:${config.port}`;
    log.info('');
    log.info(`  ${config.fundName} — Institutional Trading Floor`);
    log.info(`  ─────────────────────────────────────────────`);
    log.info(`  Floor & dashboard:  ${url}`);
    log.info(`  Market data:        ${config.feed === 'sim' ? `SIMULATION (${config.simSpeed}x speed)` : 'LIVE (Binance + Yahoo Finance)'}`);
    for (const n of feeds.notes) log.info(`                      ${n}`);
    log.info(`  TradingView hook:   http://localhost:${config.webhookPort}/webhook   (public address: TradingView tab)`);
    log.info(`  Webhook secret:     ${config.webhookSecret}`);
    log.info(`  FTMO / MT5 bridge:  http://127.0.0.1:${config.port}/api/bridge/sync  (token in the FTMO tab)`);
    log.info(`  Paper trading unless you connect MT5 and arm live trading in the FTMO tab.`);
    log.info('');
    if (config.openBrowser && !process.env.CI) openBrowser(url);
  });
  hookServer.listen(config.webhookPort, config.host, () => tunnel.init());
  hookServer.on('error', (err) => log.warn(`[webhook] port ${config.webhookPort} unavailable: ${err.message}`));
}

let shuttingDown = false;
async function shutdown() {
  if (shuttingDown) return;
  shuttingDown = true;
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
  process.exit(0);
}
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);

server.on('error', (err) => {
  if (err.code === 'EADDRINUSE') {
    log.warn(`\n  Port ${config.port} is already in use. Start with PORT=3100 npm start (or stop the other process).\n`);
    process.exit(1);
  }
  throw err;
});

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
