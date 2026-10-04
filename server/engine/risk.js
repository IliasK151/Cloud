import { usdPerQuote, roundToLot, SYMBOLS } from '../market/symbols.js';
import { eventLabel } from '../market/calendar.js';
import { fmtNyTime } from '../market/session.js';

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
    this.news = null; // economic calendar (set by the fund)
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

  canOpen(agent, symbol = agent.symbol) {
    // Their own way (live/liveTrader.js): no desk or fund loss limits from outside, and the news
    // rules only where FTMO has them (a funded account). The desk's own trade cap and cool-down
    // after a loss are its own way of trading, so they stay.
    const own = !!agent.env?.ownWay?.();
    if (agent.paused) return { ok: false, reason: 'Desk paused by the boss' };
    if (agent.halted && !own) return { ok: false, reason: agent.halted };
    if (this.riskOff && !own) return { ok: false, reason: `Fund risk-off: ${this.riskOff.reason}` };
    if (this.session.isFlattenWindow()) return { ok: false, reason: 'Flat into the close' };
    const news = agent.env?.newsRules?.() === false ? null : this.news?.blackout(symbol);
    if (news) {
      const when = news.phase === 'before' ? `at ${fmtNyTime(news.event.time)}` : 'just released';
      return { ok: false, news: true, reason: `News blackout: ${eventLabel(news.event)} ${when} (${news.impact} impact), no new ${symbol} trades until ${fmtNyTime(news.until)}` };
    }
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
