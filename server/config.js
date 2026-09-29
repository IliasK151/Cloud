import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { loadEnv } from './util/env.js';

export const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
loadEnv(path.join(ROOT, '.env'));

const DATA_DIR = path.resolve(ROOT, process.env.DATA_DIR || 'data');
fs.mkdirSync(DATA_DIR, { recursive: true });

// The webhook secret protects the TradingView endpoint. If you don't set one,
// a random secret is generated once and kept in data/webhook-secret.txt.
function resolveWebhookSecret() {
  if (process.env.WEBHOOK_SECRET) return process.env.WEBHOOK_SECRET;
  const file = path.join(DATA_DIR, 'webhook-secret.txt');
  if (fs.existsSync(file)) return fs.readFileSync(file, 'utf8').trim();
  const secret = crypto.randomBytes(12).toString('hex');
  fs.writeFileSync(file, secret + '\n', { mode: 0o600 });
  return secret;
}

const num = (value, fallback) => {
  const n = Number(value);
  return Number.isFinite(n) ? n : fallback;
};

const feed = (process.env.FEED || 'live').toLowerCase() === 'sim' ? 'sim' : 'live';

export const config = {
  port: num(process.env.PORT, 3000),
  // Webhook-only listener for TradingView (tunnel this port, never the dashboard).
  webhookPort: num(process.env.WEBHOOK_PORT, num(process.env.PORT, 3000) + 1),
  host: process.env.HOST || '127.0.0.1',
  feed,
  // Market-seconds that pass per real second in simulation mode.
  simSpeed: Math.max(1, num(process.env.SIM_SPEED, 20)),
  fundName: process.env.FUND_NAME || 'Meridian Capital',
  startingCapital: num(process.env.STARTING_CAPITAL, 100_000_000),
  webhookSecret: resolveWebhookSecret(),
  openBrowser: process.env.OPEN_BROWSER !== '0',
  dataDir: DATA_DIR,
  risk: {
    riskPerTradePct: num(process.env.RISK_PER_TRADE_PCT, 0.5) / 100,
    deskDailyLossPct: num(process.env.DESK_DAILY_LOSS_PCT, 2) / 100,
    fundDailyLossPct: num(process.env.FUND_DAILY_LOSS_PCT, 1.2) / 100,
    maxLeverage: num(process.env.MAX_LEVERAGE, 4),
  },
};
