import * as THREE from 'three';
import { carpetTexture, skylineTexture, woodTexture } from './textures.js';

// Room dimensions (metres). The trading rows face the video wall at -Z.
export const ROOM = { x0: -17, x1: 17, z0: -15, z1: 13, height: 6.5 };
export const PLATFORM = { z0: 0.1, z1: 4.9, height: 0.32 };

const std = (color, opts = {}) => new THREE.MeshStandardMaterial({ color, roughness: 0.8, metalness: 0.02, ...opts });

// Walls and ceiling are single-sided and face inward, so when the camera orbits
// outside the room they disappear (a "cutaway" view of the floor).
export function buildRoom(scene) {
  const W = ROOM.x1 - ROOM.x0;
  const D = ROOM.z1 - ROOM.z0;
  const cx = (ROOM.x0 + ROOM.x1) / 2;
  const cz = (ROOM.z0 + ROOM.z1) / 2;

  const floor = new THREE.Mesh(new THREE.PlaneGeometry(W, D), std('#ffffff', { map: carpetTexture(), roughness: 0.95 }));
  floor.rotation.x = -Math.PI / 2;
  floor.position.set(cx, 0, cz);
  floor.receiveShadow = true;
  scene.add(floor);

  // Raised back row (tiered like a real floor / mission control).
  const wood = woodTexture();
  wood.wrapS = wood.wrapT = THREE.RepeatWrapping;
  wood.repeat.set(8, 2);
  const platform = new THREE.Mesh(
    new THREE.BoxGeometry(W - 3, PLATFORM.height, PLATFORM.z1 - PLATFORM.z0),
    [std('#1a1d24'), std('#1a1d24'), std('#ffffff', { map: wood, roughness: 0.55 }), std('#1a1d24'), std('#1a1d24'), std('#1a1d24')],
  );
  platform.position.set(cx, PLATFORM.height / 2, (PLATFORM.z0 + PLATFORM.z1) / 2);
  platform.receiveShadow = true;
  scene.add(platform);
  const edgeMat = new THREE.MeshStandardMaterial({ color: '#8fc2ff', emissive: '#6aa8ff', emissiveIntensity: 2.2 });
  const edge = new THREE.Mesh(new THREE.BoxGeometry(W - 3, 0.025, 0.03), edgeMat);
  edge.position.set(cx, PLATFORM.height - 0.02, PLATFORM.z0 - 0.005);
  scene.add(edge);

  // LED aisle strips between the desks.
  const stripMat = new THREE.MeshStandardMaterial({ color: '#4d8fe0', emissive: '#3c7fd6', emissiveIntensity: 1.3 });
  for (const x of [-12.5, -7.5, -2.5, 2.5, 7.5, 12.5]) {
    const s = new THREE.Mesh(new THREE.BoxGeometry(0.04, 0.008, 6.5), stripMat);
    s.position.set(x, 0.005, -5.4);
    scene.add(s);
  }

  // Ceiling with light panels (facing down only).
  const ceiling = new THREE.Mesh(new THREE.PlaneGeometry(W, D), std('#0f1218', { side: THREE.FrontSide }));
  ceiling.rotation.x = Math.PI / 2;
  ceiling.position.set(cx, ROOM.height, cz);
  scene.add(ceiling);
  const panelMat = new THREE.MeshBasicMaterial({ color: '#e8f0ff', toneMapped: false });
  const panelGeo = new THREE.PlaneGeometry(3.2, 0.45);
  for (let z = -12; z <= 11; z += 3.3) {
    for (const x of [-11, -5.5, 0, 5.5, 11]) {
      const p = new THREE.Mesh(panelGeo, panelMat);
      p.rotation.x = Math.PI / 2;
      p.position.set(x, ROOM.height - 0.01, z);
      scene.add(p);
    }
  }

  // Walls
  const wallMat = std('#0e1117', { roughness: 0.9 });
  const addWall = (w, h, pos, rotY) => {
    const m = new THREE.Mesh(new THREE.PlaneGeometry(w, h), wallMat);
    m.position.copy(pos);
    m.rotation.y = rotY;
    m.receiveShadow = true;
    scene.add(m);
    return m;
  };
  addWall(W, ROOM.height, new THREE.Vector3(cx, ROOM.height / 2, ROOM.z0), 0); // front (video wall)
  addWall(W, ROOM.height, new THREE.Vector3(cx, ROOM.height / 2, ROOM.z1), Math.PI); // back

  // Side walls: floor-to-ceiling glass with the city at night outside.
  const sky = skylineTexture(5);
  const sky2 = skylineTexture(9);
  for (const side of [-1, 1]) {
    const x = side < 0 ? ROOM.x0 : ROOM.x1;
    const rotY = side < 0 ? Math.PI / 2 : -Math.PI / 2;
    const sill = new THREE.Mesh(new THREE.PlaneGeometry(D, 0.7), wallMat);
    sill.position.set(x, 0.35, cz);
    sill.rotation.y = rotY;
    scene.add(sill);
    const header = new THREE.Mesh(new THREE.PlaneGeometry(D, 0.8), wallMat);
    header.position.set(x, ROOM.height - 0.4, cz);
    header.rotation.y = rotY;
    scene.add(header);
    // City backdrop a little outside the glass for parallax.
    const tex = side < 0 ? sky : sky2;
    tex.wrapS = THREE.RepeatWrapping;
    tex.repeat.set(1.6, 1);
    const city = new THREE.Mesh(new THREE.PlaneGeometry(D + 20, 12), new THREE.MeshBasicMaterial({ map: tex, toneMapped: false, color: '#b8c4dc' }));
    city.position.set(x + side * 6, 3.4, cz);
    city.rotation.y = rotY;
    scene.add(city);
    const glass = new THREE.Mesh(
      new THREE.PlaneGeometry(D, ROOM.height - 1.5),
      new THREE.MeshStandardMaterial({ color: '#1a2438', transparent: true, opacity: 0.18, roughness: 0.05, metalness: 0.9, depthWrite: false }),
    );
    glass.position.set(x, 0.7 + (ROOM.height - 1.5) / 2, cz);
    glass.rotation.y = rotY;
    scene.add(glass);
    // Mullions / pilasters
    const mullionMat = std('#1b1f27', { metalness: 0.5, roughness: 0.4 });
    for (let z = ROOM.z0 + 1.5; z < ROOM.z1; z += 3.5) {
      const m = new THREE.Mesh(new THREE.BoxGeometry(0.12, ROOM.height, 0.12), mullionMat);
      m.position.set(x - side * 0.06, ROOM.height / 2, z);
      scene.add(m);
    }
  }

  // Potted plants in the corners.
  const pot = std('#2a2d33', { roughness: 0.6 });
  const leaf = std('#2f6b3a', { roughness: 0.85 });
  for (const [x, z] of [[-15.5, -13.5], [15.5, -13.5], [-15.5, 11.5], [15.5, 11.5], [-15.5, -1], [15.5, -1]]) {
    const p = new THREE.Mesh(new THREE.CylinderGeometry(0.35, 0.28, 0.7, 16), pot);
    p.position.set(x, 0.35, z);
    p.castShadow = true;
    scene.add(p);
    for (let i = 0; i < 5; i++) {
      const f = new THREE.Mesh(new THREE.ConeGeometry(0.35 - i * 0.04, 0.9, 8), leaf);
      f.position.set(x + Math.sin(i * 2.1) * 0.08, 0.95 + i * 0.28, z + Math.cos(i * 2.1) * 0.08);
      f.castShadow = true;
      scene.add(f);
    }
  }

  // Lighting
  scene.add(new THREE.HemisphereLight(0xdde7ff, 0x1a1d24, 1.1));
  const key = new THREE.DirectionalLight(0xffffff, 1.6);
  key.position.set(7, 16, 9);
  key.castShadow = true;
  key.shadow.mapSize.set(2048, 2048);
  key.shadow.camera.left = -19;
  key.shadow.camera.right = 19;
  key.shadow.camera.top = 16;
  key.shadow.camera.bottom = -16;
  key.shadow.camera.near = 1;
  key.shadow.camera.far = 40;
  key.shadow.bias = -0.0004;
  key.shadow.normalBias = 0.02;
  key.target.position.set(0, 0, -2);
  scene.add(key);
  scene.add(key.target);
  const fill = new THREE.DirectionalLight(0x8fb2ff, 0.35);
  fill.position.set(-10, 8, -6);
  scene.add(fill);
  const wallWash = new THREE.PointLight(0x5c8fe6, 2.5, 18, 2);
  wallWash.position.set(0, 3, -11);
  scene.add(wallWash);

  return { floor, platform };
}
