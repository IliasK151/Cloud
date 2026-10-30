// The deep brain's memory: every past trade it knows, as the vector the transformer made of it
// (the idea token's final state, 32 numbers). Trades the network sees as alike sit close
// together, the way a language model's search finds related text. A new idea is compared with
// all of them (cosine similarity) and its closest past trades, with how they ended, are the
// evidence shown with its answer.
//
// For the Brain tab the vectors are squeezed onto three axes (principal components: the three
// directions they differ most along), which is the galaxy you see.

export function unit(v) {
  let n = 0;
  for (let i = 0; i < v.length; i++) n += v[i] * v[i];
  n = Math.sqrt(n) || 1;
  const out = new Float32Array(v.length);
  for (let i = 0; i < v.length; i++) out[i] = v[i] / n;
  return out;
}

// The k entries most like q (unit vector) in vecs (n unit vectors packed in one array of n×d).
export function nearest(vecs, d, q, k = 12, skip = null) {
  const n = Math.floor(vecs.length / d);
  const best = [];
  for (let i = 0; i < n; i++) {
    if (skip?.(i)) continue;
    let s = 0;
    const o = i * d;
    for (let j = 0; j < d; j++) s += vecs[o + j] * q[j];
    if (best.length < k) {
      best.push({ i, s });
      if (best.length === k) best.sort((a, b) => b.s - a.s);
    } else if (s > best[k - 1].s) {
      best[k - 1] = { i, s };
      for (let m = k - 1; m > 0 && best[m].s > best[m - 1].s; m--) [best[m], best[m - 1]] = [best[m - 1], best[m]];
    }
  }
  return best.sort((a, b) => b.s - a.s);
}

// The three directions the vectors differ most along (power iteration with deflation), and a
// scale that puts most of them within 6 units of the centre.
export function pca3(vecs, d) {
  const n = Math.floor(vecs.length / d);
  const mean = new Float64Array(d);
  for (let i = 0; i < n; i++) for (let j = 0; j < d; j++) mean[j] += vecs[i * d + j] / n;
  const C = new Float64Array(d * d);
  for (let i = 0; i < n; i++) {
    for (let a = 0; a < d; a++) {
      const va = vecs[i * d + a] - mean[a];
      for (let b = a; b < d; b++) C[a * d + b] += va * (vecs[i * d + b] - mean[b]);
    }
  }
  for (let a = 0; a < d; a++) for (let b = 0; b < a; b++) C[a * d + b] = C[b * d + a];
  const basis = [];
  for (let k = 0; k < 3; k++) {
    let v = Float64Array.from({ length: d }, (_, i) => Math.sin(i * 1.7 + k * 2.3) + 0.1);
    for (let it = 0; it < 200; it++) {
      const w = new Float64Array(d);
      for (let a = 0; a < d; a++) {
        let s = 0;
        for (let b = 0; b < d; b++) s += C[a * d + b] * v[b];
        w[a] = s;
      }
      for (const u of basis) {
        let p = 0;
        for (let a = 0; a < d; a++) p += w[a] * u[a];
        for (let a = 0; a < d; a++) w[a] -= p * u[a];
      }
      let norm = 0;
      for (let a = 0; a < d; a++) norm += w[a] * w[a];
      norm = Math.sqrt(norm);
      if (!(norm > 1e-12)) break;
      for (let a = 0; a < d; a++) w[a] /= norm;
      v = w;
    }
    basis.push(Array.from(v));
  }
  const pca = { mean: Array.from(mean), basis, scale: 1 };
  const radii = [];
  for (let i = 0; i < n; i++) {
    const p = project(pca, vecs.subarray(i * d, (i + 1) * d));
    radii.push(Math.hypot(p[0], p[1], p[2]));
  }
  radii.sort((a, b) => a - b);
  const r95 = radii[Math.floor(radii.length * 0.95)] || 1;
  pca.scale = 6 / (r95 || 1);
  return pca;
}

export function project(pca, v) {
  const out = [0, 0, 0];
  for (let k = 0; k < 3; k++) {
    let s = 0;
    for (let j = 0; j < pca.mean.length; j++) s += (v[j] - pca.mean[j]) * pca.basis[k][j];
    out[k] = s * pca.scale;
  }
  return out;
}

// Float32 vectors to and from text for saving.
export const packVecs = (v) => Buffer.from(v.buffer, v.byteOffset, v.byteLength).toString('base64');
export const unpackVecs = (s) => {
  const b = Buffer.from(s, 'base64');
  return new Float32Array(b.buffer, b.byteOffset, Math.floor(b.byteLength / 4)).slice();
};
