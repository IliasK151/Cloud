import { usdPerQuote, roundToLot, SYMBOLS } from '../market/symbols.js';

// The CRO. Sizes every trade off a fixed fraction of the desk's allocation,
// enforces per-desk and fund-wide daily loss limits, trade caps and cooldowns.
export class RiskManager {
  constructor({ riskPerTradePct, deskDailyLossPct, fundDailyLossPct, maxLeverage }, session) {
    this.riskPerTradePct = riskPerTradePct;
    this.deskDailyLossPct = deskDailyLossPct;
    this.fundDailyLossPct = fundDailyLossPct;
    this.maxLeverage = maxLeverage;
    this.session = session;
    this.riskOff = null; // { reason, time } when the fund-level stop trips
  }

  deskLossLimit(agent) {
    return agent.allocation * this.deskDailyLossPct;
  }

  // Units to trade so that a stop-out loses `riskPerTradePct` of the desk allocation,
  // capped by the desk's leverage limit.
  size(agent, symbol, entry, stop, { riskMultiplier = 1 } = {}) {
    const dist = Math.abs(entry - stop);
    if (!(dist > 0) || !Number.isFinite(entry)) return 0;
    const fx = usdPerQuote(symbol, entry);
    const riskUsd = agent.allocation * this.riskPerTradePct * (agent.profile.riskScale ?? 1) * riskMultiplier;
    let qty = riskUsd / (dist * fx);
    const maxNotional = agent.allocation * this.maxLeverage;
    qty = Math.min(qty, maxNotional / (entry * fx));
    const lots = roundToLot(symbol, qty);
    return lots >= SYMBOLS[symbol].lot ? lots : 0;
  }

  canOpen(agent) {
    if (agent.paused) return { ok: false, reason: 'Desk paused by the boss' };
    if (agent.halted) return { ok: false, reason: agent.halted };
    if (this.riskOff) return { ok: false, reason: `Fund risk-off: ${this.riskOff.reason}` };
    if (this.session.isFlattenWindow()) return { ok: false, reason: 'Flat into the close' };
    const cap = agent.learner ? agent.learner.maxTrades(agent.profile.maxTradesPerDay ?? 12) : agent.profile.maxTradesPerDay ?? 12;
    if (agent.day.trades >= cap) return { ok: false, reason: 'Daily trade cap reached' };
    if (agent.cooldownBars > 0) return { ok: false, reason: `Cooling off after a loss (${agent.cooldownBars} bars)` };
    return { ok: true };
  }

  // Called continuously by the fund. Returns true if the desk was just halted.
  checkDesk(agent, dayPnl) {
    if (agent.halted) return false;
    if (dayPnl <= -this.deskDailyLossPct * agent.allocation) {
      agent.halt(`Daily loss limit hit (${(this.deskDailyLossPct * 100).toFixed(1)}% of allocation)`);
      return true;
    }
    return false;
  }

  checkFund(fundDayPnl, nav) {
    if (this.riskOff) return false;
    if (fundDayPnl <= -this.fundDailyLossPct * nav) {
      this.riskOff = { reason: `Fund down ${(this.fundDailyLossPct * 100).toFixed(1)}% on the day`, time: Date.now() };
      return true;
    }
    return false;
  }

  resetDay() {
    this.riskOff = null;
  }
}
