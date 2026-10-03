import * as THREE from 'three';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import { api } from '../net.js';
import { escapeHtml } from '../format.js';

// The neural brain, live in 3D (Brain tab): the real network the desks ask before they trade.
//
// On the left, its senses (the ~50 facts it sees about a trade idea, coloured by group);
// in the middle, its two hidden layers; on the right, one neuron: the chance the trade ends in
// profit. Every line is one learned connection: green ones push a neuron up, red ones down,
// brighter means stronger.
//
//   A desk asks:      the signal flows left to right along the connections that carried most
//                     of it, the neurons light with what they computed, and the answer appears
//                     at the end: while it is still learning, what it WOULD do (the desk
//                     decides); once it has earned a say, TAKE, PASS or EXPLORE on paper.
//   A trade closes:   the result travels back, right to left (green: won, red: lost). The
//                     brain keeps it for its next lesson.
//   The brain learns: the connections it changed flash gold, then settle into their new colour.
//
// It draws only while something moves, so a still brain costs no battery.

const GROUP = { Trend: '#4c8dff', Location: '#f2b01e', Volatility: '#a371f7', Trade: '#2fbf71', Time: '#8b93a1', Desk: '#e58f4b', Market: '#c9ccd3', Style: '#5ec4d6' };
const POS = new THREE.Color('#2fbf71');
const NEG = new THREE.Color('#e5534b');
const GOLD = new THREE.Color('#ffd166');
const VERDICT = { take: ['TAKE', '#2fbf71'], pass: ['PASS', '#8b93a1'], explore: ['EXPLORE · paper', '#f2b01e'], yours: ['YOUR ALERT', '#4c8dff'] };
// Still learning: it says what it would do, the desk trades anyway.
const verdictOf = (t) => (t.verdict === 'learning' ? [`LEARNING · would ${t.would === 'take' ? 'take' : 'pass'}`, t.would === 'take' ? '#2f8f5b' : '#6b7280'] : VERDICT[t.verdict] || ['—', '#8b93a1']);
const STEP_MS = 650; // one layer to the next
const fmtR = (x) => (x == null ? '—' : `${x >= 0 ? '+' : '−'}${Math.abs(x).toFixed(2)}R`);
const pct = (x) => (x == null ? '—' : `${Math.round(x * 100)}%`);
const nyHour = (h) => `${String(h).padStart(2, '0')}:00`;

function dotTexture() {
  const c = document.createElement('canvas');
  c.width = c.height = 64;
  const g = c.getContext('2d');
  const grd = g.createRadialGradient(32, 32, 0, 32, 32, 32);
  grd.addColorStop(0, 'rgba(255,255,255,1)');
  grd.addColorStop(0.35, 'rgba(255,255,255,0.6)');
  grd.addColorStop(1, 'rgba(255,255,255,0)');
  g.fillStyle = grd;
  g.fillRect(0, 0, 64, 64);
  return new THREE.CanvasTexture(c);
}

export class NeuralBrain3D {
  constructor(store, root, { onSelect } = {}) {
    this.store = store;
    this.root = root;
    this.onSelect = onSelect;
    this.view = null;
    this.layers = []; // [{ pos: Vector3[], mesh: Mesh[] }]
    this.pulses = [];
    this.flashes = []; // { idx (line), t0, ms }
    this.visible = false;
    this.running = false;
    this.lastInput = 0;
    this.feed = [];
    this.#build();
    store.on('neural', (ev) => this.#onEvent(ev));
  }

  // ---- page --------------------------------------------------------------------------------
  #build() {
    this.root.innerHTML = `
      <div class="mg-head">
        <div><h2>Neural brain <span class="pill ok mg-live">LIVE</span> <span class="pill nb-mode" id="nb-mode" hidden></span></h2>
        <p class="sub" id="nb-stats">Loading the brain…</p></div>
        <div class="mg-legend">${Object.entries(GROUP).map(([g, c]) => `<span><i style="background:${c}"></i>${g}</span>`).join('')}
          <span><i style="background:${POS.getStyle()}"></i>Connection pushes up</span><span><i style="background:${NEG.getStyle()}"></i>…pushes down</span><span><i style="background:${GOLD.getStyle()}"></i>Just learned</span></div>
      </div>
      <div class="nb-say" id="nb-say" hidden></div>
      <div class="mg-body">
        <div class="mg-stage nb-stage"><canvas></canvas><div class="mg-labels"></div><div class="mg-tip" hidden></div>
          <div class="nb-banner" hidden></div>
          <p class="mg-hint">Drag to turn · scroll to zoom · hover a sense to see what it means</p></div>
        <aside class="mg-side nb-side">
          <h3>Thinking now</h3><div id="nb-now" class="nb-now"><span class="muted">Waiting for a desk to ask…</span></div>
          <h3>Recent thoughts</h3><ol class="mg-feed" id="nb-feed"></ol>
          <h3>Learning</h3><div id="nb-learn"></div>
        </aside>
      </div>
      <div class="nb-cards">
        <div class="nb-card" id="nb-tested"></div>
        <div class="nb-card" id="nb-desks"></div>
      </div>`;
    this.stage = this.root.querySelector('.mg-stage');
    this.canvas = this.root.querySelector('canvas');
    this.labelsEl = this.root.querySelector('.mg-labels');
    this.tip = this.root.querySelector('.mg-tip');
    this.banner = this.root.querySelector('.nb-banner');

    const r = new THREE.WebGLRenderer({ canvas: this.canvas, antialias: true, alpha: true, powerPreference: 'low-power' });
    r.setPixelRatio(Math.min(window.devicePixelRatio, 1.5));
    this.renderer = r;
    this.scene = new THREE.Scene();
    this.camera = new THREE.PerspectiveCamera(48, 1, 0.5, 400);
    this.camera.position.set(-42, 26, 58);
    this.scene.add(new THREE.AmbientLight(0xffffff, 0.8));
    const sun = new THREE.DirectionalLight(0xffffff, 1.4);
    sun.position.set(20, 40, 30);
    this.scene.add(sun);
    this.controls = new OrbitControls(this.camera, this.canvas);
    this.controls.enableDamping = true;
    this.controls.dampingFactor = 0.08;
    this.controls.minDistance = 15;
    this.controls.maxDistance = 160;
    this.controls.addEventListener('change', () => this.#wake());
    this.sphere = new THREE.SphereGeometry(1, 16, 12);
    this.lineGeo = new THREE.BufferGeometry();
    this.lines = new THREE.LineSegments(this.lineGeo, new THREE.LineBasicMaterial({ vertexColors: true, transparent: true, opacity: 0.9, blending: THREE.AdditiveBlending, depthWrite: false }));
    this.scene.add(this.lines);
    this.pulseGeo = new THREE.BufferGeometry();
    this.points = new THREE.Points(this.pulseGeo, new THREE.PointsMaterial({ size: 1.6, map: dotTexture(), vertexColors: true, transparent: true, blending: THREE.AdditiveBlending, depthWrite: false }));
    this.scene.add(this.points);
    this.ray = new THREE.Raycaster();

    const input = () => { this.lastInput = performance.now(); this.#wake(); };
    for (const evt of ['pointerdown', 'wheel']) this.canvas.addEventListener(evt, input, { passive: true });
    this.canvas.addEventListener('pointermove', (e) => { input(); this.#hover(e); });
    this.canvas.addEventListener('pointerleave', () => { this.tip.hidden = true; });
    this.root.addEventListener('click', (e) => {
      if (e.target.closest('[data-act="nb-learn"]')) this.#learnNow(e.target.closest('button'));
      const d = e.target.closest('[data-desk]');
      if (d && this.onSelect) this.onSelect(d.dataset.desk, { tab: 'brain' });
    });
    new ResizeObserver(() => this.#resize()).observe(this.stage);
  }

  show() {
    this.visible = true;
    this.#resize();
    this.refresh();
  }

  hide() {
    this.visible = false;
  }

  async refresh() {
    try {
      this.#setView(await api('/api/neural'));
    } catch {
      this.root.querySelector('#nb-stats').textContent = 'The neural brain isn\'t available right now.';
    }
  }

  async #learnNow(btn) {
    if (btn) btn.disabled = true;
    try {
      const res = await api('/api/neural/learn', { method: 'POST', body: '{}' });
      this.#bannerText(res.ok ? 'Learning from its newest trades… (a minute or two)' : res.error, res.ok ? 'gold' : 'grey');
    } catch (err) {
      this.#bannerText(`Couldn't start learning: ${err.message}`, 'grey');
    }
    setTimeout(() => this.refresh(), 1500);
  }

  // ---- the network -------------------------------------------------------------------------
  #setView(v) {
    const prevNet = this.view?.network;
    this.view = v;
    const net = v.network;
    if (!net) {
      this.#side();
      return;
    }
    const sameShape = prevNet && prevNet.sizes.join() === net.sizes.join();
    if (!sameShape) this.#layout(net.sizes, v.features);
    this.#colorLines(net);
    this.#side();
    if (v.lastThought && !this.lastShown) this.#showThought(v.lastThought, { quiet: true });
    this.#wake();
  }

  // Layers side by side; each layer's neurons in a grid facing you. The senses are grouped.
  #layout(sizes, features) {
    for (const L of this.layers) for (const m of L.mesh) { this.scene.remove(m); m.material.dispose(); }
    this.layers = [];
    const xs = sizes.length === 4 ? [-30, -6, 14, 30] : sizes.map((_, i) => -30 + (60 * i) / (sizes.length - 1));
    sizes.forEach((n, l) => {
      const cols = l === 0 ? 6 : l === sizes.length - 1 ? 1 : Math.ceil(Math.sqrt(n * 1.5));
      const rows = Math.ceil(n / cols);
      const gap = l === 0 ? 3 : 3.4;
      const pos = [];
      const mesh = [];
      for (let i = 0; i < n; i++) {
        const c = i % cols;
        const r = Math.floor(i / cols);
        const p = new THREE.Vector3(xs[l], ((rows - 1) / 2 - r) * gap, (c - (cols - 1) / 2) * gap);
        pos.push(p);
        const color = l === 0 ? new THREE.Color(GROUP[features?.[i]?.group] || '#c9ccd3') : l === sizes.length - 1 ? new THREE.Color('#ffffff') : new THREE.Color('#9aa3b2');
        const m = new THREE.Mesh(this.sphere, new THREE.MeshLambertMaterial({ color, emissive: color.clone().multiplyScalar(0.15) }));
        m.position.copy(p);
        const size = l === sizes.length - 1 ? 2.2 : l === 0 ? 0.55 : 0.75;
        m.scale.setScalar(size);
        m.userData = { l, i, size, base: color.clone() };
        this.scene.add(m);
        mesh.push(m);
      }
      this.layers.push({ pos, mesh });
    });
    // One line per connection.
    const segs = [];
    for (let l = 0; l < sizes.length - 1; l++) {
      for (let j = 0; j < sizes[l + 1]; j++) for (let i = 0; i < sizes[l]; i++) segs.push([l, i, j]);
    }
    this.segs = segs;
    this.segIndex = new Map(segs.map((s, k) => [`${s[0]}:${s[1]}:${s[2]}`, k]));
    const p = new Float32Array(segs.length * 6);
    segs.forEach(([l, i, j], k) => {
      const a = this.layers[l].pos[i];
      const b = this.layers[l + 1].pos[j];
      p.set([a.x, a.y, a.z, b.x, b.y, b.z], k * 6);
    });
    this.lineGeo.setAttribute('position', new THREE.BufferAttribute(p, 3));
    this.lineGeo.setAttribute('color', new THREE.BufferAttribute(new Float32Array(segs.length * 6), 3));
    this.baseColors = new Float32Array(segs.length * 3);
    this.#labels(sizes, features);
    this.#fit();
  }

  // Each layer on its own scale, dimmer where there are many lines (the senses have over a
  // thousand), so the strong connections stand out instead of everything glowing white.
  #colorLines(net) {
    const maxAbs = net.W.map((W) => W.reduce((m, w) => Math.max(m, Math.abs(w)), 1e-9));
    const dim = net.W.map((W) => Math.min(1, Math.sqrt(120 / W.length)));
    const c = new THREE.Color();
    this.segs.forEach(([l, i, j], k) => {
      const w = net.W[l][j * net.sizes[l] + i];
      const s = (0.025 + 0.6 * (Math.abs(w) / maxAbs[l]) ** 1.6) * dim[l];
      c.copy(w >= 0 ? POS : NEG).multiplyScalar(s);
      this.baseColors.set([c.r, c.g, c.b], k * 3);
    });
    this.#paintLines(performance.now());
  }

  #paintLines(now) {
    const col = this.lineGeo.getAttribute('color');
    if (!col) return;
    const arr = col.array;
    for (let k = 0; k < this.segs.length; k++) {
      const r = this.baseColors[k * 3];
      const g = this.baseColors[k * 3 + 1];
      const b = this.baseColors[k * 3 + 2];
      arr[k * 6] = r; arr[k * 6 + 1] = g; arr[k * 6 + 2] = b;
      arr[k * 6 + 3] = r; arr[k * 6 + 4] = g; arr[k * 6 + 5] = b;
    }
    // An idea travelling: each connection lights up while its signal runs along it.
    for (const p of this.pulses) {
      if (p.idx == null || now < p.t0) continue;
      const t = Math.sin(Math.PI * Math.min(1, (now - p.t0) / p.ms)) * p.s;
      for (const o of [0, 3]) {
        arr[p.idx * 6 + o] += p.color.r * t;
        arr[p.idx * 6 + o + 1] += p.color.g * t;
        arr[p.idx * 6 + o + 2] += p.color.b * t;
      }
    }
    // What it just learned: those connections glow gold and fade to their new colour.
    this.flashes = this.flashes.filter((f) => now - f.t0 < f.ms);
    for (const f of this.flashes) {
      const t = Math.max(0, 1 - (now - f.t0) / f.ms);
      const k = f.idx;
      for (const o of [0, 3]) {
        arr[k * 6 + o] += GOLD.r * t * f.s;
        arr[k * 6 + o + 1] += GOLD.g * t * f.s;
        arr[k * 6 + o + 2] += GOLD.b * t * f.s;
      }
    }
    col.needsUpdate = true;
  }

  #labels(sizes, features) {
    this.labelsEl.innerHTML = '';
    this.labelEls = [];
    const add = (text, pos, cls = '') => {
      const el = document.createElement('span');
      el.className = `mg-label ${cls}`;
      el.textContent = text;
      this.labelsEl.appendChild(el);
      this.labelEls.push({ el, pos });
    };
    // One label per group of senses, at its first neuron.
    const seen = new Set();
    (features || []).forEach((f, i) => {
      if (seen.has(f.group) || !this.layers[0]?.pos[i]) return;
      seen.add(f.group);
      add(f.group, this.layers[0].pos[i].clone().add(new THREE.Vector3(0, 1.6, 0)), 'nb-group');
    });
    const top = (l) => this.layers[l].pos.reduce((a, p) => (p.y > a.y ? p : a), this.layers[l].pos[0]).clone().add(new THREE.Vector3(0, 3.2, 0));
    if (this.layers.length === 4) {
      add('Senses', top(0).add(new THREE.Vector3(0, 2, 0)), 'market');
      add('Hidden layer 1', top(1), 'market');
      add('Hidden layer 2', top(2), 'market');
    }
    const out = this.layers.at(-1).pos[0];
    this.outLabel = document.createElement('span');
    this.outLabel.className = 'mg-label nb-out';
    this.outLabel.textContent = 'Chance of profit';
    this.labelsEl.appendChild(this.outLabel);
    this.labelEls.push({ el: this.outLabel, pos: out.clone().add(new THREE.Vector3(0, 3.6, 0)) });
  }

  // ---- live events ---------------------------------------------------------------------------
  #onEvent(ev) {
    if (!ev) return;
    if (ev.kind === 'thought') {
      this.feed.unshift(ev);
      this.feed.length = Math.min(this.feed.length, 12);
      if (this.visible) {
        this.#renderFeed();
        this.#showThought(ev);
      }
    } else if (ev.kind === 'outcome') {
      if (this.visible) this.#showOutcome(ev);
    } else if (ev.kind === 'learning') {
      this.#bannerText(`Learning from ${ev.own} trades of its own…`, 'gold');
      this.refresh();
    } else if (ev.kind === 'learned') {
      this.#bannerText(ev.text || 'Learning finished', ev.adopted ? 'gold' : 'grey', 9000);
      this.refresh().then(() => { if (ev.adopted) this.#flashChanges(ev.changes || []); });
    }
  }

  #showThought(t, { quiet = false } = {}) {
    this.lastShown = t;
    const net = this.view?.network;
    const acts = t.acts;
    this.#renderNow(t);
    if (!net || !Array.isArray(acts) || acts.length !== net.sizes.length || !this.layers.length) return;
    // Neurons light with what they computed: green above zero, red below.
    acts.forEach((a, l) => a.forEach((v, i) => {
      const m = this.layers[l]?.mesh[i];
      if (!m) return;
      const glow = l === acts.length - 1 ? new THREE.Color(verdictOf(t)[1]) : (v >= 0 ? POS : NEG).clone().multiplyScalar(Math.min(1, Math.abs(v)));
      m.userData.glow = glow;
      m.userData.glowUntil = performance.now() + (quiet ? 0 : (acts.length - 1) * STEP_MS) + 4000;
      m.userData.glowFrom = performance.now() + (quiet ? 0 : l * STEP_MS);
    }));
    if (quiet) return this.#wake();
    // The strongest flows, layer by layer: activation × weight.
    const now = performance.now();
    for (let l = 0; l < net.sizes.length - 1; l++) {
      const nIn = net.sizes[l];
      const flows = [];
      for (let j = 0; j < net.sizes[l + 1]; j++) for (let i = 0; i < nIn; i++) flows.push({ i, j, f: acts[l][i] * net.W[l][j * nIn + i] });
      flows.sort((a, b) => Math.abs(b.f) - Math.abs(a.f));
      const top = flows.slice(0, l === net.sizes.length - 2 ? 12 : 42);
      const max = Math.abs(top[0]?.f || 1);
      for (const q of top) {
        this.pulses.push({ a: this.layers[l].pos[q.i], b: this.layers[l + 1].pos[q.j], idx: this.segIndex.get(`${l}:${q.i}:${q.j}`), color: q.f >= 0 ? POS : NEG, t0: now + l * STEP_MS + Math.random() * 120, ms: STEP_MS * 1.6, s: 0.35 + 0.65 * Math.abs(q.f) / max });
      }
    }
    this.#wake();
  }

  // A trade closed: its result runs back through the network, right to left.
  #showOutcome(o) {
    const net = this.view?.network;
    if (!net || !this.layers.length) return;
    const now = performance.now();
    const color = o.won ? POS : NEG;
    const L = net.sizes.length - 1;
    for (let l = L - 1; l >= 0; l--) {
      const nIn = net.sizes[l];
      const ws = [];
      for (let j = 0; j < net.sizes[l + 1]; j++) for (let i = 0; i < nIn; i++) ws.push({ i, j, w: Math.abs(net.W[l][j * nIn + i]) });
      ws.sort((a, b) => b.w - a.w);
      for (const q of ws.slice(0, l === L - 1 ? 12 : 30)) {
        this.pulses.push({ a: this.layers[l + 1].pos[q.j], b: this.layers[l].pos[q.i], idx: this.segIndex.get(`${l}:${q.i}:${q.j}`), color, t0: now + (L - 1 - l) * STEP_MS * 0.8, ms: STEP_MS * 1.2, s: 0.6 });
      }
    }
    const out = this.layers[L].mesh[0];
    out.userData.glow = color;
    out.userData.glowFrom = now;
    out.userData.glowUntil = now + 2500;
    this.feed.unshift({ kind: 'outcome', ...o });
    this.feed.length = Math.min(this.feed.length, 12);
    this.#renderFeed();
    this.#wake();
  }

  #flashChanges(changes) {
    const now = performance.now();
    const max = Math.max(1e-9, ...changes.map((c) => Math.abs(c.d)));
    for (const c of changes) {
      const idx = this.segIndex?.get(`${c.l}:${c.i}:${c.j}`);
      if (idx != null) this.flashes.push({ idx, t0: now, ms: 4500, s: 0.4 + 0.6 * Math.abs(c.d) / max });
    }
    // And the whole brain pulses once.
    for (const L of this.layers) for (const m of L.mesh) { m.userData.glow = GOLD; m.userData.glowFrom = now; m.userData.glowUntil = now + 2000; }
    this.#wake();
  }

  #bannerText(text, tone = 'gold', ms = 6000) {
    if (!text) return;
    this.banner.textContent = text;
    this.banner.className = `nb-banner ${tone}`;
    this.banner.hidden = false;
    clearTimeout(this.bannerTimer);
    this.bannerTimer = setTimeout(() => { this.banner.hidden = true; }, ms);
  }

  // ---- drawing -------------------------------------------------------------------------------
  #wake() {
    if (this.running || !this.visible) return;
    this.running = true;
    requestAnimationFrame((t) => this.#frame(t));
  }

  #frame(now) {
    if (!this.visible || document.hidden) {
      this.running = false;
      return;
    }
    const glowing = this.layers.some((L) => L.mesh.some((m) => m.userData.glowUntil > now));
    const moving = this.pulses.length || this.flashes.length || glowing || now - this.lastInput < 1500 || this.controls.update();
    if (now - (this.lastFrame || 0) >= 1000 / 30 - 4) {
      this.lastFrame = now;
      this.#draw(now);
    }
    if (!moving) {
      this.running = false;
      this.#draw(now);
      return;
    }
    requestAnimationFrame((t) => this.#frame(t));
  }

  #draw(now) {
    // Pulses travel along their connection with a soft glow.
    this.pulses = this.pulses.filter((p) => now < p.t0 + p.ms);
    const live = this.pulses.filter((p) => now >= p.t0);
    const pos = new Float32Array(live.length * 3);
    const col = new Float32Array(live.length * 3);
    const v = new THREE.Vector3();
    live.forEach((p, k) => {
      const t = (now - p.t0) / p.ms;
      v.lerpVectors(p.a, p.b, t);
      pos.set([v.x, v.y, v.z], k * 3);
      const fade = Math.sin(Math.PI * t) * p.s;
      col.set([p.color.r * fade, p.color.g * fade, p.color.b * fade], k * 3);
    });
    this.pulseGeo.setAttribute('position', new THREE.BufferAttribute(pos, 3));
    this.pulseGeo.setAttribute('color', new THREE.BufferAttribute(col, 3));
    // Neurons glow with their last activation, then cool down.
    for (const L of this.layers) {
      for (const m of L.mesh) {
        const u = m.userData;
        let k = 0;
        if (u.glow && now >= (u.glowFrom || 0) && now < (u.glowUntil || 0)) k = Math.min(1, (u.glowUntil - now) / 1500);
        m.material.emissive.copy(u.base).multiplyScalar(0.15);
        if (k > 0) m.material.emissive.lerp(u.glow, k * 0.9);
        m.scale.setScalar(u.size * (1 + 0.35 * k));
      }
    }
    this.#paintLines(now);
    this.renderer.render(this.scene, this.camera);
    this.#placeLabels();
  }

  #placeLabels() {
    const w = this.stage.clientWidth;
    const h = this.stage.clientHeight;
    const v = new THREE.Vector3();
    for (const { el, pos } of this.labelEls || []) {
      v.copy(pos).project(this.camera);
      const off = v.z > 1 || v.x < -1.1 || v.x > 1.1 || v.y < -1.1 || v.y > 1.1;
      el.style.display = off ? 'none' : '';
      if (!off) el.style.transform = `translate(${((v.x + 1) / 2) * w}px, ${((1 - v.y) / 2) * h - 14}px) translateX(-50%)`;
    }
  }

  // A three-quarter view, so each layer reads as a plane and the signal runs left to right.
  #fit() {
    this.controls.target.set(-7, -1, 0);
    this.camera.position.set(-46, 21, 49);
    this.controls.update();
  }

  #resize() {
    const w = this.stage.clientWidth || 600;
    const h = this.stage.clientHeight || 420;
    this.renderer.setSize(w, h, false);
    this.camera.aspect = w / h;
    this.camera.updateProjectionMatrix();
    this.#wake();
  }

  #hover(e) {
    if (performance.now() - (this.lastHover || 0) < 60 || !this.layers.length) return;
    this.lastHover = performance.now();
    const rect = this.canvas.getBoundingClientRect();
    const ndc = new THREE.Vector2(((e.clientX - rect.left) / rect.width) * 2 - 1, -((e.clientY - rect.top) / rect.height) * 2 + 1);
    this.ray.setFromCamera(ndc, this.camera);
    const hit = this.ray.intersectObjects(this.layers.flatMap((L) => L.mesh), false)[0];
    if (!hit) { this.tip.hidden = true; return; }
    const { l, i } = hit.object.userData;
    const t = this.lastShown;
    const val = t?.acts?.[l]?.[i];
    const n = this.layers.length;
    let html;
    if (l === 0) {
      const f = this.view?.features?.[i];
      html = `<b>${escapeHtml(f?.label || `Sense ${i + 1}`)}</b><br><span class="muted">${escapeHtml(f?.group || '')}</span>${val != null ? `<br>For ${escapeHtml(t.name)}'s last idea: ${val >= 0 ? '+' : ''}${val.toFixed(2)} (−1 to +1, + helps the trade)` : ''}`;
    } else if (l === n - 1) {
      html = `<b>Chance of profit</b>${t ? `<br>${escapeHtml(t.name)}'s ${escapeHtml(t.symbol)} ${escapeHtml(t.side.toLowerCase())}: ${pct(t.p)} · ${fmtR(t.expR)} expected` : ''}`;
    } else {
      html = `<b>Hidden neuron ${i + 1}, layer ${l}</b><br><span class="muted">It learned its own pattern from the senses; nobody wrote it.</span>${val != null ? `<br>Last value: ${val >= 0 ? '+' : ''}${val.toFixed(2)}` : ''}`;
    }
    const sr = this.stage.getBoundingClientRect();
    this.tip.innerHTML = html;
    this.tip.hidden = false;
    this.tip.style.left = `${Math.min(sr.width - 260, e.clientX - sr.left + 14)}px`;
    this.tip.style.top = `${Math.max(0, e.clientY - sr.top - 10)}px`;
  }

  // ---- side panel and cards --------------------------------------------------------------------
  #renderNow(t) {
    const [word, color] = verdictOf(t);
    this.root.querySelector('#nb-now').innerHTML = `<div class="nb-think"><b>${escapeHtml(t.name)}</b> · ${escapeHtml(t.symbol)} ${escapeHtml(t.side.toLowerCase())}
      <div class="nb-p"><span class="nb-big">${pct(t.p)}</span> chance of profit · <b class="${t.expR >= 0 ? 'pos' : 'neg'}">${fmtR(t.expR)}</b> expected</div>
      <span class="nb-verdict" style="background:${color}">${word}</span></div>`;
  }

  #renderFeed() {
    const line = (ev) => {
      if (ev.kind === 'outcome') return `<b>${escapeHtml(this.store.profileById?.[ev.desk]?.name.split(' ')[0] || ev.desk)}</b>'s ${escapeHtml(ev.symbol)} closed <b class="${ev.r >= 0 ? 'pos' : 'neg'}">${fmtR(ev.r)}</b> <span class="muted">· it said ${pct(ev.p)}${ev.explore ? ' (exploring)' : ''}; kept for its next lesson</span>`;
      const [word] = verdictOf(ev);
      return `<b>${escapeHtml(ev.name)}</b> ${escapeHtml(ev.symbol)} ${escapeHtml(ev.side.toLowerCase())}: ${pct(ev.p)}, ${fmtR(ev.expR)} → <b>${word}</b>`;
    };
    this.root.querySelector('#nb-feed').innerHTML = this.feed.length
      ? this.feed.map((ev) => `<li>${line(ev)}</li>`).join('')
      : '<li class="muted">Every trade idea a desk has appears here with the brain\'s answer.</li>';
  }

  #side() {
    const v = this.view;
    const stats = this.root.querySelector('#nb-stats');
    if (!v?.ready) {
      stats.textContent = 'No brain yet: it ships with the floor (server/research/brain.json, made by npm run brain).';
      return;
    }
    const tr = v.trainedOn;
    const span = tr ? `${new Date(tr.from).toISOString().slice(0, 7)} – ${new Date(tr.to).toISOString().slice(0, 7)}` : '';
    const lastLesson = (v.versions || []).filter((r) => r.adopted).at(-1);
    stats.textContent = `Version ${v.version}${lastLesson ? ` (learned ${new Date(lastLesson.at).toLocaleDateString(undefined, { day: 'numeric', month: 'short' })})` : ''} · ${v.network.sizes.join(' → ')} neurons · learned from ${tr?.n?.toLocaleString('en-US') ?? '?'} trades (${span}) · ${v.own.n.toLocaleString('en-US')} trades of its own on real prices`;
    const mode = this.root.querySelector('#nb-mode');
    mode.hidden = false;
    mode.className = `pill nb-mode ${v.mode === 'trusted' ? 'ok' : 'warn'}`;
    mode.textContent = v.mode === 'trusted' ? 'HAS A SAY' : 'LEARNING';
    const say = this.root.querySelector('#nb-say');
    say.hidden = !v.skill?.text;
    say.className = `nb-say ${v.mode === 'trusted' ? 'ok' : 'learning'}`;
    say.innerHTML = v.skill ? `<b>${v.mode === 'trusted' ? 'It has earned a say.' : 'Learning: it watches and judges, the desks decide.'}</b> ${escapeHtml(v.skill.text.replace(/\.$/, ''))}.` : '';
    if (!this.feed.length && v.thoughts?.length) this.feed = v.thoughts.slice().reverse();
    this.#renderFeed();
    const learn = v.learning
      ? `<p class="nb-learning"><span class="lab-busy"><i></i>Learning now from ${v.own.n} trades of its own…</span></p>`
      : `<p class="fine">${v.own.newSinceTrain} new trade${v.own.newSinceTrain === 1 ? '' : 's'} on real prices since its last lesson. It studies after the New York close once it has ${v.settings.minNew}, and keeps a new version only if it judges trades it hasn't seen better.${v.own.explored ? ` ${v.own.explored} of its trades were explorations: ideas it passed on, taken small on paper so it keeps learning.` : ''}</p>`;
    const hist = (v.versions || []).slice().reverse().slice(0, 5).map((r) => `<li>${new Date(r.at).toLocaleString(undefined, { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' })}: ${r.adopted ? `<b class="pos">learned · v${r.version}</b>` : '<span class="muted">studied, kept what it knew</span>'} <span class="muted">(${r.own} trades, tested on the newest ${r.held})</span></li>`).join('');
    const calib = v.calibration?.length
      ? `<p class="fine">Honest check, on your account's trades: ${v.calibration.map((c) => `said ${pct(c.said)} → won ${pct(c.won)} (${c.n})`).join(' · ')}</p>`
      : '';
    this.root.querySelector('#nb-learn').innerHTML = `${learn}${v.lastError ? `<p class="tg-msg bad">Last lesson didn't finish: ${escapeHtml(v.lastError.text)}</p>` : ''}
      ${hist ? `<ol class="nb-hist">${hist}</ol>` : ''}${calib}
      <button class="btn" data-act="nb-learn" ${v.learning ? 'disabled' : ''}>Learn now</button>`;
    this.#tested(v);
    this.#desks(v);
  }

  // How the brain did on months it had never seen (walk-forward on long history).
  #tested(v) {
    const el = this.root.querySelector('#nb-tested');
    const t = v.tested;
    if (!t) { el.innerHTML = ''; return; }
    const name = (id) => this.store.profileById?.[id]?.name.split(' ')[0] || id;
    const rows = Object.entries(t.desks || {}).sort((a, b) => (b[1].pickedR ?? -9) - (a[1].pickedR ?? -9)).map(([d, s]) => `<tr data-desk="${escapeHtml(d)}">
      <td><b>${escapeHtml(name(d))}</b></td><td class="r num">${s.n.toLocaleString('en-US')}</td>
      <td class="r num ${s.allR >= 0 ? 'pos' : 'neg'}">${fmtR(s.allR)}</td>
      <td class="r num">${s.n ? Math.round((100 * s.picked) / s.n) : 0}%</td>
      <td class="r num ${s.pickedR == null ? '' : s.pickedR >= 0 ? 'pos' : 'neg'}">${fmtR(s.pickedR)}</td>
      <td class="r num">${s.auc ?? '—'}</td></tr>`).join('');
    el.innerHTML = `<h3>Tested on months it never saw</h3>
      <p class="fine">Every month of ${t.months} it was retrained on the months before, then judged that month's trades. "Every trade" is what the desk made taking them all; "brain picks" is what the trades it would have taken made.</p>
      <div class="nb-headline"><div><span>Every trade</span><b class="${t.all.allR >= 0 ? 'pos' : 'neg'}">${fmtR(t.all.allR)}</b><small>${t.all.n.toLocaleString('en-US')} trades</small></div>
        <div><span>Brain picks</span><b class="${(t.all.pickedR ?? 0) >= 0 ? 'pos' : 'neg'}">${fmtR(t.all.pickedR)}</b><small>${t.all.picked.toLocaleString('en-US')} trades (${t.all.n ? Math.round((100 * t.all.picked) / t.all.n) : 0}%)</small></div>
        <div><span>It passed on</span><b class="${(t.all.skippedR ?? 0) >= 0 ? 'pos' : 'neg'}">${fmtR(t.all.skippedR)}</b><small>a trade</small></div>
        <div><span>Ranking skill</span><b>${t.all.auc ?? '—'}</b><small>0.5 = a coin · ${v.settings?.trust?.minAuc ?? 0.55} to earn a say</small></div></div>
      <div class="table-wrap" style="max-height:none"><table class="table compact"><thead><tr><th>Desk</th><th class="r">Trades</th><th class="r">Every trade</th><th class="r">It takes</th><th class="r">Its picks</th><th class="r">Skill</th></tr></thead><tbody>${rows}</tbody></table></div>`;
  }

  // What each desk's brain has learned: its own strategy, in words.
  #desks(v) {
    const el = this.root.querySelector('#nb-desks');
    const ins = v.insights;
    if (!ins) { el.innerHTML = ''; return; }
    const name = (id) => this.store.profileById?.[id]?.name.split(' ')[0] || id;
    const proven = v.mode === 'trusted';
    el.innerHTML = `<h3>What each desk's brain learned${proven ? '' : ' <span class="pill warn">hunches, not proven</span>'}</h3>
      <p class="fine">Its own strategy, found in its trades: the situations that raise or lower its chance of a winning trade most, and its best and worst hours (New York time).${proven ? '' : ' Until the brain tells winners from losers on trades it hasn\'t seen, these are hunches: nothing trades on them.'}</p>
      <div class="nb-learned">${Object.entries(ins).map(([d, s]) => `<div class="nb-desk" data-desk="${escapeHtml(d)}">
        <b>${escapeHtml(name(d))}</b> <span class="muted">· ${proven ? 'takes' : 'would take'} ${pct(s.takes)} of its ideas ·${s.n.toLocaleString('en-US')} trades</span>
        ${s.helps?.length ? `<p><span class="pos">More likely to win when</span> ${s.helps.map((h) => `${escapeHtml(h.text)} <small>(+${h.points} pts)</small>`).join(', ')}.</p>` : ''}
        ${s.hurts?.length ? `<p><span class="neg">Less likely when</span> ${s.hurts.map((h) => `${escapeHtml(h.text)} <small>(−${h.points} pts)</small>`).join(', ')}.</p>` : ''}
        ${s.bestHours?.length ? `<p class="muted">Best hours ${s.bestHours.map(nyHour).join(', ')} · worst ${s.worstHours.map(nyHour).join(', ')}</p>` : ''}
      </div>`).join('')}</div>`;
  }
}
