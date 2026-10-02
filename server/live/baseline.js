import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

// Each desk's long-run record: every trading desk replayed on many months of real 1-minute
// prices (thousands of trades), written by `npm run baseline` to server/research/baseline.json
// and shipped with the floor. The nightly review judges the desks on the few weeks of prices
// the floor has saved from your MT5; this is the long view. The account brain uses both: a
// desk that lost money with confidence over the long run trades paper only, unless the
// nightly review finds a statistically real edge on your own recent prices.

export const BASELINE_FILE = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'research', 'baseline.json');
// Verdicts that say something (the rest: no history, too few trades, a replay that failed).
const JUDGED = new Set(['loses', 'no edge', 'unclear', 'edge']);
const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

export function validBaseline(b) {
  if (!b || typeof b !== 'object' || !Array.isArray(b.desks)) return false;
  return b.desks.every((d) => d && typeof d.id === 'string' && typeof d.verdict === 'string'
    && (!JUDGED.has(d.verdict) || (Number.isFinite(d.n) && Number.isFinite(d.avgR) && Number.isFinite(d.from) && Number.isFinite(d.to)
      && (d.ci == null || (Array.isArray(d.ci) && d.ci.length === 2 && d.ci.every(Number.isFinite))))));
}

export function loadBaseline(file = BASELINE_FILE, log = console) {
  try {
    const b = JSON.parse(fs.readFileSync(file, 'utf8'));
    if (validBaseline(b)) return b;
    log.warn?.(`[baseline] ignoring ${path.basename(file)}: it isn't a complete long-run record`);
  } catch (err) {
    if (err.code !== 'ENOENT') log.warn?.(`[baseline] could not read ${path.basename(file)}: ${err.message}`);
  }
  return null;
}

// "23 months (Jul 2018 – May 2020)"
export function spanText(fromSec, toSec) {
  const a = new Date(fromSec * 1000);
  const b = new Date(toSec * 1000);
  const months = Math.max(1, Math.round((toSec - fromSec) / (30.44 * 86_400)));
  const m = (d) => `${MONTHS[d.getUTCMonth()]} ${d.getUTCFullYear()}`;
  return `${months} month${months === 1 ? '' : 's'} (${m(a)} – ${m(b)})`;
}

const fr = (x) => `${x >= 0 ? '+' : '−'}${Math.abs(x).toFixed(2)}R`;

export class Baseline {
  constructor(data = null) {
    this.data = validBaseline(data) ? data : null;
    this.byId = new Map((this.data?.desks || []).map((d) => [d.id, d]));
  }

  // A desk's judged long-run record, or null.
  forDesk(id) {
    const d = this.byId.get(id);
    return d && JUDGED.has(d.verdict) ? d : null;
  }

  // "−0.17R a trade over 4,016 trades on 23 months (Jul 2018 – May 2020) of real 1-minute
  // prices (90% range −0.19R to −0.14R)"
  recordText(d) {
    const range = d.ci ? ` (90% range ${fr(d.ci[0])} to ${fr(d.ci[1])})` : '';
    return `${fr(d.avgR)} a trade over ${d.n.toLocaleString('en-US')} trades on ${spanText(d.from, d.to)} of real 1-minute prices${range}`;
  }

  // For the floor's views: what the long-run record says, desk by desk.
  view() {
    if (!this.data) return null;
    return {
      at: this.data.at ?? null,
      source: String(this.data.source || ''),
      desks: this.data.desks.map((d) => ({
        id: d.id, name: String(d.name ?? d.id), symbol: String(d.symbol ?? ''), verdict: d.verdict, n: Number.isFinite(d.n) ? d.n : 0, avgR: Number.isFinite(d.avgR) ? d.avgR : null,
        ci: Array.isArray(d.ci) && d.ci.every(Number.isFinite) ? d.ci : null,
        span: Number.isFinite(d.from) && Number.isFinite(d.to) ? spanText(d.from, d.to) : null,
        quarters: d.quarters && Number.isFinite(d.quarters.total) ? { positive: Number(d.quarters.positive) || 0, total: d.quarters.total } : null,
      })),
    };
  }
}
