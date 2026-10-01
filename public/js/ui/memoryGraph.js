import * as THREE from 'three';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import { api } from '../net.js';
import { escapeHtml } from '../format.js';

// The floor's memory as a live 3D knowledge graph (Brain tab). Desks, markets, the
// situations their trades were taken in (green: trades like this made money, red: lost,
// grey: not enough evidence yet), the lessons each desk learned, and who reviews whose
// ideas in the committee. When a trade closes, a lesson is learned or the committee meets,
// the connection lights up.
//
// It draws only while something moves (the layout settling, a pulse, you dragging it):
// a still graph costs no battery.

const COLORS = { market: '#f2b01e', lesson: '#a371f7', grey: '#8b93a1', green: '#2fbf71', red: '#e5534b', review: '#4c8dff', link: '#c9ccd3' };
const REST = { trades: 9, of: 4.2, took: 6.5, reviews: 15, learned: 3.2, correlated: 9 };
const PULL = { trades: 0.05, of: 0.18, took: 0.03, reviews: 0.004, learned: 0.2, correlated: 0.03 };
const fmtR = (x) => (x == null ? '—' : `${x >= 0 ? '+' : '−'}${Math.abs(x).toFixed(2)}R`);
const pct = (x) => (x == null ? '—' : `${Math.round(x * 100)}%`);

function situationColor(n) {
  const c = new THREE.Color(COLORS.grey);
  if (!n.ready) return c;
  const t = Math.max(-1, Math.min(1, (n.shrunk ?? 0) / 0.3));
  return c.lerp(new THREE.Color(t >= 0 ? COLORS.green : COLORS.red), Math.min(1, 0.35 + Math.abs(t)));
}

export class MemoryGraph {
  constructor(store, root, { onSelect } = {}) {
    this.store = store;
    this.root = root;
    this.onSelect = onSelect;
    this.nodes = new Map(); // id → { data, pos, vel, mesh, size }
    this.links = [];
    this.pulses = [];
    this.alpha = 0;
    this.visible = false;
    this.running = false;
    this.lastInput = 0;
    this.feed = [];
    this.#build();
    store.on('memory', (ev) => this.#onEvent(ev));
  }

  // ---- page --------------------------------------------------------------------------------
  #build() {
    this.root.innerHTML = `
      <div class="mg-head">
        <div><h2>Floor memory <span class="pill ok mg-live">LIVE</span></h2>
        <p class="sub" id="mg-stats">Loading the memory…</p></div>
        <div class="mg-legend">
          <span><i style="background:#3987e5"></i>Desk (in its colour)</span><span><i style="background:${COLORS.market}"></i>Market</span>
          <span><i style="background:${COLORS.green}"></i>Situation that made money</span><span><i style="background:${COLORS.red}"></i>…that lost</span>
          <span><i style="background:${COLORS.grey}"></i>…still learning</span><span><i style="background:${COLORS.lesson}"></i>Lesson</span>
        </div>
      </div>
      <div class="mg-body">
        <div class="mg-stage"><canvas></canvas><div class="mg-labels"></div><div class="mg-tip" hidden></div>
          <p class="mg-hint">Drag to turn · scroll to zoom · click a desk to open it</p></div>
        <aside class="mg-side">
          <h3>What the floor remembers best</h3><ol class="mg-strong" id="mg-strong"></ol>
          <h3>Live</h3><ol class="mg-feed" id="mg-feed"></ol>
        </aside>
      </div>`;
    this.stage = this.root.querySelector('.mg-stage');
    this.canvas = this.root.querySelector('canvas');
    this.labelsEl = this.root.querySelector('.mg-labels');
    this.tip = this.root.querySelector('.mg-tip');

    const r = new THREE.WebGLRenderer({ canvas: this.canvas, antialias: true, alpha: true, powerPreference: 'low-power' });
    r.setPixelRatio(Math.min(window.devicePixelRatio, 1.5));
    this.renderer = r;
    this.scene = new THREE.Scene();
    this.scene.fog = new THREE.Fog(0x0b0c0e, 60, 140);
    this.camera = new THREE.PerspectiveCamera(50, 1, 0.5, 400);
    this.camera.position.set(0, 18, 62);
    this.scene.add(new THREE.AmbientLight(0xffffff, 0.75));
    const sun = new THREE.DirectionalLight(0xffffff, 1.6);
    sun.position.set(20, 40, 30);
    this.scene.add(sun);
    this.controls = new OrbitControls(this.camera, this.canvas);
    this.controls.enableDamping = true;
    this.controls.dampingFactor = 0.08;
    this.controls.minDistance = 12;
    this.controls.maxDistance = 140;
    this.controls.addEventListener('change', () => this.#wake());
    this.sphere = new THREE.SphereGeometry(1, 18, 14);
    this.lineGeo = new THREE.BufferGeometry();
    this.lines = new THREE.LineSegments(this.lineGeo, new THREE.LineBasicMaterial({ vertexColors: true, transparent: true, opacity: 0.55 }));
    this.scene.add(this.lines);
    this.pulseGeo = new THREE.BufferGeometry();
    this.pulseLines = new THREE.LineSegments(this.pulseGeo, new THREE.LineBasicMaterial({ vertexColors: true, transparent: true, opacity: 1, blending: THREE.AdditiveBlending }));
    this.scene.add(this.pulseLines);
    this.ray = new THREE.Raycaster();

    const input = () => { this.lastInput = performance.now(); this.#wake(); };
    this.canvas.addEventListener('pointerdown', () => { this.userMoved = true; }, { passive: true });
    this.canvas.addEventListener('wheel', () => { this.userMoved = true; }, { passive: true });
    for (const evt of ['pointerdown', 'wheel']) this.canvas.addEventListener(evt, input, { passive: true });
    this.canvas.addEventListener('pointermove', (e) => { input(); this.#hover(e); });
    this.canvas.addEventListener('pointerleave', () => { this.tip.hidden = true; this.hovered = null; });
    this.canvas.addEventListener('click', (e) => this.#click(e));
    this.root.querySelector('#mg-strong').addEventListener('click', (e) => {
      const li = e.target.closest('[data-node]');
      if (li) this.#focus(li.dataset.node);
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
      this.#merge(await api('/api/memory'));
    } catch {
      this.root.querySelector('#mg-stats').textContent = 'The memory isn\'t available right now.';
    }
  }

  // ---- data ---------------------------------------------------------------------------------
  #merge(g) {
    this.data = g;
    const seen = new Set();
    let added = 0;
    for (const d of g.nodes) {
      seen.add(d.id);
      const have = this.nodes.get(d.id);
      if (have) {
        have.data = d;
        this.#style(have);
        continue;
      }
      const n = { data: d, pos: this.#seedPos(d, g), vel: new THREE.Vector3(), mesh: new THREE.Mesh(this.sphere, new THREE.MeshLambertMaterial({ color: 0xffffff })) };
      this.#style(n);
      n.mesh.userData.id = d.id;
      this.scene.add(n.mesh);
      this.nodes.set(d.id, n);
      added++;
    }
    for (const [id, n] of this.nodes) {
      if (seen.has(id)) continue;
      this.scene.remove(n.mesh);
      n.mesh.material.dispose();
      this.nodes.delete(id);
    }
    this.links = g.links.filter((l) => this.nodes.has(l.s) && this.nodes.has(l.t));
    this.lineGeo.setAttribute('position', new THREE.BufferAttribute(new Float32Array(this.links.length * 6), 3));
    this.lineGeo.setAttribute('color', new THREE.BufferAttribute(new Float32Array(this.links.length * 6), 3));
    this.#colorLinks();
    this.#labels();
    this.#side();
    if (added) this.alpha = Math.max(this.alpha, added > 20 ? 1 : 0.5);
    this.#wake();
  }

  // New nodes start next to what they belong to, so the graph grows instead of jumping.
  #seedPos(d, g) {
    const near = (id) => this.nodes.get(id)?.pos;
    const jitter = (r) => new THREE.Vector3((Math.random() - 0.5) * r, (Math.random() - 0.5) * r, (Math.random() - 0.5) * r);
    if (d.type === 'market') {
      const i = g.nodes.filter((x) => x.type === 'market').findIndex((x) => x.id === d.id);
      const a = i * 2.39996; // golden angle: markets spread round a sphere
      const y = 1 - (2 * (i + 0.5)) / Math.max(1, g.nodes.filter((x) => x.type === 'market').length);
      const r = Math.sqrt(1 - y * y);
      return new THREE.Vector3(Math.cos(a) * r * 20, y * 14, Math.sin(a) * r * 20);
    }
    const anchor = d.type === 'situation' ? near(`mkt:${d.symbol}`)
      : d.type === 'lesson' ? near(`desk:${d.agentId}`)
        : near(g.links.find((l) => l.s === d.id && l.kind === 'trades')?.t);
    return (anchor ? anchor.clone() : new THREE.Vector3()).add(jitter(d.type === 'desk' ? 10 : 5));
  }

  #style(n) {
    const d = n.data;
    let color;
    let size;
    if (d.type === 'desk') {
      color = new THREE.Color(this.store.profileById?.[d.agentId]?.accent || '#3987e5');
      size = 1.25;
    } else if (d.type === 'market') {
      color = new THREE.Color(COLORS.market);
      size = 1.7;
    } else if (d.type === 'situation') {
      color = situationColor(d);
      size = Math.min(1.5, 0.42 + 0.16 * Math.sqrt(d.trades || 1));
    } else {
      color = new THREE.Color(COLORS.lesson);
      size = 0.4;
    }
    n.size = size;
    n.mesh.material.color.copy(color);
    n.mesh.material.emissive = color.clone().multiplyScalar(0.25);
    n.mesh.scale.setScalar(size);
  }

  #colorLinks() {
    const col = this.lineGeo.getAttribute('color');
    const c = new THREE.Color();
    this.links.forEach((l, i) => {
      if (l.kind === 'took') c.set(l.avgR > 0.05 ? COLORS.green : l.avgR < -0.05 ? COLORS.red : COLORS.grey).multiplyScalar(0.35 + Math.min(0.45, 0.06 * l.trades));
      else if (l.kind === 'reviews') c.set(COLORS.review).multiplyScalar(Math.min(0.5, 0.08 + 0.02 * l.n));
      else if (l.kind === 'learned') c.set(COLORS.lesson).multiplyScalar(0.5);
      else if (l.kind === 'correlated') c.set(COLORS.market).multiplyScalar(0.3);
      else c.set(COLORS.link).multiplyScalar(0.18);
      col.setXYZ(i * 2, c.r, c.g, c.b);
      col.setXYZ(i * 2 + 1, c.r, c.g, c.b);
    });
    col.needsUpdate = true;
  }

  // ---- layout: a small 3D force simulation --------------------------------------------------
  #tickLayout() {
    const list = [...this.nodes.values()];
    const k = this.alpha;
    const d = new THREE.Vector3();
    for (let i = 0; i < list.length; i++) {
      const a = list[i];
      for (let j = i + 1; j < list.length; j++) {
        const b = list[j];
        d.subVectors(a.pos, b.pos);
        let dist2 = d.lengthSq();
        if (dist2 > 900) continue; // far apart: no push
        if (dist2 < 0.01) { d.set(Math.random() - 0.5, Math.random() - 0.5, Math.random() - 0.5); dist2 = 0.01; }
        const f = (k * 6 * (a.size + b.size)) / dist2;
        d.multiplyScalar(f / Math.sqrt(dist2));
        a.vel.add(d);
        b.vel.sub(d);
      }
    }
    for (const l of this.links) {
      const a = this.nodes.get(l.s);
      const b = this.nodes.get(l.t);
      d.subVectors(b.pos, a.pos);
      const dist = d.length() || 0.01;
      const f = ((dist - (REST[l.kind] || 8)) / dist) * (PULL[l.kind] || 0.05) * k;
      d.multiplyScalar(f);
      a.vel.add(d);
      b.vel.sub(d);
    }
    for (const n of list) {
      n.vel.addScaledVector(n.pos, -0.004 * k); // a gentle pull to the middle
      n.vel.multiplyScalar(0.55);
      n.pos.add(n.vel);
    }
    this.alpha *= 0.985;
    if (this.alpha < 0.02) {
      this.alpha = 0;
      // Settled: frame the whole graph, unless you've been moving the camera yourself.
      if (!this.userMoved) this.#fit();
    }
  }

  #fit() {
    if (!this.nodes.size) return;
    const center = new THREE.Vector3();
    for (const n of this.nodes.values()) center.add(n.pos);
    center.divideScalar(this.nodes.size);
    let r = 0;
    for (const n of this.nodes.values()) r = Math.max(r, n.pos.distanceTo(center) + n.size);
    const fov = (this.camera.fov * Math.PI) / 180;
    const fit = Math.min(fov, 2 * Math.atan(Math.tan(fov / 2) * this.camera.aspect));
    const dist = Math.min(this.controls.maxDistance, (r / Math.sin(fit / 2)) * 0.86);
    const dir = this.camera.position.clone().sub(this.controls.target).normalize();
    this.controls.target.copy(center);
    this.camera.position.copy(center).addScaledVector(dir, dist);
    this.controls.update();
  }

  // ---- live events ---------------------------------------------------------------------------
  #onEvent(ev) {
    this.feed.unshift(ev);
    this.feed.length = Math.min(this.feed.length, 10);
    if (!this.visible) return;
    this.#renderFeed();
    const desk = `desk:${ev.agentId}`;
    if (ev.kind === 'trade') {
      const sit = `sit:${ev.key}`;
      if (!this.nodes.has(sit)) return this.#refreshSoon();
      this.#pulse(desk, sit, ev.r >= 0 ? COLORS.green : COLORS.red);
      this.#refreshSoon(); // the situation's numbers changed
    } else if (ev.kind === 'lesson') {
      this.#refreshSoon();
      setTimeout(() => this.#pulse(`lesson:${ev.id}`, desk, COLORS.lesson), 1200);
    } else if (ev.kind === 'debate') {
      for (const r of ev.reviewers || []) this.#pulse(`desk:${r.id}`, desk, r.stance === 'agree' ? COLORS.green : r.stance === 'disagree' ? COLORS.red : COLORS.review, 1600);
    }
  }

  #refreshSoon() {
    if (this.refreshTimer) return;
    this.refreshTimer = setTimeout(() => { this.refreshTimer = null; this.refresh(); }, 1000);
  }

  #pulse(from, to, color, ms = 2600) {
    if (!this.nodes.has(from) || !this.nodes.has(to)) return;
    this.pulses.push({ from, to, color: new THREE.Color(color), t0: performance.now(), ms });
    this.#wake();
  }

  // ---- drawing -------------------------------------------------------------------------------
  #wake() {
    if (this.running || !this.visible) return;
    this.running = true;
    this.lastFrame = 0;
    requestAnimationFrame((t) => this.#frame(t));
  }

  #frame(now) {
    if (!this.visible || document.hidden) {
      this.running = false;
      return;
    }
    const interacting = now - this.lastInput < 1500;
    const moving = this.alpha > 0 || this.pulses.length || interacting || this.controls.update();
    // Moving: up to 30 frames a second; nothing moving: stop drawing until the next event.
    if (now - (this.lastFrame || 0) >= 1000 / 30 - 4) {
      this.lastFrame = now;
      if (this.alpha > 0) for (let i = 0; i < 2 && this.alpha > 0; i++) this.#tickLayout();
      this.#draw(now);
    }
    if (!moving && !this.pendingFinal) {
      this.pendingFinal = true; // one last frame so the picture is current
      requestAnimationFrame((t) => this.#frame(t));
      return;
    }
    if (!moving) {
      this.pendingFinal = false;
      this.running = false;
      return;
    }
    this.pendingFinal = false;
    requestAnimationFrame((t) => this.#frame(t));
  }

  #draw(now) {
    for (const n of this.nodes.values()) n.mesh.position.copy(n.pos);
    const pos = this.lineGeo.getAttribute('position');
    if (pos) {
      this.links.forEach((l, i) => {
        const a = this.nodes.get(l.s).pos;
        const b = this.nodes.get(l.t).pos;
        pos.setXYZ(i * 2, a.x, a.y, a.z);
        pos.setXYZ(i * 2 + 1, b.x, b.y, b.z);
      });
      pos.needsUpdate = true;
    }
    // Pulses: a bright line that fades, and both ends swell for a moment.
    this.pulses = this.pulses.filter((p) => now - p.t0 < p.ms);
    const pp = new Float32Array(this.pulses.length * 6);
    const pc = new Float32Array(this.pulses.length * 6);
    for (const n of this.nodes.values()) n.mesh.scale.setScalar(n.size);
    this.pulses.forEach((p, i) => {
      const a = this.nodes.get(p.from);
      const b = this.nodes.get(p.to);
      if (!a || !b) return;
      const k = 1 - (now - p.t0) / p.ms;
      pp.set([a.pos.x, a.pos.y, a.pos.z, b.pos.x, b.pos.y, b.pos.z], i * 6);
      pc.set([p.color.r * k, p.color.g * k, p.color.b * k, p.color.r * k, p.color.g * k, p.color.b * k], i * 6);
      a.mesh.scale.setScalar(a.size * (1 + 0.6 * k));
      b.mesh.scale.setScalar(b.size * (1 + 0.6 * k));
    });
    this.pulseGeo.setAttribute('position', new THREE.BufferAttribute(pp, 3));
    this.pulseGeo.setAttribute('color', new THREE.BufferAttribute(pc, 3));
    this.renderer.render(this.scene, this.camera);
    this.#placeLabels();
  }

  #labels() {
    this.labelsEl.innerHTML = '';
    this.labelEls = [];
    for (const n of this.nodes.values()) {
      if (n.data.type !== 'desk' && n.data.type !== 'market') continue;
      const el = document.createElement('span');
      el.className = `mg-label ${n.data.type}`;
      el.textContent = n.data.label;
      this.labelsEl.appendChild(el);
      this.labelEls.push({ el, n });
    }
  }

  #placeLabels() {
    const w = this.stage.clientWidth;
    const h = this.stage.clientHeight;
    const v = new THREE.Vector3();
    for (const { el, n } of this.labelEls || []) {
      v.copy(n.pos).project(this.camera);
      const off = v.z > 1 || v.x < -1.1 || v.x > 1.1 || v.y < -1.1 || v.y > 1.1;
      el.style.display = off ? 'none' : '';
      if (!off) el.style.transform = `translate(${((v.x + 1) / 2) * w}px, ${((1 - v.y) / 2) * h - 14}px) translateX(-50%)`;
    }
  }

  #resize() {
    const w = this.stage.clientWidth || 600;
    const h = this.stage.clientHeight || 420;
    this.renderer.setSize(w, h, false);
    this.camera.aspect = w / h;
    this.camera.updateProjectionMatrix();
    this.#wake();
  }

  // ---- hover, click, side panel ---------------------------------------------------------------
  #pick(e) {
    const rect = this.canvas.getBoundingClientRect();
    const ndc = new THREE.Vector2(((e.clientX - rect.left) / rect.width) * 2 - 1, -((e.clientY - rect.top) / rect.height) * 2 + 1);
    this.ray.setFromCamera(ndc, this.camera);
    const hit = this.ray.intersectObjects([...this.nodes.values()].map((n) => n.mesh), false)[0];
    return hit ? this.nodes.get(hit.object.userData.id) : null;
  }

  #hover(e) {
    if (performance.now() - (this.lastHover || 0) < 60) return;
    this.lastHover = performance.now();
    const n = this.#pick(e);
    if (!n) {
      this.tip.hidden = true;
      return;
    }
    const rect = this.stage.getBoundingClientRect();
    this.tip.innerHTML = this.#describe(n.data);
    this.tip.hidden = false;
    this.tip.style.left = `${Math.min(rect.width - 260, e.clientX - rect.left + 14)}px`;
    this.tip.style.top = `${Math.max(0, e.clientY - rect.top - 10)}px`;
  }

  #describe(d) {
    const name = (id) => this.store.profileById?.[id]?.name.split(' ')[0] || id;
    if (d.type === 'situation') {
      const desks = (this.data?.links || []).filter((l) => l.kind === 'took' && l.t === d.id).sort((a, b) => b.trades - a.trades).slice(0, 4)
        .map((l) => `${escapeHtml(name(l.s.slice(5)))} ${l.trades} (${fmtR(l.avgR)})`).join(' · ');
      return `<b>${escapeHtml(d.symbol)}: ${escapeHtml(d.label)}</b><br>${d.trades} trade${d.trades === 1 ? '' : 's'} like this, average ${fmtR(d.avgR)}, ${pct(d.winRate)} won`
        + `<br><span class="muted">${d.ready ? 'The committee weighs this memory.' : `The committee listens once it has seen about ${this.data?.minN ?? 6}.`}</span>${desks ? `<br><span class="muted">${desks}</span>` : ''}`;
    }
    if (d.type === 'desk') {
      const took = (this.data?.links || []).filter((l) => l.kind === 'took' && l.s === d.id);
      const trades = took.reduce((s, l) => s + l.trades, 0);
      const lessons = (this.data?.nodes || []).filter((x) => x.type === 'lesson' && x.agentId === d.agentId).length;
      return `<b>${escapeHtml(d.label)}</b> · ${escapeHtml(d.sub || '')}<br>${trades} trade${trades === 1 ? '' : 's'} in ${took.length} situation${took.length === 1 ? '' : 's'} · ${lessons} lesson${lessons === 1 ? '' : 's'}<br><span class="muted">Click to open the desk</span>`;
    }
    if (d.type === 'market') {
      const sits = (this.data?.nodes || []).filter((x) => x.type === 'situation' && x.symbol === d.label);
      return `<b>${escapeHtml(d.label)}</b><br>${sits.reduce((s, x) => s + x.trades, 0)} trades remembered in ${sits.length} situation${sits.length === 1 ? '' : 's'}`;
    }
    return `<b>${escapeHtml(name(d.agentId))} learned</b><br>${escapeHtml(d.label)}<br><span class="muted">${escapeHtml(d.status || '')}</span>`;
  }

  #click(e) {
    const n = this.#pick(e);
    if (!n) return;
    if (n.data.type === 'desk' && this.onSelect) this.onSelect(n.data.agentId, { tab: 'learn' });
    else this.#focus(n.data.id);
  }

  #focus(id) {
    const n = this.nodes.get(id);
    if (!n) return;
    this.controls.target.copy(n.pos);
    this.lastInput = performance.now();
    this.#pulse(id, id, '#ffffff', 1500);
    for (const l of this.links) if (l.s === id || l.t === id) this.#pulse(l.s, l.t, '#ffffff', 1500);
    this.#wake();
  }

  #side() {
    const g = this.data;
    const s = g.stats;
    this.root.querySelector('#mg-stats').textContent = s.trades
      ? `${s.trades.toLocaleString('en-US')} trades on real prices remembered in ${s.situations} situations (${s.ready} with enough evidence for the committee) · ${s.lessons} lessons · ${s.reviews.toLocaleString('en-US')} committee reviews`
      : 'Empty for now: every trade the desks close on real prices goes in here, filed by its situation. The committee starts listening to a situation once it has seen a few trades like it.';
    this.root.querySelector('#mg-strong').innerHTML = g.strongest.length
      ? g.strongest.map((x) => `<li data-node="${escapeHtml(x.id)}"><b class="${x.avgR >= 0 ? 'pos' : 'neg'}">${fmtR(x.avgR)}</b> ${escapeHtml(x.symbol)}, ${escapeHtml(x.label)} <span class="muted">· ${x.trades} trades, ${pct(x.winRate)} won</span></li>`).join('')
      : `<li class="muted">Nothing yet: a situation needs about ${g.minN} trades before it counts.</li>`;
    if (!this.feed.length) this.feed = [...(g.events || [])].reverse().slice(0, 10);
    this.#renderFeed();
  }

  #renderFeed() {
    const name = (id) => this.store.profileById?.[id]?.name.split(' ')[0] || id;
    const line = (ev) => {
      if (ev.kind === 'trade') {
        const [sym, trend, vol, session] = ev.key.split('|');
        return `<b>${escapeHtml(name(ev.agentId))}</b> closed ${escapeHtml(sym)} <b class="${ev.r >= 0 ? 'pos' : 'neg'}">${fmtR(ev.r)}</b> <span class="muted">→ ${escapeHtml(trend)} trend, ${escapeHtml(vol)}, ${escapeHtml(session)}</span>`;
      }
      if (ev.kind === 'lesson') return `<b>${escapeHtml(name(ev.agentId))}</b> learned: ${escapeHtml(ev.text)}`;
      return `Committee on <b>${escapeHtml(name(ev.agentId))}</b>'s ${escapeHtml(ev.symbol || '')} idea: ${(ev.reviewers || []).map((r) => `${escapeHtml(name(r.id))} ${escapeHtml(r.stance)}`).join(', ') || 'no reviewers'} <span class="muted">· ${escapeHtml(ev.verdict || '')}</span>`;
    };
    this.root.querySelector('#mg-feed').innerHTML = this.feed.length
      ? this.feed.map((ev) => `<li>${line(ev)}</li>`).join('')
      : '<li class="muted">Trades, lessons and committee meetings appear here as they happen.</li>';
  }
}
