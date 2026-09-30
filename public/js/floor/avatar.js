import * as THREE from 'three';
import { buildHead } from './avatar/head.js';
import { buildHair } from './avatar/hair.js';
import { buildTorso, buildArm, buildLegs } from './avatar/body.js';
import { buildChair } from './avatar/chair.js';
import { buildGlasses, buildHeadset } from './avatar/accessories.js';
import { solveArm } from './avatar/ik.js';
import { strandTexture, weaveTexture, mixColor, darken, mesh } from './avatar/geo.js';

// A seated trader at their desk: a stylised human with a swivel chair and a small
// procedural animation system — typing, mousing, reading, sipping coffee, taking calls,
// blinking and glancing between screens, reacting to P&L, and turning round to greet
// and talk to the boss with lip sync. Local space: the trader faces -Z (the monitors).

const damp = (cur, target, lambda, dt) => THREE.MathUtils.lerp(cur, target, 1 - Math.exp(-lambda * dt));
const v3 = (x, y, z) => new THREE.Vector3(x, y, z);

// Points of interest in the avatar's root (chair) space, matching desk.js.
const SCREENS = [v3(-0.66, 1.06, -0.98), v3(0, 1.06, -1.1), v3(0.66, 1.06, -0.98), v3(-0.66, 1.47, -1.02), v3(0, 1.47, -1.14), v3(0.66, 1.47, -1.02)];
const KEYBOARD = v3(0.05, 0.78, -0.5);
const MUG_SPOT = v3(0.72, 0.766, -0.42);

const HEAD_IN_TORSO = v3(0, 0.645, -0.012);

function makeMaterials(app, accent) {
  const skin = new THREE.Color(app.skin);
  const phys = (o) => new THREE.MeshPhysicalMaterial(o);
  const fabric = (color, extra = {}) => phys({ color, roughness: 0.82, sheen: 0.5, sheenRoughness: 0.6, sheenColor: mixColor(color, '#ffffff', 0.35), bumpMap: weaveTexture(), bumpScale: 0.35, ...extra });
  const sleeveColor = app.outfit === 'shirt' || app.outfit === 'vest' ? app.shirt : app.jacket;
  const hairLum = new THREE.Color(app.hair).getHSL({}).l;
  const hairColor = app.hairStyle === 'buzz' ? mixColor(app.hair, app.skin, 0.35) : new THREE.Color(app.hair);
  const hair = phys({ color: hairColor, map: strandTexture(), bumpMap: strandTexture(), bumpScale: 0.5, roughness: 0.62, sheen: 0.35 + hairLum * 0.6, sheenRoughness: 0.4, sheenColor: mixColor(app.hair, '#ffffff', 0.12 + hairLum * 0.3) });
  hair.userData.tieMat = new THREE.MeshStandardMaterial({ color: '#111', roughness: 0.4 });
  return {
    face: phys({ color: '#ffffff', vertexColors: true, roughness: 0.52, sheen: 0.35, sheenRoughness: 0.45, sheenColor: '#ff9f8c' }),
    skin: phys({ color: skin, roughness: 0.52, sheen: 0.35, sheenRoughness: 0.45, sheenColor: '#ff9f8c' }),
    skinDeep: new THREE.MeshStandardMaterial({ color: darken(skin, 0.72), roughness: 0.6 }),
    lid: phys({ color: darken(skin, 0.93), roughness: 0.5, sheen: 0.3, sheenColor: '#ff9f8c' }),
    lash: new THREE.MeshStandardMaterial({ color: '#16100c', roughness: 0.6 }),
    brow: new THREE.MeshStandardMaterial({ color: darken(app.hair, app.hair === '#9a9a9a' ? 0.8 : 0.85), roughness: 0.8 }),
    sclera: phys({ color: '#f1eee8', roughness: 0.18, clearcoat: 1, clearcoatRoughness: 0.05 }),
    glint: new THREE.MeshBasicMaterial({ color: '#ffffff', transparent: true, opacity: 0.85 }),
    lips: phys({ color: app.lips || mixColor(darken(skin, 0.82), '#a4494e', app.build === 'f' ? 0.4 : 0.22), roughness: 0.38, sheen: 0.4, sheenColor: '#ffb0a8', clearcoat: app.build === 'f' ? 0.4 : 0.1 }),
    mouth: new THREE.MeshStandardMaterial({ color: '#34110f', roughness: 0.8 }),
    teeth: new THREE.MeshStandardMaterial({ color: '#efe9dc', roughness: 0.35 }),
    nostril: new THREE.MeshStandardMaterial({ color: darken(skin, 0.45), roughness: 0.9 }),
    hair,
    torso: fabric('#ffffff'),
    torsoEdge: fabric(mixColor(app.jacket, '#ffffff', 0.06)),
    sleeve: fabric(sleeveColor),
    shirt: fabric(app.shirt || '#f2f2f2', { bumpScale: 0.15 }),
    button: new THREE.MeshStandardMaterial({ color: '#1b1917', roughness: 0.35 }),
    trousers: fabric(app.trousers || (app.outfit === 'suit' ? app.jacket : '#24272d')),
    shoes: new THREE.MeshStandardMaterial({ color: '#141414', roughness: 0.32, metalness: 0.1 }),
    accent,
  };
}

function buildMug(color) {
  const g = new THREE.Group();
  const ceramic = new THREE.MeshStandardMaterial({ color, roughness: 0.35 });
  const cup = mesh(new THREE.CylinderGeometry(0.037, 0.033, 0.095, 20, 1, true), ceramic);
  cup.material = ceramic.clone();
  cup.material.side = THREE.DoubleSide;
  cup.position.y = 0.0475;
  g.add(cup);
  const bottom = mesh(new THREE.CircleGeometry(0.033, 20), ceramic);
  bottom.rotation.x = -Math.PI / 2;
  bottom.position.y = 0.002;
  g.add(bottom);
  const coffee = new THREE.Mesh(new THREE.CircleGeometry(0.035, 20), new THREE.MeshStandardMaterial({ color: '#2b1a10', roughness: 0.2 }));
  coffee.rotation.x = -Math.PI / 2;
  coffee.position.y = 0.08;
  g.add(coffee);
  const handle = mesh(new THREE.TorusGeometry(0.022, 0.006, 8, 16, Math.PI * 1.2), ceramic);
  handle.position.set(0.038, 0.05, 0);
  handle.rotation.z = -Math.PI * 0.6;
  g.add(handle);
  return g;
}

export class Avatar {
  constructor(profile, index = 0) {
    const app = { build: profile.gender === 'female' ? 'f' : 'm', ...profile.appearance };
    this.profile = profile;
    this.index = index;
    this.app = app;
    this.root = new THREE.Group();
    const mats = makeMaterials(app, profile.accent);
    this.mats = mats;

    const chair = buildChair();
    this.root.add(chair.base);
    this.swivel = chair.swivel;
    this.root.add(this.swivel);

    // Body pivots at the hips so leaning looks natural.
    this.body = new THREE.Group();
    this.body.position.set(0, 0.56, 0.02);
    this.swivel.add(this.body);
    this.body.add(buildLegs(app, mats));

    const torso = buildTorso(app, mats);
    this.torso = torso.group;
    this.body.add(this.torso);

    // Neck and head
    this.neck = new THREE.Group();
    this.neck.position.set(0, 0.485, 0.004);
    this.torso.add(this.neck);
    const neckMesh = mesh(new THREE.CylinderGeometry(torso.neckR * 0.9, torso.neckR, 0.13, 20), mats.skin);
    neckMesh.position.y = 0.055;
    this.neck.add(neckMesh);
    this.headPivot = new THREE.Group();
    this.headPivot.position.set(0, 0.1, -0.006);
    this.neck.add(this.headPivot);
    this.head = new THREE.Group();
    this.head.position.set(0, 0.06, -0.01);
    this.head.scale.setScalar(1.1);
    this.headPivot.add(this.head);
    const head = buildHead(app, mats);
    this.face = head;
    this.head.add(head.group);
    const hair = buildHair(app.hairStyle, head.shape, mats.hair);
    this.head.add(hair);
    if (app.glasses) this.head.add(buildGlasses(head, typeof app.glasses === 'string' ? app.glasses : undefined));
    if (app.headset) this.head.add(buildHeadset(head, app.hairStyle === 'buzz' ? 0.004 : app.hairStyle === 'bob' || app.hairStyle === 'side' || app.hairStyle === 'textured' ? 0.018 : 0.011, profile.accent));

    // Arms
    this.arms = [-1, 1].map((s) => {
      const arm = buildArm(app, mats, s, v3(s * torso.shoulderX, torso.shoulderY, 0.004));
      this.torso.add(arm.shoulder);
      return arm;
    });

    // Coffee mug that lives on the desk and travels with the hand when sipping.
    this.mug = buildMug(index % 2 ? '#f2f1ee' : '#1d1f24');
    this.mug.position.copy(MUG_SPOT);
    this.root.add(this.mug);

    // Animation state
    this.t = Math.random() * 100;
    this.mood = 'focused';
    this.status = 'SCANNING';
    this.mode = 'work'; // work | greet
    this.faceAngle = 0;
    this.greetStart = 0;
    this.celebrateUntil = 0;
    this.activity = { kind: 'type', until: 0, start: 0 };
    this.gaze = { target: SCREENS[1].clone(), next: 0 };
    this.lookWorld = null; // camera position while greeting
    this.blink = { next: 1 + Math.random() * 3, t: -1 };
    this.speech = 0; // 0..1 mouth opening from the voice
    this.speaking = false;
    this.cur = { lean: 0.1, swivel: 0, yaw: 0, pitch: 0, eyeYaw: 0, eyePitch: 0, smile: 0, open: 0, brow: 0, lid: 0 };
    this.hands = [0, 1].map(() => ({ pos: v3(0, 0.3, -0.3), fingers: v3(0, -0.3, -1), palm: v3(0, -1, 0) }));
    this.gesture = { next: 0, a: v3(), b: v3() };

    // Scratch objects
    this._m = new THREE.Matrix4();
    this._r = new THREE.Matrix3();
    this._ri = new THREE.Matrix3();
    this._v = new THREE.Vector3();
    this._t = [v3(), v3()];
    this._f = [v3(), v3()];
    this._p = [v3(), v3()];
    this.root.updateMatrixWorld(true);
  }

  setState({ mood, status }) {
    if (mood && mood !== this.mood) {
      if (mood === 'celebrating') this.celebrateUntil = this.t + 3.5;
      this.mood = mood;
    }
    if (status) this.status = status;
  }

  // Turn toward a point in the avatar's parent (desk) space, wave and look at it.
  greet(localTarget) {
    const chairPos = this.root.position;
    this.faceAngle = Math.atan2(-(localTarget.x - chairPos.x), -(localTarget.z - chairPos.z));
    if (this.mode !== 'greet') this.greetStart = this.t;
    this.mode = 'greet';
    this.#dropMug();
  }

  backToWork() {
    this.mode = 'work';
    this.lookWorld = null;
    this.speaking = false;
    this.speech = 0;
    this.activity.until = 0;
  }

  // World-space point to look at while greeting (usually the camera).
  lookAt(worldPos) {
    this.lookWorld = worldPos ? (this.lookWorld || v3()).copy(worldPos) : null;
  }

  headWorldPosition(target = new THREE.Vector3()) {
    return this.head.getWorldPosition(target);
  }

  #dropMug() {
    if (this.mug.parent !== this.root) {
      this.root.attach(this.mug);
      this.mug.position.copy(MUG_SPOT);
      this.mug.rotation.set(0, 0, 0);
    }
  }

  #pickActivity() {
    const busy = this.status === 'IN TRADE' || this.status === 'ARMED' || this.status === 'RESEARCHING';
    const options = busy
      ? [['type', 4], ['mouse', 5], ['read', 1.2], ['think', 0.6], ['call', this.app.headset ? 1.5 : 0], ['sip', 0.6]]
      : [['type', 3], ['mouse', 3], ['read', 2], ['think', 1.2], ['call', this.app.headset ? 0.8 : 0], ['sip', 1.2]];
    const total = options.reduce((s, o) => s + o[1], 0);
    let r = Math.random() * total;
    let kind = 'type';
    for (const [k, w] of options) {
      r -= w;
      if (r <= 0) { kind = k; break; }
    }
    if (kind === this.activity.kind && kind === 'sip') kind = 'type';
    const len = kind === 'sip' ? 5.2 : kind === 'call' ? 6 + Math.random() * 6 : 4 + Math.random() * 7;
    this.activity = { kind, start: this.t, until: this.t + len };
  }

  update(dt) {
    this.t += dt;
    const t = this.t;
    const greeting = this.mode === 'greet';
    if (!greeting && t > this.activity.until) {
      this.#dropMug();
      this.#pickActivity();
    }
    const act = greeting ? 'greet' : this.activity.kind;
    const since = t - (greeting ? this.greetStart : this.activity.start);
    const celebrating = !greeting && t < this.celebrateUntil;

    // ---- targets ------------------------------------------------------------------------
    let swivel = Math.sin(t * 0.13 + this.index) * 0.05;
    let lean = 0.1;
    let smile = 0.08;
    let brow = 0;
    const L = { space: 'root', pos: v3(-0.13, 0.8, -0.37), fingers: v3(0.05, -0.3, -1), palm: v3(0, -1, 0.15), curl: 0.55, type: 0 };
    const R = { space: 'root', pos: v3(0.15, 0.8, -0.37), fingers: v3(-0.05, -0.3, -1), palm: v3(0, -1, 0.15), curl: 0.55, type: 0 };
    let gazeRoot = null;

    if (greeting) {
      swivel = this.faceAngle;
      lean = -0.02;
      smile = this.speaking ? 0.35 : 0.55;
      brow = since < 2 ? 1 : 0.3;
      const waving = since > 0.5 && since < 3.2;
      L.space = R.space = 'torso';
      L.pos.set(-0.2, 0.2, -0.18);
      L.fingers.set(0.4, -0.2, -1);
      L.palm.set(0.2, -1, 0);
      L.curl = 0.35;
      R.pos.set(0.2, 0.2, -0.18);
      R.fingers.set(-0.4, -0.2, -1);
      R.palm.set(-0.2, -1, 0);
      R.curl = 0.35;
      if (waving) {
        const w = Math.sin((since - 0.5) * 11);
        R.pos.set(0.27 + w * 0.035, 0.66, -0.1);
        R.fingers.set(w * 0.25, 1, -0.15);
        R.palm.set(0, 0.1, -1);
        R.curl = 0.1;
      } else if (this.speaking || since > 3.2) {
        // Talking gestures: hands drift in front of the body with the rhythm of speech.
        if (t > this.gesture.next) {
          this.gesture.next = t + 1.2 + Math.random() * 1.8;
          this.gesture.a.set(-0.13 - Math.random() * 0.08, 0.24 + Math.random() * 0.1, -0.24 - Math.random() * 0.08);
          this.gesture.b.set(0.13 + Math.random() * 0.08, 0.24 + Math.random() * 0.1, -0.24 - Math.random() * 0.08);
        }
        const k = this.speaking ? 1 : 0.4;
        const beat = this.speaking ? this.speech * 0.03 : 0;
        L.pos.lerp(this.gesture.a, k).y += beat;
        R.pos.lerp(this.gesture.b, k).y += beat * 0.7;
        L.fingers.set(0.6, 0.1, -1);
        L.palm.set(0.5, 0.6, -0.2);
        R.fingers.set(-0.6, 0.1, -1);
        R.palm.set(-0.5, 0.6, -0.2);
      }
    } else if (celebrating) {
      const pump = Math.sin(t * 9) * 0.05;
      L.space = R.space = 'torso';
      L.pos.set(-0.24, 0.9 + pump, -0.05);
      R.pos.set(0.24, 0.9 - pump, -0.05);
      L.fingers.set(0, 1, 0);
      R.fingers.set(0, 1, 0);
      L.palm.set(0, 0, -1);
      R.palm.set(0, 0, -1);
      L.curl = R.curl = 1.3;
      lean = -0.15;
      smile = 1;
      brow = 1;
      swivel = Math.sin(t * 3) * 0.25;
      gazeRoot = SCREENS[4];
    } else {
      switch (act) {
        case 'type':
          L.type = R.type = 1;
          break;
        case 'mouse': {
          const wig = Math.sin(t * 1.7) * 0.02;
          R.pos.set(0.4 + wig, 0.795, -0.37 + Math.sin(t * 1.1) * 0.015);
          R.fingers.set(0, -0.35, -1);
          R.curl = 0.35;
          L.pos.set(-0.1, 0.795, -0.36);
          L.type = Math.sin(t * 0.7) > 0.6 ? 0.6 : 0;
          break;
        }
        case 'read':
          // Sit back and read the top screens, forearms resting on the desk edge.
          lean = -0.06;
          L.pos.set(-0.2, 0.79, -0.24);
          L.fingers.set(0.35, -0.2, -1);
          L.palm.set(0.1, -1, 0.1);
          R.pos.set(0.2, 0.79, -0.24);
          R.fingers.set(-0.35, -0.2, -1);
          R.palm.set(-0.1, -1, 0.1);
          L.curl = R.curl = 0.7;
          gazeRoot = this.gaze.target.y > 1.3 ? null : SCREENS[4];
          break;
        case 'think':
          // Chin on the hand, the other forearm on the desk.
          lean = 0.2;
          R.space = 'torso';
          R.pos.set(0.035, 0.53, -0.2);
          R.fingers.set(-0.2, 1, -0.3);
          R.palm.set(-0.6, 0, -0.8);
          R.curl = 1.1;
          L.pos.set(-0.12, 0.79, -0.3);
          L.fingers.set(0.6, -0.2, -1);
          L.curl = 0.8;
          break;
        case 'call': {
          // Hand to the headset, nodding and talking to a broker.
          L.space = 'torso';
          L.pos.set(-0.16, 0.62, -0.02);
          L.fingers.set(0.2, 1, 0.1);
          L.palm.set(1, 0, 0);
          L.curl = 0.5;
          R.type = 0.5;
          smile = 0.2;
          break;
        }
        case 'sip': {
          // reach → lift → drink → put down
          const mugWorldToRoot = MUG_SPOT.clone().add(v3(0.03, 0.05, 0.04));
          R.curl = 0.9;
          R.fingers.set(-1, 0, -0.3);
          R.palm.set(-0.3, 0, -1);
          if (since < 0.9) {
            R.pos.copy(mugWorldToRoot);
          } else if (since < 4.2) {
            if (this.mug.parent === this.root) this.arms[1].hand.attach(this.mug);
            R.space = 'torso';
            const lift = since < 1.8 ? (since - 0.9) / 0.9 : since < 3.4 ? 1 : 1 - (since - 3.4) / 0.8;
            R.pos.set(0.1 - 0.06 * lift, 0.32 + 0.24 * lift, -0.3 + 0.08 * lift);
            R.fingers.set(-1, 0.3 * lift, -0.4);
            R.palm.set(-0.2, 0, -1);
            lean = 0.02 - 0.12 * lift;
            gazeRoot = SCREENS[1];
          } else {
            R.pos.copy(mugWorldToRoot);
            if (since > 4.9) this.#dropMug();
          }
          L.type = 0.4;
          break;
        }
        default:
          break;
      }
      switch (this.mood) {
        case 'stressed':
          lean = 0.24;
          smile = -0.1;
          brow = -0.8;
          break;
        case 'confident':
        case 'happy':
          smile = 0.35;
          lean = Math.min(lean, 0.02);
          break;
        case 'dejected':
          lean = -0.12;
          smile = -0.2;
          brow = -0.3;
          break;
        case 'frustrated':
          if (act !== 'sip') {
            L.space = R.space = 'torso';
            L.pos.set(-0.1, 0.76, -0.12);
            R.pos.set(0.1, 0.76, -0.12);
            L.fingers.set(0.3, 1, 0.3);
            R.fingers.set(-0.3, 1, 0.3);
            L.palm.set(0.6, 0, -0.6);
            R.palm.set(-0.6, 0, -0.6);
            lean = 0.12;
            smile = -0.3;
            brow = -1;
          }
          break;
        default:
          break;
      }
    }

    // ---- body -------------------------------------------------------------------------
    const c = this.cur;
    c.swivel = damp(c.swivel, swivel, greeting ? 3.2 : 3, dt);
    this.swivel.rotation.y = c.swivel;
    c.lean = damp(c.lean, lean, 3.5, dt);
    this.torso.rotation.x = -c.lean;
    const breathe = Math.sin(t * 1.5);
    this.torso.scale.set(1 + breathe * 0.006, 1 + breathe * 0.004, 1 + breathe * 0.01);

    // ---- gaze ---------------------------------------------------------------------------
    this.root.updateWorldMatrix(true, false);
    this.torso.updateWorldMatrix(true, false);
    const toTorso = this._m.copy(this.torso.matrixWorld).invert();
    const g = this._v;
    if (greeting && this.lookWorld) {
      g.copy(this.lookWorld).applyMatrix4(toTorso);
    } else {
      if (!gazeRoot && t > this.gaze.next) {
        const pool = act === 'type' || act === 'mouse' ? [0, 1, 1, 2, 3, 4, 5, 1, 4] : act === 'read' || act === 'think' ? [3, 4, 5, 4, 1] : act === 'call' ? [1, 4, 2, 0] : [1, 4];
        const i = pool[Math.floor(Math.random() * pool.length)];
        this.gaze.target.copy(SCREENS[i]).add(v3((Math.random() - 0.5) * 0.3, (Math.random() - 0.5) * 0.15, 0));
        if (act === 'type' && Math.random() < 0.15) this.gaze.target.copy(KEYBOARD);
        this.gaze.next = t + 0.7 + Math.random() * 2.6;
      }
      g.copy(gazeRoot || this.gaze.target).applyMatrix4(this.root.matrixWorld).applyMatrix4(toTorso);
    }
    g.sub(HEAD_IN_TORSO);
    const yaw = Math.atan2(-g.x, -g.z);
    const pitch = Math.atan2(g.y, Math.hypot(g.x, g.z));
    const headYaw = THREE.MathUtils.clamp(yaw * 0.75, -1.0, 1.0);
    const headPitch = THREE.MathUtils.clamp(pitch * 0.7, -0.5, 0.45);
    const lagHead = greeting ? 4 : 5;
    c.yaw = damp(c.yaw, headYaw, lagHead, dt);
    c.pitch = damp(c.pitch, headPitch, lagHead, dt);
    c.eyeYaw = damp(c.eyeYaw, THREE.MathUtils.clamp(yaw - c.yaw, -0.45, 0.45), 25, dt);
    c.eyePitch = damp(c.eyePitch, THREE.MathUtils.clamp(pitch - c.pitch, -0.3, 0.3), 25, dt);
    const nod = greeting && this.speaking ? Math.sin(t * 5.2) * 0.03 * this.speech + Math.sin(t * 1.3) * 0.02 : act === 'call' ? Math.sin(t * 2.1) * 0.04 : 0;
    this.neck.rotation.set(-c.pitch * 0.35, c.yaw * 0.4, 0);
    this.headPivot.rotation.set(-c.pitch * 0.65 - nod, c.yaw * 0.6, Math.sin(t * 0.37) * 0.025);
    for (const e of this.face.eyes) e.rotation.set(-c.eyePitch, c.eyeYaw, 0);

    // ---- face -----------------------------------------------------------------------------
    const b = this.blink;
    if (t > b.next && b.t < 0) b.t = 0;
    let lidClose = 0;
    if (b.t >= 0) {
      b.t += dt;
      lidClose = b.t < 0.07 ? b.t / 0.07 : Math.max(0, 1 - (b.t - 0.07) / 0.1);
      if (b.t > 0.17) {
        b.t = -1;
        b.next = t + (Math.random() < 0.15 ? 0.25 : 1.8 + Math.random() * 4);
      }
    }
    const lookDown = Math.max(0, -(c.pitch + c.eyePitch)) * 0.6;
    c.lid = Math.max(lidClose, Math.min(0.55, lookDown + (this.mood === 'stressed' ? 0.12 : 0)));
    for (const lid of this.face.lids) {
      lid.upper.rotation.x = THREE.MathUtils.lerp(0.36, -0.3, c.lid) - c.eyePitch * 0.3;
      lid.lower.rotation.x = Math.PI - 0.72 + lidClose * 0.12;
    }
    const talking = greeting ? this.speaking : act === 'call' && Math.sin(t * 0.9) > -0.2;
    const openTarget = greeting ? (this.speaking ? this.speech : 0) : talking ? Math.max(0, Math.sin(t * 13) * Math.sin(t * 3.1)) * 0.45 : 0;
    c.open = damp(c.open, openTarget, 28, dt);
    c.smile = damp(c.smile, smile, 4, dt);
    c.brow = damp(c.brow, brow, 5, dt);
    for (const lip of this.face.lips) {
      lip.morphTargetInfluences[0] = c.open;
      lip.morphTargetInfluences[1] = Math.max(-0.4, c.smile);
    }
    this.face.inside.scale.y = 0.0006 + 0.0085 * c.open;
    this.face.inside.position.y = this.face.mouth.y - 0.001 - 0.004 * c.open;
    this.face.brows.position.y = 0.0028 * Math.max(0, c.brow) + 0.0012 * Math.min(0, c.brow);
    this.face.brows.rotation.x = -0.05 * Math.min(0, c.brow);

    // ---- arms (IK) ------------------------------------------------------------------------
    const sw = this.swivel;
    sw.updateWorldMatrix(false, false);
    [L, R].forEach((h, i) => {
      const arm = this.arms[i];
      const tgt = this._t[i].copy(h.pos);
      const fing = this._f[i].copy(h.fingers).normalize();
      const palm = this._p[i].copy(h.palm).normalize();
      if (h.type) {
        // Little hops of the wrists as keys are pressed.
        const hop = Math.max(0, Math.sin(t * 17 + i * 1.9)) * 0.006 * h.type;
        tgt.y += hop;
        tgt.x += Math.sin(t * 2.3 + i) * 0.012 * h.type;
      }
      if (h.space !== 'torso') {
        const from = h.space === 'root' ? this.root.matrixWorld : sw.matrixWorld;
        tgt.applyMatrix4(from).applyMatrix4(toTorso);
        const rot = this._r.setFromMatrix4(from);
        const inv = this._ri.setFromMatrix4(toTorso);
        fing.applyMatrix3(rot).applyMatrix3(inv).normalize();
        palm.applyMatrix3(rot).applyMatrix3(inv).normalize();
      }
      const hs = this.hands[i];
      const k = 1 - Math.exp(-(greeting ? 9 : 7) * dt);
      hs.pos.lerp(tgt, k);
      hs.fingers.lerp(fing, k).normalize();
      hs.palm.lerp(palm, k).normalize();
      const pole = v3(arm.side * 0.8, -0.7, 0.45);
      solveArm(arm, hs.pos, pole, hs.fingers, hs.palm, 0.9);
      arm.fingers.forEach((f, j) => {
        const tap = h.type ? Math.max(0, Math.sin(t * 15 + j * 1.3 + i * 2.1)) * 0.5 * h.type : 0;
        f.rotation.x = damp(f.rotation.x, h.curl + tap - 0.08 * j * (h.curl < 0.3 ? 1 : 0), 14, dt);
      });
    });
  }
}
