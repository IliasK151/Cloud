// Every agent's own brain: how much they care about each piece of evidence. Everyone
// weighs the desk's measured edge (its real track record) first and foremost. A trend
// trader lives by the trend and hates fighting it; a mean-reversion trader cares about
// location and hates chasing; a quant weighs the regime and validated research; the head
// of research is the risk hawk. The same market therefore gets genuinely different
// opinions, which is the point of asking.

export const FACTORS = ['edge', 'htf', 'trend', 'structure', 'momentum', 'stretch', 'location', 'room', 'volatility', 'news', 'research'];

export const FACTOR_LABELS = {
  edge: 'Measured edge (track record)', htf: 'Higher-timeframe trend', trend: '15-minute trend', structure: 'Market structure', momentum: 'Momentum',
  stretch: 'Distance from VWAP', location: 'Support / resistance behind', room: 'Room to target',
  volatility: 'Volatility', news: 'News', research: 'Regime & research',
};

export const STYLES = {
  trend: { label: 'trend follower', w: { edge: 1.0, htf: 1.0, trend: 1.2, structure: 0.8, momentum: 0.8, stretch: 0.4, location: 0.3, room: 0.8, volatility: 0.6, news: 1.0, research: 0.3 } },
  reversion: { label: 'mean-reversion trader', w: { edge: 1.0, htf: 0.7, trend: 0.3, structure: 0.4, momentum: 0.1, stretch: 1.3, location: 1.2, room: 1.0, volatility: 0.6, news: 1.0, research: 0.3 } },
  structure: { label: 'price-action trader', w: { edge: 1.0, htf: 1.2, trend: 0.8, structure: 1.3, momentum: 0.4, stretch: 0.6, location: 0.9, room: 0.9, volatility: 0.6, news: 1.0, research: 0.3 } },
  quant: { label: 'quant', w: { edge: 1.8, htf: 0.6, trend: 0.6, structure: 0.5, momentum: 0.5, stretch: 0.7, location: 0.5, room: 0.8, volatility: 0.9, news: 1.0, research: 1.4 } },
  flow: { label: 'market maker', w: { edge: 1.2, htf: 0.4, trend: 0.5, structure: 0.4, momentum: 0.6, stretch: 0.9, location: 0.6, room: 0.6, volatility: 1.3, news: 1.0, research: 0.4 } },
  signals: { label: 'systematic trader', w: { edge: 1.1, htf: 0.8, trend: 1.0, structure: 0.8, momentum: 0.7, stretch: 0.6, location: 0.5, room: 0.8, volatility: 0.6, news: 1.0, research: 0.4 } },
  risk: { label: 'risk manager', w: { edge: 1.8, htf: 1.0, trend: 0.8, structure: 0.8, momentum: 0.4, stretch: 0.9, location: 0.8, room: 1.1, volatility: 1.2, news: 1.3, research: 1.0 } },
};

const BY_AGENT = {
  marcus: 'trend', viktor: 'trend', lucas: 'trend', priya: 'trend',
  james: 'reversion', amara: 'reversion',
  sofia: 'structure',
  kenji: 'quant', arjun: 'quant', hannah: 'quant', omar: 'quant', mei: 'quant',
  isabella: 'flow', chen: 'signals', elena: 'risk',
};

export function styleOf(agentId) {
  return STYLES[BY_AGENT[agentId] || 'signals'];
}

export function styleKey(agentId) {
  return BY_AGENT[agentId] || 'signals';
}

// Research factor: does the market's condition suit this kind of trade, and does a
// validated research strategy stand behind it?
export function researchFactor(regime, dir, proposerStyle, validated = null) {
  let v = 0;
  let text = `the market is ${regime?.label?.toLowerCase() || 'unclassified'}`;
  const key = regime?.key;
  if (key === 'trend-up' || key === 'trend-down') {
    const withIt = (key === 'trend-up') === (dir > 0);
    v = withIt ? 0.7 : proposerStyle === 'reversion' ? -0.4 : -0.7;
    text = withIt ? `the regime is ${regime.label.toLowerCase()}, which suits this trade` : `the regime is ${regime.label.toLowerCase()}, against this trade`;
  } else if (key === 'range') {
    v = proposerStyle === 'reversion' ? 0.4 : proposerStyle === 'trend' ? -0.25 : 0;
    text = proposerStyle === 'trend' ? 'the market is ranging, breakouts often fail here' : proposerStyle === 'reversion' ? 'the market is ranging, which suits fading extremes' : 'the market is ranging';
  } else if (key === 'squeeze') {
    v = proposerStyle === 'trend' ? 0.3 : -0.2;
    text = 'volatility is squeezed, a move is building';
  } else if (key === 'volatile') {
    v = -0.3;
    text = 'the market is volatile, stops get run';
  }
  // The validation itself is described by the measured-edge factor; here it only adds weight.
  if (validated) v = Math.min(1, v + 0.5);
  return { value: Math.max(-1, Math.min(1, v)), text };
}

// A score from -1 (strongly against) to +1 (strongly for), and the reasons that drove it.
export function opinion(agentId, factors) {
  const w = styleOf(agentId).w;
  let sum = 0;
  let norm = 0;
  const parts = [];
  for (const k of FACTORS) {
    const f = factors[k];
    if (!f) continue;
    const c = w[k] * f.value;
    sum += c;
    norm += w[k];
    parts.push({ k, c, text: f.text, value: f.value });
  }
  const score = Math.max(-1, Math.min(1, (sum / Math.max(1e-9, norm)) * 2.4));
  const pros = parts.filter((p) => p.c > 0.05).sort((a, b) => b.c - a.c);
  const cons = parts.filter((p) => p.c < -0.05).sort((a, b) => a.c - b.c);
  const stance = score >= 0.2 ? 'agree' : score <= -0.1 ? 'disagree' : 'cautious';
  return { score, stance, pros, cons };
}

const pick = (list, seed) => list[Math.abs(seed) % list.length];
const cap = (s) => s.charAt(0).toUpperCase() + s.slice(1);

// What they'd actually say about someone else's trade idea. `avoid` holds points a
// colleague already made, so each reviewer brings their own where they have one.
export function say(op, seed = 0, avoid = null) {
  const fresh = (list) => {
    if (!avoid?.size) return list;
    const other = list.filter((p) => !avoid.has(p.k));
    return other.length ? [...other, ...list.filter((p) => avoid.has(p.k))] : list;
  };
  const pros = fresh(op.pros).slice(0, 2);
  const cons = fresh(op.cons).slice(0, 2);
  if (avoid) for (const p of [...pros.slice(0, 1), ...cons.slice(0, 1)]) avoid.add(p.k);
  const pro = pros.map((p) => p.text);
  const con = cons.map((p) => p.text);
  if (op.stance === 'agree') {
    const open = pick(["I'm with you", 'Agreed', 'Good trade', 'I like it'], seed);
    return `${open}: ${pro.join(' and ') || 'the picture is clean'}.${con.length ? ` Just watch it: ${con[0]}.` : ''}`;
  }
  if (op.stance === 'disagree') {
    const open = pick(["I'd pass", 'Not here', 'No', "I don't like it"], seed);
    return `${open}: ${con.join(', and ') || 'the evidence is against it'}.${pro.length ? ` Yes, ${pro[0]}, but that's not enough.` : ''}`;
  }
  const open = pick(["I'd go smaller", 'Careful', "I'm on the fence", 'Mixed picture'], seed);
  return `${open}: ${pro[0] ? `${pro[0]}, ` : ''}but ${con[0] || 'nothing stands out either way'}.`;
}

// The desk's own reasoning for its trade, in one line.
export function thesisLine(proposal, op) {
  const pro = op.pros.slice(0, 3).map((p) => p.text);
  return `${cap(proposal.reason || 'Setup triggered')}. Why: ${pro.join('; ') || 'the setup itself'}.`;
}
