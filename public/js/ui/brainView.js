import { money, escapeHtml, initials, nyTime, signClass } from '../format.js';
import { api } from '../net.js';
import { planSwitches, onPlanSwitch } from './planSwitch.js';
import { MemoryGraph } from './memoryGraph.js';
import { NeuralBrain3D } from './neuralBrain.js';

// The Brain: how the floor thinks. At the top, the account brain (the plan that protects
// the prop account) and which desks have earned real money. Then the neural brain every desk
// asks before a trade, live in 3D, and the floor's memory. Below, one live graph per
// department: market evidence → each agent's own brain → the department's call, with the
// debates in which they argue every trade before it is taken.

const NODE_KEYS = [
  ['htf', 'Higher TF trend', 'htf'],
  ['trend', '15m trend', 'trend'],
  ['structure', 'Structure', 'structure'],
  ['momentum', 'Momentum', 'momentum'],
  ['vwap', 'VWAP', 'stretch'],
  ['volatility', 'Volatility', 'volatility'],
  ['news', 'News', 'news'],
];

const GREEN = '#2fbf71';
const RED = '#e5534b';
const GREY = '#6b7280';
const fmtR = (x) => (x == null ? '—' : `${x >= 0 ? '+' : '−'}${Math.abs(x).toFixed(2)}R`);
const valColor = (v) => (v > 0.1 ? GREEN : v < -0.1 ? RED : GREY);
const leanArrow = (l) => (l === 'LONG' ? '▲' : l === 'SHORT' ? '▼' : '•');
const stanceCls = { agree: 'ok', cautious: 'warn', disagree: 'no', propose: 'prop' };
const verdictCls = (v) => (/^APPROVED$/.test(v) ? 'ok' : /SMALLER/.test(v) ? 'warn' : /PAPER/.test(v) ? 'paper' : 'no');

export class BrainView {
  constructor(store, root, { onSelect }) {
    this.store = store;
    this.root = root;
    this.onSelect = onSelect;
    this.visible = false;
    this.built = false;
    this.sel = {};
    this.lastRender = 0;
    this.opened = new Set();
    this.closed = new Set();
  }

  #build() {
    this.root.innerHTML = `
      <div class="dash-head"><div><h1>Brain</h1><p class="lede">How the floor thinks. No desk trades on its own say-so: every idea is argued by its department, graded, and only the best reach your account.</p></div></div>
      <div class="grid brain-top">
        <div class="card" id="bv-account"></div>
        <div class="card" id="bv-cleared"></div>
      </div>
      <div class="card mg-card" id="bv-neural"></div>
      <div class="card mg-card" id="bv-memory"></div>
      <div class="card vault-card" id="bv-vault"></div>
      <div class="grid brain-depts" id="bv-depts"></div>
      <div class="card" style="margin-top:14px" id="bv-recent"></div>`;
    this.root.addEventListener('toggle', (e) => {
      const d = e.target.closest?.('details.debate');
      if (!d || this.rendering) return;
      if (d.open) { this.opened.add(d.dataset.id); this.closed.delete(d.dataset.id); } else { this.closed.add(d.dataset.id); this.opened.delete(d.dataset.id); }
    }, true);
    this.root.addEventListener('change', (e) => {
      if (e.target.matches('[data-plan-switch]')) onPlanSwitch(e.target, this.store.live?.plan);
    });
    this.root.addEventListener('click', (e) => {
      const tab = e.target.closest('[data-mkt]');
      if (tab) {
        this.sel[tab.dataset.dept] = tab.dataset.mkt;
        this.render(true);
        return;
      }
      const who = e.target.closest('[data-agent]');
      if (who) this.onSelect(who.dataset.agent, { tab: 'brain' });
      const copy = e.target.closest('[data-act="vault-copy"]');
      if (copy) navigator.clipboard?.writeText(copy.dataset.path).then(() => { copy.textContent = 'Copied'; setTimeout(() => { copy.textContent = 'Copy the folder'; }, 1500); }).catch(() => {});
    });
    this.neural = new NeuralBrain3D(this.store, this.root.querySelector('#bv-neural'), { onSelect: this.onSelect });
    this.memory = new MemoryGraph(this.store, this.root.querySelector('#bv-memory'), { onSelect: this.onSelect });
    this.built = true;
  }

  show() {
    if (!this.built) this.#build();
    this.visible = true;
    this.root.hidden = false;
    this.render(true);
    this.neural.show();
    this.memory.show();
    this.#vault();
  }

  // Where the Obsidian vault is and how to open it.
  async #vault() {
    const el = this.root.querySelector('#bv-vault');
    let v;
    try {
      v = await api('/api/vault');
    } catch {
      return;
    }
    const ago = v.lastWrite ? `${Math.max(0, Math.round((Date.now() - v.lastWrite) / 60_000))} min ago` : 'not yet';
    el.innerHTML = v.enabled ? `<h2>Obsidian vault</h2>
      <p class="sub">Everything the desks know, written live as linked notes: each desk's own journal of the day, what every desk is doing right now, every trade with why it was taken and how it ended, every idea they took or turned down, their wins and losses, the rules they learned, what works and what loses, and the brains' verdicts. It's the same knowledge they trade on.</p>
      <p class="vault-path"><code>${escapeHtml(v.dir)}</code> <button class="btn" data-act="vault-copy" data-path="${escapeHtml(v.dir)}">Copy the folder</button></p>
      <p class="fine">${v.live ? '<span class="pos">● live</span> · ' : ''}${v.notes.toLocaleString('en-US')} notes · last written ${ago}${v.mode === 'sim' ? ' · demo mode has its own vault' : ''}${v.lastError ? ` · <span class="neg">${escapeHtml(v.lastError.text)}</span>` : ''}</p>
      <p class="fine">To open it: install Obsidian (obsidian.md), choose <b>Open folder as vault</b> and pick this folder. Start from <b>Home</b>, and try the graph view (wins green, losses red). Anything you write under "Your notes" in a note stays. To keep the vault somewhere else, set <code>VAULT_DIR</code> in <code>.env</code> (for example <code>VAULT_DIR=~/Meridian Vault</code>; not Desktop, Documents, Downloads or iCloud Drive, which macOS keeps the non-stop service out of).</p>`
      : `<h2>Obsidian vault</h2><p class="sub">Switched off (VAULT=0 in .env).</p>`;
  }

  hide() {
    this.visible = false;
    this.root.hidden = true;
    this.neural?.hide();
    this.memory?.hide();
  }

  render(force = false) {
    if (!this.visible || !this.store.brain) return;
    const now = performance.now();
    if (!force && now - this.lastRender < 900) return;
    this.lastRender = now;
    this.rendering = true;
    // Their own way (FTMO tab): no committee argues the desks' ideas.
    const lede = this.root.querySelector('.dash-head .lede');
    const text = this.store.live?.ownWay
      ? 'How the floor thinks. The desks trade their own way: each takes its own strategy\'s signals, and no committee argues them. Below: what each desk reads in its market, the neural brain learning from every trade, and the floor\'s memory.'
      : 'How the floor thinks. No desk trades on its own say-so: every idea is argued by its department, graded, and only the best reach your account.';
    if (lede && lede.textContent !== text) lede.textContent = text;
    this.#renderAccount();
    this.#renderCleared();
    this.#renderDepts();
    this.#renderRecent();
    setTimeout(() => { this.rendering = false; }, 0);
  }

  // ---- account brain ------------------------------------------------------------------------
  #renderAccount() {
    const el = this.root.querySelector('#bv-account');
    const plan = this.store.live?.plan;
    if (!plan && this.store.live?.ownWay) {
      el.innerHTML = `<h2>Account brain</h2>
        <p class="sub">The desks trade their own way. It switches on when MT5 connects and the account is set up in the FTMO tab.</p>
        <ul class="plan-rules">
          <li class="ok">Each desk takes its own strategy's signals, with its own stops and targets</li>
          <li class="ok">Your risk per trade on every trade</li>
          <li class="ok">Every order carries its stop-loss</li>
          <li class="ok">FTMO's loss guard closes everything near FTMO's limits</li>
        </ul>`;
      return;
    }
    if (!plan) {
      el.innerHTML = `<h2>Account brain</h2>
        <p class="sub">The plan that protects your prop account. It switches on when MT5 connects and the account is set up in the FTMO tab.</p>
        <ul class="plan-rules">
          <li class="ok">Only committee A-grade trades, from desks with a proven edge</li>
          <li class="ok">Risk shrinks in drawdown and after losses, never grows past your base risk</li>
          <li class="ok">Daily stop at −1.5% (FTMO allows 5%), at most 6 trades a day, done after 3 losses in a row</li>
          <li class="ok">One position per correlated group, flat before high-impact news</li>
          <li class="ok">Near the target, smaller risk so one loss can't undo the progress; lighter risk when funded</li>
        </ul>`;
      return;
    }
    const st = plan.status;
    const stCls = st === 'NORMAL' ? 'ok' : st === 'CAUTIOUS' ? 'warn' : 'no';
    el.innerHTML = `
      <div class="plan-head"><div><h2>Account brain · ${escapeHtml(plan.phase)}</h2><p class="sub">${escapeHtml(plan.goal)}</p></div><span class="plan-status ${stCls}">${escapeHtml(st)}</span></div>
      ${plan.blocked ? `<div class="banner crit">⛔ ${escapeHtml(plan.blocked)}.</div>` : ''}
      ${planSwitches(plan)}
      <div class="mini-tiles">
        <div><span>Equity</span><b class="num">${money(plan.equity)}</b></div>
        <div><span>From start</span><b class="num ${signClass(plan.profit)}">${money(plan.profit, { sign: true })}</b></div>
        <div><span>Today</span><b class="num ${signClass(plan.dayPnl)}">${money(plan.dayPnl, { sign: true })}</b></div>
        <div><span>Risk per trade now</span><b class="num">${plan.riskPct.toFixed(2)}% · ${money(plan.riskMoney)}</b></div>
      </div>
      ${plan.reasons.length ? `<ul class="plan-why">${plan.reasons.map((r) => `<li>${escapeHtml(r)}</li>`).join('')}</ul>` : '<p class="fine">Risk is at your base setting: no drawdown, no losing streak, room left today.</p>'}
      <p class="fine">${plan.winsToTarget ? `About <b>${plan.winsToTarget}</b> clean 2R winners from the target at this risk · ` : ''}Trading days: ${plan.tradingDays}${plan.minTradingDays ? ` (FTMO asks for at least ${plan.minTradingDays})` : ''} · losing streak: ${plan.streak} · trades today: ${plan.tradesToday} of ${plan.maxTradesPerDay}</p>
      <ul class="plan-rules">${plan.rules.map((r) => `<li class="${r.ok ? 'ok' : 'warn'}">${escapeHtml(r.text)}</li>`).join('')}</ul>`;
  }

  // Which desks have earned real money, and which are proving themselves on paper.
  #renderCleared() {
    const b = this.store.brain;
    const s = this.store;
    const rows = s.profiles.map((p) => ({ p, e: b.edges?.[p.id] })).filter((x) => x.e);
    const cleared = rows.filter((x) => x.e.proven).sort((x, y) => y.e.e - x.e.e);
    const paper = rows.filter((x) => !x.e.proven && !x.e.bookManaged).sort((x, y) => y.e.e - x.e.e);
    const chip = ({ p, e }) => `<button class="edge-chip" data-agent="${p.id}" title="${escapeHtml(e.text)}"><i style="background:${p.accent}"></i>${escapeHtml(p.name.split(' ')[0])}<b class="${e.e > 0 ? 'pos' : e.e < 0 ? 'neg' : ''}">${e.n ? fmtR(e.e) : 'new'}</b></button>`;
    const st = b.stats || {};
    this.root.querySelector('#bv-cleared').innerHTML = `
      <h2>Who has earned real money</h2>
      <p class="sub">A desk reaches your account only with a positive measured edge (its real track record, shrunk toward zero until there's enough of it) or a validated research strategy. Everyone else proves themselves on paper first.</p>
      <h3>Cleared for the account</h3>
      <div class="edge-chips">${cleared.map(chip).join('') || '<span class="muted">Nobody yet: the desks need a positive record first.</span>'}</div>
      <h3>Proving themselves on paper</h3>
      <div class="edge-chips">${paper.map(chip).join('') || '<span class="muted">—</span>'}</div>
      <h3>Committee so far</h3>
      <div class="mini-tiles">
        <div><span>Ideas reviewed</span><b class="num">${st.reviewed || 0}</b></div>
        <div><span>A-grade</span><b class="num pos">${st.approved || 0}</b></div>
        <div><span>B · C (paper)</span><b class="num">${(st.reduced || 0) + (st.paper || 0)}</b></div>
        <div><span>Vetoed</span><b class="num neg">${st.rejected || 0}</b></div>
      </div>`;
  }

  // ---- department graphs --------------------------------------------------------------------
  #renderDepts() {
    const b = this.store.brain;
    const html = b.departments.map((d) => this.#dept(d, b)).join('');
    this.root.querySelector('#bv-depts').innerHTML = html;
  }

  #dept(d, b) {
    const s = this.store;
    const last = d.debates[0];
    const sym = this.sel[d.id] && d.markets[this.sel[d.id]] ? this.sel[d.id] : last && d.markets[last.symbol] ? last.symbol : Object.keys(d.markets)[0];
    const m = d.markets[sym];
    const tabs = Object.keys(d.markets).map((k) => {
      const c = d.markets[k].consensus;
      return `<button class="mkt-tab ${k === sym ? 'on' : ''}" data-dept="${d.id}" data-mkt="${k}">${k}<span class="call ${c.call.toLowerCase()}">${c.call}</span></button>`;
    }).join('');
    const fresh = last && b.now - last.time < 8 * 60_000 && last.symbol === sym ? last : null;
    const thoughts = d.members.map((id) => {
      const p = s.profileById[id];
      const t = m.thoughts[id];
      const own = d.own[id];
      return `<li data-agent="${id}"><span class="av" style="background:${p.accent}">${initials(p.name)}</span>
        <div><b>${escapeHtml(p.name.split(' ')[0])}</b> <span class="lean ${t.lean.toLowerCase()}">${leanArrow(t.lean)} ${t.lean === 'NEUTRAL' ? 'no edge' : t.lean.toLowerCase()}</span> <small class="muted">${escapeHtml(b.styles[id]?.label || '')}</small>
        <p>${escapeHtml(t.text.replace(`${sym}: `, ''))}</p>${own?.stage && own.symbol === sym ? `<p class="stage-line">${escapeHtml(own.stage)}</p>` : ''}</div></li>`;
    }).join('');
    return `<div class="card dept-card">
      <div class="dept-head"><h2>${escapeHtml(d.name)}</h2><div class="mkt-tabs">${tabs}</div></div>
      ${this.#graph(d, m, sym, fresh, b)}
      <ul class="thoughts">${thoughts}</ul>
      ${d.debates.length ? `<h3>Debates</h3>${d.debates.slice(0, 3).map((x, i) => this.#debate(x, i === 0)).join('')}` : '<p class="fine">No trade ideas yet. Every idea from this department is debated here before it trades.</p>'}
    </div>`;
  }

  #graph(d, m, sym, fresh, b) {
    const W = 600;
    const H = 260;
    const nodes = m.nodes;
    const fx = 118;
    const ax = 330;
    const dx = 520;
    const dy = H / 2;
    const fy = (i) => 26 + i * 34;
    const members = d.members;
    const ay = (i) => (members.length === 1 ? dy : 34 + (i * (H - 68)) / (members.length - 1));
    const s = this.store;
    let edges = '';
    let fnodes = '';
    NODE_KEYS.forEach(([k, label, wk], i) => {
      const n = nodes?.[k];
      const v = n ? (n.neutral ? (k === 'volatility' ? (n.value >= 0.93 || n.value <= 0.07 ? -1 : 0) : n.value) : n.value) : 0;
      const col = n?.neutral ? (v < 0 ? RED : GREY) : valColor(v);
      members.forEach((id, j) => {
        const w = b.styles[id]?.w?.[wk] ?? 0.5;
        const op = Math.min(0.75, 0.06 + 0.45 * (w / 1.8) * Math.max(0.15, Math.abs(v)));
        edges += `<path d="M${fx + 10},${fy(i)} C${fx + 110},${fy(i)} ${ax - 110},${ay(j)} ${ax - 22},${ay(j)}" stroke="${col}" stroke-opacity="${op.toFixed(2)}" stroke-width="${(0.6 + w * 0.9).toFixed(1)}" fill="none"/>`;
      });
      const r = 7 + Math.abs(v) * 5;
      fnodes += `<g class="fnode"><title>${escapeHtml(n?.text || label)}</title><circle cx="${fx}" cy="${fy(i)}" r="${r.toFixed(1)}" fill="${col}" fill-opacity="${(0.35 + 0.6 * Math.abs(v)).toFixed(2)}"/><text x="${fx - 16}" y="${fy(i) + 4}" text-anchor="end">${label}</text></g>`;
    });
    const c = m.consensus;
    const cCol = c.call === 'BUY' ? GREEN : c.call === 'SELL' ? RED : GREY;
    let anodes = '';
    members.forEach((id, j) => {
      const p = s.profileById[id];
      const t = m.thoughts[id];
      const col = t.lean === 'LONG' ? GREEN : t.lean === 'SHORT' ? RED : GREY;
      edges += `<path d="M${ax + 22},${ay(j)} C${ax + 90},${ay(j)} ${dx - 90},${dy} ${dx - 40},${dy}" stroke="${col}" stroke-opacity="${(0.25 + Math.min(0.7, Math.abs(t.score) * 1.4)).toFixed(2)}" stroke-width="${(1 + Math.abs(t.score) * 7).toFixed(1)}" fill="none"/>`;
      anodes += `<g class="anode" data-agent="${id}"><title>${escapeHtml(t.text)}</title><circle cx="${ax}" cy="${ay(j)}" r="21" fill="${p.accent}"/><circle cx="${ax}" cy="${ay(j)}" r="24" fill="none" stroke="${col}" stroke-width="2.5"/><text x="${ax}" y="${ay(j) + 4}" text-anchor="middle" class="ini">${initials(p.name)}</text><text x="${ax + 30}" y="${ay(j) - 6}" class="nm">${escapeHtml(p.name.split(' ')[0])} ${leanArrow(t.lean)}</text></g>`;
    });
    // Live debate: the proposer talks to each reviewer.
    let talk = '';
    if (fresh) {
      const pi = members.indexOf(fresh.proposer);
      for (const msg of fresh.messages.filter((x) => x.role === 'reviews')) {
        const ri = members.indexOf(msg.from);
        if (pi < 0 || ri < 0) continue;
        const y1 = ay(pi);
        const y2 = ay(ri);
        const col = msg.stance === 'agree' ? GREEN : msg.stance === 'disagree' ? RED : '#e3b341';
        talk += `<path class="talk" d="M${ax - 24},${y1} C${ax - 90},${y1} ${ax - 90},${y2} ${ax - 24},${y2}" stroke="${col}" stroke-width="2.2" fill="none"/>`;
      }
    }
    const dnode = `<g class="dnode ${fresh ? 'fresh' : ''}"><circle cx="${dx}" cy="${dy}" r="40" fill="${cCol}" fill-opacity="0.18" stroke="${cCol}" stroke-width="2"/><text x="${dx}" y="${dy + 5}" text-anchor="middle" class="call">${c.call}</text><text x="${dx}" y="${dy + 58}" text-anchor="middle" class="sub">${sym} · ${c.longs} long · ${c.shorts} short</text></g>`;
    return `<svg class="brain-graph" viewBox="0 0 ${W} ${H}" preserveAspectRatio="xMidYMid meet" role="img" aria-label="${escapeHtml(d.name)} brain for ${sym}">${edges}${talk}${fnodes}${anodes}${dnode}
      <text x="${fx - 90}" y="${H - 4}" class="axis">market evidence</text><text x="${ax - 20}" y="${H - 4}" class="axis">each agent's brain</text><text x="${dx - 38}" y="${H - 4}" class="axis">department call</text></svg>`;
  }

  #debate(x, first) {
    const s = this.store;
    const who = (id) => s.profileById[id]?.name.split(' ')[0] ?? id;
    const open = this.opened.has(x.id) || (first && !this.closed.has(x.id));
    return `<details class="debate" data-id="${escapeHtml(x.id)}" ${open ? 'open' : ''}>
      <summary><span class="verdict ${verdictCls(x.verdict)}">${escapeHtml(x.verdict)}${x.grade && x.grade !== '—' ? ` · ${x.grade}` : ''}</span> <b>${escapeHtml(who(x.proposer))}</b> ${x.side === 'LONG' ? 'buy' : 'sell'} ${x.symbol} <span class="muted">${nyTime(x.time)} · score ${x.score.toFixed(2)}</span></summary>
      <ol class="msgs">${x.messages.map((mm) => {
        const p = s.profileById[mm.from];
        return `<li class="${stanceCls[mm.stance] || ''}"><span class="av sm" style="background:${p?.accent ?? '#555'}">${initials(p?.name ?? mm.from)}</span><div><b>${escapeHtml(who(mm.from))}</b>${mm.role === 'decides' ? ' <small class="muted">risk</small>' : ''}<p>${escapeHtml(mm.text)}</p></div></li>`;
      }).join('')}</ol>
    </details>`;
  }

  #renderRecent() {
    const b = this.store.brain;
    const s = this.store;
    const who = (id) => s.profileById[id]?.name ?? id;
    this.root.querySelector('#bv-recent').innerHTML = `<h2>Latest decisions across the floor</h2>
      <p class="sub">${s.live?.ownWay
        ? 'The desks trade their own way, so no committee decides on new ideas. These are its last decisions from before.'
        : 'A: full size. B: smaller. C: the smallest size (paper only, or the Free Trial while training). Vetoed: never traded.'}</p>
      <div class="table-wrap"><table class="table compact"><thead><tr><th>Time</th><th>Desk</th><th>Idea</th><th>Decision</th><th class="r">Score</th><th>Why</th></tr></thead><tbody>${
        (b.recent || []).map((x) => `<tr class="clickable" data-agent="${x.proposer}"><td>${nyTime(x.time)}</td><td>${escapeHtml(who(x.proposer))}</td><td>${x.side === 'LONG' ? 'Buy' : 'Sell'} ${x.symbol}</td><td><span class="verdict ${verdictCls(x.verdict)}">${escapeHtml(x.verdict)}${x.grade && x.grade !== '—' ? ` · ${x.grade}` : ''}</span></td><td class="r num">${x.score.toFixed(2)}</td><td class="muted">${escapeHtml(x.why)}</td></tr>`).join('') ||
        '<tr><td colspan="6" class="muted">No trade ideas yet.</td></tr>'
      }</tbody></table></div>`;
  }
}

// One agent's own brain, for the agent panel.
export function agentBrainTab(B, p, edge) {
  if (!B) return '<p class="muted">The brain is off.</p>';
  const first = p.name.split(' ')[0];
  const t = B.thought;
  const bars = B.factors.map((f) => {
    const side = t.lean === 'SHORT' ? f.short : f.long;
    const c = side * f.weight;
    const w = Math.min(50, Math.abs(c) * 30);
    return `<div class="fbar"><span class="fl" title="${escapeHtml(f.text || '')}">${escapeHtml(labelOf(f.k))}<small>×${f.weight}</small></span>
      <div class="ft"><i class="${c >= 0 ? 'p' : 'n'}" style="width:${w}%;${c >= 0 ? 'left:50%' : `right:50%`}"></i><span class="z"></span></div>
      <span class="fx">${escapeHtml(f.text || '')}</span></div>`;
  }).join('');
  const debates = B.debates.map((d) => `<li><b>${d.proposer === p.id ? 'Proposed' : 'Reviewed'}</b> ${d.side === 'LONG' ? 'buy' : 'sell'} ${d.symbol}: <span class="verdict ${verdictCls(d.verdict)}">${escapeHtml(d.verdict)}${d.grade !== '—' ? ` · ${d.grade}` : ''}</span><p>${escapeHtml((d.messages.find((m) => m.from === p.id) || d.messages[0]).text)}</p></li>`).join('');
  return `
    <div class="learn-strip">
      <div><span>Style</span><b>${escapeHtml(B.style)}</b></div>
      <div><span>Leaning on ${B.symbol}</span><b class="lean ${t.lean.toLowerCase()}">${leanArrow(t.lean)} ${t.lean === 'NEUTRAL' ? 'no edge' : t.lean.toLowerCase()}</b></div>
      <div><span>Measured edge</span><b class="num ${edge?.e > 0 ? 'pos' : edge?.e < 0 ? 'neg' : ''}">${edge?.n ? fmtR(edge.e) : 'new'}</b></div>
    </div>
    <p class="thesis" style="margin-top:10px">${escapeHtml(t.text)}</p>
    <h3>What ${escapeHtml(first)}'s brain weighs${t.lean === 'SHORT' ? ' (for a short)' : ' (for a long)'}</h3>
    <div class="fbars">${bars}</div>
    <p class="fine">Green pushes toward the trade, red against it; the multiplier is how much ${escapeHtml(first)}, as a ${escapeHtml(B.style)}, cares about it. ${edge ? escapeHtml(cap(edge.text)) + '.' : ''} ${edge?.proven ? `${escapeHtml(first)} is cleared to trade your account.` : edge?.bookManaged ? 'This book is paper only.' : `${escapeHtml(first)} proves itself on paper before any real money.`}</p>
    <h3>Debates</h3>
    ${debates ? `<ul class="brain-debates">${debates}</ul>` : '<p class="fine">No debates yet.</p>'}`;
}

const LABELS = {
  edge: 'Measured edge', htf: 'Higher TF trend', trend: '15m trend', structure: 'Structure', momentum: 'Momentum', stretch: 'VWAP distance',
  location: 'Level behind', room: 'Room to target', volatility: 'Volatility', news: 'News', research: 'Regime',
};
const labelOf = (k) => LABELS[k] || k;
const cap = (x) => x.charAt(0).toUpperCase() + x.slice(1);
