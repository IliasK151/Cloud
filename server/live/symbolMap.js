// Map the floor's instruments to the broker's MT5 symbol names (FTMO uses e.g. US100.cash).

const CANDIDATES = {
  NAS100: ['US100.cash', 'US100', 'NAS100', 'USTEC', 'NDX100', 'NAS100.cash', 'NQ100'],
  SPX500: ['US500.cash', 'US500', 'SPX500', 'SP500', 'US500.c'],
  XAUUSD: ['XAUUSD', 'GOLD', 'XAUUSD.cash'],
  USOIL: ['USOIL.cash', 'USOIL', 'WTI', 'XTIUSD', 'CL-OIL', 'WTI.cash'],
  EURUSD: ['EURUSD'],
  GBPUSD: ['GBPUSD'],
  USDJPY: ['USDJPY'],
  BTCUSD: ['BTCUSD', 'BTCUSDT', 'BITCOIN'],
  ETHUSD: ['ETHUSD', 'ETHUSDT', 'ETHEREUM'],
  SOLUSD: ['SOLUSD', 'SOLUSDT'],
};

// Strip broker suffixes such as ".cash", ".pro", ".z", "-ECN", "_i" or a trailing "+" / "#".
const bare = (s) => s.toUpperCase().replace(/[+#!]+$/, '').replace(/[._-][A-Z0-9]{1,5}$/, '').replace(/[^A-Z0-9]/g, '');

export function autoMap(brokerSymbols = []) {
  const byUpper = new Map(brokerSymbols.map((s) => [s.toUpperCase(), s]));
  const byBare = new Map();
  for (const s of brokerSymbols) if (!byBare.has(bare(s))) byBare.set(bare(s), s);
  const map = {};
  for (const [floorId, names] of Object.entries(CANDIDATES)) {
    let hit = null;
    for (const n of names) {
      hit = byUpper.get(n.toUpperCase());
      if (hit) break;
    }
    if (!hit) for (const n of names) {
      hit = byBare.get(bare(n));
      if (hit) break;
    }
    map[floorId] = hit || null;
  }
  return map;
}

export function candidatesFor(floorId, brokerSymbols = []) {
  const names = (CANDIDATES[floorId] || []).map(bare);
  return brokerSymbols.filter((s) => names.includes(bare(s)));
}
