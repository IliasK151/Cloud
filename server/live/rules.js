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
};

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
