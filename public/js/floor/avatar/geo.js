import * as THREE from 'three';

// Small geometry and texture helpers shared by the avatar builders.

export const clamp01 = (x) => Math.min(1, Math.max(0, x));
export const smooth = (e0, e1, x) => {
  const t = clamp01((x - e0) / (e1 - e0));
  return t * t * (3 - 2 * t);
};
export const gauss = (x, s) => Math.exp(-(x * x) / (s * s));
export const lerp = (a, b, t) => a + (b - a) * t;

export function seeded(seed) {
  let s = seed >>> 0 || 1;
  return () => {
    s = (s * 1664525 + 1013904223) >>> 0;
    return s / 4294967296;
  };
}

export function hashString(str) {
  let h = 2166136261;
  for (const c of str) h = Math.imul(h ^ c.charCodeAt(0), 16777619) >>> 0;
  return h;
}

// Indexed grid surface from fn(u, v, out:Vector3). Normals face away from `center`.
export function gridSurface(U, V, fn, center = null) {
  const pos = new Float32Array((U + 1) * (V + 1) * 3);
  const uv = new Float32Array((U + 1) * (V + 1) * 2);
  const p = new THREE.Vector3();
  let k = 0;
  let q = 0;
  for (let j = 0; j <= V; j++) {
    for (let i = 0; i <= U; i++) {
      fn(i / U, j / V, p);
      pos[k++] = p.x;
      pos[k++] = p.y;
      pos[k++] = p.z;
      uv[q++] = i / U;
      uv[q++] = 1 - j / V;
    }
  }
  const idx = [];
  for (let j = 0; j < V; j++) {
    for (let i = 0; i < U; i++) {
      const a = j * (U + 1) + i;
      const b = a + 1;
      const c = a + U + 1;
      const d = c + 1;
      idx.push(a, b, c, b, d, c);
    }
  }
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.BufferAttribute(pos, 3));
  g.setAttribute('uv', new THREE.BufferAttribute(uv, 2));
  g.setIndex(idx);
  g.computeVertexNormals();
  if (center) orientOutward(g, center);
  return g;
}

// Flip the winding if most normals point toward `center`.
export function orientOutward(g, center) {
  const pos = g.attributes.position;
  const nor = g.attributes.normal;
  let dot = 0;
  for (let i = 0; i < pos.count; i += 3) {
    dot += (pos.getX(i) - center.x) * nor.getX(i) + (pos.getY(i) - center.y) * nor.getY(i) + (pos.getZ(i) - center.z) * nor.getZ(i);
  }
  if (dot < 0) {
    const idx = g.index.array;
    for (let i = 0; i < idx.length; i += 3) {
      const t = idx[i + 1];
      idx[i + 1] = idx[i + 2];
      idx[i + 2] = t;
    }
    g.index.needsUpdate = true;
    g.computeVertexNormals();
  }
  return g;
}

// Average the normals of coincident vertices (UV seams and poles) so deformed shapes shade smoothly.
export function weldNormals(g, precision = 1e5) {
  const pos = g.attributes.position;
  const nor = g.attributes.normal;
  const groups = new Map();
  for (let i = 0; i < pos.count; i++) {
    const key = `${Math.round(pos.getX(i) * precision)},${Math.round(pos.getY(i) * precision)},${Math.round(pos.getZ(i) * precision)}`;
    let list = groups.get(key);
    if (!list) groups.set(key, (list = []));
    list.push(i);
  }
  const n = new THREE.Vector3();
  for (const list of groups.values()) {
    if (list.length < 2) continue;
    n.set(0, 0, 0);
    for (const i of list) n.x += nor.getX(i), n.y += nor.getY(i), n.z += nor.getZ(i);
    n.normalize();
    for (const i of list) nor.setXYZ(i, n.x, n.y, n.z);
  }
  nor.needsUpdate = true;
  return g;
}

// Tube with a varying radius r(t) along a curve (t in 0..1), capped by the radius going to ~0.
export function taperedTube(curve, radius, { tubular = 32, radial = 12, flatten = 1 } = {}) {
  const frames = curve.computeFrenetFrames(tubular, false);
  const p = new THREE.Vector3();
  return gridSurface(radial, tubular, (u, v, out) => {
    const i = Math.round(v * tubular);
    curve.getPointAt(v, p);
    const a = u * Math.PI * 2;
    const r = radius(v);
    out.copy(p)
      .addScaledVector(frames.normals[i], Math.cos(a) * r * flatten)
      .addScaledVector(frames.binormals[i], Math.sin(a) * r);
  });
}

export function canvas(w, h) {
  const c = document.createElement('canvas');
  c.width = w;
  c.height = h;
  return { c, ctx: c.getContext('2d') };
}

export function texture(c, { srgb = true, repeat = null } = {}) {
  const t = new THREE.CanvasTexture(c);
  if (srgb) t.colorSpace = THREE.SRGBColorSpace;
  t.anisotropy = 8;
  if (repeat) {
    t.wrapS = t.wrapT = THREE.RepeatWrapping;
    t.repeat.set(repeat[0], repeat[1]);
  }
  return t;
}

// Fine strands running along v (hair) — used as colour and bump map.
let strandTex = null;
export function strandTexture() {
  if (strandTex) return strandTex;
  const { c, ctx } = canvas(256, 256);
  const rnd = seeded(41);
  ctx.fillStyle = '#f0f0f0';
  ctx.fillRect(0, 0, 256, 256);
  for (let i = 0; i < 900; i++) {
    const x = rnd() * 256;
    const v = 170 + rnd() * 85;
    ctx.strokeStyle = `rgba(${v},${v},${v},${0.25 + rnd() * 0.5})`;
    ctx.lineWidth = 0.6 + rnd() * 1.4;
    ctx.beginPath();
    const y0 = rnd() * 256;
    ctx.moveTo(x, y0 - 40);
    ctx.bezierCurveTo(x + (rnd() - 0.5) * 6, y0, x + (rnd() - 0.5) * 6, y0 + 60, x + (rnd() - 0.5) * 4, y0 + 120);
    ctx.stroke();
  }
  // Wrap vertically so the pattern tiles.
  ctx.drawImage(c, 0, 0, 256, 128, 0, 128, 256, 128);
  strandTex = texture(c, { srgb: false, repeat: [6, 1] });
  return strandTex;
}

// Subtle woven fabric noise for suits and shirts.
let weaveTex = null;
export function weaveTexture() {
  if (weaveTex) return weaveTex;
  const { c, ctx } = canvas(128, 128);
  const img = ctx.createImageData(128, 128);
  const rnd = seeded(5);
  for (let y = 0; y < 128; y++) {
    for (let x = 0; x < 128; x++) {
      const i = (y * 128 + x) * 4;
      const twill = ((x + y) % 4 < 2 ? 10 : -10) + (rnd() - 0.5) * 18;
      const v = 200 + twill;
      img.data[i] = img.data[i + 1] = img.data[i + 2] = v;
      img.data[i + 3] = 255;
    }
  }
  ctx.putImageData(img, 0, 0);
  weaveTex = texture(c, { srgb: false, repeat: [10, 10] });
  return weaveTex;
}

export function darken(hex, k) {
  return new THREE.Color(hex).multiplyScalar(k);
}

export function mixColor(a, b, t) {
  return new THREE.Color(a).lerp(new THREE.Color(b), t);
}

export function mesh(geo, mat, { shadow = true } = {}) {
  const m = new THREE.Mesh(geo, mat);
  m.castShadow = shadow;
  m.receiveShadow = shadow;
  return m;
}
