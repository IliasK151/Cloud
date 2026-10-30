import * as THREE from 'three';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import { EffectComposer } from 'three/addons/postprocessing/EffectComposer.js';
import { RenderPass } from 'three/addons/postprocessing/RenderPass.js';
import { UnrealBloomPass } from 'three/addons/postprocessing/UnrealBloomPass.js';
import { OutputPass } from 'three/addons/postprocessing/OutputPass.js';
import { api } from '../net.js';
import { escapeHtml, initials, nyTime } from '../format.js';

// The deep brain in the Brain tab (server/deep/): one 3D scene where a real idea travels
// through all three parts, left to right, as it happens.
//
//   1 Reads      the 24 candles before the idea (1-hour, 15-minute, 5-minute, 1-minute) sit in
//                a row with the idea at the end. Two attention layers above them: every line is
//                one head looking from the idea back at one candle, brighter where it looked
//                harder. These are the network's real attention weights for that idea.
//   2 Decides    the idea's final vector goes to the router, which weighs the five market
//                experts (beams as wide as its trust in each); the experts light up and their
//                answers merge into the chance of profit.
//   3 Remembers  every past trade it knows is a star (green won, red lost), placed by how alike
//                the network sees them. The idea flies in, lands among its 12 closest past
//                trades and lines run to each.
//
// With "Follow the thought" on, the camera glides along with the idea. It draws only while the
// Brain tab is open and the card is on screen.

const C = {
  win: '#4ade80', loss: '#f87171', gold: '#fbbf24', idea: '#ffffff', neuron: '#60a5fa', router: '#c084fc', beam: '#93c5fd', grey: '#94a3b8',
};
const HEADS = ['#38bdf8', '#c084fc', '#fbbf24', '#4ade80'].map((c) => new THREE.Color(c));
const EXPERT_COLORS = ['#60a5fa', '#a78bfa', '#fbbf24', '#4ade80', '#2dd4bf'];
const VERDICT = { take: ['TAKE', '#4ade80'], pass: ['PASS', '#94a3b8'], explore: ['EXPLORE · paper', '#fbbf24'], yours: ['YOUR ALERT', '#60a5fa'] };
const verdictOf = (t) => (t.verdict === 'learning' ? [`LEARNING · would ${t.would === 'take' ? 'take' : 'pass'}`, t.would === 'take' ? '#34d399' : '#94a3b8'] : VERDICT[t.verdict] || ['—', '#94a3b8']);
const TF_LABEL = { 60: '1-hour', 15: '15-min', 5: '5-min', 1: '1-min' };
const SRC = ['long history', 'replayed on your prices', 'your floor'];

// The scene, left to right.
const ZT = new THREE.Vector3(-8, 0, 0); // transformer
const ZE = new THREE.Vector3(5.2, 0.3, 0); // router
const ORB = new THREE.Vector3(14, 0.3, 0); // the answer
const ZG = new THREE.Vector3(21.8, 0.4, 0); // galaxy
const GS = 0.85; // galaxy scale
const ROW_Y = -2.6;
const LAYER_Y = [-0.9, 0.9];
const TOP_Y = 2.6;
const SLOTS = 24;
const SEG = 22;
const xOf = (slot) => ZT.x + (slot - 11.5) * 0.5 + (Math.floor(slot / 6) - 1.5) * 0.42;
const IDEA_X = xOf(23) + 0.95;

// When each part of a thought plays (seconds from its start).
const T = { candles: [0, 0.8], l1: [0.8, 2.0], l2: [1.9, 3.1], rise: [3.0, 3.8], router: [3.7, 4.5], experts: [4.1, 5.1], out: [4.9, 5.6], comet: [5.5, 6.9], near: [6.8, 7.8], end: 9.5 };
const smooth = (a, b, t) => Math.max(0, Math.min(1, (t - a) / (b - a)));
const ease = (t) => (t < 0.5 ? 4 * t * t * t : 1 - (-2 * t + 2) ** 3 / 2);
const clamp = (x, a, b) => Math.max(a, Math.min(b, x));
const pct = (x) => (x == null ? '—' : `${Math.round(x * 100)}%`);
const fmtR = (x) => (x == null ? '—' : `${x >= 0 ? '+' : '−'}${Math.abs(x).toFixed(2)}R`);
const bez = (a, c, b, t, out) => out.set(
  (1 - t) ** 2 * a.x + 2 * (1 - t) * t * c.x + t * t * b.x,
  (1 - t) ** 2 * a.y + 2 * (1 - t) * t * c.y + t * t * b.y,
  (1 - t) ** 2 * a.z + 2 * (1 - t) * t * c.z + t * t * b.z,
);

function dotTexture() {
  const c = document.createElement('canvas');
  c.width = c.height = 64;
  const g = c.getContext('2d');
  const grd = g.createRadialGradient(32, 32, 0, 32, 32, 32);
  grd.addColorStop(0, 'rgba(255,255,255,1)');
  grd.addColorStop(0.35, 'rgba(255,255,255,0.5)');
  grd.addColorStop(1, 'rgba(255,255,255,0)');
  g.fillStyle = grd;
  g.fillRect(0, 0, 64, 64);
  return new THREE.CanvasTexture(c);
}
const ADD = { transparent: true, depthWrite: false, blending: THREE.AdditiveBlending };

export class DeepBrainPanel {
  constructor(store, root, { onSelect } = {}) {
    this.store = store;
    this.root = root;
    this.onSelect = onSelect;
    this.visible = false;
    this.onScreen = true;
    this.running = false;
    this.eco = document.documentElement.classList.contains('eco');
    this.battery = false;
    this.view = null;
    this.thought = null; // the one on screen
    this.t0 = 0; // when it started playing
    this.queue = null;
    this.follow = true;
    this.lastInput = 0;
    this.reduce = matchMedia('(prefers-reduced-motion: reduce)').matches;
    this.#build();
    store.on('deep', (ev) => this.#onEvent(ev));
    // The desks' names and colours arrive with the floor: draw again once they're there.
    store.on('init', () => { if (this.visible) this.#renderSide(); });
  }

  // ---- page --------------------------------------------------------------------------------
  #build() {
    this.root.innerHTML = `
      <div class="mg-head dp-head">
        <div><h2>Deep brain <span class="pill dp-status" id="dp-status">…</span></h2>
          <p class="sub" id="dp-sub">A transformer that reads the candles, five market experts and a memory of past trades.</p></div>
        <div class="dp-actions">
          <button class="btn" data-act="dp-follow" aria-pressed="true">Follow the thought</button>
          <button class="btn" data-act="dp-replay">Replay</button>
          <button class="btn" data-act="dp-learn">Learn now</button>
        </div>
      </div>
      <div class="mg-body dp-body">
        <div class="dp-stage"><canvas aria-label="The deep brain: an idea read by a transformer, judged by five experts and compared with past trades"></canvas>
          <div class="dp-labels"></div><div class="mg-tip" hidden></div>
          <div class="dp-overlay" id="dp-overlay" hidden></div>
          <div class="dp-legend"><span><i style="background:${C.win};color:${C.win}"></i>Won</span><span><i style="background:${C.loss};color:${C.loss}"></i>Lost</span>${HEADS.map((h, i) => `<span><i style="background:${h.getStyle()};color:${h.getStyle()}"></i>Head ${i + 1}</span>`).join('')}</div>
          <p class="mg-hint dp-hint">Drag to turn · scroll to zoom · click a past trade's desk in the list to open it</p></div>
        <aside class="mg-side dp-side" id="dp-side"></aside>
      </div>
      <div class="dp-cards">
        <div class="dp-card-inner" id="dp-test"></div>
        <div class="dp-card-inner" id="dp-learn"></div>
      </div>`;
    this.stage = this.root.querySelector('.dp-stage');
    this.canvas = this.root.querySelector('canvas');
    this.labelsEl = this.root.querySelector('.dp-labels');
    this.overlay = this.root.querySelector('#dp-overlay');

    const r = new THREE.WebGLRenderer({ canvas: this.canvas, antialias: false, powerPreference: 'high-performance' });
    r.setClearColor('#04060b', 1);
    this.renderer = r;
    this.scene = new THREE.Scene();
    this.scene.background = new THREE.Color('#04060b');
    this.camera = new THREE.PerspectiveCamera(38, 2, 0.1, 200);
    this.controls = new OrbitControls(this.camera, this.canvas);
    this.controls.enableDamping = true;
    this.controls.dampingFactor = 0.07;
    this.controls.enablePan = true;
    this.controls.minDistance = 6;
    this.controls.maxDistance = 70;
    this.controls.addEventListener('start', () => { this.goal = null; this.lastInput = performance.now(); this.#wake(); });
    const target = new THREE.WebGLRenderTarget(1, 1, { type: THREE.HalfFloatType, samples: 4 });
    this.composer = new EffectComposer(r, target);
    this.composer.addPass(new RenderPass(this.scene, this.camera));
    this.bloom = new UnrealBloomPass(new THREE.Vector2(256, 256), 0.95, 0.55, 0.05);
    this.composer.addPass(this.bloom);
    this.composer.addPass(new OutputPass());
    this.dot = dotTexture();
    this.#buildTransformer();
    this.#buildExperts();
    this.#buildGalaxy();
    this.#labels();
    this.#overview(true);

    const input = () => { this.lastInput = performance.now(); this.#wake(); };
    for (const ev of ['pointerdown', 'wheel']) this.canvas.addEventListener(ev, input, { passive: true });
    this.canvas.addEventListener('pointermove', input, { passive: true });
    this.root.addEventListener('click', (e) => {
      const act = e.target.closest('[data-act]')?.dataset.act;
      if (act === 'dp-follow') {
        this.follow = !this.follow;
        const b = e.target.closest('button');
        b.setAttribute('aria-pressed', String(this.follow));
        b.textContent = this.follow ? 'Follow the thought' : 'Camera free';
        // Free: back to the whole scene once, then it's yours.
        this.goal = this.follow ? null : { home: true };
        this.#wake();
      } else if (act === 'dp-replay') {
        const t = this.thought || this.view?.thoughts?.at(-1);
        if (t) this.#play(t);
      } else if (act === 'dp-learn') this.#learnNow(e.target.closest('button'));
      const th = e.target.closest('[data-thought]');
      if (th) {
        const t = (this.view?.thoughts || []).find((x) => x.id === th.dataset.thought);
        if (t) this.#play(t);
      }
      const d = e.target.closest('[data-desk]');
      if (d && this.onSelect) this.onSelect(d.dataset.desk, { tab: 'brain' });
    });
    new ResizeObserver(() => this.#resize()).observe(this.stage);
    new IntersectionObserver(([en]) => { this.onScreen = en.isIntersecting; this.#wake(); }).observe(this.stage);
    document.addEventListener('visibilitychange', () => this.#wake());
  }

  // ---- 1. the transformer -------------------------------------------------------------------
  #buildTransformer() {
    const g = new THREE.Group();
    this.scene.add(g);
    this.tf = { group: g };
    const body = new THREE.BoxGeometry(0.3, 1, 0.3);
    const wick = new THREE.BoxGeometry(0.05, 1, 0.05);
    this.tf.candles = Array.from({ length: SLOTS }, () => {
      const m = new THREE.Mesh(body, new THREE.MeshBasicMaterial({ color: C.win, transparent: true, opacity: 0 }));
      const w = new THREE.Mesh(wick, new THREE.MeshBasicMaterial({ color: C.win, transparent: true, opacity: 0 }));
      g.add(m, w);
      return { m, w };
    });
    this.tf.idea = new THREE.Mesh(new THREE.OctahedronGeometry(0.34), new THREE.MeshBasicMaterial({ color: C.idea }));
    this.tf.idea.position.set(IDEA_X, ROW_Y, 0);
    g.add(this.tf.idea);
    // Two glass layers.
    const w = IDEA_X - xOf(0) + 1.4;
    for (const y of LAYER_Y) {
      const pg = new THREE.PlaneGeometry(w, 2.2);
      const plate = new THREE.Mesh(pg, new THREE.MeshBasicMaterial({ color: 0x1d4ed8, transparent: true, opacity: 0.05, side: THREE.DoubleSide, depthWrite: false }));
      plate.rotation.x = -Math.PI / 2;
      plate.position.set((IDEA_X + xOf(0)) / 2, y - 0.02, 0);
      const edge = new THREE.LineSegments(new THREE.EdgesGeometry(pg), new THREE.LineBasicMaterial({ color: 0x38bdf8, transparent: true, opacity: 0.22 }));
      edge.rotation.x = -Math.PI / 2;
      edge.position.copy(plate.position);
      g.add(plate, edge);
    }
    // A neuron per token per layer, and the stream running up each column.
    const cols = [...Array.from({ length: SLOTS }, (_, s) => xOf(s)), IDEA_X];
    this.tf.cols = cols;
    this.tf.neurons = this.#points(cols.length * 2, 0.36);
    this.tf.stream = this.#segs(cols.length * 2);
    const NP = this.tf.neurons.geometry.attributes.position.array;
    const SP = this.tf.stream.geometry.attributes.position.array;
    cols.forEach((x, i) => {
      LAYER_Y.forEach((y, l) => {
        NP.set([x, y, 0], (l * cols.length + i) * 3);
        SP.set([x, l ? LAYER_Y[0] : ROW_Y + 0.85, 0, x, y, 0], (l * cols.length + i) * 6);
      });
    });
    g.add(this.tf.neurons, this.tf.stream);
    // Attention arcs: per layer, per head, from the idea back to every candle slot.
    this.tf.arcs = [];
    this.tf.arcLines = LAYER_Y.map((y, l) => {
      const line = this.#segs(4 * SLOTS * SEG);
      const P = line.geometry.attributes.position.array;
      let k = 0;
      for (let h = 0; h < 4; h++) {
        for (let s = 0; s < SLOTS; s++) {
          const a = new THREE.Vector3(xOf(s), l ? LAYER_Y[0] : ROW_Y + 0.85, 0);
          const b = new THREE.Vector3(IDEA_X, y, 0);
          const c = new THREE.Vector3((a.x + b.x) / 2, (a.y + b.y) / 2 + 0.45 + 0.04 * Math.abs(b.x - a.x), (h - 1.5) * 0.55 + 0.9);
          const pts = [];
          for (let q = 0; q <= SEG; q++) pts.push(bez(a, c, b, q / SEG, new THREE.Vector3()));
          for (let q = 0; q < SEG; q++) P.set([pts[q].x, pts[q].y, pts[q].z, pts[q + 1].x, pts[q + 1].y, pts[q + 1].z], (k + q) * 6);
          this.tf.arcs.push({ l, h, s, start: k, pts });
          k += SEG;
        }
      }
      g.add(line);
      return line;
    });
    this.tf.pulses = this.#points(64, 0.42);
    g.add(this.tf.pulses);
  }

  // ---- 2. the router and the experts --------------------------------------------------------
  #buildExperts() {
    const g = new THREE.Group();
    this.scene.add(g);
    this.ex = { group: g };
    this.ex.router = new THREE.LineSegments(new THREE.WireframeGeometry(new THREE.IcosahedronGeometry(0.95, 1)), new THREE.LineBasicMaterial({ color: C.router, transparent: true, opacity: 0.85, blending: THREE.AdditiveBlending }));
    this.ex.router.position.copy(ZE);
    this.ex.core = new THREE.Mesh(new THREE.SphereGeometry(0.32, 24, 16), new THREE.MeshBasicMaterial({ color: C.router }));
    this.ex.core.position.copy(ZE);
    this.ex.orb = new THREE.Mesh(new THREE.SphereGeometry(0.42, 24, 16), new THREE.MeshBasicMaterial({ color: '#dbeafe' }));
    this.ex.orb.position.copy(ORB);
    g.add(this.ex.router, this.ex.core, this.ex.orb);
    this.ex.experts = EXPERT_COLORS.map((hex, k) => {
      const ang = THREE.MathUtils.degToRad(64 - k * 32);
      const center = new THREE.Vector3(ZE.x + 2.7 + Math.cos(ang) * 0.6, ZE.y + Math.sin(ang) * 3.3, (k % 2 ? -0.9 : 0.9));
      const nodes = [];
      [3, 4, 1].forEach((n, l) => { for (let j = 0; j < n; j++) nodes.push({ l, p: new THREE.Vector3(center.x - 0.7 + l * 0.7, center.y + (j - (n - 1) / 2) * 0.34, center.z) }); });
      const pts = this.#points(nodes.length, 0.32);
      nodes.forEach((nd, i) => pts.geometry.attributes.position.array.set([nd.p.x, nd.p.y, nd.p.z], i * 3));
      const links = [];
      for (const a of nodes) for (const b of nodes) if (b.l === a.l + 1) links.push([a, b]);
      const ln = this.#segs(links.length);
      links.forEach(([a, b], i) => ln.geometry.attributes.position.array.set([a.p.x, a.p.y, a.p.z, b.p.x, b.p.y, b.p.z], i * 6));
      g.add(pts, ln);
      return { k, color: new THREE.Color(hex), center, nodes, pts, ln, links, inPt: nodes[1].p, outPt: nodes[nodes.length - 1].p };
    });
    // Beams: transformer → router, router → each expert, each expert → the answer.
    this.ex.beams = this.#segs(11 * 30);
    this.ex.flow = this.#points(260, 0.3);
    g.add(this.ex.beams, this.ex.flow);
  }

  // ---- 3. the memory galaxy -----------------------------------------------------------------
  #buildGalaxy() {
    const g = new THREE.Group();
    g.position.copy(ZG);
    this.scene.add(g);
    this.gx = { group: g, n: 0 };
    this.gx.stars = this.#points(6000, 0.19, 1);
    this.gx.bright = this.#points(1200, 0.3, 1); // the floor's own trades, bigger
    this.gx.near = this.#points(12, 0.5);
    this.gx.lines = this.#segs(12);
    this.gx.comet = this.#points(28, 0.5);
    this.gx.ring = new THREE.Mesh(new THREE.RingGeometry(0.9, 1, 64), new THREE.MeshBasicMaterial({ color: 0xffffff, transparent: true, opacity: 0, side: THREE.DoubleSide, depthWrite: false, blending: THREE.AdditiveBlending }));
    g.add(this.gx.stars, this.gx.bright, this.gx.near, this.gx.lines, this.gx.ring);
    this.scene.add(this.gx.comet); // flies in world space, from the answer to the galaxy
    for (const p of [this.gx.stars, this.gx.bright, this.gx.near, this.gx.lines]) p.geometry.setDrawRange(0, 0);
  }

  #setGalaxy(galaxy) {
    const pts = galaxy?.points || [];
    const S = GS;
    const win = new THREE.Color(C.win);
    const loss = new THREE.Color(C.loss);
    let a = 0;
    let b = 0;
    const A = this.gx.stars.geometry.attributes;
    const B = this.gx.bright.geometry.attributes;
    for (const [x, y, z, won, src] of pts) {
      const col = won ? win : loss;
      if (src === 2 && b < 1200) {
        B.position.array.set([x * S, y * S, z * S], b * 3);
        B.color.array.set([col.r, col.g, col.b], b * 3);
        b++;
      } else if (a < 6000) {
        const k = src === 1 ? 0.75 : 0.32;
        A.position.array.set([x * S, y * S, z * S], a * 3);
        A.color.array.set([col.r * k, col.g * k, col.b * k], a * 3);
        a++;
      }
    }
    this.gx.stars.geometry.setDrawRange(0, a);
    this.gx.bright.geometry.setDrawRange(0, b);
    for (const at of [A.position, A.color, B.position, B.color]) at.needsUpdate = true;
    this.gx.n = galaxy?.n ?? pts.length;
  }

  #points(n, size, opacity = 1) {
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.BufferAttribute(new Float32Array(n * 3), 3));
    g.setAttribute('color', new THREE.BufferAttribute(new Float32Array(n * 3), 3));
    const p = new THREE.Points(g, new THREE.PointsMaterial({ size, map: this.dot, vertexColors: true, opacity, sizeAttenuation: true, ...ADD }));
    p.frustumCulled = false;
    return p;
  }

  #segs(n) {
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.BufferAttribute(new Float32Array(n * 6), 3));
    g.setAttribute('color', new THREE.BufferAttribute(new Float32Array(n * 6), 3));
    const l = new THREE.LineSegments(g, new THREE.LineBasicMaterial({ vertexColors: true, ...ADD }));
    l.frustumCulled = false;
    return l;
  }

  // ---- labels ------------------------------------------------------------------------------
  #labels() {
    this.labelEls = [];
    const add = (html, pos, cls = '', parent = null) => {
      const el = document.createElement('span');
      el.className = `dp-label ${cls}`;
      el.innerHTML = html;
      this.labelsEl.appendChild(el);
      const l = { el, pos, parent, op: 1 };
      this.labelEls.push(l);
      return l;
    };
    add('<b>1</b><span>Reads the candles</span><small>transformer · 2 layers × 4 heads</small>', new THREE.Vector3(ZT.x - 1, TOP_Y + 2.6, 0), 'zone');
    add('<b>2</b><span>Asks its experts</span><small>router · 5 experts</small>', new THREE.Vector3((ZE.x + ORB.x) / 2, TOP_Y + 2.6, 0), 'zone');
    this.galaxyTitle = add('<b>3</b><span>Remembers</span><small>memory of past trades</small>', new THREE.Vector3(ZG.x, TOP_Y + 2.6, 0), 'zone');
    [['1-hour', 0], ['15-min', 6], ['5-min', 12], ['1-min', 18]].forEach(([t, s]) => add(t, new THREE.Vector3((xOf(s) + xOf(s + 5)) / 2, ROW_Y - 1.25, 0), 'cap'));
    add('The idea', new THREE.Vector3(IDEA_X, ROW_Y - 0.8, 0), 'cap');
    LAYER_Y.forEach((y, l) => add(`Layer ${l + 1}`, new THREE.Vector3(xOf(0) - 0.9, y, 0), 'cap left'));
    add('Router', ZE.clone().add(new THREE.Vector3(0, -1.5, 0)), 'cap');
    this.expertLbls = this.ex.experts.map((e, k) => add(['Indices', 'FX', 'Gold', 'Oil', 'Crypto'][k], e.center.clone().add(new THREE.Vector3(1.05, 0, 0)), 'cap expert right'));
    this.expertLbls.forEach((l, k) => l.el.style.setProperty('--c', EXPERT_COLORS[k]));
    this.orbLbl = add('', ORB.clone().add(new THREE.Vector3(0, 1.35, 0)), 'big');
    this.keyLbls = [add('', new THREE.Vector3(), 'key')];
    this.landLbl = add('', new THREE.Vector3(), 'key', this.gx.group);
  }

  #placeLabels() {
    const w = this.stage.clientWidth;
    const h = this.stage.clientHeight;
    const v = new THREE.Vector3();
    for (const l of this.labelEls) {
      v.copy(l.pos);
      if (l.parent) v.applyMatrix4(l.parent.matrixWorld);
      v.project(this.camera);
      const x = ((v.x + 1) / 2) * w;
      const y = ((1 - v.y) / 2) * h;
      const align = l.el.classList.contains('left') ? '-100%' : l.el.classList.contains('right') ? '0%' : '-50%';
      l.el.style.transform = `translate(${x.toFixed(1)}px, ${y.toFixed(1)}px) translate(${align}, -50%)`;
      l.el.style.opacity = v.z > 1 || l.op <= 0.01 ? '0' : String(Math.min(1, l.op));
    }
  }

  // ---- data --------------------------------------------------------------------------------
  show() {
    this.visible = true;
    this.#resize();
    this.refresh();
    this.#wake();
  }

  hide() {
    this.visible = false;
  }

  setPower({ eco = this.eco, battery = this.battery } = {}) {
    this.eco = eco;
    this.battery = battery;
    this.#resize();
  }

  get #saving() {
    return this.eco && this.battery;
  }

  async refresh() {
    let v;
    try {
      v = await api('/api/deep');
    } catch {
      this.root.querySelector('#dp-sub').textContent = 'The deep brain isn\'t available right now.';
      return;
    }
    this.view = v;
    if (v.galaxy) this.#setGalaxy(v.galaxy);
    this.#renderHead();
    this.#renderSide();
    this.#renderCards();
    this.#renderOverlay();
    // The last real thought plays when the card opens.
    if (!this.thought && v.thoughts?.length) this.#play(v.thoughts.at(-1));
    this.#wake();
  }

  async #learnNow(btn) {
    if (btn) btn.disabled = true;
    try {
      const res = await api('/api/deep/learn', { method: 'POST', body: '{}' });
      if (!res.ok) this.#flash(res.error);
    } catch (err) {
      this.#flash(`Couldn't start learning: ${err.message}`);
    }
    setTimeout(() => { if (btn) btn.disabled = false; this.refresh(); }, 1200);
  }

  #flash(text) {
    const el = this.root.querySelector('#dp-sub');
    el.textContent = text;
    el.classList.add('dp-note');
    clearTimeout(this.flashTimer);
    this.flashTimer = setTimeout(() => { el.classList.remove('dp-note'); this.#renderHead(); }, 8000);
  }

  #onEvent(ev) {
    if (!ev) return;
    if (ev.kind === 'thought') {
      const { kind, ...t } = ev;
      if (this.view) {
        this.view.thoughts = [...(this.view.thoughts || []), t].slice(-12);
        if (this.visible) this.#renderSide();
      }
      if (!this.visible) return;
      // A thought already playing finishes first (the newest waits its turn).
      const busy = this.thought && performance.now() - this.t0 < T.near[1] * 1000;
      if (busy) this.queue = t;
      else this.#play(t);
    } else if (ev.kind === 'outcome') {
      if (ev.kept && Array.isArray(ev.pos) && this.visible) this.#addStar(ev);
    } else if (ev.kind === 'progress' || ev.kind === 'learning') {
      if (this.view) {
        this.view.status = 'training';
        this.view.learning = { ...(this.view.learning || {}), stage: ev.stage, pct: ev.pct, text: ev.text || 'Starting…' };
        if (this.visible) { this.#renderHead(); this.#renderOverlay(); this.#renderCards(); }
      }
    } else if (ev.kind === 'learned') {
      this.refresh();
    }
  }

  // A trade the brain judged has closed: its star joins the galaxy.
  #addStar(ev) {
    const B = this.gx.bright.geometry;
    const n = B.drawRange.count;
    if (n >= 1200) return;
    const col = new THREE.Color(ev.won ? C.win : C.loss);
    B.attributes.position.array.set(ev.pos.map((v) => v * GS), n * 3);
    B.attributes.color.array.set([col.r, col.g, col.b], n * 3);
    B.setDrawRange(0, n + 1);
    B.attributes.position.needsUpdate = true;
    B.attributes.color.needsUpdate = true;
    this.ring = { pos: new THREE.Vector3(...ev.pos.map((v) => v * GS)), t0: performance.now(), color: col };
    this.#wake();
  }

  // ---- a thought plays -----------------------------------------------------------------------
  #play(t) {
    this.thought = t;
    this.t0 = performance.now();
    this.queue = null;
    this.#setCandles(t);
    this.#renderSide();
    if (this.follow && !this.reduce) this.goal = { step: 0 };
    this.#wake();
  }

  #setCandles(t) {
    const bySlot = new Map((t.candles || []).map((c) => [c[0], c]));
    // Each timeframe on its own scale, so 1-hour and 1-minute candles both read.
    for (let g = 0; g < 4; g++) {
      const cs = [];
      for (let s = g * 6; s < g * 6 + 6; s++) if (bySlot.has(s)) cs.push(bySlot.get(s));
      const lo = Math.min(...cs.map((c) => c[5]));
      const hi = Math.max(...cs.map((c) => c[4]));
      const sy = (v) => ROW_Y - 0.8 + ((v - lo) / (hi - lo || 1)) * 1.6;
      for (let s = g * 6; s < g * 6 + 6; s++) {
        const c = bySlot.get(s);
        const { m, w } = this.tf.candles[s];
        if (!c) { m.visible = false; w.visible = false; continue; }
        m.visible = true;
        w.visible = true;
        const [, , , o, h, l, cl] = c;
        const col = cl >= o ? C.win : C.loss;
        m.material.color.set(col);
        w.material.color.set(col);
        const y0 = sy(Math.min(o, cl));
        const y1 = sy(Math.max(o, cl));
        m.scale.y = Math.max(0.04, y1 - y0);
        m.position.set(xOf(s), (y0 + y1) / 2, 0);
        w.scale.y = Math.max(0.04, sy(h) - sy(l));
        w.position.set(xOf(s), (sy(h) + sy(l)) / 2, 0);
      }
    }
    // Attention by slot: [layer][head][slot].
    this.att = (t.attn || []).map((L) => L.map((hw) => {
      const out = new Float32Array(SLOTS);
      hw.forEach((w, j) => { const c = t.candles?.[j]; if (c) out[c[0]] = w; });
      return out;
    }));
    const n = Math.max(1, (t.candles || []).length);
    this.attNorm = 1 / n; // what attention would be if it looked at everything equally
  }

  // ---- drawing -----------------------------------------------------------------------------
  #wake() {
    if (this.running || !this.visible || !this.onScreen || document.hidden) return;
    this.running = true;
    this.lastFrame = 0;
    requestAnimationFrame((t) => this.#frame(t));
  }

  #fps(now) {
    const watched = document.hasFocus() && (now - this.lastInput < 10_000 || now - this.t0 < T.end * 1000);
    if (this.#saving) return watched ? 30 : 12;
    if (!document.hasFocus()) return 20;
    return this.eco && !watched ? 30 : 0;
  }

  #frame(now) {
    if (!this.visible || !this.onScreen || document.hidden) {
      this.running = false;
      return;
    }
    requestAnimationFrame((t) => this.#frame(t));
    const cap = this.#fps(now);
    if (cap && now - this.lastFrame < 1000 / cap - 3) return;
    const dt = Math.min(0.1, (now - (this.lastFrame || now)) / 1000);
    this.lastFrame = now;
    if (this.queue && now - this.t0 > T.end * 1000) this.#play(this.queue);
    this.#update(now, dt);
    this.composer.render(dt);
    this.#placeLabels();
  }

  #update(now, dt) {
    const time = now / 1000;
    const th = this.thought;
    // Without a thought, the scene rests with the architecture faintly lit.
    const c = th ? (now - this.t0) / 1000 * (this.reduce ? 3 : 1) : 99;
    this.#camera(c, dt);
    this.controls.update(dt);
    this.#drawTransformer(c, time, th);
    this.#drawExperts(c, time, th);
    this.#drawGalaxy(c, time, th, dt);
  }

  // The camera glides along with the idea (unless you took it, or "Follow" is off).
  #camera(c, dt) {
    const g = this.goal;
    if (!g) return;
    const fit = this.fit || 1;
    if (g.home) {
      const k = 1 - Math.exp(-dt * 2.2);
      const want = this.home.target.clone().add(this.home.offset);
      this.controls.target.lerp(this.home.target, k);
      this.camera.position.lerp(want, k);
      if (this.camera.position.distanceTo(want) < 0.05) this.goal = null;
      return;
    }
    const shots = [
      [0, new THREE.Vector3(ZT.x + 0.3, -0.4, 0), new THREE.Vector3(-2, 4, 17.5)],
      [T.rise[0], new THREE.Vector3((ZE.x + ORB.x) / 2 + 0.4, 0.2, 0), new THREE.Vector3(-0.5, 3, 13)],
      [T.comet[0] + 0.3, ZG.clone(), new THREE.Vector3(2.5, 4.5, 14.5)],
      [T.end, this.home.target.clone(), this.home.offset.clone()],
    ];
    let i = 0;
    while (i + 1 < shots.length && c >= shots[i + 1][0]) i++;
    const [, tgt, off] = shots[i];
    const k = 1 - Math.exp(-dt * 1.8);
    this.controls.target.lerp(tgt, k);
    this.camera.position.lerp(tgt.clone().addScaledVector(off, i === shots.length - 1 ? 1 : fit), k);
    if (c > T.end + 2.5) this.goal = null;
  }

  #overview(snap = false) {
    const fit = this.fit || 1;
    this.home = { target: new THREE.Vector3(6.2, 0.9, 0), offset: new THREE.Vector3(-1.5, 7.5, 38).multiplyScalar(fit) };
    if (snap) {
      this.controls.target.copy(this.home.target);
      this.camera.position.copy(this.home.target).add(this.home.offset);
      this.controls.update();
    }
  }

  #drawTransformer(c, time, th) {
    const show = th ? ease(smooth(...T.candles, c)) : 0;
    this.tf.candles.forEach(({ m, w }, s) => {
      const k = clamp(show * 1.5 - s / 40, 0, 1) * 0.95;
      m.material.opacity = k;
      w.material.opacity = k;
    });
    this.tf.idea.rotation.y = time * 1.1;
    this.tf.idea.material.color.setRGB(1, 1, 1).multiplyScalar(0.35 + 0.65 * (th ? 1 : 0.4));
    const cols = this.tf.cols.length;
    const NC = this.tf.neurons.geometry.attributes.color.array;
    const SC = this.tf.stream.geometry.attributes.color.array;
    const blue = new THREE.Color(C.neuron);
    const gold = new THREE.Color(C.gold);
    for (let l = 0; l < 2; l++) {
      const lit = th ? smooth(T[`l${l + 1}`][0], T[`l${l + 1}`][1] - 0.4, c) : 0;
      for (let i = 0; i < cols; i++) {
        const idea = i === cols - 1;
        let w = 0.25;
        if (th && this.att?.[l] && !idea) w = 0.25 + Math.min(1.2, this.att[l].reduce((s, a) => s + a[i], 0) / 4 / this.attNorm) * 0.6;
        const base = idea ? gold : blue;
        const k = (0.14 + 0.86 * lit) * (idea ? 1.2 : w);
        NC.set([base.r * k, base.g * k, base.b * k], (l * cols + i) * 3);
        const s = 0.05 + 0.1 * lit;
        SC.set([0.23 * s, 0.51 * s, 0.96 * s, 0.23 * s, 0.51 * s, 0.96 * s], (l * cols + i) * 6);
      }
    }
    this.tf.neurons.geometry.attributes.color.needsUpdate = true;
    this.tf.stream.geometry.attributes.color.needsUpdate = true;
    // The attention arcs grow from the candles to the idea, as bright as the head looked.
    const PP = this.tf.pulses.geometry.attributes.position.array;
    const PC = this.tf.pulses.geometry.attributes.color.array;
    let np = 0;
    this.tf.arcLines.forEach((line, l) => {
      const C2 = line.geometry.attributes.color.array;
      const [a0, a1] = T[`l${l + 1}`];
      const grow = th ? ease(smooth(a0, a1 - 0.3, c)) : 0;
      for (const arc of this.tf.arcs) {
        if (arc.l !== l) continue;
        const w = this.att?.[l]?.[arc.h]?.[arc.s] ?? 0;
        // How much more than an even share this head looked at this candle: an even look stays
        // faint, three times an even share or more is full brightness.
        const strength = th ? 1.3 * clamp((w / this.attNorm - 1) / 2, 0, 1) ** 1.2 : 0;
        const hc = HEADS[arc.h];
        for (let q = 0; q < SEG; q++) {
          const on = q / SEG <= grow ? 1 : 0;
          const k = (0.018 + strength) * on;
          const o = (arc.start + q) * 6;
          C2[o] = C2[o + 3] = hc.r * k;
          C2[o + 1] = C2[o + 4] = hc.g * k;
          C2[o + 2] = C2[o + 5] = hc.b * k;
        }
        if (grow >= 1 && strength > 0.35 && np < 64 && c < T.end + 30) {
          const u = (time * 0.8 + arc.s * 0.13 + arc.h * 0.21) % 1;
          const q = arc.pts[Math.min(SEG, Math.floor(u * SEG))];
          PP.set([q.x, q.y, q.z], np * 3);
          PC.set([hc.r * 1.3, hc.g * 1.3, hc.b * 1.3], np * 3);
          np++;
        }
      }
      line.geometry.attributes.color.needsUpdate = true;
    });
    this.tf.pulses.geometry.setDrawRange(0, np);
    this.tf.pulses.geometry.attributes.position.needsUpdate = true;
    this.tf.pulses.geometry.attributes.color.needsUpdate = true;
    // The candle it looked at hardest, named in the scene when it really stood out (more than
    // half again an even share); the side panel lists the top three either way.
    const top = (th?.top || []).filter((x) => x.w > 1.5 * this.attNorm);
    this.keyLbls.forEach((kl, j) => {
      const tp = top[j];
      if (!tp) { kl.op = 0; return; }
      kl.pos.set(xOf(tp.slot), ROW_Y + 1.25, 0.4);
      const html = `${TF_LABEL[tp.tf] || ''} · ${nyTime((tp.t + tp.tf * 60) * 1000)} · ${Math.round(tp.w * 100)}%`;
      if (kl.el.innerHTML !== html) kl.el.innerHTML = html;
      kl.op = th ? smooth(T.l2[1] - 0.3, T.l2[1], c) : 0;
    });
  }

  #drawExperts(c, time, th) {
    const gates = th?.gates || [0.2, 0.2, 0.2, 0.2, 0.2];
    const top2 = gates.map((g, k) => [g, k]).sort((a, b) => b[0] - a[0]).slice(0, 2).map((x) => x[1]);
    const routing = th ? smooth(...T.router, c) : 0;
    this.ex.router.rotation.y = time * (0.25 + (routing > 0 && routing < 1 ? 1.6 : 0.15));
    this.ex.router.rotation.x = time * 0.12;
    this.ex.core.material.color.set(C.router).multiplyScalar(0.35 + 0.65 * routing);
    const outK = th ? smooth(...T.out, c) : 0;
    this.ex.orb.material.color.set('#dbeafe').multiplyScalar(0.2 + 0.75 * outK);
    this.ex.orb.scale.setScalar(1 + 0.3 * outK);
    const lit = th ? ease(smooth(...T.experts, c)) : 0;
    for (const e of this.ex.experts) {
      const g = gates[e.k];
      const chosen = top2.includes(e.k);
      const PC = e.pts.geometry.attributes.color.array;
      e.nodes.forEach((nd, i) => {
        const wave = clamp(lit * 3.2 - nd.l, 0, 1);
        const kk = 0.12 + wave * (0.25 + 1.6 * g) * (chosen ? 1 : 0.6);
        PC.set([e.color.r * kk, e.color.g * kk, e.color.b * kk], i * 3);
      });
      e.pts.geometry.attributes.color.needsUpdate = true;
      const LC = e.ln.geometry.attributes.color.array;
      e.links.forEach(([a], i) => {
        const wave = clamp(lit * 3.2 - a.l - 0.5, 0, 1);
        const kk = 0.025 + wave * (0.06 + 0.5 * g);
        LC.set([e.color.r * kk, e.color.g * kk, e.color.b * kk, e.color.r * kk, e.color.g * kk, e.color.b * kk], i * 6);
      });
      e.ln.geometry.attributes.color.needsUpdate = true;
      const lbl = this.expertLbls[e.k];
      const html = `${['Indices', 'FX', 'Gold', 'Oil', 'Crypto'][e.k]}${th ? ` <b>${Math.round(g * 100)}%</b>` : ''}`;
      if (lbl.el.innerHTML !== html) lbl.el.innerHTML = html;
      lbl.op = 0.45 + 0.55 * (chosen ? Math.max(0.4, lit) : 0.3);
    }
    // The beams.
    const BP = this.ex.beams.geometry.attributes.position.array;
    const BC = this.ex.beams.geometry.attributes.color.array;
    const FP = this.ex.flow.geometry.attributes.position.array;
    const FC = this.ex.flow.geometry.attributes.color.array;
    let b = 0;
    let f = 0;
    const tmp = new THREE.Vector3();
    const curve = (a, z, lift, k, col, flowK, nFlow) => {
      const ctl = a.clone().add(z).multiplyScalar(0.5);
      ctl.y += lift;
      ctl.z += 0.8;
      for (let s = 0; s < 30; s++) {
        const p0 = bez(a, ctl, z, s / 30, new THREE.Vector3());
        const p1 = bez(a, ctl, z, (s + 1) / 30, new THREE.Vector3());
        BP.set([p0.x, p0.y, p0.z, p1.x, p1.y, p1.z], b * 6);
        BC.set([col.r * k, col.g * k, col.b * k, col.r * k, col.g * k, col.b * k], b * 6);
        b++;
      }
      for (let i = 0; i < nFlow && flowK > 0 && f < 260; i++) {
        bez(a, ctl, z, (time * 0.7 + i / nFlow) % 1, tmp);
        FP.set([tmp.x, tmp.y, tmp.z], f * 3);
        FC.set([col.r * flowK * 1.3, col.g * flowK * 1.3, col.b * flowK * 1.3], f * 3);
        f++;
      }
    };
    const rise = th ? smooth(...T.rise, c) : 0;
    const beamCol = new THREE.Color(C.beam);
    const from = new THREE.Vector3(IDEA_X, TOP_Y, 0);
    curve(from, ZE, 1.6, 0.04 + 0.5 * rise * (1 - 0.6 * smooth(T.router[1], T.end, c)), beamCol, rise > 0 && rise < 1 ? 1 : 0, 26);
    for (const e of this.ex.experts) {
      const g = gates[e.k];
      const chosen = top2.includes(e.k);
      curve(ZE, e.inPt, 0.3, (0.02 + (chosen ? 0.9 : 0.25) * g) * routing, e.color, routing > 0 && c < T.out[1] ? routing * (chosen ? 1 : 0.3) : 0, Math.round(6 + 30 * g));
      curve(e.outPt, ORB, 0.2, chosen ? (0.05 + 0.8 * g) * outK : 0.02 * outK, e.color, chosen && outK > 0 && c < T.comet[0] ? outK : 0, Math.round(6 + 24 * g));
    }
    this.ex.beams.geometry.setDrawRange(0, b * 2);
    this.ex.flow.geometry.setDrawRange(0, f);
    for (const at of [this.ex.beams.geometry.attributes.position, this.ex.beams.geometry.attributes.color, this.ex.flow.geometry.attributes.position, this.ex.flow.geometry.attributes.color]) at.needsUpdate = true;
    const orb = th && outK > 0.05 ? `${Math.round(th.p * 100 * Math.min(1, outK * 1.2))}%` : '';
    if (this.orbLbl.el.innerHTML !== orb) this.orbLbl.el.innerHTML = orb;
    this.orbLbl.el.title = 'Its chance of profit';
  }

  #drawGalaxy(c, time, th, dt) {
    const g = this.gx.group;
    g.rotation.y += dt * (this.reduce ? 0 : 0.05);
    g.updateMatrixWorld();
    const land = th?.pos ? new THREE.Vector3(...th.pos.map((v) => v * GS)) : null;
    // The comet from the answer to where the idea lands.
    const CP = this.gx.comet.geometry.attributes.position.array;
    const CC = this.gx.comet.geometry.attributes.color.array;
    const fly = th && land ? ease(smooth(...T.comet, c)) : 0;
    const to = land ? land.clone().applyMatrix4(g.matrixWorld) : ZG.clone();
    const ctl = ORB.clone().lerp(to, 0.5).add(new THREE.Vector3(0, 3.2, 1.5));
    const tmp = new THREE.Vector3();
    for (let i = 0; i < 28; i++) {
      const u = clamp(fly - i * 0.012, 0, 1);
      bez(ORB, ctl, to, u, tmp);
      CP.set([tmp.x, tmp.y, tmp.z], i * 3);
      const k = fly > 0 && fly < 1 ? (1 - i / 28) ** 1.5 : 0;
      CC.set([k, k, k], i * 3);
    }
    this.gx.comet.geometry.attributes.position.needsUpdate = true;
    this.gx.comet.geometry.attributes.color.needsUpdate = true;
    // Its closest past trades.
    const near = th?.near || [];
    const linkK = th && land ? ease(smooth(...T.near, c)) : 0;
    const NP = this.gx.near.geometry.attributes.position.array;
    const NC = this.gx.near.geometry.attributes.color.array;
    const LP = this.gx.lines.geometry.attributes.position.array;
    const LC = this.gx.lines.geometry.attributes.color.array;
    const win = new THREE.Color(C.win);
    const loss = new THREE.Color(C.loss);
    if (land) near.forEach((nb, i) => {
      const k = clamp(linkK * near.length - i, 0, 1);
      const col = nb.r > 0 ? win : loss;
      const p = new THREE.Vector3(...(nb.pos || [0, 0, 0]).map((v) => v * GS));
      NP.set([p.x, p.y, p.z], i * 3);
      NC.set([col.r * 1.4 * k, col.g * 1.4 * k, col.b * 1.4 * k], i * 3);
      tmp.copy(land).lerp(p, k);
      LP.set([land.x, land.y, land.z, tmp.x, tmp.y, tmp.z], i * 6);
      LC.set([0.65 * k, 0.65 * k, 0.65 * k, col.r * k, col.g * k, col.b * k], i * 6);
    });
    this.gx.near.geometry.setDrawRange(0, land ? near.length : 0);
    this.gx.lines.geometry.setDrawRange(0, land ? near.length * 2 : 0);
    for (const at of [this.gx.near.geometry.attributes.position, this.gx.near.geometry.attributes.color, this.gx.lines.geometry.attributes.position, this.gx.lines.geometry.attributes.color]) at.needsUpdate = true;
    // The ring where it landed (or where a closed trade's star appeared).
    const ringAt = this.ring && performance.now() - this.ring.t0 < 1600 ? this.ring : th && land && c > T.comet[1] && c < T.comet[1] + 1.6 ? { pos: land, t0: this.t0 + T.comet[1] * 1000, color: new THREE.Color('#ffffff') } : null;
    if (ringAt) {
      const r = (performance.now() - ringAt.t0) / 1600;
      this.gx.ring.position.copy(ringAt.pos);
      this.gx.ring.scale.setScalar(0.2 + r * 2.4);
      this.gx.ring.material.color.copy(ringAt.color);
      this.gx.ring.material.opacity = (1 - r) * 0.9;
      this.gx.ring.lookAt(this.camera.position);
    } else this.gx.ring.material.opacity = 0;
    if (land) {
      this.landLbl.pos.copy(land).add(new THREE.Vector3(0, 0.75, 0));
      const html = near.length ? `${th.nearWon} of ${near.length} similar won` : 'no past trades yet';
      if (this.landLbl.el.innerHTML !== html) this.landLbl.el.innerHTML = html;
      this.landLbl.op = smooth(T.comet[1], T.near[1], c);
    } else this.landLbl.op = 0;
    const title = `<b>3</b><span>Remembers</span><small>memory of ${this.gx.n.toLocaleString('en-US')} trades</small>`;
    if (this.galaxyTitle.el.innerHTML !== title) this.galaxyTitle.el.innerHTML = title;
  }

  #resize() {
    const w = this.stage.clientWidth || 900;
    const h = this.stage.clientHeight || 560;
    const pr = Math.min(window.devicePixelRatio || 1, this.#saving ? 1 : 1.75);
    this.renderer.setPixelRatio(pr);
    this.renderer.setSize(w, h, false);
    this.composer.setPixelRatio(pr);
    this.composer.setSize(w, h);
    this.bloom.enabled = !this.#saving;
    this.camera.aspect = w / h;
    this.camera.updateProjectionMatrix();
    // A narrow picture steps back so the whole scene fits.
    const fit = Math.max(1, (2.1 / (w / h)) ** 0.95);
    const changed = Math.abs(fit - (this.fit || 0)) > 0.01;
    this.fit = fit;
    this.controls.maxDistance = 75 * fit;
    if (changed) this.#overview(!this.goal);
    this.#wake();
  }

  // ---- the side panel and the cards ------------------------------------------------------------
  #renderHead() {
    const v = this.view;
    if (!v) return;
    const st = this.root.querySelector('#dp-status');
    const map = { training: ['LEARNING NOW', 'gold'], untrained: ['NOT TRAINED YET', 'warn'], learning: ['WATCHING · LEARNING', 'warn'], trusted: ['HAS A SAY', 'ok'] };
    const [word, cls] = map[v.status] || ['—', 'warn'];
    st.textContent = v.demo && !v.ready ? 'LIVE MODE ONLY' : word;
    st.className = `pill dp-status ${cls}`;
    const sub = this.root.querySelector('#dp-sub');
    if (sub.classList.contains('dp-note')) return;
    const d = v.design || {};
    sub.textContent = v.ready
      ? `Version ${v.version}${v.trainedAt ? `, learned ${new Date(v.trainedAt).toLocaleDateString(undefined, { day: 'numeric', month: 'short' })}` : ''} · a transformer (${d.layers} layers × ${d.heads} heads, ${d.params?.toLocaleString('en-US') ?? '?'} learned numbers) reads the 24 candles before each idea, a router asks five market experts, and it remembers ${v.memory?.n?.toLocaleString('en-US') ?? 0} past trades`
      : 'A transformer that reads the candles before each idea, five market experts and a memory of past trades. It learns on this computer from your real prices.';
    this.root.querySelector('[data-act="dp-learn"]').disabled = v.demo || v.status === 'training';
  }

  #renderOverlay() {
    const v = this.view;
    const el = this.overlay;
    // A working version keeps the scene clear; its next lesson shows in the header and below.
    if (!v || v.ready) { el.hidden = true; return; }
    if (v.status === 'training') {
      const p = v.learning || {};
      el.innerHTML = `<b>Learning now</b><p>${escapeHtml(p.text || 'Starting…')}</p><div class="dp-progress"><i style="width:${Math.round((p.pct ?? 0) * 100)}%"></i></div><p class="fine">In the background: the desks keep trading. The first lesson takes a few minutes.</p>`;
      el.hidden = false;
      return;
    }
    if (v.demo) {
      el.innerHTML = '<b>Learns from real prices only</b><p>In demo mode the prices are simulated, so the deep brain doesn\'t learn. Start the floor in live mode and it learns on this computer from your broker\'s prices.</p>';
      el.hidden = false;
      return;
    }
    const need = v.settings?.minHistoryDays ?? 21;
    const rows = Object.entries(v.history || {}).filter(([, h]) => h.real !== false).sort((a, b) => b[1].days - a[1].days).slice(0, 10)
      .map(([id, h]) => `<li><span>${escapeHtml(id)}</span><i><b style="width:${Math.min(100, Math.round((h.days / need) * 100))}%"></b></i><small>${h.days} of ${need} days</small></li>`).join('');
    el.innerHTML = `<b>Not trained yet</b><p>${v.lastError ? escapeHtml(v.lastError.text) : `It learns on this computer as soon as a market has ${need} days of saved prices: MT5 pages months of your broker's prices in, and the floor saves every new minute.`}</p>${rows ? `<ul class="dp-days">${rows}</ul>` : ''}`;
    el.hidden = false;
  }

  #renderSide() {
    const el = this.root.querySelector('#dp-side');
    const v = this.view;
    const t = this.thought;
    if (!t) {
      el.innerHTML = `<h3>Thinking now</h3><p class="muted">${v?.ready ? 'Waiting for a desk to have an idea: every idea any desk has is read here before it trades.' : 'Once it has learned, every idea any desk has is read here before it trades.'}</p>${this.#recentHtml()}`;
      return;
    }
    const [word, color] = verdictOf(t);
    const p = this.store.profileById?.[t.desk];
    const near = t.near || [];
    const nearRows = near.slice(0, 5).map((n) => {
      const who = this.store.profileById?.[n.desk]?.name?.split(' ')[0] || String(n.desk || '').replace(/^./, (ch) => ch.toUpperCase());
      return `<li ${this.store.profileById?.[n.desk] ? `data-desk="${escapeHtml(n.desk)}"` : ''}><i style="background:${n.r > 0 ? C.win : C.loss}"></i><span><b>${escapeHtml(who)}</b> ${escapeHtml(n.symbol)} · ${new Date(n.t).toLocaleDateString(undefined, { day: 'numeric', month: 'short', year: n.src === 'history' ? '2-digit' : undefined })}</span><b class="${n.r > 0 ? 'pos' : 'neg'}">${fmtR(n.r)}</b><small>${SRC[n.src === 'own' ? 2 : n.src === 'replay' ? 1 : 0]}</small></li>`;
    }).join('');
    const top = (t.top || []).map((x) => `<li>${TF_LABEL[x.tf] || ''} candle ending ${nyTime((x.t + x.tf * 60) * 1000)} <b>${Math.round(x.w * 100)}%</b></li>`).join('');
    const gates = (t.gates || []).map((g, k) => `<div class="bar" style="--c:${EXPERT_COLORS[k]}"><span>${['Indices', 'FX', 'Gold', 'Oil', 'Crypto'][k]}</span><i style="--w:${Math.round(g * 100)}%"></i><b>${Math.round(g * 100)}%</b><small title="This expert's own chance of profit">${pct(t.experts?.[k])}</small></div>`).join('');
    el.innerHTML = `
      <h3>Thinking now</h3>
      <div class="dp-now" ${p ? `data-desk="${escapeHtml(t.desk)}"` : ''}>
        <span class="av" style="background:${p?.accent || '#475569'}">${escapeHtml(p ? initials(p.name) : '?')}</span>
        <div><b>${escapeHtml(t.name || t.desk)}</b> · ${escapeHtml(t.symbol)} ${escapeHtml(String(t.side || '').toLowerCase())} <small class="muted">${nyTime(t.at)}</small>
        <div class="dp-p"><span class="dp-big">${pct(t.p)}</span> chance of profit · <b class="${t.expR >= 0 ? 'pos' : 'neg'}">${fmtR(t.expR)}</b> expected</div>
        <span class="dp-verdict" style="background:${color}">${word}</span></div>
      </div>
      <h3>What it read hardest</h3>
      <ol class="dp-top">${top || '<li class="muted">No candles to read: the market had no saved prices before this idea.</li>'}</ol>
      <h3>The router's choice <small class="muted">(trust · own answer)</small></h3>
      <div class="bars dp-bars">${gates}</div>
      <h3>The closest past trades</h3>
      ${near.length ? `<p class="dp-nearsum"><b>${t.nearWon} of ${near.length}</b> won · average <b class="${(t.nearAvgR ?? 0) >= 0 ? 'pos' : 'neg'}">${fmtR(t.nearAvgR)}</b></p><ul class="dp-near">${nearRows}</ul>` : '<p class="muted">Its memory is empty so far.</p>'}
      ${this.#recentHtml()}`;
  }

  #recentHtml() {
    const list = (this.view?.thoughts || []).slice().reverse().slice(0, 8);
    if (!list.length) return '';
    return `<h3>Recent thoughts</h3><ol class="dp-recent">${list.map((t) => {
      const [word, color] = verdictOf(t);
      return `<li data-thought="${escapeHtml(t.id)}" class="${t.id === this.thought?.id ? 'on' : ''}"><i style="background:${color}"></i><span><b>${escapeHtml(t.name || t.desk)}</b> ${escapeHtml(t.symbol)} ${escapeHtml(String(t.side || '').toLowerCase())}</span><b>${pct(t.p)}</b><small>${escapeHtml(word)}</small></li>`;
    }).join('')}</ol>`;
  }

  #renderCards() {
    const v = this.view;
    if (!v) return;
    const val = v.validation;
    const row = (name, s, cls = '') => `<tr class="${cls}"><td>${name}</td><td class="r num">${s?.auc ?? '—'}</td><td class="r num ${s?.pickedR == null ? '' : s.pickedR >= 0 ? 'pos' : 'neg'}">${fmtR(s?.pickedR)}</td><td class="r num ${s?.allR == null ? '' : s.allR >= 0 ? 'pos' : 'neg'}">${fmtR(s?.allR)}</td><td class="r num">${s?.picked ?? '—'}</td></tr>`;
    this.root.querySelector('#dp-test').innerHTML = `<h3>The fair test</h3>
      ${val ? `<p class="fine">At its last lesson, the newest ${val.n.toLocaleString('en-US')} trades were kept back. It never learned from them; then it judged each one. "Its picks" is what the trades it would take made, "every trade" what taking them all made. Skill 0.5 is a coin.</p>
        <div class="table-wrap"><table class="table compact"><thead><tr><th></th><th class="r">Skill</th><th class="r">Its picks</th><th class="r">Every trade</th><th class="r">Picks</th></tr></thead><tbody>
        ${row('Deep brain (this version)', val.challenger, 'hl')}${val.champion ? row('The version before', val.champion) : ''}${val.mlp ? row('Neural brain', val.mlp) : ''}</tbody></table></div>` : '<p class="fine">It is tested after its first lesson, on the newest trades it never learned from, side by side with the neural brain.</p>'}
      ${v.skill?.text ? `<p class="fine">${escapeHtml(v.skill.text.replace(/\.+$/, ''))}.</p>` : ''}`;
    const d = v.data;
    const pre = v.pretrain;
    const prog = v.status === 'training' && v.learning ? `<div class="dp-progress"><i style="width:${Math.round((v.learning.pct ?? 0) * 100)}%"></i></div><p class="fine">${escapeHtml(v.learning.text || '')}</p>` : '';
    const hist = (v.versions || []).slice().reverse().slice(0, 5).map((r) => `<li>${new Date(r.at).toLocaleString(undefined, { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' })}: ${r.adopted ? `<b class="pos">learned · v${r.version}</b>` : '<span class="muted">kept what it knew</span>'} <span class="muted">(tested on ${r.held} trades)</span></li>`).join('');
    this.root.querySelector('#dp-learn').innerHTML = `<h3>How it learns</h3>${prog}
      ${d ? `<ul class="dp-data">
        <li><b>${(d.replays ?? 0).toLocaleString('en-US')}</b> practice trades: ${d.replayDesks ?? 0} desks replayed on your saved prices</li>
        <li><b>${(d.own ?? 0).toLocaleString('en-US')}</b> of the floor's own trades on real prices (they count 3×)</li>
        <li><b>${(d.shipped ?? 0).toLocaleString('en-US')}</b> trades from the neural brain's long history (senses only, no candles)</li>
        ${pre ? `<li>Pre-training: guessed whether price was higher 15 minutes later at <b>${pre.n.toLocaleString('en-US')}</b> moments, right <b>${Math.round((pre.hit ?? 0) * 100)}%</b> of the time on moments it hadn't practised on (50% is a coin)</li>` : ''}
      </ul>` : '<p class="fine">Like a language model, in two stages: first it learns to read candles by guessing what price does next across all your saved history (no labels needed), then it learns which of the desks\' trades won. It relearns after the New York close once it has 30 new trades of its own or a week of new prices, and keeps a new version only if it judges unseen trades better.</p>'}
      <p class="fine">${v.own ? `${v.own.n} trades of its own so far, ${v.own.newSinceTrain} since its last lesson.` : ''} Demo mode never teaches it. Everything it knows is in <code>data/deep/</code>.</p>
      ${hist ? `<ol class="nb-hist">${hist}</ol>` : ''}`;
  }
}
