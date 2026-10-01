// The setup, as a picture: when a desk's trade goes to the account, the floor draws the chart
// the way TradingView would (dark theme, candles, the long/short position tool with entry,
// stop and target, the desk's own setup levels and the nearest support and resistance) and
// sends it to the boss's phone with the reasons.
//
// It's drawn from the same 1-minute prices the desk traded on (your MT5 feed), as an SVG,
// then turned into a PNG by resvg (an optional dependency; without it alerts stay text).

const W = 1200;
const H = 675;
const PAD = { l: 14, r: 92, t: 78, b: 58 };
const C = {
  bg: '#131722', grid: '#1e222d', text: '#b2b5be', dim: '#787b86', white: '#e1e3ea',
  up: '#089981', down: '#f23645', entry: '#2962ff', level: '#f0b90b', brain: '#5d606b',
  profit: 'rgba(8,153,129,0.20)', loss: 'rgba(242,54,69,0.20)',
};
const FONT = "-apple-system, 'SF Pro Text', 'Helvetica Neue', Helvetica, Arial, 'DejaVu Sans', sans-serif";
const FUTURE = 18; // empty bars to the right, where the trade plays out

const esc = (s) => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
const fin = Number.isFinite;

function niceStep(raw) {
  const p = 10 ** Math.floor(Math.log10(raw));
  const m = raw / p;
  return (m < 1.5 ? 1 : m < 3 ? 2 : m < 7 ? 5 : 10) * p;
}

const timeLabel = (sec, timeZone) => new Date(sec * 1000).toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit', ...(timeZone ? { timeZone } : {}) });

// spec: { symbol, brokerSymbol, tv, decimals, side, entry, stop, target, bars:[{time,open,high,low,close}],
//         who, desk, grade, levels:[{label,price}], context:[{label,price}], timeZone, when }
export function chartSvg(spec) {
  const dec = spec.decimals ?? 2;
  const fmt = (x) => Number(x).toFixed(dec);
  const bars = (spec.bars || []).filter((b) => [b.open, b.high, b.low, b.close].every(fin)).slice(-120);
  const long = spec.side !== 'SHORT' && spec.side !== 'SELL';
  const plot = { x0: PAD.l, x1: W - PAD.r, y0: PAD.t, y1: H - PAD.b };
  const n = Math.max(bars.length, 1);
  const step = (plot.x1 - plot.x0) / (n + FUTURE);
  const xOf = (i) => plot.x0 + (i + 0.5) * step;

  // The price range: the candles, the trade, and the setup levels that are near it.
  let lo = Math.min(...bars.map((b) => b.low), spec.entry, spec.stop ?? spec.entry, spec.target ?? spec.entry);
  let hi = Math.max(...bars.map((b) => b.high), spec.entry, spec.stop ?? spec.entry, spec.target ?? spec.entry);
  const span0 = Math.max(hi - lo, Math.abs(spec.entry) * 1e-4);
  const near = (p) => fin(p) && p > lo - span0 * 0.6 && p < hi + span0 * 0.6;
  const levels = (spec.levels || []).filter((l) => near(l.price)).slice(0, 6);
  const context = (spec.context || []).filter((l) => near(l.price) && !levels.some((s) => Math.abs(s.price - l.price) < span0 * 0.01)).slice(0, 4);
  for (const l of [...levels, ...context]) {
    lo = Math.min(lo, l.price);
    hi = Math.max(hi, l.price);
  }
  const pad = (hi - lo) * 0.07 || span0 * 0.1;
  lo -= pad;
  hi += pad;
  const yOf = (p) => plot.y0 + ((hi - p) / (hi - lo)) * (plot.y1 - plot.y0);

  const out = [];
  out.push(`<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${H}" viewBox="0 0 ${W} ${H}" font-family="${esc(FONT)}">`);
  out.push(`<rect width="${W}" height="${H}" fill="${C.bg}"/>`);

  // Grid and price scale.
  const tick = niceStep((hi - lo) / 7);
  for (let p = Math.ceil(lo / tick) * tick; p <= hi; p += tick) {
    const y = yOf(p).toFixed(1);
    out.push(`<line x1="${plot.x0}" x2="${plot.x1}" y1="${y}" y2="${y}" stroke="${C.grid}"/>`);
    out.push(`<text x="${plot.x1 + 10}" y="${+y + 4}" font-size="12" fill="${C.dim}">${esc(fmt(p))}</text>`);
  }
  const every = Math.max(1, Math.round(n / 8));
  for (let i = 0; i < bars.length; i += every) {
    const x = xOf(i).toFixed(1);
    out.push(`<line x1="${x}" x2="${x}" y1="${plot.y0}" y2="${plot.y1}" stroke="${C.grid}"/>`);
    out.push(`<text x="${x}" y="${plot.y1 + 18}" font-size="12" fill="${C.dim}" text-anchor="middle">${esc(timeLabel(bars[i].time, spec.timeZone))}</text>`);
  }
  out.push(`<line x1="${plot.x1}" x2="${plot.x1}" y1="${plot.y0 - 8}" y2="${plot.y1}" stroke="#2a2e39"/>`);

  // The long / short position tool, from the entry candle into the future.
  const iE = bars.length - 1;
  const xe = xOf(Math.max(0, iE)) - step * 0.4;
  const xr = plot.x1 - 2;
  const yE = yOf(spec.entry);
  const box = (y1, y2, fill) => `<rect x="${xe.toFixed(1)}" y="${Math.min(y1, y2).toFixed(1)}" width="${(xr - xe).toFixed(1)}" height="${Math.max(1, Math.abs(y2 - y1)).toFixed(1)}" fill="${fill}"/>`;
  if (fin(spec.target)) out.push(box(yE, yOf(spec.target), C.profit));
  if (fin(spec.stop)) out.push(box(yE, yOf(spec.stop), C.loss));

  // The desk's own setup levels (amber) and the market's nearest support and resistance (grey):
  // lines under the candles, their labels over them.
  const labels = [];
  for (const l of context) {
    const y = yOf(l.price).toFixed(1);
    out.push(`<line x1="${plot.x0}" x2="${plot.x1}" y1="${y}" y2="${y}" stroke="${C.brain}" stroke-dasharray="2 4"/>`);
    labels.push(`<text x="${plot.x1 - 6}" y="${+y - 5}" font-size="11" fill="${C.dim}" text-anchor="end">${esc(l.label)} ${esc(fmt(l.price))}</text>`);
  }
  for (const l of levels) {
    const y = yOf(l.price).toFixed(1);
    const text = `${l.label} ${fmt(l.price)}`;
    out.push(`<line x1="${plot.x0}" x2="${plot.x1}" y1="${y}" y2="${y}" stroke="${C.level}" stroke-width="1.2" stroke-dasharray="7 5" opacity="0.9"/>`);
    labels.push(`<rect x="${plot.x0 + 4}" y="${+y - 17}" width="${Math.min(360, 14 + text.length * 6.6)}" height="15" rx="3" fill="${C.bg}" opacity="0.85"/>`);
    labels.push(`<text x="${plot.x0 + 10}" y="${+y - 6}" font-size="11.5" fill="${C.level}">${esc(text)}</text>`);
  }

  // Candles.
  const bw = Math.max(1, step * 0.66);
  for (let i = 0; i < bars.length; i++) {
    const b = bars[i];
    const col = b.close >= b.open ? C.up : C.down;
    const x = xOf(i);
    const yo = yOf(b.open);
    const yc = yOf(b.close);
    out.push(`<line x1="${x.toFixed(1)}" x2="${x.toFixed(1)}" y1="${yOf(b.high).toFixed(1)}" y2="${yOf(b.low).toFixed(1)}" stroke="${col}" stroke-width="1"/>`);
    out.push(`<rect x="${(x - bw / 2).toFixed(1)}" y="${Math.min(yo, yc).toFixed(1)}" width="${bw.toFixed(1)}" height="${Math.max(1, Math.abs(yc - yo)).toFixed(1)}" fill="${col}"/>`);
  }

  out.push(...labels);

  // Entry, stop and target lines with their labels, and on the price scale.
  const line = (p, col, label, dash = '') => {
    const y = yOf(p).toFixed(1);
    out.push(`<line x1="${xe.toFixed(1)}" x2="${plot.x1}" y1="${y}" y2="${y}" stroke="${col}" stroke-width="1.6"${dash ? ` stroke-dasharray="${dash}"` : ''}/>`);
    out.push(`<rect x="${plot.x1 + 1}" y="${+y - 10}" width="${PAD.r - 4}" height="20" rx="2" fill="${col}"/>`);
    out.push(`<text x="${plot.x1 + 8}" y="${+y + 4.5}" font-size="12" font-weight="600" fill="#fff">${esc(fmt(p))}</text>`);
    const w = 12 + label.length * 6.9;
    const lx = Math.max(plot.x0 + 4, xr - w - 8);
    out.push(`<rect x="${lx.toFixed(1)}" y="${+y - 22}" width="${w.toFixed(1)}" height="18" rx="3" fill="${col}"/>`);
    out.push(`<text x="${(lx + 6).toFixed(1)}" y="${+y - 9}" font-size="12" font-weight="600" fill="#fff">${esc(label)}</text>`);
  };
  if (fin(spec.target)) line(spec.target, C.up, spec.targetLabel || `Target ${fmt(spec.target)}`);
  if (fin(spec.stop)) line(spec.stop, C.down, spec.stopLabel || `Stop ${fmt(spec.stop)}`);
  line(spec.entry, C.entry, spec.entryLabel || `${long ? 'Buy' : 'Sell'} ${fmt(spec.entry)}`);

  // The entry candle gets an arrow.
  if (bars.length) {
    const b = bars[iE];
    const x = xOf(iE);
    const y = long ? yOf(b.low) + 10 : yOf(b.high) - 10;
    const d = long ? `M${x} ${y} l-7 12 h14 z` : `M${x} ${y} l-7 -12 h14 z`;
    out.push(`<path d="${d}" fill="${C.entry}"/>`);
  }

  // Header and footer.
  out.push(`<text x="${PAD.l + 2}" y="30" font-size="21" font-weight="700" fill="${C.white}">${esc(spec.title || `${spec.brokerSymbol || spec.symbol}`)}</text>`);
  out.push(`<text x="${PAD.l + 2}" y="54" font-size="13.5" fill="${C.text}">${esc(spec.subtitle || '')}</text>`);
  out.push(`<text x="${W - 16}" y="30" font-size="14" font-weight="600" fill="${C.text}" text-anchor="end">Meridian Capital</text>`);
  out.push(`<text x="${W - 16}" y="52" font-size="12" fill="${C.dim}" text-anchor="end">${esc(spec.when || '')}</text>`);
  out.push(`<text x="${PAD.l + 2}" y="${H - 12}" font-size="11.5" fill="${C.dim}">${esc(spec.footer || '')}</text>`);
  out.push('</svg>');
  return out.join('\n');
}

let resvg; // undefined: not tried yet · null: not installed
export async function renderPng(svg) {
  if (resvg === undefined) {
    try {
      resvg = (await import('@resvg/resvg-js')).Resvg;
    } catch {
      resvg = null;
    }
  }
  if (!resvg) return null;
  const r = new resvg(svg, { fitTo: { mode: 'width', value: W }, font: { loadSystemFonts: true, defaultFontFamily: 'Helvetica' } });
  return Buffer.from(r.render().asPng());
}

export async function entryChart(spec) {
  const svg = chartSvg(spec);
  return { svg, png: await renderPng(svg) };
}
