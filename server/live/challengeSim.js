import { mulberry32 } from '../util/random.js';

// How likely is a challenge to pass, at a given risk per trade? Thousands of challenges are
// played out with trades drawn from the desks' real results (each in R, after costs), under
// FTMO's rules and the floor's own loss guard:
//
//   2-Step: +10% target, daily loss 5% of the starting balance (below the day's start),
//           max loss 10% fixed at the start, at least 4 trading days.
//   1-Step: +10% target, daily loss 3%, max loss 10% trailing the best end-of-day balance
//           (never above the start), and the Best Day rule: no day over 50% of the profit
//           from winning days before it passes.
//
// The floor's guard stops for the day at guardPct of the daily limit and stops trading at
// guardPct of the max loss; a stop at the max-loss guard counts as a failed challenge (the
// account can't pass from there without you stepping in). A loss that jumps past a limit in
// one trade is a breach. Trades risk riskPct of the current balance, as the floor sizes them.

export const PROGRAMS = {
  '2-step': { target: 0.10, daily: 0.05, max: 0.10, trailing: false, minDays: 4, bestDay: null },
  '1-step': { target: 0.10, daily: 0.03, max: 0.10, trailing: true, minDays: 0, bestDay: 0.5 },
};

// Poisson-distributed trade count for a day.
function poisson(rng, mean) {
  if (mean <= 0) return 0;
  const L = Math.exp(-mean);
  let k = 0;
  let p = 1;
  do {
    k++;
    p *= rng();
  } while (p > L && k < 200);
  return k - 1;
}

export function simulateChallenge({ samples, tradesPerDay, riskPct, program = '1-step', size = 10_000, runs = 4000, maxDays = 60, guardPct = 80, seed = 1 }) {
  const rules = PROGRAMS[program];
  if (!rules) throw new Error(`unknown program ${program}`);
  const rs = (samples || []).filter(Number.isFinite);
  if (!rs.length || !(tradesPerDay > 0) || !(riskPct > 0)) return { passed: 0, failed: 0, open: 1, runs: 0, medianDays: null };
  const rng = mulberry32(seed);
  const g = guardPct / 100;
  const risk = riskPct / 100;
  let passed = 0;
  let failed = 0;
  const passDays = [];
  for (let run = 0; run < runs; run++) {
    let balance = size;
    let peak = size; // best end-of-day balance (1-Step)
    let tradingDays = 0;
    const dayProfits = [];
    let outcome = null;
    for (let day = 1; day <= maxDays && !outcome; day++) {
      const start = balance;
      const dailyFloor = start - rules.daily * size;
      const maxFloor = (rules.trailing ? Math.min(size, peak) : size) - rules.max * size;
      const n = poisson(rng, tradesPerDay);
      if (n) tradingDays++;
      for (let i = 0; i < n; i++) {
        balance += rs[Math.floor(rng() * rs.length)] * risk * balance;
        if (balance <= dailyFloor || balance <= maxFloor) { outcome = 'fail'; break; } // breached
        // The floor's guard: done for the day, or done (a challenge that can't pass).
        if (balance - maxFloor <= (1 - g) * rules.max * size) { outcome = 'fail'; break; }
        if (start - balance >= g * rules.daily * size) break;
      }
      if (outcome) break;
      dayProfits.push(balance - start);
      peak = Math.max(peak, balance);
      if (balance >= size * (1 + rules.target) && tradingDays >= rules.minDays) {
        if (rules.bestDay) {
          const wins = dayProfits.filter((p) => p > 0);
          const total = wins.reduce((s, p) => s + p, 0);
          if (total > 0 && Math.max(...wins) > rules.bestDay * total) continue; // keep trading
        }
        outcome = 'pass';
        passDays.push(day);
      }
    }
    if (outcome === 'pass') passed++;
    else if (outcome === 'fail') failed++;
  }
  passDays.sort((a, b) => a - b);
  return {
    runs,
    passed: passed / runs,
    failed: failed / runs,
    open: (runs - passed - failed) / runs, // still going after maxDays
    medianDays: passDays.length ? passDays[Math.floor(passDays.length / 2)] : null,
  };
}

// The pass probability at each risk size, and the best one.
export function riskSweep({ samples, tradesPerDay, program = '1-step', size = 10_000, risks = [0.25, 0.5, 0.75, 1, 1.5], runs = 4000, maxDays = 60, seed = 1 }) {
  const rows = risks.map((riskPct) => ({ riskPct, ...simulateChallenge({ samples, tradesPerDay, riskPct, program, size, runs, maxDays, seed }) }));
  const best = rows.reduce((b, r) => (!b || r.passed > b.passed ? r : b), null);
  return { rows, best };
}
