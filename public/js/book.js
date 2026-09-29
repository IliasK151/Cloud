// Which P&L the floor displays: the connected FTMO account (real) or the paper fund.
// With an FTMO account set up and connected, FTMO is the default; the boss can flip to Paper.

let pref = null;
try {
  pref = localStorage.getItem('floor.book');
} catch {
  /* storage unavailable */
}

export function setBookPref(value) {
  pref = value;
  try { localStorage.setItem('floor.book', value); } catch { /* ignore */ }
}

export function hasFtmo(store) {
  return !!(store.live?.profile && store.live?.account);
}

export function bookMode(store) {
  if (!hasFtmo(store)) return 'paper';
  return pref === 'paper' ? 'paper' : 'ftmo';
}

export function fundBook(store) {
  if (bookMode(store) === 'ftmo') {
    const v = store.live;
    const acc = v.account;
    const dayStart = v.metrics?.dayStartBalance ?? acc.balance;
    return {
      mode: 'ftmo',
      navLabel: 'FTMO equity',
      nav: acc.equity,
      day: acc.equity - dayStart,
      totalLabel: 'Since start',
      total: acc.equity - v.profile.size,
      exposureLabel: 'Open risk',
      exposure: v.openRisk || 0,
      open: v.positions.filter((p) => p.floor).length,
      equity: v.equityHistory || [],
      start: v.profile.size,
      name: `FTMO ${v.account.login}`,
    };
  }
  const f = store.fund;
  return {
    mode: 'paper',
    navLabel: 'Paper NAV',
    nav: f.nav,
    day: f.dayPnl,
    totalLabel: 'Since inception',
    total: f.totalPnl,
    exposureLabel: 'Gross exposure',
    exposure: f.grossExposure,
    open: f.openPositions,
    equity: store.equity,
    start: f.startingCapital,
    name: f.name,
  };
}

// Per-desk numbers. In FTMO view, desks that aren't switched on for the account return na.
export function deskBook(store, id) {
  if (bookMode(store) === 'ftmo') {
    const d = store.live.desks.find((x) => x.id === id);
    if (!d?.enabled) return { mode: 'ftmo', na: true, day: 0, total: 0, unrealized: 0, trades: 0 };
    return { mode: 'ftmo', na: false, day: d.pnlToday || 0, total: d.pnlTotal || 0, unrealized: d.live?.profit || 0, trades: d.tradesToday || 0, live: d.live };
  }
  const a = store.agents[id];
  return { mode: 'paper', na: false, day: a?.pnl.day ?? 0, total: a?.pnl.total ?? 0, unrealized: a?.pnl.unrealized ?? 0, trades: a?.stats.tradesDay ?? 0 };
}
