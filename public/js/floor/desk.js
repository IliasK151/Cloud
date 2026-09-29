import * as THREE from 'three';
import { RoundedBoxGeometry } from 'three/addons/geometries/RoundedBoxGeometry.js';
import { Avatar } from './avatar.js';
import { DeskScreens, SLOTS } from './screens.js';
import { canvasTexture, blobTexture, roundRect } from './textures.js';
import { money } from '../format.js';

const std = (color, opts = {}) => new THREE.MeshStandardMaterial({ color, roughness: 0.6, metalness: 0.05, ...opts });

let sharedBlob = null;
const blob = () => (sharedBlob ||= blobTexture());

// Monitor layout (desk-local, the trader sits on +Z and faces -Z).
const MONITORS = [
  { slot: 'position', x: -0.66, y: 1.06, z: -0.2, ry: 0.32, rx: 0 },
  { slot: 'chart', x: 0, y: 1.06, z: -0.32, ry: 0, rx: 0 },
  { slot: 'dom', x: 0.66, y: 1.06, z: -0.2, ry: -0.32, rx: 0 },
  { slot: 'terminal', x: -0.66, y: 1.47, z: -0.24, ry: 0.32, rx: 0.12 },
  { slot: 'pnl', x: 0, y: 1.47, z: -0.36, ry: 0, rx: 0.12 },
  { slot: 'watch', x: 0.66, y: 1.47, z: -0.24, ry: -0.32, rx: 0.12 },
];

export class Desk {
  constructor(profile, index) {
    this.profile = profile;
    this.index = index;
    this.group = new THREE.Group();
    this.group.name = `desk-${profile.id}`;
    this.screens = new DeskScreens();
    this.#buildFurniture();
    this.#buildMonitors();
    this.#buildSign();
    this.avatar = new Avatar(profile);
    this.avatar.root.position.set(0, 0, 0.78);
    this.group.add(this.avatar.root);
    this.#buildStatusTag();
    this.#buildRing();
    this.#buildHitbox();
    this.hover = false;
    this.selected = false;
    this.lastSign = '';
    this.lastStatus = '';
  }

  #buildFurniture() {
    const g = this.group;
    const accent = new THREE.Color(this.profile.accent);
    const top = new THREE.Mesh(new RoundedBoxGeometry(3.0, 0.045, 1.15, 2, 0.015), std('#b4bac4', { roughness: 0.5 }));
    top.position.set(0, 0.74, 0);
    top.castShadow = top.receiveShadow = true;
    g.add(top);
    const frame = std('#23272f', { roughness: 0.7 });
    for (const s of [-1, 1]) {
      const side = new THREE.Mesh(new THREE.BoxGeometry(0.05, 0.72, 1.05), frame);
      side.position.set(s * 1.44, 0.36, 0);
      side.castShadow = true;
      g.add(side);
    }
    const modesty = new THREE.Mesh(new THREE.BoxGeometry(2.9, 0.56, 0.04), frame);
    modesty.position.set(0, 0.42, -0.52);
    modesty.castShadow = true;
    g.add(modesty);
    const led = new THREE.Mesh(new THREE.BoxGeometry(2.9, 0.025, 0.045), new THREE.MeshStandardMaterial({ color: accent, emissive: accent, emissiveIntensity: 1.6 }));
    led.position.set(0, 0.69, -0.52);
    g.add(led);
    this.led = led;

    // Monitor arm pole
    const metal = std('#3a3f48', { metalness: 0.6, roughness: 0.35 });
    const pole = new THREE.Mesh(new THREE.CylinderGeometry(0.025, 0.025, 1.05, 10), metal);
    pole.position.set(0, 1.25, -0.46);
    g.add(pole);
    const foot = new THREE.Mesh(new THREE.BoxGeometry(0.3, 0.02, 0.2), metal);
    foot.position.set(0, 0.772, -0.42);
    g.add(foot);
    for (const yy of [1.06, 1.47]) {
      const bar = new THREE.Mesh(new THREE.BoxGeometry(1.5, 0.03, 0.03), metal);
      bar.position.set(0, yy, -0.44);
      g.add(bar);
    }

    // Keyboard, Bloomberg keyboard, mouse, turret, coffee.
    const kb = new THREE.Mesh(new RoundedBoxGeometry(0.46, 0.022, 0.15, 2, 0.006), std('#1b1d22', { roughness: 0.5 }));
    kb.position.set(0.05, 0.775, 0.28);
    g.add(kb);
    const keys = new THREE.Mesh(new THREE.PlaneGeometry(0.42, 0.11), std('#2c3038', { roughness: 0.8 }));
    keys.rotation.x = -Math.PI / 2;
    keys.position.set(0.05, 0.787, 0.28);
    g.add(keys);
    const bbg = new THREE.Mesh(new RoundedBoxGeometry(0.42, 0.022, 0.15, 2, 0.006), std('#0e0f12'));
    bbg.position.set(-0.62, 0.775, 0.2);
    bbg.rotation.y = 0.18;
    g.add(bbg);
    const bbgKeys = new THREE.Mesh(new THREE.PlaneGeometry(0.1, 0.1), new THREE.MeshStandardMaterial({ color: '#e0a100', emissive: '#e0a100', emissiveIntensity: 0.4 }));
    bbgKeys.rotation.x = -Math.PI / 2;
    bbgKeys.position.set(-0.76, 0.788, 0.22);
    g.add(bbgKeys);
    const mouse = new THREE.Mesh(new THREE.SphereGeometry(0.035, 12, 8), std('#1b1d22'));
    mouse.scale.set(0.8, 0.45, 1.2);
    mouse.position.set(0.42, 0.78, 0.3);
    g.add(mouse);
    const turret = new THREE.Mesh(new RoundedBoxGeometry(0.36, 0.1, 0.26, 2, 0.02), std('#16181d'));
    turret.position.set(1.05, 0.8, 0.05);
    turret.rotation.set(-0.35, -0.35, 0);
    g.add(turret);
    // Dealer-board (voice turret) with a lit button panel.
    const turretScreen = new THREE.Mesh(new THREE.PlaneGeometry(0.3, 0.2), new THREE.MeshBasicMaterial({ color: '#1f5fae', toneMapped: false }));
    turretScreen.rotation.x = -Math.PI / 2;
    turretScreen.position.y = 0.051;
    turret.add(turretScreen);
    const mug = new THREE.Mesh(new THREE.CylinderGeometry(0.04, 0.035, 0.1, 14), std(this.index % 2 ? '#f2f2f2' : this.profile.accent));
    mug.position.set(0.85, 0.815, 0.38);
    g.add(mug);
    const papers = new THREE.Mesh(new THREE.BoxGeometry(0.22, 0.02, 0.3), std('#eeeeea', { roughness: 0.9 }));
    papers.position.set(-1.1, 0.772, 0.28);
    papers.rotation.y = 0.2;
    g.add(papers);

    // Contact shadows
    const shadow = new THREE.Mesh(new THREE.PlaneGeometry(3.8, 2.6), new THREE.MeshBasicMaterial({ map: blob(), transparent: true, depthWrite: false, opacity: 0.8 }));
    shadow.rotation.x = -Math.PI / 2;
    shadow.position.set(0, 0.006, 0.2);
    g.add(shadow);
  }

  #buildMonitors() {
    const screenMat = new THREE.MeshBasicMaterial({ map: this.screens.texture, toneMapped: false });
    const bezelMat = std('#0b0c0f', { roughness: 0.4, metalness: 0.3 });
    this.screenMeshes = [];
    for (const m of MONITORS) {
      const mon = new THREE.Group();
      mon.position.set(m.x, m.y, m.z);
      mon.rotation.set(m.rx, m.ry, 0, 'YXZ');
      const bezel = new THREE.Mesh(new RoundedBoxGeometry(0.645, 0.395, 0.03, 2, 0.008), bezelMat);
      bezel.castShadow = true;
      mon.add(bezel);
      const geo = new THREE.PlaneGeometry(0.62, 0.37);
      const [c, r] = SLOTS[m.slot];
      DeskScreens.uvFor(c, r, geo);
      const screen = new THREE.Mesh(geo, screenMat);
      screen.position.z = 0.0165;
      mon.add(screen);
      this.screenMeshes.push(screen);
      this.group.add(mon);
    }
  }

  #buildSign() {
    const { canvas, ctx, texture } = canvasTexture(1024, 240);
    this.signCanvas = canvas;
    this.signCtx = ctx;
    this.signTex = texture;
    const face = new THREE.MeshBasicMaterial({ map: texture, color: '#d8dce4' });
    const edge = std('#111318');
    const sign = new THREE.Mesh(new THREE.BoxGeometry(2.6, 0.61, 0.05), [edge, edge, edge, edge, face, face]);
    sign.position.set(0, 3.25, -0.2);
    this.group.add(sign);
    const cable = std('#555a63', { metalness: 0.6 });
    for (const s of [-1, 1]) {
      const c = new THREE.Mesh(new THREE.CylinderGeometry(0.006, 0.006, 1.6, 4), cable);
      c.position.set(s * 1.1, 4.35, -0.2);
      this.group.add(c);
    }
    this.drawSign(null);
  }

  drawSign(agent) {
    const ctx = this.signCtx;
    const W = 1024;
    const H = 240;
    const p = this.profile;
    ctx.fillStyle = '#0b0e14';
    ctx.fillRect(0, 0, W, H);
    ctx.fillStyle = p.accent;
    ctx.fillRect(0, 0, 16, H);
    ctx.fillStyle = '#f2f4f8';
    ctx.textBaseline = 'alphabetic';
    ctx.textAlign = 'left';
    // Shrink long desk names so they never run into the P&L block.
    let size = 64;
    do {
      ctx.font = `800 ${size}px system-ui, -apple-system, sans-serif`;
      size -= 2;
    } while (ctx.measureText(p.desk.toUpperCase()).width > W - 380 && size > 30);
    ctx.fillText(p.desk.toUpperCase(), 44, 96);
    ctx.fillStyle = '#9aa3b2';
    ctx.font = '500 34px system-ui, -apple-system, sans-serif';
    ctx.fillText(`${p.name} · ${p.symbols.join(' / ')}`, 44, 150);
    ctx.fillStyle = '#6b7383';
    ctx.font = '500 28px system-ui, -apple-system, sans-serif';
    ctx.fillText(p.strategy, 44, 198);
    if (agent) {
      const v = agent.pnl.day;
      ctx.textAlign = 'right';
      ctx.fillStyle = '#6b7383';
      ctx.font = '600 26px system-ui, -apple-system, sans-serif';
      ctx.fillText('DAY P&L', W - 40, 70);
      ctx.fillStyle = v > 0.5 ? '#2fbf4f' : v < -0.5 ? '#ff6b6b' : '#e6e9ef';
      ctx.font = '800 64px system-ui, -apple-system, sans-serif';
      ctx.fillText(money(v, { sign: true, compact: Math.abs(v) >= 1e6 }), W - 40, 140);
      ctx.fillStyle = '#9aa3b2';
      ctx.font = '600 28px system-ui, -apple-system, sans-serif';
      ctx.fillText(agent.status, W - 40, 196);
    }
    this.signTex.needsUpdate = true;
  }

  #buildStatusTag() {
    const { canvas, ctx, texture } = canvasTexture(320, 72);
    this.tagCanvas = canvas;
    this.tagCtx = ctx;
    this.tagTex = texture;
    const sprite = new THREE.Sprite(new THREE.SpriteMaterial({ map: texture, transparent: true, depthWrite: false, toneMapped: false }));
    sprite.scale.set(0.62, 0.14, 1);
    sprite.position.set(0, 1.78, 0.78);
    sprite.renderOrder = 5;
    this.group.add(sprite);
    this.tag = sprite;
  }

  drawTag(status, mood) {
    const ctx = this.tagCtx;
    ctx.clearRect(0, 0, 320, 72);
    const colors = { 'IN TRADE': '#3987e5', ARMED: '#fab219', HALTED: '#d03b3b', PAUSED: '#7d8594', COOLDOWN: '#ec835a' };
    const dot = colors[status] || '#0ca30c';
    ctx.fillStyle = 'rgba(8, 10, 14, 0.82)';
    roundRect(ctx, 4, 8, 312, 56, 28);
    ctx.fill();
    ctx.strokeStyle = 'rgba(255,255,255,0.18)';
    ctx.lineWidth = 2;
    ctx.stroke();
    ctx.fillStyle = dot;
    ctx.beginPath();
    ctx.arc(36, 36, 10, 0, Math.PI * 2);
    ctx.fill();
    ctx.fillStyle = '#fff';
    ctx.font = '700 26px system-ui, -apple-system, sans-serif';
    ctx.textBaseline = 'middle';
    ctx.fillText(`${this.profile.name.split(' ')[0]} · ${status}`, 58, 37);
    this.tagTex.needsUpdate = true;
  }

  #buildRing() {
    const ring = new THREE.Mesh(
      new THREE.RingGeometry(1.95, 2.08, 72),
      new THREE.MeshBasicMaterial({ color: this.profile.accent, transparent: true, opacity: 0, depthWrite: false, toneMapped: false }),
    );
    ring.rotation.x = -Math.PI / 2;
    ring.position.set(0, 0.012, 0.25);
    this.group.add(ring);
    this.ring = ring;
  }

  #buildHitbox() {
    const hit = new THREE.Mesh(new THREE.BoxGeometry(3.2, 2.1, 2.4), new THREE.MeshBasicMaterial({ visible: false }));
    hit.position.set(0, 1.05, 0.35);
    hit.userData.agentId = this.profile.id;
    this.group.add(hit);
    this.hitbox = hit;
  }

  // Called with fresh agent snapshots from the server.
  sync(agent) {
    if (!agent) return;
    const signKey = `${Math.round(agent.pnl.day)}|${agent.status}`;
    if (signKey !== this.lastSign) {
      this.lastSign = signKey;
      this.drawSign(agent);
    }
    if (agent.status !== this.lastStatus) {
      this.lastStatus = agent.status;
      this.drawTag(agent.status, agent.mood);
    }
    this.avatar.setState({ mood: agent.mood, status: agent.status });
  }

  update(dt, t) {
    this.avatar.update(dt);
    const target = this.selected ? 0.85 : this.hover ? 0.5 : 0;
    const pulse = this.selected ? 0.15 * Math.sin(t * 3) : 0;
    this.ring.material.opacity = THREE.MathUtils.lerp(this.ring.material.opacity, target + pulse, 1 - Math.exp(-8 * dt));
    this.tag.visible = !this.selected;
  }
}
