import { fmtUsd } from '../util/format.js';
import { trainingOn, programRules, COST_LIMIT_R, COST_MAX_R } from './rules.js';
import { VERDICT_EFFECT } from './review.js';
import { spanText } from './baseline.js';

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
//     funded account risk is lighter to protect the payouts;
//   - risk limits that hold even while training (LIMITS below): a cool-off after a losing
//     streak, each desk's own daily loss limit, no flipping a market right after a loss, and
//     capital that follows each desk's record on the account after costs;
//   - the neural brain (neural/brain.js) can only hold trades back, never add one: an idea it
//     passed on that trades small on paper so it keeps learning (an exploration) never goes
//     to the account.

export const GROUPS = {
  NAS100: 'US indices', SPX500: 'US indices',
  BTCUSD: 'Crypto', ETHUSD: 'Crypto', SOLUSD: 'Crypto',
  EURUSD: 'FX', GBPUSD: 'FX', USDJPY: 'FX', XAUUSD: 'Gold', USOIL: 'Oil',
};

// Risk limits, the way a bank's trading floor runs them: each holds whether or not the desks
// are training on FTMO, and none of them stops the paper trading the desks learn from.
export const LIMITS = {
  cooloffMs: 2 * 3_600_000, // training: after the losing streak, the account pauses this long
  noFlipMs: 30 * 60_000, // after a losing trade on a market, nothing the other way on it
  deskLossR: 2, // a desk that loses this many full risks on the account in a day is off it
  allocMin: 8, // account trades before a desk's own record sizes it
  allocWindow: 12, // its most recent account trades
  formMin: 3, // real-price trades before a desk's form counts
  formWindow: 20, // its most recent real-price trades (paper and account alike)
  labPaperTrades: 10, // a research desk's new strategy: live paper trades before the account
  practiceRiskPct: 0.25, // Free Trial practice: desks the evidence holds back trade at this risk at most
  weekendCrypto: 3, // at the weekend every desk trades crypto, and crypto moves together: positions at once
};

const GRADE_RANK = { A: 3, B: 2, C: 1 };
const fmtR = (x) => (Number.isFinite(x) ? `${x >= 0 ? '+' : '−'}${Math.abs(x).toFixed(2)}R` : '—');
const clamp = (x, lo, hi) => Math.max(lo, Math.min(hi, x));

// FTMO only (liveTrader gate()): a trade the account holds back isn't taken on paper either.
const noPaper = (lt) => !!lt?.ftmoOnly && lt.mode === 'live';

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

    const training = trainingOn(p);
    const size = p.size;
    const profit = acc.equity - size;
    const dayPnl = acc.equity - m.dayStartBalance;
    const base = p.riskPerTradePct;
    let mult = 1;
    const reasons = [];
    let blocked = null;

    // Drawdown from where the max-loss line is measured: the start (2-Step), or the best
    // end-of-day balance while 1-Step's line still trails it.
    const rules = programRules(p);
    const ddFrac = m.totalLoss / size;
    if (ddFrac > 0) {
      // Down to 0.4× by halfway to the max loss, and a quarter once it's 60% of the way there:
      // replayed on 23 months of every desk's real trades, the deeper cut took a quarter off
      // the losses of a losing run and kept the account further from the line.
      const floor = ddFrac >= 0.6 * (p.maxLossPct / 100) ? 0.25 : 0.4;
      const k = clamp(1 - ddFrac / (0.5 * (p.maxLossPct / 100)), floor, 1);
      if (k < 0.995) {
        mult *= k;
        reasons.push(m.trailing && m.maxBase > size + 0.005
          ? `The account is ${fmtUsd(-m.totalLoss)} below its best end-of-day balance (${fmtUsd(m.maxBase)}), where FTMO's max loss is measured from, so risk is ×${k.toFixed(2)} until that's won back`
          : `The account is ${fmtUsd(profit)} from its start, so risk is ×${k.toFixed(2)} until that's won back`);
      }
    }
    const dayLoss = Math.max(0, -dayPnl) / size;
    const stop = p.dailyStopPct / 100;
    // The boss can switch the daily stop off; the half-risk step below still applies.
    // Training on FTMO pauses the plan's stops (holds), never its smaller sizes after losses.
    const holds = !training;
    if (holds && p.dailyStopOn !== false && dayLoss >= stop) blocked = `Daily stop: ${fmtUsd(dayPnl)} today. The plan stops at −${p.dailyStopPct}%, long before FTMO's ${p.dailyLossPct}% limit. Back tomorrow`;
    else if (dayLoss >= stop / 2) {
      mult *= 0.5;
      reasons.push(`Down ${fmtUsd(dayPnl)} today: half risk for the rest of the day`);
    }
    if (holds && p.streakStopOn !== false && streak >= p.streakStop && lastToday) blocked = blocked || `${streak} losses in a row today: done for the day, fresh start tomorrow (the losing-streak stop can be switched off below)`;
    else if (streak >= 2) {
      mult *= 0.5;
      reasons.push(`${streak} losses in a row: half risk until the next winner`);
    }
    if (holds && p.tradeCapOn !== false && tradesToday >= p.maxTradesPerDay) blocked = blocked || `${tradesToday} trades today, the plan's daily cap of ${p.maxTradesPerDay} (the trade cap can be switched off below)`;
    // Training keeps a brake on losing streaks: a cool-off on the account instead of the rest
    // of the day. The desks keep trading on paper meanwhile, so they keep learning.
    let cooloff = null;
    if (training && p.streakStopOn !== false && streak >= p.streakStop && lastToday && lastClosed.closedAt) {
      const until = lastClosed.closedAt + LIMITS.cooloffMs;
      const left = until - Date.now();
      if (left > 0) cooloff = { until, minutes: Math.ceil(left / 60_000), text: `${streak} losses in a row on the account: a ${LIMITS.cooloffMs / 3_600_000}-hour cool-off, ${Math.ceil(left / 60_000)} minutes to go (${noPaper(this.live) ? 'nothing trades meanwhile: FTMO only is on' : 'the desks keep trading on paper meanwhile'})` };
    }

    // FTMO's own rules stop the day even while training: 1-Step's Best Day rule. A day that
    // makes more than half the target could be "too good" at the finish line, so the desks call
    // it a day there. Past the target with the rule not met yet, they trade on at half risk.
    const best = rules.bestDayPct ? lt.consistency?.() ?? null : null;
    let ruleStop = null;
    if (best?.dayCap && dayPnl >= best.dayCap) {
      ruleStop = `Best Day rule: ${fmtUsd(dayPnl, { sign: true })} today, half the target's profit. Done for today so no single day is more than ${rules.bestDayPct}% of the profit (FTMO ${rules.program ? '1-Step' : '1-Step rules, until you set the program'})`;
    }
    const bestDayPending = !!(best && !best.ok && m.targetHit);
    if (bestDayPending) {
      mult *= 0.5;
      reasons.push(`Target reached, but the Best Day rule needs about ${fmtUsd(best.needed)} more on other days: half risk to keep the target`);
    }

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
    const maxText = `${p.maxLossPct}% max loss${m.trailing ? ' (trailing)' : ''}`;
    const goal = p.type === 'funded'
      ? 'Payouts: steady, small gains. Protect the account first'
      : `Pass: reach +${p.targetPct}% (${fmtUsd(m.targetEquity - size)}) without touching the ${p.dailyLossPct}% daily or ${maxText}${rules.bestDayPct ? `, no day over ${rules.bestDayPct}% of the profit` : ''}`;
    const winsToTarget = remaining != null && remaining > 0 && riskMoney > 0 ? Math.ceil(remaining / (riskMoney * 2)) : null;
    const status = lt.halt ? 'HALTED' : blocked || ruleStop ? 'STOPPED FOR TODAY' : cooloff ? 'COOLING OFF' : mult < 0.99 ? 'CAUTIOUS' : 'NORMAL';
    // The risk limits, in the plan's list.
    const full = acc.balance * (base / 100);
    const limitRules = [
      training && (p.streakStopOn !== false
        ? { text: `${p.streakStop} losses in a row: a ${LIMITS.cooloffMs / 3_600_000}-hour cool-off on the account${noPaper(this.live) ? ' (FTMO only: nothing trades during it)' : ', the desks keep learning on paper'}${cooloff ? ` (${cooloff.minutes} minutes to go)` : ` (streak ${streak})`}`, ok: !cooloff }
        : { text: `Cool-off after ${p.streakStop} losses in a row is OFF (the losing-streak switch)`, ok: false }),
      { text: `Desk loss limit: a desk that loses ${LIMITS.deskLossR}× its full risk (${fmtUsd(LIMITS.deskLossR * full)}) on the account in a day is off it until tomorrow`, ok: true },
      { text: `No flipping: after a losing trade on a market, nothing the other way on it for ${LIMITS.noFlipMs / 60_000} minutes`, ok: true },
      { text: `Costs: a stop too tight for the market's costs is widened (smaller size, same risk) until they're ${COST_LIMIT_R}R of it; a trade that would cost over ${COST_MAX_R}R doesn't go`, ok: true },
      (() => {
        const rv = lt.review?.report || null;
        const fresh = !!lt.review?.current?.();
        const hours = rv ? Math.max(1, Math.round((Date.now() - rv.at) / 3_600_000)) : null;
        const ago = hours == null ? '' : hours < 48 ? `${hours} h ago` : `${Math.round(hours / 24)} days ago`;
        if (!rv) return { text: 'Evidence first: the nightly review replays each desk on your own prices after the New York close. No review yet, so no desk is held back by it', ok: false };
        if (!fresh) return { text: `Evidence first: the last nightly review is ${ago}, so the reviews have stopped (the Mac asleep after the close, or failing: see the Nightly review card). Its verdicts still apply until a new one runs`, ok: false };
        return { text: `Evidence first: every night each desk is replayed on your own prices (last review ${ago}, ${rv.tradingDays} trading days). No edge: paper only. Unclear: half size`, ok: true };
      })(),
      (() => {
        const base = lt.baseline;
        const judged = (lt.fund?.agents || []).filter((a) => p.desks?.[a.id] && base?.forDesk?.(a.id));
        if (!judged.length) return null;
        const recs = judged.map((a) => base.forDesk(a.id));
        const span = spanText(Math.min(...recs.map((d) => d.from)), Math.max(...recs.map((d) => d.to)));
        const losers = judged.filter((a) => base.forDesk(a.id).verdict === 'loses').map((a) => a.profile.name.split(' ')[0]);
        return {
          text: `Long-run record: each desk was replayed on up to ${span} of real 1-minute prices. ${losers.length
            ? `${losers.length} of the ${judged.length} desks on the account lost money there with confidence (${losers.join(', ')}): ${training && p.practiceAll !== false ? `they practise on the Free Trial at ${Math.min(LIMITS.practiceRiskPct, p.riskPerTradePct)}% a trade; on a paid challenge, paper only` : 'paper only'}, unless the nightly review finds a real edge on your own prices`
            : `None of the ${judged.length} desks on the account lost money there with confidence`}`,
          ok: true,
        };
      })(),
      (() => {
        const nb = lt.fund?.env?.neural;
        const sk = nb?.ready ? nb.skill() : null;
        if (!sk) return null;
        return sk.trusted
          ? { text: `Neural brain has a say: on trades it hadn't seen it ranks winners above losers (skill ${sk.auc}). Ideas it expects to lose stay off the account${noPaper(this.live) ? ' and, with FTMO only on, aren\'t traded at all' : ', a few trade small on paper so it keeps learning'}. It never sends a trade these rules hold back`, ok: true }
          : { text: `Neural brain is learning: it judges every idea and learns from every trade, but decides nothing for the account until it tells winners from losers on trades it hasn't seen (skill ${sk.auc ?? '—'} now, it needs ${nb.trust.minAuc})`, ok: true };
      })(),
      lt.fund?.weekendOn && { text: `Weekend: the desks day-trade crypto (Bitcoin and Ether) until Sunday 18:00 New York, flat by 16:50 each day. At most ${LIMITS.weekendCrypto} crypto positions on the account at once, because crypto moves together, and each desk's weekend crypto record counts as its long-run record`, ok: true },
      { text: `Desks earn their place: a desk whose last ${LIMITS.formWindow} trades on real prices average below 0R trades paper only until its record recovers`, ok: true },
      { text: `Proven live first: a research desk's new strategy trades paper on real prices until ${LIMITS.labPaperTrades} live trades haven't lost money in total, then the account`, ok: true },
      { text: `Capital follows results: a desk losing money after costs over its last ${LIMITS.allocMin} or more account trades trades at half size`, ok: true },
    ].filter(Boolean);
    // FTMO's rules for this account, in the plan's list (any program).
    const ftmoRules = [
      !rules.program && { text: 'Which FTMO program is this account, 2-Step or 1-Step? Not set yet, so the guard follows the stricter 1-Step limits (3% daily, trailing max loss) until you choose in the FTMO tab', ok: false },
      m.trailing && { text: `Max loss line: equity must stay above ${fmtUsd(m.maxFloor)}, ${p.maxLossPct}% below the best end-of-day balance${m.maxBase >= size + m.maxLimit - 0.005 ? ' (it has stopped trailing: it never goes above the starting balance)' : ` (${fmtUsd(m.maxBase)}); the line moves up with new highs, never above ${fmtUsd(size)}`}`, ok: m.maxUsed < 0.5 },
      best && { text: best.share == null
        ? `Best Day rule: no single day may be more than ${best.pct}% of the profit from winning days (none yet). The desks stop for the day at ${fmtUsd(best.dayCap, { sign: true })}`
        : `Best Day rule: best day ${fmtUsd(best.best.pnl, { sign: true })} is ${Math.round(best.share * 100)}% of ${fmtUsd(best.total)} from ${best.winningDays} winning day${best.winningDays === 1 ? '' : 's'} (${best.pct}% or less to pass${best.ok ? '' : `, about ${fmtUsd(best.needed)} more on other days`}). Desks stop for the day at ${fmtUsd(best.dayCap, { sign: true })}`, ok: best.ok || !m.targetHit },
    ].filter(Boolean);
    const minGrade = p.minGrade;
    return {
      phase, goal, status, blocked: blocked || ruleStop || cooloff?.text || null, ruleStop, cooloff, reasons,
      program: rules.program, programLabel: rules.label, trailing: m.trailing, maxFloor: m.maxFloor, dailyFloor: m.dailyFloor, peakBalance: m.peakBalance,
      bestDay: best, bestDayPending,
      baseRiskPct: base, riskPct: Math.round(riskPct * 1000) / 1000, riskMoney, mult: Math.round(mult * 100) / 100,
      equity: acc.equity, size, profit, dayPnl, streak, tradesToday, tradingDays, minTradingDays: rules.minTradingDays,
      remaining, winsToTarget,
      dailyStopPct: p.dailyStopPct, dailyStopOn: p.dailyStopOn !== false, dailyLossPct: p.dailyLossPct, guardPct: p.guardPct, maxTradesPerDay: p.maxTradesPerDay, streakStop: p.streakStop, minGrade,
      tradeCapOn: p.tradeCapOn !== false, streakStopOn: p.streakStopOn !== false, provenOnly: p.provenOnly !== false,
      training, canTrain: p.type === 'trial',
      practiceAll: p.type === 'trial' && p.practiceAll !== false, practice: training && p.practiceAll !== false, practiceRiskPct: LIMITS.practiceRiskPct,
      rules: training ? [
        { text: 'Training on FTMO: every trade the desks take goes to the account, so they learn on FTMO itself. The committee grade, proven-desk, correlation and daily-plan holds are paused; the risk limits below stay', ok: false },
        p.practiceAll !== false
          ? { text: `Practice is ON: desks the evidence holds back (losing over the long run, no edge on your prices, out of form, a new research strategy) trade the Free Trial too, at ${Math.min(LIMITS.practiceRiskPct, p.riskPerTradePct)}% a trade, so you watch every desk trade. On average they lose a little; a paid challenge never does this`, ok: false }
          : { text: `Practice is OFF: desks the evidence holds back ${noPaper(this.live) ? 'don\'t trade (FTMO only is on)' : 'stay on paper'} while the others train on FTMO`, ok: true },
        { text: 'Real prices only: a market whose live feed is down is not traded, never simulated', ok: true },
        { text: `Risk ${riskPct.toFixed(2)}% per trade now (base ${base}%), smaller for the committee's B and C grades`, ok: mult >= 0.99 },
        { text: 'Every order carries its stop-loss', ok: true },
        { text: 'Flat before high-impact news, no trades in a blackout', ok: true },
        { text: `FTMO guard closes everything at ${p.guardPct}% of a limit, and no trade goes in that could breach it`, ok: !lt.halt },
        ...limitRules,
        ...ftmoRules,
      ] : [
        p.provenOnly !== false
          ? { text: `Only committee ${minGrade === 'A' ? 'A-grade' : 'A and B-grade'} trades from desks with a proven edge on real prices`, ok: true }
          : { text: 'Proven desks only is OFF: unproven desks trade the account at half risk (committee-approved A and B-grade trades)', ok: false },
        { text: 'Real prices only: a market whose live feed is down is not traded, never simulated', ok: true },
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
        ...limitRules,
        ...ftmoRules,
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
    // The boss's own TradingView alert: not held back by the desk's paper record or grade.
    const boss = plan.tag === 'TV';
    // An idea the neural brain passed on, taken small on paper so it learns whether it was
    // right: an experiment, never for the account (training or not).
    if (plan.neural?.explore) return { ok: false, reason: `the neural brain passed on this idea (${Math.round((plan.neural.p ?? 0) * 100)}% chance, ${fmtR(plan.neural.expR)} expected): ${noPaper(this.live) ? 'with FTMO only on, it isn\'t traded' : 'it trades small on paper only, so the brain learns whether it was right'}` };
    // FTMO's own rules and the risk limits hold even while training.
    if (st.ruleStop) return { ok: false, reason: st.ruleStop };
    if (st.cooloff) return { ok: false, reason: st.cooloff.text };
    const flip = this.#flip(pos);
    if (flip) return { ok: false, reason: flip };
    // The weekend: all the desks on crypto, which moves as one market.
    const crowd = this.#weekendCrowd(pos);
    if (crowd) return { ok: false, reason: crowd };
    // The desk's own loss limit and its record on the account (your own alerts are your call).
    let alloc = { mult: 1 };
    let ev = null;
    // Practice on the Free Trial: what the evidence would hold back goes anyway, small.
    let practice = null;
    const hold = (why) => {
      if (st.practice) practice ??= why;
      return st.practice ? null : { ok: false, reason: why };
    };
    if (!boss) {
      const limit = this.deskLimit(agent);
      if (limit) return { ok: false, reason: limit };
      // A research desk's new strategy proves itself live on paper before it risks the account.
      const lab = this.labProving(agent);
      if (lab) { const no = hold(lab); if (no) return no; }
      // The evidence decides next: the nightly review on your own prices, and the long run.
      ev = this.evidence(agent);
      if (ev?.mult === 0) { const no = hold(ev.text); if (no) return no; }
      const form = this.form(agent);
      if (!form.ok) { const no = hold(form.text); if (no) return no; }
      alloc = this.allocation(agent);
      if (ev && ev.mult > 0 && ev.mult < 1) alloc = { ...alloc, mult: alloc.mult * ev.mult };
    }
    if (practice) {
      const pct = Math.min(LIMITS.practiceRiskPct, this.live.profile.riskPerTradePct);
      const mult = pct / this.live.profile.riskPerTradePct;
      return { ok: true, riskMult: st.mult * Math.min(alloc.mult, 1) * mult, reasons: [...st.reasons, `Practice on the Free Trial at ${pct}% a trade: ${practice}`], boss, training: true, practice: true };
    }
    const reasons = [...st.reasons, ...(alloc.text ? [alloc.text] : []), ...(ev && ev.mult < 1 ? [ev.text] : [])];
    // Training on FTMO: every trade goes, sized by the plan (and the desk's grade, in the live trader).
    if (st.training) return { ok: true, riskMult: st.mult * alloc.mult, reasons, boss, training: true };
    if (st.blocked) return { ok: false, reason: st.blocked };
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
    if (probation) return { ok: true, riskMult: st.mult * alloc.mult * 0.5, reasons: [...reasons, 'Unproven desk: half risk'], probation, boss };
    return { ok: true, riskMult: st.mult * alloc.mult, reasons, boss };
  }

  // A desk's own loss limit, like a trader's at a bank: once it has lost LIMITS.deskLossR full
  // risks on the account today, it's off the account until tomorrow.
  deskLimit(agent) {
    const lt = this.live;
    const acc = lt.account;
    const p = lt.profile;
    if (!acc || !p) return null;
    const day = lt.bridge.serverDay;
    const full = acc.balance * (p.riskPerTradePct / 100);
    const today = (l) => (l.closedDay ? l.closedDay === day : Date.now() - (l.closedAt || 0) < 12 * 3_600_000);
    const pnl = this.#links().filter((l) => l.agentId === agent.id && l.state === 'closed' && Number.isFinite(l.pnl) && today(l)).reduce((s, l) => s + l.pnl, 0);
    if (!(full > 0) || pnl > -LIMITS.deskLossR * full) return null;
    return `desk loss limit: ${fmtUsd(pnl)} on the account today, ${LIMITS.deskLossR}× its full risk of ${fmtUsd(full)}. Off the account until tomorrow${noPaper(lt) ? ' (FTMO only: it doesn\'t trade until then)' : '; it keeps trading on paper'}`;
  }

  // At the weekend every desk day-trades crypto, and Bitcoin, Ether and the rest move together:
  // a few positions at once on the account, or it's one big bet (training and practice too).
  #weekendCrowd(pos) {
    if (!this.live.fund?.weekendOn || GROUPS[pos.symbol] !== 'Crypto') return null;
    const open = this.#links().filter((l) => !l.previousSession && ['pending', 'open', 'closing'].includes(l.state) && GROUPS[l.floorSymbol] === 'Crypto').length;
    if (open < LIMITS.weekendCrypto) return null;
    return `weekend crypto: the account already has ${open} crypto positions, the most at once at the weekend (${LIMITS.weekendCrypto}), because crypto moves together`;
  }

  // No whipsaws: after the account lost on one side of a market, nothing the other way on it
  // for a while (selling oil, getting stopped, then buying it and getting stopped again).
  #flip(pos) {
    const side = pos.qty > 0 ? 'BUY' : 'SELL';
    const now = Date.now();
    const last = this.#links()
      .filter((l) => l.floorSymbol === pos.symbol && l.state === 'closed' && l.pnl < 0 && l.side && l.side !== side && now - (l.closedAt || 0) < LIMITS.noFlipMs)
      .sort((a, b) => b.closedAt - a.closedAt)[0];
    if (!last) return null;
    return `the account just lost on a ${last.side === 'BUY' ? 'long' : 'short'} ${pos.symbol} (${Math.max(1, Math.round((now - last.closedAt) / 60_000))} min ago): no flipping to the other side within ${LIMITS.noFlipMs / 60_000} minutes`;
  }

  // What the evidence says about this desk: the nightly review (live/review.js) on your own
  // recent prices, and its long-run record on many months of real prices (live/baseline.js).
  // null when neither says anything yet.
  //
  // Thousands of losing trades outweigh a few good weeks: a desk that lost money with
  // confidence over the long run trades paper only, unless the nightly review finds a
  // statistically real edge (its whole 90% range above zero) on your own prices, and then at
  // half size until that lasts. A desk with no edge over the long run (not significant either
  // way, a little below or above zero) trades at half size until the nightly review says more.
  evidence(agent) {
    const name = agent.profile.name.split(' ')[0];
    const d = this.live.review?.verdictFor?.(agent.id);
    const eff = d ? VERDICT_EFFECT[d.verdict] : null;
    const rec = d ? `${d.avgR >= 0 ? '+' : '−'}${Math.abs(d.avgR).toFixed(2)}R a trade over ${d.n} trades` : '';
    // At the weekend a desk day-trades crypto: its weekend record is the long run that counts
    // (the nightly review replays its own market, so it says nothing about crypto).
    const weekend = !!agent.weekend;
    const base = weekend ? this.live.weekendRecord : this.live.baseline;
    const long = base?.forDesk?.(agent.id) || null;
    const where = weekend ? ' at the weekend' : '';
    if (long?.verdict === 'loses') {
      if (d?.verdict === 'EDGE' && !weekend) return { mult: 0.5, verdict: 'EDGE', long, text: `${name} has an edge on your recent prices (${rec} in the nightly review) but lost money over the long run (${base.recordText(long)}): half size until the edge lasts` };
      return { mult: 0, verdict: 'loses', long, text: weekend
        ? `${name} lost money day-trading crypto at the weekend over the long run: ${base.recordText(long)}. Paper only at the weekend`
        : `${name} lost money over the long run: ${base.recordText(long)}. Paper only until the nightly review finds a real edge on your own prices` };
    }
    if (!eff || weekend) {
      if (long?.verdict === 'no edge') return { mult: 0.5, verdict: 'no edge', long, text: `${name} has no edge${where} over the long run (${base.recordText(long)}): half size` };
      // A hair above zero with a range either side of it isn't an edge either.
      if (long?.verdict === 'unclear') return { mult: 0.5, verdict: 'unclear', long, text: `${name} has no proven edge${where} over the long run (${base.recordText(long)}): half size` };
      if (long?.verdict === 'edge') return { mult: 1, verdict: 'edge', long, text: `${name} made money${where} over the long run (${base.recordText(long)})` };
      // Too few weekend trades to judge: half size until there's a record.
      if (weekend) return { mult: 0.5, verdict: 'unclear', long: null, text: `${name} has too short a record day-trading crypto at the weekend to judge: half size` };
      return null;
    }
    if (eff.mult === 0) return { mult: 0, verdict: d.verdict, text: `the nightly review found no edge on your prices (${rec}): paper only until a review finds one` };
    if (eff.mult < 1) return { mult: eff.mult, verdict: d.verdict, text: `${name} is unproven on your prices (${rec} in the nightly review): half size` };
    return { mult: 1, verdict: d.verdict, text: `${name} has an edge on your prices (${rec} in the nightly review)` };
  }

  // A research desk's strategy passed its validation on history, but a strategy found by
  // searching hundreds of ideas can pass by luck: the lab, run week after week on two weeks of
  // real 1-minute history (as the floor keeps), deployed strategies validated at +0.3R to
  // +0.4R a trade that then lost in the weeks after. So a new strategy trades paper first, on
  // real prices, and reaches the account once it has LIMITS.labPaperTrades live trades that
  // didn't lose money in total. null when it may go to the account.
  labProving(agent) {
    if (!agent.profile.lab || !agent.active) return null;
    const l = agent.active.live || {};
    const realOnly = agent.env?.clock?.mode === 'live';
    const n = realOnly ? l.realTrades || 0 : l.trades || 0;
    const sum = realOnly ? l.realSumR || 0 : l.sumR || 0;
    if (n >= LIMITS.labPaperTrades && sum >= 0) return null;
    const name = agent.profile.name.split(' ')[0];
    const so = n ? `, ${sum >= 0 ? '+' : '−'}${Math.abs(sum).toFixed(2)}R in total` : '';
    return n >= LIMITS.labPaperTrades
      ? `${name}'s strategy (${agent.active.name}) trades paper first and is down ${Math.abs(sum).toFixed(2)}R over its ${n} live trades: it reaches the account once that's back to 0R or better`
      : `${name}'s new strategy (${agent.active.name}) trades paper first: ${n} of ${LIMITS.labPaperTrades} live trades on real prices so far${so}. Validated on history isn't proven live`;
  }

  // A desk earns its place on the account with its current form: once it has LIMITS.formMin
  // trades on real prices, the average of its last LIMITS.formWindow must be 0R or better.
  // Below that it trades paper only, where it keeps learning, and it's back on the account as
  // soon as its paper trades lift the average again. (Replayed on real 1-minute history, this
  // kept the two desks whose method didn't suit those markets off the account, and the rest
  // were positive in both halves of the history.)
  form(agent) {
    const recent = (agent.lifetime?.recentR || []).slice(-LIMITS.formWindow);
    const n = recent.length;
    if (n < LIMITS.formMin) return { ok: true, n, avgR: null };
    const avgR = recent.reduce((s, r) => s + r, 0) / n;
    if (avgR >= 0) return { ok: true, n, avgR };
    const name = agent.profile.name.split(' ')[0];
    return { ok: false, n, avgR, text: `out of form: ${name}'s last ${n} trades on real prices averaged ${avgR >= 0 ? '+' : '−'}${Math.abs(avgR).toFixed(2)}R. ${noPaper(this.live) ? 'Off the account until that\'s back to 0R or better' : 'Paper only until that\'s back to 0R or better; the desk keeps trading on paper'}` };
  }

  // Capital follows results, as at a multi-manager fund: a desk whose recent trades on the
  // account lost money after costs (spread, commission, slippage: what MT5 actually paid)
  // trades at half size until its record turns positive again.
  allocation(agent) {
    const recent = this.#links()
      .filter((l) => l.agentId === agent.id && l.state === 'closed' && l.risk > 0 && Number.isFinite(l.pnl))
      .sort((a, b) => (a.closedAt || 0) - (b.closedAt || 0))
      .slice(-LIMITS.allocWindow);
    const n = recent.length;
    if (n < LIMITS.allocMin) return { mult: 1, n, avgR: null };
    const avgR = recent.reduce((s, l) => s + l.pnl, 0) / recent.reduce((s, l) => s + l.risk, 0);
    const r = `${avgR >= 0 ? '+' : '−'}${Math.abs(avgR).toFixed(2)}R`;
    if (avgR >= 0) return { mult: 1, n, avgR };
    return { mult: 0.5, n, avgR, text: `${agent.profile.name.split(' ')[0]}'s last ${n} account trades made ${r} each after costs: half size until it earns it back` };
  }

  // Where a desk stands with the account right now, in one line the whole floor can show.
  deskStatus(agent, st = this.state()) {
    const lt = this.live;
    const p = lt.profile;
    if (!p?.desks?.[agent.id]) return { state: 'off', label: 'Off', text: `Not switched on for the FTMO account: ${noPaper(lt) ? 'with FTMO only on, it doesn\'t trade' : 'paper only'}` };
    if (!lt.eligible(agent.id)) return noPaper(lt) ? { state: 'paper', label: 'Not trading', text: `${lt.ineligibleReason(agent.id).replace(/ — paper only\.?$/, '')}. With FTMO only on, it doesn't trade.` } : { state: 'paper', label: 'Paper only', text: lt.ineligibleReason(agent.id) };
    const open = this.#links().find((l) => l.agentId === agent.id && !l.previousSession && ['open', 'closing', 'pending'].includes(l.state));
    if (open) return { state: 'live', label: 'LIVE', text: `Live on MT5: ${open.side} ${open.volumeNow ?? open.volume0} ${open.brokerSymbol}` };
    if (lt.halt) return { state: 'halted', label: 'Halted', text: lt.halt.reason };
    if (st?.ruleStop && lt.armed) return { state: 'stopped', label: 'Stopped today', text: st.ruleStop };
    if (st?.cooloff && lt.armed) return { state: 'stopped', label: 'Cooling off', text: st.cooloff.text };
    const limit = this.deskLimit(agent);
    if (limit && lt.armed) return { state: 'stopped', label: 'Desk limit', text: limit };
    // Held back by the evidence: paper only, or with practice on the Free Trial, small on it.
    const held = (what, text) => {
      const say = `${text.charAt(0).toUpperCase()}${text.slice(1)}.`;
      if (!st?.practice) return { state: 'proving', label: `Paper · ${what}`, text: say };
      const pct = Math.min(LIMITS.practiceRiskPct, p.riskPerTradePct);
      if (!lt.armed) return { state: 'ready', label: `Practice · ${what} · not armed`, text: `Practises on the Free Trial at ${pct}% a trade once you arm live trading. ${say}` };
      return { state: 'training', label: `Practice · ${what}`, text: `Practises on the Free Trial at ${pct}% a trade (practice is on). ${say}` };
    };
    const lab = this.labProving(agent);
    if (lab) return held('proving live', lab);
    const ev = this.evidence(agent);
    if (ev?.mult === 0) return held(ev.verdict === 'loses' ? (agent.weekend ? 'loses on weekend crypto' : 'loses long-term') : 'no edge', ev.text);
    const form = this.form(agent);
    if (!form.ok) return held('out of form', form.text);
    const alloc = this.allocation(agent);
    const half = [alloc.text, ev && ev.mult < 1 ? ev.text : null].filter(Boolean).map((t) => ` ${t}.`).join('');
    const halfSize = !!alloc.text || (ev && ev.mult < 1);
    if (st?.training) {
      if (!lt.armed) return { state: 'ready', label: halfSize ? 'Training · half size · not armed' : 'Training · not armed', text: `Every trade it takes will go to FTMO (training on FTMO).${half} Arm live trading to start.` };
      return { state: 'training', label: halfSize ? 'Training · half size' : ev?.mult === 1 ? 'Training · proven' : 'Training on FTMO', text: `Every trade it takes goes to your FTMO account (training on FTMO).${half}${ev?.mult === 1 ? ` ${ev.text}.` : ''}` };
    }
    const c = this.clearance(agent);
    const alerts = agent.profile.tvDesk ? ' Your TradingView alerts through this desk still go to the account.' : '';
    if (!c.ok && p.provenOnly === false) {
      if (!lt.armed) return { state: 'ready', label: 'Unproven · not armed', text: 'Will trade the account at half risk while unproven ("Proven desks only" is off). Arm live trading to start.' };
      if (st?.blocked) return { state: 'stopped', label: 'Stopped today', text: st.blocked };
      return { state: 'probation', label: 'Unproven · half risk', text: `Trades the account at half risk while it proves itself ("Proven desks only" is off): ${c.text}.` };
    }
    if (!c.ok) return { state: 'proving', label: 'Proving on paper', text: `Paper only for now: ${c.text}.${alerts}` };
    if (!lt.armed) return { state: 'ready', label: halfSize ? 'Cleared · half size · not armed' : 'Cleared · not armed', text: `Cleared for the account.${half} Arm live trading in the FTMO tab to start.` };
    if (st?.blocked) return { state: 'stopped', label: 'Stopped today', text: st.blocked };
    return { state: 'cleared', label: halfSize ? 'Cleared · half size' : 'Cleared', text: `Cleared: its ${st?.minGrade === 'B' ? 'A and B-grade' : 'A-grade'} trades go to MT5.${half}` };
  }
}
