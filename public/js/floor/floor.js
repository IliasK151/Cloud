import * as THREE from 'three';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import { RoomEnvironment } from 'three/addons/environments/RoomEnvironment.js';
import { EffectComposer } from 'three/addons/postprocessing/EffectComposer.js';
import { RenderPass } from 'three/addons/postprocessing/RenderPass.js';
import { UnrealBloomPass } from 'three/addons/postprocessing/UnrealBloomPass.js';
import { GTAOPass } from 'three/addons/postprocessing/GTAOPass.js';
import { OutputPass } from 'three/addons/postprocessing/OutputPass.js';
import { buildRoom, PLATFORM, LAB, DAY, DESK_XS, FRONT_ROW_Z, BACK_ROW_Z, LAB_ROW_Z, DAY_ROW_Z } from './room.js';
import { Desk } from './desk.js';
import { VideoWall } from './videowall.js';
import { money, escapeHtml, STATUS_COLORS, deskKey } from '../format.js';
import { deskBook } from '../book.js';
import { voice } from '../voice.js';
import { fpsFor } from './power.js';

const OVERVIEW = { pos: new THREE.Vector3(-2.4, 18.5, 33.5), target: new THREE.Vector3(-2.4, 0.0, 0.8) };

const LABEL_OFFSET = new THREE.Vector3(0, 2.25, 0.3);

const easeInOut = (t) => (t < 0.5 ? 4 * t * t * t : 1 - (-2 * t + 2) ** 3 / 2);

export class TradingFloor {
  constructor(canvas, overlay, store) {
    this.canvas = canvas;
    this.overlay = overlay;
    this.store = store;
    this.desks = new Map();
    this.labels = new Map();
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
    // Battery saver (on unless switched off in Settings): a calmer frame rate when nobody is
    // touching the floor, plain graphics on battery, and no drawing at all on other tabs.
    this.eco = true;
    this.onBattery = false;
    this.qualityBeforeBattery = false;
    this.lastInput = performance.now();
    this.lastRender = 0;

    this.#initRenderer();
    this.#initScene();
    this.#initInput();
    window.addEventListener('resize', () => this.#resize());
    for (const evt of ['pointermove', 'pointerdown', 'wheel', 'keydown']) {
      window.addEventListener(evt, () => { this.lastInput = performance.now(); }, { passive: true });
    }
    this.#resize();
    this.#loop(true);
  }

  // The render loop runs only while the floor is on screen.
  #loop(on) {
    if (on === this.looping) return;
    this.looping = on;
    this.renderer.setAnimationLoop(on ? () => this.#frame() : null);
  }

  // Frames per second the floor needs right now (0: as fast as the display). Moving the
  // camera, talking to a desk or using the mouse gets a smooth picture; a floor nobody is
  // touching only needs to keep the traders and screens moving.
  fpsCap(now = performance.now()) {
    return fpsFor({
      eco: this.eco,
      battery: this.onBattery,
      busy: !!this.tween || !!(this.focused && voice.isSpeaking(this.focused)) || now - this.lastInput < 15_000,
      focused: document.hasFocus(),
    });
  }

  setEco(on) {
    this.eco = on;
    this.#applyPower();
  }

  // On battery the saver also switches the shadows and glow off, and back on with the charger.
  setPower({ battery }) {
    this.onBattery = !!battery;
    this.#applyPower();
  }

  #applyPower() {
    const saving = this.eco && this.onBattery;
    if (saving && this.quality) {
      this.qualityBeforeBattery = true;
      this.setQuality(false, { auto: true });
    } else if (!saving && this.qualityBeforeBattery) {
      this.qualityBeforeBattery = false;
      this.setQuality(true, { auto: true });
    }
  }

  on(evt, fn) {
    this.listeners[evt].push(fn);
  }

  #emit(evt, ...v) {
    for (const fn of this.listeners[evt]) fn(...v);
  }

  #initRenderer() {
    const r = new THREE.WebGLRenderer({ canvas: this.canvas, antialias: true, powerPreference: 'high-performance' });
    r.setPixelRatio(Math.min(window.devicePixelRatio, 1.5));
    r.shadowMap.enabled = true;
    r.shadowMap.type = THREE.PCFShadowMap;
    r.toneMapping = THREE.NeutralToneMapping;
    r.toneMappingExposure = 1.0;
    r.outputColorSpace = THREE.SRGBColorSpace;
    this.renderer = r;
  }

  #initScene() {
    const scene = new THREE.Scene();
    scene.background = new THREE.Color('#0c0d10');
    scene.fog = new THREE.Fog('#0c0d10', 40, 75);
    const pmrem = new THREE.PMREMGenerator(this.renderer);
    scene.environment = pmrem.fromScene(new RoomEnvironment(), 0.04).texture;
    scene.environmentIntensity = 0.32;
    this.scene = scene;

    this.camera = new THREE.PerspectiveCamera(45, 1, 0.05, 200);
    this.camera.position.copy(OVERVIEW.pos);
    this.controls = new OrbitControls(this.camera, this.canvas);
    this.controls.target.copy(OVERVIEW.target);
    this.controls.enableDamping = true;
    this.controls.dampingFactor = 0.08;
    this.controls.maxPolarAngle = 1.5;
    this.controls.minDistance = 0.8;
    this.controls.maxDistance = 44;
    this.controls.screenSpacePanning = true;
    this.controls.update();

    buildRoom(scene);
    this.wall = new VideoWall(scene);

    // Multisampled target so edges stay crisp through post-processing.
    const rt = new THREE.WebGLRenderTarget(1, 1, { type: THREE.HalfFloatType, samples: 4 });
    this.composer = new EffectComposer(this.renderer, rt);
    this.composer.addPass(new RenderPass(scene, this.camera));
    this.ao = new GTAOPass(scene, this.camera, 1, 1);
    this.ao.updateGtaoMaterial({ radius: 0.45, distanceExponent: 1.4, thickness: 1.2, scale: 1.1, samples: 12 });
    this.ao.updatePdMaterial({ lumaPhi: 10, depthPhi: 2, normalPhi: 3, radius: 6, rings: 2, samples: 12 });
    this.ao.blendIntensity = 0.85;
    this.composer.addPass(this.ao);
    this.bloom = new UnrealBloomPass(new THREE.Vector2(512, 512), 0.22, 0.5, 0.92);
    this.composer.addPass(this.bloom);
    this.composer.addPass(new OutputPass());
  }

  // Called once profiles are known.
  buildDesks(profiles) {
    if (this.desks.size) return;
    profiles.forEach((p, i) => {
      const desk = new Desk(p, i);
      // Trading rows by position, then the lab and the day trading desk on their own tiers.
      const row = p.dayTrader ? 3 : p.lab ? 2 : Math.min(1, Math.floor(i / 5));
      desk.group.position.set(DESK_XS[i % 5], [0, PLATFORM.height, LAB.height, DAY.height][row], [FRONT_ROW_Z, BACK_ROW_Z, LAB_ROW_Z, DAY_ROW_Z][row]);
      desk.blob.visible = !this.quality;
      this.scene.add(desk.group);
      this.desks.set(p.id, desk);
      this.#buildLabel(p, i);
    });
    this.hitboxes = [...this.desks.values()].map((d) => d.hitbox);
  }

  #initInput() {
    const ray = new THREE.Raycaster();
    const ndc = new THREE.Vector2();
    let down = null;

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
      if (e.buttons) return;
      const id = pick(e);
      if (id !== this.hovered) {
        if (this.hovered) {
          this.desks.get(this.hovered).hover = false;
          this.labels.get(this.hovered)?.el.classList.remove('hover');
        }
        this.hovered = id;
        if (id) {
          this.desks.get(id).hover = true;
          this.labels.get(id)?.el.classList.add('hover');
        }
        this.canvas.style.cursor = id ? 'pointer' : '';
      }
    });
    this.canvas.addEventListener('pointerleave', () => {
      if (!this.hovered) return;
      this.desks.get(this.hovered).hover = false;
      this.labels.get(this.hovered)?.el.classList.remove('hover');
      this.hovered = null;
    });
  }

  // Minimal floating name tag above each desk: name, desk and today's P&L.
  #buildLabel(p, i) {
    const el = document.createElement('button');
    el.className = 'desk-tag';
    el.type = 'button';
    const key = deskKey(p, i);
    el.innerHTML = `<span class="k${p.lab ? ' lab' : p.dayTrader ? ' daytrade' : ''}">${key}</span><span class="who"><b>${escapeHtml(p.name.split(' ')[0])}</b><small>${escapeHtml(p.desk)}</small></span><span class="v"></span><i class="st"></i>`;
    el.style.setProperty('--accent', p.accent);
    el.addEventListener('click', () => this.#emit('select', p.id));
    this.overlay.appendChild(el);
    this.labels.set(p.id, { el, v: el.querySelector('.v'), st: el.querySelector('.st'), key: '' });
  }

  #placeLabels() {
    const v = new THREE.Vector3();
    const w = this.canvas.clientWidth;
    const h = this.canvas.clientHeight;
    const cam = this.camera.position;
    for (const [id, lab] of this.labels) {
      const desk = this.desks.get(id);
      const hide = !!this.focused || this.tween?.focus;
      v.copy(desk.group.position).add(LABEL_OFFSET);
      const dist = v.distanceTo(cam);
      v.project(this.camera);
      const visible = !hide && v.z < 1 && Math.abs(v.x) < 1.05 && Math.abs(v.y) < 1.05;
      lab.el.classList.toggle('off', !visible);
      if (!visible) continue;
      const scale = THREE.MathUtils.clamp(15 / dist, 0.72, 1.12);
      lab.el.style.transform = `translate(${((v.x + 1) / 2) * w}px, ${((1 - v.y) / 2) * h}px) translate(-50%, -100%) scale(${scale.toFixed(3)})`;
      lab.el.style.zIndex = String(Math.round(1000 - dist * 10));
    }
  }

  #resize() {
    const w = this.canvas.clientWidth || window.innerWidth;
    const h = this.canvas.clientHeight || window.innerHeight;
    this.renderer.setSize(w, h, false);
    this.composer.setSize(w, h);
    this.ao?.setSize(Math.ceil(w * 0.75), Math.ceil(h * 0.75));
    this.camera.aspect = w / h;
    this.camera.updateProjectionMatrix();
  }

  setActive(on) {
    this.active = on;
    if (on) this.lastFrame = performance.now();
    this.#loop(on || !this.eco);
  }

  setQuality(on, { auto = false } = {}) {
    this.quality = on;
    this.renderer.setPixelRatio(on ? Math.min(window.devicePixelRatio, 1.5) : 1);
    this.renderer.shadowMap.enabled = on;
    for (const d of this.desks.values()) d.blob.visible = !on;
    this.scene.traverse((o) => {
      if (o.material) {
        const mats = Array.isArray(o.material) ? o.material : [o.material];
        for (const m of mats) m.needsUpdate = true;
      }
    });
    this.#resize();
    this.#emit('quality', on, auto);
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
    const base = desk.group.position;
    // A conversational close-up: slightly above eye level, off to the side of the monitors.
    const camPos = base.clone().add(new THREE.Vector3(1.05, 1.62, 2.55));
    const target = base.clone().add(new THREE.Vector3(0.05, 1.12, 0.72));
    // Frame the trader in the free part of the screen (the agent panel covers the right side).
    const side = new THREE.Vector3().subVectors(target, camPos).cross(new THREE.Vector3(0, 1, 0)).normalize();
    const offset = window.innerWidth > 1100 ? 0.42 : 0;
    camPos.addScaledVector(side, offset);
    target.addScaledVector(side, offset);
    this.#flyTo(camPos, target, 1.5, () => {
      desk.avatar.greet(desk.group.worldToLocal(this.camera.position.clone()));
    });
    this.tween.focus = true;
    // Start turning a little before the camera lands.
    setTimeout(() => {
      if (this.focused === id) desk.avatar.greet(desk.group.worldToLocal(camPos.clone()));
    }, 650);
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
    const symbol = s.agents[id]?.symbol || p.symbols[0];
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
    const colors = STATUS_COLORS;
    for (const [id, desk] of this.desks) {
      const a = this.store.agents[id];
      desk.sync(a);
      const lab = this.labels.get(id);
      if (!lab || !a) continue;
      const b = deskBook(this.store, id);
      const key = `${b.na}|${Math.round(b.day)}|${a.status}`;
      if (key === lab.key) continue;
      lab.key = key;
      lab.v.textContent = b.na ? 'paper' : money(b.day, { sign: true, compact: Math.abs(b.day) >= 1e5 });
      lab.v.className = `v ${b.na ? 'na' : b.day > 0.5 ? 'pos' : b.day < -0.5 ? 'neg' : ''}`;
      lab.st.style.background = colors[a.status] || '#3fb950';
      lab.el.title = `${this.store.profileById[id].name} · ${a.status}`;
    }
  }

  #frame() {
    if (!this.active || document.hidden) return;
    const now = performance.now();
    const cap = this.fpsCap(now);
    if (cap && now - this.lastRender < 1000 / cap - 4) return;
    this.lastRender = now;
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

    if (this.focused) {
      const av = this.desks.get(this.focused).avatar;
      av.lookAt(this.camera.position);
      av.speaking = voice.isSpeaking(this.focused);
      av.speech = av.speaking ? voice.level(this.focused) : 0;
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
    this.#placeLabels();
    if (this.quality) this.composer.render(dt);
    else this.renderer.render(this.scene, this.camera);
    this.#watchPerformance(realDt, cap);
  }

  // Drop to the fast path automatically if the machine struggles (judged against the frame
  // rate the battery saver asked for, not the display's).
  #watchPerformance(realDt, cap = 0) {
    if (!this.quality || !this.autoQuality || (cap && cap < 24)) {
      this.frameTimes = [];
      return;
    }
    this.frameTimes.push(realDt);
    if (this.frameTimes.length < (cap ? 90 : 180)) return;
    const avg = this.frameTimes.reduce((a, b) => a + b, 0) / this.frameTimes.length;
    this.frameTimes = [];
    if (avg > (cap ? 1.5 / cap : 1 / 24)) this.setQuality(false);
  }
}
