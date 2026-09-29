import * as THREE from 'three';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import { RoomEnvironment } from 'three/addons/environments/RoomEnvironment.js';
import { EffectComposer } from 'three/addons/postprocessing/EffectComposer.js';
import { RenderPass } from 'three/addons/postprocessing/RenderPass.js';
import { UnrealBloomPass } from 'three/addons/postprocessing/UnrealBloomPass.js';
import { OutputPass } from 'three/addons/postprocessing/OutputPass.js';
import { buildRoom, PLATFORM } from './room.js';
import { Desk } from './desk.js';
import { VideoWall } from './videowall.js';
import { money, escapeHtml } from '../format.js';

const OVERVIEW = { pos: new THREE.Vector3(-2.3, 7.0, 14.6), target: new THREE.Vector3(-2.3, 0.3, -3.0) };
const FRONT_ROW_Z = -5.4;
const BACK_ROW_Z = 1.9;
const XS = [-10, -5, 0, 5, 10];

const easeInOut = (t) => (t < 0.5 ? 4 * t * t * t : 1 - (-2 * t + 2) ** 3 / 2);

export class TradingFloor {
  constructor(canvas, overlay, store) {
    this.canvas = canvas;
    this.overlay = overlay;
    this.store = store;
    this.desks = new Map();
    this.bubbles = new Map();
    this.focused = null;
    this.hovered = null;
    this.active = true;
    this.quality = true;
    this.listeners = { select: [], quality: [] };
    this.lastFrame = performance.now();
    this.elapsed = 0;
    this.tween = null;
    this.refreshIndex = 0;
    this.refreshTimer = 0;
    this.focusTimer = 0;
    this.wallTimer = 0;
    this.frameTimes = [];
    this.autoQuality = true;

    this.#initRenderer();
    this.#initScene();
    this.#initInput();
    window.addEventListener('resize', () => this.#resize());
    this.#resize();
    this.renderer.setAnimationLoop(() => this.#frame());
  }

  on(evt, fn) {
    this.listeners[evt].push(fn);
  }

  #emit(evt, v) {
    for (const fn of this.listeners[evt]) fn(v);
  }

  #initRenderer() {
    const r = new THREE.WebGLRenderer({ canvas: this.canvas, antialias: true, powerPreference: 'high-performance' });
    r.setPixelRatio(Math.min(window.devicePixelRatio, 1.75));
    r.shadowMap.enabled = true;
    r.shadowMap.type = THREE.PCFShadowMap;
    r.toneMapping = THREE.ACESFilmicToneMapping;
    r.toneMappingExposure = 1.15;
    r.outputColorSpace = THREE.SRGBColorSpace;
    this.renderer = r;
  }

  #initScene() {
    const scene = new THREE.Scene();
    scene.background = new THREE.Color('#05070b');
    scene.fog = new THREE.Fog('#05070b', 38, 70);
    const pmrem = new THREE.PMREMGenerator(this.renderer);
    scene.environment = pmrem.fromScene(new RoomEnvironment(), 0.04).texture;
    scene.environmentIntensity = 0.28;
    this.scene = scene;

    this.camera = new THREE.PerspectiveCamera(50, 1, 0.1, 200);
    this.camera.position.copy(OVERVIEW.pos);
    this.controls = new OrbitControls(this.camera, this.canvas);
    this.controls.target.copy(OVERVIEW.target);
    this.controls.enableDamping = true;
    this.controls.dampingFactor = 0.08;
    this.controls.maxPolarAngle = 1.5;
    this.controls.minDistance = 1.2;
    this.controls.maxDistance = 38;
    this.controls.screenSpacePanning = true;
    this.controls.update();

    buildRoom(scene);
    this.wall = new VideoWall(scene);

    this.composer = new EffectComposer(this.renderer);
    this.composer.addPass(new RenderPass(scene, this.camera));
    this.bloom = new UnrealBloomPass(new THREE.Vector2(512, 512), 0.38, 0.4, 0.93);
    this.composer.addPass(this.bloom);
    this.composer.addPass(new OutputPass());
  }

  // Called once profiles are known.
  buildDesks(profiles) {
    if (this.desks.size) return;
    profiles.forEach((p, i) => {
      const desk = new Desk(p, i);
      const back = i >= 5;
      desk.group.position.set(XS[i % 5], back ? PLATFORM.height : 0, back ? BACK_ROW_Z : FRONT_ROW_Z);
      this.scene.add(desk.group);
      this.desks.set(p.id, desk);
    });
    this.hitboxes = [...this.desks.values()].map((d) => d.hitbox);
  }

  #initInput() {
    const ray = new THREE.Raycaster();
    const ndc = new THREE.Vector2();
    let down = null;
    this.tip = document.createElement('div');
    this.tip.className = 'hover-tip';
    this.tip.hidden = true;
    this.overlay.appendChild(this.tip);

    const pick = (e) => {
      if (!this.hitboxes) return null;
      const rect = this.canvas.getBoundingClientRect();
      ndc.set(((e.clientX - rect.left) / rect.width) * 2 - 1, -((e.clientY - rect.top) / rect.height) * 2 + 1);
      ray.setFromCamera(ndc, this.camera);
      const hit = ray.intersectObjects(this.hitboxes, false)[0];
      return hit ? hit.object.userData.agentId : null;
    };

    this.canvas.addEventListener('pointerdown', (e) => {
      down = { x: e.clientX, y: e.clientY };
    });
    this.canvas.addEventListener('pointerup', (e) => {
      if (!down) return;
      const moved = Math.hypot(e.clientX - down.x, e.clientY - down.y);
      down = null;
      if (moved > 6) return;
      const id = pick(e);
      if (id) this.#emit('select', id);
    });
    this.canvas.addEventListener('pointermove', (e) => {
      if (e.buttons) {
        this.tip.hidden = true;
        return;
      }
      const id = pick(e);
      if (id !== this.hovered) {
        if (this.hovered) this.desks.get(this.hovered).hover = false;
        this.hovered = id;
        if (id) this.desks.get(id).hover = true;
        this.canvas.style.cursor = id ? 'pointer' : '';
      }
      if (id && id !== this.focused) {
        const p = this.store.profileById[id];
        const a = this.store.agents[id];
        const day = a?.pnl.day ?? 0;
        this.tip.innerHTML = `<b>${escapeHtml(p.name)}</b>${escapeHtml(p.desk)} · ${escapeHtml(a?.status ?? '')} · <span class="${day > 0.5 ? 'pos' : day < -0.5 ? 'neg' : ''}">${money(day, { sign: true })}</span>`;
        this.tip.style.left = `${e.clientX}px`;
        this.tip.style.top = `${e.clientY - 58}px`;
        this.tip.hidden = false;
      } else {
        this.tip.hidden = true;
      }
    });
    this.canvas.addEventListener('pointerleave', () => {
      this.tip.hidden = true;
    });
  }

  #resize() {
    const w = this.canvas.clientWidth || window.innerWidth;
    const h = this.canvas.clientHeight || window.innerHeight;
    this.renderer.setSize(w, h, false);
    this.composer.setSize(w, h);
    this.camera.aspect = w / h;
    this.camera.updateProjectionMatrix();
  }

  setActive(on) {
    this.active = on;
    if (on) this.lastFrame = performance.now();
  }

  setQuality(on) {
    this.quality = on;
    this.renderer.setPixelRatio(on ? Math.min(window.devicePixelRatio, 1.75) : 1);
    this.renderer.shadowMap.enabled = on;
    this.scene.traverse((o) => {
      if (o.material) {
        const mats = Array.isArray(o.material) ? o.material : [o.material];
        for (const m of mats) m.needsUpdate = true;
      }
    });
    this.#resize();
    this.#emit('quality', on);
  }

  // ---- camera director ----------------------------------------------------------------
  #flyTo(pos, target, duration = 1.6, onDone) {
    this.tween = {
      fromPos: this.camera.position.clone(),
      fromTarget: this.controls.target.clone(),
      toPos: pos.clone(),
      toTarget: target.clone(),
      t: 0,
      duration,
      onDone,
    };
    this.controls.enabled = false;
  }

  focusAgent(id) {
    const desk = this.desks.get(id);
    if (!desk) return;
    if (this.focused && this.focused !== id) {
      const prev = this.desks.get(this.focused);
      prev.selected = false;
      prev.avatar.backToWork();
    }
    this.focused = id;
    desk.selected = true;
    this.tip.hidden = true;
    const base = desk.group.position;
    const camPos = base.clone().add(new THREE.Vector3(1.55, 1.95, 4.15));
    const target = base.clone().add(new THREE.Vector3(0.1, 1.3, 0.55));
    // Frame the trader in the free half of the screen (the agent panel covers the right side).
    const side = new THREE.Vector3().subVectors(target, camPos).cross(new THREE.Vector3(0, 1, 0)).normalize();
    const offset = window.innerWidth > 1100 ? 0.55 : 0;
    camPos.addScaledVector(side, offset);
    target.addScaledVector(side, offset);
    this.#flyTo(camPos, target, 1.5, () => {
      const local = desk.group.worldToLocal(this.camera.position.clone());
      desk.avatar.greet(local);
    });
    // Start turning a little before the camera lands.
    setTimeout(() => {
      if (this.focused === id) desk.avatar.greet(desk.group.worldToLocal(camPos.clone()));
    }, 700);
  }

  overview() {
    if (this.focused) {
      const d = this.desks.get(this.focused);
      d.selected = false;
      d.avatar.backToWork();
      this.clearBubble(this.focused);
    }
    this.focused = null;
    this.#flyTo(OVERVIEW.pos, OVERVIEW.target, 1.4);
  }

  // ---- speech bubbles ---------------------------------------------------------------------
  showBubble(id, html, { duration = 4000, big = false } = {}) {
    const desk = this.desks.get(id);
    if (!desk) return;
    this.clearBubble(id);
    const el = document.createElement('div');
    el.className = `bubble${big ? ' big' : ''}`;
    el.innerHTML = html;
    this.overlay.appendChild(el);
    const b = { el, desk, until: duration ? performance.now() + duration : Infinity };
    this.bubbles.set(id, b);
    return b;
  }

  updateBubble(id, html) {
    const b = this.bubbles.get(id);
    if (b) b.el.innerHTML = html;
  }

  clearBubble(id) {
    const b = this.bubbles.get(id);
    if (!b) return;
    b.el.remove();
    this.bubbles.delete(id);
  }

  #placeBubbles(now) {
    const v = new THREE.Vector3();
    const w = this.canvas.clientWidth;
    const h = this.canvas.clientHeight;
    for (const [id, b] of this.bubbles) {
      if (now > b.until) {
        b.el.classList.add('fade');
        if (now > b.until + 400) this.clearBubble(id);
        continue;
      }
      b.desk.avatar.headWorldPosition(v);
      v.y += 0.26;
      v.project(this.camera);
      const visible = v.z < 1 && Math.abs(v.x) < 1.1 && Math.abs(v.y) < 1.1;
      b.el.style.display = visible ? '' : 'none';
      if (visible) b.el.style.transform = `translate(${((v.x + 1) / 2) * w}px, ${((1 - v.y) / 2) * h}px) translate(-50%, -100%)`;
    }
  }

  // ---- per-frame ----------------------------------------------------------------------------
  #screenData(id) {
    const s = this.store;
    const p = s.profileById[id];
    const symbol = p.symbols[0];
    return {
      agent: s.agents[id],
      profile: p,
      symbol,
      sym: s.symbols[symbol],
      bars: s.candles[symbol],
      quote: s.quotes[symbol],
      quotes: s.quotes,
      symbols: s.symbols,
      curve: s.dayCurves[id],
      ticks: s.ticks[symbol],
      allocation: s.config?.allocation ?? 1e7,
      marketTime: s.fund?.marketTime,
    };
  }

  sync() {
    for (const [id, desk] of this.desks) desk.sync(this.store.agents[id]);
  }

  #frame() {
    if (!this.active || document.hidden) return;
    const now = performance.now();
    // realDt drives refresh timers; dt (clamped) drives animation so slow frames don't jump.
    const realDt = Math.min(1, (now - this.lastFrame) / 1000);
    this.lastFrame = now;
    const dt = Math.min(0.05, realDt);
    this.elapsed += dt;
    const t = this.elapsed;

    if (this.tween) {
      const tw = this.tween;
      tw.t += Math.min(0.25, realDt) / tw.duration;
      const k = easeInOut(Math.min(1, tw.t));
      this.camera.position.lerpVectors(tw.fromPos, tw.toPos, k);
      this.camera.position.y += Math.sin(Math.PI * k) * 0.8 * (tw.fromPos.distanceTo(tw.toPos) > 6 ? 1 : 0);
      this.controls.target.lerpVectors(tw.fromTarget, tw.toTarget, k);
      this.camera.lookAt(this.controls.target);
      if (tw.t >= 1) {
        this.tween = null;
        this.controls.enabled = true;
        tw.onDone?.();
      }
    } else {
      this.controls.update();
    }

    for (const desk of this.desks.values()) desk.update(dt, t);
    this.wall.tick(dt);

    if (this.store.ready) {
      // Monitor refresh: the focused desk often, the rest round-robin.
      this.refreshTimer += realDt;
      if (this.refreshTimer > 0.12 && this.desks.size) {
        this.refreshTimer = 0;
        const ids = [...this.desks.keys()];
        const id = ids[this.refreshIndex++ % ids.length];
        if (id !== this.focused) this.desks.get(id).screens.draw(this.#screenData(id));
      }
      if (this.focused) {
        this.focusTimer += realDt;
        if (this.focusTimer > 0.25) {
          this.focusTimer = 0;
          this.desks.get(this.focused).screens.draw(this.#screenData(this.focused));
        }
      }
      this.wallTimer += realDt;
      if (this.wallTimer > 1) {
        this.wallTimer = 0;
        this.wall.draw(this.store);
        this.wall.drawTape(this.store);
      }
    }

    this.#placeBubbles(now);
    if (this.quality) this.composer.render(dt);
    else this.renderer.render(this.scene, this.camera);
    this.#watchPerformance(realDt);
  }

  // Drop to the fast path automatically if the machine struggles.
  #watchPerformance(realDt) {
    if (!this.quality || !this.autoQuality) return;
    this.frameTimes.push(realDt);
    if (this.frameTimes.length < 180) return;
    const avg = this.frameTimes.reduce((a, b) => a + b, 0) / this.frameTimes.length;
    this.frameTimes = [];
    if (avg > 1 / 24) this.setQuality(false);
  }
}
