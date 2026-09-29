import * as THREE from 'three';

// Two-bone arm IK. Everything is in the parent (torso) space of the shoulder pivot.
// The arm hangs along local -Y; the elbow bends about its local X axis.

const _d = new THREE.Vector3();
const _p = new THREE.Vector3();
const _u = new THREE.Vector3();
const _e = new THREE.Vector3();
const _f = new THREE.Vector3();
const _x = new THREE.Vector3();
const _y = new THREE.Vector3();
const _z = new THREE.Vector3();
const _m = new THREE.Matrix4();
const _q = new THREE.Quaternion();
const _qe = new THREE.Quaternion();
const _qd = new THREE.Quaternion();
const _fl = new THREE.Vector3();
const _n = new THREE.Vector3();

/**
 * @param arm   { shoulder, elbow, hand, L1, L2 }
 * @param target wrist target (torso space)
 * @param pole   direction the elbow should point toward (torso space)
 * @param fingers desired finger direction (torso space), optional
 * @param palm    desired palm normal (torso space), optional
 * @param wristBlend 0..1 how strongly the hand follows fingers/palm
 */
export function solveArm(arm, target, pole, fingers = null, palm = null, wristBlend = 0.85) {
  const { shoulder, elbow, hand, L1, L2 } = arm;
  _d.subVectors(target, shoulder.position);
  let D = _d.length();
  D = Math.min(Math.max(D, Math.abs(L1 - L2) + 0.02), (L1 + L2) * 0.998);
  _d.normalize();
  const A = Math.acos(THREE.MathUtils.clamp((L1 * L1 + D * D - L2 * L2) / (2 * L1 * D), -1, 1));
  _p.copy(pole).addScaledVector(_d, -pole.dot(_d));
  if (_p.lengthSq() < 1e-8) _p.set(0, -1, 0);
  _p.normalize();
  _u.copy(_d).multiplyScalar(Math.cos(A)).addScaledVector(_p, Math.sin(A));
  _e.copy(_u).multiplyScalar(L1);
  _f.copy(_d).multiplyScalar(D).sub(_e).normalize();

  _y.copy(_u).negate();
  _x.crossVectors(_u, _f);
  if (_x.lengthSq() < 1e-8) _x.crossVectors(_u, _p);
  _x.normalize();
  _z.crossVectors(_x, _y).normalize();
  _m.makeBasis(_x, _y, _z);
  shoulder.quaternion.setFromRotationMatrix(_m);

  _fl.copy(_f).applyQuaternion(_q.copy(shoulder.quaternion).invert());
  elbow.rotation.set(Math.atan2(-_fl.z, -_fl.y), 0, 0);

  if (fingers && palm) {
    // Hand basis: fingers along -Y, palm facing -Z.
    _y.copy(fingers).normalize().negate();
    _n.copy(palm).addScaledVector(_y, -palm.dot(_y)).normalize().negate(); // local +Z
    _x.crossVectors(_y, _n).normalize();
    _z.crossVectors(_x, _y).normalize();
    _m.makeBasis(_x, _y, _z);
    _qd.setFromRotationMatrix(_m);
    _qe.copy(shoulder.quaternion).multiply(elbow.quaternion).invert();
    _qd.premultiply(_qe);
    hand.quaternion.identity().slerp(_qd, wristBlend);
  } else {
    hand.quaternion.identity();
  }
}
