// Fast-forward the simulator (economic calendar and research lab included) through several
// sessions without the UI and print each desk's results: `npm run backtest -- 5` (sessions).
import { MarketClock, Session } from '../server/market/session.js';
import { MarketData } from '../server/market/marketData.js';
import { SimFeed } from '../server/market/simFeed.js';
import { SYMBOLS } from '../server/market/symbols.js';
import { Broker } from '../server/engine/broker.js';
import { RiskManager } from '../server/engine/risk.js';
import { Fund } from '../server/engine/fund.js';
import { NewsCalendar } from '../server/market/calendar.js';
import { HistoryStore } from '../server/research/history.js';
import { ResearchLab } from '../server/research/lab.js';
import { config } from '../server/config.js';
import { fmtUsd } from '../server/util/format.js';

const quietLog = { info() {}, warn() {} };

// Synchronous run without the research lab (research desks stay flat).
export function runBacktest({ sessions = 3, seed = 42, quiet = false } = {}) {
  const env = setup({ seed });
  loop(env, { sessions, quiet });
  return env.fund;
}

// The whole floor, research lab included: the lab researches in between market steps.
export async function runFloor({ sessions = 1, seed = 42, quiet = true } = {}) {
  const env = setup({ seed, research: true });
  await env.history.load();
  env.lab.start();
  await loop(env, { sessions, quiet, yieldEvery: 30 });
  return env.fund;
}

function setup({ seed, research = false }) {
  const clock = new MarketClock('sim', 1);
  const session = new Session(clock);
  const md = new MarketData(clock);
  const broker = new Broker(md, clock);
  const risk = new RiskManager(config.risk, session);
  const news = new NewsCalendar({ clock, mode: 'sim', dataDir: null, log: quietLog });
  const sim = new SimFeed(md, clock, Object.keys(SYMBOLS), { seed, calendar: news });
  sim.warmup(420);
  const history = research ? new HistoryStore({ md, mode: 'sim', calendar: news, log: quietLog }) : null;
  const lab = research ? new ResearchLab({ history, calendar: news, mode: 'sim', inline: true, log: quietLog }) : null;
  const fund = new Fund({ config: { ...config, feed: 'sim' }, md, clock, session, broker, risk, news, lab });
  fund.trading = true;
  return { clock, sim, fund, history, lab, news };
}

function loop({ clock, sim, fund }, { sessions, quiet, yieldEvery = 0 }) {
  let done = 0;
  let sinceHousekeeping = 0;
  let steps = 0;
  const stepMs = 5000;
  const tick = () => {
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
  };
  if (!yieldEvery) {
    while (done < sessions) tick();
    return undefined;
  }
  return (async () => {
    while (done < sessions) {
      tick();
      if (++steps % yieldEvery === 0) await new Promise((r) => setImmediate(r));
    }
  })();
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const sessions = Number(process.argv[2]) || 3;
  console.log('Generating history for the research lab and running the floor…');
  const fund = await runFloor({ sessions, seed: Number(process.argv[3]) || 42, quiet: false });
  console.log('');
  console.log('Desk'.padEnd(22), 'Trades'.padStart(7), 'Win%'.padStart(6), 'PF'.padStart(6), 'AvgR'.padStart(6), 'P&L'.padStart(14));
  for (const a of fund.agents) {
    const s = a.statsView();
    if (a.profile.lab) {
      const act = a.active;
      console.log(`  ${a.profile.name}: ${act ? `${act.name} on ${act.symbol} (unseen ${act.stats.unseen.avgR.toFixed(2)}R x ${act.stats.unseen.n})` : 'no validated strategy'}`);
    }
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
