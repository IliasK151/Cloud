import { api } from '../net.js';

// The daily-stop switch for the account plan, shown on the Brain and FTMO tabs.
// On: no new trades on the account after a −1.5% day. Off: the desks keep trading so the
// boss can watch the performance; FTMO's own daily loss guard still applies either way.

export function dailyStopSwitch(plan) {
  if (!plan) return '';
  const on = plan.dailyStopOn !== false;
  const pct = plan.dailyStopPct;
  return `<div class="plan-switch ${on ? '' : 'off'}">
    <label class="switch safe" title="${on ? 'Switch the daily stop off' : 'Switch the daily stop on'}"><input type="checkbox" data-plan-switch="dailyStopOn" ${on ? 'checked' : ''} aria-label="Daily stop at −${pct}%"><span></span></label>
    <div><b>Daily stop at −${pct}%: ${on ? 'ON' : 'OFF'}</b><small>${on
      ? `No new trades on the account after a −${pct}% day.`
      : `The desks keep trading after a −${pct}% day. FTMO's daily loss guard still stops everything near the ${plan.dailyLossPct ?? 5}% limit.`}</small></div>
  </div>`;
}

// Handles a click on the switch: confirm, then save it on the floor.
export async function onPlanSwitch(input) {
  if (input?.dataset.planSwitch !== 'dailyStopOn') return;
  const on = input.checked;
  if (!on && !confirm('Switch off the daily stop?\n\nThe desks will keep trading your account after a losing day instead of stopping. Losses can then go past −1.5% in a day.\n\nFTMO\'s daily loss guard still closes everything and stops trading near the daily limit.')) {
    input.checked = true;
    return;
  }
  try {
    const res = await api('/api/live/plan', { method: 'POST', body: JSON.stringify({ dailyStopOn: on }) });
    if (!res.ok) {
      input.checked = !on;
      alert(res.error || 'Could not change the daily stop');
    }
  } catch (err) {
    input.checked = !on;
    alert(`Could not reach the floor: ${err.message}`);
  }
}
