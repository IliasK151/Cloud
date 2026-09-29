import * as THREE from 'three';
import { smooth, gauss, gridSurface, taperedTube, lerp, mesh } from './geo.js';

// Hairstyles built as surfaces that hug the shaped skull. theta runs around the head
// (0 = back, π = face), phi runs down from the crown.

const TAU = Math.PI * 2;

// Interpolates a hairline (phi in degrees) over the angle from the face (0) to the back (π).
function hairline(points) {
  return (theta) => {
    let a = Math.abs(((theta - Math.PI + Math.PI) % TAU + TAU) % TAU - Math.PI); // 0 at face, π at back
    a = Math.min(Math.PI, a);
    for (let i = 1; i < points.length; i++) {
      const [a1, p1] = points[i];
      const [a0, p0] = points[i - 1];
      if (a <= a1) {
        const t = (a - a0) / (a1 - a0);
        const s = t * t * (3 - 2 * t);
        return THREE.MathUtils.degToRad(lerp(p0, p1, s));
      }
    }
    return THREE.MathUtils.degToRad(points[points.length - 1][1]);
  };
}

const STYLES = {
  short: { line: [[0, 57], [0.5, 66], [1.1, 84], [1.45, 80], [1.8, 88], [2.4, 106], [Math.PI, 112]], top: 0.011, side: 0.004, back: 0.005 },
  side: { line: [[0, 55], [0.5, 64], [1.1, 84], [1.45, 80], [1.8, 88], [2.4, 106], [Math.PI, 112]], top: 0.019, side: 0.005, back: 0.006, part: 0.55, swoop: 0.012 },
  buzz: { line: [[0, 58], [0.5, 67], [1.1, 86], [1.45, 82], [1.8, 90], [2.4, 106], [Math.PI, 112]], top: 0.0028, side: 0.0018, back: 0.002 },
  receding: { line: [[0, 44], [0.35, 52], [0.6, 48], [1.1, 82], [1.45, 80], [1.8, 88], [2.4, 106], [Math.PI, 112]], top: 0.006, side: 0.0045, back: 0.005 },
  textured: { line: [[0, 56], [0.5, 65], [1.1, 84], [1.45, 80], [1.8, 88], [2.4, 106], [Math.PI, 112]], top: 0.02, side: 0.006, back: 0.007, noise: 0.006 },
  long: { line: [[0, 58], [0.5, 70], [1.0, 96], [1.6, 108], [2.4, 118], [Math.PI, 122]], top: 0.008, side: 0.009, back: 0.01, part: 0, curtain: { length: 0.3, sideLength: 0.2, flare: 0.028 } },
  bob: { line: [[0, 70], [0.45, 76], [0.9, 96], [1.6, 108], [2.4, 118], [Math.PI, 122]], top: 0.012, side: 0.012, back: 0.012, fringe: 0.012, curtain: { length: 0.1, sideLength: 0.075, flare: 0.022, curl: 0.012 } },
  bun: { line: [[0, 57], [0.5, 66], [1.1, 88], [1.45, 86], [1.8, 92], [2.4, 106], [Math.PI, 114]], top: 0.005, side: 0.004, back: 0.005, bun: 0.042 },
  ponytail: { line: [[0, 57], [0.5, 66], [1.1, 88], [1.45, 86], [1.8, 92], [2.4, 106], [Math.PI, 114]], top: 0.006, side: 0.004, back: 0.005, tail: 0.24 },
};

export function buildHair(style, shape, mat) {
  const s = STYLES[style] || STYLES.short;
  const group = new THREE.Group();
  const phiMax = hairline(s.line);
  const d = new THREE.Vector3();
  const p = new THREE.Vector3();
  const center = new THREE.Vector3(0, 0, 0);

  const thickness = (theta, phi, edge) => {
    const ny = Math.cos(phi);
    const faceSide = Math.max(0, -Math.cos(theta));
    let t = lerp(s.side, s.top, smooth(0.1, 0.85, ny));
    t = lerp(t, s.back, Math.max(0, Math.cos(theta)) * (1 - smooth(0.3, 0.9, ny)));
    if (s.part) t *= 1 - 0.45 * gauss(Math.sin(theta) - s.part, 0.08) * smooth(0.4, 0.9, ny);
    if (s.swoop) t += s.swoop * gauss(Math.sin(theta) + 0.35, 0.45) * faceSide * smooth(0.3, 0.8, ny);
    if (s.fringe) t += s.fringe * faceSide * faceSide * smooth(0.55, 0.2, ny) * 0.8;
    if (s.noise) t += s.noise * (Math.sin(theta * 9 + phi * 7) * 0.5 + Math.sin(theta * 17 - phi * 11) * 0.5) * smooth(0.2, 0.8, ny);
    // Taper to the scalp at the hairline so the edge blends in.
    return Math.max(0.0003, t * (0.08 + 0.92 * smooth(0, 0.22, edge)));
  };

  // Cap
  const cap = gridSurface(64, 26, (u, v, out) => {
    const theta = u * TAU;
    const faceSide = Math.max(0, -Math.cos(theta));
    const pm = phiMax(theta) + (s.fringe ? 0.028 * faceSide * Math.sin(theta * 23) * Math.sin(theta * 7) : 0);
    const phi = v * pm;
    d.set(Math.sin(phi) * Math.sin(theta), Math.cos(phi), Math.sin(phi) * Math.cos(theta));
    shape(d, p);
    const t = thickness(theta, phi, 1 - v);
    out.copy(p).addScaledVector(d, t);
    // Fringe falls slightly forward/down over the forehead.
    if (s.fringe) out.y -= 0.004 * Math.max(0, -Math.cos(theta)) * v * v;
  }, center);
  group.add(mesh(cap, mat));

  // Hanging lengths (long hair, bob): a curtain around the back and sides, open at the face.
  if (s.curtain) {
    const cfg = s.curtain;
    const open = 1.05; // half-angle of the face opening
    const top = 0.012;
    const curtain = gridSurface(48, 20, (u, v, out) => {
      const theta = Math.PI + open + u * (TAU - 2 * open); // from left of the face around the back
      const aroundFace = 1 - Math.abs(Math.cos((theta - Math.PI) / 2)); // 0 back … ~1 near the face
      const lenHere = lerp(cfg.length, cfg.sideLength, smooth(0.35, 0.95, aroundFace));
      const y = lerp(top, -lenHere, v);
      // Radius: follow the head where it exists, then fall straight with a gentle flare.
      d.set(Math.sin(theta), 0, Math.cos(theta));
      const ny = Math.max(-0.95, Math.min(0.95, y / 0.11));
      const dd = new THREE.Vector3(Math.sin(theta) * Math.sqrt(1 - ny * ny), ny, Math.cos(theta) * Math.sqrt(1 - ny * ny));
      shape(dd, p);
      const headR = Math.hypot(p.x, p.z);
      const topR = Math.hypot(...(() => { shape(new THREE.Vector3(Math.sin(theta), 0, Math.cos(theta)), p); return [p.x, p.z]; })());
      const r = (y > 0 ? headR : Math.max(headR, topR * lerp(1, 0.94, smooth(0, -0.08, y)))) + 0.01 + cfg.flare * smooth(-0.02, -lenHere, y);
      const curl = cfg.curl ? -cfg.curl * smooth(0.75, 1, v) : 0;
      out.set(Math.sin(theta) * (r + curl), y, Math.cos(theta) * (r + curl));
    }, center);
    const cm = mesh(curtain, mat);
    cm.material = mat.side === THREE.DoubleSide ? mat : mat.clone();
    cm.material.side = THREE.DoubleSide;
    group.add(cm);
  }

  if (s.bun) {
    const bun = mesh(new THREE.SphereGeometry(s.bun, 24, 18), mat);
    shape(new THREE.Vector3(0, 0.55, 0.83).normalize(), p);
    bun.position.copy(p).add(new THREE.Vector3(0, 0.012, s.bun * 0.72));
    bun.scale.set(1, 0.88, 0.95);
    group.add(bun);
  }

  if (s.tail) {
    shape(new THREE.Vector3(0, 0.35, 1).normalize(), p);
    const start = p.clone().add(new THREE.Vector3(0, 0, 0.008));
    const curve = new THREE.CatmullRomCurve3([
      start,
      start.clone().add(new THREE.Vector3(0, -0.04, 0.035)),
      start.clone().add(new THREE.Vector3(0.006, -0.12, 0.05)),
      start.clone().add(new THREE.Vector3(0.012, -s.tail, 0.03)),
    ]);
    const tail = mesh(taperedTube(curve, (t) => 0.02 * (0.55 + 0.6 * Math.sin(Math.PI * Math.min(1, t * 0.9 + 0.12))) * (1 - smooth(0.8, 1, t) * 0.85), { tubular: 28, radial: 14 }), mat);
    group.add(tail);
    const tie = mesh(new THREE.TorusGeometry(0.012, 0.004, 8, 20), mat.userData.tieMat || mat);
    tie.position.copy(start).add(new THREE.Vector3(0, -0.004, 0.006));
    tie.rotation.x = Math.PI / 2 - 0.5;
    group.add(tie);
  }

  return group;
}
