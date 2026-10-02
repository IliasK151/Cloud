import { escapeHtml } from '../format.js';

// "Today on the account": are the desks trading, and if not, why not? One sentence on top,
// the market hours in the boss's own time, the day's funnel (ideas → turned down → paper →
// held back → sent to FTMO) and, per desk, what it's doing and the latest reason it didn't
// trade the account.

// ---- market hours ------------------------------------------------------------------------------
const NY = new Intl.DateTimeFormat('en-US', {
  timeZone: 'America/New_York', year: 'numeric', month: '2-digit', day: '2-digit',
  hour: '2-digit', minute: '2-digit', weekday: 'short', hourCycle: 'h23',
});

function nyParts(ms) {
  const p = {};
  for (const x of NY.formatToParts(new Date(ms))) p[x.type] = x.value;
  return { y: +p.year, mo: +p.month, d: +p.day, h: +p.hour % 24, m: +p.minute, wd: p.weekday };
}

// Epoch ms of hh:mm New York time, `days` after the New York date of `ms`.
export function nyAt(ms, hh, mm, days = 0) {
  const p = nyParts(ms);
  const offset = Date.UTC(p.y, p.mo - 1, p.d, p.h, p.m) - Math.floor(ms / 60_000) * 60_000;
  return Date.UTC(p.y, p.mo - 1, p.d + days, hh, mm) - offset;
}

const localTime = (ms, timeZone) => new Date(ms).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', ...(timeZone ? { timeZone } : {}) });

// Where the markets are right now, and the next busy windows, in the boss's own time zone.
export function marketClock(ms, timeZone) {
  const p = nyParts(ms);
  const min = p.h * 60 + p.m;
  const at = (hh, mm, days = 0) => localTime(nyAt(ms, hh, mm, days), timeZone);
  const weekend = (p.wd === 'Fri' && min >= 17 * 60) || p.wd === 'Sat' || (p.wd === 'Sun' && min < 18 * 60);
  let session;
  let quiet = false;
  if (weekend) {
    session = `the weekend: FX, gold, oil and the indices are closed (crypto trades on). They reopen Sunday 18:00 New York, ${p.wd === 'Sun' ? at(18, 0) : 'Sunday evening'} your time`;
    quiet = true;
  } else if (min >= 16 * 60 + 50 && min < 18 * 60) session = 'the daily close: the desks are flat until 18:00 New York';
  else if (min >= 16 * 60 && min < 16 * 60 + 50) { session = 'after the New York close, a quiet hour'; quiet = true; }
  else if (min >= 9 * 60 + 30) session = 'the New York session, the busiest hours';
  else if (min >= 3 * 60) session = 'the London session';
  else { session = 'the Asia session, the quietest hours for most desks'; quiet = true; }

  // The busy windows still ahead, soonest first (tomorrow's if today's have passed).
  const windows = [
    { label: 'London open', h: 3, m: 0 },
    { label: 'New York open', h: 9, m: 30 },
  ].map((w) => {
    const days = min < w.h * 60 + w.m ? 0 : 1;
    return { ...w, ms: nyAt(ms, w.h, w.m, days), local: at(w.h, w.m, days) };
  }).sort((a, b) => a.ms - b.ms);

  const kz = (name, from, to) => ({ name, from: at(Math.floor(from / 60), from % 60), to: at(Math.floor(to / 60), to % 60), open: !weekend && min >= from && min < to });
  return {
    ny: `${String(p.h).padStart(2, '0')}:${String(p.m).padStart(2, '0')}`,
    local: localTime(ms, timeZone),
    session, quiet, weekend, windows,
    scalp: [kz('London', 2 * 60, 5 * 60), kz('New York', 8 * 60, 11 * 60)],
  };
}

// ---- why trades stay on paper -----------------------------------------------------------------
const MEANING = {
  'Committee grade too low': 'The committee grades every idea A, B or C. Only A and B-grade trades go to the account; a C ("not convinced") stays on paper so the desk keeps measuring.',
  'Desk not proven yet': 'The desk needs 10+ trades on real prices with a positive edge first, or switch off "Proven desks only" below.',
  'Correlated position already open': 'One position per correlated group: both US indices are one bet, so are the coins and the FX pairs.',
  'Account plan stopped for the day': 'The account plan\'s daily stop, trade cap or losing-streak stop (each has a switch below).',
  'Max open positions reached': 'The account already holds the most positions the setup allows.',
  'Open-risk budget full': 'The trades already open use the whole open-risk budget.',
  'News blackout': 'High-impact news is due: no new trades around it.',
  'No room under the loss guard': 'The trade could breach the FTMO loss limits.',
  'Below the broker\'s minimum lot': 'Even the smallest lot risks more than the account allows per trade.',
  'Market not on MT5': 'That market isn\'t mapped to a symbol on your account (Edit setup).',
  'Algo Trading off in MT5': 'Turn on the Algo Trading button in MT5.',
  'TradingView test alert': 'Test alerts never trade the account.',
  'No real prices': 'Only real prices trade real money.',
  'FTMO Best Day rule': 'FTMO 1-Step: no single day may be more than half the profit, so the desks call it a day at half the target\'s profit.',
  'Cool-off after a losing streak': 'After 3 losses in a row the account pauses for 2 hours. The desks keep trading on paper, so they keep learning.',
  'Desk out of form': 'The desk\'s last 12 trades on real prices lost on average. It trades paper only, where it keeps learning, and it\'s back on the account as soon as that average is 0R or better.',
  'Desk loss limit': 'A desk that has lost twice its full risk on the account today is off it until tomorrow, like a trader\'s loss limit at a bank.',
  'No flipping right after a loss': 'After a losing trade on a market, nothing the other way on it for 30 minutes: buying right after a losing sell is how a choppy market takes both sides.',
  'Costs too high for the stop': 'The spread and commission would eat more than a quarter of the trade\'s risk before it starts. The stop is too tight for that market\'s costs.',
  'FTMO order-action limit': 'FTMO allows 2,000 order actions a day; the floor stops new trades at 1,000, far below it.',
};

const ago = (at, now) => {
  const s = Math.max(0, Math.round((now - at) / 1000));
  return s < 90 ? 'just now' : s < 5400 ? `${Math.round(s / 60)} min ago` : `${Math.round(s / 3600)} h ago`;
};
const plural = (n, one, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;
const clip = (s, n = 110) => (s.length > n ? `${s.slice(0, n - 1)}…` : s);
const lc = (s) => s.charAt(0).toLowerCase() + s.slice(1);

// The day so far on the account, in numbers and in one sentence.
export function todaySummary(store, now = Date.now()) {
  const v = store.live;
  if (!v?.profile) return null;
  const t = v.today || { sent: 0, failed: 0, held: 0, reasons: [], byDesk: {}, recent: [] };
  const desks = (v.desks || []).filter((d) => d.enabled && d.eligible);
  let ideas = 0;
  let vetoed = 0;
  let skipped = 0;
  let paper = 0;
  const rows = desks.map((d) => {
    const a = store.agents?.[d.id];
    const day = a?.today || {};
    ideas += day.ideas || 0;
    vetoed += day.vetoed || 0;
    skipped += day.skipped || 0;
    paper += day.entries || 0;
    const mine = t.byDesk?.[d.id] || {};
    // The latest reason this desk didn't trade the account: held back by the account, or a
    // signal that never became a trade.
    const held = d.lastSkip && (!day.whyNot || d.lastSkip.at >= day.whyNot.at)
      ? { text: `${d.lastSkip.symbol} trade held back: ${d.lastSkip.reason}`, at: d.lastSkip.at }
      : null;
    const why = d.status?.state === 'live'
      ? { text: d.status.text, live: true }
      : held || (day.whyNot ? { text: day.whyNot.text, at: day.whyNot.at } : null);
    return {
      id: d.id, name: d.name, desk: d.desk, status: a?.status || '—', stage: a?.setup?.stage || '',
      ideas: day.ideas || 0, vetoed: day.vetoed || 0, paper: day.entries || 0, sent: mine.sent || 0, held: mine.held || 0,
      why, account: d.status,
    };
  }).sort((x, y) => (y.why?.live ? 1 : 0) - (x.why?.live ? 1 : 0) || y.sent - x.sent || y.ideas - x.ideas);

  const top = t.reasons?.[0]?.[0] || null;
  const training = !!v.plan?.training;
  const working = training
    ? 'Everything is connected and armed, and the desks are training on FTMO: every trade they take goes to the account'
    : 'Everything is connected and armed, and the desks are working';
  let headline;
  let tone = 'info';
  if (!v.connected) { headline = 'MT5 isn\'t connected, so nothing can reach the account. See Connection below.'; tone = 'bad'; }
  else if (v.halt) { headline = `Trading is halted: ${v.halt.reason}.`; tone = 'bad'; }
  else if (!v.armed) { headline = 'Live trading isn\'t armed, so the desks trade on paper only. Arm it in Connection below.'; tone = 'warn'; }
  else if (!desks.length) { headline = 'No desk is switched on for the account (Desks on the account, below).'; tone = 'warn'; }
  else if (v.plan?.blocked) { headline = `The account plan stopped for today: ${v.plan.blocked}.`; tone = 'warn'; }
  else if (t.sent) {
    headline = `${plural(t.sent, 'trade')} went to FTMO today.${t.held ? ` ${plural(t.held, 'more', 'more')} stayed on paper, mostly: ${lc(top)}.` : ''}`;
    tone = 'good';
  } else if (t.held) headline = `No trades on FTMO yet today. ${working}: ${plural(t.held, 'trade')} ${t.held === 1 ? 'was' : 'were'} held back from the account, mostly: ${lc(top)}.`;
  else if (paper && !training) headline = `No trades on FTMO yet today. ${working}: ${plural(paper, 'paper trade')} so far, none of ${paper === 1 ? 'it' : 'them'} qualified for the account.`;
  else if (ideas) headline = `No trades on FTMO yet today. ${working}. They found ${plural(ideas, 'setup')} and the committee turned ${vetoed >= ideas ? (ideas === 1 ? 'it' : 'all of them') : vetoed} down (no reward worth the risk, news due, or a dead or wild market).`;
  else headline = `No trades yet today. ${working}, but the market hasn't given them a setup that meets their rules yet.`;

  return {
    headline, tone, top, meaning: top ? MEANING[top] || '' : '',
    funnel: { ideas, turnedDown: vetoed + skipped, vetoed, skipped, paper, held: t.held || 0, sent: t.sent || 0, failed: t.failed || 0 },
    reasons: t.reasons || [], rows, now,
  };
}

export function renderToday(store, { now = Date.now(), timeZone } = {}) {
  const s = todaySummary(store, now);
  if (!s) return '';
  const c = marketClock(store.fund?.marketTime || now, timeZone);
  const next = c.windows.map((w) => `${w.label} ${w.local}`).join(' · ');
  const scalp = c.scalp.map((k) => `${k.name} ${k.from}–${k.to}${k.open ? ' <b class="open">(open now)</b>' : ''}`).join(' · ');
  const f = s.funnel;
  const tile = (label, n, sub = '', cls = '') => `<div class="ft ${cls}"><span>${label}</span><b class="num">${n}</b>${sub ? `<small>${sub}</small>` : ''}</div>`;
  const reasons = s.reasons.length
    ? `<div class="today-reasons"><h3>Why trades stayed on paper today</h3><ul>${s.reasons.map(([k, n]) => `<li><b>${escapeHtml(k)}</b> <span class="num">${n}</span>${MEANING[k] ? `<small>${escapeHtml(MEANING[k])}</small>` : ''}</li>`).join('')}</ul></div>`
    : '';
  const rows = s.rows.map((r) => `<tr>
      <td><b>${escapeHtml(r.name.split(' ')[0])}</b><small>${escapeHtml(r.desk)}</small></td>
      <td><span class="st">${escapeHtml(r.status.toLowerCase())}</span>${r.stage ? `<small>${escapeHtml(clip(r.stage))}</small>` : ''}</td>
      <td class="r num">${r.ideas}${r.vetoed ? `<small>${r.vetoed} no</small>` : ''}</td>
      <td class="r num">${r.paper}</td>
      <td class="r num ${r.sent ? 'pos' : ''}">${r.sent}</td>
      <td class="why">${r.why ? `${escapeHtml(clip(r.why.text, 160))}${r.why.at ? ` <span class="muted">· ${ago(r.why.at, s.now)}</span>` : ''}` : '<span class="muted">No setup yet today</span>'}</td>
    </tr>`).join('');
  return `
    <h2>Today on the account</h2>
    <p class="today-head ${s.tone}">${escapeHtml(s.headline)}</p>
    <p class="today-clock">Now <b>${c.ny}</b> in New York, <b>${c.local}</b> your time: ${escapeHtml(c.session)}.${c.weekend ? '' : ` Next: ${next} your time.`}<br>
      <span class="muted">Scalpers (your time): ${scalp}</span></p>
    <div class="acct-funnel">
      ${tile('Trade ideas', f.ideas, 'setups the desks found')}
      ${tile('Turned down', f.turnedDown, `committee ${f.vetoed}${f.skipped ? ` · experience ${f.skipped}` : ''}`)}
      ${tile('Paper trades', f.paper, 'taken by the desks')}
      ${tile('Held back', f.held, 'stayed on paper', f.held ? 'warn' : '')}
      ${tile('Sent to FTMO', f.sent, f.failed ? `${f.failed} refused by MT5` : 'orders on your account', f.sent ? 'good' : '')}
    </div>
    ${ftmoLine(store.live)}
    ${reasons}
    <div class="table-wrap" style="max-height:none"><table class="table compact today-desks">
      <thead><tr><th>Desk</th><th>Doing now</th><th class="r">Ideas</th><th class="r">Paper</th><th class="r">FTMO</th><th>Latest on the account</th></tr></thead>
      <tbody>${rows || '<tr><td colspan="6" class="muted">No desk is switched on for the account.</td></tr>'}</tbody>
    </table></div>
    <p class="fine">Counts start at the beginning of the trading day (18:00 New York). Ideas the committee turned down minutes earlier aren't counted twice.</p>`;
}

// FTMO's own limits today, in one line: order actions, the loss lines and the Best Day rule.
const usd = (x, sign = false) => `${sign && x > 0 ? '+' : x < 0 ? '−' : ''}$${Math.abs(x).toLocaleString('en-US', { maximumFractionDigits: 0 })}`;
export function ftmoLine(v) {
  const plan = v?.plan;
  const a = v?.today?.actions;
  if (!plan || !v.metrics) return '';
  const bits = [];
  if (a) bits.push(`<span>Order actions today <b class="num">${a.n.toLocaleString('en-US')}</b> of FTMO's ${a.ftmo.toLocaleString('en-US')}<small>new trades stop at ${a.newTrades.toLocaleString('en-US')}</small></span>`);
  bits.push(`<span>Daily loss line <b class="num">${usd(v.metrics.dailyFloor)}</b><small>${plan.dailyLossPct}% below today's start</small></span>`);
  bits.push(`<span>Max loss line <b class="num">${usd(plan.maxFloor)}</b><small>${plan.trailing ? 'trails the best end-of-day balance' : 'fixed at the start'}</small></span>`);
  const b = plan.bestDay;
  if (b) {
    bits.push(b.share == null
      ? `<span>Best Day rule <b class="num">—</b><small>no winning day yet · desks stop at ${usd(b.dayCap, true)} a day</small></span>`
      : `<span class="${b.ok || !plan.bestDayPending ? '' : 'warn'}">Best Day rule <b class="num">${Math.round(b.share * 100)}%</b><small>best day ${usd(b.best.pnl, true)} of ${usd(b.total)} · ${b.pct}% or less to pass</small></span>`);
  }
  const program = plan.program
    ? `FTMO ${escapeHtml(plan.programLabel)}`
    : 'FTMO program not set: <b>the stricter 1-Step limits apply</b>';
  return `<div class="ftmo-line"><em>${program}</em>${bits.join('')}</div>`;
}

// One line for the floor's desk rail: the day on the account, and where to see why.
export function todayRailNote(store) {
  const s = todaySummary(store);
  const v = store.live;
  if (!s || !v?.armed || !v.connected) return '';
  const f = s.funnel;
  const what = f.sent
    ? `<b>${plural(f.sent, 'trade')} on FTMO today.</b>`
    : `<b>No trades on FTMO yet today.</b> ${f.held ? `${f.held} held back${s.top ? ` (${escapeHtml(lc(s.top))})` : ''}.` : f.ideas ? `${plural(f.ideas, 'idea')}, ${f.turnedDown} turned down.` : 'No setups yet.'}`;
  return `${what} <button class="btn" data-goto-view="ftmo">See why on the FTMO tab</button>`;
}
