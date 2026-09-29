import { test } from 'node:test';
import assert from 'node:assert/strict';

import { ema, sma, atr, rsi, anchoredVwap, supertrend, resample, swings } from '../server/market/indicators.js';
import { resolveSymbol, roundToLot, roundToTick } from '../server/market/symbols.js';
import { MarketClock, Session, nyWallToMs, nyParts } from '../server/market/session.js';
import { MarketData } from '../server/market/marketData.js';
import { Broker } from '../server/engine/broker.js';
import { RiskManager } from '../server/engine/risk.js';
import { parseBody, normalizeAlert, secretMatches } from '../server/tradingview/webhook.js';
import { runBacktest } from '../scripts/backtest.js';

const bar = (time, o, h, l, c, v = 100) => ({ time, open: o, high: h, low: l, close: c, volume: v });

test('moving averages', () => {
  const vals = [1, 2, 3, 4, 5, 6];
  assert.deepEqual(sma(vals, 3).slice(2), [2, 3, 4, 5]);
  const e = ema(vals, 3);
  assert.ok(Number.isNaN(e[1]));
  assert.equal(e[2], 2);
  assert.equal(e[3], 3); // 4*0.5 + 2*0.5
});

test('ATR, RSI and VWAP behave on simple series', () => {
  const bars = Array.from({ length: 30 }, (_, i) => bar(i * 60, 100 + i, 101 + i, 99 + i, 100.5 + i));
  const a = atr(bars, 14);
  assert.ok(Math.abs(a[a.length - 1] - 2) < 0.05);
  const r = rsi(bars.map((b) => b.close), 14);
  assert.equal(r[r.length - 1], 100); // only up-moves
  const { vwap } = anchoredVwap(bars, 10);
  assert.ok(Number.isNaN(vwap[9]));
  assert.ok(vwap[29] > vwap[10]);
});

test('supertrend flips with the trend', () => {
  const up = Array.from({ length: 40 }, (_, i) => bar(i * 60, 100 + i, 101 + i, 99.5 + i, 100.8 + i));
  const down = Array.from({ length: 40 }, (_, i) => bar((40 + i) * 60, 140 - 2 * i, 141 - 2 * i, 138 - 2 * i, 138.5 - 2 * i));
  const { dir } = supertrend([...up, ...down], 10, 3);
  assert.equal(dir[35], 1);
  assert.equal(dir[dir.length - 1], -1);
});

test('resample and swings', () => {
  const bars = Array.from({ length: 30 }, (_, i) => bar(i * 60, 10, 10 + (i === 12 ? 5 : 0), 9 - (i === 20 ? 4 : 0), 10));
  const m15 = resample(bars, 15);
  assert.equal(m15.length, 2);
  assert.equal(m15[0].high, 15);
  const { highs, lows } = swings(bars, 3, 100);
  assert.equal(highs[0].index, 12);
  assert.equal(lows[0].index, 20);
});

test('symbol resolution from TradingView tickers', () => {
  assert.equal(resolveSymbol('OANDA:XAUUSD'), 'XAUUSD');
  assert.equal(resolveSymbol('BINANCE:BTCUSDT'), 'BTCUSD');
  assert.equal(resolveSymbol('NQ1!'), 'NAS100');
  assert.equal(resolveSymbol('ethusdt.p'), 'ETHUSD');
  assert.equal(resolveSymbol('AAPL'), null);
  assert.equal(roundToLot('BTCUSD', 1.23456), 1.234);
  assert.equal(roundToTick('NAS100', 24500.13), 24500.25);
});

test('New York session helpers are DST aware', () => {
  const summer = nyWallToMs(2026, 7, 1, 9, 30);
  assert.equal(new Date(summer).toISOString(), '2026-07-01T13:30:00.000Z');
  const winter = nyWallToMs(2026, 12, 1, 9, 30);
  assert.equal(new Date(winter).toISOString(), '2026-12-01T14:30:00.000Z');
  assert.equal(nyParts(summer).hour, 9);
  const clock = new MarketClock('live');
  const session = new Session(clock);
  // 17:30 NY is inside the live flatten window; 10:00 NY is not.
  assert.equal(session.isFlattenWindow(nyWallToMs(2026, 7, 1, 17, 30)), true);
  assert.equal(session.isFlattenWindow(nyWallToMs(2026, 7, 1, 10, 0)), false);
  // The live trading day rolls at 18:00 NY.
  assert.equal(session.tradingDay(nyWallToMs(2026, 7, 1, 17, 59)), '2026-07-01');
  assert.equal(session.tradingDay(nyWallToMs(2026, 7, 1, 18, 1)), '2026-07-02');
});

function makeBroker(price = 100) {
  const clock = new MarketClock('sim', 1);
  const md = new MarketData(clock);
  md.applyTick('SPX500', price, 1, clock.now());
  return { md, clock, broker: new Broker(md, clock) };
}

test('broker books round trips, fees and partial exits', () => {
  const { md, clock, broker } = makeBroker(6000);
  const r1 = broker.execute('t', 'SPX500', 10, { reason: 'entry', initialRisk: 1000 });
  assert.ok(r1.fill.price >= 6000);
  assert.equal(broker.position('t', 'SPX500').qty, 10);
  md.applyTick('SPX500', 6050, 1, clock.now());
  broker.execute('t', 'SPX500', -5, { reason: 'scale' });
  assert.equal(broker.position('t', 'SPX500').qty, 5);
  const r3 = broker.execute('t', 'SPX500', -5, { reason: 'target' });
  assert.equal(r3.closed.length, 1);
  const trade = r3.closed[0];
  assert.equal(trade.side, 'LONG');
  assert.equal(trade.qty, 10);
  assert.ok(trade.pnl > 400 && trade.pnl < 500, `pnl ${trade.pnl}`);
  assert.ok(trade.r > 0.4 && trade.r < 0.5);
  const book = broker.book('t');
  assert.ok(Math.abs(book.realizedDay - trade.pnl) < 1e-6);
  assert.equal(book.positions.size, 0);
});

test('broker handles flips and USDJPY P&L conversion', () => {
  const clock = new MarketClock('sim', 1);
  const md = new MarketData(clock);
  const broker = new Broker(md, clock);
  md.applyTick('USDJPY', 150, 1, clock.now());
  broker.execute('t', 'USDJPY', 1_000_000, { maker: true, price: 150 });
  md.applyTick('USDJPY', 151.5, 1, clock.now());
  // Unrealized: 1,000,000 * 1.5 JPY / 151.5 ≈ $9,901
  assert.ok(Math.abs(broker.unrealized('t') - 9901) < 5);
  const res = broker.execute('t', 'USDJPY', -2_000_000, { maker: true, price: 151.5 });
  assert.equal(res.closed.length, 1);
  assert.equal(broker.position('t', 'USDJPY').qty, -1_000_000);
});

test('risk sizing respects risk budget and leverage cap', () => {
  const clock = new MarketClock('sim', 1);
  const risk = new RiskManager({ riskPerTradePct: 0.005, deskDailyLossPct: 0.02, fundDailyLossPct: 0.01, maxLeverage: 4 }, new Session(clock));
  const agent = { allocation: 10_000_000, profile: {} };
  // $50k risk / $10 stop = 5,000 units of SPX500 → notional 30M < 40M cap.
  assert.equal(risk.size(agent, 'SPX500', 6000, 5990), 5000);
  // Tiny stop would imply 500k units; capped at 4x allocation / price.
  assert.equal(risk.size(agent, 'SPX500', 6000, 5999.9), Math.floor(40_000_000 / 6000));
  assert.equal(risk.size(agent, 'SPX500', 6000, 6000), 0);
});

test('TradingView alert parsing', () => {
  const json = parseBody('{"secret":"abc","agent":"Amara","symbol":"OANDA:XAUUSD","action":"BUY","price":"2,345.5","sl":2330}');
  const a = normalizeAlert(json);
  assert.equal(a.ok, true);
  assert.equal(a.alert.agent, 'amara');
  assert.equal(a.alert.symbol, 'XAUUSD');
  assert.equal(a.alert.action, 'buy');
  assert.equal(a.alert.price, 2345.5);
  assert.equal(a.alert.stop, 2330);

  const strat = normalizeAlert(parseBody('{"secret":"x","action":"sell","position":"flat","symbol":"BTCUSDT"}'));
  assert.equal(strat.alert.action, 'close');

  const text = normalizeAlert(parseBody('SELL NQ1! agent=marcus secret=zzz'));
  assert.equal(text.alert.action, 'sell');
  assert.equal(text.alert.symbol, 'NAS100');
  assert.equal(text.alert.secret, 'zzz');

  assert.equal(normalizeAlert(parseBody('{"action":"hold"}')).ok, false);
  assert.equal(secretMatches('abc', 'abc'), true);
  assert.equal(secretMatches('abd', 'abc'), false);
  assert.equal(secretMatches('', ''), false);
});

test('a simulated session runs every desk without errors', () => {
  const fund = runBacktest({ sessions: 1, seed: 7, quiet: true });
  assert.ok(Number.isFinite(fund.nav()));
  const totalTrades = fund.agents.reduce((s, a) => s + a.lifetime.trades, 0);
  assert.ok(totalTrades > 10, `expected trading activity, got ${totalTrades}`);
  for (const a of fund.agents) {
    const snap = a.snapshot();
    assert.ok(Number.isFinite(snap.pnl.total), `${a.id} P&L`);
    assert.equal(snap.positions.length, 0, `${a.id} must be flat after the close`);
    assert.ok(!a.log.some((l) => l.kind === 'error'), `${a.id} logged a strategy error`);
    const b = a.briefing();
    assert.ok(b.text.includes(a.firstName));
    assert.equal(b.greeting, 'Hello boss!');
  }
});

test('paper P&L can be reset to zero', () => {
  const fund = runBacktest({ sessions: 1, seed: 3, quiet: true });
  assert.ok(fund.agents.some((a) => a.lifetime.trades > 0));
  fund.resetPaper();
  for (const a of fund.agents) {
    assert.equal(a.lifetime.trades, 0);
    assert.equal(fund.broker.book(a.id).trades.length, 0);
    assert.equal(a.book.realizedTotal, 0);
  }
  assert.ok(Math.abs(fund.nav() - fund.config.startingCapital) < 1e-6);
});
