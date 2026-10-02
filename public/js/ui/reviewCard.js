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

const fr = (x) => (x == null ? '—' : `${x >= 0 ? '+' : '−'}${Math.abs(x).toFixed(2)}R`);
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
  const err = r.lastError ? `<p class="tg-msg bad">The last review didn't finish: ${escapeHtml(r.lastError.text)}</p>` : '';
  if (!rep) {
    return `${head}${progress}${err}<p class="fine">No review yet. It runs by itself after the New York close (and once, about 10 minutes after the floor first starts), as soon as the floor has saved some real prices. Or press Run now.</p>`;
  }
  const stale = !r.fresh ? ' <b class="warn-text">(over 4 days old: it no longer decides anything until the next one)</b>' : '';
  const rows = rep.desks.map((d) => {
    const eff = EFFECT[d.verdict];
    const range = d.ci ? `${fr(d.ci[0])} to ${fr(d.ci[1])}` : '';
    return `<tr>
      <td><b>${escapeHtml(d.name.split(' ')[0])}</b><small>${escapeHtml(d.desk)}</small></td>
      <td>${escapeHtml(d.symbol)}</td>
      <td class="r num">${d.n || '—'}</td>
      <td class="r num">${d.n ? pct(d.winRate) : '—'}</td>
      <td class="r num ${d.avgR > 0 ? 'pos' : d.avgR < 0 ? 'neg' : ''}">${d.n ? fr(d.avgR) : '—'}${range ? `<small>90%: ${range}</small>` : ''}</td>
      <td>${eff ? `<span class="verdict-chip ${eff.cls}">${eff.label}</span>` : `<span class="muted">${escapeHtml(d.verdict)}</span>`}</td>
      <td>${eff ? eff.account : '<span class="muted">Unchanged</span>'}</td>
    </tr>`;
  }).join('');
  const sim = rep.withEdge || rep.everyone;
  let odds = '';
  if (sim) {
    const adv = riskAdvice(sim, riskPct);
    const bars = sim.rows.map((x) => {
      const yours = Math.abs(x.riskPct - riskPct) < 1e-9;
      const best = adv.best && Math.abs(x.riskPct - adv.best.riskPct) < 1e-9;
      return `<div class="odds-row${yours ? ' yours' : ''}${best ? ' best' : ''}">
        <span class="odds-risk">${x.riskPct}%${yours ? ' <em>yours</em>' : ''}${best ? ' <em class="b">best</em>' : ''}</span>
        <span class="odds-bar"><i class="p" style="width:${(x.passed * 100).toFixed(1)}%"></i><i class="f" style="width:${(x.failed * 100).toFixed(1)}%"></i></span>
        <span class="odds-num">passes <b>${pct(x.passed)}</b> · fails ${pct(x.failed)}${x.medianDays ? ` · ~${x.medianDays} days` : ''}</span>
      </div>`;
    }).join('');
    // Only with desks that have an edge: without one, a bigger risk only fails faster.
    const button = adv.worth && rep.withEdge ? `<button class="btn primary" data-act="use-risk" data-risk="${adv.best.riskPct}">Use ${adv.best.riskPct}% risk a trade</button>` : '';
    odds = `
      <h3 class="review-h">Chance of passing FTMO ${escapeHtml(rep.program)} ($${Number(rep.size).toLocaleString('en-US')}), ${rep.withEdge ? 'trading the desks with an edge' : 'with every desk (none has an edge yet)'}</h3>
      <p class="fine">${sim.trades} replayed trades, ${fr(sim.avgR)} a trade after costs, about ${sim.tradesPerDay.toFixed(1)} a day. Thousands of challenges played out under the rules and the floor's loss guard, up to 60 trading days.</p>
      <div class="odds">${bars}</div>
      ${button ? `<div class="btn-row">${button}<span class="fine">Your risk per trade is ${riskPct}%.</span></div>` : ''}`;
  }
  const verdict = !rep.withEdge
    ? 'No desk shows an edge on your prices yet. Keep training on the Free Trial; don\'t pay for a challenge on these results.'
    : rep.withEdge.best.passed >= 0.6
      ? `The desks with an edge pass ${pct(rep.withEdge.best.passed)} of simulated challenges at ${rep.withEdge.best.riskPct}% risk. Confirm it on the Free Trial with the same desks and risk before paying for one.`
      : `Even the desks with an edge pass only ${pct(rep.withEdge.best.passed)} of simulated challenges. Not ready for a paid challenge yet.`;
  return `${head}${progress}${err}
    <p class="sub">Last review ${ago(rep.at, now)}${rep.tookMs ? ` (took ${Math.max(1, Math.round(rep.tookMs / 60_000))} min)` : ''} · ${rep.tradingDays} trading days of your prices${stale}</p>
    <p class="review-verdict ${rep.withEdge && rep.withEdge.best.passed >= 0.6 ? 'good' : 'warn'}">${escapeHtml(verdict)}</p>
    <div class="table-wrap" style="max-height:none"><table class="table compact review-desks">
      <thead><tr><th>Desk</th><th>Market</th><th class="r">Trades</th><th class="r">Won</th><th class="r">Per trade</th><th>Verdict</th><th>On the account</th></tr></thead>
      <tbody>${rows}</tbody>
    </table></div>
    ${odds}
    <p class="fine">History, not a promise: the market changes, and a few weeks of minutes is a small sample. The more the floor has saved, the sharper it gets. Same report in Terminal: <code>npm run edge</code>.</p>`;
}
