import { escapeHtml } from '../format.js';

// The nightly review card (FTMO tab): who has an edge on your own prices, what that means for
// the account, and the chance of passing a challenge at each risk size. The review itself
// runs on the server (live/review.js) every night after the New York close.

const EFFECT = {
  EDGE: { cls: 'v-edge', label: 'Edge', account: 'Full size' },
  promising: { cls: 'v-prom', label: 'Promising', account: 'Full size' },
  unclear: { cls: 'v-unclear', label: 'Unclear', account: 'Half size' },
  'no edge': { cls: 'v-none', label: 'No edge', account: 'Paper only' },
};

const LONG_LABEL = { loses: 'loses', 'no edge': 'no edge', unclear: 'unclear', edge: 'edge' };

// The long-run record by desk (from the server's baseline view), numbers only.
function longRun(baseline) {
  const out = new Map();
  for (const d of baseline?.desks || []) {
    if (!LONG_LABEL[d.verdict] || !Number.isFinite(d.avgR) || !Number.isFinite(d.n)) continue;
    out.set(d.id, { verdict: d.verdict, avgR: d.avgR, n: d.n, span: typeof d.span === 'string' ? d.span : null });
  }
  return out;
}

// What the two records mean on the account together (the same rules as the account brain).
function accountEffect(recent, long) {
  if (long === 'loses') return recent === 'EDGE' ? 'Half size' : 'Paper only';
  const eff = EFFECT[recent];
  if (eff) return eff.account;
  if (long === 'no edge' || long === 'unclear') return 'Half size';
  return '<span class="muted">Unchanged</span>';
}

const fr = (x) => (x == null ? '—' : `${x >= 0 ? '+' : '−'}${Math.abs(x).toFixed(2)}R`);

// Before the first nightly review: the long-run record on its own.
function longOnly(baseline) {
  const rows = (baseline?.desks || []).filter((d) => LONG_LABEL[d.verdict] && Number.isFinite(d.avgR) && Number.isFinite(d.n));
  if (!rows.length) return '';
  const span = rows.find((d) => typeof d.span === 'string')?.span;
  return `
    <h3 class="review-h">Long run${span ? `: ${escapeHtml(span)}` : ''} of real 1-minute prices</h3>
    <div class="table-wrap" style="max-height:none"><table class="table compact review-desks">
      <thead><tr><th>Desk</th><th>Market</th><th class="r">Trades</th><th class="r">Per trade</th><th>Verdict</th><th>On the account</th></tr></thead>
      <tbody>${rows.map((d) => `<tr>
        <td><b>${escapeHtml(String(d.name || d.id).split(' ')[0])}</b></td>
        <td>${escapeHtml(d.symbol || '')}</td>
        <td class="r num">${d.n.toLocaleString('en-US')}</td>
        <td class="r num ${d.avgR > 0 ? 'pos' : d.avgR < 0 ? 'neg' : ''}">${fr(d.avgR)}${Array.isArray(d.ci) ? `<small>90%: ${fr(d.ci[0])} to ${fr(d.ci[1])}</small>` : ''}</td>
        <td>${escapeHtml(LONG_LABEL[d.verdict])}</td>
        <td>${accountEffect(null, d.verdict)}</td>
      </tr>`).join('')}</tbody>
    </table></div>
    <p class="fine">A desk that lost money there with confidence trades paper only, unless the nightly review finds a real edge on your own prices.</p>`;
}
const pct = (x) => (x == null ? '—' : `${Math.round(x * 100)}%`);

function ago(ms, now) {
  const m = Math.max(0, Math.round((now - ms) / 60_000));
  if (m < 2) return 'just now';
  if (m < 90) return `${m} min ago`;
  const h = Math.round(m / 60);
  return h < 36 ? `${h} h ago` : `${Math.round(h / 24)} days ago`;
}

// The pass odds at your risk, the best risk, and whether switching is worth a button.
export function riskAdvice(sim, riskPct) {
  if (!sim?.rows?.length) return null;
  const mine = sim.rows.find((r) => Math.abs(r.riskPct - riskPct) < 1e-9) || null;
  const best = sim.best;
  const worth = !!best && best.passed > 0 && Math.abs(best.riskPct - riskPct) > 1e-9 && (!mine || best.passed - mine.passed >= 0.05);
  return { mine, best, worth };
}

export function renderReview(v, { now = Date.now() } = {}) {
  const r = v?.review;
  if (!v?.profile || !r) return '';
  const running = r.running;
  const rep = r.report;
  const riskPct = v.profile.riskPerTradePct;
  const head = `
    <div class="plan-head"><div><h2>Nightly review: who has an edge on your prices</h2>
      <p class="sub">Every night after the New York close, each desk is replayed minute by minute on the real prices the floor saved from your MT5, with FTMO's costs. Its verdict decides who trades the account: no edge means paper only, unclear means half size.</p></div>
      <button class="btn" data-act="review-run" ${running || v.mode !== 'live' ? 'disabled' : ''}>${running ? 'Reviewing…' : 'Run now'}</button></div>`;
  const progress = running ? `<p class="review-progress"><span class="spinner"></span>${escapeHtml(running.line || 'Starting')} <span class="muted">· started ${ago(running.startedAt, now)}, takes a few minutes</span></p>` : '';
  const retry = Number.isFinite(r.retryAt) ? Math.max(1, Math.round((r.retryAt - now) / 60_000)) : null;
  const when = retry == null ? '' : ` The floor tries again by itself in ${retry < 90 ? `${retry} min` : `${Math.round(retry / 60)} h`}.`;
  const err = r.lastError ? `<p class="tg-msg bad">The last review didn't finish: ${escapeHtml(String(r.lastError.text).replace(/\.+$/, ''))}.${when}</p>` : '';
  if (!rep) {
    return `${head}${progress}${err}<p class="fine">No review yet. It runs by itself after the New York close (and once, about 10 minutes after the floor first starts), as soon as the floor has saved some real prices. Or press Run now.</p>${longOnly(v.baseline)}`;
  }
  const stale = !r.fresh ? ' <b class="warn-text">(over 4 days old: the nightly reviews have stopped. Its verdicts still decide who trades until a new one runs; press Run now)</b>' : '';
  const long = longRun(v.baseline);
  const rows = rep.desks.map((d) => {
    const eff = EFFECT[d.verdict];
    const range = d.ci ? `${fr(d.ci[0])} to ${fr(d.ci[1])}` : '';
    const lr = long.get(d.id);
    const onAccount = accountEffect(d.verdict, lr?.verdict);
    return `<tr>
      <td><b>${escapeHtml(d.name.split(' ')[0])}</b><small>${escapeHtml(d.desk)}</small></td>
      <td>${escapeHtml(d.symbol)}</td>
      <td class="r num">${d.n || '—'}</td>
      <td class="r num">${d.n ? pct(d.winRate) : '—'}</td>
      <td class="r num ${d.avgR > 0 ? 'pos' : d.avgR < 0 ? 'neg' : ''}">${d.n ? fr(d.avgR) : '—'}${range ? `<small>90%: ${range}</small>` : ''}</td>
      <td>${eff ? `<span class="verdict-chip ${eff.cls}">${eff.label}</span>` : `<span class="muted">${escapeHtml(d.verdict)}</span>`}</td>
      ${long.size ? `<td class="r num ${lr && lr.avgR > 0 ? 'pos' : lr && lr.avgR < 0 ? 'neg' : ''}">${lr ? `${fr(lr.avgR)}<small>${lr.n.toLocaleString('en-US')} trades${LONG_LABEL[lr.verdict] ? ` · ${LONG_LABEL[lr.verdict]}` : ''}</small>` : '<span class="muted">—</span>'}</td>` : ''}
      <td>${onAccount}</td>
    </tr>`;
  }).join('');
  const longSpan = [...long.values()].find((x) => x.span)?.span;
  const sim = rep.withEdge || rep.everyone;
  let odds = '';
  if (sim) {
    const adv = riskAdvice(sim, riskPct);
    const bars = sim.rows.map((x) => {
      const yours = Math.abs(x.riskPct - riskPct) < 1e-9;
      // No "best" among sizes that all fail: 1 pass in 4,000 isn't a choice.
      const best = adv.best && adv.best.passed >= 0.005 && Math.abs(x.riskPct - adv.best.riskPct) < 1e-9;
      return `<div class="odds-row${yours ? ' yours' : ''}${best ? ' best' : ''}">
        <span class="odds-risk">${x.riskPct}%${yours ? ' <em>yours</em>' : ''}${best ? ' <em class="b">best</em>' : ''}</span>
        <span class="odds-bar"><i class="p" style="width:${(x.passed * 100).toFixed(1)}%"></i><i class="f" style="width:${(x.failed * 100).toFixed(1)}%"></i></span>
        <span class="odds-num">passes <b>${pct(x.passed)}</b> · fails ${pct(x.failed)}${x.medianDays && x.passed >= 0.005 ? ` · ~${x.medianDays} days` : ''}</span>
      </div>`;
    }).join('');
    // The odds were played out for the program and size of the account at the time of the
    // review: changed since, they don't fit any more and nothing is suggested from them.
    const program = v.profile.program === '2-step' ? '2-step' : '1-step';
    const mismatch = rep.program !== program || Number(rep.size) !== Number(v.profile.size);
    // Only with desks that have an edge: without one, a bigger risk only fails faster.
    const button = adv.worth && rep.withEdge && !mismatch ? `<button class="btn primary" data-act="use-risk" data-risk="${Number(adv.best.riskPct)}">Use ${Number(adv.best.riskPct)}% risk a trade</button>` : '';
    odds = `
      <h3 class="review-h">Chance of passing FTMO ${escapeHtml(rep.program)} ($${Number(rep.size).toLocaleString('en-US')}), ${rep.withEdge ? 'trading the desks with an edge' : 'with every desk (none has an edge yet)'}</h3>
      ${mismatch ? `<p class="tg-msg bad">These odds are for FTMO ${escapeHtml(rep.program)} $${Number(rep.size).toLocaleString('en-US')}; your account is now ${program} $${Number(v.profile.size).toLocaleString('en-US')}. Press Run now for odds that fit it.</p>` : ''}
      <p class="fine">${sim.trades} replayed trades, ${fr(sim.avgR)} a trade after costs, about ${sim.tradesPerDay.toFixed(1)} a day. Thousands of challenges played out under the rules and the floor's loss guard, up to 60 trading days.</p>
      <div class="odds">${bars}</div>
      ${button ? `<div class="btn-row">${button}<span class="fine">Your risk per trade is ${riskPct}%.</span></div>` : ''}`;
  }
  const best = rep.withEdge?.best || null;
  const verdict = !rep.withEdge || !best
    ? 'No desk shows an edge on your prices yet. Keep training on the Free Trial; don\'t pay for a challenge on these results.'
    : best.passed >= 0.6
      ? `The desks with an edge pass ${pct(best.passed)} of simulated challenges at ${best.riskPct}% risk. Confirm it on the Free Trial with the same desks and risk before paying for one.`
      : `Even the desks with an edge pass only ${pct(best.passed)} of simulated challenges. Not ready for a paid challenge yet.`;
  return `${head}${progress}${err}
    <p class="sub">Last review ${ago(rep.at, now)}${rep.tookMs ? ` (took ${Math.max(1, Math.round(rep.tookMs / 60_000))} min)` : ''} · ${rep.tradingDays} trading days of your prices${stale}</p>
    <p class="review-verdict ${best && best.passed >= 0.6 ? 'good' : 'warn'}">${escapeHtml(verdict)}</p>
    <div class="table-wrap" style="max-height:none"><table class="table compact review-desks">
      <thead><tr><th>Desk</th><th>Market</th><th class="r">Trades</th><th class="r">Won</th><th class="r">Per trade</th><th>Verdict</th>${long.size ? `<th class="r" title="Each desk replayed on many months of real 1-minute prices (npm run baseline)">Long run${longSpan ? `<small>${escapeHtml(longSpan)}</small>` : ''}</th>` : ''}<th>On the account</th></tr></thead>
      <tbody>${rows}</tbody>
    </table></div>
    ${long.size ? '<p class="fine">Long run: each desk replayed on many months of real 1-minute prices, thousands of trades. A desk that lost money there with confidence trades paper only, unless the nightly review finds a real edge (its whole 90% range above zero) on your own prices, and then at half size.</p>' : ''}
    ${odds}
    <p class="fine">History, not a promise: the market changes, and a few weeks of minutes is a small sample. The more the floor has saved, the sharper it gets. Same report in Terminal: <code>npm run edge</code>.</p>`;
}
