import * as THREE from 'three';
import { RoundedBoxGeometry } from 'three/addons/geometries/RoundedBoxGeometry.js';
import { RectAreaLightUniformsLib } from 'three/addons/lights/RectAreaLightUniformsLib.js';
import { floorTexture, rugTexture, skylineTexture, canvasTexture } from './textures.js';

// Room dimensions (metres). The trading rows face the video wall at -Z.
export const ROOM = { x0: -17, x1: 17, z0: -15, z1: 17, height: 6.5 };
export const PLATFORM = { z0: 0.1, z1: 4.9, height: 0.32 };
// The Quant Research Lab: a third, higher tier behind the trading rows.
export const LAB = { z0: 6.3, z1: 11.5, height: 0.64 };
export const DESK_XS = [-10, -5, 0, 5, 10];
export const FRONT_ROW_Z = -5.4;
export const BACK_ROW_Z = 1.9;
export const LAB_ROW_Z = 8.4;

const std = (color, o = {}) => new THREE.MeshStandardMaterial({ color, roughness: 0.8, metalness: 0.02, ...o });

// A calm, architectural floor: polished concrete, walnut slat walls, glass to the city at
// dusk, linear pendants over every desk. Walls and ceiling are single-sided and face
// inward, so orbiting outside the room gives a cutaway view.
export function buildRoom(scene) {
  const W = ROOM.x1 - ROOM.x0;
  const D = ROOM.z1 - ROOM.z0;
  const cx = (ROOM.x0 + ROOM.x1) / 2;
  const cz = (ROOM.z0 + ROOM.z1) / 2;
  const dynamic = { pendants: [] };

  // --- floor and rugs ---
  const floorMat = new THREE.MeshPhysicalMaterial({ color: '#4a4a4c', map: floorTexture(), roughness: 0.42, clearcoat: 0.35, clearcoatRoughness: 0.35 });
  const floor = new THREE.Mesh(new THREE.PlaneGeometry(W, D), floorMat);
  floor.rotation.x = -Math.PI / 2;
  floor.position.set(cx, 0, cz);
  floor.receiveShadow = true;
  scene.add(floor);
  const rugMat = std('#34363b', { map: rugTexture(), roughness: 0.97 });
  const rug = (z0, z1, y) => {
    const m = new THREE.Mesh(new RoundedBoxGeometry(26.5, 0.012, z1 - z0, 2, 0.005), rugMat);
    m.position.set(0, y + 0.006, (z0 + z1) / 2);
    m.receiveShadow = true;
    scene.add(m);
  };
  rug(FRONT_ROW_Z - 1.3, FRONT_ROW_Z + 2.2, 0);

  // --- raised back row ---
  const platMat = new THREE.MeshPhysicalMaterial({ color: '#4a4a4c', map: floorTexture(), roughness: 0.42, clearcoat: 0.35, clearcoatRoughness: 0.35 });
  const plat = new THREE.Mesh(new THREE.BoxGeometry(W - 3, PLATFORM.height, PLATFORM.z1 - PLATFORM.z0), platMat);
  plat.position.set(cx, PLATFORM.height / 2, (PLATFORM.z0 + PLATFORM.z1) / 2);
  plat.receiveShadow = plat.castShadow = true;
  scene.add(plat);
  rug(PLATFORM.z0 + 0.35, PLATFORM.z1 - 0.2, PLATFORM.height);
  const walnut = std('#5a3a26', { roughness: 0.55 });
  const nosing = new THREE.Mesh(new RoundedBoxGeometry(W - 3, 0.06, 0.08, 2, 0.02), walnut);
  nosing.position.set(cx, PLATFORM.height - 0.03, PLATFORM.z0 - 0.02);
  scene.add(nosing);
  const stepLight = new THREE.Mesh(new THREE.BoxGeometry(W - 3.2, 0.012, 0.01), new THREE.MeshBasicMaterial({ color: '#ffd9a8', toneMapped: false }));
  stepLight.position.set(cx, PLATFORM.height - 0.07, PLATFORM.z0 - 0.045);
  scene.add(stepLight);

  // --- research lab tier: higher again, set off by a low glass balustrade and teal light ---
  const lab = new THREE.Mesh(new THREE.BoxGeometry(W - 3, LAB.height, LAB.z1 - LAB.z0), platMat);
  lab.position.set(cx, LAB.height / 2, (LAB.z0 + LAB.z1) / 2);
  lab.receiveShadow = lab.castShadow = true;
  scene.add(lab);
  rug(LAB.z0 + 0.45, LAB.z1 - 0.3, LAB.height);
  const labNosing = new THREE.Mesh(new RoundedBoxGeometry(W - 3, 0.06, 0.08, 2, 0.02), walnut);
  labNosing.position.set(cx, LAB.height - 0.03, LAB.z0 - 0.02);
  scene.add(labNosing);
  const labLight = new THREE.Mesh(new THREE.BoxGeometry(W - 3.2, 0.012, 0.01), new THREE.MeshBasicMaterial({ color: '#7fe6d6', toneMapped: false }));
  labLight.position.set(cx, LAB.height - 0.07, LAB.z0 - 0.045);
  scene.add(labLight);
  const glassMat = new THREE.MeshPhysicalMaterial({ color: '#9fd6cf', transparent: true, opacity: 0.1, roughness: 0.05, metalness: 0, clearcoat: 1, depthWrite: false, side: THREE.DoubleSide });
  const railMat = std('#1b1c1f', { metalness: 0.7, roughness: 0.3 });
  const balustrade = new THREE.Mesh(new THREE.PlaneGeometry(W - 3.4, 0.9), glassMat);
  balustrade.position.set(cx, LAB.height + 0.45, LAB.z0 + 0.12);
  scene.add(balustrade);
  const rail = new THREE.Mesh(new RoundedBoxGeometry(W - 3.4, 0.035, 0.05, 2, 0.012), railMat);
  rail.position.set(cx, LAB.height + 0.92, LAB.z0 + 0.12);
  scene.add(rail);
  for (let x = ROOM.x0 + 1.8; x <= ROOM.x1 - 1.8; x += 3.8) {
    const post = new THREE.Mesh(new THREE.BoxGeometry(0.03, 0.9, 0.03), railMat);
    post.position.set(x, LAB.height + 0.45, LAB.z0 + 0.12);
    scene.add(post);
  }
  // Etched into the glass, facing the room: the lab's name.
  const sign = canvasTexture(1024, 96);
  sign.ctx.clearRect(0, 0, 1024, 96);
  sign.ctx.font = '700 58px -apple-system, "Helvetica Neue", Arial, sans-serif';
  sign.ctx.textAlign = 'center';
  sign.ctx.textBaseline = 'middle';
  sign.ctx.fillStyle = '#8ff0e0';
  if ('letterSpacing' in sign.ctx) sign.ctx.letterSpacing = '14px';
  sign.ctx.fillText('QUANT RESEARCH LAB', 512, 50);
  sign.texture.needsUpdate = true;
  const signMesh = new THREE.Mesh(new THREE.PlaneGeometry(3.6, 0.34), new THREE.MeshBasicMaterial({ map: sign.texture, transparent: true, opacity: 0.85, toneMapped: false, depthWrite: false }));
  signMesh.position.set(-2.5, LAB.height + 0.52, LAB.z0 + 0.14);
  scene.add(signMesh);

  // --- walls ---
  const plaster = std('#1e1f23', { roughness: 0.92 });
  const addWall = (w, h, pos, rotY, mat = plaster) => {
    const m = new THREE.Mesh(new THREE.PlaneGeometry(w, h), mat);
    m.position.copy(pos);
    m.rotation.y = rotY;
    m.receiveShadow = true;
    scene.add(m);
    return m;
  };
  addWall(W, ROOM.height, new THREE.Vector3(cx, ROOM.height / 2, ROOM.z0), 0);
  addWall(W, ROOM.height, new THREE.Vector3(cx, ROOM.height / 2, ROOM.z1), Math.PI);

  // Walnut slat feature wall behind the video wall (instanced).
  const slatW = 0.045;
  const gap = 0.1;
  const span = 24;
  const count = Math.floor(span / gap);
  const slats = new THREE.InstancedMesh(new THREE.BoxGeometry(slatW, ROOM.height, 0.04), walnut, count);
  const mtx = new THREE.Matrix4();
  for (let i = 0; i < count; i++) {
    mtx.makeTranslation(-span / 2 + i * gap, ROOM.height / 2, ROOM.z0 + 0.03);
    slats.setMatrixAt(i, mtx);
  }
  slats.receiveShadow = true;
  scene.add(slats);
  const backing = addWall(span + 0.2, ROOM.height, new THREE.Vector3(0, ROOM.height / 2, ROOM.z0 + 0.005), 0, std('#0e0e10', { roughness: 1 }));
  backing.receiveShadow = false;
  // Side walls: floor-to-ceiling glass with the city at dusk outside.
  const sky = skylineTexture(5);
  const sky2 = skylineTexture(9);
  const mullionMat = std('#141518', { metalness: 0.6, roughness: 0.35 });
  for (const side of [-1, 1]) {
    const x = side < 0 ? ROOM.x0 : ROOM.x1;
    const rotY = side < 0 ? Math.PI / 2 : -Math.PI / 2;
    const sill = new THREE.Mesh(new THREE.PlaneGeometry(D, 0.45), plaster);
    sill.position.set(x, 0.225, cz);
    sill.rotation.y = rotY;
    scene.add(sill);
    const header = new THREE.Mesh(new THREE.PlaneGeometry(D, 0.6), plaster);
    header.position.set(x, ROOM.height - 0.3, cz);
    header.rotation.y = rotY;
    scene.add(header);
    const tex = side < 0 ? sky : sky2;
    tex.wrapS = THREE.RepeatWrapping;
    tex.repeat.set(1.5, 1);
    const city = new THREE.Mesh(new THREE.PlaneGeometry(D + 30, 16), new THREE.MeshBasicMaterial({ map: tex, toneMapped: false, color: '#c9cfdc', fog: false }));
    city.position.set(x + side * 8, 4.2, cz);
    city.rotation.y = rotY;
    scene.add(city);
    const glass = new THREE.Mesh(
      new THREE.PlaneGeometry(D, ROOM.height - 1.05),
      new THREE.MeshPhysicalMaterial({ color: '#20283a', transparent: true, opacity: 0.12, roughness: 0.05, metalness: 0, clearcoat: 1, depthWrite: false }),
    );
    glass.position.set(x, 0.45 + (ROOM.height - 1.05) / 2, cz);
    glass.rotation.y = rotY;
    scene.add(glass);
    for (let z = ROOM.z0 + 2; z < ROOM.z1; z += 2.8) {
      const m = new THREE.Mesh(new THREE.BoxGeometry(0.06, ROOM.height, 0.06), mullionMat);
      m.position.set(x - side * 0.03, ROOM.height / 2, z);
      scene.add(m);
    }
    const transom = new THREE.Mesh(new THREE.BoxGeometry(0.05, 0.05, D), mullionMat);
    transom.position.set(x - side * 0.03, 0.47, cz);
    scene.add(transom);
  }

  // --- ceiling and linear pendants over every desk ---
  const ceiling = new THREE.Mesh(new THREE.PlaneGeometry(W, D), std('#131417', { roughness: 0.95 }));
  ceiling.rotation.x = Math.PI / 2;
  ceiling.position.set(cx, ROOM.height, cz);
  scene.add(ceiling);
  const pendantBody = std('#1b1c1f', { roughness: 0.4, metalness: 0.5 });
  const pendantGlow = new THREE.MeshBasicMaterial({ color: '#fff3e2', toneMapped: false });
  const wire = std('#555', { metalness: 0.6 });
  for (const [z, y0] of [[FRONT_ROW_Z + 0.2, 0], [BACK_ROW_Z + 0.2, PLATFORM.height], [LAB_ROW_Z + 0.2, LAB.height]]) {
    for (const x of DESK_XS) {
      const body = new THREE.Mesh(new RoundedBoxGeometry(2.4, 0.045, 0.09, 2, 0.015), pendantBody);
      body.position.set(x, y0 + 3.4, z);
      scene.add(body);
      const glow = new THREE.Mesh(new THREE.PlaneGeometry(2.34, 0.05), pendantGlow);
      glow.rotation.x = Math.PI / 2;
      glow.position.set(x, y0 + 3.377, z);
      scene.add(glow);
      for (const s of [-1, 1]) {
        const w = new THREE.Mesh(new THREE.CylinderGeometry(0.003, 0.003, ROOM.height - y0 - 3.4, 4), wire);
        w.position.set(x + s * 1.0, (ROOM.height + y0 + 3.4) / 2, z);
        scene.add(w);
      }
    }
  }

  // --- olive trees by the windows ---
  const planterMat = std('#2a2b2f', { roughness: 0.55 });
  const trunkMat = std('#4a3a2c', { roughness: 0.9 });
  const leafMats = [std('#62734f', { roughness: 0.75, flatShading: true }), std('#768a5e', { roughness: 0.75, flatShading: true })];
  const leafGeo = new THREE.IcosahedronGeometry(0.16, 0);
  let seed = 3;
  const rnd = () => ((seed = (seed * 16807) % 2147483647) / 2147483647);
  for (const [x, z] of [[-15.6, -12.6], [15.6, -12.6], [-15.6, -1.4], [15.6, -1.4], [-15.6, 14.4], [15.6, 14.4]]) {
    const planter = new THREE.Mesh(new RoundedBoxGeometry(0.9, 0.7, 0.9, 3, 0.05), planterMat);
    planter.position.set(x, 0.35, z);
    planter.castShadow = planter.receiveShadow = true;
    scene.add(planter);
    const trunkCurve = new THREE.CatmullRomCurve3([new THREE.Vector3(x, 0.65, z), new THREE.Vector3(x + 0.08, 1.3, z - 0.05), new THREE.Vector3(x - 0.05, 2.0, z + 0.06), new THREE.Vector3(x + 0.04, 2.5, z)]);
    const trunk = new THREE.Mesh(new THREE.TubeGeometry(trunkCurve, 16, 0.045, 8), trunkMat);
    trunk.castShadow = true;
    scene.add(trunk);
    for (const mat of leafMats) {
      const n = 26;
      const leaves = new THREE.InstancedMesh(leafGeo, mat, n);
      const q = new THREE.Quaternion();
      const sc = new THREE.Vector3();
      const p = new THREE.Vector3();
      for (let i = 0; i < n; i++) {
        const a = rnd() * Math.PI * 2;
        const r = Math.sqrt(rnd()) * 0.7;
        p.set(x + Math.cos(a) * r, 2.35 + rnd() * 0.75 - r * 0.35, z + Math.sin(a) * r);
        q.setFromEuler(new THREE.Euler(rnd() * 3, rnd() * 3, rnd() * 3));
        const k = 0.7 + rnd() * 0.8;
        sc.set(k, k * 0.8, k);
        leaves.setMatrixAt(i, new THREE.Matrix4().compose(p, q, sc));
      }
      leaves.castShadow = true;
      scene.add(leaves);
    }
  }

  // --- lighting ---
  scene.add(new THREE.HemisphereLight(0xf1ede6, 0x24252a, 0.9));
  const key = new THREE.DirectionalLight(0xfff0de, 1.7);
  key.position.set(6, 16, 9);
  key.castShadow = true;
  key.shadow.mapSize.set(2048, 2048);
  key.shadow.camera.left = -19;
  key.shadow.camera.right = 19;
  key.shadow.camera.top = 19;
  key.shadow.camera.bottom = -19;
  key.shadow.camera.near = 1;
  key.shadow.camera.far = 40;
  key.shadow.bias = -0.0004;
  key.shadow.normalBias = 0.02;
  key.shadow.radius = 3;
  key.target.position.set(0, 0, -2);
  scene.add(key, key.target);
  for (const side of [-1, 1]) {
    const dusk = new THREE.DirectionalLight(0x9fb3d6, 0.22);
    dusk.position.set(side * 20, 5, -2);
    scene.add(dusk);
  }
  // Soft light from the pendants onto each row.
  RectAreaLightUniformsLib.init();
  for (const [z, y0] of [[FRONT_ROW_Z + 0.4, 0], [BACK_ROW_Z + 0.4, PLATFORM.height], [LAB_ROW_Z + 0.4, LAB.height]]) {
    const area = new THREE.RectAreaLight(0xfff1dc, 0.55, 24, 1.6);
    area.position.set(0, y0 + 3.36, z);
    area.lookAt(0, y0, z);
    scene.add(area);
  }
  // Warm wash grazing the slat wall.
  for (const x of [-8, 0, 8]) {
    const spot = new THREE.SpotLight(0xffd6a8, 26, 9, 0.55, 0.9, 1.6);
    spot.position.set(x, ROOM.height - 0.2, ROOM.z0 + 1.2);
    spot.target.position.set(x, 1.5, ROOM.z0);
    scene.add(spot, spot.target);
  }

  return { floor, platform: plat, dynamic };
}
