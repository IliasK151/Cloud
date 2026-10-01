// FTMO rule presets and the guard maths. Numbers are the classic FTMO 2-Step values;
// always check them against your own account in the FTMO Client Area and edit them
// in the FTMO tab if your program differs.

export const ACCOUNT_TYPES = {
  trial: { label: 'Free Trial', targetPct: 10, dailyLossPct: 5, maxLossPct: 10 },
  challenge: { label: 'FTMO Challenge', targetPct: 10, dailyLossPct: 5, maxLossPct: 10 },
  verification: { label: 'Verification', targetPct: 5, dailyLossPct: 5, maxLossPct: 10 },
  funded: { label: 'FTMO Account', targetPct: null, dailyLossPct: 5, maxLossPct: 10 },
};

export const DEFAULTS = {
  guardPct: 80, // act at 80% of each FTMO limit, leaving a safety buffer
  riskPerTradePct: 0.25, // % of balance risked per live trade (stop-loss distance)
  maxOpenRiskPct: 1.5, // max total risk across open live positions
  maxPositions: 5,
  stopAtTarget: true,
  // The account brain's plan (live/accountBrain.js).
  minGrade: 'A', // only committee A-grade trades reach the account ('B' allows A and B)
  dailyStopPct: 1.5, // stop for the day at this loss, far before FTMO's daily limit
  dailyStopOn: true, // the boss can switch the daily stop off (FTMO's own daily guard still applies)
  tradeCapOn: true, // stop taking new trades after maxTradesPerDay
  streakStopOn: true, // stop for the day after streakStop losses in a row
  provenOnly: true, // only desks with a proven edge on real prices (off: unproven desks at half risk)
  maxTradesPerDay: 6,
  streakStop: 3, // losses in a row that end the day
  stayArmed: false, // re-arm on its own after a restart if it was armed (the boss opts in)
  // Training on FTMO (Free Trial only, on unless switched off): every trade a desk takes goes
  // to the account, so the desks learn on FTMO itself. No grade, proven-desk, correlation or
  // daily-plan holds; real prices, a stop-loss on every order and FTMO's loss guard stay.
  // Its default depends on the account type, so it isn't set here (see trainingOn).
};

// Training is for the Free Trial (demo money). A paid challenge or a funded account always
// runs the full account plan.
export const trainingOn = (p) => !!p && p.type === 'trial' && p.training !== false;

// The account plan's on/off switches (see the Brain and FTMO tabs).
export const PLAN_SWITCHES = ['training', 'dailyStopOn', 'tradeCapOn', 'streakStopOn', 'provenOnly'];
const flag = (v, fallback) => (v == null ? fallback : v !== false && v !== 'false');

const clampNum = (v, lo, hi, fallback) => {
  const n = Number(v);
  return Number.isFinite(n) ? Math.min(hi, Math.max(lo, n)) : fallback;
};

export function normalizeProfile(input = {}, account = {}) {
  const type = ACCOUNT_TYPES[input.type] ? input.type : 'trial';
  const preset = ACCOUNT_TYPES[type];
  const size = clampNum(input.size, 1000, 10_000_000, account.initialDeposit || account.balance || 100_000);
  const target = input.targetPct === null || input.targetPct === '' ? null : input.targetPct;
  return {
    type,
    size,
    targetPct: target == null && type === 'funded' ? null : clampNum(target ?? preset.targetPct, 0.5, 100, preset.targetPct),
    dailyLossPct: clampNum(input.dailyLossPct ?? preset.dailyLossPct, 0.5, 50, preset.dailyLossPct),
    maxLossPct: clampNum(input.maxLossPct ?? preset.maxLossPct, 1, 100, preset.maxLossPct),
    guardPct: clampNum(input.guardPct ?? DEFAULTS.guardPct, 30, 100, DEFAULTS.guardPct),
    riskPerTradePct: clampNum(input.riskPerTradePct ?? DEFAULTS.riskPerTradePct, 0.01, 2, DEFAULTS.riskPerTradePct),
    maxOpenRiskPct: clampNum(input.maxOpenRiskPct ?? DEFAULTS.maxOpenRiskPct, 0.05, 10, DEFAULTS.maxOpenRiskPct),
    maxPositions: Math.round(clampNum(input.maxPositions ?? DEFAULTS.maxPositions, 1, 20, DEFAULTS.maxPositions)),
    stopAtTarget: input.stopAtTarget ?? DEFAULTS.stopAtTarget,
    minGrade: ['A', 'B'].includes(input.minGrade) ? input.minGrade : DEFAULTS.minGrade,
    dailyStopPct: clampNum(input.dailyStopPct ?? DEFAULTS.dailyStopPct, 0.25, 10, DEFAULTS.dailyStopPct),
    dailyStopOn: flag(input.dailyStopOn, DEFAULTS.dailyStopOn),
    tradeCapOn: flag(input.tradeCapOn, DEFAULTS.tradeCapOn),
    streakStopOn: flag(input.streakStopOn, DEFAULTS.streakStopOn),
    provenOnly: flag(input.provenOnly, DEFAULTS.provenOnly),
    maxTradesPerDay: Math.round(clampNum(input.maxTradesPerDay ?? DEFAULTS.maxTradesPerDay, 1, 50, DEFAULTS.maxTradesPerDay)),
    streakStop: Math.round(clampNum(input.streakStop ?? DEFAULTS.streakStop, 2, 10, DEFAULTS.streakStop)),
    stayArmed: flag(input.stayArmed, DEFAULTS.stayArmed),
    training: type === 'trial' ? flag(input.training, true) : false,
  };
}

// Where the account stands against its rules.
//   dayStartBalance: balance at the start of the broker's trading day
//   openRisk:        money lost if every open live position hit its stop
export function guardMetrics(profile, { balance, equity, closedToday = 0 }, openRisk = 0) {
  const dayStartBalance = balance - closedToday;
  const dailyLimit = (profile.dailyLossPct / 100) * profile.size;
  const maxLimit = (profile.maxLossPct / 100) * profile.size;
  const g = profile.guardPct / 100;
  const dailyLoss = Math.max(0, dayStartBalance - equity);
  const totalLoss = Math.max(0, profile.size - equity);
  const targetEquity = profile.targetPct ? profile.size * (1 + profile.targetPct / 100) : null;
  const profit = equity - profile.size;
  return {
    dayStartBalance,
    dailyLimit,
    maxLimit,
    dailyLoss,
    totalLoss,
    dailyUsed: dailyLimit ? dailyLoss / dailyLimit : 0,
    maxUsed: maxLimit ? totalLoss / maxLimit : 0,
    dailyGuard: g * dailyLimit,
    maxGuard: g * maxLimit,
    // Room left before the guard trips, after assuming every open stop is hit.
    dailyRoom: g * dailyLimit - dailyLoss - openRisk,
    maxRoom: g * maxLimit - totalLoss - openRisk,
    targetEquity,
    profit,
    targetProgress: targetEquity ? profit / (targetEquity - profile.size) : null,
    dailyBreach: dailyLoss >= g * dailyLimit,
    maxBreach: totalLoss >= g * maxLimit,
    targetHit: targetEquity != null && equity >= targetEquity,
  };
}

// Lots so that a stop-out costs `riskMoney` (account currency).
export function lotsForRisk(riskMoney, stopDistance, spec) {
  const tickSize = spec.tickSize || spec.point;
  const tickValue = spec.tickValueLoss || spec.tickValue;
  if (!(riskMoney > 0) || !(stopDistance > 0) || !(tickSize > 0) || !(tickValue > 0)) return 0;
  const lossPerLot = (stopDistance / tickSize) * tickValue;
  let lots = riskMoney / lossPerLot;
  const step = spec.volStep || 0.01;
  lots = Math.floor(lots / step + 1e-9) * step;
  if (spec.volMax) lots = Math.min(lots, spec.volMax);
  const decimals = Math.max(0, Math.ceil(-Math.log10(step) - 1e-9));
  lots = Number(lots.toFixed(decimals));
  return lots >= (spec.volMin || step) - 1e-9 ? lots : 0;
}

// Money at risk on a live position if its stop is hit (0 once the stop locks in profit).
export function positionRisk(pos, spec) {
  if (!spec || !pos.sl) return pos.sl ? 0 : Infinity;
  const tickSize = spec.tickSize || spec.point;
  const tickValue = spec.tickValueLoss || spec.tickValue;
  const dist = pos.side === 'BUY' ? pos.open - pos.sl : pos.sl - pos.open;
  if (dist <= 0) return 0;
  return (dist / tickSize) * tickValue * pos.volume;
}
