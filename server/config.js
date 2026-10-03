import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { isMainThread } from 'node:worker_threads';
import { loadEnv } from './util/env.js';

export const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
loadEnv(path.join(ROOT, '.env'));

// Everything the floor writes (secrets, account setup, track record) is readable by your
// macOS user only: new files 0600, folders 0700. (Set once by the main thread: worker threads
// share the process and aren't allowed to change it.)
if (isMainThread) process.umask(0o077);

const DATA_DIR = path.resolve(ROOT, process.env.DATA_DIR || 'data');
fs.mkdirSync(DATA_DIR, { recursive: true });
try {
  fs.chmodSync(DATA_DIR, 0o700);
  for (const f of fs.readdirSync(DATA_DIR)) {
    const full = path.join(DATA_DIR, f);
    if (fs.statSync(full).isFile()) fs.chmodSync(full, 0o600);
  }
} catch {
  /* best effort (e.g. a read-only or foreign-owned folder) */
}

// The webhook secret protects the TradingView endpoint. If you don't set one,
// a random secret is generated once and kept in data/webhook-secret.txt.
function resolveWebhookSecret() {
  if (process.env.WEBHOOK_SECRET) return process.env.WEBHOOK_SECRET;
  const file = path.join(DATA_DIR, 'webhook-secret.txt');
  if (fs.existsSync(file)) return fs.readFileSync(file, 'utf8').trim();
  const secret = crypto.randomBytes(16).toString('hex');
  fs.writeFileSync(file, secret + '\n', { mode: 0o600 });
  return secret;
}

// Shared secret between the MT5 bridge EA and the floor (data/bridge-token.txt).
function resolveBridgeToken() {
  if (process.env.BRIDGE_TOKEN) return process.env.BRIDGE_TOKEN;
  const file = path.join(DATA_DIR, 'bridge-token.txt');
  if (fs.existsSync(file)) return fs.readFileSync(file, 'utf8').trim();
  const token = crypto.randomBytes(16).toString('hex');
  fs.writeFileSync(file, token + '\n', { mode: 0o600 });
  return token;
}

const num = (value, fallback) => {
  const n = Number(value);
  return Number.isFinite(n) ? n : fallback;
};

const feed = (process.env.FEED || 'live').toLowerCase() === 'sim' ? 'sim' : 'live';

// The Obsidian vault the floor writes (server/vault/vault.js): data/vault, or VAULT_DIR (for
// example ~/Documents/Meridian Vault). Demo mode always writes its own, data/vault-demo, so
// made-up prices never mix with the real vault.
function resolveVaultDir() {
  if (feed === 'sim') return path.join(DATA_DIR, 'vault-demo');
  const v = (process.env.VAULT_DIR || '').trim();
  if (!v) return path.join(DATA_DIR, 'vault');
  return path.resolve(ROOT, v.startsWith('~') ? path.join(os.homedir(), v.slice(1)) : v);
}

export const config = {
  port: num(process.env.PORT, 3000),
  // Webhook-only listener for TradingView (tunnel this port, never the dashboard).
  webhookPort: num(process.env.WEBHOOK_PORT, num(process.env.PORT, 3000) + 1),
  host: process.env.HOST || '127.0.0.1',
  // Opening the floor from another device on your Wi-Fi (HOST=0.0.0.0) requires a password.
  floorPassword: process.env.FLOOR_PASSWORD || '',
  allowedHosts: (process.env.ALLOWED_HOSTS || '').split(',').map((s) => s.trim()).filter(Boolean),
  // Separate origin that hosts the TradingView chart widget, isolated from the floor.
  widgetPort: num(process.env.WIDGET_PORT, num(process.env.PORT, 3000) + 2),
  feed,
  // Market-seconds that pass per real second in simulation mode.
  simSpeed: Math.max(1, num(process.env.SIM_SPEED, 20)),
  fundName: process.env.FUND_NAME || 'Meridian Capital',
  startingCapital: num(process.env.STARTING_CAPITAL, 100_000_000),
  webhookSecret: resolveWebhookSecret(),
  webhookSecretFromEnv: !!process.env.WEBHOOK_SECRET,
  bridgeToken: resolveBridgeToken(),
  openBrowser: process.env.OPEN_BROWSER !== '0',
  // macOS: keep the Mac awake while the floor runs (trades, alerts and MT5 need it).
  keepAwake: process.env.KEEP_AWAKE !== '0',
  dataDir: DATA_DIR,
  vault: process.env.VAULT !== '0', // VAULT=0 turns the vault off
  vaultDir: resolveVaultDir(),
  risk: {
    riskPerTradePct: num(process.env.RISK_PER_TRADE_PCT, 0.5) / 100,
    deskDailyLossPct: num(process.env.DESK_DAILY_LOSS_PCT, 2) / 100,
    fundDailyLossPct: num(process.env.FUND_DAILY_LOSS_PCT, 1.2) / 100,
    maxLeverage: num(process.env.MAX_LEVERAGE, 4),
  },
};
