import * as THREE from 'three';
import { roundRect } from './textures.js';
import { money, price as fmtPrice, qty as fmtQty, pct, nyTime } from '../format.js';

// Every desk has six monitors. They share one canvas atlas (3 x 2 tiles) so a desk
// costs a single texture upload per refresh.
export const TILE_W = 480;
export const TILE_H = 288;
export const COLS = 3;
export const ROWS = 2;

// Monitor slots in the atlas: row 0 = upper monitors, row 1 = lower monitors.
export const SLOTS = {
  terminal: [0, 0],
  pnl: [1, 0],
  watch: [2, 0],
  position: [0, 1],
  chart: [1, 1],
  dom: [2, 1],
};

const TV = {
  bg: '#131722',
  panel: '#1e222d',
  grid: 'rgba(54, 58, 69, 0.55)',
  text: '#d1d4dc',
  muted: '#787b86',
  up: '#089981',
  down: '#f23645',
  blue: '#2962ff',
  amber: '#ffb000',
};
const FONT = 'system-ui, -apple-system, "Segoe UI", sans-serif';
const MONO = 'ui-monospace, "SF Mono", Menlo, monospace';

export class DeskScreens {
  constructor() {
    this.canvas = document.createElement('canvas');
    this.canvas.width = TILE_W * COLS;
    this.canvas.height = TILE_H * ROWS;
    this.ctx = this.canvas.getContext('2d');
    this.texture = new THREE.CanvasTexture(this.canvas);
    this.texture.colorSpace = THREE.SRGBColorSpace;
    this.texture.anisotropy = 8;
    this.texture.generateMipmaps = true;
    this.texture.minFilter = THREE.LinearMipmapLinearFilter;
    this.ctx.fillStyle = TV.bg;
    this.ctx.fillRect(0, 0, this.canvas.width, this.canvas.height);
    this.texture.needsUpdate = true;
  }

  // UVs for a monitor showing the tile at (col, row).
  static uvFor(col, row, geometry) {
    const uv = geometry.attributes.uv;
    const u0 = col / COLS;
    const u1 = (col + 1) / COLS;
    const v0 = 1 - (row + 1) / ROWS;
    const v1 = 1 - row / ROWS;
    for (let i = 0; i < uv.count; i++) {
      uv.setXY(i, uv.getX(i) < 0.5 ? u0 : u1, uv.getY(i) < 0.5 ? v0 : v1);
    }
    uv.needsUpdate = true;
  }

  draw(d) {
    const ctx = this.ctx;
    const tile = (slot, fn) => {
      const [c, r] = SLOTS[slot];
      ctx.save();
      ctx.translate(c * TILE_W, r * TILE_H);
      ctx.beginPath();
      ctx.rect(0, 0, TILE_W, TILE_H);
      ctx.clip();
      fn(ctx, TILE_W, TILE_H, d);
      ctx.restore();
    };
    tile('chart', drawChart);
    tile('position', drawPosition);
    tile('dom', drawDom);
    tile('terminal', drawTerminal);
    tile('pnl', drawPnl);
    tile('watch', drawWatch);
    this.texture.needsUpdate = true;
  }
}

// ---------------------------------------------------------------------------------------------
function header(ctx, w, title, right = '', color = TV.text) {
  ctx.fillStyle = TV.panel;
  ctx.fillRect(0, 0, w, 30);
  ctx.fillStyle = color;
  ctx.font = `600 15px ${FONT}`;
  ctx.textBaseline = 'middle';
  ctx.textAlign = 'left';
  ctx.fillText(title, 12, 15);
  if (right) {
    ctx.fillStyle = TV.muted;
    ctx.font = `500 13px ${FONT}`;
    ctx.textAlign = 'right';
    ctx.fillText(right, w - 12, 15);
  }
}

const pnlColor = (v) => (v > 0.5 ? TV.up : v < -0.5 ? TV.down : TV.text);

function drawChart(ctx, w, h, d) {
  const { agent, symbol, sym, bars, quote } = d;
  ctx.fillStyle = TV.bg;
  ctx.fillRect(0, 0, w, h);
  const dec = sym?.decimals ?? 2;
  const visible = (bars || []).slice(-64);
  // Header like a TradingView chart legend.
  const lastBar = visible[visible.length - 1];
  ctx.textBaseline = 'middle';
  ctx.textAlign = 'left';
  ctx.font = `700 15px ${FONT}`;
  ctx.fillStyle = TV.text;
  ctx.fillText(`${symbol} · 1`, 10, 16);
  ctx.font = `500 12px ${FONT}`;
  ctx.fillStyle = TV.muted;
  const tvName = sym?.tv?.split(':')[0] ?? '';
  ctx.fillText(tvName, 10 + ctx.measureText(`${symbol} · 1  `).width + 30, 16);
  if (lastBar) {
    const up = lastBar.close >= lastBar.open;
    ctx.fillStyle = up ? TV.up : TV.down;
    ctx.font = `500 12px ${MONO}`;
    ctx.textAlign = 'right';
    ctx.fillText(`O${fmtPrice(lastBar.open, dec)} H${fmtPrice(lastBar.high, dec)} L${fmtPrice(lastBar.low, dec)} C${fmtPrice(lastBar.close, dec)}`, w - 10, 16);
  }
  if (visible.length < 2) {
    ctx.fillStyle = TV.muted;
    ctx.textAlign = 'center';
    ctx.fillText('Loading market data…', w / 2, h / 2);
    return;
  }

  const axisW = 70;
  const top = 34;
  const bottom = h - 20;
  const plotW = w - axisW - 6;
  const pos = agent?.positions?.find((p) => p.symbol === symbol);
  let lo = Math.min(...visible.map((b) => b.low));
  let hi = Math.max(...visible.map((b) => b.high));
  const span0 = hi - lo || lo * 0.001;
  const extra = [];
  if (pos) extra.push(pos.avg, pos.stop, pos.target);
  for (const l of agent?.setup?.levels || []) extra.push(l.price);
  for (const v of extra) {
    if (Number.isFinite(v) && v > lo - span0 * 0.8 && v < hi + span0 * 0.8) {
      lo = Math.min(lo, v);
      hi = Math.max(hi, v);
    }
  }
  const pad = (hi - lo) * 0.08 || 1;
  lo -= pad;
  hi += pad;
  const y = (p) => top + ((hi - p) / (hi - lo)) * (bottom - top);
  const step = plotW / visible.length;
  const x = (i) => 4 + i * step + step / 2;

  // Watermark
  ctx.fillStyle = 'rgba(120, 123, 134, 0.08)';
  ctx.font = `800 64px ${FONT}`;
  ctx.textAlign = 'center';
  ctx.fillText(symbol, plotW / 2, (top + bottom) / 2);

  // Grid + price axis
  ctx.strokeStyle = TV.grid;
  ctx.lineWidth = 1;
  ctx.font = `12px ${MONO}`;
  ctx.textAlign = 'left';
  for (let g = 0; g <= 4; g++) {
    const p = lo + ((hi - lo) * g) / 4;
    const yy = Math.round(y(p)) + 0.5;
    ctx.beginPath();
    ctx.moveTo(0, yy);
    ctx.lineTo(plotW + 4, yy);
    ctx.stroke();
    ctx.fillStyle = TV.muted;
    ctx.fillText(fmtPrice(p, dec), plotW + 10, yy);
  }
  for (let i = 0; i < visible.length; i += 15) {
    const xx = Math.round(x(i)) + 0.5;
    ctx.beginPath();
    ctx.moveTo(xx, top);
    ctx.lineTo(xx, bottom);
    ctx.stroke();
    ctx.fillStyle = TV.muted;
    ctx.textAlign = 'center';
    ctx.fillText(nyTime(visible[i].time * 1000), xx, h - 9);
    ctx.textAlign = 'left';
  }

  // TradingView-style long/short position tool.
  if (pos && Number.isFinite(pos.stop)) {
    const startIdx = Math.max(0, visible.findIndex((b) => b.time * 1000 >= pos.openTime - 60_000));
    const x0 = x(startIdx) - step / 2;
    const x1 = plotW + 4;
    const yE = y(pos.avg);
    if (Number.isFinite(pos.target)) {
      ctx.fillStyle = 'rgba(8, 153, 129, 0.2)';
      ctx.fillRect(x0, Math.min(yE, y(pos.target)), x1 - x0, Math.abs(y(pos.target) - yE));
    }
    ctx.fillStyle = 'rgba(242, 54, 69, 0.2)';
    ctx.fillRect(x0, Math.min(yE, y(pos.stop)), x1 - x0, Math.abs(y(pos.stop) - yE));
  }

  // Candles
  const bw = Math.max(2, step * 0.62);
  for (let i = 0; i < visible.length; i++) {
    const b = visible[i];
    const up = b.close >= b.open;
    ctx.strokeStyle = ctx.fillStyle = up ? TV.up : TV.down;
    const xx = x(i);
    ctx.beginPath();
    ctx.moveTo(Math.round(xx) + 0.5, y(b.high));
    ctx.lineTo(Math.round(xx) + 0.5, y(b.low));
    ctx.stroke();
    const y0 = y(Math.max(b.open, b.close));
    const y1 = y(Math.min(b.open, b.close));
    ctx.fillRect(xx - bw / 2, y0, bw, Math.max(1, y1 - y0));
  }

  const tag = (p, color, label, dashed = true) => {
    if (!Number.isFinite(p) || p < lo || p > hi) return;
    const yy = Math.round(y(p)) + 0.5;
    ctx.save();
    ctx.strokeStyle = color;
    ctx.lineWidth = 1.5;
    if (dashed) ctx.setLineDash([6, 4]);
    ctx.beginPath();
    ctx.moveTo(0, yy);
    ctx.lineTo(plotW + 4, yy);
    ctx.stroke();
    ctx.restore();
    ctx.fillStyle = color;
    roundRect(ctx, plotW + 5, yy - 10, axisW - 6, 20, 3);
    ctx.fill();
    ctx.fillStyle = '#fff';
    ctx.font = `600 12px ${MONO}`;
    ctx.textAlign = 'left';
    ctx.fillText(fmtPrice(p, dec), plotW + 9, yy + 1);
    if (label) {
      ctx.font = `600 11px ${FONT}`;
      const tw = ctx.measureText(label).width + 10;
      ctx.fillStyle = color;
      roundRect(ctx, plotW - tw - 2, yy - 9, tw, 18, 3);
      ctx.fill();
      ctx.fillStyle = '#fff';
      ctx.fillText(label, plotW - tw + 3, yy + 1);
    }
  };

  // Strategy levels (subtle), then the live position lines.
  for (const l of (agent?.setup?.levels || []).slice(0, 4)) tag(l.price, 'rgba(120, 123, 134, 0.9)', l.label);
  if (pos) {
    tag(pos.stop, TV.down, 'STOP');
    tag(pos.target, TV.up, 'TARGET');
    tag(pos.avg, TV.blue, `${pos.side} ${fmtQty(pos.qty)}`, false);
  }
  const last = quote?.price ?? lastBar.close;
  tag(last, lastBar.close >= lastBar.open ? TV.up : TV.down, '', true);
}

function drawPosition(ctx, w, h, d) {
  const { agent, profile } = d;
  ctx.fillStyle = TV.bg;
  ctx.fillRect(0, 0, w, h);
  header(ctx, w, `${profile.desk.toUpperCase()} · BOOK`, agent?.status ?? '');
  if (!agent) return;
  const dayPnl = agent.pnl.day;
  ctx.textBaseline = 'alphabetic';
  ctx.textAlign = 'left';
  ctx.fillStyle = TV.muted;
  ctx.font = `600 12px ${FONT}`;
  ctx.fillText('DAY P&L', 14, 54);
  ctx.fillStyle = pnlColor(dayPnl);
  ctx.font = `700 38px ${FONT}`;
  ctx.fillText(money(dayPnl, { sign: true }), 14, 92);
  ctx.fillStyle = TV.muted;
  ctx.font = `500 13px ${FONT}`;
  ctx.fillText(`Unrealized ${money(agent.pnl.unrealized, { sign: true })} · Total ${money(agent.pnl.total, { sign: true })}`, 14, 114);

  // Position rows
  let yy = 140;
  ctx.font = `600 14px ${FONT}`;
  if (!agent.positions.length) {
    ctx.fillStyle = TV.muted;
    ctx.fillText('FLAT — no open risk', 14, yy);
    yy += 24;
  }
  for (const p of agent.positions.slice(0, 2)) {
    ctx.fillStyle = p.side === 'LONG' ? TV.up : TV.down;
    roundRect(ctx, 14, yy - 15, 58, 20, 4);
    ctx.fill();
    ctx.fillStyle = '#fff';
    ctx.font = `700 12px ${FONT}`;
    ctx.fillText(p.side, 20, yy);
    ctx.fillStyle = TV.text;
    ctx.font = `600 14px ${FONT}`;
    ctx.fillText(`${fmtQty(p.qty)} ${p.symbol} @ ${fmtPrice(p.avg, d.symbols[p.symbol]?.decimals ?? 2)}`, 80, yy);
    ctx.fillStyle = pnlColor(p.unrealized);
    ctx.textAlign = 'right';
    ctx.fillText(money(p.unrealized, { sign: true }), w - 14, yy);
    ctx.textAlign = 'left';
    yy += 26;
  }

  // Setup checklist
  ctx.fillStyle = TV.muted;
  ctx.font = `600 11px ${FONT}`;
  ctx.fillText('SETUP CHECKLIST', 14, yy + 6);
  yy += 26;
  ctx.font = `500 13px ${FONT}`;
  for (const item of (agent.setup.checklist || []).slice(0, 5)) {
    ctx.fillStyle = item.ok ? TV.up : '#4a4f5c';
    ctx.fillText(item.ok ? '✓' : '✕', 16, yy);
    ctx.fillStyle = item.ok ? TV.text : TV.muted;
    ctx.fillText(item.label, 36, yy);
    yy += 20;
    if (yy > h - 8) break;
  }
}

function hash(n) {
  const s = Math.sin(n * 12.9898) * 43758.5453;
  return s - Math.floor(s);
}

function drawDom(ctx, w, h, d) {
  const { symbol, sym, quote, agent, ticks } = d;
  ctx.fillStyle = TV.bg;
  ctx.fillRect(0, 0, w, h);
  header(ctx, w, `DOM · ${symbol}`, 'TIME & SALES');
  const mid = quote?.price;
  if (!Number.isFinite(mid)) return;
  const dec = sym?.decimals ?? 2;
  const tick = sym?.tick ?? 0.01;
  const step = Math.max(tick, Math.pow(10, Math.floor(Math.log10(mid * 0.00012))) || tick);
  const center = Math.round(mid / step) * step;
  const rows = 12;
  const rowH = (h - 36) / rows;
  const colW = 250;
  const t = Math.floor(Date.now() / 700);
  const pos = agent?.positions?.find((p) => p.symbol === symbol);
  ctx.font = `13px ${MONO}`;
  ctx.textBaseline = 'middle';
  for (let i = 0; i < rows; i++) {
    const level = center + (rows / 2 - i) * step;
    const yy = 36 + i * rowH + rowH / 2;
    const isAsk = level > mid;
    const size = Math.round(5 + hash(level * 7.13 + t * 0.37) * 120);
    const barW = Math.min(90, size * 0.75);
    if (Math.abs(level - center) < step / 2) {
      ctx.fillStyle = 'rgba(41, 98, 255, 0.18)';
      ctx.fillRect(0, yy - rowH / 2, colW, rowH);
    }
    ctx.fillStyle = isAsk ? 'rgba(242, 54, 69, 0.28)' : 'rgba(8, 153, 129, 0.28)';
    if (isAsk) ctx.fillRect(colW - 8 - barW, yy - rowH / 2 + 3, barW, rowH - 6);
    else ctx.fillRect(8, yy - rowH / 2 + 3, barW, rowH - 6);
    ctx.fillStyle = isAsk ? '#ff7b86' : '#3cd3b6';
    ctx.textAlign = isAsk ? 'right' : 'left';
    ctx.fillText(String(size), isAsk ? colW - 12 : 12, yy);
    ctx.fillStyle = TV.text;
    ctx.textAlign = 'center';
    ctx.fillText(fmtPrice(level, dec), colW / 2, yy);
    if (pos && (Math.abs(level - pos.stop) < step / 2 || Math.abs(level - pos.target) < step / 2)) {
      ctx.strokeStyle = Math.abs(level - pos.stop) < step / 2 ? TV.down : TV.up;
      ctx.strokeRect(2, yy - rowH / 2 + 1, colW - 4, rowH - 2);
    }
  }
  ctx.strokeStyle = TV.grid;
  ctx.beginPath();
  ctx.moveTo(colW + 0.5, 30);
  ctx.lineTo(colW + 0.5, h);
  ctx.stroke();
  // Time & sales
  const prints = (ticks || []).slice(-rows).reverse();
  ctx.textAlign = 'left';
  prints.forEach((p, i) => {
    const yy = 36 + i * rowH + rowH / 2;
    ctx.fillStyle = p.up ? '#3cd3b6' : '#ff7b86';
    ctx.fillText(fmtPrice(p.price, dec), colW + 12, yy);
    ctx.fillStyle = TV.muted;
    ctx.textAlign = 'right';
    ctx.fillText(String(Math.round(1 + hash(p.price * 3.1 + i) * 40)), w - 12, yy);
    ctx.textAlign = 'left';
  });
}

function wrap(ctx, text, maxW) {
  const words = String(text).split(' ');
  const lines = [];
  let line = '';
  for (const word of words) {
    const test = line ? `${line} ${word}` : word;
    if (ctx.measureText(test).width > maxW && line) {
      lines.push(line);
      line = word;
    } else line = test;
  }
  if (line) lines.push(line);
  return lines;
}

function drawTerminal(ctx, w, h, d) {
  const { agent, profile, symbol } = d;
  ctx.fillStyle = '#000';
  ctx.fillRect(0, 0, w, h);
  ctx.fillStyle = TV.amber;
  ctx.fillRect(0, 0, w, 26);
  ctx.fillStyle = '#000';
  ctx.font = `700 13px ${MONO}`;
  ctx.textBaseline = 'middle';
  ctx.textAlign = 'left';
  ctx.fillText(`${symbol} <GO>  ${profile.strategy.toUpperCase()}`.slice(0, 44), 8, 13);
  ctx.font = `13px ${MONO}`;
  ctx.textBaseline = 'alphabetic';
  const lines = [];
  for (const entry of (agent?.log || []).slice(-9)) {
    const prefix = nyTime(entry.time);
    const color = entry.kind === 'entry' ? '#6fe3ff' : entry.kind === 'exit' ? '#ffffff' : entry.kind === 'halt' || entry.kind === 'risk' ? '#ff6b6b' : TV.amber;
    for (const [i, l] of wrap(ctx, entry.text, w - 76).entries()) lines.push({ t: i === 0 ? prefix : '', l, color });
  }
  const shown = lines.slice(-12);
  shown.forEach((ln, i) => {
    const yy = 46 + i * 20;
    ctx.fillStyle = '#9a7a2a';
    ctx.fillText(ln.t, 8, yy);
    ctx.fillStyle = ln.color;
    ctx.fillText(ln.l, 62, yy);
  });
  if (!shown.length) {
    ctx.fillStyle = TV.amber;
    ctx.fillText('Awaiting first signal…', 8, 50);
  }
  if (Math.floor(Date.now() / 500) % 2) {
    ctx.fillStyle = TV.amber;
    ctx.fillRect(8, Math.min(h - 14, 50 + shown.length * 20), 9, 14);
  }
}

function drawPnl(ctx, w, h, d) {
  const { agent, curve, allocation } = d;
  ctx.fillStyle = TV.bg;
  ctx.fillRect(0, 0, w, h);
  const st = agent?.stats;
  header(ctx, w, 'INTRADAY P&L', st ? `${st.tradesDay} trades · ${st.winsDay} wins` : '');
  const pts = (curve || []).slice(-240);
  const top = 44;
  const bottom = h - 46;
  const left = 12;
  const right = w - 12;
  if (pts.length > 1) {
    const vals = pts.map((p) => p.value);
    let lo = Math.min(0, ...vals);
    let hi = Math.max(0, ...vals);
    if (hi - lo < allocation * 0.001) { hi += allocation * 0.0005; lo -= allocation * 0.0005; }
    const y = (v) => top + ((hi - v) / (hi - lo)) * (bottom - top);
    const x = (i) => left + (i / (pts.length - 1)) * (right - left);
    ctx.strokeStyle = TV.grid;
    ctx.beginPath();
    ctx.moveTo(left, Math.round(y(0)) + 0.5);
    ctx.lineTo(right, Math.round(y(0)) + 0.5);
    ctx.stroke();
    const lastV = vals[vals.length - 1];
    const col = lastV >= 0 ? TV.up : TV.down;
    const grad = ctx.createLinearGradient(0, top, 0, bottom);
    grad.addColorStop(0, lastV >= 0 ? 'rgba(8,153,129,0.35)' : 'rgba(242,54,69,0.05)');
    grad.addColorStop(1, lastV >= 0 ? 'rgba(8,153,129,0.02)' : 'rgba(242,54,69,0.35)');
    ctx.beginPath();
    ctx.moveTo(x(0), y(0));
    pts.forEach((p, i) => ctx.lineTo(x(i), y(p.value)));
    ctx.lineTo(x(pts.length - 1), y(0));
    ctx.closePath();
    ctx.fillStyle = grad;
    ctx.fill();
    ctx.beginPath();
    pts.forEach((p, i) => (i ? ctx.lineTo(x(i), y(p.value)) : ctx.moveTo(x(i), y(p.value))));
    ctx.strokeStyle = col;
    ctx.lineWidth = 2.5;
    ctx.stroke();
    ctx.lineWidth = 1;
  } else {
    ctx.fillStyle = TV.muted;
    ctx.font = `500 13px ${FONT}`;
    ctx.textAlign = 'center';
    ctx.fillText('Sampling P&L every market minute…', w / 2, (top + bottom) / 2);
  }
  if (!st) return;
  const cells = [
    ['WIN RATE', st.winRate == null ? '—' : `${Math.round(st.winRate * 100)}%`],
    ['PROFIT F.', st.profitFactor == null ? '—' : Number.isFinite(st.profitFactor) ? st.profitFactor.toFixed(2) : '∞'],
    ['AVG R', st.avgR == null ? '—' : st.avgR.toFixed(2)],
    ['MAX DD', money(-st.maxDrawdown, { compact: true })],
  ];
  const cw = (w - 24) / cells.length;
  cells.forEach(([k, v], i) => {
    ctx.textAlign = 'left';
    ctx.fillStyle = TV.muted;
    ctx.font = `600 10px ${FONT}`;
    ctx.fillText(k, 12 + i * cw, h - 28);
    ctx.fillStyle = TV.text;
    ctx.font = `700 15px ${FONT}`;
    ctx.fillText(v, 12 + i * cw, h - 10);
  });
}

function drawWatch(ctx, w, h, d) {
  const { quotes, symbols } = d;
  ctx.fillStyle = TV.bg;
  ctx.fillRect(0, 0, w, h);
  header(ctx, w, 'MARKET WATCH', nyTime(d.marketTime, true));
  const ids = Object.keys(symbols);
  const cols = 3;
  const cw = (w - 16) / cols;
  const ch = (h - 40) / Math.ceil(ids.length / cols);
  ids.forEach((id, i) => {
    const q = quotes[id];
    const c = i % cols;
    const r = Math.floor(i / cols);
    const x = 8 + c * cw;
    const y = 36 + r * ch;
    const chg = q?.change ?? 0;
    const k = Math.min(1, Math.abs(chg) / 0.01);
    ctx.fillStyle = chg >= 0 ? `rgba(8,153,129,${0.12 + 0.45 * k})` : `rgba(242,54,69,${0.12 + 0.45 * k})`;
    roundRect(ctx, x + 2, y + 2, cw - 4, ch - 4, 5);
    ctx.fill();
    ctx.fillStyle = TV.text;
    ctx.textAlign = 'left';
    ctx.font = `700 13px ${FONT}`;
    ctx.fillText(id, x + 10, y + 20);
    ctx.font = `600 14px ${MONO}`;
    ctx.fillText(fmtPrice(q?.price, symbols[id].decimals), x + 10, y + 40);
    ctx.font = `600 12px ${FONT}`;
    ctx.textAlign = 'right';
    ctx.fillText(pct(chg), x + cw - 10, y + 20);
    ctx.fillStyle = 'rgba(255,255,255,0.55)';
    ctx.font = `600 9px ${FONT}`;
    ctx.fillText(q?.status ?? '', x + cw - 10, y + 40);
  });
}
