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

// The ten desks on the floor. `appearance` drives the 3D avatar (build comes from gender),
// `voice` the spoken briefing: `neural` is the Kokoro voice, `lang`/`prefer` pick a system
// voice when neural voices are off. `accent` is the desk colour.
export const ROSTER = [
  {
    id: 'marcus', name: 'Marcus Reid', title: 'Head of Index Futures', desk: 'Index Futures',
    Strategy: OpeningRangeBreakout, symbols: ['NAS100'], gender: 'male',
    appearance: { skin: '#b98356', hair: '#1b1410', hairStyle: 'short', eyes: '#3b2415', outfit: 'vest', jacket: '#1d2b4a', shirt: '#e9eef6', tie: '#7a1f2b', trousers: '#1d2b4a', glasses: false, headset: true, stubble: 0.3 },
    accent: '#3987e5',
    voice: { neural: 'am_michael', lang: 'en-US', prefer: ['Evan', 'Nathan', 'Tom', 'Aaron', 'Alex'] },
  },
  {
    id: 'sofia', name: 'Sofia Laurent', title: 'Global Macro PM', desk: 'Global Macro',
    Strategy: MarketStructure, symbols: ['USDJPY'], gender: 'female', maxTradesPerDay: 6,
    appearance: { skin: '#f0c9a8', hair: '#5a311b', hairStyle: 'long', eyes: '#5b7f5a', outfit: 'blazer', jacket: '#d9cdb9', shirt: '#1e2230', neckline: true, glasses: false, headset: false },
    accent: '#9085e9',
    voice: { neural: 'bf_emma', lang: 'en-GB', prefer: ['Serena', 'Kate', 'Stephanie', 'Martha', 'Google UK English Female'] },
  },
  {
    id: 'kenji', name: 'Kenji Tanaka', title: 'Quant PM · Stat-Arb', desk: 'Quant Stat-Arb',
    Strategy: PairsArbitrage, symbols: ['ETHUSD', 'BTCUSD'], gender: 'male', customPositionPitch: true, maxTradesPerDay: 10,
    appearance: { skin: '#e6c29d', hair: '#0e0e10', hairStyle: 'side', eyes: '#2a1c12', outfit: 'knit', jacket: '#3a3f47', shirt: '#e9ecef', glasses: '#1a1a1a', headset: false },
    accent: '#199e70',
    voice: { neural: 'am_puck', lang: 'en-US', prefer: ['Nathan', 'Tom', 'Alex', 'Aaron', 'Evan'] },
  },
  {
    id: 'amara', name: 'Amara Okafor', title: 'Metals Trader', desk: 'Metals',
    Strategy: LiquiditySweep, symbols: ['XAUUSD'], gender: 'female',
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
    maxTradesPerDay: 1e9, noCooldown: true, quietTrades: true,
    appearance: { skin: '#d9a47a', hair: '#2a160c', hairStyle: 'ponytail', eyes: '#3a2515', outfit: 'blazer', jacket: '#7d1d38', shirt: '#eceae6', glasses: false, headset: true },
    accent: '#d55181',
    voice: { neural: 'af_bella', lang: 'en-US', prefer: ['Ava', 'Allison', 'Samantha', 'Susan', 'Zoe'] },
  },
  {
    id: 'james', name: 'James Whitfield', title: 'Head of Execution', desk: 'Execution & VWAP',
    Strategy: VwapReversion, symbols: ['SPX500'], gender: 'male',
    appearance: { skin: '#f1d0b9', hair: '#9a9a9a', hairStyle: 'receding', eyes: '#6b7a86', outfit: 'suit', jacket: '#262a31', shirt: '#cfe0f5', tie: '#1f3b63', glasses: '#3a2a1c', headset: false, stubble: 0.12 },
    accent: '#5aa0f2',
    voice: { neural: 'bm_george', lang: 'en-GB', prefer: ['Daniel', 'Oliver', 'Jamie', 'Arthur', 'Google UK English Male'] },
  },
  {
    id: 'priya', name: 'Priya Sharma', title: 'G10 FX Volatility', desk: 'FX G10',
    Strategy: VolatilitySqueeze, symbols: ['EURUSD'], gender: 'female',
    appearance: { skin: '#a9714b', hair: '#0f0a08', hairStyle: 'long', eyes: '#2a1a10', outfit: 'blazer', jacket: '#2f2a4a', shirt: '#ece4f3', glasses: '#2b2b33', headset: false },
    accent: '#7c6ff0',
    voice: { neural: 'bf_isabella', lang: 'en-IN', prefer: ['Isha', 'Veena', 'Sangeeta', 'Kate', 'Serena'] },
  },
  {
    id: 'lucas', name: 'Lucas Meyer', title: 'Energy Trader', desk: 'Energy',
    Strategy: TrendPullback, symbols: ['USOIL'], gender: 'male',
    appearance: { skin: '#e3b58f', hair: '#4a2e1a', hairStyle: 'textured', eyes: '#5c4630', outfit: 'shirt', jacket: '#8fb0d6', shirt: '#9db9dc', trousers: '#2a2d33', glasses: false, headset: true, stubble: 0.35 },
    accent: '#008300',
    voice: { neural: 'bm_fable', lang: 'en-AU', prefer: ['Lee', 'Gordon', 'Daniel', 'Oliver'] },
  },
  {
    id: 'chen', name: 'Chen Wei', title: 'Systematic Signals PM', desk: 'TradingView Signals',
    Strategy: TradingViewSignals, symbols: ['ETHUSD'], gender: 'female',
    appearance: { skin: '#efcca6', hair: '#101012', hairStyle: 'bob', eyes: '#2a1a10', outfit: 'turtleneck', jacket: '#15181d', glasses: '#1a1a1a', headset: true },
    accent: '#2962ff',
    voice: { neural: 'af_sarah', lang: 'en-US', prefer: ['Susan', 'Nicky', 'Allison', 'Samantha', 'Ava'] },
  },
];

export function publicProfile(p) {
  const { Strategy, ...rest } = p;
  return { ...rest, strategy: Strategy.strategyName, strategyBlurb: Strategy.strategyBlurb };
}
