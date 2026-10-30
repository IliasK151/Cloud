import * as THREE from 'three';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import { EffectComposer } from 'three/addons/postprocessing/EffectComposer.js';
import { RenderPass } from 'three/addons/postprocessing/RenderPass.js';
import { UnrealBloomPass } from 'three/addons/postprocessing/UnrealBloomPass.js';
import { OutputPass } from 'three/addons/postprocessing/OutputPass.js';
import { escapeHtml, initials, nyTime } from '../format.js';

// The floor's mind (top of the Brain tab): one brain for every thought on the floor, live in 3D.
//
// Thousands of neurons in the shape of a brain. The London desks live in its left half, the
// New York desks in its right half (each market in the same place on both sides), the Asia
// desk at the back. Down the middle sit the parts every desk thinks with: its senses (real
// prices, structure, liquidity), the news, the neural net it asks before a trade, Claude, the
// floor's memory, the committee, risk, and execution (MT5).
//
// Every bright signal is something that really happened, as it happens:
//   a price moves               Senses → the desks on that market (small sparks)
//   a desk reads its setup      Senses → the desk, and its thought appears beside it
//   it asks the neural net      desk → Neural net → back (green: would take, grey: pass)
//   the deep brain reads it     desk → Deep brain → back (its transformer, experts and memory)
//   Claude reviews it           desk → Claude → back with its verdict
//   the committee argues it     desk → Committee → each reviewer (green agrees, red doesn't)
//   it trades                   desk → Risk → Execution (green: buy, red: sell)
//   the trade closes            Execution → desk → Memory (green: won, red: lost)
//   it learns                   desk → Memory in gold; the neural net learning lights it all
// Where a signal lands, a wave of light runs through the neurons around it. The faint
// shimmer is only the brain at rest: nothing in it is made up.
//
// It draws only while the Brain tab is open and the mind is on screen; on battery with the
// battery saver on, it turns slower, without the glow.

const REGIONS = [
  { id: 'senses', label: 'Senses', color: '#38bdf8', pos: [0, 0.16, -1.16], card: null, tip: 'Real prices, from MT5 or the public feed. Every desk\'s top-down read, its liquidity levels and structure start here.' },
  { id: 'news', label: 'News', color: '#f59e0b', pos: [0, 0.64, -0.66], card: null, tip: 'The economic calendar: desks stand aside around the releases that move their market.' },
  { id: 'neural', label: 'Neural net', color: '#60a5fa', pos: [0, 0.14, -0.12], card: '#bv-neural', tip: 'The neural network every desk asks before a trade: its chance of profit. It retrains itself on the floor\'s own trades.' },
  { id: 'deep', label: 'Deep brain', color: '#f472b6', pos: [0, 0.4, 0.3], card: '#bv-deep', tip: 'The deep brain: a transformer that reads the 24 candles before every idea, five market experts and a memory of past trades. It learns on this computer from real prices.' },
  { id: 'memory', label: 'Memory', color: '#2dd4bf', pos: [0, -0.36, -0.42], card: '#bv-memory', tip: 'Every trade, lesson and debate, linked: the floor\'s long-term memory. Desks recall it before they trade.' },
  { id: 'claude', label: 'Claude', color: '#c084fc', pos: [0, 0.56, 0.84], card: '#bv-llm', tip: 'Claude, the LLM brain: reviews every setup, is scored on every result and keeps a lesson book.' },
  { id: 'committee', label: 'Committee', color: '#e2e8f0', pos: [0, 0.8, 0.12], card: '#bv-depts', tip: 'Each department argues every idea before it trades.' },
  { id: 'risk', label: 'Risk', color: '#fb7185', pos: [0, -0.16, 1.12], card: '#bv-account', tip: 'The account brain: risk per trade, the daily stop and the prop firm\'s limits.' },
  { id: 'exec', label: 'Execution', color: '#4ade80', pos: [0, -1.22, -0.46], card: null, tip: 'Orders go out here: to MT5 on your account, and to the paper book.' },
];
// The wiring always drawn, faintly: how the parts of the mind connect.
const SKELETON = [['news', 'senses'], ['senses', 'neural'], ['senses', 'deep'], ['deep', 'memory'], ['deep', 'risk'], ['neural', 'memory'], ['neural', 'claude'], ['claude', 'risk'], ['committee', 'risk'], ['committee', 'claude'], ['risk', 'exec'], ['memory', 'exec']];

const COL = {
  deep: '#f472b6',
  price: '#38bdf8', read: '#7dd3fc', buy: '#34d399', sell: '#fb7185', win: '#4ade80', loss: '#f87171', gold: '#fbbf24',
  claude: '#c084fc', neural: '#60a5fa', memory: '#2dd4bf', news: '#f59e0b', white: '#e2e8f0', grey: '#94a3b8',
};
const LEGEND = [['Price', COL.price], ['A desk\'s read', COL.read], ['Buy · win', COL.win], ['Sell · loss', COL.loss], ['Learned', COL.gold], ['Claude', COL.claude], ['Neural net', COL.neural]];

// The brain's shape (scene units: about 2.3 wide, 2.3 long, 2.1 tall). x: left → right,
// y: up, z: back → front.
const HEMI_C = [new THREE.Vector3(-0.5, 0.08, 0), new THREE.Vector3(0.5, 0.08, 0)];
const HEMI_R = new THREE.Vector3(0.6, 0.74, 1.1);
const CEREB_C = new THREE.Vector3(0, -0.5, -0.74);
const CEREB_R = new THREE.Vector3(0.58, 0.28, 0.36);
const STEM_A = new THREE.Vector3(0, -0.34, -0.36);
const STEM_B = new THREE.Vector3(0, -1.24, -0.46);
// Markets front to back along each half, so a market's London and New York desks mirror.
const MARKET_ORDER = ['NAS100', 'SPX500', 'XAUUSD', 'USOIL', 'EURUSD', 'GBPUSD', 'USDJPY', 'BTCUSD', 'ETHUSD', 'SOLUSD'];

const WAVES = 12;
const TRAIL = 26;
const MAX_VERTS = 4000;
const MAX_RIPPLES = 48;
const ARC_SEG = 64;
const FEED_MAX = 40;
const CAPTIONS_MAX = 3;
const pct = (x) => (x == null ? '—' : `${Math.round(x * 100)}%`);
const fmtR = (x) => (x == null ? '—' : `${x >= 0 ? '+' : '−'}${Math.abs(x).toFixed(2)}R`);
const ease = (t) => (t < 0.5 ? 4 * t * t * t : 1 - (-2 * t + 2) ** 3 / 2);
const clamp = (x, a, b) => Math.max(a, Math.min(b, x));

function rng(seed) {
  return () => {
    seed = (seed + 0x6d2b79f5) | 0;
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const ell = (x, y, z, c, r) => Math.hypot((x - c.x) / r.x, (y - c.y) / r.y, (z - c.z) / r.z) - 1;
// The folds of the cortex: 1 along each fold's crest, falling to 0 in the grooves between.
function gyri(x, y, z) {
  const a = Math.sin(x * 7.3 + Math.sin(y * 5.1 + z * 2.3) * 1.9 + z * 3.1);
  const b = Math.sin(z * 8.9 + Math.sin(x * 4.7 - y * 1.7) * 2.1 + y * 2.3);
  const c = Math.sin(y * 9.7 + Math.sin(z * 5.3 + x * 2.9) * 1.6);
  return clamp(1 - Math.abs((a + b + c) / 3) * 2.2, 0, 1);
}

// The neurons: most on the folded surface of the two halves, the rest in the cerebellum,
// the brainstem and, sparsely, inside. part: 0 left, 1 right, 2 cerebellum, 3 brainstem.
function brainCloud(n, rnd) {
  const pos = [];
  const part = [];
  const dir = () => {
    const u = rnd() * 2 - 1;
    const t = rnd() * Math.PI * 2;
    const s = Math.sqrt(1 - u * u);
    return [s * Math.cos(t), u, s * Math.sin(t)];
  };
  const want = { cortex: Math.round(n * 0.7), inner: Math.round(n * 0.1), cereb: Math.round(n * 0.14) };
  want.stem = n - want.cortex - want.inner - want.cereb;
  for (let k = 0, got = 0; got < want.cortex && k < n * 40; k++) {
    const side = k % 2;
    const c = HEMI_C[side];
    const [dx, dy, dz] = dir();
    const x0 = c.x + dx * HEMI_R.x;
    const y0 = c.y + dy * HEMI_R.y;
    const z0 = c.z + dz * HEMI_R.z;
    const g = gyri(x0, y0, z0);
    // Neurons gather on the crests of the folds, which is what draws them.
    if (rnd() > 0.25 + 0.75 * g) continue;
    const r = 1 + 0.06 * g + (rnd() - 0.5) * 0.018;
    const x = c.x + dx * HEMI_R.x * r;
    const y = c.y + dy * HEMI_R.y * r;
    const z = c.z + dz * HEMI_R.z * r;
    // The gap between the halves, and a flatter underside at the front.
    if ((side === 0 && x > -0.04) || (side === 1 && x < 0.04)) continue;
    if (y < -0.4 && z > 0.05) continue;
    pos.push(x, y, z);
    part.push(side);
    got++;
  }
  for (let k = 0, got = 0; got < want.inner && k < n * 40; k++) {
    const x = (rnd() * 2 - 1) * 1.05;
    const y = -0.6 + rnd() * 1.4;
    const z = (rnd() * 2 - 1) * 1.05;
    const side = x < 0 ? 0 : 1;
    if (Math.abs(x) < 0.06 || ell(x, y, z, HEMI_C[side], HEMI_R) > -0.12 || (y < -0.4 && z > 0.05)) continue;
    pos.push(x, y, z);
    part.push(side);
    got++;
  }
  for (let k = 0, got = 0; got < want.cereb && k < n * 40; k++) {
    const [dx, dy, dz] = dir();
    // Fine horizontal folds (folia).
    const f = Math.abs(Math.sin((CEREB_C.y + dy * CEREB_R.y) * 58));
    if (rnd() > 0.3 + 0.7 * f) continue;
    const r = 1 + 0.05 * f + (rnd() - 0.5) * 0.02;
    const x = CEREB_C.x + dx * CEREB_R.x * r;
    const y = CEREB_C.y + dy * CEREB_R.y * r;
    const z = CEREB_C.z + dz * CEREB_R.z * r;
    if (Math.min(ell(x, y, z, HEMI_C[0], HEMI_R), ell(x, y, z, HEMI_C[1], HEMI_R)) < -0.04) continue;
    pos.push(x, y, z);
    part.push(2);
    got++;
  }
  const ab = STEM_B.clone().sub(STEM_A);
  for (let got = 0; got < want.stem; got++) {
    const t = rnd();
    const a = rnd() * Math.PI * 2;
    const r = 0.13 * (1 - 0.3 * t) * (0.92 + rnd() * 0.12);
    pos.push(STEM_A.x + ab.x * t + Math.cos(a) * r, STEM_A.y + ab.y * t, STEM_A.z + ab.z * t + Math.sin(a) * r);
    part.push(3);
  }
  return { pos, part };
}

// Each neuron wired to its nearest neighbours (a spatial grid keeps it quick).
function wire(pos, maxD, k) {
  const n = pos.length / 3;
  const grid = new Map();
  const cell = (v) => Math.floor(v / maxD);
  const key = (a, b, c) => `${a},${b},${c}`;
  for (let i = 0; i < n; i++) {
    const g = key(cell(pos[i * 3]), cell(pos[i * 3 + 1]), cell(pos[i * 3 + 2]));
    if (!grid.has(g)) grid.set(g, []);
    grid.get(g).push(i);
  }
  const edges = [];
  const seen = new Set();
  for (let i = 0; i < n; i++) {
    const cx = cell(pos[i * 3]);
    const cy = cell(pos[i * 3 + 1]);
    const cz = cell(pos[i * 3 + 2]);
    const near = [];
    for (let dx = -1; dx <= 1; dx++) for (let dy = -1; dy <= 1; dy++) for (let dz = -1; dz <= 1; dz++) {
      for (const j of grid.get(key(cx + dx, cy + dy, cz + dz)) || []) {
        if (j === i) continue;
        const d2 = (pos[i * 3] - pos[j * 3]) ** 2 + (pos[i * 3 + 1] - pos[j * 3 + 1]) ** 2 + (pos[i * 3 + 2] - pos[j * 3 + 2]) ** 2;
        if (d2 < maxD * maxD) near.push([d2, j]);
      }
    }
    near.sort((a, b) => a[0] - b[0]);
    for (const [, j] of near.slice(0, k)) {
      const id = Math.min(i, j) * n + Math.max(i, j);
      if (seen.has(id)) continue;
      seen.add(id);
      edges.push(i, j);
    }
  }
  return edges;
}

// Where each desk sits: London on the left half, New York on the right, Asia at the back.
function deskSpots(profiles) {
  const out = new Map();
  const groups = { london: [], ny: [], asia: [] };
  for (const p of profiles) (groups[p.session] || groups.london).push(p);
  const rank = (p) => {
    const i = MARKET_ORDER.indexOf(p.symbols?.[0]);
    return i < 0 ? MARKET_ORDER.length : i;
  };
  for (const [session, list] of Object.entries(groups)) {
    list.sort((a, b) => rank(a) - rank(b));
    if (session === 'asia') {
      list.forEach((p, i) => {
        const pos = new THREE.Vector3((i - (list.length - 1) / 2) * 0.3, CEREB_C.y - 0.02, CEREB_C.z - CEREB_R.z - 0.05);
        out.set(p.id, { pos, normal: pos.clone().sub(CEREB_C).normalize() });
      });
      continue;
    }
    const side = session === 'ny' ? 1 : -1;
    const c = HEMI_C[side > 0 ? 1 : 0];
    const taken = new Set();
    const slots = list.map((p) => {
      let k = rank(p);
      while (taken.has(k)) k++;
      taken.add(k);
      return [p, k];
    });
    const n = Math.max(MARKET_ORDER.length, ...[...taken].map((k) => k + 1));
    for (const [p, k] of slots) {
      const a = THREE.MathUtils.degToRad(64 - (k * 136) / (n - 1));
      const e = THREE.MathUtils.degToRad(k % 2 ? 4 : 36);
      const dir = new THREE.Vector3(side * Math.cos(e) * Math.cos(a), Math.sin(e), Math.cos(e) * Math.sin(a));
      const pos = new THREE.Vector3(c.x + dir.x * HEMI_R.x, c.y + dir.y * HEMI_R.y, c.z + dir.z * HEMI_R.z).addScaledVector(dir, 0.06);
      out.set(p.id, { pos, normal: dir });
    }
  }
  return out;
}

function dotTexture() {
  const c = document.createElement('canvas');
  c.width = c.height = 64;
  const g = c.getContext('2d');
  const grd = g.createRadialGradient(32, 32, 0, 32, 32, 32);
  grd.addColorStop(0, 'rgba(255,255,255,1)');
  grd.addColorStop(0.4, 'rgba(255,255,255,0.35)');
  grd.addColorStop(1, 'rgba(255,255,255,0)');
  g.fillStyle = grd;
  g.fillRect(0, 0, 64, 64);
  return new THREE.CanvasTexture(c);
}

// ---- shaders ----------------------------------------------------------------------------------
// A wave of light runs out from wherever a signal lands (up to WAVES at once).
const WAVE_GLSL = `
uniform float uTime; uniform float uNear; uniform float uFar;
uniform vec4 uWave[WAVES]; uniform vec3 uWaveC[WAVES];
vec3 waves(vec3 p, out float k) {
  vec3 c = vec3(0.0); k = 0.0;
  for (int i = 0; i < WAVES; i++) {
    float age = uTime - uWave[i].w;
    if (age < 0.0 || age > 2.4) continue;
    float d = distance(p, uWave[i].xyz);
    float band = exp(-pow((d - age * 0.95) / 0.07, 2.0)) * (1.0 - age / 2.4);
    c += uWaveC[i] * band; k += band;
  }
  return c;
}
float depthOf(vec4 mv) { return clamp((uFar + mv.z) / (uFar - uNear), 0.0, 1.0); }
`;

const CLOUD_VS = `${WAVE_GLSL}
uniform float uScale;
attribute vec3 aColor; attribute float aPhase; attribute float aSize;
varying vec3 vColor;
void main() {
  vec4 mv = modelViewMatrix * vec4(position, 1.0);
  float tw = 0.5 + 0.5 * sin(uTime * (0.5 + aPhase) + aPhase * 40.0);
  float k; vec3 w = waves(position, k);
  float depth = depthOf(mv);
  vColor = aColor * (0.4 + 0.6 * tw) * mix(0.22, 1.0, depth) + w * mix(0.35, 1.0, depth);
  gl_PointSize = aSize * uScale * (1.0 + 0.8 * min(k, 1.0)) / -mv.z;
  gl_Position = projectionMatrix * mv;
}`;
const CLOUD_FS = `
varying vec3 vColor;
void main() {
  float r = length(gl_PointCoord - 0.5) * 2.0;
  if (r > 1.0) discard;
  gl_FragColor = vec4(vColor, exp(-r * r * 4.0));
}`;

const WIRE_VS = `${WAVE_GLSL}
uniform vec3 uColor;
attribute float aPhase;
varying vec3 vColor;
void main() {
  vec4 mv = modelViewMatrix * vec4(position, 1.0);
  float k; vec3 w = waves(position, k);
  float tw = 0.6 + 0.4 * sin(uTime * 0.7 + aPhase * 30.0);
  vColor = uColor * tw * mix(0.15, 1.0, depthOf(mv)) + w * 0.6;
  gl_Position = projectionMatrix * mv;
}`;
const WIRE_FS = `
uniform float uAlpha;
varying vec3 vColor;
void main() { gl_FragColor = vec4(vColor, uAlpha); }`;

const ARC_VS = `
uniform float uNear; uniform float uFar;
attribute float aT;
varying float vT; varying float vDepth;
void main() {
  vT = aT;
  vec4 mv = modelViewMatrix * vec4(position, 1.0);
  vDepth = clamp((uFar + mv.z) / (uFar - uNear), 0.0, 1.0);
  gl_Position = projectionMatrix * mv;
}`;
const ARC_FS = `
uniform vec3 uColor; uniform float uBase; uniform float uEnergy; uniform float uTime;
varying float vT; varying float vDepth;
void main() {
  float flow = 0.5 + 0.5 * sin(vT * 22.0 - uTime * 2.6);
  float a = (uBase * (0.45 + 0.55 * flow) + uEnergy * (0.4 + 0.6 * flow)) * mix(0.3, 1.0, vDepth);
  gl_FragColor = vec4(uColor, a);
}`;

const SPRITE_VS = `
uniform float uScale;
attribute vec3 aColor; attribute float aSize; attribute float aAlpha; attribute float aGlow; attribute float aRing;
varying vec3 vColor; varying float vAlpha; varying float vGlow; varying float vRing;
void main() {
  vec4 mv = modelViewMatrix * vec4(position, 1.0);
  vColor = aColor; vAlpha = aAlpha; vGlow = aGlow; vRing = aRing;
  gl_PointSize = aSize * uScale / -mv.z;
  gl_Position = projectionMatrix * mv;
}`;
// A desk or a part of the mind: a white-hot core, a halo that flares when a signal lands,
// and a ring (a desk in a trade, or armed and waiting for its entry).
const HUB_FS = `
varying vec3 vColor; varying float vAlpha; varying float vGlow; varying float vRing;
void main() {
  float r = length(gl_PointCoord - 0.5) * 2.0;
  if (r > 1.0) discard;
  float core = smoothstep(0.2, 0.1, r);
  float disc = smoothstep(0.3, 0.2, r);
  float halo = exp(-r * r * 9.0) * (0.3 + 1.1 * vGlow);
  float ring = smoothstep(0.045, 0.0, abs(r - 0.58)) * vRing;
  vec3 c = vColor * (halo * 1.1 + ring * 1.1 + disc * 0.9) + mix(vColor, vec3(1.0), 0.25) * core * (0.8 + vGlow);
  gl_FragColor = vec4(c, clamp(max(disc, max(halo, ring)), 0.0, 1.0) * vAlpha);
}`;
// A signal: a bright head with a fading tail.
const COMET_FS = `
varying vec3 vColor; varying float vAlpha;
void main() {
  float r = length(gl_PointCoord - 0.5) * 2.0;
  if (r > 1.0) discard;
  float core = exp(-r * r * 9.0);
  gl_FragColor = vec4(vColor * (1.0 + core * 0.8), core * vAlpha);
}`;
// Where a signal lands: a ring of light spreading out.
const RIPPLE_FS = `
varying vec3 vColor; varying float vAlpha;
void main() {
  float r = length(gl_PointCoord - 0.5) * 2.0;
  if (r > 1.0) discard;
  float ring = smoothstep(0.1, 0.0, abs(r - 0.86)) + 0.12 * smoothstep(0.86, 0.0, r);
  gl_FragColor = vec4(vColor, ring * vAlpha);
}`;

const additive = { transparent: true, depthWrite: false, blending: THREE.AdditiveBlending };

export class FloorMind {
  constructor(store, root, { onSelect } = {}) {
    this.store = store;
    this.root = root;
    this.onSelect = onSelect;
    this.visible = false;
    this.onScreen = true;
    this.running = false;
    this.eco = document.documentElement.classList.contains('eco');
    this.battery = false;
    this.hubs = [];
    this.hub = new Map();
    this.arcs = new Map();
    this.comets = [];
    this.ripples = [];
    this.captions = [];
    this.feed = [];
    this.waveSlot = 0;
    this.lastPx = {};
    this.lastSpark = {};
    this.lastInput = 0;
    this.t0 = performance.now();
    this.spin = !matchMedia('(prefers-reduced-motion: reduce)').matches;
    this.#build();
    store.on('event', (ev) => this.#think('note', ev));
    store.on('neural', (ev) => this.#think('neural', ev));
    store.on('llm-event', (ev) => this.#think('llm', ev));
    store.on('memory', (ev) => this.#think('memory', ev));
    store.on('deep', (ev) => this.#think('deep', ev));
    store.on('snapshot', () => this.#onSnapshot());
    store.on('init', () => this.#layout());
  }

  // ---- page --------------------------------------------------------------------------------
  #build() {
    this.root.innerHTML = `
      <div class="mg-head fm-head">
        <div><h2>The floor's mind <span class="pill ok mg-live" id="fm-live">LIVE</span></h2>
        <p class="sub" id="fm-stats">Every thought on the floor, as it happens.</p></div>
        <div class="fm-actions">
          <button class="btn" data-act="fm-replay" title="Play the floor's last real thoughts again">Replay the last thoughts</button>
          <button class="btn" data-act="fm-spin" aria-pressed="true">Turning</button>
        </div>
      </div>
      <div class="mg-body fm-body">
        <div class="fm-stage"><canvas aria-label="The floor's mind: a 3D brain that lights up with every desk's thoughts"></canvas>
          <div class="fm-labels"></div><div class="fm-thoughts"></div><div class="mg-tip fm-tip" hidden></div>
          <div class="fm-legend">${LEGEND.map(([t, c]) => `<span><i style="background:${c};color:${c}"></i>${t}</span>`).join('')}</div>
          <p class="mg-hint fm-hint">Drag to turn · scroll to zoom · click a desk to open it</p></div>
        <aside class="mg-side fm-side">
          <h3>Stream of thought</h3>
          <ol class="fm-feed" id="fm-feed"></ol>
          <p class="fine">London's desks think in the left half of the brain, New York's in the right, Asia's at the back. Every bright signal is something that just happened; the faint shimmer is only the brain at rest.</p>
        </aside>
      </div>`;
    this.stage = this.root.querySelector('.fm-stage');
    this.canvas = this.root.querySelector('canvas');
    this.labelsEl = this.root.querySelector('.fm-labels');
    this.thoughtsEl = this.root.querySelector('.fm-thoughts');
    this.tip = this.root.querySelector('.fm-tip');

    const r = new THREE.WebGLRenderer({ canvas: this.canvas, antialias: false, powerPreference: 'high-performance' });
    r.setClearColor('#04060b', 1);
    this.renderer = r;
    this.scene = new THREE.Scene();
    this.scene.background = new THREE.Color('#04060b');
    this.camera = new THREE.PerspectiveCamera(38, 1, 0.1, 60);
    this.camera.position.set(-3.3, 0.95, 2.1);
    this.group = new THREE.Group();
    this.scene.add(this.group);
    this.controls = new OrbitControls(this.camera, this.canvas);
    this.controls.target.set(0, -0.12, 0);
    this.controls.enableDamping = true;
    this.controls.dampingFactor = 0.06;
    this.controls.enablePan = false;
    this.controls.minDistance = 2.1;
    this.controls.maxDistance = 7.5;
    this.controls.rotateSpeed = 0.7;
    this.controls.autoRotate = this.spin;
    this.controls.autoRotateSpeed = 0.55;
    this.controls.addEventListener('start', () => { this.controls.autoRotate = false; clearTimeout(this.spinTimer); });
    this.controls.addEventListener('end', () => {
      clearTimeout(this.spinTimer);
      this.spinTimer = setTimeout(() => { this.controls.autoRotate = this.spin; }, 6000);
    });

    // Multisampled targets: smooth lines under the glow.
    const target = new THREE.WebGLRenderTarget(1, 1, { type: THREE.HalfFloatType, samples: 4 });
    this.composer = new EffectComposer(r, target);
    this.composer.addPass(new RenderPass(this.scene, this.camera));
    this.bloom = new UnrealBloomPass(new THREE.Vector2(256, 256), 1.0, 0.6, 0.06);
    this.composer.addPass(this.bloom);
    this.composer.addPass(new OutputPass());

    this.shared = {
      uTime: { value: 0 }, uNear: { value: 2 }, uFar: { value: 5 }, uScale: { value: 10 },
      uWave: { value: Array.from({ length: WAVES }, () => new THREE.Vector4(0, 0, 0, -99)) },
      uWaveC: { value: Array.from({ length: WAVES }, () => new THREE.Vector3()) },
    };
    this.#buildBrain();
    this.#buildFx();
    this.#layout();

    const input = () => { this.lastInput = performance.now(); this.#wake(); };
    let down = null;
    this.canvas.addEventListener('pointerdown', (e) => { input(); down = { x: e.clientX, y: e.clientY }; }, { passive: true });
    this.canvas.addEventListener('wheel', () => { this.zoomed = true; input(); }, { passive: true });
    this.canvas.addEventListener('pointermove', (e) => { input(); this.#hover(e); });
    this.canvas.addEventListener('pointerleave', () => { this.tip.hidden = true; this.hovered = null; });
    this.canvas.addEventListener('pointerup', (e) => {
      if (down && Math.hypot(e.clientX - down.x, e.clientY - down.y) < 5) this.#click(e);
      down = null;
    });
    this.root.addEventListener('click', (e) => {
      if (e.target.closest('[data-act="fm-replay"]')) this.#replay();
      const spin = e.target.closest('[data-act="fm-spin"]');
      if (spin) {
        this.spin = !this.spin;
        this.controls.autoRotate = this.spin;
        spin.setAttribute('aria-pressed', String(this.spin));
        spin.textContent = this.spin ? 'Turning' : 'Still';
        this.#wake();
      }
      const who = e.target.closest('[data-agent]');
      if (who && this.onSelect) this.onSelect(who.dataset.agent, { tab: 'brain' });
    });
    new ResizeObserver(() => this.#resize()).observe(this.stage);
    new IntersectionObserver(([en]) => { this.onScreen = en.isIntersecting; this.#wake(); }).observe(this.stage);
    document.addEventListener('visibilitychange', () => this.#wake());
  }

  // ---- the brain ---------------------------------------------------------------------------
  #buildBrain() {
    const rnd = rng(20260129);
    const { pos, part } = brainCloud(5200, rnd);
    const n = part.length;
    const color = new Float32Array(n * 3);
    const phase = new Float32Array(n);
    const size = new Float32Array(n);
    // London's half cool blue to cyan, New York's blue to violet, the cerebellum teal.
    const tints = [['#1d4ed8', '#22d3ee'], ['#3b3fd8', '#8b9cf7'], ['#0f766e', '#2dd4bf'], ['#4338ca', '#818cf8']];
    const a = new THREE.Color();
    const b = new THREE.Color();
    for (let i = 0; i < n; i++) {
      const [c1, c2] = tints[part[i]];
      a.set(c1);
      b.set(c2);
      a.lerp(b, clamp(0.5 + pos[i * 3 + 1] * 0.45 + (rnd() - 0.5) * 0.5, 0, 1)).multiplyScalar(0.55);
      color.set([a.r, a.g, a.b], i * 3);
      phase[i] = rnd();
      size[i] = 0.9 + rnd() * rnd() * 2.2;
    }
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
    g.setAttribute('aColor', new THREE.BufferAttribute(color, 3));
    g.setAttribute('aPhase', new THREE.BufferAttribute(phase, 1));
    g.setAttribute('aSize', new THREE.BufferAttribute(size, 1));
    this.cloud = new THREE.Points(g, new THREE.ShaderMaterial({ uniforms: this.shared, vertexShader: CLOUD_VS, fragmentShader: CLOUD_FS, defines: { WAVES }, ...additive }));
    this.group.add(this.cloud);

    // The synapses: each neuron to its nearest neighbours.
    const edges = wire(pos, 0.1, 3);
    const lp = new Float32Array(edges.length * 3);
    const lph = new Float32Array(edges.length);
    edges.forEach((i, k) => {
      lp.set([pos[i * 3], pos[i * 3 + 1], pos[i * 3 + 2]], k * 3);
      lph[k] = phase[i];
    });
    const lg = new THREE.BufferGeometry();
    lg.setAttribute('position', new THREE.BufferAttribute(lp, 3));
    lg.setAttribute('aPhase', new THREE.BufferAttribute(lph, 1));
    this.wires = new THREE.LineSegments(lg, new THREE.ShaderMaterial({
      uniforms: { ...this.shared, uColor: { value: new THREE.Color('#3b82f6').multiplyScalar(0.9) }, uAlpha: { value: 0.22 } },
      vertexShader: WIRE_VS, fragmentShader: WIRE_FS, defines: { WAVES }, ...additive,
    }));
    this.group.add(this.wires);

    // Faint dust far behind, for depth.
    const dust = [];
    for (let i = 0; i < 700; i++) {
      const v = new THREE.Vector3(rnd() * 2 - 1, rnd() * 2 - 1, rnd() * 2 - 1).normalize().multiplyScalar(5 + rnd() * 6);
      dust.push(v.x, v.y, v.z);
    }
    const dg = new THREE.BufferGeometry();
    dg.setAttribute('position', new THREE.Float32BufferAttribute(dust, 3));
    this.dust = new THREE.Points(dg, new THREE.PointsMaterial({ size: 0.05, map: dotTexture(), color: '#5b7bd6', opacity: 0.45, ...additive }));
    this.scene.add(this.dust);
  }

  // Sprites for the desks and parts of the mind, the signals, and the ripples.
  #buildFx() {
    const sprites = (count, fs) => {
      const g = new THREE.BufferGeometry();
      g.setAttribute('position', new THREE.BufferAttribute(new Float32Array(count * 3), 3).setUsage(THREE.DynamicDrawUsage));
      g.setAttribute('aColor', new THREE.BufferAttribute(new Float32Array(count * 3), 3).setUsage(THREE.DynamicDrawUsage));
      for (const k of ['aSize', 'aAlpha', 'aGlow', 'aRing']) g.setAttribute(k, new THREE.BufferAttribute(new Float32Array(count), 1).setUsage(THREE.DynamicDrawUsage));
      g.setDrawRange(0, 0);
      const p = new THREE.Points(g, new THREE.ShaderMaterial({ uniforms: { uScale: this.shared.uScale }, vertexShader: SPRITE_VS, fragmentShader: fs, ...additive }));
      p.frustumCulled = false;
      this.group.add(p);
      return p;
    };
    this.hubPts = sprites(128, HUB_FS);
    this.cometPts = sprites(MAX_VERTS, COMET_FS);
    this.ripplePts = sprites(MAX_RIPPLES, RIPPLE_FS);
    this.hubPts.renderOrder = 3;
  }

  // The desks (from the roster) and the parts of the mind, with their labels.
  #layout() {
    const profiles = (this.store.profiles || []).filter((p) => p?.id);
    const sig = profiles.map((p) => `${p.id}:${p.session}:${p.symbols?.[0]}`).join();
    if (sig === this.layoutSig && this.hubs.length) return;
    this.layoutSig = sig;
    for (const a of this.arcs.values()) { this.group.remove(a.line); a.line.geometry.dispose(); a.line.material.dispose(); }
    this.arcs.clear();
    this.hubs = [];
    this.hub.clear();
    for (const r of REGIONS) this.#addHub({ id: r.id, kind: 'region', label: r.label, color: r.color, pos: new THREE.Vector3(...r.pos), size: 8.5, region: r });
    const spots = deskSpots(profiles);
    for (const p of profiles) {
      const s = spots.get(p.id);
      if (s) this.#addHub({ id: p.id, kind: 'desk', label: p.name.split(' ')[0], color: p.accent || '#94a3b8', pos: s.pos, normal: s.normal, size: 6.5, profile: p });
    }
    const g = this.hubPts.geometry;
    this.hubs.forEach((h, i) => {
      g.attributes.position.setXYZ(i, h.pos.x, h.pos.y, h.pos.z);
      g.attributes.aColor.setXYZ(i, h.color.r, h.color.g, h.color.b);
    });
    g.attributes.position.needsUpdate = true;
    g.attributes.aColor.needsUpdate = true;
    g.setDrawRange(0, this.hubs.length);
    // The wiring: the parts of the mind, and every desk to its senses and the neural net.
    for (const [a, b] of SKELETON) this.#arc(a, b, 0.12);
    for (const h of this.hubs) if (h.kind === 'desk') { this.#arc('senses', h.id, 0.035); this.#arc(h.id, 'neural', 0.045); }
    this.#labels(profiles);
  }

  #addHub(h) {
    h.color = new THREE.Color(h.color);
    h.flare = 0;
    h.flareColor = h.color.clone();
    this.hubs.push(h);
    this.hub.set(h.id, h);
  }

  #labels(profiles) {
    this.labelsEl.innerHTML = '';
    this.labelEls = [];
    const add = (html, pos, cls, hub = null, normal = null) => {
      const el = document.createElement('span');
      el.className = `fm-label ${cls}`;
      el.innerHTML = html;
      this.labelsEl.appendChild(el);
      this.labelEls.push({ el, pos, hub, normal });
    };
    // Each half's name on its outer side, shown while that side faces you.
    add('LONDON', new THREE.Vector3(-1.08, 0.72, 0.1), 'hemi', null, new THREE.Vector3(-1, 0.35, 0).normalize());
    add('NEW YORK', new THREE.Vector3(1.08, 0.72, 0.1), 'hemi', null, new THREE.Vector3(1, 0.35, 0).normalize());
    if (profiles.some((p) => p.session === 'asia')) add('ASIA', new THREE.Vector3(0, -0.84, -1.22), 'hemi', null, new THREE.Vector3(0, -0.2, -1).normalize());
    for (const h of this.hubs) {
      if (h.kind === 'region') add(escapeHtml(h.label), h.pos.clone().add(new THREE.Vector3(0, 0.1, 0)), 'region', h);
      else add(`<i style="background:${h.color.getStyle()};color:${h.color.getStyle()}"></i>${escapeHtml(h.label)}`, h.pos, 'desk', h);
      this.labelEls.at(-1).el.style.setProperty('--c', h.color.getStyle());
    }
  }

  // A curved connection between two hubs, made once and reused both ways.
  #arc(a, b, base = 0) {
    const key = `${a}|${b}`;
    const back = `${b}|${a}`;
    if (this.arcs.has(key)) return { arc: this.arcs.get(key), rev: false };
    if (this.arcs.has(back)) return { arc: this.arcs.get(back), rev: true };
    const A = this.hub.get(a)?.pos;
    const B = this.hub.get(b)?.pos;
    if (!A || !B || a === b) return null;
    const mid = A.clone().add(B).multiplyScalar(0.5);
    const d = A.distanceTo(B);
    const out = mid.lengthSq() > 0.02 ? mid.clone().normalize().multiplyScalar(0.55) : new THREE.Vector3();
    const ctrl = mid.add(out.add(new THREE.Vector3(0, 0.75, 0)).normalize().multiplyScalar(0.1 + 0.28 * d));
    const pts = new THREE.QuadraticBezierCurve3(A.clone(), ctrl, B.clone()).getSpacedPoints(ARC_SEG);
    const g = new THREE.BufferGeometry().setFromPoints(pts);
    g.setAttribute('aT', new THREE.BufferAttribute(new Float32Array(pts.map((_, i) => i / ARC_SEG)), 1));
    const baseColor = this.hub.get(this.hub.get(b).kind === 'region' ? b : a).color.clone();
    const mat = new THREE.ShaderMaterial({
      uniforms: { uNear: this.shared.uNear, uFar: this.shared.uFar, uTime: this.shared.uTime, uColor: { value: baseColor.clone() }, uBase: { value: base }, uEnergy: { value: 0 } },
      vertexShader: ARC_VS, fragmentShader: ARC_FS, ...additive,
    });
    const line = new THREE.Line(g, mat);
    line.visible = base > 0;
    this.group.add(line);
    let len = 0;
    for (let i = 1; i < pts.length; i++) len += pts[i].distanceTo(pts[i - 1]);
    const arc = { a, b, pts, len, line, mat, base, energy: 0, baseColor, hot: baseColor.clone() };
    this.arcs.set(key, arc);
    return { arc, rev: false };
  }

  // ---- thoughts ------------------------------------------------------------------------------
  // Turn what happened into a route through the mind. A leg is one signal from hub to hub; legs
  // run one after the other, and an array of legs runs side by side.
  #route(source, ev) {
    const L = (a, b, c, o = {}) => ({ a, b, c, ...o });
    const desk = (id) => (id && this.hub.get(id)?.kind === 'desk' ? id : null);
    const name = (id) => this.#name(id);
    const symOf = (id, s) => s || this.hub.get(id)?.profile?.symbols?.[0] || '';
    if (source === 'note') {
      if (!ev || ev.kind === 'quiet') return null;
      const text = String(ev.text || '');
      const d = desk(ev.agentId);
      if (!d) {
        if (ev.kind === 'risk') return { at: 'risk', legs: [], flare: COL.loss, text, color: COL.loss, time: ev.time };
        if (/real prices again/.test(text)) return { at: 'senses', legs: [], flare: COL.price, text, color: COL.price, time: ev.time };
        return null; // the neural brain's own notes arrive as its events
      }
      const base = { desk: d, sym: symOf(d, ev.symbol), text, time: ev.time, caption: true };
      switch (ev.kind) {
        case 'setup': return { ...base, legs: [L('senses', d, COL.read)], color: COL.read };
        case 'signal': return { ...base, legs: [L('senses', d, COL.white)], color: COL.white };
        case 'entry': {
          const c = ev.side === 'SHORT' || /^Sold/.test(text) ? COL.sell : COL.buy;
          return { ...base, legs: [L(d, 'risk', c), L('risk', 'exec', c)], color: c };
        }
        case 'exit': {
          const c = (ev.pnl ?? (/loss/i.test(text) ? -1 : 1)) >= 0 ? COL.win : COL.loss;
          return { ...base, legs: [L('exec', d, c)], color: c };
        }
        case 'partial': return { ...base, legs: [L('exec', d, COL.win)], color: COL.win };
        case 'learn': return { ...base, legs: [L(d, 'memory', COL.gold)], color: COL.gold };
        case 'news': return { ...base, legs: [L('news', d, COL.news)], color: COL.news };
        case 'llm': return { ...base, legs: [L('claude', d, COL.claude)], color: COL.claude };
        case 'live': return { ...base, legs: [L('exec', d, COL.white, { small: true })], color: COL.white, caption: false };
        case 'halt':
        case 'error': return { ...base, legs: [], at: d, flare: COL.loss, color: COL.loss };
        default: return { ...base, legs: [], at: d, flare: COL.white, color: COL.grey };
      }
    }
    if (source === 'neural') {
      const d = desk(ev?.desk);
      if (ev?.kind === 'thought' && d) {
        const v = ev.verdict === 'learning' ? (ev.would === 'take' ? 'take' : 'pass') : ev.verdict;
        const c = v === 'take' ? COL.win : v === 'explore' ? COL.gold : v === 'yours' ? COL.neural : COL.grey;
        const word = ev.verdict === 'learning' ? `would ${ev.would === 'take' ? 'take it' : 'pass'}` : v === 'take' ? 'take it' : v === 'explore' ? 'explore it on paper' : v === 'yours' ? 'your alert' : 'pass';
        return {
          desk: d, sym: ev.symbol, time: ev.at, color: COL.neural, legs: [L(d, 'neural', COL.neural), L('neural', d, c)],
          text: `Neural net on ${name(d)}'s ${ev.symbol} ${String(ev.side || '').toLowerCase()}: ${pct(ev.p)} chance of profit, ${fmtR(ev.expR)} expected → ${word}.`,
          hubCaption: ['neural', `${pct(ev.p)} · ${word}`, c],
        };
      }
      if (ev?.kind === 'outcome' && d) {
        const c = ev.won ? COL.win : COL.loss;
        return { desk: d, sym: ev.symbol, color: c, legs: [L('exec', 'neural', c)], text: `${name(d)}'s ${ev.symbol} closed ${fmtR(ev.r)} (the neural net said ${pct(ev.p)}): kept for its next lesson.` };
      }
      if (ev?.kind === 'learning') return { at: 'neural', color: COL.gold, legs: [L('memory', 'neural', COL.gold)], text: `The neural net is learning from ${ev.own ?? 'its'} trades of its own…` };
      if (ev?.kind === 'learned') return { at: 'neural', color: COL.gold, legs: [], flare: COL.gold, burst: !!ev.adopted, text: ev.text || 'The neural net finished learning.' };
      return null;
    }
    if (source === 'llm') {
      const d = desk(ev?.desk);
      if (!d) return null;
      if (ev.kind === 'review') {
        if (ev.status === 'thinking') return { desk: d, sym: ev.symbol, color: COL.claude, legs: [L(d, 'claude', COL.claude)], feed: false };
        if (ev.verdict) {
          const take = ev.verdict === 'take';
          const c = take ? COL.win : COL.loss;
          return {
            desk: d, sym: ev.symbol, color: COL.claude, legs: [L('claude', d, c)],
            text: `Claude on ${name(d)}'s ${ev.symbol} setup: ${take ? 'take it' : 'skip it'} (${pct(ev.p)} chance of profit).`,
            hubCaption: ['claude', `${take ? 'Take it' : 'Skip it'} · ${pct(ev.p)}`, c],
          };
        }
        if (ev.status === 'failed' || ev.status === 'skipped') return { at: 'claude', legs: [], flare: COL.grey, feed: false };
        return null;
      }
      if (ev.kind === 'outcome') {
        const c = ev.right == null ? COL.grey : ev.right ? COL.win : COL.loss;
        return { desk: d, sym: ev.symbol, color: COL.claude, legs: [L('exec', 'claude', c)], text: `Claude's call on ${name(d)}'s ${ev.symbol} ${ev.right == null ? 'was scored' : ev.right ? 'was right' : 'was wrong'} (${fmtR(ev.r)}).` };
      }
      return null;
    }
    if (source === 'deep') {
      const d = desk(ev?.desk);
      if (ev?.kind === 'thought' && d) {
        const v = ev.verdict === 'learning' ? (ev.would === 'take' ? 'take' : 'pass') : ev.verdict;
        const c = v === 'take' ? COL.win : v === 'explore' ? COL.gold : v === 'yours' ? COL.neural : COL.grey;
        const word = ev.verdict === 'learning' ? `would ${ev.would === 'take' ? 'take it' : 'pass'}` : v === 'take' ? 'take it' : v === 'explore' ? 'explore it on paper' : v === 'yours' ? 'your alert' : 'pass';
        // Named only when one candle really stood out (more than half again an even share).
        const top = ev.top?.[0]?.w > 1.5 / Math.max(1, ev.candles?.length || 24) ? ev.top[0] : null;
        const read = top ? ` It looked hardest at the ${top.tf === 60 ? '1-hour' : top.tf === 1 ? '1-minute' : `${top.tf}-minute`} candle ending ${nyTime((top.t + top.tf * 60) * 1000)}.` : '';
        const near = ev.near?.length ? ` ${ev.nearWon} of its ${ev.near.length} closest past trades won.` : '';
        return {
          desk: d, sym: ev.symbol, time: ev.at, color: COL.deep, legs: [L(d, 'deep', COL.deep), L('deep', d, c)],
          text: `Deep brain on ${name(d)}'s ${ev.symbol} ${String(ev.side || '').toLowerCase()}: ${pct(ev.p)} chance of profit, ${fmtR(ev.expR)} expected → ${word}.${read}${near}`,
          hubCaption: ['deep', `${pct(ev.p)} · ${word}`, c],
        };
      }
      if (ev?.kind === 'outcome' && d) {
        const c = ev.won ? COL.win : COL.loss;
        return { desk: d, sym: ev.symbol, color: c, legs: [L('exec', 'deep', c)], text: `${name(d)}'s ${ev.symbol} closed ${fmtR(ev.r)} (the deep brain said ${pct(ev.p)})${ev.kept ? ': a new star in its memory' : ''}.` };
      }
      if (ev?.kind === 'learning') return { at: 'deep', color: COL.gold, legs: [L('memory', 'deep', COL.gold)], text: 'The deep brain is learning from your saved prices…' };
      if (ev?.kind === 'learned' && !ev.failed) return { at: 'deep', color: COL.gold, legs: [], flare: COL.gold, text: ev.text || 'The deep brain finished learning.' };
      return null;
    }
    if (source === 'memory') {
      if (ev?.kind === 'trade' && desk(ev.agentId)) return { desk: ev.agentId, legs: [L(ev.agentId, 'memory', ev.r >= 0 ? COL.win : COL.loss)], delay: 900, feed: false };
      if (ev?.kind === 'lesson' && ev.agentId === 'llm') return { at: 'claude', color: COL.gold, legs: [L('claude', 'memory', COL.gold)], text: `Claude learned: ${ev.text}` };
      if (ev?.kind === 'debate' && desk(ev.agentId)) {
        const d = ev.agentId;
        const ok = /^APPROVED/.test(ev.verdict || '');
        const stance = (s) => (s === 'agree' ? COL.win : s === 'disagree' ? COL.loss : COL.gold);
        const rev = (ev.reviewers || []).filter((r) => desk(r.id) && r.id !== d).map((r) => L('committee', r.id, stance(r.stance)));
        return {
          desk: d, sym: ev.symbol, color: COL.white, caption: true,
          legs: [L(d, 'committee', COL.white), ...(rev.length ? [rev] : []), ...(ok ? [L('committee', 'risk', COL.win)] : [])],
          text: `The committee on ${name(d)}'s ${ev.symbol} idea: ${String(ev.verdict || '').toLowerCase()}${ev.grade && ev.grade !== '—' ? ` (grade ${ev.grade})` : ''}.`,
        };
      }
    }
    return null;
  }

  #think(source, ev, { animate = true, delay = 0, replay = false } = {}) {
    const th = this.#route(source, ev);
    if (!th) return;
    th.delay = (th.delay || 0) + delay;
    if (th.text && th.feed !== false && !replay) this.#addFeed(th);
    if (animate && this.visible && this.onScreen && !document.hidden) this.#animate(th);
  }

  #animate(th) {
    const now = performance.now() + th.delay;
    // A busy floor: the feed keeps every thought, the picture keeps up with the newest.
    if (this.comets.length > 260) return;
    let groupEnd = now;
    for (const leg of th.legs) {
      const start = groupEnd;
      for (const l of Array.isArray(leg) ? leg : [leg]) {
        const found = this.#arc(l.a, l.b);
        if (!found) continue;
        const dur = l.small ? 300 + 380 * found.arc.len : 620 + 520 * found.arc.len;
        this.comets.push({ ...found, t0: start, dur, color: new THREE.Color(l.c), small: !!l.small, to: l.b, from: l.a, left: false });
        groupEnd = Math.max(groupEnd, start + dur);
      }
    }
    if (th.flare) setTimeout(() => this.#land(th.at, new THREE.Color(th.flare), { wave: true }), th.delay);
    if (th.burst) setTimeout(() => this.#burst(), th.delay);
    if (th.caption && th.desk && th.text) setTimeout(() => this.#caption(th.desk, th.text, th.color, th.time), th.delay);
    if (th.hubCaption) setTimeout(() => this.#caption(th.hubCaption[0], th.hubCaption[1], th.hubCaption[2], null, { small: true }), th.delay + (groupEnd - now) * 0.5);
    this.#wake();
  }

  // A signal arrived: the hub flares, a ring spreads and a wave runs through the neurons.
  #land(id, color, { wave = true, strength = 1 } = {}) {
    const h = this.hub.get(id);
    if (!h) return;
    h.flare = Math.min(1.6, h.flare + strength);
    h.flareColor.copy(color);
    if (this.ripples.length < MAX_RIPPLES) this.ripples.push({ pos: h.pos, color: color.clone(), t0: performance.now(), dur: 1300, size: h.size });
    if (wave) this.#wave(h.pos, color, strength);
    this.#wake();
  }

  #wave(pos, color, strength = 1) {
    this.waveSlot = (this.waveSlot + 1) % WAVES;
    this.shared.uWave.value[this.waveSlot].set(pos.x, pos.y, pos.z, this.#t());
    this.shared.uWaveC.value[this.waveSlot].set(color.r, color.g, color.b).multiplyScalar(0.65 * strength);
  }

  // The neural net learned something new: the whole brain lights up in gold.
  #burst() {
    const gold = new THREE.Color(COL.gold);
    this.#land('neural', gold, { strength: 1.4 });
    this.hubs.forEach((h, i) => { if (h.kind === 'desk') setTimeout(() => this.#land(h.id, gold, { wave: false, strength: 0.7 }), 300 + i * 40); });
  }

  // Prices into the senses: each market's desks get a small spark when its price moves.
  #onSnapshot() {
    if (!this.visible || !this.onScreen || document.hidden) return;
    const now = performance.now();
    for (const [sym, q] of Object.entries(this.store.quotes || {})) {
      const px = q?.price;
      if (!Number.isFinite(px)) continue;
      const moved = this.lastPx[sym] != null && this.lastPx[sym] !== px;
      this.lastPx[sym] = px;
      if (!moved || now - (this.lastSpark[sym] || 0) < 2200 || this.comets.length > 160) continue;
      this.lastSpark[sym] = now;
      for (const h of this.hubs) {
        if (h.kind !== 'desk' || h.profile.symbols?.[0] !== sym) continue;
        const found = this.#arc('senses', h.id);
        if (found) this.comets.push({ ...found, t0: now + Math.random() * 400, dur: 300 + 380 * found.arc.len, color: new THREE.Color(COL.price), small: true, to: h.id, from: 'senses' });
      }
    }
    this.#wake();
  }

  // The last real thoughts, played again (for an empty screen, or when you ask).
  #replay() {
    const evs = (this.store.events || []).filter((e) => e.agentId && this.hub.get(e.agentId) && !['quiet', 'live', 'info'].includes(e.kind)).slice(-9);
    evs.forEach((ev, i) => this.#think('note', ev, { delay: i * 1100, replay: true }));
    if (!evs.length) this.#land('senses', new THREE.Color(COL.price));
  }

  // ---- captions and the stream ----------------------------------------------------------------
  #caption(id, text, color, time, { small = false } = {}) {
    const h = this.hub.get(id);
    if (!h || !this.visible) return;
    // One thought per hub at a time: the newest replaces the one before.
    for (const old of this.captions.filter((c) => c.hub === h)) this.#dropCaption(old);
    while (this.captions.length >= CAPTIONS_MAX) this.#dropCaption(this.captions[0]);
    const el = document.createElement('div');
    el.className = `fm-thought${small ? ' small' : ''}`;
    el.style.setProperty('--c', color || h.color.getStyle());
    const p = h.profile;
    el.innerHTML = small
      ? `<b>${escapeHtml(h.label)}</b> ${escapeHtml(text)}`
      : `<span class="av" style="background:${p?.accent || h.color.getStyle()}">${escapeHtml(p ? initials(p.name) : h.label[0])}</span><div><b>${escapeHtml(h.label)}</b> <small>${escapeHtml(p?.symbols?.[0] || '')}${Number.isFinite(time) ? ` · ${nyTime(time)}` : ''}</small><p>${escapeHtml(text.length > 150 ? `${text.slice(0, 147)}…` : text)}</p></div>`;
    this.thoughtsEl.appendChild(el);
    const c = { el, hub: h, until: performance.now() + (small ? 3800 : 6500) };
    this.captions.push(c);
    requestAnimationFrame(() => el.classList.add('on'));
  }

  #dropCaption(c) {
    this.captions = this.captions.filter((x) => x !== c);
    c.el.classList.remove('on');
    setTimeout(() => c.el.remove(), 400);
  }

  #addFeed(th) {
    const f = { time: th.time, desk: th.desk, at: th.at, text: th.text, color: th.color, route: this.#path(th.legs) };
    this.feed.unshift(f);
    this.feed.length = Math.min(this.feed.length, FEED_MAX);
    if (!this.visible) return;
    // Only the newest line slides in; the rest stay put.
    const el = this.root.querySelector('#fm-feed');
    el.querySelector('.fm-empty')?.remove();
    el.insertAdjacentHTML('afterbegin', this.#feedItem(f, true));
    while (el.children.length > FEED_MAX) el.lastElementChild.remove();
  }

  #path(legs) {
    const names = [];
    const push = (id) => { const n = id === '*' ? 'its reviewers' : this.#name(id); if (names.at(-1) !== n) names.push(n); };
    for (const leg of legs || []) {
      if (Array.isArray(leg)) { if (!names.length) push(leg[0].a); push(leg.length > 1 ? '*' : leg[0].b); continue; }
      if (!names.length) push(leg.a);
      push(leg.b);
    }
    return names.join(' → ');
  }

  #feedItem(f, fresh = false) {
    return `<li class="${fresh ? 'fm-new' : ''}" ${f.desk ? `data-agent="${escapeHtml(f.desk)}"` : ''} style="--c:${f.color || COL.grey}">
      <div><b>${escapeHtml(f.desk ? this.#name(f.desk) : this.#name(f.at))}</b> <small class="muted">${Number.isFinite(f.time) ? nyTime(f.time) : ''}</small>
      <p>${escapeHtml(f.text)}</p>${f.route ? `<small class="fm-route">${escapeHtml(f.route)}</small>` : ''}</div></li>`;
  }

  #renderFeed() {
    this.root.querySelector('#fm-feed').innerHTML = this.feed.length
      ? this.feed.map((f) => this.#feedItem(f)).join('')
      : '<li class="muted fm-empty">Waiting for the desks to think: every read, trade, review and lesson appears here as it happens.</li>';
  }

  // The floor's recent thoughts, so the stream isn't empty when the page opens.
  #prefill() {
    if (this.prefilled || !this.store.ready) return;
    this.prefilled = true;
    for (const ev of (this.store.events || []).slice(-60)) {
      const th = this.#route('note', ev);
      if (th?.text && th.feed !== false) this.feed.unshift({ time: th.time, desk: th.desk, at: th.at, text: th.text, color: th.color, route: this.#path(th.legs) });
    }
    this.feed.length = Math.min(this.feed.length, FEED_MAX);
  }

  #name(id) {
    const h = this.hub.get(id);
    return h ? h.label : id || '';
  }

  // ---- showing it ----------------------------------------------------------------------------
  show() {
    this.visible = true;
    this.#layout();
    this.#prefill();
    this.#renderFeed();
    this.#stats();
    this.#resize();
    clearInterval(this.statsTimer);
    this.statsTimer = setInterval(() => this.#stats(), 2000);
    if (!this.replayed) {
      this.replayed = true;
      setTimeout(() => this.#replay(), 600);
    }
    this.#wake();
  }

  hide() {
    this.visible = false;
    clearInterval(this.statsTimer);
    for (const c of [...this.captions]) this.#dropCaption(c);
  }

  // Battery saver (Settings) and the charger, from main.js.
  setPower({ eco = this.eco, battery = this.battery } = {}) {
    this.eco = eco;
    this.battery = battery;
    this.#resize();
  }

  get #saving() {
    return this.eco && this.battery;
  }

  #stats() {
    const s = this.store;
    const live = this.root.querySelector('#fm-live');
    const demo = s.config?.mode !== 'live';
    live.textContent = demo ? 'DEMO' : 'LIVE';
    live.className = `pill ${demo ? 'warn' : 'ok'} mg-live`;
    const agents = Object.values(s.agents || {});
    const inTrade = agents.filter((a) => a.status === 'IN TRADE').length;
    const armed = agents.filter((a) => a.status === 'ARMED').length;
    const now = s.fund?.marketTime ?? Date.now();
    const hour = (s.events || []).filter((e) => e.agentId && e.kind !== 'quiet' && now - e.time < 3_600_000).length;
    const llm = s.llm;
    const claude = !llm || llm.status === 'off' ? 'Claude not connected' : llm.busy?.reviews ? `Claude reviewing ${llm.busy.reviews}` : 'Claude ready';
    this.root.querySelector('#fm-stats').textContent = `${hour} thought${hour === 1 ? '' : 's'} in the last hour · ${inTrade} desk${inTrade === 1 ? '' : 's'} in a trade · ${armed} armed · ${claude}${demo ? ' · demo mode: simulated prices' : ''}`;
  }

  #t() {
    return (performance.now() - this.t0) / 1000;
  }

  #wake() {
    if (this.running || !this.visible || !this.onScreen || document.hidden) return;
    this.running = true;
    requestAnimationFrame((t) => this.#frame(t));
  }

  // Frames a second: as smooth as the display while you watch; calmer in the background and
  // on battery with the saver on.
  #fps(now) {
    const watched = document.hasFocus() && (now - this.lastInput < 10_000 || this.comets.length > 0);
    if (this.#saving) return watched ? 30 : 15;
    if (!document.hasFocus()) return 24;
    return this.eco && !watched ? 40 : 0;
  }

  #frame(now) {
    if (!this.visible || !this.onScreen || document.hidden) {
      this.running = false;
      return;
    }
    requestAnimationFrame((t) => this.#frame(t));
    const cap = this.#fps(now);
    if (cap && now - (this.lastFrame || 0) < 1000 / cap - 3) return;
    const dt = Math.min(0.1, (now - (this.lastFrame || now)) / 1000);
    this.lastFrame = now;
    this.#adapt(dt, cap);
    this.#update(now, dt);
    this.composer.render(dt);
    this.#overlay(now);
  }

  // A computer that can't keep up gets a lighter picture (once): fewer pixels under the glow.
  #adapt(dt, cap) {
    if (this.light || cap || !dt) return;
    this.slow = (this.slow || 0) * 0.97 + (dt > 1 / 28 ? 1 : 0) * 0.03;
    if (this.slow > 0.6) {
      this.light = true;
      this.#resize();
    }
  }

  #update(now, dt) {
    const t = this.#t();
    this.shared.uTime.value = t;
    this.controls.update(dt);
    const dist = this.camera.position.distanceTo(this.controls.target);
    this.shared.uNear.value = dist - 1.1;
    this.shared.uFar.value = dist + 1.1;
    this.group.scale.setScalar(1 + 0.006 * Math.sin(t * 0.9));
    this.dust.rotation.y = t * 0.008;
    this.#updateHubs(t, dt);
    this.#updateComets(now);
    this.#updateRipples(now);
    for (const a of this.arcs.values()) {
      a.energy *= Math.exp(-dt * 0.9);
      if (a.energy < 0.004) a.energy = 0;
      a.mat.uniforms.uEnergy.value = a.energy;
      a.mat.uniforms.uColor.value.copy(a.baseColor).lerp(a.hot, Math.min(1, a.energy * 1.4));
      a.line.visible = a.base > 0 || a.energy > 0;
    }
  }

  #updateHubs(t, dt) {
    const g = this.hubPts.geometry;
    const cam = this.camera.position;
    const v = new THREE.Vector3();
    const c = new THREE.Color();
    const agents = this.store.agents || {};
    const thinking = this.store.llm?.busy?.reviews > 0;
    this.hubs.forEach((h, i) => {
      h.flare *= Math.exp(-dt * 1.6);
      // Behind the brain: dimmer, so the near side reads clearly.
      let facing = 1;
      if (h.normal) facing = clamp(h.normal.dot(v.copy(cam).sub(h.pos).normalize()) * 2.2 + 0.7, 0, 1);
      h.facing = facing;
      const st = h.kind === 'desk' ? agents[h.id]?.status : null;
      const quiet = st && /NO PRICES|MARKET CLOSED|PAUSED|HALTED/.test(st);
      let ring = h.kind === 'region' ? 0.35 : 0.18;
      if (st === 'IN TRADE') ring = 0.75 + 0.25 * Math.sin(t * 3 + i);
      else if (st === 'ARMED') ring = 0.45 + 0.4 * Math.max(0, Math.sin(t * 2 + i));
      let glow = h.flare;
      if (h.id === 'claude' && thinking) glow += 0.35 + 0.3 * Math.sin(t * 2.4);
      c.copy(h.color).lerp(h.flareColor, Math.min(1, h.flare));
      g.attributes.aColor.setXYZ(i, c.r, c.g, c.b);
      g.attributes.aSize.setX(i, h.size * (1 + 0.45 * Math.min(1, h.flare)) * (h === this.hovered ? 1.25 : 1));
      g.attributes.aAlpha.setX(i, (0.3 + 0.7 * facing) * (quiet ? 0.5 : 1));
      g.attributes.aGlow.setX(i, glow);
      g.attributes.aRing.setX(i, ring);
    });
    for (const k of ['aColor', 'aSize', 'aAlpha', 'aGlow', 'aRing']) g.attributes[k].needsUpdate = true;
  }

  #updateComets(now) {
    const g = this.cometPts.geometry;
    const P = g.attributes.position.array;
    const C = g.attributes.aColor.array;
    const S = g.attributes.aSize.array;
    const A = g.attributes.aAlpha.array;
    const tmp = new THREE.Vector3();
    let v = 0;
    const done = [];
    for (const c of this.comets) {
      if (now < c.t0) continue;
      const t = Math.min(1, (now - c.t0) / c.dur);
      if (!c.left) {
        c.left = true;
        const from = this.hub.get(c.from);
        if (from && !c.small) from.flare = Math.min(1.6, from.flare + 0.35);
      }
      if (t >= 1) {
        done.push(c);
        c.arc.energy = Math.min(1.2, c.arc.energy + (c.small ? 0.25 : 1));
        c.arc.hot.copy(c.color);
        // A price spark only brushes its desk; a thought lands with a ring and a wave.
        if (c.small) {
          const h = this.hub.get(c.to);
          if (h && h.flare < 0.15) h.flare = Math.max(h.flare, 0.12);
        } else this.#land(c.to, c.color);
        continue;
      }
      const e = ease(t);
      const n = c.small ? 10 : TRAIL;
      const step = Math.min(0.03, (c.small ? 0.18 : 0.42) / (n * c.arc.len));
      const fade = t < 0.06 ? t / 0.06 : 1;
      for (let i = 0; i < n && v < MAX_VERTS; i++) {
        const u = e - i * step;
        if (u < 0) break;
        this.#at(c.arc, c.rev ? 1 - u : u, tmp);
        P[v * 3] = tmp.x; P[v * 3 + 1] = tmp.y; P[v * 3 + 2] = tmp.z;
        const k = 1 - i / n;
        const hot = i === 0 ? 1.7 : 1.15;
        C[v * 3] = c.color.r * hot; C[v * 3 + 1] = c.color.g * hot; C[v * 3 + 2] = c.color.b * hot;
        S[v] = (c.small ? 3.4 : 6.5) * (i === 0 ? 1 : 0.8 * k ** 1.1);
        A[v] = (i === 0 ? 1 : 0.85 * k ** 1.7) * fade * (c.small ? 0.6 : 1);
        v++;
      }
    }
    if (done.length) this.comets = this.comets.filter((c) => !done.includes(c));
    g.setDrawRange(0, v);
    for (const k of ['position', 'aColor', 'aSize', 'aAlpha']) {
      g.attributes[k].clearUpdateRanges();
      g.attributes[k].addUpdateRange(0, v * g.attributes[k].itemSize);
      g.attributes[k].needsUpdate = true;
    }
  }

  #at(arc, u, out) {
    const f = clamp(u, 0, 1) * ARC_SEG;
    const i = Math.min(ARC_SEG - 1, Math.floor(f));
    return out.lerpVectors(arc.pts[i], arc.pts[i + 1], f - i);
  }

  #updateRipples(now) {
    const g = this.ripplePts.geometry;
    this.ripples = this.ripples.filter((r) => now - r.t0 < r.dur);
    this.ripples.forEach((r, i) => {
      const t = (now - r.t0) / r.dur;
      g.attributes.position.setXYZ(i, r.pos.x, r.pos.y, r.pos.z);
      g.attributes.aColor.setXYZ(i, r.color.r * 1.3, r.color.g * 1.3, r.color.b * 1.3);
      g.attributes.aSize.setX(i, r.size * (1.2 + 4.2 * ease(t)));
      g.attributes.aAlpha.setX(i, (1 - t) ** 1.6 * 0.9);
    });
    g.setDrawRange(0, this.ripples.length);
    for (const k of ['position', 'aColor', 'aSize', 'aAlpha']) g.attributes[k].needsUpdate = true;
  }

  // Labels and captions follow their hubs on screen.
  #overlay(now) {
    const w = this.stage.clientWidth;
    const h = this.stage.clientHeight;
    const v = new THREE.Vector3();
    const toScreen = (pos) => {
      v.copy(pos).multiplyScalar(this.group.scale.x).project(this.camera);
      return { x: ((v.x + 1) / 2) * w, y: ((1 - v.y) / 2) * h, off: v.z > 1 };
    };
    const cam = this.camera.position;
    const look = new THREE.Vector3();
    for (const { el, pos, hub, normal } of this.labelEls || []) {
      const s = toScreen(pos);
      el.style.transform = `translate(${s.x.toFixed(1)}px, ${s.y.toFixed(1)}px) translate(${hub?.kind === 'desk' ? '10px, -50%' : '-50%, -150%'})`;
      const facing = normal ? clamp(normal.dot(look.copy(cam).sub(pos).normalize()) * 2.5, 0, 1) : 1;
      const op = s.off ? 0 : hub ? (hub.kind === 'desk' ? 0.15 + 0.85 * hub.facing : 0.95) * (hub.flare > 0.3 || hub === this.hovered ? 1.25 : 1) : facing;
      el.style.opacity = Math.min(1, op).toFixed(2);
    }
    // Captions above their hub, nudged apart so they never cover each other.
    const placed = [];
    for (const c of this.captions) {
      if (now > c.until) { this.#dropCaption(c); continue; }
      const s = toScreen(c.hub.pos);
      const cw = c.el.offsetWidth || 240;
      const ch = c.el.offsetHeight || 60;
      let x = clamp(s.x + 14, 8, w - cw - 8);
      let y = clamp(s.y - ch - 16, 8, h - ch - 8);
      for (let k = 0; k < 6; k++) {
        const hit = placed.find((p) => x < p.x + p.w && x + cw > p.x && y < p.y + p.h + 6 && y + ch + 6 > p.y);
        if (!hit) break;
        y = clamp(hit.y + hit.h + 8, 8, h - ch - 8);
        if (y === h - ch - 8) x = clamp(hit.x - cw - 8, 8, w - cw - 8);
      }
      placed.push({ x, y, w: cw, h: ch });
      c.el.style.transform = `translate(${x.toFixed(1)}px, ${y.toFixed(1)}px)`;
    }
    if (this.hovered) this.#placeTip();
  }

  #resize() {
    const w = this.stage.clientWidth || 800;
    const h = this.stage.clientHeight || 600;
    const pr = Math.min(window.devicePixelRatio || 1, this.#saving || this.light ? 1 : 1.75);
    this.renderer.setPixelRatio(pr);
    this.renderer.setSize(w, h, false);
    this.composer.setPixelRatio(pr);
    this.composer.setSize(w, h);
    this.bloom.enabled = !this.#saving;
    this.camera.aspect = w / h;
    this.camera.updateProjectionMatrix();
    // A narrow picture (a phone) steps back so the whole brain fits, until you zoom yourself.
    if (!this.zoomed) {
      const fit = 4.05 * Math.max(1, (1.25 / this.camera.aspect) ** 0.85);
      const off = this.camera.position.clone().sub(this.controls.target);
      this.camera.position.copy(this.controls.target).addScaledVector(off.normalize(), fit);
    }
    // Point sizes follow the picture's height, so it looks the same at any size.
    this.shared.uScale.value = (h * pr) / 60;
    this.#wake();
  }

  // ---- hover and click ---------------------------------------------------------------------
  #pick(e) {
    const rect = this.canvas.getBoundingClientRect();
    const mx = e.clientX - rect.left;
    const my = e.clientY - rect.top;
    const v = new THREE.Vector3();
    let best = null;
    let bestD = 22;
    for (const h of this.hubs) {
      v.copy(h.pos).project(this.camera);
      if (v.z > 1) continue;
      const d = Math.hypot(((v.x + 1) / 2) * rect.width - mx, ((1 - v.y) / 2) * rect.height - my) - (h.facing < 0.4 ? 8 : 0);
      if (d < bestD) { bestD = d; best = h; }
    }
    return best;
  }

  #hover(e) {
    if (performance.now() - (this.lastHover || 0) < 50) return;
    this.lastHover = performance.now();
    const h = this.#pick(e);
    this.hovered = h;
    this.canvas.style.cursor = h ? 'pointer' : '';
    if (!h) { this.tip.hidden = true; return; }
    this.tip.innerHTML = this.#tipHtml(h);
    this.tip.hidden = false;
    this.#placeTip();
  }

  #placeTip() {
    const h = this.hovered;
    if (!h) return;
    const v = h.pos.clone().project(this.camera);
    const w = this.stage.clientWidth;
    const ht = this.stage.clientHeight;
    const x = ((v.x + 1) / 2) * w;
    const y = ((1 - v.y) / 2) * ht;
    this.tip.style.left = `${clamp(x + 18, 8, w - 280)}px`;
    this.tip.style.top = `${clamp(y + 12, 8, ht - (this.tip.offsetHeight || 80) - 8)}px`;
  }

  #tipHtml(h) {
    const s = this.store;
    if (h.kind === 'desk') {
      const a = s.agents?.[h.id];
      const p = h.profile;
      const sym = p.symbols?.[0];
      let thought = '';
      for (const d of s.brain?.departments || []) {
        const t = d.markets?.[sym]?.thoughts?.[h.id];
        if (t?.text) thought = t.text;
      }
      return `<b>${escapeHtml(p.name)}</b> <span class="muted">· ${escapeHtml(p.desk || sym)}</span>
        ${a ? `<br>${escapeHtml(a.status)}${a.setup?.stage ? `: ${escapeHtml(a.setup.stage)}` : ''}` : ''}
        ${thought ? `<br><span class="muted">${escapeHtml(thought)}</span>` : ''}
        <br><span class="muted">Click to open ${escapeHtml(h.label)}'s desk</span>`;
    }
    const r = h.region;
    let extra = '';
    if (r.id === 'claude') {
      const l = s.llm;
      extra = !l || l.status === 'off' ? 'Not connected yet: connect it in the Claude card below.' : `${l.record?.n ?? 0} calls judged${l.busy?.reviews ? ` · reviewing ${l.busy.reviews} now` : ''} · say: ${escapeHtml(l.mode || 'advise')}`;
    } else if (r.id === 'committee' && s.live?.ownWay) extra = 'Switched off: the desks trade their own way (FTMO tab).';
    else if (r.id === 'risk' && s.live?.plan) extra = `${escapeHtml(s.live.plan.status)} · risk per trade ${s.live.plan.riskPct.toFixed(2)}%`;
    else if (r.id === 'exec') extra = s.live?.connected ? 'MT5 is connected.' : 'MT5 is not connected: paper trades only.';
    return `<b>${escapeHtml(r.label)}</b><br>${escapeHtml(r.tip)}${extra ? `<br><span class="muted">${extra}</span>` : ''}${r.card ? '<br><span class="muted">Click to see it below</span>' : ''}`;
  }

  #click(e) {
    const h = this.#pick(e);
    if (!h) return;
    if (h.kind === 'desk') this.onSelect?.(h.id, { tab: 'brain' });
    else if (h.region.card) document.querySelector(h.region.card)?.scrollIntoView({ behavior: 'smooth', block: 'start' });
  }
}
