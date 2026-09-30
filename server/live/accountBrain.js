import { fmtUsd } from '../util/format.js';

// The account brain: the plan a professional prop trader follows to pass a challenge and
// then keep getting paid. The paper desks can experiment; the account only gets the best
// ideas, sized by where the account stands:
//
//   - only committee A-grade trades, from desks with a proven, positive measured edge
//     earned on real market prices (never on a simulated stand-in feed);
//   - risk shrinks while the account is in drawdown and after losses, never grows past the
//     base risk you set;
//   - a daily stop well before FTMO's daily limit (the boss can switch it off; FTMO's own
//     daily guard still applies), a cap on trades per day, and a stop for the day after a
//     losing streak;
//   - one position per correlated group (both US indices are one bet, so are the coins);
//   - the boss's own TradingView alerts are the boss's decision: they skip the proven-desk
//     and grade gates (the committee can still veto them) but every risk rule above applies;
//   - near the profit target the risk shrinks so one loss can't undo the progress, and on a
//     funded account risk is lighter to protect the payouts.

export const GROUPS = {
  NAS100: 'US indices', SPX500: 'US indices',
  BTCUSD: 'Crypto', ETHUSD: 'Crypto', SOLUSD: 'Crypto',
  EURUSD: 'FX', GBPUSD: 'FX', USDJPY: 'FX', XAUUSD: 'Gold', USOIL: 'Oil',
};

const GRADE_RANK = { A: 3, B: 2, C: 1 };
const clamp = (x, lo, hi) => Math.max(lo, Math.min(hi, x));

export class AccountBrain {
  constructor(live) {
    this.live = live;
  }

  #links() {
    const lt = this.live;
    return [...lt.links.values()].filter((l) => l.login === lt.login);
  }

  // Where the account stands and what the plan says, right now.
  state() {
    const lt = this.live;
    const p = lt.profile;
    const acc = lt.account;
    const m = lt.metrics();
    if (!p || !acc || !m) return null;
    const day = lt.bridge.serverDay;
    const links = this.#links();
    const closed = links.filter((l) => l.state === 'closed').sort((a, b) => (a.closedAt || 0) - (b.closedAt || 0));
    let streak = 0;
    for (let i = closed.length - 1; i >= 0 && closed[i].pnl < 0; i--) streak++;
    const lastClosed = closed[closed.length - 1];
    const lastToday = lastClosed && (lastClosed.closedDay ? lastClosed.closedDay === day : Date.now() - lastClosed.closedAt < 12 * 3_600_000);
    // Trades that really reached MT5 (a ticket), or an order still in flight right now.
    // Orders MT5 never confirmed don't count.
    const traded = links.filter((l) => (['open', 'closing', 'closed'].includes(l.state) && l.ticket) || (l.state === 'pending' && !l.previousSession && Date.now() - l.createdAt < 120_000));
    const tradesToday = traded.filter((l) => (l.openedDay ? l.openedDay === day : Date.now() - l.createdAt < 12 * 3_600_000)).length;
    const tradingDays = new Set(traded.map((l) => l.openedDay).filter(Boolean)).size;

    const size = p.size;
    const profit = acc.equity - size;
    const dayPnl = acc.equity - m.dayStartBalance;
    const base = p.riskPerTradePct;
    let mult = 1;
    const reasons = [];
    let blocked = null;

    const ddFrac = Math.max(0, -profit) / size;
    if (ddFrac > 0) {
      const k = clamp(1 - ddFrac / (0.5 * (p.maxLossPct / 100)), 0.4, 1);
      if (k < 0.995) {
        mult *= k;
        reasons.push(`The account is ${fmtUsd(profit)} from its start, so risk is ×${k.toFixed(2)} until that's won back`);
      }
    }
    const dayLoss = Math.max(0, -dayPnl) / size;
    const stop = p.dailyStopPct / 100;
    // The boss can switch the daily stop off; the half-risk step below still applies.
    if (p.dailyStopOn !== false && dayLoss >= stop) blocked = `Daily stop: ${fmtUsd(dayPnl)} today. The plan stops at −${p.dailyStopPct}%, long before FTMO's ${p.dailyLossPct}% limit. Back tomorrow`;
    else if (dayLoss >= stop / 2) {
      mult *= 0.5;
      reasons.push(`Down ${fmtUsd(dayPnl)} today: half risk for the rest of the day`);
    }
    if (p.streakStopOn !== false && streak >= p.streakStop && lastToday) blocked = blocked || `${streak} losses in a row today: done for the day, fresh start tomorrow (the losing-streak stop can be switched off below)`;
    else if (streak >= 2) {
      mult *= 0.5;
      reasons.push(`${streak} losses in a row: half risk until the next winner`);
    }
    if (p.tradeCapOn !== false && tradesToday >= p.maxTradesPerDay) blocked = blocked || `${tradesToday} trades today, the plan's daily cap of ${p.maxTradesPerDay} (the trade cap can be switched off below)`;

    let remaining = null;
    if (m.targetEquity) {
      remaining = m.targetEquity - acc.equity;
      const riskMoney = acc.balance * (base / 100) * mult;
      if (remaining > 0 && riskMoney > remaining / 2) {
        const k = Math.max(0.25, remaining / 2 / riskMoney);
        mult *= k;
        reasons.push(`Only ${fmtUsd(remaining)} left to the target: smaller risk so one loss can't undo the progress`);
      }
    }
    if (p.type === 'funded') {
      mult *= 0.8;
      reasons.push('Funded account: 20% lighter risk to protect the payouts');
    }
    const riskPct = base * mult;
    const riskMoney = acc.balance * (riskPct / 100);
    if (!reasons.length && profit > 0.02 * size) reasons.push('A profit cushion is built, so the normal risk applies (never more)');

    const phase = p.type === 'funded' ? 'Funded' : p.type === 'verification' ? 'Verification' : p.type === 'challenge' ? 'Challenge' : 'Free Trial';
    const goal = p.type === 'funded'
      ? 'Payouts: steady, small gains. Protect the account first'
      : `Pass: reach +${p.targetPct}% (${fmtUsd(m.targetEquity - size)}) without touching the ${p.dailyLossPct}% daily or ${p.maxLossPct}% max loss`;
    const winsToTarget = remaining != null && remaining > 0 && riskMoney > 0 ? Math.ceil(remaining / (riskMoney * 2)) : null;
    const status = lt.halt ? 'HALTED' : blocked ? 'STOPPED FOR TODAY' : mult < 0.99 ? 'CAUTIOUS' : 'NORMAL';
    const minGrade = p.minGrade;
    return {
      phase, goal, status, blocked, reasons,
      baseRiskPct: base, riskPct: Math.round(riskPct * 1000) / 1000, riskMoney, mult: Math.round(mult * 100) / 100,
      equity: acc.equity, size, profit, dayPnl, streak, tradesToday, tradingDays, minTradingDays: 4,
      remaining, winsToTarget,
      dailyStopPct: p.dailyStopPct, dailyStopOn: p.dailyStopOn !== false, dailyLossPct: p.dailyLossPct, guardPct: p.guardPct, maxTradesPerDay: p.maxTradesPerDay, streakStop: p.streakStop, minGrade,
      tradeCapOn: p.tradeCapOn !== false, streakStopOn: p.streakStopOn !== false, provenOnly: p.provenOnly !== false,
      rules: [
        p.provenOnly !== false
          ? { text: `Only committee ${minGrade === 'A' ? 'A-grade' : 'A and B-grade'} trades from desks with a proven edge on real prices`, ok: true }
          : { text: 'Proven desks only is OFF: unproven desks trade the account at half risk (committee-approved A and B-grade trades)', ok: false },
        { text: 'Never a trade on simulated prices (a market whose live feed is down)', ok: true },
        { text: `Risk ${riskPct.toFixed(2)}% per trade now (base ${base}%)`, ok: mult >= 0.99 },
        p.dailyStopOn !== false
          ? { text: `Daily stop at −${p.dailyStopPct}% (today ${fmtUsd(dayPnl, { sign: true })})`, ok: dayLoss < stop / 2 }
          : { text: `Daily stop is OFF: trading continues after a −${p.dailyStopPct}% day (today ${fmtUsd(dayPnl, { sign: true })}). FTMO's daily guard still closes everything at ${p.guardPct}% of the ${p.dailyLossPct}% limit`, ok: false },
        p.tradeCapOn !== false
          ? { text: `At most ${p.maxTradesPerDay} trades a day (${tradesToday} so far)`, ok: tradesToday < p.maxTradesPerDay }
          : { text: `Trade cap is OFF: no limit on trades a day (${tradesToday} so far)`, ok: false },
        p.streakStopOn !== false
          ? { text: `Stop for the day after ${p.streakStop} losses in a row (streak ${streak})`, ok: streak < 2 }
          : { text: `Losing-streak stop is OFF (streak ${streak}; risk still halves after 2 losses)`, ok: false },
        { text: 'One position per correlated group', ok: true },
        { text: 'Flat before high-impact news, no trades in a blackout', ok: true },
        { text: `FTMO guard closes everything at ${p.guardPct}% of a limit`, ok: !lt.halt },
      ],
    };
  }

  // Has this desk earned real money with its own trades? (Its measured edge on real prices,
  // or for a research desk a strategy validated on real data.)
  clearance(agent) {
    const committee = agent.env.committee;
    if (!committee) return { ok: true, text: 'cleared' };
    if (agent.profile.lab) {
      const act = agent.active;
      if (!act) return { ok: false, text: 'no validated strategy yet, so it researches on paper first' };
      const ed = committee.edge(agent, act.symbol, 'LONG');
      if (ed.e <= 0) return { ok: false, text: ed.text };
      return { ok: true, text: ed.text };
    }
    const ed = committee.edge(agent, agent.symbol, 'LONG');
    if (ed.n < 10) return { ok: false, n: ed.n, text: `it needs 10 or more paper trades on real market prices before it risks real money (${ed.n} so far)` };
    if (ed.e <= 0) return { ok: false, text: `its measured edge is negative (${ed.text}); it earns its way back on paper first` };
    return { ok: true, text: ed.text };
  }

  // May this desk's trade go to the account, and at what size?
  allow(agent, pos, plan) {
    const st = this.state();
    if (!st) return { ok: true, riskMult: 1 };
    if (st.blocked) return { ok: false, reason: st.blocked };
    // The boss's own TradingView alert: not held back by the desk's paper record or grade.
    const boss = plan.tag === 'TV';
    let probation = false;
    if (!boss) {
      const c = this.clearance(agent);
      if (!c.ok && st.provenOnly) {
        if (plan.grade != null && (GRADE_RANK[plan.grade] || 0) < (GRADE_RANK[st.minGrade] || 3)) {
          return { ok: false, reason: `committee grade ${plan.grade}: the account only takes ${st.minGrade === 'A' ? 'A-grade' : 'A and B-grade'} trades` };
        }
        return { ok: false, reason: c.n != null ? `the desk ${c.text.replace(/^it /, '')}` : `the desk isn't cleared yet: ${c.text}` };
      }
      // "Proven desks only" is off: an unproven desk trades the account at half risk. Its
      // measured edge counts zero, so A-grades are rare: any committee-approved trade (A or
      // B) goes; "not convinced" (C) stays on paper.
      probation = !c.ok;
      const need = probation ? Math.min(GRADE_RANK[st.minGrade] || 3, GRADE_RANK.B) : GRADE_RANK[st.minGrade] || 3;
      if (plan.grade != null && (GRADE_RANK[plan.grade] || 0) < need) {
        return { ok: false, reason: `committee grade ${plan.grade}: the account only takes ${need >= 3 ? 'A-grade' : 'A and B-grade'} trades` };
      }
    }
    const group = GROUPS[pos.symbol];
    const busy = this.#links().some((l) => !l.previousSession && ['pending', 'open', 'closing'].includes(l.state) && GROUPS[l.floorSymbol] === group);
    if (group && busy) return { ok: false, reason: `the account already has a ${group} position (one per correlated group)` };
    if (probation) return { ok: true, riskMult: st.mult * 0.5, reasons: [...st.reasons, 'Unproven desk: half risk'], probation, boss };
    return { ok: true, riskMult: st.mult, reasons: st.reasons, boss };
  }

  // Where a desk stands with the account right now, in one line the whole floor can show.
  deskStatus(agent, st = this.state()) {
    const lt = this.live;
    const p = lt.profile;
    if (!p?.desks?.[agent.id]) return { state: 'off', label: 'Off', text: 'Not switched on for the FTMO account: paper only' };
    if (!lt.eligible(agent.id)) return { state: 'paper', label: 'Paper only', text: lt.ineligibleReason(agent.id) };
    const open = this.#links().find((l) => l.agentId === agent.id && !l.previousSession && ['open', 'closing', 'pending'].includes(l.state));
    if (open) return { state: 'live', label: 'LIVE', text: `Live on MT5: ${open.side} ${open.volumeNow ?? open.volume0} ${open.brokerSymbol}` };
    if (lt.halt) return { state: 'halted', label: 'Halted', text: lt.halt.reason };
    const c = this.clearance(agent);
    const alerts = agent.profile.tvDesk ? ' Your TradingView alerts through this desk still go to the account.' : '';
    if (!c.ok && p.provenOnly === false) {
      if (!lt.armed) return { state: 'ready', label: 'Unproven · not armed', text: 'Will trade the account at half risk while unproven ("Proven desks only" is off). Arm live trading to start.' };
      if (st?.blocked) return { state: 'stopped', label: 'Stopped today', text: st.blocked };
      return { state: 'probation', label: 'Unproven · half risk', text: `Trades the account at half risk while it proves itself ("Proven desks only" is off): ${c.text}.` };
    }
    if (!c.ok) return { state: 'proving', label: 'Proving on paper', text: `Paper only for now: ${c.text}.${alerts}` };
    if (!lt.armed) return { state: 'ready', label: 'Cleared · not armed', text: 'Cleared for the account. Arm live trading in the FTMO tab to start.' };
    if (st?.blocked) return { state: 'stopped', label: 'Stopped today', text: st.blocked };
    return { state: 'cleared', label: 'Cleared', text: `Cleared: its ${st?.minGrade === 'B' ? 'A and B-grade' : 'A-grade'} trades go to MT5.` };
  }
}
