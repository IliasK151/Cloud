import * as THREE from 'three';
import { RoundedBoxGeometry } from 'three/addons/geometries/RoundedBoxGeometry.js';
import { canvas, texture, taperedTube, mesh, seeded } from './geo.js';

// Seated body: torso (lathe with a painted jacket/shirt/tie), neck, arms built for IK,
// hands with fingers, pelvis and legs. Local space: hips at the origin, facing -Z.

const PROFILES = {
  m: { sx: 1.2, sz: 0.66, pts: [[0.146, -0.05], [0.15, 0.04], [0.152, 0.13], [0.16, 0.22], [0.168, 0.3], [0.17, 0.36], [0.162, 0.405], [0.14, 0.44], [0.105, 0.468], [0.066, 0.486], [0.05, 0.495]] },
  f: { sx: 1.08, sz: 0.68, pts: [[0.15, -0.05], [0.145, 0.04], [0.135, 0.13], [0.145, 0.22], [0.158, 0.29], [0.157, 0.35], [0.148, 0.395], [0.128, 0.43], [0.095, 0.458], [0.058, 0.476], [0.043, 0.485]] },
};

export function torsoProfile(build) {
  return PROFILES[build === 'f' ? 'f' : 'm'];
}

function radiusAt(prof, y) {
  const pts = prof.pts;
  if (y <= pts[0][1]) return pts[0][0];
  for (let i = 1; i < pts.length; i++) {
    if (y <= pts[i][1]) {
      const t = (y - pts[i - 1][1]) / (pts[i][1] - pts[i - 1][1]);
      return pts[i - 1][0] + (pts[i][0] - pts[i - 1][0]) * t;
    }
  }
  return pts[pts.length - 1][0];
}

// v texture coordinate of a height on the lathe (LatheGeometry spaces v by point index).
function vAt(prof, y) {
  const pts = prof.pts;
  if (y <= pts[0][1]) return 0;
  for (let i = 1; i < pts.length; i++) {
    if (y <= pts[i][1]) return (i - 1 + (y - pts[i - 1][1]) / (pts[i][1] - pts[i - 1][1])) / (pts.length - 1);
  }
  return 1;
}

// A point on the torso surface: phi = 0 at the back, π at the front; `off` pushes outward.
export function torsoPoint(prof, phi, y, off = 0, out = new THREE.Vector3()) {
  const r = radiusAt(prof, y);
  const sn = Math.sin(phi);
  const cs = Math.cos(phi);
  const nx = sn / prof.sx;
  const nz = cs / prof.sz;
  const nl = Math.hypot(nx, nz) || 1;
  return out.set(r * sn * prof.sx + (nx / nl) * off, y, r * cs * prof.sz + (nz / nl) * off);
}

function paintTorso(app, prof) {
  const W = 1024;
  const H = 1024;
  const { c, ctx } = canvas(W, H);
  const outfit = app.outfit;
  const jacketLike = outfit === 'suit' || outfit === 'blazer' || outfit === 'vest';
  const base = outfit === 'shirt' ? app.shirt : app.jacket;
  // Map body coordinates (x across the front in metres, y height) to the canvas.
  const toCanvas = (xm, y) => {
    const a = radiusAt(prof, y) * prof.sx;
    const u = 0.5 - xm / (2 * Math.PI * a);
    return [u * W, (1 - vAt(prof, y)) * H];
  };
  const poly = (pts, fill) => {
    ctx.beginPath();
    pts.forEach(([x, y], i) => {
      const [cx, cy] = toCanvas(x, y);
      if (i) ctx.lineTo(cx, cy);
      else ctx.moveTo(cx, cy);
    });
    ctx.closePath();
    ctx.fillStyle = fill;
    ctx.fill();
  };
  const line = (pts, stroke, width) => {
    ctx.beginPath();
    pts.forEach(([x, y], i) => {
      const [cx, cy] = toCanvas(x, y);
      if (i) ctx.lineTo(cx, cy);
      else ctx.moveTo(cx, cy);
    });
    ctx.strokeStyle = stroke;
    ctx.lineWidth = width;
    ctx.stroke();
  };
  const shade = (hex, k) => `#${new THREE.Color(hex).multiplyScalar(k).getHexString()}`;

  // Base fabric with a soft vertical falloff.
  const g = ctx.createLinearGradient(0, 0, 0, H);
  g.addColorStop(0, shade(base, 1.04));
  g.addColorStop(1, shade(base, 0.82));
  ctx.fillStyle = g;
  ctx.fillRect(0, 0, W, H);
  const rnd = seeded(9);
  if (outfit === 'knit' || outfit === 'turtleneck') {
    // Ribbed knit.
    for (let x = 0; x < W; x += 6) {
      ctx.fillStyle = `rgba(0,0,0,${0.05 + rnd() * 0.04})`;
      ctx.fillRect(x, 0, 2, H);
    }
    const [, hemY] = toCanvas(0, 0.02);
    ctx.fillStyle = 'rgba(0,0,0,0.12)';
    ctx.fillRect(0, hemY, W, H - hemY);
  }

  if (jacketLike) {
    const fem = app.build === 'f';
    const vBottom = outfit === 'vest' ? 0.24 : fem ? 0.27 : 0.25;
    const top = 0.492;
    const topW = fem ? 0.06 : 0.058;
    // Opening: shirt (or blouse) visible in the V.
    poly([[-topW, top], [topW, top], [0, vBottom]], app.shirt);
    if (app.neckline) {
      // Open neckline shows skin at the top of a blouse.
      poly([[-0.045, top], [0.045, top], [0, 0.41]], app.skin);
      line([[-0.03, 0.47], [0, 0.428], [0.03, 0.47]], '#c9a45c', 3);
    }
    if (app.tie) {
      poly([[-0.013, 0.482], [0.013, 0.482], [0.009, 0.455], [-0.009, 0.455]], shade(app.tie, 0.9));
      poly([[-0.009, 0.455], [0.009, 0.455], [0.022, 0.24], [0, 0.22], [-0.022, 0.24]], app.tie);
      ctx.save();
      ctx.globalAlpha = 0.18;
      for (let y = 0.25; y < 0.45; y += 0.025) line([[-0.024, y], [0.024, y + 0.018]], '#ffffff', 2);
      ctx.restore();
    } else if (!app.neckline && outfit !== 'vest') {
      line([[0, 0.47], [0, vBottom]], shade(app.shirt, 0.85), 2);
    }
    // Shirt collar points.
    if (!app.neckline) {
      poly([[-topW, top], [-0.012, top], [-0.022, 0.455]], shade(app.shirt, 1.06));
      poly([[topW, top], [0.012, top], [0.022, 0.455]], shade(app.shirt, 1.06));
      line([[-topW, top], [-0.022, 0.455], [-0.012, top]], shade(app.shirt, 0.8), 2);
      line([[topW, top], [0.022, 0.455], [0.012, top]], shade(app.shirt, 0.8), 2);
    }
    if (outfit !== 'vest') {
      // Lapels: a band along each edge of the V with a notch.
      for (const s of [-1, 1]) {
        poly([[s * topW, top], [s * (topW + 0.03), 0.43], [s * (topW + 0.018), 0.418], [s * 0.034, 0.38], [0, vBottom], [s * 0.006, vBottom + 0.02]], shade(base, 0.93));
        line([[s * topW, top], [s * (topW + 0.03), 0.43], [s * (topW + 0.018), 0.418], [s * 0.034, 0.38], [0, vBottom]], shade(base, 1.25), 2.5);
      }
      // Breast pocket (wearer's left).
      line([[-0.105, 0.335], [-0.06, 0.34]], shade(base, 0.7), 3);
      // Hip pockets.
      line([[-0.13, 0.1], [-0.07, 0.1]], shade(base, 0.7), 3);
      line([[0.07, 0.1], [0.13, 0.1]], shade(base, 0.7), 3);
    }
    // Front closure.
    line([[0.004, vBottom], [0.012, -0.05]], shade(base, 0.62), 3);
    // Back seam and side seams.
    ctx.fillStyle = shade(base, 0.8);
    ctx.fillRect(W * 0 - 1, 0, 2, H);
    ctx.fillRect(W - 1, 0, 2, H);
  } else if (outfit === 'shirt') {
    const top = 0.492;
    poly([[-0.05, top], [0.05, top], [0, 0.415]], app.skin);
    line([[0, 0.415], [0, -0.05]], `#${new THREE.Color(app.shirt).multiplyScalar(0.8).getHexString()}`, 3);
    for (let y = 0.36; y > 0; y -= 0.085) {
      const [cx, cy] = toCanvas(0.004, y);
      ctx.fillStyle = '#f4f4f0';
      ctx.beginPath();
      ctx.arc(cx, cy, 4, 0, Math.PI * 2);
      ctx.fill();
    }
    // Collar spread.
    for (const s of [-1, 1]) poly([[s * 0.05, top], [s * 0.014, top], [s * 0.03, 0.45], [s * 0.066, 0.462]], `#${new THREE.Color(app.shirt).multiplyScalar(1.08).getHexString()}`);
  }
  const t = texture(c);
  t.anisotropy = 8;
  return t;
}

export function buildTorso(app, mats) {
  const prof = torsoProfile(app.build);
  const geo = new THREE.LatheGeometry(prof.pts.map(([r, y]) => new THREE.Vector2(r, y)), 48);
  geo.scale(prof.sx, 1, prof.sz);
  geo.computeVertexNormals();
  const mat = mats.torso.clone();
  mat.map = paintTorso(app, prof);
  const torsoMesh = mesh(geo, mat);
  const group = new THREE.Group();
  group.add(torsoMesh);

  const fem = app.build === 'f';
  const shoulderX = fem ? 0.155 : 0.182;
  const shoulderY = fem ? 0.4 : 0.41;
  // Shoulder caps in the sleeve fabric.
  for (const s of [-1, 1]) {
    const cap = mesh(new THREE.SphereGeometry(fem ? 0.05 : 0.06, 20, 14), mats.sleeve);
    cap.position.set(s * shoulderX, shoulderY - 0.005, 0.004);
    cap.scale.set(1.05, 0.95, 1.05);
    group.add(cap);
  }

  const jacketLike = app.outfit === 'suit' || app.outfit === 'blazer' || app.outfit === 'vest';
  // Raised lapel edges and buttons.
  if (jacketLike) {
    const vBottom = app.outfit === 'vest' ? 0.24 : fem ? 0.27 : 0.25;
    const phiAt = (xm, y) => Math.PI - xm / (radiusAt(prof, y) * prof.sx);
    if (app.outfit !== 'vest') {
      for (const s of [-1, 1]) {
        const topW = fem ? 0.06 : 0.058;
        const pts = [[s * topW, 0.49], [s * (topW + 0.03), 0.43], [s * 0.034, 0.38], [0, vBottom]].map(([x, y]) => torsoPoint(prof, phiAt(x, y), y, 0.0035));
        const edge = mesh(taperedTube(new THREE.CatmullRomCurve3(pts), () => 0.0028, { tubular: 20, radial: 6 }), mats.torsoEdge, { shadow: false });
        group.add(edge);
      }
    }
    const buttons = app.outfit === 'vest' ? [0.21, 0.15, 0.09, 0.03] : [0.2, 0.11];
    for (const y of buttons) {
      const b = mesh(new THREE.SphereGeometry(0.0075, 12, 8), mats.button, { shadow: false });
      b.position.copy(torsoPoint(prof, phiAt(0.012, y), y, 0.002));
      b.scale.set(1, 1, 0.45);
      group.add(b);
    }
  }
  // Collar / neckline around the base of the neck.
  const neckR = fem ? 0.04 : 0.047;
  if (app.outfit === 'turtleneck') {
    const roll = mesh(new THREE.CylinderGeometry(neckR + 0.008, neckR + 0.014, 0.06, 24, 1), mats.sleeve);
    roll.position.set(0, 0.512, 0.006);
    group.add(roll);
  } else if (app.outfit === 'knit') {
    const rib = mesh(new THREE.TorusGeometry(neckR + 0.012, 0.009, 8, 28), mats.sleeve);
    rib.rotation.x = Math.PI / 2;
    rib.position.set(0, 0.488, 0.004);
    rib.scale.set(1.12, 0.9, 1);
    group.add(rib);
    if (app.shirt) {
      const collar = mesh(new THREE.CylinderGeometry(neckR + 0.004, neckR + 0.008, 0.03, 24, 1, true, Math.PI * 0.2, Math.PI * 1.6), mats.shirt);
      collar.rotation.y = Math.PI;
      collar.position.set(0, 0.505, 0.004);
      group.add(collar);
    }
  } else if (!app.neckline) {
    const collar = mesh(new THREE.CylinderGeometry(neckR + 0.004, neckR + 0.009, 0.035, 24, 1, true, Math.PI * 0.12, Math.PI * 1.76), mats.shirt);
    collar.rotation.y = Math.PI;
    collar.position.set(0, 0.502, 0.004);
    group.add(collar);
  }

  return { group, shoulderX, shoulderY, prof, neckR };
}

// Upper arm, forearm (with cuff) and hand, arranged for the IK solver in ik.js.
export function buildArm(app, mats, side, shoulderPos) {
  const fem = app.build === 'f';
  const L1 = fem ? 0.26 : 0.28;
  const L2 = fem ? 0.235 : 0.25;
  const shoulder = new THREE.Group();
  shoulder.position.copy(shoulderPos);
  const upper = mesh(new THREE.CapsuleGeometry(fem ? 0.04 : 0.047, L1 - 0.02, 6, 18), mats.sleeve);
  upper.position.y = -L1 / 2;
  shoulder.add(upper);
  const elbow = new THREE.Group();
  elbow.position.y = -L1;
  shoulder.add(elbow);
  const foreR = fem ? 0.036 : 0.042;
  const fore = mesh(new THREE.CylinderGeometry(foreR, foreR * 0.86, L2 - 0.03, 18, 1), mats.sleeve);
  fore.position.y = -(L2 - 0.03) / 2;
  elbow.add(fore);
  const elbowCap = mesh(new THREE.SphereGeometry(foreR * 1.02, 16, 12), mats.sleeve);
  elbow.add(elbowCap);
  const jacketLike = app.outfit === 'suit' || app.outfit === 'blazer';
  if (jacketLike) {
    const cuff = mesh(new THREE.CylinderGeometry(foreR * 0.78, foreR * 0.8, 0.02, 16, 1), mats.shirt);
    cuff.position.y = -L2 + 0.028;
    elbow.add(cuff);
  }
  const wrist = mesh(new THREE.CylinderGeometry(foreR * 0.62, foreR * 0.66, 0.04, 14, 1), mats.skin);
  wrist.position.y = -L2 + 0.008;
  elbow.add(wrist);

  const hand = new THREE.Group();
  hand.position.y = -L2;
  elbow.add(hand);
  const k = fem ? 0.88 : 1;
  const palm = mesh(new RoundedBoxGeometry(0.066 * k, 0.078 * k, 0.024 * k, 3, 0.011 * k), mats.skin);
  palm.position.y = -0.04 * k;
  hand.add(palm);
  const fingers = [];
  const spec = [[0.022, 0.05], [0.0075, 0.056], [-0.0075, 0.053], [-0.022, 0.043]];
  for (const [x, len] of spec) {
    const f = new THREE.Group();
    f.position.set(side * x * k, -0.074 * k, 0);
    const L = len * k;
    const curve = new THREE.CatmullRomCurve3([new THREE.Vector3(0, 0.006, 0), new THREE.Vector3(0, -L * 0.5, -0.004), new THREE.Vector3(0, -L, -0.011)]);
    const r = (fem ? 0.0074 : 0.0085) * k;
    const geo = taperedTube(curve, (t) => r * (1 - 0.18 * t) * Math.min(1, Math.sin(Math.PI * Math.min(1, t * 0.5 + 0.5)) * 4), { tubular: 10, radial: 8 });
    f.add(mesh(geo, mats.skin, { shadow: false }));
    hand.add(f);
    fingers.push(f);
  }
  const thumb = new THREE.Group();
  thumb.position.set(side * 0.03 * k, -0.022 * k, -0.006);
  thumb.rotation.set(0.35, 0, side * 0.75);
  const tc = new THREE.CatmullRomCurve3([new THREE.Vector3(0, 0, 0), new THREE.Vector3(0, -0.024 * k, -0.006), new THREE.Vector3(0, -0.046 * k, -0.012)]);
  thumb.add(mesh(taperedTube(tc, (t) => 0.0098 * k * (1 - 0.2 * t) * Math.min(1, Math.sin(Math.PI * Math.min(1, t * 0.5 + 0.5)) * 4), { tubular: 10, radial: 8 }), mats.skin, { shadow: false }));
  hand.add(thumb);

  return { side, shoulder, elbow, hand, fingers, thumb, L1, L2 };
}

export function buildLegs(app, mats) {
  const g = new THREE.Group();
  const pelvis = mesh(new RoundedBoxGeometry(0.34, 0.15, 0.24, 3, 0.06), mats.trousers);
  pelvis.position.set(0, -0.01, 0.0);
  g.add(pelvis);
  for (const s of [-1, 1]) {
    const thigh = mesh(new THREE.CapsuleGeometry(0.074, 0.38, 6, 16), mats.trousers);
    thigh.rotation.x = Math.PI / 2;
    thigh.position.set(s * 0.095, -0.015, -0.22);
    g.add(thigh);
    const shin = mesh(new THREE.CapsuleGeometry(0.054, 0.4, 6, 14), mats.trousers);
    shin.position.set(s * 0.1, -0.24, -0.44);
    g.add(shin);
    const shoe = mesh(new RoundedBoxGeometry(0.1, 0.075, 0.27, 3, 0.03), mats.shoes);
    shoe.position.set(s * 0.1, -0.52, -0.5);
    g.add(shoe);
  }
  return g;
}
