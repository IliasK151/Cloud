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

// The ten desks on the floor. `appearance` drives the 3D avatar, `voice` the spoken
// briefing (first matching system voice wins), `accent` the desk signage colour.
export const ROSTER = [
  {
    id: 'marcus', name: 'Marcus Reid', title: 'Head of Index Futures', desk: 'Index Futures',
    Strategy: OpeningRangeBreakout, symbols: ['NAS100'], gender: 'male',
    appearance: { skin: '#c68b59', hair: '#1b1410', hairStyle: 'short', shirt: '#cdd6e4', vest: '#1d2b4a', glasses: false, headset: true },
    accent: '#3987e5',
    voice: { prefer: ['Daniel', 'Google UK English Male', 'Arthur', 'Oliver'], pitch: 0.95, rate: 1.03 },
  },
  {
    id: 'sofia', name: 'Sofia Laurent', title: 'Global Macro PM', desk: 'Global Macro',
    Strategy: MarketStructure, symbols: ['USDJPY'], gender: 'female', maxTradesPerDay: 6,
    appearance: { skin: '#f1c7a5', hair: '#6b3a1e', hairStyle: 'long', shirt: '#2c3e63', vest: null, glasses: false, headset: false },
    accent: '#9085e9',
    voice: { prefer: ['Amelie', 'Serena', 'Kate', 'Google UK English Female', 'Samantha'], pitch: 1.05, rate: 1.0 },
  },
  {
    id: 'kenji', name: 'Kenji Tanaka', title: 'Quant PM · Stat-Arb', desk: 'Quant Stat-Arb',
    Strategy: PairsArbitrage, symbols: ['ETHUSD', 'BTCUSD'], gender: 'male', customPositionPitch: true, maxTradesPerDay: 10,
    appearance: { skin: '#e8c39e', hair: '#0d0d0f', hairStyle: 'side', shirt: '#d6d6d2', vest: '#3a3f47', glasses: true, headset: false },
    accent: '#199e70',
    voice: { prefer: ['Alex', 'Tom', 'Aaron', 'Google US English'], pitch: 1.0, rate: 1.05 },
  },
  {
    id: 'amara', name: 'Amara Okafor', title: 'Metals Trader', desk: 'Metals',
    Strategy: LiquiditySweep, symbols: ['XAUUSD'], gender: 'female',
    appearance: { skin: '#6b4226', hair: '#120c0a', hairStyle: 'bun', shirt: '#d9a441', vest: null, glasses: false, headset: true },
    accent: '#c98500',
    voice: { prefer: ['Tessa', 'Karen', 'Moira', 'Google UK English Female', 'Samantha'], pitch: 1.0, rate: 1.02 },
  },
  {
    id: 'viktor', name: 'Viktor Petrov', title: 'Digital Assets PM', desk: 'Digital Assets',
    Strategy: TrendMomentum, symbols: ['BTCUSD'], gender: 'male',
    appearance: { skin: '#f0cfb4', hair: '#b58a52', hairStyle: 'buzz', shirt: '#1a1d23', vest: null, glasses: false, headset: true },
    accent: '#d95926',
    voice: { prefer: ['Fred', 'Ralph', 'Aaron', 'Google US English'], pitch: 0.85, rate: 1.0 },
  },
  {
    id: 'isabella', name: 'Isabella Cruz', title: 'Electronic Market Maker', desk: 'Electronic MM',
    Strategy: MarketMaker, symbols: ['SOLUSD'], gender: 'female',
    maxTradesPerDay: 1e9, noCooldown: true, quietTrades: true,
    appearance: { skin: '#d9a47a', hair: '#2a160c', hairStyle: 'ponytail', shirt: '#d9d9dc', vest: '#8a1f3d', glasses: false, headset: true },
    accent: '#d55181',
    voice: { prefer: ['Paulina', 'Monica', 'Samantha', 'Victoria', 'Google US English'], pitch: 1.1, rate: 1.06 },
  },
  {
    id: 'james', name: 'James Whitfield', title: 'Head of Execution', desk: 'Execution & VWAP',
    Strategy: VwapReversion, symbols: ['SPX500'], gender: 'male',
    appearance: { skin: '#f3d2bb', hair: '#8c8c8c', hairStyle: 'short', shirt: '#b8c9e0', vest: '#23262d', glasses: true, headset: false },
    accent: '#5aa0f2',
    voice: { prefer: ['Arthur', 'Daniel', 'Oliver', 'Google UK English Male'], pitch: 0.9, rate: 0.98 },
  },
  {
    id: 'priya', name: 'Priya Sharma', title: 'G10 FX Volatility', desk: 'FX G10',
    Strategy: VolatilitySqueeze, symbols: ['EURUSD'], gender: 'female',
    appearance: { skin: '#b07a52', hair: '#0f0a08', hairStyle: 'long', shirt: '#5b2a86', vest: null, glasses: true, headset: false },
    accent: '#7c6ff0',
    voice: { prefer: ['Veena', 'Isha', 'Lekha', 'Samantha', 'Google UK English Female'], pitch: 1.05, rate: 1.04 },
  },
  {
    id: 'lucas', name: 'Lucas Meyer', title: 'Energy Trader', desk: 'Energy',
    Strategy: TrendPullback, symbols: ['USOIL'], gender: 'male',
    appearance: { skin: '#e3b58f', hair: '#3b2414', hairStyle: 'messy', shirt: '#6f8fb3', vest: null, glasses: false, headset: true },
    accent: '#008300',
    voice: { prefer: ['Lee', 'Rishi', 'Tom', 'Alex', 'Google US English'], pitch: 1.0, rate: 1.02 },
  },
  {
    id: 'chen', name: 'Chen Wei', title: 'Systematic Signals PM', desk: 'TradingView Signals',
    Strategy: TradingViewSignals, symbols: ['ETHUSD'], gender: 'female',
    appearance: { skin: '#f0cda8', hair: '#101012', hairStyle: 'bob', shirt: '#101820', vest: null, glasses: true, headset: true },
    accent: '#2962ff',
    voice: { prefer: ['Tingting', 'Meijia', 'Samantha', 'Karen', 'Google US English'], pitch: 1.05, rate: 1.03 },
  },
];

export function publicProfile(p) {
  const { Strategy, ...rest } = p;
  return { ...rest, strategy: Strategy.strategyName, strategyBlurb: Strategy.strategyBlurb };
}
