import * as THREE from 'three';
import { taperedTube, mesh } from './geo.js';

const dir = (x, y, z) => new THREE.Vector3(x, y, z).normalize();

// Thin rectangular frames with lenses, resting on the nose and ears.
export function buildGlasses(head, color = '#15171b') {
  const g = new THREE.Group();
  const frame = new THREE.MeshStandardMaterial({ color, roughness: 0.3, metalness: 0.4 });
  const lensMat = new THREE.MeshPhysicalMaterial({ color: '#dfe8f2', transparent: true, opacity: 0.12, roughness: 0.02, metalness: 0, clearcoat: 1, envMapIntensity: 2.2, depthWrite: false });
  const w = 0.0265;
  const h = 0.019;
  const outline = (cx, cy, cz) => {
    const pts = [];
    for (let i = 0; i < 32; i++) {
      const a = (i / 32) * Math.PI * 2;
      const c = Math.cos(a);
      const s = Math.sin(a);
      pts.push(new THREE.Vector3(cx + Math.sign(c) * Math.pow(Math.abs(c), 0.45) * w / 2, cy + Math.sign(s) * Math.pow(Math.abs(s), 0.55) * h / 2 - (s < 0 ? 0.0015 * Math.abs(s) : 0), cz));
    }
    return pts;
  };
  const eyes = head.eyes.map((e) => e.position);
  const z = Math.min(...eyes.map((p) => p.z)) - 0.0145;
  for (const e of eyes) {
    const pts = outline(e.x, e.y + 0.001, z);
    g.add(mesh(taperedTube(new THREE.CatmullRomCurve3(pts, true), () => 0.0012, { tubular: 48, radial: 6 }), frame, { shadow: false }));
    const shape = new THREE.Shape(pts.map((p) => new THREE.Vector2(p.x, p.y)));
    const lens = new THREE.Mesh(new THREE.ShapeGeometry(shape, 12), lensMat);
    lens.position.z = z + 0.0004;
    lens.renderOrder = 3;
    g.add(lens);
  }
  const [l, r] = eyes[0].x < eyes[1].x ? eyes : [eyes[1], eyes[0]];
  const bridge = new THREE.CatmullRomCurve3([
    new THREE.Vector3(l.x + w / 2, l.y + 0.003, z),
    new THREE.Vector3(0, l.y + 0.005, z - 0.002),
    new THREE.Vector3(r.x - w / 2, r.y + 0.003, z),
  ]);
  g.add(mesh(taperedTube(bridge, () => 0.0011, { tubular: 12, radial: 6 }), frame, { shadow: false }));
  for (const s of [-1, 1]) {
    const e = s < 0 ? l : r;
    const ear = head.shape(dir(s, 0.06, 0.1), new THREE.Vector3());
    const temple = new THREE.CatmullRomCurve3([
      new THREE.Vector3(e.x + s * w / 2, e.y + 0.004, z),
      new THREE.Vector3(ear.x + s * 0.004, e.y + 0.006, (z + ear.z) / 2),
      new THREE.Vector3(ear.x + s * 0.002, ear.y + 0.004, ear.z + 0.004),
      new THREE.Vector3(ear.x - s * 0.002, ear.y - 0.012, ear.z + 0.014),
    ]);
    g.add(mesh(taperedTube(temple, () => 0.0011, { tubular: 20, radial: 6 }), frame, { shadow: false }));
  }
  return g;
}

// Over-the-head trading headset with a boom mic on the right.
export function buildHeadset(head, hairTop, accent) {
  const g = new THREE.Group();
  const plastic = new THREE.MeshStandardMaterial({ color: '#16181c', roughness: 0.45, metalness: 0.25 });
  const pad = new THREE.MeshStandardMaterial({ color: '#0e0f11', roughness: 0.9 });
  const light = new THREE.MeshStandardMaterial({ color: accent, emissive: accent, emissiveIntensity: 1.2 });
  const p = new THREE.Vector3();
  const band = [];
  for (let i = 0; i <= 16; i++) {
    const a = -Math.PI / 2 + (i / 16) * Math.PI; // left ear → top → right ear
    const d = dir(Math.sin(a), Math.cos(a), 0.12);
    head.shape(d, p);
    const lift = hairTop * Math.max(0, Math.cos(a)) + 0.006;
    band.push(p.clone().addScaledVector(d, lift));
  }
  band[0].y -= 0.01;
  band[band.length - 1].y -= 0.01;
  g.add(mesh(taperedTube(new THREE.CatmullRomCurve3(band), () => 0.0045, { tubular: 40, radial: 8, flatten: 2.2 }), plastic, { shadow: false }));
  for (const s of [-1, 1]) {
    head.shape(dir(s, 0.02, 0.12), p);
    const cup = new THREE.Group();
    cup.position.set(p.x + s * 0.016, p.y - 0.008, p.z);
    cup.rotation.z = Math.PI / 2;
    const shell = mesh(new THREE.CylinderGeometry(0.029, 0.031, 0.02, 24), plastic, { shadow: false });
    cup.add(shell);
    const cushion = mesh(new THREE.TorusGeometry(0.026, 0.007, 8, 24), pad, { shadow: false });
    cushion.rotation.x = Math.PI / 2;
    cushion.position.y = -s * 0.011;
    cup.add(cushion);
    const dot = new THREE.Mesh(new THREE.CircleGeometry(0.004, 12), light);
    dot.position.y = s * 0.0102;
    dot.rotation.x = -s * Math.PI / 2;
    cup.add(dot);
    g.add(cup);
    if (s > 0) {
      const mouth = head.mouth;
      const boom = new THREE.CatmullRomCurve3([
        new THREE.Vector3(p.x + 0.02, p.y - 0.012, p.z - 0.01),
        new THREE.Vector3(p.x + 0.006, p.y - 0.04, p.z - 0.05),
        new THREE.Vector3(mouth.x + 0.035, mouth.y - 0.004, mouth.z - 0.018),
      ]);
      g.add(mesh(taperedTube(boom, () => 0.0022, { tubular: 20, radial: 6 }), plastic, { shadow: false }));
      const mic = mesh(new THREE.CapsuleGeometry(0.0045, 0.01, 4, 10), pad, { shadow: false });
      mic.position.set(mouth.x + 0.031, mouth.y - 0.004, mouth.z - 0.019);
      mic.rotation.z = Math.PI / 2;
      g.add(mic);
    }
  }
  return g;
}
