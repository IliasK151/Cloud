import { escapeHtml, nyTime } from '../format.js';

// Research lab rendering: the dashboard card and a research desk's Research tab.

export const fmtR = (x, d = 2) => (x == null || !Number.isFinite(x) ? '—' : `${x >= 0 ? '+' : '−'}${Math.abs(x).toFixed(d)}R`);
const pctTxt = (x) => (x == null ? '—' : `${Math.round(x * 100)}%`);
const cls = (x) => (x > 0.001 ? 'pos' : x < -0.001 ? 'neg' : '');

const STAGES = ['In-sample search', 'Out-of-sample test', 'Robustness checks', 'Final holdout'];

export function progressText(r) {
  if (!r) return '';
  if (r.progress) {
    const p = r.progress;
    const pct = p.total ? Math.round((p.done / p.total) * 100) : 0;
    return `${p.symbol}: ${p.stage}${p.stage === 'In-sample search' ? ` ${pct}%` : ''}${r.waitingFor?.length > 1 ? ` · ${r.waitingFor.length - 1} more market${r.waitingFor.length > 2 ? 's' : ''} queued` : ''}`;
  }
  if (r.researching) return r.queued ? 'Queued at the lab' : 'Researching…';
  return '';
}

function stageBar(r) {
  const st = r.progress?.stage;
  const idx = STAGES.indexOf(st);
  return `<div class="stages">${STAGES.map((s, i) => `<span class="${i < idx ? 'done' : i === idx ? 'now' : ''}">${s}</span>`).join('')}</div>`;
}

// ---- dashboard card ----------------------------------------------------------------------------
export function labRows(store) {
  const rows = store.profiles.filter((p) => p.lab).map((p) => ({ p, a: store.agents[p.id] })).filter((x) => x.a?.research);
  return `<thead><tr><th>Researcher</th><th>Market condition</th><th>Strategy</th><th class="r">On unseen data</th><th class="r">Live</th><th></th></tr></thead><tbody>${
    rows.map(({ p, a }) => {
      const r = a.research;
      const act = r.active;
      const regimeSym = act?.symbol || p.research?.markets?.[0];
      const rg = r.regimes?.[regimeSym];
      let strat;
      if (r.researching || r.progress) strat = `<span class="lab-busy"><i></i>${escapeHtml(progressText(r))}</span>${act ? `<small>Trading ${escapeHtml(act.name)} meanwhile</small>` : ''}`;
      else if (act) strat = `<b>${escapeHtml(act.name)}</b> <span class="muted">on ${act.symbol}</span>${act.probation ? ' <span class="pill warnp">PROBATION</span>' : ''}`;
      else if (a.status === 'LOADING DATA') strat = '<span class="muted">Loading market history…</span>';
      else strat = '<span class="muted">No strategy passed validation: not trading</span>';
      const u = act?.stats?.unseen;
      return `<tr class="clickable" data-id="${p.id}">
        <td><span class="desk-cell"><i style="background:${p.accent}"></i><span>${escapeHtml(p.name)}<small>${escapeHtml(p.desk)}</small></span></span></td>
        <td>${rg ? `${escapeHtml(rg.label)} <span class="muted">${regimeSym}</span>` : '<span class="muted">—</span>'}</td>
        <td>${strat}</td>
        <td class="r num">${u ? `<span class="${cls(u.avgR)}">${fmtR(u.avgR)}</span> <span class="muted">× ${u.n} · PF ${u.pf}</span>` : '<span class="muted">—</span>'}</td>
        <td class="r num">${act?.live?.trades ? `<span class="${cls(act.live.sumR)}">${fmtR(act.live.sumR, 1)}</span> <span class="muted">/ ${act.live.trades}</span>` : '<span class="muted">—</span>'}</td>
        <td class="r"><button class="mini-btn" data-research="${p.id}" ${r.researching ? 'disabled' : ''}>Research now</button></td>
      </tr>`;
    }).join('')
  }</tbody>`;
}

// ---- R equity curve with the in-sample / out-of-sample / holdout segments --------------------
function curveSvg(curve, splits, w = 360, h = 120) {
  if (!curve?.length) return '';
  const pts = [{ time: curve[0].time - 60, r: 0 }, ...curve];
  const t0 = pts[0].time;
  const t1 = pts[pts.length - 1].time;
  const lo = Math.min(0, ...pts.map((p) => p.r));
  const hi = Math.max(0, ...pts.map((p) => p.r));
  const span = hi - lo || 1;
  const x = (t) => ((t - t0) / Math.max(1, t1 - t0)) * (w - 4) + 2;
  const y = (v) => h - 14 - ((v - lo) / span) * (h - 22);
  const d = pts.map((p, i) => `${i ? 'L' : 'M'}${x(p.time).toFixed(1)},${y(p.r).toFixed(1)}`).join('');
  const xs = splits ? [x(splits.isTo), x(splits.oosTo)] : null;
  const seg = xs
    ? `<rect x="${xs[0]}" y="0" width="${xs[1] - xs[0]}" height="${h - 12}" fill="rgba(76,141,255,0.08)"/><rect x="${xs[1]}" y="0" width="${w - xs[1]}" height="${h - 12}" fill="rgba(45,212,191,0.1)"/>
       <text x="4" y="${h - 2}" class="seg">in-sample (search)</text><text x="${xs[0] + 3}" y="${h - 2}" class="seg">out-of-sample</text><text x="${xs[1] + 3}" y="${h - 2}" class="seg">holdout</text>`
    : '';
  return `<svg class="r-curve" viewBox="0 0 ${w} ${h}" preserveAspectRatio="none" aria-label="Backtest equity in R">${seg}
    <line x1="0" x2="${w}" y1="${y(0).toFixed(1)}" y2="${y(0).toFixed(1)}" stroke="rgba(255,255,255,0.15)"/>
    <path d="${d}" fill="none" stroke="#2dd4bf" stroke-width="1.8" stroke-linejoin="round"/></svg>`;
}

function statRow(label, s, note = '') {
  if (!s) return '';
  return `<tr><td>${label}${note ? ` <span class="muted">${note}</span>` : ''}</td><td class="r">${s.n}</td><td class="r">${pctTxt(s.winRate)}</td>
    <td class="r ${cls(s.avgR)}">${fmtR(s.avgR)}</td><td class="r">${s.pf >= 99 ? '∞' : s.pf}</td><td class="r">${s.maxDD?.toFixed(1)}R</td></tr>`;
}

function funnelHtml(f) {
  if (!f) return '';
  const steps = [['Ideas tested', f.tested], ['Edge in-sample', f.inSample], ['Held out-of-sample', f.outOfSample], ['Robust', f.robust], ['Passed holdout', f.holdout]];
  const max = Math.max(1, f.tested);
  return `<div class="funnel">${steps.map(([l, v]) => `<div><span>${l}</span><i style="width:${Math.max(2, (v / max) * 100)}%"></i><b>${v}</b></div>`).join('')}</div>`;
}

export function researchTab(R, p, a) {
  if (!R) return '<p class="muted">Loading…</p>';
  const first = p.name.split(' ')[0];
  const act = R.active;
  const busy = R.researching || R.progress;
  const markets = p.research?.markets || [];
  const regimes = markets.map((s) => R.regimes?.[s] ? `<span class="rg"><b>${s}</b> ${escapeHtml(R.regimes[s].label)}</span>` : '').join('');
  let html = `
    <div class="learn-strip">
      <div><span>Status</span><b>${busy ? 'Researching' : act ? (act.probation ? 'Probation' : 'Trading') : a?.status === 'LOADING DATA' ? 'Loading data' : 'No edge'}</b></div>
      <div><span>Ideas tested</span><b class="num">${R.tested.toLocaleString('en-US')}</b></div>
      <div><span>Live result</span><b class="num ${cls(act?.live?.sumR || 0)}">${act?.live?.trades ? `${fmtR(act.live.sumR, 1)} / ${act.live.trades}` : '—'}</b></div>
    </div>
    ${busy ? `<div class="lab-progress"><p><span class="lab-busy"><i></i>${escapeHtml(progressText(R))}</span></p>${stageBar(R)}</div>` : ''}
    ${regimes ? `<h3>Market conditions</h3><div class="regimes">${regimes}</div>` : ''}`;

  if (act) {
    const s = act.stats;
    const rb = act.robust || {};
    html += `
      <h3>Trading: ${escapeHtml(act.name)} on ${act.symbol}</h3>
      <p class="fine">Built for <b>${escapeHtml(act.regime?.label?.toLowerCase() || '')}</b> conditions · chosen from ${act.tested} ideas · deployed ${nyTime(act.deployedAt)} ET · about ${act.tradesPerDay} trades a day in the backtest.</p>
      <ol class="rules">${(act.rules || []).map((r) => `<li>${escapeHtml(r)}</li>`).join('')}</ol>
      <h3>Validation</h3>
      <div class="table-wrap"><table class="table compact"><thead><tr><th>Data</th><th class="r">Trades</th><th class="r">Win</th><th class="r">Avg</th><th class="r">PF</th><th class="r">Max DD</th></tr></thead><tbody>
        ${statRow('In-sample', s.is, '(searched: flattered)')}
        ${statRow('Out-of-sample', s.oos)}
        ${statRow('Final holdout', s.holdout)}
        ${statRow('<b>All unseen data</b>', s.unseen)}
      </tbody></table></div>
      ${curveSvg(act.curve, act.splits)}
      <div class="checks">
        <span class="ok">Neighbouring settings profitable: ${pctTxt(rb.neighbours)}</span>
        <span class="ok">With double costs: ${fmtR(rb.doubleCostsAvgR)} per trade</span>
        <span class="ok">Monte Carlo: ${pctTxt(rb.mc?.pPositive)} of reshuffles profitable, 95% worst drawdown ${rb.mc?.ddP95}R</span>
        <span class="ok">Statistical confidence on unseen data: t = ${s.unseen?.t}</span>
      </div>
      <h3>Live tracking</h3>
      <p class="fine">${act.live.trades
        ? `${act.live.trades} live trade${act.live.trades === 1 ? '' : 's'}, ${fmtR(act.live.sumR, 2)} in total (validation expects about ${fmtR((act.expectation?.avgR || 0) * act.live.trades, 1)}). `
        : 'No live trades yet. '}${act.probation ? 'On probation: half size until it has 5 trades and is in profit. ' : 'Full size. '}${escapeHtml(first)} retires the strategy automatically if live results fall clearly below what validation promised, or if the market changes and it no longer passes.</p>`;
  } else if (R.lastRun?.results) {
    html += `<h3>Last research${R.lastRun.at ? ` · ${nyTime(R.lastRun.at)} ET` : ''}</h3>`;
    for (const [sym, r] of Object.entries(R.lastRun.results)) {
      const reasons = Object.entries(r.reasons || {}).sort((x, y) => y[1] - x[1]).slice(0, 3);
      html += `<div class="lab-result"><div class="lh"><b>${sym}</b><span class="muted">${escapeHtml(r.regime?.label || '')}</span><span class="pill ${r.outcome === 'deploy' ? 'ok' : 'no'}">${r.outcome === 'deploy' ? 'PASSED' : r.outcome === 'data' ? 'NEED DATA' : 'NO EDGE'}</span></div>
        ${r.outcome === 'data' ? `<p class="fine">${escapeHtml(r.summary)}</p>` : funnelHtml(r.funnel)}
        ${reasons.length ? `<p class="fine">Most ideas failed because: ${reasons.map(([k, v]) => `${escapeHtml(k)} (${v})`).join(', ')}.</p>` : ''}
        ${r.nearMiss ? `<p class="fine">Closest: ${escapeHtml(r.nearMiss.name)}, rejected at the last step: ${escapeHtml(r.nearMiss.why)}.</p>` : ''}</div>`;
    }
    html += `<p class="fine">${escapeHtml(first)} is not trading, on purpose: no strategy proved itself on data it had never seen. Research runs again when the market changes, and every 45 minutes of market time.</p>`;
  } else if (!busy) {
    html += '<p class="fine">Waiting for market history before the first research round.</p>';
  }

  if (R.events?.length) {
    html += `<h3>Research log</h3><ol class="log">${R.events.slice(0, 12).map((e) => `<li class="k-research"><time>${nyTime(e.time)}</time>${escapeHtml(e.text)}</li>`).join('')}</ol>`;
  }
  html += `
    <details class="how"><summary>How ${escapeHtml(first)} validates a strategy</summary>
      <ol>
        <li>Reads the market's condition (trend, range, squeeze, volatility) and generates strategy ideas that suit it: breakouts, pullbacks, mean reversion, squeezes, VWAP and momentum, on 1 to 15-minute charts, with stops, targets and trailing exits.</li>
        <li>Backtests every idea on the first 60% of the history with realistic spread, slippage and commission, the same news blackouts and the same trade management the desk uses live.</li>
        <li>The best few are tested once on the next 25%, which the search never saw. They must stay profitable and keep most of their edge.</li>
        <li>Robustness: nearby settings must also work, it must survive double trading costs, and a Monte Carlo reshuffle must stay profitable with a tolerable drawdown.</li>
        <li>A final holdout (the last 15%) is looked at once. On all unseen data together, the edge must be statistically significant over at least 20 trades.</li>
        <li>New strategies trade at half size until they prove themselves live, and are retired automatically if they stop working.</li>
      </ol>
      <p>Tested on 200 runs of pure random data (where no edge exists), this process wrongly accepted a strategy 5 times (2.5%), and probation plus the live kill-switch are there to catch those. No process can promise winners; this one makes it hard to fool ourselves.</p>
    </details>
    <button class="btn" data-act="research" ${R.researching ? 'disabled' : ''} style="margin-top:8px">Research now</button>`;
  return html;
}
