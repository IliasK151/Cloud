import * as THREE from 'three';
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js';
import { smooth, gauss, weldNormals, taperedTube, canvas, texture, mesh } from './geo.js';

// A stylised but anatomically proportioned head. Local space: head centre at the origin,
// the face looks down -Z, +Y is up. Unit radius R = 0.1 m before shaping.
export const R = 0.1;

// Maps a unit direction to a point on the shaped skull (jaw, chin, sockets, brow, occiput).
export function headShape(d, build, out = new THREE.Vector3()) {
  const fem = build === 'f';
  const nx = d.x;
  const ny = d.y;
  const nz = d.z;
  const front = Math.max(0, -nz);
  const back = Math.max(0, nz);
  let x = nx * (fem ? 0.8 : 0.84);
  let y = ny * (fem ? 1.08 : 1.1);
  let z = nz * 0.99;
  // Jaw tapers toward the chin.
  const low = smooth(0.1, -0.95, ny);
  x *= 1 - (fem ? 0.2 : 0.16) * low * low - 0.05 * low;
  // Chin and jawline project forward at the bottom of the face.
  const chin = gauss(ny + 0.78, 0.22) * front * front * gauss(nx, 0.7);
  z -= (fem ? 0.08 : 0.11) * chin;
  y -= 0.03 * chin;
  // Tuck the back of the jaw in so the head sits naturally on the neck.
  z -= 0.28 * low * back * back;
  y += 0.06 * low * back;
  // Fuller back of the skull.
  z += 0.07 * back * gauss(ny - 0.2, 0.45);
  // Brow ridge, eye sockets and cheekbones.
  z -= (fem ? 0.015 : 0.03) * gauss(ny - 0.24, 0.09) * front * front * (1 - 0.6 * Math.abs(nx));
  for (const s of [-1, 1]) z += 0.04 * gauss(nx - s * 0.35, 0.13) * gauss(ny - 0.1, 0.09) * front;
  x *= 1 + 0.045 * gauss(ny + 0.1, 0.2) * (1 - back);
  // Slightly flatter face plane.
  z = z < 0 ? z * (1 - 0.05 * gauss(ny + 0.15, 0.5)) : z;
  return out.set(x * R, y * R, z * R);
}

const dir = (x, y, z) => new THREE.Vector3(x, y, z).normalize();

// Iris + pupil painted for a spherical cap: canvas top = cap centre (pupil), bottom = rim.
function irisTexture(color) {
  const { c, ctx } = canvas(128, 128);
  const base = new THREE.Color(color);
  const hex = (k) => `#${base.clone().multiplyScalar(k).getHexString()}`;
  const g = ctx.createLinearGradient(0, 0, 0, 128);
  g.addColorStop(0, '#040404');
  g.addColorStop(0.36, '#050505');
  g.addColorStop(0.4, hex(0.55));
  g.addColorStop(0.62, hex(1.15));
  g.addColorStop(0.86, hex(0.8));
  g.addColorStop(0.95, '#15100c');
  g.addColorStop(1, '#2a2622');
  ctx.fillStyle = g;
  ctx.fillRect(0, 0, 128, 128);
  // Radial fibres (vertical in this mapping).
  for (let i = 0; i < 70; i++) {
    const x = (i / 70) * 128;
    ctx.fillStyle = `rgba(255,255,255,${0.04 + (i % 3) * 0.03})`;
    ctx.fillRect(x, 52, 1, 50);
  }
  return texture(c);
}

// Builds the head. Returns handles for animation: eyes, lids, brows, lips (morphs), jaw.
export function buildHead(app, mats) {
  const build = app.build;
  const fem = build === 'f';
  const group = new THREE.Group();

  // --- skull with painted-in skin variation (blush, beard shadow, eye area) ---
  const geo = new THREE.SphereGeometry(1, 64, 48);
  const pos = geo.attributes.position;
  const colors = new Float32Array(pos.count * 3);
  const skin = new THREE.Color(app.skin);
  const blush = skin.clone().lerp(new THREE.Color('#d0605a'), 0.5);
  const beard = skin.clone().multiplyScalar(0.62).lerp(new THREE.Color('#3a3f48'), 0.35);
  const d = new THREE.Vector3();
  const p = new THREE.Vector3();
  const c = new THREE.Color();
  for (let i = 0; i < pos.count; i++) {
    d.fromBufferAttribute(pos, i).normalize();
    headShape(d, build, p);
    pos.setXYZ(i, p.x, p.y, p.z);
    const front = Math.max(0, -d.z);
    c.copy(skin);
    const cheek = Math.max(gauss(d.x - 0.48, 0.2), gauss(d.x + 0.48, 0.2)) * gauss(d.y + 0.2, 0.18) * front;
    c.lerp(blush, (fem ? 0.28 : 0.16) * cheek);
    c.lerp(blush, 0.12 * gauss(d.x, 0.08) * gauss(d.y + 0.2, 0.08) * front); // nose tip area
    const socket = (gauss(d.x - 0.35, 0.16) + gauss(d.x + 0.35, 0.16)) * gauss(d.y - 0.06, 0.14) * front;
    c.multiplyScalar(1 - 0.1 * socket);
    if (app.stubble) {
      const jaw = smooth(-0.25, -0.55, d.y) * smooth(0.05, 0.45, front + 0.2) * (1 - smooth(0.7, 0.95, Math.abs(d.x) + 0.2 * (1 - front)));
      const lip = gauss(d.y + 0.36, 0.06) * gauss(d.x, 0.2) * front;
      c.lerp(beard, app.stubble * Math.min(1, jaw + lip));
    }
    // Slightly deeper tone under the jaw.
    c.multiplyScalar(1 - 0.12 * smooth(-0.6, -0.95, d.y));
    colors[i * 3] = c.r;
    colors[i * 3 + 1] = c.g;
    colors[i * 3 + 2] = c.b;
  }
  geo.setAttribute('color', new THREE.BufferAttribute(colors, 3));
  geo.computeVertexNormals();
  weldNormals(geo);
  const skull = mesh(geo, mats.face);
  group.add(skull);

  // --- ears ---
  for (const s of [-1, 1]) {
    const ear = mesh(new THREE.SphereGeometry(1, 16, 12), mats.skin);
    const at = headShape(dir(s, 0.02, 0.12), build);
    ear.position.set(at.x - s * 0.001, at.y - 0.004, at.z + 0.004);
    ear.scale.set(0.008, 0.026, 0.017);
    ear.rotation.set(0, s * -0.18, s * 0.05);
    group.add(ear);
    const inner = mesh(new THREE.SphereGeometry(1, 12, 8), mats.skinDeep, { shadow: false });
    inner.position.set(at.x + s * 0.005, at.y - 0.004, at.z + 0.002);
    inner.scale.set(0.004, 0.018, 0.01);
    inner.rotation.copy(ear.rotation);
    group.add(inner);
  }

  // --- nose: bridge, tip and wings merged into one mesh ---
  const noseTop = headShape(dir(0, 0.1, -1), build);
  const noseTip = headShape(dir(0, -0.2, -1), build);
  const len = noseTop.distanceTo(noseTip);
  const parts = [];
  const bridge = new THREE.SphereGeometry(1, 16, 12);
  bridge.scale(fem ? 0.0062 : 0.0074, len * 0.56, 0.0095);
  bridge.rotateX(0.3);
  bridge.translate(0, (noseTop.y + noseTip.y) / 2 - 0.002, (noseTop.z + noseTip.z) / 2 - 0.0045);
  parts.push(bridge);
  const tip = new THREE.SphereGeometry(1, 16, 12);
  tip.scale(fem ? 0.0068 : 0.008, fem ? 0.0062 : 0.0072, 0.0068);
  tip.translate(0, noseTip.y + 0.002, noseTip.z - 0.0102);
  parts.push(tip);
  for (const s of [-1, 1]) {
    const wing = new THREE.SphereGeometry(1, 12, 10);
    wing.scale(0.0052, 0.0046, 0.0062);
    wing.translate(s * (fem ? 0.0078 : 0.0092), noseTip.y + 0.0012, noseTip.z - 0.0028);
    parts.push(wing);
  }
  const noseGeo = mergeGeometries(parts.map((g) => g.toNonIndexed()).map((g) => { g.deleteAttribute('uv'); return g; }));
  noseGeo.computeVertexNormals();
  const nose = mesh(noseGeo, mats.skin);
  group.add(nose);
  // Nostrils: two small dark dots under the tip.
  for (const s of [-1, 1]) {
    const n = mesh(new THREE.SphereGeometry(0.0024, 8, 6), mats.nostril, { shadow: false });
    n.position.set(s * 0.0042, noseTip.y - 0.0036, noseTip.z - 0.0072);
    n.scale.set(1.1, 0.45, 1);
    group.add(n);
  }

  // --- eyes ---
  const eyeR = fem ? 0.0136 : 0.0128;
  const irisMat = new THREE.MeshPhysicalMaterial({ map: irisTexture(app.eyes || '#5a3a22'), roughness: 0.25, clearcoat: 1, clearcoatRoughness: 0.05 });
  const eyes = [];
  const lids = [];
  for (const s of [-1, 1]) {
    const socket = headShape(dir(s * 0.35, 0.1, -0.93), build);
    const eye = new THREE.Group();
    eye.position.set(socket.x, socket.y, socket.z + eyeR * 0.6);
    group.add(eye);
    const sclera = mesh(new THREE.SphereGeometry(eyeR, 24, 16), mats.sclera, { shadow: false });
    eye.add(sclera);
    // Iris: a cap on the front of the eyeball (slightly proud of it, like the cornea).
    const iris = new THREE.Mesh(new THREE.SphereGeometry(eyeR * 1.012, 32, 12, 0, Math.PI * 2, 0, 0.6), irisMat);
    iris.rotation.x = -Math.PI / 2;
    eye.add(iris);
    eyes.push(eye);

    // Eyelids: an upper shell that blinks and a lower one; a dark lash line on the upper edge.
    const lidGeo = new THREE.SphereGeometry(eyeR * 1.1, 24, 10, 0, Math.PI * 2, 0, Math.PI / 2);
    const upper = new THREE.Group();
    upper.position.copy(eye.position);
    group.add(upper);
    upper.add(mesh(lidGeo, mats.lid, { shadow: false }));
    const lash = new THREE.Mesh(new THREE.TorusGeometry(eyeR * 1.1, fem ? 0.0014 : 0.0009, 6, 24, Math.PI), mats.lash);
    lash.rotation.x = -Math.PI / 2;
    upper.add(lash);
    const lower = new THREE.Group();
    lower.position.copy(eye.position);
    lower.rotation.x = Math.PI - 0.6;
    group.add(lower);
    lower.add(mesh(lidGeo, mats.lid, { shadow: false }));
    lids.push({ upper, lower, side: s });

    // Catchlight: fixed to the head, like the reflection of the ceiling lights.
    const glint = new THREE.Mesh(new THREE.CircleGeometry(eyeR * 0.13, 10), mats.glint);
    glint.position.set(eye.position.x - eyeR * 0.28, eye.position.y + eyeR * 0.32, eye.position.z - eyeR * 1.02);
    glint.rotation.y = Math.PI;
    group.add(glint);
  }

  // --- eyebrows ---
  const brows = new THREE.Group();
  group.add(brows);
  for (const s of [-1, 1]) {
    const pts = [[0.13, 0.25], [0.3, 0.3], [0.5, 0.26]].map(([x, y]) => {
      const q = headShape(dir(s * x, y, -0.93), build);
      return q.add(new THREE.Vector3(0, 0, -0.0016));
    });
    const curve = new THREE.CatmullRomCurve3(pts);
    const thick = fem ? 0.0022 : 0.0033;
    const brow = mesh(taperedTube(curve, (t) => thick * (1.05 - 0.55 * t) * Math.min(1, Math.sin(Math.PI * Math.min(1, t * 1.15 + 0.08)) * 1.6 + 0.2), { tubular: 16, radial: 8, flatten: 0.55 }), mats.brow, { shadow: false });
    brows.add(brow);
  }

  // --- mouth: lips with open/smile morph targets, teeth and the dark inside ---
  const m = headShape(dir(0, -0.46, -1), build);
  const halfW = fem ? 0.0205 : 0.022;
  const curveZ = (x) => m.z + (x * x) / 0.12 - 0.0012;
  const lipCurve = (upper, open, smile) => {
    const pts = [];
    for (let i = 0; i <= 8; i++) {
      const t = i / 8;
      const x = (t * 2 - 1) * halfW;
      const e = (x / halfW) ** 2; // 0 centre, 1 corners
      let y = m.y;
      if (upper) y += 0.0022 * (1 - e) ; // gentle cupid's bow
      else y -= 0.0026 * (1 - e);
      if (upper) y += 0.0018 * open * (1 - e);
      else y -= 0.0095 * open * (1 - e * 0.85);
      y += 0.0042 * smile * e;
      const xx = x * (1 + 0.1 * smile);
      pts.push(new THREE.Vector3(xx, y, curveZ(x) + 0.0016 * smile * e - (upper ? 0 : 0.0006 * open)));
    }
    return new THREE.CatmullRomCurve3(pts);
  };
  const lipMesh = (upper) => {
    const r = upper ? (fem ? 0.0031 : 0.0027) : fem ? 0.0041 : 0.0035;
    const prof = (t) => r * Math.pow(Math.sin(Math.PI * t), 0.7);
    const base = taperedTube(lipCurve(upper, 0, 0), prof, { tubular: 24, radial: 10, flatten: 0.8 });
    const open = taperedTube(lipCurve(upper, 1, 0), prof, { tubular: 24, radial: 10, flatten: 0.8 });
    const smile = taperedTube(lipCurve(upper, 0, 1), prof, { tubular: 24, radial: 10, flatten: 0.8 });
    base.morphAttributes.position = [open.attributes.position, smile.attributes.position];
    base.morphAttributes.normal = [open.attributes.normal, smile.attributes.normal];
    const lm = mesh(base, mats.lips, { shadow: false });
    lm.morphTargetInfluences = [0, 0];
    group.add(lm);
    return lm;
  };
  const lips = [lipMesh(true), lipMesh(false)];
  const inside = new THREE.Mesh(new THREE.CircleGeometry(1, 24), mats.mouth);
  inside.position.set(0, m.y - 0.001, m.z - 0.0002);
  inside.scale.set(halfW * 0.92, 0.0005, 1);
  inside.rotation.y = Math.PI;
  group.add(inside);
  const teeth = new THREE.Mesh(new THREE.BoxGeometry(halfW * 0.95, 0.003, 0.001), mats.teeth);
  teeth.position.set(0, m.y + 0.0006, m.z - 0.0008);
  group.add(teeth);

  return {
    group,
    eyes,
    lids,
    brows,
    lips,
    inside,
    teeth,
    mouth: m,
    halfW,
    shape: (d0, out) => headShape(d0, build, out),
  };
}
