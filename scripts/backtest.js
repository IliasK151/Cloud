// Fast-forward the simulator through several sessions without the UI and print each
// desk's results. Useful for tuning strategies: `npm run backtest -- 5` (sessions).
import { MarketClock, Session } from '../server/market/session.js';
import { MarketData } from '../server/market/marketData.js';
import { SimFeed } from '../server/market/simFeed.js';
import { SYMBOLS } from '../server/market/symbols.js';
import { Broker } from '../server/engine/broker.js';
import { RiskManager } from '../server/engine/risk.js';
import { Fund } from '../server/engine/fund.js';
import { config } from '../server/config.js';
import { fmtUsd } from '../server/util/format.js';

export function runBacktest({ sessions = 3, seed = 42, quiet = false } = {}) {
  const clock = new MarketClock('sim', 1);
  const session = new Session(clock);
  const md = new MarketData(clock);
  const broker = new Broker(md, clock);
  const risk = new RiskManager(config.risk, session);
  const fund = new Fund({ config: { ...config, feed: 'sim' }, md, clock, session, broker, risk });
  const sim = new SimFeed(md, clock, Object.keys(SYMBOLS), { seed });
  sim.warmup(420);
  fund.trading = true;

  let done = 0;
  let sinceHousekeeping = 0;
  const stepMs = 5000;
  while (done < sessions) {
    const from = clock.now();
    clock.t += stepMs;
    sim.step(from, clock.now());
    sinceHousekeeping += stepMs;
    if (sinceHousekeeping >= 20_000) {
      fund.housekeeping();
      sinceHousekeeping = 0;
    }
    if (clock.sessionOver()) {
      fund.flattenAll('Session close');
      fund.housekeeping();
      const { from: f, to } = clock.jumpToNextOpen();
      sim.gap(f, to);
      done++;
      if (!quiet) console.log(`Session ${done}: fund P&L ${fmtUsd(fund.nav() - config.startingCapital, { sign: true })}`);
      fund.housekeeping();
    }
  }
  return fund;
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const sessions = Number(process.argv[2]) || 3;
  const fund = runBacktest({ sessions, seed: Number(process.argv[3]) || 42 });
  console.log('');
  console.log('Desk'.padEnd(22), 'Trades'.padStart(7), 'Win%'.padStart(6), 'PF'.padStart(6), 'AvgR'.padStart(6), 'P&L'.padStart(14));
  for (const a of fund.agents) {
    const s = a.statsView();
    console.log(
      a.profile.desk.padEnd(22),
      String(s.trades).padStart(7),
      (s.winRate == null ? '—' : (s.winRate * 100).toFixed(0)).padStart(6),
      (s.profitFactor == null ? '—' : Number.isFinite(s.profitFactor) ? s.profitFactor.toFixed(2) : '∞').padStart(6),
      (s.avgR == null ? '—' : s.avgR.toFixed(2)).padStart(6),
      fmtUsd(a.totalPnl(), { sign: true }).padStart(14),
    );
  }
  console.log('');
  console.log('Fund NAV', fmtUsd(fund.nav()), 'P&L', fmtUsd(fund.nav() - config.startingCapital, { sign: true }));
  process.exit(0);
}
