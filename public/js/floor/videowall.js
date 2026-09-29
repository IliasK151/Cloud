import * as THREE from 'three';
import { ROOM } from './room.js';
import { canvasTexture, roundRect } from './textures.js';
import { money, price as fmtPrice, pct, nyTime, zoneTime } from '../format.js';

// The big LED wall at the front of the floor, the world clocks above it and the
// scrolling ticker tapes.
const WALL_W = 13;
const WALL_H = 4.55;
const CW = 2400;
const CH = 840;
const FONT = 'system-ui, -apple-system, "Segoe UI", sans-serif';
const MONO = 'ui-monospace, "SF Mono", Menlo, monospace';

export class VideoWall {
  constructor(scene) {
    const z = ROOM.z0 + 0.06;
    const frame = new THREE.Mesh(new THREE.BoxGeometry(WALL_W + 0.3, WALL_H + 0.3, 0.12), new THREE.MeshStandardMaterial({ color: '#08090c', roughness: 0.4, metalness: 0.5 }));
    frame.position.set(0, 3.05, z);
    scene.add(frame);

    this.main = canvasTexture(CW, CH);
    const screen = new THREE.Mesh(new THREE.PlaneGeometry(WALL_W, WALL_H), new THREE.MeshBasicMaterial({ map: this.main.texture, toneMapped: false }));
    screen.position.set(0, 3.05, z + 0.065);
    scene.add(screen);

    this.clocks = canvasTexture(2000, 110);
    const clocks = new THREE.Mesh(new THREE.PlaneGeometry(10, 0.55), new THREE.MeshBasicMaterial({ map: this.clocks.texture, toneMapped: false }));
    clocks.position.set(0, 5.85, z + 0.02);
    scene.add(clocks);

    // Ticker tape texture, shared by three LED strips.
    this.tape = canvasTexture(4096, 80);
    this.tape.texture.wrapS = THREE.RepeatWrapping;
    this.tapeTextures = [];
    const strip = (len, h, pos, rotY) => {
      const tex = this.tape.texture.clone();
      tex.wrapS = THREE.RepeatWrapping;
      tex.repeat.set(len / (4096 / 80 * h), 1);
      this.tapeTextures.push(tex);
      const m = new THREE.Mesh(new THREE.PlaneGeometry(len, h), new THREE.MeshBasicMaterial({ map: tex, toneMapped: false }));
      m.position.copy(pos);
      m.rotation.y = rotY;
      scene.add(m);
    };
    strip(16, 0.3, new THREE.Vector3(0, 0.42, z + 0.02), 0);
    strip(ROOM.z1 - ROOM.z0 - 1, 0.32, new THREE.Vector3(ROOM.x0 + 0.05, 6.02, (ROOM.z0 + ROOM.z1) / 2), Math.PI / 2);
    strip(ROOM.z1 - ROOM.z0 - 1, 0.32, new THREE.Vector3(ROOM.x1 - 0.05, 6.02, (ROOM.z0 + ROOM.z1) / 2), -Math.PI / 2);
    this.tapeText = '';
    this.#drawBoot();
  }

  #drawBoot() {
    const ctx = this.main.ctx;
    ctx.fillStyle = '#04060a';
    ctx.fillRect(0, 0, CW, CH);
    ctx.fillStyle = '#3987e5';
    ctx.font = `700 60px ${FONT}`;
    ctx.textAlign = 'center';
    ctx.fillText('CONNECTING TO THE FLOOR…', CW / 2, CH / 2);
    this.main.texture.needsUpdate = true;
  }

  tick(dt) {
    for (const t of this.tapeTextures) t.offset.x = (t.offset.x + dt * 0.035) % 1;
  }

  draw(store) {
    const f = store.fund;
    if (!f) return;
    this.#drawMain(store);
    this.#drawClocks(f.marketTime, f.mode);
  }

  #drawMain(store) {
    const f = store.fund;
    const ctx = this.main.ctx;
    ctx.fillStyle = '#04060a';
    ctx.fillRect(0, 0, CW, CH);
    // LED panel seams
    ctx.strokeStyle = 'rgba(255,255,255,0.025)';
    ctx.lineWidth = 2;
    for (let x = 300; x < CW; x += 300) { ctx.beginPath(); ctx.moveTo(x, 0); ctx.lineTo(x, CH); ctx.stroke(); }
    for (let y = 280; y < CH; y += 280) { ctx.beginPath(); ctx.moveTo(0, y); ctx.lineTo(CW, y); ctx.stroke(); }

    // Header
    ctx.textBaseline = 'alphabetic';
    ctx.textAlign = 'left';
    ctx.fillStyle = '#ffffff';
    ctx.font = `800 52px ${FONT}`;
    ctx.fillText(f.name.toUpperCase(), 50, 78);
    ctx.fillStyle = '#7d8594';
    ctx.font = `600 30px ${FONT}`;
    ctx.fillText('GLOBAL MARKETS · TRADING FLOOR', 50 + ctx.measureText('').width + 2, 118);
    ctx.textAlign = 'right';
    ctx.fillStyle = f.mode === 'live' ? '#ff6b6b' : '#8fbcf5';
    ctx.font = `800 34px ${FONT}`;
    ctx.fillText(f.mode === 'live' ? '● LIVE MARKETS' : `SIMULATION ${f.speed}×`, CW - 50, 70);
    ctx.fillStyle = '#b9c0cc';
    ctx.font = `600 30px ${MONO}`;
    ctx.fillText(`${nyTime(f.marketTime, true)} ET · ${f.session.toUpperCase()} SESSION`, CW - 50, 116);

    // Left: NAV and day P&L
    const L = 50;
    ctx.textAlign = 'left';
    ctx.fillStyle = '#7d8594';
    ctx.font = `700 28px ${FONT}`;
    ctx.fillText('NET ASSET VALUE', L, 200);
    ctx.fillStyle = '#ffffff';
    ctx.font = `800 92px ${FONT}`;
    ctx.fillText(money(f.nav), L, 290);
    const dayCol = f.dayPnl > 0.5 ? '#2fbf4f' : f.dayPnl < -0.5 ? '#ff6b6b' : '#e6e9ef';
    ctx.fillStyle = '#7d8594';
    ctx.font = `700 28px ${FONT}`;
    ctx.fillText('DAY P&L', L, 360);
    ctx.fillText('SINCE INCEPTION', L + 380, 360);
    ctx.fillStyle = dayCol;
    ctx.font = `800 58px ${FONT}`;
    ctx.fillText(money(f.dayPnl, { sign: true }), L, 425);
    ctx.fillStyle = f.totalPnl >= 0 ? '#2fbf4f' : '#ff6b6b';
    ctx.fillText(money(f.totalPnl, { sign: true, compact: true }), L + 380, 425);

    // Fund equity sparkline (recent)
    const eq = store.equity.slice(-240);
    const sx = L;
    const sy = 470;
    const sw = 700;
    const sh = 250;
    ctx.fillStyle = 'rgba(255,255,255,0.03)';
    roundRect(ctx, sx, sy, sw, sh, 14);
    ctx.fill();
    ctx.fillStyle = '#7d8594';
    ctx.font = `700 22px ${FONT}`;
    ctx.fillText('FUND EQUITY', sx + 20, sy + 38);
    if (eq.length > 1) {
      const vals = eq.map((p) => p.value);
      const lo = Math.min(...vals);
      const hi = Math.max(...vals);
      const span = hi - lo || 1;
      const x = (i) => sx + 20 + (i / (eq.length - 1)) * (sw - 40);
      const y = (v) => sy + sh - 22 - ((v - lo) / span) * (sh - 80);
      const up = vals[vals.length - 1] >= vals[0];
      const col = up ? '#2fbf4f' : '#ff6b6b';
      const grad = ctx.createLinearGradient(0, sy + 50, 0, sy + sh);
      grad.addColorStop(0, up ? 'rgba(47,191,79,0.35)' : 'rgba(255,107,107,0.35)');
      grad.addColorStop(1, 'rgba(0,0,0,0)');
      ctx.beginPath();
      eq.forEach((p, i) => (i ? ctx.lineTo(x(i), y(p.value)) : ctx.moveTo(x(i), y(p.value))));
      ctx.lineTo(x(eq.length - 1), sy + sh - 22);
      ctx.lineTo(x(0), sy + sh - 22);
      ctx.closePath();
      ctx.fillStyle = grad;
      ctx.fill();
      ctx.beginPath();
      eq.forEach((p, i) => (i ? ctx.lineTo(x(i), y(p.value)) : ctx.moveTo(x(i), y(p.value))));
      ctx.strokeStyle = col;
      ctx.lineWidth = 5;
      ctx.stroke();
    }

    // Middle: desk P&L bars (diverging around zero)
    const M = 840;
    const MW = 700;
    ctx.fillStyle = '#7d8594';
    ctx.font = `700 28px ${FONT}`;
    ctx.fillText('DESK P&L — TODAY', M, 200);
    const agents = store.profiles.map((p) => ({ p, a: store.agents[p.id] })).filter((x) => x.a);
    const maxAbs = Math.max(1, ...agents.map((x) => Math.abs(x.a.pnl.day)));
    const rowH = 56;
    const nameW = 250;
    const barArea = MW - nameW - 170;
    const zeroX = M + nameW + barArea / 2;
    agents.forEach(({ p, a }, i) => {
      const y = 240 + i * rowH;
      ctx.fillStyle = p.accent;
      ctx.fillRect(M, y + 8, 8, rowH - 22);
      ctx.fillStyle = '#d7dbe3';
      ctx.font = `600 26px ${FONT}`;
      ctx.textAlign = 'left';
      ctx.fillText(p.desk, M + 22, y + 34);
      const v = a.pnl.day;
      const len = (Math.abs(v) / maxAbs) * (barArea / 2);
      ctx.fillStyle = v >= 0 ? '#0ca30c' : '#d03b3b';
      if (v >= 0) ctx.fillRect(zeroX, y + 10, len, rowH - 26);
      else ctx.fillRect(zeroX - len, y + 10, len, rowH - 26);
      ctx.fillStyle = v > 0.5 ? '#2fbf4f' : v < -0.5 ? '#ff6b6b' : '#b9c0cc';
      ctx.font = `700 26px ${MONO}`;
      ctx.textAlign = 'right';
      ctx.fillText(money(v, { sign: true, compact: true }), M + MW, y + 34);
    });
    ctx.fillStyle = 'rgba(255,255,255,0.3)';
    ctx.fillRect(zeroX - 1, 232, 2, agents.length * rowH);

    // Right: markets
    const R = 1600;
    ctx.textAlign = 'left';
    ctx.fillStyle = '#7d8594';
    ctx.font = `700 28px ${FONT}`;
    ctx.fillText('MARKETS', R, 200);
    const ids = Object.keys(store.symbols);
    const tw = 245;
    const th = 170;
    ids.forEach((id, i) => {
      const q = store.quotes[id];
      const x = R + (i % 3) * (tw + 12);
      const y = 225 + Math.floor(i / 3) * (th + 12);
      const chg = q?.change ?? 0;
      const k = Math.min(1, Math.abs(chg) / 0.01);
      ctx.fillStyle = chg >= 0 ? `rgba(12,163,12,${0.14 + 0.4 * k})` : `rgba(208,59,59,${0.14 + 0.4 * k})`;
      roundRect(ctx, x, y, tw, th, 12);
      ctx.fill();
      ctx.fillStyle = '#ffffff';
      ctx.font = `800 30px ${FONT}`;
      ctx.textAlign = 'left';
      ctx.fillText(id, x + 18, y + 44);
      ctx.font = `700 34px ${MONO}`;
      ctx.fillText(fmtPrice(q?.price, store.symbols[id].decimals), x + 18, y + 100);
      ctx.font = `700 28px ${FONT}`;
      ctx.fillText(pct(chg), x + 18, y + 146);
      ctx.fillStyle = 'rgba(255,255,255,0.55)';
      ctx.font = `700 18px ${FONT}`;
      ctx.textAlign = 'right';
      ctx.fillText(q?.status ?? '', x + tw - 16, y + 40);
    });

    // Footer: risk line
    ctx.textAlign = 'left';
    const risk = f.riskOff ? `RISK-OFF — ${f.riskOff.reason}` : 'RISK: NORMAL';
    ctx.fillStyle = f.riskOff ? '#ff6b6b' : '#2fbf4f';
    ctx.font = `800 28px ${FONT}`;
    ctx.fillText(risk, 50, CH - 40);
    ctx.fillStyle = '#9aa3b2';
    ctx.font = `600 28px ${FONT}`;
    ctx.fillText(`Gross ${money(f.grossExposure, { compact: true })}  ·  Open positions ${f.openPositions}  ·  Trades today ${f.tradesDay}${f.winRateDay != null ? `  ·  Win rate ${Math.round(f.winRateDay * 100)}%` : ''}`, 420, CH - 40);
    this.main.texture.needsUpdate = true;
  }

  #drawClocks(ms, mode) {
    const ctx = this.clocks.ctx;
    ctx.fillStyle = '#05070b';
    ctx.fillRect(0, 0, 2000, 110);
    // In sim mode the wall clocks follow the simulated market clock.
    const zones = [['NEW YORK', 'America/New_York'], ['LONDON', 'Europe/London'], ['FRANKFURT', 'Europe/Berlin'], ['TOKYO', 'Asia/Tokyo'], ['HONG KONG', 'Asia/Hong_Kong']];
    zones.forEach(([name, tz], i) => {
      const x = 40 + i * 392;
      ctx.fillStyle = '#7d8594';
      ctx.font = `700 26px ${FONT}`;
      ctx.textAlign = 'left';
      ctx.fillText(name, x, 64);
      ctx.fillStyle = mode === 'live' ? '#ff5b5b' : '#6fb4ff';
      ctx.font = `700 50px ${MONO}`;
      ctx.fillText(zoneTime(ms, tz), x + 170, 72);
    });
    this.clocks.texture.needsUpdate = true;
  }

  drawTape(store) {
    const parts = [];
    for (const id of Object.keys(store.symbols)) {
      const q = store.quotes[id];
      if (!q) continue;
      parts.push({ t: `${id} ${fmtPrice(q.price, store.symbols[id].decimals)} ${q.change >= 0 ? '▲' : '▼'} ${pct(q.change)}`, c: q.change >= 0 ? '#39d353' : '#ff6b6b' });
    }
    const recent = store.events.filter((e) => e.kind === 'entry' || e.kind === 'exit').slice(-4);
    for (const e of recent) {
      const who = store.profileById[e.agentId]?.name.split(' ')[0].toUpperCase() ?? 'FLOOR';
      parts.push({ t: `${who}: ${e.text}`, c: '#ffc34d' });
    }
    const key = parts.map((p) => p.t).join('|');
    if (key === this.tapeText) return;
    this.tapeText = key;
    const ctx = this.tape.ctx;
    ctx.fillStyle = '#020304';
    ctx.fillRect(0, 0, 4096, 80);
    ctx.font = `700 44px ${MONO}`;
    ctx.textBaseline = 'middle';
    let x = 20;
    for (const p of parts) {
      if (x > 4000) break;
      ctx.fillStyle = p.c;
      ctx.fillText(p.t, x, 42);
      x += ctx.measureText(p.t).width + 70;
      ctx.fillStyle = '#3a3f48';
      ctx.fillText('◆', x - 48, 42);
    }
    for (const t of this.tapeTextures) t.needsUpdate = true;
  }
}
