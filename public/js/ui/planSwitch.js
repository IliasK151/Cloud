import { api } from '../net.js';
import { escapeHtml } from '../format.js';

// The account plan's switches, shown on the Brain and FTMO tabs. Each rule that can hold
// trades back has its own switch, so the boss can let the desks run and watch the
// performance. FTMO's own loss guard stays on whatever is switched off.

const SWITCHES = [
  {
    key: 'training',
    only: (p) => p.canTrain, // Free Trial only
    title: () => 'Training on FTMO',
    on: () => 'Every trade the desks take goes to your FTMO account, so they learn there, not on paper. FTMO\'s loss guard, real prices and a stop-loss on every order still apply.',
    off: () => 'The account plan below decides which trades go to FTMO; the rest stay on paper.',
    confirmOn: () => 'Train the desks on FTMO?\n\nEvery trade the desks take goes to your FTMO Free Trial: no committee-grade, proven-desk, correlation or daily-plan holds. Expect many more trades, including ones the committee isn\'t convinced by (sized smaller).\n\nFTMO\'s loss guard still closes everything near the limits, and every order carries its stop-loss.',
  },
  {
    key: 'dailyStopOn',
    title: (p) => `Daily stop at −${p.dailyStopPct}%`,
    on: (p) => `No new trades on the account after a −${p.dailyStopPct}% day.`,
    off: (p) => `The desks keep trading after a −${p.dailyStopPct}% day. FTMO's daily loss guard still stops everything near the ${p.dailyLossPct ?? 5}% limit.`,
    confirm: (p) => `Switch off the daily stop?\n\nThe desks will keep trading your account after a losing day instead of stopping. Losses can then go past −${p.dailyStopPct}% in a day.\n\nFTMO's daily loss guard still closes everything and stops trading near the daily limit.`,
  },
  {
    key: 'tradeCapOn',
    title: (p) => `Max ${p.maxTradesPerDay} trades a day`,
    on: (p) => `No new trades after ${p.maxTradesPerDay} today (${p.tradesToday} so far).`,
    off: (p) => `No limit on trades a day (${p.tradesToday} so far). Every other rule still applies.`,
    confirm: (p) => `Switch off the ${p.maxTradesPerDay}-trades-a-day cap?\n\nThe desks can then trade the account as often as their setups appear. Overtrading raises costs and risk; every other rule and FTMO's loss guard still apply.`,
  },
  {
    key: 'streakStopOn',
    title: (p) => `Stop after ${p.streakStop} losses in a row`,
    on: (p) => (p.training
      ? `While training: a 2-hour cool-off on the account after ${p.streakStop} losing trades in a row (streak ${p.streak}); the desks keep learning on paper.`
      : `Done for the day after ${p.streakStop} losing trades in a row (streak ${p.streak}).`),
    // This one still counts while training: it's the cool-off.
    training: true,
    off: (p) => `Keeps trading after a losing streak (streak ${p.streak}); risk still halves after 2 losses.`,
    confirm: (p) => `Switch off the losing-streak stop?\n\nThe desks keep trading after ${p.streakStop} losses in a row. Risk still halves after 2 losses, and FTMO's loss guard still applies.`,
  },
  {
    key: 'provenOnly',
    title: () => 'Proven desks only',
    on: () => 'A desk\'s own trades reach the account after 10+ trades on real prices with a positive edge.',
    off: () => 'Unproven desks trade the account too, at half risk (committee-approved A and B trades), so you can watch them for real.',
    confirm: () => 'Let unproven desks trade the account?\n\nDesks that haven\'t proven an edge on real prices will send their committee-approved trades to your FTMO account, at half the normal risk. They can lose money while they prove themselves.\n\nFTMO\'s loss guard and every other rule still apply.',
  },
];

export function planSwitches(plan) {
  if (!plan) return '';
  return `<div class="plan-switches">${SWITCHES.filter((sw) => !sw.only || sw.only(plan)).map((sw) => {
    const on = plan[sw.key] !== false;
    // While training on FTMO the plan's holds are paused: their switches wait.
    const paused = plan.training && sw.key !== 'training' && !sw.training;
    const cls = sw.key === 'training' ? `training ${on ? 'on' : 'off'}` : on ? '' : 'off';
    return `<div class="plan-switch ${cls}${paused ? ' paused' : ''}">
      <label class="switch safe" title="${paused ? 'Paused while training on FTMO' : on ? 'Switch off' : 'Switch on'}"><input type="checkbox" data-plan-switch="${sw.key}" ${on ? 'checked' : ''} ${paused ? 'disabled' : ''} aria-label="${escapeHtml(sw.title(plan))}"><span></span></label>
      <div><b>${escapeHtml(sw.title(plan))}: ${on ? 'ON' : 'OFF'}${paused ? ' · paused while training' : ''}</b><small>${escapeHtml(on ? sw.on(plan) : sw.off(plan))}</small></div>
    </div>`;
  }).join('')}</div>`;
}

// Kept for the places that show only the daily stop.
export const dailyStopSwitch = planSwitches;

// Set one switch: confirm when switching a protection off, then save it on the floor.
// Returns true when saved.
export async function setPlanSwitch(key, on, plan) {
  const sw = SWITCHES.find((x) => x.key === key);
  if (!sw) return false;
  if (!on && sw.confirm && !confirm(sw.confirm(plan || {}))) return false;
  if (on && sw.confirmOn && !confirm(sw.confirmOn(plan || {}))) return false;
  try {
    const res = await api('/api/live/plan', { method: 'POST', body: JSON.stringify({ [key]: on }) });
    if (!res.ok) alert(res.error || 'Could not change the setting');
    return !!res.ok;
  } catch (err) {
    alert(`Could not reach the floor: ${err.message}`);
    return false;
  }
}

// A click on a switch.
export async function onPlanSwitch(input, plan) {
  if (!input?.dataset.planSwitch) return;
  const on = input.checked;
  if (!(await setPlanSwitch(input.dataset.planSwitch, on, plan))) input.checked = !on;
}

// Switched-on desks whose own trades stay on paper because they're still proving
// themselves: say so where the boss is looking, with the one click that changes it.
export function provingNote(v) {
  const proving = (v?.desks || []).filter((d) => d.enabled && d.status?.state === 'proving');
  if (!v?.armed || v.plan?.training || !v.plan?.provenOnly || !proving.length) return '';
  const names = proving.map((d) => d.name.split(' ')[0]);
  const who = names.length <= 3 ? names.join(', ') : `${names.slice(0, 3).join(', ')} and ${names.length - 3} more`;
  return `<b>${proving.length === 1 ? `${escapeHtml(who)} is` : `${proving.length} desks are`} still proving ${proving.length === 1 ? 'itself' : 'themselves'}.</b> ${proving.length === 1 ? 'Its' : 'Their'} own trades stay on paper until ${proving.length === 1 ? 'it has' : 'each has'} 10 trades on real prices with a positive edge${proving.length === 1 ? '' : ` (${escapeHtml(who)})`}. Your TradingView alerts go to FTMO already.
    <button class="btn primary" data-act="let-trade">Let them trade FTMO now (half risk)</button>`;
}
