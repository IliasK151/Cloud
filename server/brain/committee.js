import { EventEmitter } from 'node:events';
import { SYMBOLS } from '../market/symbols.js';
import { volText } from './market.js';
import { opinion, say, thesisLine, researchFactor, styleKey, styleOf, FACTORS } from './personas.js';

// The investment committee. No desk trades on its own say-so: every trade idea is put to
// the department that covers that market. The desk states its thesis, two colleagues give
// their honest opinion from their own brain, and the head of research checks the risk.
// Hard vetoes (no room to the target, fighting both trends, extreme volatility, a reward
// smaller than the risk) end the discussion. Otherwise the votes are scored and the trade
// is graded: A trades at full size, B smaller, C only tiny on paper to keep measuring.
// Only A-grade trades go to the prop account (see live/accountBrain.js).

export const DEPARTMENTS = [
  { id: 'indices', name: 'Equity Indices', markets: ['NAS100', 'SPX500'], members: ['marcus', 'james', 'arjun', 'nico'] },
  { id: 'fx', name: 'FX & Macro', markets: ['EURUSD', 'GBPUSD', 'USDJPY'], members: ['sofia', 'priya', 'hannah', 'jake', 'layla'] },
  { id: 'commodities', name: 'Metals & Energy', markets: ['XAUUSD', 'USOIL'], members: ['amara', 'lucas', 'omar', 'ryan', 'mia'] },
  { id: 'crypto', name: 'Digital Assets', markets: ['BTCUSD', 'ETHUSD', 'SOLUSD'], members: ['viktor', 'isabella', 'kenji', 'chen', 'mei'] },
];
export const CHAIR = 'elena';

export const GRADES = { A: 0.35, B: 0.15 };
// C: the committee isn't convinced. It trades tiny on paper only, so the desk keeps
// measuring (and can earn its way back); it never goes to the prop account.
const SIZE = { A: 1, B: 0.6, C: 0.25 };
const REJECT_MEMORY_MS = 10 * 60_000;
const DEBATES_KEPT = 14;

const clamp = (x, lo = -1, hi = 1) => Math.max(lo, Math.min(hi, x));
const cap = (s) => s.charAt(0).toUpperCase() + s.slice(1);

export function departmentFor(symbol) {
  return DEPARTMENTS.find((d) => d.markets.includes(symbol)) || null;
}

export class Committee extends EventEmitter {
  constructor({ brain, agents, clock, shadow = false, memory = null }) {
    super();
    this.brain = brain;
    this.memory = memory; // the floor's shared memory: how trades like this went, floor-wide
    this.agents = agents; // Map id → agent
    this.clock = clock;
    this.shadow = shadow; // score every idea but never block (for research/calibration)
    this.debates = [];
    this.byDept = new Map(DEPARTMENTS.map((d) => [d.id, []]));
    this.rejected = new Map();
    this.seq = 0;
    this.stats = { reviewed: 0, approved: 0, reduced: 0, paper: 0, rejected: 0 };
  }

  // The proposing desk's measured edge: its real, shrunk track record (overall, recent form
  // and in this kind of situation), or for a research desk its validated expectation
  // blended with its live results. No record means no edge yet.
  //
  // With live market data only real evidence counts: trades on real prices, and research
  // validated on real history. A market running on a simulated stand-in (its feed is down)
  // proves nothing about the real one.
  edge(agent, symbol, side) {
    const fmtR = (x) => `${x >= 0 ? '+' : '−'}${Math.abs(x).toFixed(2)}R`;
    if (!agent) return { value: 0, e: 0, n: 0, text: 'no track record' };
    const realOnly = this.clock?.mode === 'live';
    if (agent.profile.lab) {
      const act = agent.active;
      if (!act || act.symbol !== symbol) return { value: 0, e: 0, n: 0, text: 'no validated strategy on this market' };
      if (realOnly && !act.real) return { value: 0, e: 0, n: 0, text: `${act.name} was validated on simulated history only; it has to pass again on real data` };
      const u = act.stats.unseen;
      const l = act.live;
      const trades = realOnly ? l.realTrades || 0 : l.trades;
      const sumR = realOnly ? l.realSumR || 0 : l.sumR;
      const e = (u.avgR * 20 + sumR) / (20 + trades);
      return { value: clamp(e / 0.25), e, n: u.n + trades, text: `the validated ${act.name} made ${fmtR(u.avgR)} per trade on unseen data${trades ? ` and ${fmtR(sumR)} over ${trades} live trade${trades === 1 ? '' : 's'}` : ''}` };
    }
    const L = agent.lifetime;
    if (realOnly) {
      // The learner's blend is left out here: it may still hold lessons from before the
      // real-only record existed.
      const n = L.realN || 0;
      const e = (L.realSumR || 0) / (n + 15);
      const text = n < 5 ? `the desk has no real track record yet (${n} trade${n === 1 ? '' : 's'} on real prices)` : `the desk's record is ${fmtR(L.realSumR / n)} per trade over ${n} trades on real prices`;
      return { value: clamp(e / 0.15), e, n, text };
    }
    const n = L.countR;
    let e = L.sumR / (n + 15);
    const ln = agent.learner;
    if (ln?.enabled) {
      const form = ln.form();
      if (form.n >= 8) e = (e + form.mean) / 2;
      const ctx = ln.context(symbol, side);
      const sits = ['trend', 'vol', 'session'].map((k) => ln.stat(`${k}:${ctx[k]}`)).filter((st) => st.n >= 5);
      if (sits.length) e = 0.7 * e + 0.3 * (sits.reduce((sum, st) => sum + st.mean, 0) / sits.length);
    }
    const text = n < 5 ? `the desk has no real track record yet (${n} trade${n === 1 ? '' : 's'})` : `the desk's record is ${fmtR(L.sumR / n)} per trade over ${n} trades`;
    return { value: clamp(e / 0.15), e, n, text };
  }

  // Everything each member of the committee needs, signed in the trade's favour.
  #factors(symbol, side, levels, proposerId) {
    const a = this.brain.assess(symbol, side, levels);
    if (!a) return null;
    const style = styleKey(proposerId);
    // Only a research desk's own trade can cite its validated strategy.
    const ag = this.agents.get(proposerId);
    const validated = ag?.profile.lab && ag.active?.symbol === symbol && (this.clock?.mode !== 'live' || ag.active.real) ? ag.active.name : null;
    a.f.research = researchFactor(a.read.regime, a.dir, style, validated);
    const ed = this.edge(ag, symbol, side);
    a.f.edge = { value: ed.value, text: ed.text };
    a.edge = ed;
    // The floor's memory speaks only once it has seen enough trades like this one.
    const mem = this.memory && ag?.learner ? this.memory.recall(symbol, ag.learner.context(symbol, side)) : null;
    if (mem?.ready) a.f.memory = { value: mem.value, text: mem.text };
    if (style === 'scalper') this.#scalpTerms(a, symbol);
    return a;
  }

  // A scalp is judged on scalping terms. Its target is the liquidity on the other side, and
  // the small 5- and 15-minute swings on the way are the stops it trades through, so room is
  // measured to that target. And a run of liquidity is a volatility burst by definition, so
  // high volatility is the setup, not a strike against it. (On real history the committee's
  // swing-trade view graded every gold and EURUSD scalp C, including the winners.)
  #scalpTerms(a, symbol) {
    const dec = SYMBOLS[symbol]?.decimals ?? 2;
    if (a.rr != null) {
      const v = a.rr >= 2 ? 0.5 : a.rr >= 1.5 ? 0.2 : -0.5;
      a.f.room = { value: v, text: `the scalp targets liquidity ${a.rr.toFixed(1)}R away at ${Number(a.target).toFixed(dec)}` };
    }
    if (a.read.volPct >= 0.93) a.f.volatility = { value: 0.1, text: `volatility is high (${volText(a.read)}): that's when liquidity runs happen` };
  }

  #reviewers(proposer, symbol) {
    const dept = departmentFor(symbol);
    const pool = (dept?.members || []).filter((id) => id !== proposer.id && this.agents.get(id));
    const lab = pool.filter((id) => this.agents.get(id).profile.lab);
    // Scalpers review scalps; a trading desk's idea goes to the department's other desks.
    const traders = pool.filter((id) => !this.agents.get(id).profile.lab && (proposer.profile.scalper || !this.agents.get(id).profile.scalper));
    traders.sort((x, y) => (this.agents.get(y).symbols.includes(symbol) ? 1 : 0) - (this.agents.get(x).symbols.includes(symbol) ? 1 : 0));
    return [...lab.slice(0, 1), ...traders].slice(0, 2);
  }

  // Hard stops, kept only where the evidence backs them (tested on 956 simulated trades:
  // entries shortly before news averaged -0.30R, in extreme volatility -0.24R and in a
  // dead-quiet market -0.21R, against -0.05R for everything else), plus basic arithmetic.
  //
  // "Extreme" volatility is measured against the same time of day on earlier days (see
  // volPercentile in market.js), so the London and New York opens aren't extreme by default.
  //
  // Liquidity scalpers are exempt from the extreme-volatility veto: a run of liquidity is a
  // volatility burst by definition, and on real history (scripts/scalp-test.js) the scalps
  // this veto would have stopped did better than the rest, not worse.
  #vetoes(a, proposerId = null) {
    const out = [];
    const r = a.read;
    if (r.news && r.news.minutes <= (r.news.impact === 'high' ? 45 : 20)) out.push(`${r.news.label} is due in ${r.news.minutes} minutes`);
    if (r.volPct >= 0.93 && styleKey(proposerId) !== 'scalper') out.push(`volatility is extreme (${volText(r)})`);
    if (r.volPct <= 0.07) out.push('the market is dead quiet, costs eat small moves');
    if (a.rr != null && a.rr < 0.9) out.push(`the target is only ${a.rr.toFixed(1)}R, less than the risk`);
    return out;
  }

  // Put a trade idea to the committee. Returns { ok, sizeMult, grade, score, thesis, reason, debate }.
  review({ agent, symbol, side, entry, stop, target = null, reason = '', external = false }) {
    const noPaper = !!agent.env?.ftmoOnly?.();
    const now = this.clock.now();
    const memKey = `${agent.id}|${symbol}|${side}`;
    const mem = this.rejected.get(memKey);
    if (!this.shadow && mem && now - mem.at < REJECT_MEMORY_MS) {
      return { ok: false, silent: true, sizeMult: 0, grade: '—', score: mem.score, reason: mem.reason, thesis: '' };
    }
    const a = this.#factors(symbol, side, { entry, stop, target }, agent.id);
    if (!a) {
      return { ok: true, sizeMult: 0.5, grade: 'B', score: 0, thesis: `${cap(reason || 'Setup')}. Not enough history for a full review, so half size.`, reason: 'not enough history to review' };
    }
    this.stats.reviewed++;
    const dec = SYMBOLS[symbol]?.decimals ?? 2;
    const fmt = (x) => Number(x).toFixed(dec);
    const seed = ++this.seq;

    // The desk's own case.
    const own = opinion(agent.id, a.f);
    const conf = clamp(((agent.setup?.confidence ?? 55) - 50) / 40);
    const proposerScore = clamp(0.6 * own.score + 0.4 * conf);
    const thesis = thesisLine({ reason }, own);
    const verb = side === 'LONG' ? 'Buy' : 'Sell';
    const messages = [{
      from: agent.id, role: 'proposes', stance: 'propose', score: proposerScore,
      text: `${verb} ${symbol} at ${fmt(a.entry)}, stop ${fmt(stop)}${target != null ? `, target ${fmt(target)} (${a.rr.toFixed(1)}R)` : ', trailing exit'}. ${thesis}`,
    }];

    // Colleagues' honest opinions.
    const votes = [];
    const said = new Set();
    for (const id of this.#reviewers(agent, symbol)) {
      const op = opinion(id, a.f);
      votes.push({ id, score: op.score, stance: op.stance });
      messages.push({ from: id, role: 'reviews', stance: op.stance, score: op.score, text: say(op, seed + id.length, said) });
    }

    // The head of research signs off on risk.
    const vetoes = this.#vetoes(a, agent.id);
    const chairOp = opinion(CHAIR, a.f);
    if (agent.id !== CHAIR) votes.push({ id: CHAIR, score: chairOp.score, stance: chairOp.stance, chair: true });
    const reviewAvg = votes.length ? votes.reduce((s, v) => s + v.score, 0) / votes.length : proposerScore;
    // The measured edge counts most; opinions and the desk's own conviction refine it.
    const score = clamp(0.45 * a.edge.value + 0.35 * reviewAvg + 0.2 * proposerScore);

    let verdict;
    let grade;
    let why;
    if (vetoes.length) {
      verdict = 'REJECTED';
      grade = '—';
      why = vetoes[0];
    } else if (score >= GRADES.A) {
      verdict = 'APPROVED';
      grade = 'A';
      why = 'strong agreement';
    } else if (score >= GRADES.B) {
      verdict = 'APPROVED · SMALLER';
      grade = 'B';
      why = 'mixed evidence, so smaller size';
    } else {
      // FTMO only (live/liveTrader.js): there's no paper. A C-grade goes to the Free Trial at the
      // smallest size while training, and isn't taken on a paid account.
      verdict = noPaper ? 'NOT CONVINCED' : 'PAPER ONLY';
      grade = 'C';
      const worst = FACTORS.map((k) => ({ k, v: a.f[k]?.value ?? 0, t: a.f[k]?.text })).sort((x, y) => x.v - y.v)[0];
      why = `not convinced (${worst?.t || 'weak evidence'}): ${noPaper ? 'the smallest size, and only while training on the Free Trial' : 'tiny size on paper to keep measuring'}`;
    }
    const rest = cap(say(chairOp, seed, said).replace(/^[^:]+: /, ''));
    const chairText = vetoes.length
      ? `Vetoed: ${vetoes.join('; ')}.`
      : grade === 'C'
        ? `Not good enough for real money (score ${score.toFixed(2)}). ${noPaper ? 'Quarter size, and only while training on the Free Trial' : 'Paper only, quarter size, so we keep measuring'}. ${rest}`
        : `${grade === 'A' ? 'Approved, full size' : 'Approved at reduced size'} (score ${score.toFixed(2)}). ${rest}`;
    messages.push({ from: CHAIR, role: 'decides', stance: vetoes.length || grade === 'C' ? 'disagree' : grade === 'A' ? 'agree' : 'cautious', score: chairOp.score, text: chairText });

    const ok = this.shadow || verdict !== 'REJECTED';
    const sizeMult = this.shadow ? 1 : ok ? SIZE[grade] : 0;
    const dept = departmentFor(symbol);
    const debate = {
      id: `${now}-${seed}`, time: now, dept: dept?.id ?? null, symbol, side, proposer: agent.id, external,
      entry: a.entry, stop, target, rr: a.rr, roomR: a.roomR, thesis, messages, verdict, grade, score, sizeMult, why,
      factors: Object.fromEntries(FACTORS.map((k) => [k, a.f[k] ? { value: a.f[k].value, text: a.f[k].text } : null])),
    };
    this.#record(debate);
    if (verdict === 'REJECTED') {
      this.stats.rejected++;
      this.rejected.set(memKey, { at: now, reason: why, score });
    } else if (grade === 'A') this.stats.approved++;
    else if (grade === 'B') this.stats.reduced++;
    else this.stats.paper = (this.stats.paper || 0) + 1;
    return { ok, sizeMult, grade, score, thesis, reason: why, debate, shadowVerdict: verdict };
  }

  #record(debate) {
    this.debates.push(debate);
    if (this.debates.length > 60) this.debates.shift();
    if (debate.dept) {
      const list = this.byDept.get(debate.dept);
      list.push(debate);
      if (list.length > DEBATES_KEPT) list.shift();
    }
    this.emit('debate', debate);
  }

  // ---- the live brain: what every agent thinks right now ------------------------------------
  // Their lean on a market: their own opinion of buying it against their opinion of selling it.
  thought(agentId, symbol) {
    const L = this.#factors(symbol, 'LONG', {}, agentId);
    const S = this.#factors(symbol, 'SHORT', {}, agentId);
    if (!L || !S) return { symbol, lean: 'NEUTRAL', score: 0, long: 0, short: 0, text: `${symbol}: waiting for enough data.` };
    const ol = opinion(agentId, L.f);
    const os = opinion(agentId, S.f);
    const d = (ol.score - os.score) / 2;
    const lean = d > 0.15 ? 'LONG' : d < -0.15 ? 'SHORT' : 'NEUTRAL';
    let text;
    if (lean === 'NEUTRAL') {
      const why = [ol.cons[0]?.text, os.cons[0]?.text].filter(Boolean);
      text = `${symbol}: no edge either way${why.length ? ` (${why.join('; ')})` : ''}.`;
    } else {
      const op = lean === 'LONG' ? ol : os;
      text = `${symbol}: I lean ${lean === 'LONG' ? 'long' : 'short'}: ${op.pros.slice(0, 2).map((p) => p.text).join(' and ')}.${op.cons[0] ? ` Risk: ${op.cons[0].text}.` : ''}`;
    }
    return { symbol, lean, score: d, long: ol.score, short: os.score, text };
  }

  // The market factors as nodes (bullish-signed), for the brain graph.
  nodes(symbol) {
    const r = this.brain.read(symbol);
    if (!r) return null;
    return {
      htf: { value: r.htf.value, text: r.htf.text },
      trend: { value: r.mid.value, text: r.mid.text },
      structure: { value: r.structure.value, text: r.structure.text },
      momentum: { value: r.momentum.value, text: r.momentum.text },
      vwap: { value: clamp(r.z / 2), text: `${r.z >= 0 ? '+' : ''}${r.z.toFixed(1)}σ from VWAP` },
      volatility: { value: r.volPct, text: `volatility ${volText(r)}`, neutral: true },
      news: { value: r.news && r.news.minutes <= 60 ? -1 : 0, text: r.news ? `${r.news.label} in ${r.news.minutes} min` : 'no big news due', neutral: true },
      regime: r.regime?.label || '',
      price: r.price,
    };
  }

  view() {
    const now = this.clock.now();
    const departments = DEPARTMENTS.map((d) => {
      const members = d.members.filter((id) => this.agents.get(id));
      const markets = {};
      for (const sym of d.markets) {
        const thoughts = {};
        let sum = 0;
        let n = 0;
        for (const id of members) {
          const t = this.thought(id, sym);
          thoughts[id] = t;
          sum += t.score;
          n++;
        }
        const bias = n ? sum / n : 0;
        const longs = Object.values(thoughts).filter((t) => t.lean === 'LONG').length;
        const shorts = Object.values(thoughts).filter((t) => t.lean === 'SHORT').length;
        const call = bias > 0.12 && longs > shorts ? 'BUY' : bias < -0.12 && shorts > longs ? 'SELL' : 'WAIT';
        markets[sym] = { nodes: this.nodes(sym), thoughts, consensus: { call, bias, longs, shorts, members: n } };
      }
      // Each member's own market (or the department's first) for their headline thought.
      const own = {};
      for (const id of members) {
        const a = this.agents.get(id);
        const sym = d.markets.includes(a.symbol) ? a.symbol : d.markets[0];
        own[id] = { ...markets[sym].thoughts[id], stage: a.setup?.stage || '', status: a.status() };
      }
      return { id: d.id, name: d.name, markets, members, own, debates: this.byDept.get(d.id).slice(-8).reverse() };
    });
    const chair = this.agents.get(CHAIR);
    const styles = {};
    const edges = {};
    for (const a of this.agents.values()) {
      const st = styleOf(a.id);
      styles[a.id] = { key: styleKey(a.id), label: st.label, w: st.w };
      const bookManaged = !a.profile.lab && a.profile.learning === false;
      const e = this.edge(a, a.symbol, 'LONG');
      edges[a.id] = {
        e: Math.round(e.e * 1000) / 1000, n: e.n, text: e.text, bookManaged,
        proven: !bookManaged && e.e > 0 && (a.profile.lab ? !!a.active : e.n >= 10),
      };
    }
    return {
      now, styles, edges,
      chair: chair ? { id: CHAIR, symbol: chair.symbol, thought: this.thought(CHAIR, chair.symbol), status: chair.status() } : null,
      departments,
      recent: this.debates.slice(-12).reverse(),
      stats: this.stats,
      grades: GRADES,
    };
  }

  // One agent's brain: their weights, and how each factor on their market pushes them.
  agentView(agentId) {
    const a = this.agents.get(agentId);
    if (!a) return null;
    const sym = a.symbol;
    const style = styleOf(agentId);
    const L = this.#factors(sym, 'LONG', {}, agentId);
    const S = this.#factors(sym, 'SHORT', {}, agentId);
    const factors = FACTORS.map((k) => ({
      k, weight: style.w[k],
      long: L?.f[k]?.value ?? 0, short: S?.f[k]?.value ?? 0,
      text: (L?.f[k]?.value ?? 0) >= (S?.f[k]?.value ?? 0) ? L?.f[k]?.text : S?.f[k]?.text,
    }));
    const mine = this.debates.filter((d) => d.proposer === agentId || d.messages.some((m) => m.from === agentId)).slice(-6).reverse();
    return { symbol: sym, style: style.label, thought: this.thought(agentId, sym), factors, debates: mine, department: departmentFor(sym)?.name ?? null };
  }
}
