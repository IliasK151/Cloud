import { OpeningRangeBreakout } from './strategies/orb.js';
import { MarketStructure } from './strategies/marketStructure.js';
import { PairsArbitrage } from './strategies/pairs.js';
import { LiquiditySweep } from './strategies/liquiditySweep.js';
import { TrendMomentum } from './strategies/momentum.js';
import { MarketMaker } from './strategies/marketMaker.js';
import { VwapReversion } from './strategies/vwapReversion.js';
import { VolatilitySqueeze } from './strategies/squeeze.js';
import { TrendPullback } from './strategies/trendPullback.js';
import { TradingViewSignals } from './strategies/signals.js';
import { QuantResearch } from './strategies/research.js';
import { DayTrader } from './strategies/dayTrader.js';
import { PLAYBOOK, zonesText } from './daytrade.js';

// Every seat the floor has had: ten discretionary/systematic desks, the five-person Quant
// Research Lab (research: markets they may research and trade, budget = ideas tested per
// market per research round), the five scalpers who used to sit at the back (retired: no
// scalping any more) and the five-person Day Trading Desk, who trade top-down the way TJR does
// (rules.zones: the killzones each one works). New desks are only ever appended and retired
// ones keep their seat: a desk's place in this list is its MT5 magic number on the prop
// account. ROSTER (below) is the desks on the floor now.
// `appearance` drives the 3D avatar (build comes from gender), `voice` the spoken briefing:
// `neural` is the Kokoro voice, `lang`/`prefer` pick a system voice when neural voices are
// off. `accent` is the desk colour.
export const SEATS = [
  {
    id: 'marcus', name: 'Marcus Reid', title: 'Head of Index Futures', desk: 'Index Futures',
    Strategy: OpeningRangeBreakout, symbols: ['NAS100'], gender: 'male',
    weekendSymbol: 'BTCUSD', // crypto day trading at the weekend (Fri 18:00 – Sun 18:00 New York)
    // More setups, as many as good: tested on 22 months of real prices (README "More setups").
    rules: { minWidth: 1.0, maxWidth: 12, volume: 0 },
    appearance: { skin: '#b98356', hair: '#1b1410', hairStyle: 'short', eyes: '#3b2415', outfit: 'vest', jacket: '#1d2b4a', shirt: '#e9eef6', tie: '#7a1f2b', trousers: '#1d2b4a', glasses: false, headset: true, stubble: 0.3 },
    accent: '#3987e5',
    voice: { neural: 'am_michael', lang: 'en-US', prefer: ['Evan', 'Nathan', 'Tom', 'Aaron', 'Alex'] },
  },
  {
    id: 'sofia', name: 'Sofia Laurent', title: 'Global Macro PM', desk: 'Global Macro',
    Strategy: MarketStructure, symbols: ['USDJPY'], gender: 'female', maxTradesPerDay: 6,
    weekendSymbol: 'ETHUSD', // crypto day trading at the weekend (Fri 18:00 – Sun 18:00 New York)
    appearance: { skin: '#f0c9a8', hair: '#5a311b', hairStyle: 'long', eyes: '#5b7f5a', outfit: 'blazer', jacket: '#d9cdb9', shirt: '#1e2230', neckline: true, glasses: false, headset: false },
    accent: '#9085e9',
    voice: { neural: 'bf_emma', lang: 'en-GB', prefer: ['Serena', 'Kate', 'Stephanie', 'Martha', 'Google UK English Female'] },
  },
  {
    id: 'kenji', name: 'Kenji Tanaka', title: 'Quant PM · Stat-Arb', desk: 'Quant Stat-Arb',
    Strategy: PairsArbitrage, symbols: ['ETHUSD', 'BTCUSD'], gender: 'male', customPositionPitch: true, maxTradesPerDay: 10, learning: false,
    appearance: { skin: '#e6c29d', hair: '#0e0e10', hairStyle: 'side', eyes: '#2a1c12', outfit: 'knit', jacket: '#3a3f47', shirt: '#e9ecef', glasses: '#1a1a1a', headset: false },
    accent: '#199e70',
    voice: { neural: 'am_puck', lang: 'en-US', prefer: ['Nathan', 'Tom', 'Alex', 'Aaron', 'Evan'] },
  },
  {
    id: 'amara', name: 'Amara Okafor', title: 'Metals Trader', desk: 'Metals',
    Strategy: LiquiditySweep, symbols: ['XAUUSD'], gender: 'female',
    weekendSymbol: 'ETHUSD', // crypto day trading at the weekend (Fri 18:00 – Sun 18:00 New York)
    appearance: { skin: '#6a4128', hair: '#120c0a', hairStyle: 'bun', eyes: '#2b1a10', outfit: 'blazer', jacket: '#b9822c', shirt: '#f3efe7', neckline: true, lips: '#5e2f2b', glasses: false, headset: true },
    accent: '#c98500',
    voice: { neural: 'af_heart', lang: 'en-US', prefer: ['Zoe', 'Ava', 'Allison', 'Susan', 'Samantha'] },
  },
  {
    id: 'viktor', name: 'Viktor Petrov', title: 'Digital Assets PM', desk: 'Digital Assets',
    Strategy: TrendMomentum, symbols: ['BTCUSD'], gender: 'male',
    appearance: { skin: '#efcfb5', hair: '#b58a52', hairStyle: 'buzz', eyes: '#4f7da8', outfit: 'knit', jacket: '#1a1d23', glasses: false, headset: true, stubble: 0.45 },
    accent: '#d95926',
    voice: { neural: 'am_fenrir', lang: 'en-US', prefer: ['Tom', 'Evan', 'Alex', 'Nathan', 'Aaron'] },
  },
  {
    id: 'isabella', name: 'Isabella Cruz', title: 'Electronic Market Maker', desk: 'Electronic MM',
    Strategy: MarketMaker, symbols: ['SOLUSD'], gender: 'female',
    maxTradesPerDay: 1e9, noCooldown: true, quietTrades: true, learning: false,
    appearance: { skin: '#d9a47a', hair: '#2a160c', hairStyle: 'ponytail', eyes: '#3a2515', outfit: 'blazer', jacket: '#7d1d38', shirt: '#eceae6', glasses: false, headset: true },
    accent: '#d55181',
    voice: { neural: 'af_bella', lang: 'en-US', prefer: ['Ava', 'Allison', 'Samantha', 'Susan', 'Zoe'] },
  },
  {
    id: 'james', name: 'James Whitfield', title: 'Head of Execution', desk: 'Execution & VWAP',
    Strategy: VwapReversion, symbols: ['SPX500'], gender: 'male',
    weekendSymbol: 'BTCUSD', // crypto day trading at the weekend (Fri 18:00 – Sun 18:00 New York)
    rules: { band: 1.5, rsi: 12, maxAdx: 32 },
    appearance: { skin: '#f1d0b9', hair: '#9a9a9a', hairStyle: 'receding', eyes: '#6b7a86', outfit: 'suit', jacket: '#262a31', shirt: '#cfe0f5', tie: '#1f3b63', glasses: '#3a2a1c', headset: false, stubble: 0.12 },
    accent: '#5aa0f2',
    voice: { neural: 'bm_george', lang: 'en-GB', prefer: ['Daniel', 'Oliver', 'Jamie', 'Arthur', 'Google UK English Male'] },
  },
  {
    id: 'priya', name: 'Priya Sharma', title: 'G10 FX Volatility', desk: 'FX G10',
    Strategy: VolatilitySqueeze, symbols: ['EURUSD'], gender: 'female',
    weekendSymbol: 'BTCUSD', // crypto day trading at the weekend (Fri 18:00 – Sun 18:00 New York)
    rules: { minBars: 4 },
    appearance: { skin: '#a9714b', hair: '#0f0a08', hairStyle: 'long', eyes: '#2a1a10', outfit: 'blazer', jacket: '#2f2a4a', shirt: '#ece4f3', glasses: '#2b2b33', headset: false },
    accent: '#7c6ff0',
    voice: { neural: 'bf_isabella', lang: 'en-IN', prefer: ['Isha', 'Veena', 'Sangeeta', 'Kate', 'Serena'] },
  },
  {
    id: 'lucas', name: 'Lucas Meyer', title: 'Energy Trader', desk: 'Energy',
    Strategy: TrendPullback, symbols: ['USOIL'], gender: 'male',
    weekendSymbol: 'ETHUSD', // crypto day trading at the weekend (Fri 18:00 – Sun 18:00 New York)
    appearance: { skin: '#e3b58f', hair: '#4a2e1a', hairStyle: 'textured', eyes: '#5c4630', outfit: 'shirt', jacket: '#8fb0d6', shirt: '#9db9dc', trousers: '#2a2d33', glasses: false, headset: true, stubble: 0.35 },
    accent: '#008300',
    voice: { neural: 'bm_fable', lang: 'en-AU', prefer: ['Lee', 'Gordon', 'Daniel', 'Oliver'] },
  },
  {
    id: 'chen', name: 'Chen Wei', title: 'Systematic Signals PM', desk: 'TradingView Signals',
    Strategy: TradingViewSignals, symbols: ['ETHUSD'], gender: 'female', tvDesk: true,
    appearance: { skin: '#efcca6', hair: '#101012', hairStyle: 'bob', eyes: '#2a1a10', outfit: 'turtleneck', jacket: '#15181d', glasses: '#1a1a1a', headset: true },
    accent: '#2962ff',
    voice: { neural: 'af_sarah', lang: 'en-US', prefer: ['Susan', 'Nicky', 'Allison', 'Samantha', 'Ava'] },
  },
  // ---- Quant Research Lab -------------------------------------------------------------------
  {
    id: 'elena', name: 'Elena Vasquez', title: 'Head of Quant Research', desk: 'Quant Research',
    Strategy: QuantResearch, symbols: ['XAUUSD'], gender: 'female', learning: false, lab: true,
    research: { markets: ['NAS100', 'SPX500', 'XAUUSD', 'USOIL', 'EURUSD', 'USDJPY', 'BTCUSD', 'ETHUSD', 'SOLUSD'], budget: 220, diversify: true },
    appearance: { skin: '#e2b391', hair: '#2b1b14', hairStyle: 'long', eyes: '#4a3020', outfit: 'blazer', jacket: '#1f3b3a', shirt: '#f1ede6', neckline: true, glasses: '#6b4a2a', headset: false },
    accent: '#14b8a6',
    voice: { neural: 'af_kore', lang: 'en-US', prefer: ['Samantha', 'Allison', 'Ava', 'Susan', 'Zoe'] },
  },
  {
    id: 'arjun', name: 'Arjun Mehta', title: 'Index Research', desk: 'Index Research',
    Strategy: QuantResearch, symbols: ['NAS100'], gender: 'male', learning: false, lab: true,
    research: { markets: ['NAS100', 'SPX500'], budget: 360 },
    appearance: { skin: '#9c6644', hair: '#0d0b0a', hairStyle: 'side', eyes: '#24160e', outfit: 'shirt', jacket: '#34496b', shirt: '#34496b', trousers: '#1e2126', glasses: '#1e1e22', headset: true, stubble: 0.4 },
    accent: '#22b8e6',
    voice: { neural: 'bm_lewis', lang: 'en-GB', prefer: ['Rishi', 'Daniel', 'Oliver', 'Arthur', 'Google UK English Male'] },
  },
  {
    id: 'hannah', name: 'Hannah Berg', title: 'FX Research', desk: 'FX Research',
    Strategy: QuantResearch, symbols: ['EURUSD'], gender: 'female', learning: false, lab: true,
    research: { markets: ['EURUSD', 'USDJPY'], budget: 360 },
    appearance: { skin: '#f3d6c3', hair: '#c9a06a', hairStyle: 'ponytail', eyes: '#4d6f8c', outfit: 'turtleneck', jacket: '#e6e0d6', glasses: false, headset: true },
    accent: '#d66be8',
    voice: { neural: 'bf_lily', lang: 'en-GB', prefer: ['Kate', 'Serena', 'Martha', 'Stephanie', 'Google UK English Female'] },
  },
  {
    id: 'omar', name: 'Omar Haddad', title: 'Commodities Research', desk: 'Commodities Research',
    Strategy: QuantResearch, symbols: ['XAUUSD'], gender: 'male', learning: false, lab: true,
    research: { markets: ['XAUUSD', 'USOIL'], budget: 360 },
    appearance: { skin: '#c28c63', hair: '#15100d', hairStyle: 'short', eyes: '#2e1d12', outfit: 'suit', jacket: '#3a3e45', shirt: '#f4f5f7', tie: '#5c4a1e', trousers: '#3a3e45', glasses: false, headset: false, stubble: 0.7 },
    accent: '#e3b21b',
    voice: { neural: 'am_onyx', lang: 'en-US', prefer: ['Aaron', 'Evan', 'Tom', 'Nathan', 'Alex'] },
  },
  {
    id: 'mei', name: 'Mei Lin', title: 'Digital Assets Research', desk: 'Crypto Research',
    Strategy: QuantResearch, symbols: ['BTCUSD'], gender: 'female', learning: false, lab: true,
    research: { markets: ['BTCUSD', 'ETHUSD', 'SOLUSD'], budget: 360 },
    appearance: { skin: '#f0d2b2', hair: '#0c0b0d', hairStyle: 'long', eyes: '#22160f', outfit: 'knit', jacket: '#5d6b80', glasses: '#c0c4cc', headset: true },
    accent: '#7ccf2a',
    voice: { neural: 'af_nova', lang: 'en-US', prefer: ['Ava', 'Zoe', 'Allison', 'Samantha', 'Susan'] },
  },
  // ---- Scalping Desk: retired (no scalping any more). Their seats keep their magic numbers. ----
  {
    id: 'jake', name: 'Jake Morrison', title: 'Liquidity Scalper · Cable', desk: 'Scalping · GBPUSD London',
    retired: true, symbols: ['GBPUSD'], gender: 'male',
    appearance: { skin: '#e9bf9b', hair: '#6b4a2e', hairStyle: 'textured', eyes: '#4a6b8a', outfit: 'knit', jacket: '#20242b', glasses: false, headset: true, stubble: 0.5 },
    accent: '#ef5350',
    voice: { neural: 'am_liam', lang: 'en-AU', prefer: ['Lee', 'Gordon', 'Daniel', 'Oliver'] },
  },
  {
    id: 'layla', name: 'Layla Nasser', title: 'Liquidity Scalper · Euro', desk: 'Scalping · EURUSD London',
    retired: true, symbols: ['EURUSD'], gender: 'female',
    appearance: { skin: '#d6a57c', hair: '#1a1210', hairStyle: 'long', eyes: '#3a2616', outfit: 'blazer', jacket: '#efe9df', shirt: '#1d2230', neckline: true, glasses: false, headset: true },
    accent: '#4fc3f7',
    voice: { neural: 'bf_alice', lang: 'en-GB', prefer: ['Kate', 'Serena', 'Martha', 'Stephanie', 'Google UK English Female'] },
  },
  {
    id: 'ryan', name: 'Ryan Cole', title: 'Liquidity Scalper · Gold', desk: 'Scalping · Gold London',
    retired: true, symbols: ['XAUUSD'], gender: 'male',
    appearance: { skin: '#f0cfb2', hair: '#2b1d14', hairStyle: 'side', eyes: '#5a4632', outfit: 'shirt', jacket: '#26344a', shirt: '#26344a', trousers: '#1b1e24', glasses: false, headset: true, stubble: 0.25 },
    accent: '#ffca28',
    voice: { neural: 'bm_daniel', lang: 'en-GB', prefer: ['Daniel', 'Oliver', 'Arthur', 'Jamie', 'Google UK English Male'] },
  },
  {
    id: 'mia', name: 'Mia Torres', title: 'Liquidity Scalper · Gold', desk: 'Scalping · Gold New York',
    retired: true, symbols: ['XAUUSD'], gender: 'female',
    appearance: { skin: '#c68d62', hair: '#2a1a12', hairStyle: 'ponytail', eyes: '#3b2415', outfit: 'turtleneck', jacket: '#3b1f2b', glasses: false, headset: true },
    accent: '#ff8f3a',
    voice: { neural: 'af_river', lang: 'en-US', prefer: ['Samantha', 'Allison', 'Ava', 'Zoe', 'Susan'] },
  },
  {
    id: 'nico', name: 'Nico Rossi', title: 'Liquidity Scalper · Nasdaq', desk: 'Scalping · Nasdaq New York',
    retired: true, symbols: ['NAS100'], gender: 'male',
    appearance: { skin: '#dcae88', hair: '#141013', hairStyle: 'short', eyes: '#2e2014', outfit: 'suit', jacket: '#2c2f36', shirt: '#f4f5f7', tie: '#8a1c2b', trousers: '#2c2f36', glasses: '#1a1a1a', headset: false, stubble: 0.6 },
    accent: '#ab47bc',
    voice: { neural: 'am_eric', lang: 'en-US', prefer: ['Alex', 'Tom', 'Evan', 'Aaron', 'Nathan'] },
  },
  // ---- Day Trading Desk (TJR style: top-down bias, session liquidity, 3R+ day trades) ---------
  {
    id: 'tyler', name: 'Tyler Brooks', title: 'Day Trader · Nasdaq', desk: 'Day Trading · Nasdaq',
    Strategy: DayTrader, symbols: ['NAS100'], gender: 'male', dayTrader: true, rules: { zones: 'ny' }, maxTradesPerDay: 2,
    appearance: { skin: '#e8bd98', hair: '#3a2617', hairStyle: 'textured', eyes: '#3d5a78', outfit: 'knit', jacket: '#1f2a37', glasses: false, headset: true, stubble: 0.4 },
    accent: '#ff7043',
    voice: { neural: 'am_adam', lang: 'en-US', prefer: ['Alex', 'Tom', 'Evan', 'Aaron', 'Nathan'] },
  },
  {
    id: 'sienna', name: 'Sienna Clarke', title: 'Day Trader · S&P 500', desk: 'Day Trading · S&P 500',
    Strategy: DayTrader, symbols: ['SPX500'], gender: 'female', dayTrader: true, rules: { zones: 'ny' }, maxTradesPerDay: 2,
    appearance: { skin: '#f2d3bd', hair: '#8a5a2b', hairStyle: 'ponytail', eyes: '#4f6f5a', outfit: 'blazer', jacket: '#24323f', shirt: '#eef1f4', neckline: true, glasses: false, headset: true },
    accent: '#26c6da',
    voice: { neural: 'af_jessica', lang: 'en-US', prefer: ['Allison', 'Ava', 'Samantha', 'Susan', 'Zoe'] },
  },
  {
    id: 'theo', name: 'Theo Hart', title: 'Day Trader · Gold', desk: 'Day Trading · Gold',
    Strategy: DayTrader, symbols: ['XAUUSD'], gender: 'male', dayTrader: true, rules: { zones: 'london,ny' }, maxTradesPerDay: 2,
    appearance: { skin: '#f3d2b8', hair: '#7a5634', hairStyle: 'side', eyes: '#4a6b52', outfit: 'blazer', jacket: '#3b3127', shirt: '#f2efe8', glasses: '#2a2a2a', headset: true, stubble: 0.15 },
    accent: '#ffca28',
    voice: { neural: 'bm_daniel', lang: 'en-GB', prefer: ['Daniel', 'Oliver', 'Arthur', 'Jamie', 'Google UK English Male'] },
  },
  {
    id: 'zara', name: 'Zara Ahmed', title: 'Day Trader · Euro', desk: 'Day Trading · EURUSD',
    Strategy: DayTrader, symbols: ['EURUSD'], gender: 'female', dayTrader: true, rules: { zones: 'london,ny' }, maxTradesPerDay: 2,
    appearance: { skin: '#c99872', hair: '#16100d', hairStyle: 'long', eyes: '#3a2616', outfit: 'turtleneck', jacket: '#2d2342', glasses: false, headset: true },
    accent: '#5c6bc0',
    voice: { neural: 'bf_alice', lang: 'en-GB', prefer: ['Kate', 'Serena', 'Martha', 'Stephanie', 'Google UK English Female'] },
  },
  {
    id: 'diego', name: 'Diego Alvarez', title: 'Day Trader · Oil', desk: 'Day Trading · Oil',
    Strategy: DayTrader, symbols: ['USOIL'], gender: 'male', dayTrader: true, rules: { zones: 'london,ny' }, maxTradesPerDay: 2,
    appearance: { skin: '#c68d62', hair: '#120d0b', hairStyle: 'short', eyes: '#2e1d12', outfit: 'suit', jacket: '#2a2f36', shirt: '#f4f5f7', tie: '#2e5d3a', trousers: '#2a2f36', glasses: false, headset: false, stubble: 0.6 },
    accent: '#66bb6a',
    voice: { neural: 'am_echo', lang: 'en-US', prefer: ['Aaron', 'Evan', 'Tom', 'Nathan', 'Alex'] },
  },
];

// The desks on the floor now (retired seats left out).
export const ROSTER = SEATS.filter((p) => !p.retired);

export function publicProfile(p) {
  const { Strategy, ...rest } = p;
  // A day trader's killzones, New York time ("London open 02:00–05:00, New York open 07:00–11:00").
  const sessions = p.dayTrader ? zonesText(p.rules?.zones || PLAYBOOK.zones) : undefined;
  return { ...rest, sessions, strategy: Strategy.strategyName, strategyBlurb: Strategy.strategyBlurb };
}
