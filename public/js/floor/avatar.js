import * as THREE from 'three';

// A seated trader built from primitives, with a swivel chair and a small procedural
// animation system (typing, glancing between screens, moods, greeting the boss).
// Local space: the trader faces -Z (toward the monitors).

const mat = (color, opts = {}) => new THREE.MeshStandardMaterial({ color, roughness: 0.75, metalness: 0.02, ...opts });

const damp = (current, target, lambda, dt) => THREE.MathUtils.lerp(current, target, 1 - Math.exp(-lambda * dt));

function capsule(r, len, material, radial = 12) {
  const m = new THREE.Mesh(new THREE.CapsuleGeometry(r, len, 6, radial), material);
  m.castShadow = true;
  return m;
}

function buildChair(accent) {
  const base = new THREE.Group();
  const metal = mat('#2b2f36', { metalness: 0.7, roughness: 0.35 });
  const fabric = mat('#15181d', { roughness: 0.9 });
  for (let i = 0; i < 5; i++) {
    const leg = new THREE.Mesh(new THREE.BoxGeometry(0.05, 0.035, 0.34), metal);
    const a = (i / 5) * Math.PI * 2;
    leg.position.set(Math.sin(a) * 0.17, 0.06, Math.cos(a) * 0.17);
    leg.rotation.y = a;
    base.add(leg);
    const wheel = new THREE.Mesh(new THREE.SphereGeometry(0.035, 8, 6), fabric);
    wheel.position.set(Math.sin(a) * 0.33, 0.035, Math.cos(a) * 0.33);
    base.add(wheel);
  }
  const post = new THREE.Mesh(new THREE.CylinderGeometry(0.028, 0.035, 0.36, 10), metal);
  post.position.y = 0.26;
  base.add(post);

  const swivel = new THREE.Group();
  const seat = new THREE.Mesh(new THREE.BoxGeometry(0.5, 0.08, 0.48), fabric);
  seat.position.y = 0.46;
  seat.castShadow = true;
  swivel.add(seat);
  const back = new THREE.Mesh(new THREE.BoxGeometry(0.46, 0.62, 0.06), fabric);
  back.position.set(0, 0.86, 0.25);
  back.rotation.x = -0.1;
  back.castShadow = true;
  swivel.add(back);
  const stripe = new THREE.Mesh(new THREE.BoxGeometry(0.47, 0.03, 0.065), mat(accent, { emissive: accent, emissiveIntensity: 0.35 }));
  stripe.position.set(0, 1.12, 0.22);
  stripe.rotation.x = -0.1;
  swivel.add(stripe);
  for (const s of [-1, 1]) {
    const arm = new THREE.Mesh(new THREE.BoxGeometry(0.05, 0.04, 0.3), metal);
    arm.position.set(s * 0.26, 0.66, 0.02);
    swivel.add(arm);
    const strut = new THREE.Mesh(new THREE.BoxGeometry(0.03, 0.2, 0.03), metal);
    strut.position.set(s * 0.26, 0.56, 0.1);
    swivel.add(strut);
  }
  return { base, swivel };
}

function buildHair(style, color, headR) {
  const g = new THREE.Group();
  const m = mat(color, { roughness: 0.9 });
  const cap = (phiStart, phiLen, thetaLen, r = headR * 1.06) => {
    const mesh = new THREE.Mesh(new THREE.SphereGeometry(r, 20, 14, phiStart, phiLen, 0, thetaLen), m);
    mesh.castShadow = true;
    return mesh;
  };
  switch (style) {
    case 'buzz':
      g.add(cap(0, Math.PI * 2, Math.PI * 0.42, headR * 1.02));
      break;
    case 'long': {
      g.add(cap(0, Math.PI * 2, Math.PI * 0.5));
      const back = new THREE.Mesh(new THREE.CylinderGeometry(headR * 1.02, headR * 1.15, headR * 2.6, 16, 1, true, Math.PI * 0.15, Math.PI * 1.7), m);
      back.position.y = -headR * 1.05;
      back.rotation.y = Math.PI;
      g.add(back);
      break;
    }
    case 'bun': {
      g.add(cap(0, Math.PI * 2, Math.PI * 0.5));
      const bun = new THREE.Mesh(new THREE.SphereGeometry(headR * 0.45, 12, 10), m);
      bun.position.set(0, headR * 0.75, headR * 0.75);
      g.add(bun);
      break;
    }
    case 'ponytail': {
      g.add(cap(0, Math.PI * 2, Math.PI * 0.5));
      const tail = capsule(headR * 0.28, headR * 1.6, m);
      tail.position.set(0, -headR * 0.5, headR * 1.15);
      tail.rotation.x = 0.35;
      g.add(tail);
      break;
    }
    case 'bob': {
      g.add(cap(0, Math.PI * 2, Math.PI * 0.5));
      const bob = new THREE.Mesh(new THREE.CylinderGeometry(headR * 1.1, headR * 1.12, headR * 1.1, 18, 1, true, Math.PI * 0.2, Math.PI * 1.6), m);
      bob.position.y = -headR * 0.35;
      bob.rotation.y = Math.PI;
      g.add(bob);
      break;
    }
    case 'messy': {
      g.add(cap(0, Math.PI * 2, Math.PI * 0.48));
      for (let i = 0; i < 7; i++) {
        const tuft = new THREE.Mesh(new THREE.ConeGeometry(headR * 0.25, headR * 0.45, 5), m);
        const a = (i / 7) * Math.PI * 2;
        tuft.position.set(Math.sin(a) * headR * 0.55, headR * 0.9, Math.cos(a) * headR * 0.55);
        tuft.rotation.set(Math.cos(a) * 0.6, 0, -Math.sin(a) * 0.6);
        g.add(tuft);
      }
      break;
    }
    case 'side': {
      const c = cap(0, Math.PI * 2, Math.PI * 0.46);
      c.rotation.z = 0.12;
      g.add(c);
      break;
    }
    default:
      g.add(cap(0, Math.PI * 2, Math.PI * 0.45));
  }
  return g;
}

export class Avatar {
  constructor(profile) {
    const ap = profile.appearance;
    this.profile = profile;
    this.root = new THREE.Group();
    const chair = buildChair(profile.accent);
    this.root.add(chair.base);
    this.swivel = chair.swivel;
    this.root.add(this.swivel);

    const skin = mat(ap.skin, { roughness: 0.6 });
    const shirt = mat(ap.shirt, { roughness: 0.85 });
    const pants = mat('#1c2029', { roughness: 0.9 });
    const shoes = mat('#0d0e10', { roughness: 0.5 });

    // Body pivots at the hips so leaning looks natural.
    this.body = new THREE.Group();
    this.body.position.set(0, 0.56, 0.02);
    this.swivel.add(this.body);

    for (const s of [-1, 1]) {
      const thigh = capsule(0.075, 0.34, pants);
      thigh.rotation.x = Math.PI / 2;
      thigh.position.set(s * 0.1, 0, -0.2);
      this.body.add(thigh);
      const shin = capsule(0.062, 0.36, pants);
      shin.position.set(s * 0.1, -0.24, -0.42);
      this.body.add(shin);
      const shoe = new THREE.Mesh(new THREE.BoxGeometry(0.1, 0.07, 0.24), shoes);
      shoe.position.set(s * 0.1, -0.5, -0.47);
      this.body.add(shoe);
    }

    this.torso = new THREE.Group();
    this.body.add(this.torso);
    const chest = capsule(0.17, 0.3, shirt, 16);
    chest.position.y = 0.3;
    chest.scale.set(1.05, 1, 0.72);
    this.torso.add(chest);
    this.chest = chest;
    if (ap.vest) {
      const vestMat = mat(ap.vest, { roughness: 0.95 });
      const vest = new THREE.Mesh(new THREE.CapsuleGeometry(0.178, 0.26, 6, 16, 1), vestMat);
      vest.position.set(0, 0.28, 0.004);
      vest.scale.set(1.06, 1, 0.76);
      vest.castShadow = true;
      this.torso.add(vest);
      // open front shows the shirt
      const placket = new THREE.Mesh(new THREE.BoxGeometry(0.08, 0.36, 0.02), shirt);
      placket.position.set(0, 0.33, -0.132);
      this.torso.add(placket);
    }
    const collar = new THREE.Mesh(new THREE.TorusGeometry(0.07, 0.018, 6, 14), shirt);
    collar.rotation.x = Math.PI / 2;
    collar.position.y = 0.58;
    this.torso.add(collar);

    // Head
    this.neck = new THREE.Group();
    this.neck.position.y = 0.6;
    this.torso.add(this.neck);
    const neckMesh = new THREE.Mesh(new THREE.CylinderGeometry(0.05, 0.055, 0.1, 10), skin);
    neckMesh.position.y = 0.03;
    this.neck.add(neckMesh);
    this.head = new THREE.Group();
    this.head.position.y = 0.19;
    this.neck.add(this.head);
    const headR = 0.115;
    const skull = new THREE.Mesh(new THREE.SphereGeometry(headR, 24, 18), skin);
    skull.scale.set(0.92, 1.08, 1);
    skull.castShadow = true;
    this.head.add(skull);
    const hair = buildHair(ap.hairStyle, ap.hair, headR);
    hair.position.y = 0.012;
    hair.rotation.x = -0.18;
    this.head.add(hair);
    // Face (on -Z)
    const eyeMat = mat('#101014', { roughness: 0.3 });
    const white = mat('#f4f4f4', { roughness: 0.4 });
    for (const s of [-1, 1]) {
      const eyeWhite = new THREE.Mesh(new THREE.SphereGeometry(0.017, 10, 8), white);
      eyeWhite.position.set(s * 0.04, 0.012, -0.1);
      eyeWhite.scale.z = 0.5;
      this.head.add(eyeWhite);
      const pupil = new THREE.Mesh(new THREE.SphereGeometry(0.009, 8, 6), eyeMat);
      pupil.position.set(s * 0.04, 0.012, -0.108);
      this.head.add(pupil);
      const brow = new THREE.Mesh(new THREE.BoxGeometry(0.035, 0.007, 0.01), mat(ap.hair));
      brow.position.set(s * 0.04, 0.042, -0.104);
      brow.rotation.z = -s * 0.08;
      this.head.add(brow);
      const ear = new THREE.Mesh(new THREE.SphereGeometry(0.022, 8, 8), skin);
      ear.position.set(s * 0.105, 0, 0);
      ear.scale.set(0.5, 1, 0.8);
      this.head.add(ear);
    }
    const nose = new THREE.Mesh(new THREE.ConeGeometry(0.016, 0.04, 8), skin);
    nose.rotation.x = -Math.PI / 2;
    nose.position.set(0, -0.012, -0.118);
    this.head.add(nose);
    this.mouth = new THREE.Mesh(new THREE.BoxGeometry(0.04, 0.008, 0.01), mat('#6b2f2f'));
    this.mouth.position.set(0, -0.05, -0.1);
    this.head.add(this.mouth);
    if (ap.glasses) {
      const frame = mat('#111', { metalness: 0.4, roughness: 0.3 });
      for (const s of [-1, 1]) {
        const ring = new THREE.Mesh(new THREE.TorusGeometry(0.024, 0.004, 6, 16), frame);
        ring.position.set(s * 0.04, 0.012, -0.112);
        this.head.add(ring);
      }
      const bridge = new THREE.Mesh(new THREE.BoxGeometry(0.03, 0.004, 0.004), frame);
      bridge.position.set(0, 0.016, -0.114);
      this.head.add(bridge);
    }
    if (ap.headset) {
      const hs = mat('#16181c', { metalness: 0.3, roughness: 0.5 });
      const band = new THREE.Mesh(new THREE.TorusGeometry(0.128, 0.009, 6, 20, Math.PI), hs);
      band.position.y = 0.02;
      this.head.add(band);
      for (const s of [-1, 1]) {
        const cup = new THREE.Mesh(new THREE.CylinderGeometry(0.04, 0.04, 0.025, 14), hs);
        cup.rotation.z = Math.PI / 2;
        cup.position.set(s * 0.122, 0, 0);
        this.head.add(cup);
      }
      const boom = new THREE.Mesh(new THREE.CylinderGeometry(0.004, 0.004, 0.12, 6), hs);
      boom.rotation.set(Math.PI / 2 - 0.3, 0, 0.5);
      boom.position.set(0.09, -0.05, -0.06);
      this.head.add(boom);
      const mic = new THREE.Mesh(new THREE.SphereGeometry(0.01, 8, 6), mat(profile.accent, { emissive: profile.accent, emissiveIntensity: 0.6 }));
      mic.position.set(0.045, -0.07, -0.11);
      this.head.add(mic);
    }

    // Arms: shoulder → elbow → hand
    this.arms = [];
    for (const s of [-1, 1]) {
      const shoulder = new THREE.Group();
      shoulder.position.set(s * 0.215, 0.5, 0);
      this.torso.add(shoulder);
      const upper = capsule(0.052, 0.2, shirt);
      upper.position.y = -0.13;
      shoulder.add(upper);
      const elbow = new THREE.Group();
      elbow.position.y = -0.27;
      shoulder.add(elbow);
      const fore = capsule(0.045, 0.2, shirt);
      fore.position.y = -0.12;
      elbow.add(fore);
      const hand = new THREE.Mesh(new THREE.SphereGeometry(0.045, 10, 8), skin);
      hand.position.y = -0.27;
      hand.scale.set(0.9, 1.1, 0.7);
      hand.castShadow = true;
      elbow.add(hand);
      this.arms.push({ side: s, shoulder, elbow });
    }

    // Animation state
    this.mood = 'focused';
    this.status = 'SCANNING';
    this.mode = 'work'; // work | greet
    this.faceAngle = 0; // swivel target when greeting
    this.greetStart = 0;
    this.t = Math.random() * 100;
    this.glance = { yaw: 0, pitch: 0, next: 0 };
    this.typing = 0;
    this.celebrateUntil = 0;
  }

  setState({ mood, status }) {
    if (mood && mood !== this.mood) {
      if (mood === 'celebrating') this.celebrateUntil = this.t + 3.5;
      this.mood = mood;
    }
    if (status) this.status = status;
  }

  // Turn toward a point in the avatar's parent (desk) space and wave.
  greet(localTarget) {
    const chairPos = this.root.position;
    const dx = localTarget.x - chairPos.x;
    const dz = localTarget.z - chairPos.z;
    this.faceAngle = Math.atan2(-dx, -dz);
    this.mode = 'greet';
    this.greetStart = this.t;
  }

  backToWork() {
    this.mode = 'work';
  }

  headWorldPosition(target = new THREE.Vector3()) {
    return this.head.getWorldPosition(target);
  }

  update(dt) {
    this.t += dt;
    const t = this.t;
    const [L, R] = this.arms;
    const greeting = this.mode === 'greet';
    const sinceGreet = t - this.greetStart;

    // Pose targets
    let swivel = 0;
    let lean = 0.08;
    let headYaw = 0;
    let headPitch = 0.05;
    let armL = { sx: 0.35, sz: -0.12, ex: 1.2, ez: 0 };
    let armR = { sx: 0.35, sz: 0.12, ex: 1.2, ez: 0 };

    if (!greeting) {
      if (t > this.glance.next) {
        const options = [[0, 0.05], [0.42, 0.02], [-0.42, 0.02], [0.3, -0.28], [0, -0.3], [-0.3, -0.28]];
        const pick = options[Math.floor(Math.random() * options.length)];
        this.glance = { yaw: pick[0], pitch: pick[1], next: t + 1.2 + Math.random() * 3.2 };
      }
      headYaw = this.glance.yaw;
      headPitch = this.glance.pitch;
      const busy = this.status === 'IN TRADE' || this.status === 'ARMED';
      const typingRate = this.mood === 'stressed' ? 1 : busy ? 0.75 : 0.45;
      const burst = Math.sin(t * 0.7 + this.t * 0.01) > 1 - typingRate * 1.6;
      const tap = burst ? 1 : 0;
      armL.ex += tap * Math.sin(t * 18) * 0.08;
      armR.ex += tap * Math.sin(t * 18 + 1.7) * 0.08;
      armL.sx += tap * Math.sin(t * 9) * 0.03;

      switch (this.mood) {
        case 'stressed':
          lean = 0.22;
          headPitch = -0.05;
          break;
        case 'confident':
        case 'happy':
          lean = -0.05;
          headYaw *= 0.7;
          break;
        case 'dejected':
          lean = -0.1;
          headPitch = 0.45;
          armL = { sx: 0.15, sz: -0.05, ex: 0.4, ez: 0 };
          armR = { sx: 0.15, sz: 0.05, ex: 0.4, ez: 0 };
          break;
        case 'frustrated':
          // facepalm
          headPitch = 0.3;
          lean = 0.15;
          armR = { sx: 1.95, sz: -0.35, ex: 1.35, ez: 0 };
          break;
        default:
          break;
      }
      if (t < this.celebrateUntil) {
        const pump = Math.sin(t * 9) * 0.25;
        armL = { sx: 0.1, sz: -2.7 + pump, ex: 0.3, ez: 0 };
        armR = { sx: 0.1, sz: 2.7 - pump, ex: 0.3, ez: 0 };
        headPitch = -0.25;
        lean = -0.12;
        swivel = Math.sin(t * 3) * 0.25;
      }
    } else {
      swivel = this.faceAngle;
      lean = -0.02;
      headPitch = -0.08;
      headYaw = Math.sin(t * 0.8) * 0.08;
      if (sinceGreet > 0.5 && sinceGreet < 3.6) {
        // wave with the right hand
        armR = { sx: 0.2, sz: 2.55, ex: 0, ez: -0.35 + Math.sin(t * 10) * 0.45 };
      } else {
        armR = { sx: 0.25, sz: 0.2, ex: 0.9, ez: 0 };
      }
      armL = { sx: 0.25, sz: -0.2, ex: 0.9, ez: 0 };
    }

    // Apply with damping
    const k = greeting ? 5 : 6;
    this.swivel.rotation.y = damp(this.swivel.rotation.y, swivel, greeting ? 3.5 : 4, dt);
    this.body.rotation.x = damp(this.body.rotation.x, 0, k, dt);
    // lean > 0 leans toward the screens; headPitch > 0 looks down.
    this.torso.rotation.x = damp(this.torso.rotation.x, -lean, k, dt);
    this.neck.rotation.y = damp(this.neck.rotation.y, headYaw, 4, dt);
    this.neck.rotation.x = damp(this.neck.rotation.x, -headPitch, 4, dt);
    const breathe = 1 + Math.sin(t * 1.6) * 0.012;
    this.chest.scale.y = breathe;
    for (const [arm, p] of [[L, armL], [R, armR]]) {
      arm.shoulder.rotation.x = damp(arm.shoulder.rotation.x, p.sx, 9, dt);
      arm.shoulder.rotation.z = damp(arm.shoulder.rotation.z, p.sz, 9, dt);
      arm.elbow.rotation.x = damp(arm.elbow.rotation.x, p.ex, 12, dt);
      arm.elbow.rotation.z = damp(arm.elbow.rotation.z, p.ez, 12, dt);
    }
    // Talking mouth while greeting
    const talking = greeting && sinceGreet > 0.4;
    this.mouth.scale.y = talking ? 1 + Math.abs(Math.sin(t * 14)) * 3 : 1;
  }
}
