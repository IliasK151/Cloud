// The tradable universe. Each instrument maps to:
//  - a live data source (Binance for crypto, Yahoo Finance futures/FX for the rest)
//  - a TradingView symbol for the embedded TradingView chart
//  - aliases so TradingView alert tickers ({{ticker}}) resolve to it
// seedPrice/annualVol only drive the simulator (demo mode or when a live source is unreachable).

export const SYMBOLS = {
  NAS100: {
    id: 'NAS100', name: 'Nasdaq 100', assetClass: 'Index',
    tv: 'OANDA:NAS100USD', source: { type: 'yahoo', ticker: 'NQ=F' },
    decimals: 2, tick: 0.25, lot: 1, spreadBps: 0.6,
    seedPrice: 24500, annualVol: 0.22, baseVolume: 9000,
    aliases: ['NAS100', 'NAS100USD', 'US100', 'USTEC', 'NQ', 'NQ1!', 'NDX', 'NQ=F', 'MNQ1!'],
  },
  SPX500: {
    id: 'SPX500', name: 'S&P 500', assetClass: 'Index',
    tv: 'OANDA:SPX500USD', source: { type: 'yahoo', ticker: 'ES=F' },
    decimals: 2, tick: 0.25, lot: 1, spreadBps: 0.5,
    seedPrice: 6700, annualVol: 0.17, baseVolume: 14000,
    aliases: ['SPX500', 'SPX500USD', 'US500', 'SPX', 'ES', 'ES1!', 'ES=F', 'SPY', 'MES1!'],
  },
  XAUUSD: {
    id: 'XAUUSD', name: 'Gold', assetClass: 'Metals',
    tv: 'OANDA:XAUUSD', source: { type: 'yahoo', ticker: 'GC=F' },
    decimals: 2, tick: 0.01, lot: 1, spreadBps: 1.0,
    seedPrice: 3800, annualVol: 0.18, baseVolume: 5000,
    aliases: ['XAUUSD', 'GOLD', 'GC', 'GC1!', 'GC=F', 'XAU', 'MGC1!'],
  },
  USOIL: {
    id: 'USOIL', name: 'WTI Crude', assetClass: 'Energy',
    tv: 'TVC:USOIL', source: { type: 'yahoo', ticker: 'CL=F' },
    decimals: 2, tick: 0.01, lot: 10, spreadBps: 1.5,
    seedPrice: 64, annualVol: 0.34, baseVolume: 7000,
    aliases: ['USOIL', 'WTI', 'CL', 'CL1!', 'CL=F', 'USOUSD', 'WTICOUSD', 'XTIUSD'],
  },
  EURUSD: {
    id: 'EURUSD', name: 'Euro / US Dollar', assetClass: 'FX',
    tv: 'FX:EURUSD', source: { type: 'yahoo', ticker: 'EURUSD=X' },
    decimals: 5, tick: 0.00001, lot: 1000, spreadBps: 0.4,
    seedPrice: 1.17, annualVol: 0.07, baseVolume: 20000,
    aliases: ['EURUSD', 'EURUSD=X', '6E1!', 'EUR/USD'],
  },
  USDJPY: {
    id: 'USDJPY', name: 'US Dollar / Yen', assetClass: 'FX',
    tv: 'FX:USDJPY', source: { type: 'yahoo', ticker: 'JPY=X' },
    decimals: 3, tick: 0.001, lot: 1000, spreadBps: 0.5,
    seedPrice: 148, annualVol: 0.09, baseVolume: 18000,
    // P&L on USDJPY accrues in yen; convert to USD at the current rate.
    usdPerQuote: (price) => 1 / price,
    aliases: ['USDJPY', 'JPY=X', 'USD/JPY', '6J1!'],
  },
  BTCUSD: {
    id: 'BTCUSD', name: 'Bitcoin', assetClass: 'Crypto',
    tv: 'BINANCE:BTCUSDT', source: { type: 'binance', ticker: 'BTCUSDT' },
    decimals: 1, tick: 0.1, lot: 0.001, spreadBps: 0.8,
    seedPrice: 112000, annualVol: 0.45, baseVolume: 60,
    aliases: ['BTCUSD', 'BTCUSDT', 'BTC', 'XBTUSD', 'BTCUSD.P', 'BTCUSDT.P', 'BTC1!'],
  },
  ETHUSD: {
    id: 'ETHUSD', name: 'Ethereum', assetClass: 'Crypto',
    tv: 'BINANCE:ETHUSDT', source: { type: 'binance', ticker: 'ETHUSDT' },
    decimals: 2, tick: 0.01, lot: 0.01, spreadBps: 1.0,
    seedPrice: 4100, annualVol: 0.6, baseVolume: 900,
    aliases: ['ETHUSD', 'ETHUSDT', 'ETH', 'ETHUSD.P', 'ETHUSDT.P', 'ETH1!'],
  },
  SOLUSD: {
    id: 'SOLUSD', name: 'Solana', assetClass: 'Crypto',
    tv: 'BINANCE:SOLUSDT', source: { type: 'binance', ticker: 'SOLUSDT' },
    decimals: 3, tick: 0.001, lot: 0.1, spreadBps: 1.4,
    seedPrice: 210, annualVol: 0.75, baseVolume: 9000,
    aliases: ['SOLUSD', 'SOLUSDT', 'SOL', 'SOLUSD.P', 'SOLUSDT.P'],
  },
};

export const SYMBOL_IDS = Object.keys(SYMBOLS);

export function usdPerQuote(symbolId, price) {
  const s = SYMBOLS[symbolId];
  return s && s.usdPerQuote ? s.usdPerQuote(price) : 1;
}

export function roundToTick(symbolId, price) {
  const { tick, decimals } = SYMBOLS[symbolId];
  return Number((Math.round(price / tick) * tick).toFixed(decimals));
}

export function roundToLot(symbolId, qty) {
  const { lot } = SYMBOLS[symbolId];
  const lots = Math.floor(Math.abs(qty) / lot);
  const decimals = Math.max(0, -Math.floor(Math.log10(lot)));
  return Number((Math.sign(qty) * lots * lot).toFixed(decimals));
}

// Resolve a TradingView ticker such as "OANDA:XAUUSD", "BINANCE:BTCUSDT" or "NQ1!".
export function resolveSymbol(raw) {
  if (!raw) return null;
  const cleaned = String(raw).trim().toUpperCase();
  const bare = cleaned.includes(':') ? cleaned.split(':').pop() : cleaned;
  for (const s of Object.values(SYMBOLS)) {
    if (s.id === bare || s.aliases.includes(bare) || s.aliases.includes(cleaned) || s.tv === cleaned) return s.id;
  }
  return null;
}

export function publicSymbolInfo() {
  return Object.values(SYMBOLS).map(({ id, name, assetClass, tv, decimals, tick, source }) => ({
    id, name, assetClass, tv, decimals, tick, source: source.type,
  }));
}
