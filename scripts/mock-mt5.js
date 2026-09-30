// A pretend MetaTrader 5 terminal that speaks the MeridianBridge protocol.
// Lets you try the whole FTMO flow (connect → set up → arm → desks trade) without MT5:
//
//   npm start            (in one terminal)
//   npm run mock-mt5     (in another)
//
// It invents an FTMO-style Free Trial account with its own random-walk prices, executes
// the floor's orders, and enforces stop-loss / take-profit like a broker would.
import { config } from '../server/config.js';

const URL = process.env.BRIDGE_URL || `http://127.0.0.1:${config.port}/api/bridge/sync`;
const TOKEN = config.bridgeToken;
const LOGIN = Number(process.env.MOCK_LOGIN || 1520034567);
const SERVER = process.env.MOCK_SERVER || 'FTMO-Demo';
const START_BALANCE = Number(process.env.MOCK_BALANCE || 100_000);
const GMT_OFFSET = 3 * 3600;

// Broker-style symbol specs (1 lot values are approximations, good enough for a demo).
const SPECS = {
  'US100.cash': { price: 24500, digits: 2, tickSize: 0.01, tickValue: 0.01, volMin: 0.01, volStep: 0.01, volMax: 100, vol: 0.22, spread: 1.0 },
  'US500.cash': { price: 6650, digits: 2, tickSize: 0.01, tickValue: 0.01, volMin: 0.01, volStep: 0.01, volMax: 100, vol: 0.17, spread: 0.5 },
  XAUUSD: { price: 3800, digits: 2, tickSize: 0.01, tickValue: 1, volMin: 0.01, volStep: 0.01, volMax: 50, vol: 0.18, spread: 0.25 },
  'USOIL.cash': { price: 64, digits: 2, tickSize: 0.01, tickValue: 1, volMin: 0.01, volStep: 0.01, volMax: 50, vol: 0.34, spread: 0.03 },
  EURUSD: { price: 1.17, digits: 5, tickSize: 0.00001, tickValue: 1, volMin: 0.01, volStep: 0.01, volMax: 50, vol: 0.07, spread: 0.00008 },
  USDJPY: { price: 148, digits: 3, tickSize: 0.001, tickValue: 0.68, volMin: 0.01, volStep: 0.01, volMax: 50, vol: 0.09, spread: 0.012 },
  BTCUSD: { price: 112000, digits: 2, tickSize: 0.01, tickValue: 0.01, volMin: 0.01, volStep: 0.01, volMax: 20, vol: 0.45, spread: 15 },
  ETHUSD: { price: 4100, digits: 2, tickSize: 0.01, tickValue: 0.01, volMin: 0.01, volStep: 0.01, volMax: 200, vol: 0.6, spread: 1.2 },
  SOLUSD: { price: 210, digits: 2, tickSize: 0.01, tickValue: 0.01, volMin: 0.1, volStep: 0.1, volMax: 2000, vol: 0.75, spread: 0.1 },
};
const EXTRA_SYMBOLS = ['GBPUSD', 'AUDUSD', 'USDCHF', 'GER40.cash', 'UK100.cash', 'JP225.cash', 'XAGUSD', 'UKOIL.cash', 'US30.cash'];

const gauss = () => Math.sqrt(-2 * Math.log(Math.random() || 1e-9)) * Math.cos(2 * Math.PI * Math.random());
const minuteOf = (sec) => Math.floor(sec / 60) * 60;

// Random-walk prices with 1-minute bars in broker server time.
const market = {};
const nowSec = () => Math.floor(Date.now() / 1000) + GMT_OFFSET;
for (const [sym, s] of Object.entries(SPECS)) {
  const sigmaMin = s.vol / Math.sqrt(252 * 390);
  const bars = [];
  let p = s.price;
  const t0 = minuteOf(nowSec()) - 6000 * 60;
  for (let i = 0; i < 6000; i++) {
    const o = p;
    let h = o;
    let l = o;
    for (let k = 0; k < 6; k++) {
      p *= Math.exp(sigmaMin / Math.sqrt(6) * gauss());
      h = Math.max(h, p);
      l = Math.min(l, p);
    }
    bars.push({ time: t0 + i * 60, open: o, high: h, low: l, close: p, volume: Math.round(50 + Math.random() * 200) });
  }
  market[sym] = { bars, price: p, sigmaSec: sigmaMin / Math.sqrt(60) };
}

function stepMarket(dtSec) {
  const t = minuteOf(nowSec());
  for (const m of Object.values(market)) {
    m.price *= Math.exp(m.sigmaSec * Math.sqrt(dtSec) * gauss());
    let cur = m.bars[m.bars.length - 1];
    if (cur.time < t) {
      cur = { time: t, open: m.price, high: m.price, low: m.price, close: m.price, volume: 0 };
      m.bars.push(cur);
      if (m.bars.length > 6500) m.bars.shift();
    }
    cur.high = Math.max(cur.high, m.price);
    cur.low = Math.min(cur.low, m.price);
    cur.close = m.price;
    cur.volume += Math.round(Math.random() * 20);
  }
}

const quote = (sym) => {
  const s = SPECS[sym];
  const mid = market[sym].price;
  return { bid: +(mid - s.spread / 2).toFixed(s.digits), ask: +(mid + s.spread / 2).toFixed(s.digits) };
};

// Account state
// MOCK_PNL rehearses a drawdown (or a profit) from the account's starting size, e.g. MOCK_PNL=-100.
let balance = START_BALANCE + Number(process.env.MOCK_PNL || 0);
let closedToday = 0;
let ticketSeq = 50_000_000;
const positions = new Map();
const deals = [];
let watch = [];
let history = [];
let sendSymbols = true;
let acks = [];
const done = new Set();

const pnlOf = (p) => {
  const s = SPECS[p.symbol];
  const q = quote(p.symbol);
  const exit = p.side === 'BUY' ? q.bid : q.ask;
  return ((p.side === 'BUY' ? exit - p.open : p.open - exit) / s.tickSize) * s.tickValue * p.volume;
};

function closePosition(p, volume, reason) {
  const s = SPECS[p.symbol];
  const part = Math.min(volume, p.volume);
  const q = quote(p.symbol);
  const exit = p.side === 'BUY' ? q.bid : q.ask;
  const pnl = ((p.side === 'BUY' ? exit - p.open : p.open - exit) / s.tickSize) * s.tickValue * part;
  balance += pnl;
  closedToday += pnl;
  deals.push({ ticket: ++ticketSeq, position: p.ticket, symbol: p.symbol, type: p.side === 'BUY' ? 1 : 0, entry: 1, volume: part, price: exit, pnl: +pnl.toFixed(2), magic: p.magic, comment: reason, time: nowSec() });
  p.volume = +(p.volume - part).toFixed(2);
  if (p.volume <= 1e-9) positions.delete(p.ticket);
  console.log(`  [mock] ${reason}: ${p.side} ${part} ${p.symbol} @ ${exit} → ${pnl >= 0 ? '+' : ''}${pnl.toFixed(2)}`);
  return exit;
}

function checkStops() {
  for (const p of [...positions.values()]) {
    const q = quote(p.symbol);
    const px = p.side === 'BUY' ? q.bid : q.ask;
    if (p.sl && (p.side === 'BUY' ? px <= p.sl : px >= p.sl)) closePosition(p, p.volume, '[sl]');
    else if (p.tp && (p.side === 'BUY' ? px >= p.tp : px <= p.tp)) closePosition(p, p.volume, '[tp]');
  }
}

function ack(id, ok, extra = {}) {
  acks.push({ id, ok, retcode: ok ? 10009 : 10013, ticket: 0, price: 0, volume: 0, msg: ok ? 'done' : 'invalid request', ...extra });
}

function handle(text) {
  for (const raw of text.split('\n')) {
    const line = raw.trim();
    if (!line || line === 'OK') continue;
    const f = line.split('|');
    const cmd = f[0];
    if (cmd === 'watch') watch = (f[1] || '').split(',').filter(Boolean);
    else if (cmd === 'history') history.push([f[1], Number(f[2])]);
    else if (cmd === 'symbols') sendSymbols = true;
    else if (['open', 'close', 'modify', 'closeall'].includes(cmd)) {
      const id = f[1];
      if (done.has(id)) { ack(id, true, { msg: 'duplicate' }); continue; }
      done.add(id);
      if (cmd === 'open') {
        const [, , symbol, side, vol, slDist, tpDist, magic, comment] = f;
        const s = SPECS[symbol];
        if (!s) { ack(id, false, { msg: `unknown symbol ${symbol}` }); continue; }
        const q = quote(symbol);
        const open = side === 'BUY' ? q.ask : q.bid;
        const sl = +(side === 'BUY' ? open - Number(slDist) : open + Number(slDist)).toFixed(s.digits);
        const tp = Number(tpDist) > 0 ? +(side === 'BUY' ? open + Number(tpDist) : open - Number(tpDist)).toFixed(s.digits) : 0;
        const ticket = ++ticketSeq;
        positions.set(ticket, { ticket, symbol, side, volume: Number(vol), open, sl, tp, magic: Number(magic), comment, time: nowSec() });
        console.log(`  [mock] OPEN ${side} ${vol} ${symbol} @ ${open} sl ${sl} tp ${tp || '-'} (${comment})`);
        ack(id, true, { ticket, price: open, volume: Number(vol) });
      } else if (cmd === 'close') {
        const p = positions.get(Number(f[2]));
        if (!p) { ack(id, true, { msg: 'position already closed' }); continue; }
        const frac = Number(f[3]);
        const vol = frac >= 0.999 ? p.volume : Math.floor((p.volume * frac) / SPECS[p.symbol].volStep) * SPECS[p.symbol].volStep;
        if (vol <= 0) { ack(id, false, { msg: 'partial volume not tradable' }); continue; }
        const price = closePosition(p, +vol.toFixed(2), frac >= 0.999 ? 'close' : 'partial');
        ack(id, true, { ticket: p.ticket, price, volume: vol });
      } else if (cmd === 'modify') {
        const p = positions.get(Number(f[2]));
        if (!p) { ack(id, true, { msg: 'position already closed' }); continue; }
        p.sl = Number(f[3]);
        if (f[4] !== 'keep') p.tp = Number(f[4]);
        console.log(`  [mock] MODIFY #${p.ticket} sl → ${p.sl}`);
        ack(id, true, { ticket: p.ticket, price: p.sl });
      } else if (cmd === 'closeall') {
        let n = 0;
        for (const p of [...positions.values()]) if (p.magic > 771000 && p.magic < 771100) { closePosition(p, p.volume, 'closeall'); n++; }
        ack(id, true, { msg: `closed ${n}`, volume: n });
      }
    }
  }
}

const rows = (bars) => bars.map((b) => [b.time, +b.open.toFixed(6), +b.high.toFixed(6), +b.low.toFixed(6), +b.close.toFixed(6), b.volume]);

async function sync() {
  checkStops();
  let floating = 0;
  for (const p of positions.values()) floating += pnlOf(p);
  const quotes = {};
  for (const sym of watch) {
    if (!SPECS[sym]) continue;
    const s = SPECS[sym];
    quotes[sym] = { ...quote(sym), digits: s.digits, point: s.tickSize, tickSize: s.tickSize, tickValue: s.tickValue, tickValueLoss: s.tickValue, contractSize: 1, volMin: s.volMin, volStep: s.volStep, volMax: s.volMax, stopsLevel: 0, tradeMode: 4, bars: rows(market[sym].bars.slice(-2)) };
  }
  const body = {
    token: TOKEN,
    version: 'mock-1.0',
    account: {
      login: LOGIN, server: SERVER, company: 'FTMO S.R.O. (mock)', name: 'Demo Trader', currency: 'USD',
      balance: +balance.toFixed(2), equity: +(balance + floating).toFixed(2), margin: 0, freeMargin: +(balance + floating).toFixed(2),
      leverage: 100, tradeMode: 0, marginMode: 2, tradeAllowed: true, expertAllowed: true, algoAllowed: true, connected: true,
      initialDeposit: START_BALANCE, closedToday: +closedToday.toFixed(2),
    },
    positions: [...positions.values()].map((p) => {
      const q = quote(p.symbol);
      return { ...p, current: p.side === 'BUY' ? q.bid : q.ask, profit: +pnlOf(p).toFixed(2) };
    }),
    deals: deals.slice(-40),
    quotes,
    serverTime: nowSec(),
    gmtOffset: GMT_OFFSET,
    serverDay: new Date(nowSec() * 1000).toISOString().slice(0, 10).replace(/-/g, '.'),
    acks,
  };
  if (sendSymbols) body.symbols = [...Object.keys(SPECS), ...EXTRA_SYMBOLS];
  const hist = history;
  if (hist.length) body.history = Object.fromEntries(hist.filter(([s]) => market[s]).map(([s, n]) => [s, rows(market[s].bars.slice(-n - 1, -1))]));
  try {
    const res = await fetch(URL, { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Bridge-Token': TOKEN }, body: JSON.stringify(body) });
    const text = await res.text();
    if (!res.ok) {
      console.log(`  [mock] floor replied ${res.status}: ${text.trim()}`);
      return;
    }
    acks = [];
    if (body.symbols) sendSymbols = false;
    if (hist.length) history = [];
    handle(text);
  } catch (err) {
    console.log(`  [mock] floor not reachable (${err.message}) — is npm start running?`);
  }
}

console.log(`\n  Mock MT5 terminal · account ${LOGIN} on ${SERVER} · balance $${START_BALANCE.toLocaleString()}`);
console.log(`  Syncing with ${URL} every 500 ms. Open the floor's FTMO tab. Ctrl+C to stop.\n`);
let last = Date.now();
let busy = false;
setInterval(async () => {
  const now = Date.now();
  stepMarket((now - last) / 1000);
  last = now;
  if (busy) return;
  busy = true;
  await sync();
  busy = false;
}, 500);
