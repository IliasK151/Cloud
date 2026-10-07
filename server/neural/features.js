import { atr, rsi } from '../market/indicators.js';
import { nyMinuteOfDay, nyParts } from '../market/session.js';
import { tradeCostR } from '../market/symbols.js';

// What the neural brain senses about a trade idea, at the moment a desk wants to take it.
//
// About fifty numbers, each roughly between -1 and +1, most of them signed in the trade's
// favour (+ helps the trade, - hurts it), so the network learns "with the trend" rather than
// "up". They come from the floor's market brain (the same read the committee argues from)
// and from the 1-minute bars, so the floor and the replays used for training compute the
// very same senses. Groups are for the 3D view and the explanations.
//
// No news sense: the replays it learns from have no historical calendar, and a sense it never
// saw move would act unpredictably live. News is handled before the brain is asked (the
// committee's news veto and the blackouts around releases).

const clamp = (x, lo = -1, hi = 1) => (Number.isFinite(x) ? Math.max(lo, Math.min(hi, x)) : 0);
const squash = (x, k = 1) => (Number.isFinite(x) ? Math.tanh(x / k) : 0);

// Market classes and strategy styles, one input each (the network can learn that a breakout
// in gold behaves differently from one in the Nasdaq).
const MARKET = { EURUSD: 'fx', GBPUSD: 'fx', USDJPY: 'fx', XAUUSD: 'gold', NAS100: 'index', SPX500: 'index', USOIL: 'oil', BTCUSD: 'crypto', ETHUSD: 'crypto', SOLUSD: 'crypto' };
const MARKETS = ['fx', 'gold', 'index', 'oil', 'crypto'];
const STYLE = {
  'Liquidity Scalp (AJ Currency style)': 'scalp', // the retired scalpers' trades, in what it learned from
  'Liquidity Sweep Reversal': 'sweep',
  'Top-Down Day Trading (TJR style)': 'sweep', // a sweep of liquidity with the higher-timeframe bias
  'Opening Range Breakout': 'breakout',
  'Volatility Squeeze Breakout': 'breakout',
  'Top-Down Market Structure': 'trend',
  'Trend Momentum': 'trend',
  'Trend Pullback': 'trend',
  'VWAP Mean Reversion': 'reversion',
  'TradingView Signals + Supertrend': 'signals',
  'Quant Research': 'research',
};
const STYLES = ['scalp', 'sweep', 'breakout', 'trend', 'reversion', 'signals', 'research'];

export const FEATURES = [
  // Trend and momentum
  { key: 'htf', group: 'Trend', label: 'Hourly trend with the trade' },
  { key: 'trend', group: 'Trend', label: '15-minute trend with the trade' },
  { key: 'structure', group: 'Trend', label: 'Swing structure with the trade' },
  { key: 'momentum', group: 'Trend', label: 'Momentum with the trade' },
  { key: 'ret5', group: 'Trend', label: 'Last 5 minutes moved the trade\'s way' },
  { key: 'ret15', group: 'Trend', label: 'Last 15 minutes moved the trade\'s way' },
  { key: 'ret60', group: 'Trend', label: 'Last hour moved the trade\'s way' },
  { key: 'ret240', group: 'Trend', label: 'Last 4 hours moved the trade\'s way' },
  { key: 'rsi', group: 'Trend', label: '1-minute RSI with the trade' },
  // Location
  { key: 'stretch', group: 'Location', label: 'Fair price, not chasing' },
  { key: 'vwapZ', group: 'Location', label: 'Distance from VWAP in the trade\'s direction' },
  { key: 'location', group: 'Location', label: 'A level right behind the entry' },
  { key: 'room', group: 'Location', label: 'Room to run before the next level' },
  { key: 'roomR', group: 'Location', label: 'Room to the next level, in R' },
  { key: 'dayPos', group: 'Location', label: 'Where price sits in today\'s range' },
  { key: 'prevHigh', group: 'Location', label: 'Past the prior day\'s high' },
  { key: 'prevLow', group: 'Location', label: 'Past the prior day\'s low' },
  // Volatility and regime
  { key: 'volPct', group: 'Volatility', label: 'Volatility for this time of day' },
  { key: 'volatility', group: 'Volatility', label: 'Volatility is healthy' },
  { key: 'atrRatio', group: 'Volatility', label: 'Last minutes livelier than usual' },
  { key: 'regimeWith', group: 'Volatility', label: 'Trending market, with the trade' },
  { key: 'regimeRange', group: 'Volatility', label: 'Ranging market' },
  { key: 'regimeSqueeze', group: 'Volatility', label: 'Volatility squeeze' },
  { key: 'regimeVolatile', group: 'Volatility', label: 'Volatile market' },
  // The trade itself
  { key: 'side', group: 'Trade', label: 'Long (+) or short (−)' },
  { key: 'stopAtr', group: 'Trade', label: 'Stop distance, in ATR' },
  { key: 'rr', group: 'Trade', label: 'Target, in R' },
  { key: 'hasTarget', group: 'Trade', label: 'Has a fixed target' },
  { key: 'costR', group: 'Trade', label: 'Costs, in R' },
  // Time
  { key: 'hourSin', group: 'Time', label: 'Time of day (1)' },
  { key: 'hourCos', group: 'Time', label: 'Time of day (2)' },
  { key: 'dowSin', group: 'Time', label: 'Day of the week (1)' },
  { key: 'dowCos', group: 'Time', label: 'Day of the week (2)' },
  // The desk
  { key: 'form', group: 'Desk', label: 'The desk\'s recent results' },
  { key: 'streak', group: 'Desk', label: 'Losses in a row' },
  { key: 'tradesToday', group: 'Desk', label: 'Trades already today' },
  { key: 'confidence', group: 'Desk', label: 'The desk\'s own confidence' },
  ...MARKETS.map((m) => ({ key: `mkt:${m}`, group: 'Market', label: { fx: 'FX', gold: 'Gold', index: 'Stock index', oil: 'Oil', crypto: 'Crypto' }[m] })),
  ...STYLES.map((s) => ({ key: `style:${s}`, group: 'Style', label: { scalp: 'Scalp', sweep: 'Liquidity sweep', breakout: 'Breakout', trend: 'Trend', reversion: 'Mean reversion', signals: 'TradingView signal', research: 'Research strategy' }[s] })),
];
export const N_FEATURES = FEATURES.length;
const INDEX = new Map(FEATURES.map((f, i) => [f.key, i]));

export const styleOf = (agent) => STYLE[agent?.constructor?.strategyName] || STYLE[agent?.profile?.Strategy?.strategyName] || 'trend';

// The senses for one trade idea, or null when the market brain can't read the market yet.
//   brain: MarketBrain · agent: the desk · bars: its 1-minute bars (oldest first)
export function senseTrade({ brain, agent, symbol, side, entry, stop, target = null, now }) {
  const a = brain?.assess(symbol, side, { entry, stop, target });
  if (!a) return null;
  const r = a.read;
  const dir = side === 'LONG' ? 1 : -1;
  const x = new Float64Array(N_FEATURES);
  const set = (k, v) => { x[INDEX.get(k)] = clamp(v); };
  const f = (k) => a.f[k]?.value ?? 0;

  for (const k of ['htf', 'trend', 'structure', 'momentum', 'stretch', 'location', 'room', 'volatility']) set(k, f(k));

  const bars = agent?.md?.bars(symbol) || [];
  const n = bars.length;
  const c = n ? bars[n - 1].close : entry;
  const a1Series = n > 20 ? atr(bars.slice(-120), 14) : [];
  const atr1 = a1Series.length ? a1Series[a1Series.length - 1] : r.atr1;
  const ret = (k) => (n > k && atr1 > 0 ? squash((dir * (c - bars[n - 1 - k].close)) / (atr1 * Math.sqrt(k)), 1.5) : 0);
  set('ret5', ret(5));
  set('ret15', ret(15));
  set('ret60', ret(60));
  set('ret240', ret(240));
  const rs = n > 20 ? rsi(bars.slice(-60).map((b) => b.close), 14) : [];
  const rNow = rs.length ? rs[rs.length - 1] : 50;
  set('rsi', (dir * (rNow - 50)) / 50);

  set('vwapZ', squash(dir * r.z, 2));
  set('roomR', a.roomR == null ? 1 : Math.min(a.roomR, 5) / 2.5 - 1);
  const { hi, lo, prevHi: ph, prevLo: pl } = r.day || {};
  if (Number.isFinite(hi) && Number.isFinite(lo) && hi > lo) {
    const pos = (entry - lo) / (hi - lo);
    set('dayPos', dir > 0 ? 2 * pos - 1 : 1 - 2 * pos);
  }
  const atr5 = r.atr5 || atr1 * 2.2 || 0;
  if (Number.isFinite(ph) && atr5 > 0) set('prevHigh', squash((dir * (entry - ph)) / atr5, 4));
  if (Number.isFinite(pl) && atr5 > 0) set('prevLow', squash((dir * (entry - pl)) / atr5, 4));

  set('volPct', 2 * (r.volPct ?? 0.5) - 1);
  set('atrRatio', atr5 > 0 && atr1 > 0 ? squash((atr1 * Math.sqrt(5)) / atr5 - 1, 0.5) : 0);
  const rk = r.regime?.key;
  set('regimeWith', rk === 'trend-up' ? dir : rk === 'trend-down' ? -dir : 0);
  set('regimeRange', rk === 'range' ? 1 : 0);
  set('regimeSqueeze', rk === 'squeeze' ? 1 : 0);
  set('regimeVolatile', rk === 'volatile' ? 1 : 0);

  const risk = Math.abs(entry - stop);
  set('side', dir);
  set('stopAtr', atr5 > 0 ? squash(risk / atr5, 2) : 0);
  set('rr', target != null && risk > 0 ? Math.min(Math.abs(target - entry) / risk, 4) / 2 - 1 : -1);
  set('hasTarget', target != null ? 1 : -1);
  const cost = tradeCostR(symbol, entry, stop);
  set('costR', cost == null ? 0 : Math.min(cost, 0.5) * 4 - 1);

  const m = nyMinuteOfDay(now);
  set('hourSin', Math.sin((2 * Math.PI * m) / 1440));
  set('hourCos', Math.cos((2 * Math.PI * m) / 1440));
  const dow = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'].indexOf(nyParts(now).weekday);
  set('dowSin', Math.sin((2 * Math.PI * dow) / 7));
  set('dowCos', Math.cos((2 * Math.PI * dow) / 7));

  const recent = agent?.lifetime?.recentR || [];
  const last = recent.slice(-20);
  set('form', last.length ? squash(last.reduce((s, v) => s + v, 0) / last.length, 0.5) : 0);
  let streak = 0;
  for (let i = recent.length - 1; i >= 0 && recent[i] <= 0; i--) streak++;
  set('streak', Math.min(streak, 5) / 2.5 - 1);
  set('tradesToday', Math.min(agent?.day?.entries ?? 0, 6) / 3 - 1);
  set('confidence', ((agent?.setup?.confidence ?? 50) - 50) / 50);

  const mk = MARKET[symbol];
  if (mk) set(`mkt:${mk}`, 1);
  set(`style:${styleOf(agent)}`, 1);
  return x;
}

// Plain numbers, for saving and sending to the browser.
export const toArray = (x) => Array.from(x, (v) => Math.round(v * 1e4) / 1e4);
