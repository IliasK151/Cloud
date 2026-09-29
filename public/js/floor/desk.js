import * as THREE from 'three';
import { RoundedBoxGeometry } from 'three/addons/geometries/RoundedBoxGeometry.js';
import { Avatar } from './avatar.js';
import { DeskScreens, SLOTS } from './screens.js';
import { blobTexture, canvasTexture } from './textures.js';

// One trading desk: a clean solid-surface bench with a six-screen monitor arm, keyboard,
// mouse, dealer board and a few personal touches, plus the trader in their chair.
// Desk-local: the trader sits on +Z and faces -Z. Name and P&L labels are HTML (floor.js).

let shared = null;
function materials() {
  if (shared) return shared;
  const std = (color, o = {}) => new THREE.MeshStandardMaterial({ color, roughness: 0.6, metalness: 0.05, ...o });
  const keys = canvasTexture(256, 96);
  keys.ctx.fillStyle = '#2b2e34';
  keys.ctx.fillRect(0, 0, 256, 96);
  keys.ctx.fillStyle = '#3b3f46';
  for (let r = 0; r < 5; r++) for (let c = 0; c < 18; c++) keys.ctx.fillRect(4 + c * 14, 4 + r * 18, 11, 14);
  keys.texture.needsUpdate = true;
  shared = {
    top: new THREE.MeshPhysicalMaterial({ color: '#b9b6b0', roughness: 0.5, clearcoat: 0.2, clearcoatRoughness: 0.5 }),
    edge: std('#cfccc6', { roughness: 0.5 }),
    frame: std('#1a1b1f', { roughness: 0.45, metalness: 0.4 }),
    panel: std('#26282d', { roughness: 0.8 }),
    arm: std('#2a2c31', { roughness: 0.35, metalness: 0.7 }),
    bezel: std('#0c0d10', { roughness: 0.35, metalness: 0.3 }),
    back: std('#1b1c20', { roughness: 0.55, metalness: 0.2 }),
    kb: std('#c9ccd2', { roughness: 0.35, metalness: 0.6 }),
    keys: std('#ffffff', { map: keys.texture, roughness: 0.7 }),
    mouse: std('#e9eaec', { roughness: 0.3 }),
    paper: std('#f4f2ec', { roughness: 0.95 }),
    notebook: std('#2c2f35', { roughness: 0.8 }),
    turret: std('#141519', { roughness: 0.4, metalness: 0.2 }),
    turretScreen: new THREE.MeshBasicMaterial({ color: '#3b6fb5', toneMapped: false }),
    pot: std('#f0efeb', { roughness: 0.6 }),
    leaf: std('#4f7a4a', { roughness: 0.7, flatShading: true }),
    soil: std('#2b2119', { roughness: 1 }),
    blob: new THREE.MeshBasicMaterial({ map: blobTexture(), transparent: true, depthWrite: false, opacity: 0.55 }),
  };
  return shared;
}

// Monitor layout (desk-local).
const MONITORS = [
  { slot: 'position', x: -0.66, y: 1.06, z: -0.2, ry: 0.32, rx: 0 },
  { slot: 'chart', x: 0, y: 1.06, z: -0.32, ry: 0, rx: 0 },
  { slot: 'dom', x: 0.66, y: 1.06, z: -0.2, ry: -0.32, rx: 0 },
  { slot: 'terminal', x: -0.66, y: 1.47, z: -0.24, ry: 0.32, rx: 0.12 },
  { slot: 'pnl', x: 0, y: 1.47, z: -0.36, ry: 0, rx: 0.12 },
  { slot: 'watch', x: 0.66, y: 1.47, z: -0.24, ry: -0.32, rx: 0.12 },
];

const TOP_Y = 0.7625;

export class Desk {
  constructor(profile, index) {
    this.profile = profile;
    this.index = index;
    this.group = new THREE.Group();
    this.group.name = `desk-${profile.id}`;
    this.screens = new DeskScreens();
    this.#buildFurniture();
    this.#buildMonitors();
    this.avatar = new Avatar(profile, index);
    this.avatar.root.position.set(0, 0, 0.78);
    this.group.add(this.avatar.root);
    this.#buildRing();
    this.#buildHitbox();
    this.hover = false;
    this.selected = false;
  }

  #buildFurniture() {
    const m = materials();
    const g = this.group;
    const top = new THREE.Mesh(new RoundedBoxGeometry(3.0, 0.035, 1.15, 3, 0.012), m.top);
    top.position.set(0, TOP_Y - 0.0175, 0);
    top.castShadow = top.receiveShadow = true;
    g.add(top);
    // Slim T-leg frames and a cable spine.
    for (const s of [-1, 1]) {
      const post = new THREE.Mesh(new RoundedBoxGeometry(0.06, TOP_Y - 0.06, 0.06, 2, 0.01), m.frame);
      post.position.set(s * 1.32, (TOP_Y - 0.06) / 2 + 0.03, -0.05);
      post.castShadow = true;
      g.add(post);
      const foot = new THREE.Mesh(new RoundedBoxGeometry(0.07, 0.035, 0.95, 2, 0.012), m.frame);
      foot.position.set(s * 1.32, 0.0175, -0.05);
      foot.castShadow = foot.receiveShadow = true;
      g.add(foot);
      const rail = new THREE.Mesh(new RoundedBoxGeometry(0.05, 0.04, 1.0, 2, 0.01), m.frame);
      rail.position.set(s * 1.32, TOP_Y - 0.055, -0.05);
      g.add(rail);
    }
    const spine = new THREE.Mesh(new RoundedBoxGeometry(2.6, 0.12, 0.08, 2, 0.02), m.frame);
    spine.position.set(0, TOP_Y - 0.1, -0.42);
    g.add(spine);
    const modesty = new THREE.Mesh(new RoundedBoxGeometry(2.7, 0.34, 0.02, 2, 0.008), m.panel);
    modesty.position.set(0, 0.5, -0.54);
    modesty.castShadow = true;
    g.add(modesty);

    // Monitor arm: a central pole with two crossbars.
    const pole = new THREE.Mesh(new THREE.CylinderGeometry(0.022, 0.022, 0.95, 16), m.arm);
    pole.position.set(0, TOP_Y + 0.475, -0.46);
    pole.castShadow = true;
    g.add(pole);
    const clamp = new THREE.Mesh(new RoundedBoxGeometry(0.12, 0.03, 0.1, 2, 0.01), m.arm);
    clamp.position.set(0, TOP_Y + 0.015, -0.46);
    g.add(clamp);
    for (const y of [1.06, 1.47]) {
      const bar = new THREE.Mesh(new RoundedBoxGeometry(1.4, 0.028, 0.03, 2, 0.01), m.arm);
      bar.position.set(0, y, -0.44);
      g.add(bar);
    }

    // Keyboard, mouse, notebook and a voice dealer board.
    const kb = new THREE.Mesh(new RoundedBoxGeometry(0.44, 0.016, 0.14, 2, 0.006), m.kb);
    kb.position.set(0.05, TOP_Y + 0.008, 0.28);
    kb.castShadow = true;
    g.add(kb);
    const keys = new THREE.Mesh(new THREE.PlaneGeometry(0.41, 0.115), m.keys);
    keys.rotation.x = -Math.PI / 2;
    keys.position.set(0.05, TOP_Y + 0.0165, 0.28);
    g.add(keys);
    const mouse = new THREE.Mesh(new THREE.SphereGeometry(0.03, 16, 10), m.mouse);
    mouse.scale.set(0.9, 0.45, 1.35);
    mouse.position.set(0.42, TOP_Y + 0.012, 0.3);
    mouse.castShadow = true;
    g.add(mouse);
    const notebook = new THREE.Mesh(new RoundedBoxGeometry(0.21, 0.014, 0.29, 2, 0.005), m.notebook);
    notebook.position.set(-0.78, TOP_Y + 0.007, 0.26);
    notebook.rotation.y = 0.12;
    notebook.castShadow = true;
    g.add(notebook);
    const paper = new THREE.Mesh(new THREE.PlaneGeometry(0.19, 0.27), m.paper);
    paper.rotation.set(-Math.PI / 2, 0, 0.12);
    paper.position.set(-0.78, TOP_Y + 0.0145, 0.26);
    g.add(paper);
    const turret = new THREE.Mesh(new RoundedBoxGeometry(0.34, 0.07, 0.24, 2, 0.015), m.turret);
    turret.position.set(1.08, TOP_Y + 0.04, 0.02);
    turret.rotation.set(-0.3, -0.35, 0);
    turret.castShadow = true;
    g.add(turret);
    const tScreen = new THREE.Mesh(new THREE.PlaneGeometry(0.28, 0.18), m.turretScreen);
    tScreen.rotation.x = -Math.PI / 2;
    tScreen.position.y = 0.0355;
    turret.add(tScreen);

    // A small plant on some desks.
    if (this.index % 3 !== 1) {
      const plant = new THREE.Group();
      plant.position.set(this.index % 2 ? -1.2 : 1.25, TOP_Y, this.index % 2 ? -0.28 : 0.38);
      const pot = new THREE.Mesh(new THREE.CylinderGeometry(0.055, 0.045, 0.1, 20), m.pot);
      pot.position.y = 0.05;
      pot.castShadow = true;
      plant.add(pot);
      const soil = new THREE.Mesh(new THREE.CircleGeometry(0.05, 16), m.soil);
      soil.rotation.x = -Math.PI / 2;
      soil.position.y = 0.095;
      plant.add(soil);
      for (let i = 0; i < 9; i++) {
        const a = (i / 9) * Math.PI * 2 + this.index;
        const leaf = new THREE.Mesh(new THREE.SphereGeometry(0.03, 6, 4), m.leaf);
        leaf.scale.set(0.45, 1.6, 0.25);
        leaf.position.set(Math.sin(a) * 0.028, 0.14 + (i % 3) * 0.012, Math.cos(a) * 0.028);
        leaf.rotation.set(Math.cos(a) * 0.55, 0, -Math.sin(a) * 0.55);
        leaf.castShadow = true;
        plant.add(leaf);
      }
      g.add(plant);
    }

    // Soft contact shadow (used when ambient occlusion is off).
    const shadow = new THREE.Mesh(new THREE.PlaneGeometry(3.8, 2.6), m.blob);
    shadow.rotation.x = -Math.PI / 2;
    shadow.position.set(0, 0.004, 0.2);
    g.add(shadow);
    this.blob = shadow;
  }

  #buildMonitors() {
    const m = materials();
    const screenMat = new THREE.MeshBasicMaterial({ map: this.screens.texture, toneMapped: false });
    this.screenMeshes = [];
    for (const mon of MONITORS) {
      const grp = new THREE.Group();
      grp.position.set(mon.x, mon.y, mon.z);
      grp.rotation.set(mon.rx, mon.ry, 0, 'YXZ');
      const bezel = new THREE.Mesh(new RoundedBoxGeometry(0.636, 0.382, 0.012, 2, 0.004), m.bezel);
      bezel.position.z = 0.002;
      bezel.castShadow = true;
      grp.add(bezel);
      const back = new THREE.Mesh(new RoundedBoxGeometry(0.5, 0.26, 0.03, 2, 0.012), m.back);
      back.position.z = -0.02;
      grp.add(back);
      const geo = new THREE.PlaneGeometry(0.622, 0.366);
      const [c, r] = SLOTS[mon.slot];
      DeskScreens.uvFor(c, r, geo);
      const screen = new THREE.Mesh(geo, screenMat);
      screen.position.z = 0.0085;
      grp.add(screen);
      this.screenMeshes.push(screen);
      this.group.add(grp);
    }
  }

  #buildRing() {
    const ring = new THREE.Mesh(
      new THREE.RingGeometry(0.62, 0.66, 64),
      new THREE.MeshBasicMaterial({ color: '#ffffff', transparent: true, opacity: 0, depthWrite: false, toneMapped: false }),
    );
    ring.rotation.x = -Math.PI / 2;
    ring.position.set(0, 0.008, 0.85);
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
    this.avatar.setState({ mood: agent.mood, status: agent.status });
  }

  update(dt, t) {
    this.avatar.update(dt);
    const target = this.selected ? 0.35 : this.hover ? 0.22 : 0;
    const pulse = this.selected ? 0.06 * Math.sin(t * 2.5) : 0;
    this.ring.material.opacity = THREE.MathUtils.lerp(this.ring.material.opacity, target + pulse, 1 - Math.exp(-8 * dt));
    this.ring.visible = this.ring.material.opacity > 0.005;
  }
}
