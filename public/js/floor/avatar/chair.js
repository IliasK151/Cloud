import * as THREE from 'three';
import { RoundedBoxGeometry } from 'three/addons/geometries/RoundedBoxGeometry.js';
import { canvas, texture, mesh, taperedTube } from './geo.js';

// Ergonomic mesh task chair: five-star base (static) and a swivelling seat/back/arms.

let meshTex = null;
function meshTexture() {
  if (meshTex) return meshTex;
  const { c, ctx } = canvas(64, 64);
  ctx.fillStyle = '#2a2d33';
  ctx.fillRect(0, 0, 64, 64);
  ctx.strokeStyle = '#15171b';
  ctx.lineWidth = 3;
  for (let i = -64; i < 128; i += 8) {
    ctx.beginPath();
    ctx.moveTo(i, 0);
    ctx.lineTo(i + 64, 64);
    ctx.stroke();
    ctx.beginPath();
    ctx.moveTo(i + 64, 0);
    ctx.lineTo(i, 64);
    ctx.stroke();
  }
  meshTex = texture(c, { repeat: [7, 9] });
  return meshTex;
}

let shared = null;
function materials() {
  if (shared) return shared;
  shared = {
    frame: new THREE.MeshStandardMaterial({ color: '#1c1e22', roughness: 0.45, metalness: 0.2 }),
    alu: new THREE.MeshStandardMaterial({ color: '#8b9098', roughness: 0.3, metalness: 0.85 }),
    cushion: new THREE.MeshStandardMaterial({ color: '#25282e', roughness: 0.92 }),
    mesh: new THREE.MeshStandardMaterial({ color: '#ffffff', map: meshTexture(), roughness: 0.85 }),
    caster: new THREE.MeshStandardMaterial({ color: '#0f1012', roughness: 0.5 }),
  };
  return shared;
}

export function buildChair() {
  const m = materials();
  const base = new THREE.Group();
  for (let i = 0; i < 5; i++) {
    const a = (i / 5) * Math.PI * 2 + 0.3;
    const leg = mesh(new RoundedBoxGeometry(0.05, 0.03, 0.32, 2, 0.012), m.alu, { shadow: false });
    leg.position.set(Math.sin(a) * 0.16, 0.075, Math.cos(a) * 0.16);
    leg.rotation.y = a;
    leg.rotation.x = 0.1;
    base.add(leg);
    const wheel = mesh(new THREE.CylinderGeometry(0.03, 0.03, 0.025, 14), m.caster, { shadow: false });
    wheel.rotation.z = Math.PI / 2;
    wheel.rotation.y = a;
    wheel.position.set(Math.sin(a) * 0.31, 0.03, Math.cos(a) * 0.31);
    base.add(wheel);
  }
  const hub = mesh(new THREE.CylinderGeometry(0.045, 0.05, 0.05, 16), m.alu, { shadow: false });
  hub.position.y = 0.09;
  base.add(hub);
  const lift = mesh(new THREE.CylinderGeometry(0.022, 0.028, 0.3, 14), m.frame, { shadow: false });
  lift.position.y = 0.26;
  base.add(lift);

  const swivel = new THREE.Group();
  const pan = mesh(new RoundedBoxGeometry(0.34, 0.03, 0.3, 2, 0.01), m.frame);
  pan.position.set(0, 0.405, 0.02);
  swivel.add(pan);
  const seat = mesh(new RoundedBoxGeometry(0.5, 0.07, 0.48, 4, 0.032), m.cushion);
  seat.position.set(0, 0.44, 0);
  swivel.add(seat);

  // Backrest: a bent, mesh-covered panel with a lumbar curve and a frame around it.
  const W = 0.46;
  const H = 0.58;
  const bend = (x, y) => -1.1 * x * x - 0.03 * Math.exp(-((y + 0.12) ** 2) / 0.01) + 0.02 * (y / H);
  const backGeo = new THREE.BoxGeometry(W, H, 0.018, 20, 16, 1);
  const bp = backGeo.attributes.position;
  for (let i = 0; i < bp.count; i++) {
    const x = bp.getX(i);
    const y = bp.getY(i);
    const rx = Math.abs(x) / (W / 2);
    const ry = Math.abs(y) / (H / 2);
    // Rounded-rectangle outline: pinch the corners.
    const corner = Math.max(0, rx - 0.82) * Math.max(0, ry - 0.8) * 25;
    bp.setX(i, x * (1 - 0.08 * corner));
    bp.setZ(i, bp.getZ(i) + bend(x, y));
  }
  backGeo.computeVertexNormals();
  const back = new THREE.Group();
  back.position.set(0, 0.87, 0.25);
  back.rotation.x = 0.12;
  swivel.add(back);
  back.add(mesh(backGeo, [m.frame, m.frame, m.frame, m.frame, m.frame, m.mesh]));
  const rim = [];
  for (let i = 0; i <= 40; i++) {
    const a = (i / 40) * Math.PI * 2;
    const cx = Math.cos(a);
    const cy = Math.sin(a);
    const x = Math.sign(cx) * Math.pow(Math.abs(cx), 0.35) * (W / 2);
    const y = Math.sign(cy) * Math.pow(Math.abs(cy), 0.35) * (H / 2);
    rim.push(new THREE.Vector3(x, y, bend(x, y) - 0.012));
  }
  back.add(mesh(taperedTube(new THREE.CatmullRomCurve3(rim, true), () => 0.012, { tubular: 80, radial: 8 }), m.frame));
  const spine = mesh(new RoundedBoxGeometry(0.07, 0.34, 0.03, 2, 0.012), m.frame);
  spine.position.set(0, 0.6, 0.27);
  spine.rotation.x = 0.1;
  swivel.add(spine);

  for (const s of [-1, 1]) {
    const post = mesh(new RoundedBoxGeometry(0.03, 0.22, 0.05, 2, 0.01), m.frame);
    post.position.set(s * 0.27, 0.54, 0.05);
    swivel.add(post);
    const pad = mesh(new RoundedBoxGeometry(0.075, 0.03, 0.26, 3, 0.012), m.cushion);
    pad.position.set(s * 0.27, 0.66, 0.0);
    swivel.add(pad);
  }
  return { base, swivel };
}
