import { api } from '../net.js';
import { escapeHtml } from '../format.js';

// The account plan's switches, shown on the Brain and FTMO tabs. Each rule that can hold
// trades back has its own switch, so the boss can let the desks run and watch the
// performance. FTMO's own loss guard stays on whatever is switched off.

const SWITCHES = [
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
    on: (p) => `Done for the day after ${p.streakStop} losing trades in a row (streak ${p.streak}).`,
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
  return `<div class="plan-switches">${SWITCHES.map((sw) => {
    const on = plan[sw.key] !== false;
    return `<div class="plan-switch ${on ? '' : 'off'}">
      <label class="switch safe" title="${on ? 'Switch off' : 'Switch on'}"><input type="checkbox" data-plan-switch="${sw.key}" ${on ? 'checked' : ''} aria-label="${escapeHtml(sw.title(plan))}"><span></span></label>
      <div><b>${escapeHtml(sw.title(plan))}: ${on ? 'ON' : 'OFF'}</b><small>${escapeHtml(on ? sw.on(plan) : sw.off(plan))}</small></div>
    </div>`;
  }).join('')}</div>`;
}

// Kept for the places that show only the daily stop.
export const dailyStopSwitch = planSwitches;

// A click on a switch: confirm when switching a protection off, then save it on the floor.
export async function onPlanSwitch(input, plan) {
  const sw = SWITCHES.find((x) => x.key === input?.dataset.planSwitch);
  if (!sw) return;
  const on = input.checked;
  if (!on && !confirm(sw.confirm(plan || {}))) {
    input.checked = true;
    return;
  }
  try {
    const res = await api('/api/live/plan', { method: 'POST', body: JSON.stringify({ [sw.key]: on }) });
    if (!res.ok) {
      input.checked = !on;
      alert(res.error || 'Could not change the setting');
    }
  } catch (err) {
    input.checked = !on;
    alert(`Could not reach the floor: ${err.message}`);
  }
}
