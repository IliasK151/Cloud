import { mulberry32, gaussian } from '../util/random.js';

// The deep brain's network: a small transformer, the design behind large language models,
// with a mixture of experts on top. Written out in full (forward and backward), like
// neural/net.js, so nothing is hidden and it needs no library.
//
//   Tokens       every candle is one token: 6 numbers about its body, wicks, range, volume,
//                where it closed against the entry and the time of day (deep/tokens.js), plus
//                its slot (which timeframe, which candle). The trade idea is the last token,
//                made from the ~50 senses the neural brain sees (neural/features.js).
//   Attention    two layers of four heads. Each candle reads every other candle; the idea reads
//                them all. How much the idea looked at each candle is what the Brain tab draws.
//   Experts      the idea's final vector goes to a router that weighs five experts (indices,
//                FX, gold, oil, crypto). It starts by asking the market's own expert (a learned
//                prior) and learns how much to also ask the others. The answer is the chance
//                the trade ends in profit.
//   Pre-training like an LLM: before it ever sees a trade, it learns to read candles by
//                predicting whether price is higher or lower 15 minutes after them.
//
// Pre-norm residual blocks with layer norm and GELU, AdamW with gradient clipping. Seeded, so
// the same data trains the same brain.

export const MODEL_V = 1;
export const DEFAULTS = { d: 32, heads: 4, layers: 2, ffn: 64, feats: 8, senses: 49, slots: 25, experts: 5, expertHidden: 16 };

const GC = Math.sqrt(2 / Math.PI);
const gelu = (u) => 0.5 * u * (1 + Math.tanh(GC * (u + 0.044715 * u * u * u)));
function geluGrad(u) {
  const t = Math.tanh(GC * (u + 0.044715 * u * u * u));
  return 0.5 * (1 + t) + 0.5 * u * (1 - t * t) * GC * (1 + 3 * 0.044715 * u * u);
}
const sigmoid = (z) => 1 / (1 + Math.exp(-Math.max(-35, Math.min(35, z))));
const EPS = 1e-5;

// Every learned number lives in one array; each parameter is a named view into it.
function layout(c) {
  const spec = [];
  const add = (name, n, init, decay = false) => spec.push({ name, n, init, decay });
  add('Wc', c.d * c.feats, ['w', c.feats, c.d], true);
  add('bc', c.d, 0);
  add('Wi', c.d * c.senses, ['w', c.senses, c.d], true);
  add('bi', c.d, 0);
  add('P', c.slots * c.d, ['n', 0.05], true);
  for (let l = 0; l < c.layers; l++) {
    add(`g1_${l}`, c.d, 1);
    add(`b1_${l}`, c.d, 0);
    for (const k of ['q', 'k', 'v', 'o']) {
      add(`W${k}_${l}`, c.d * c.d, ['w', c.d, c.d], true);
      add(`b${k}_${l}`, c.d, 0);
    }
    add(`g2_${l}`, c.d, 1);
    add(`b2_${l}`, c.d, 0);
    add(`W1_${l}`, c.ffn * c.d, ['w', c.d, c.ffn], true);
    add(`c1_${l}`, c.ffn, 0);
    add(`W2_${l}`, c.d * c.ffn, ['w', c.ffn, c.d], true);
    add(`c2_${l}`, c.d, 0);
  }
  add('gf', c.d, 1);
  add('bf', c.d, 0);
  add('Wr', c.experts * c.d, ['n', 0.02], true);
  add('br', c.experts, 0);
  add('prior', 1, 2);
  add('We', c.experts * c.expertHidden * c.d, ['w', c.d, c.expertHidden], true);
  add('be', c.experts * c.expertHidden, 0);
  add('we', c.experts * c.expertHidden, ['w', c.expertHidden, 1], true);
  add('ce', c.experts, 0);
  add('wp', c.d, ['w', c.d, 1], true);
  add('bp', 1, 0);
  return spec;
}

function views(theta, spec) {
  const out = {};
  let o = 0;
  for (const s of spec) {
    out[s.name] = theta.subarray(o, o + s.n);
    o += s.n;
  }
  return out;
}

// ---- building blocks (row-major: a T×n matrix is T rows of n numbers) ----------------------
function linear(X, T, nIn, nOut, W, b) {
  const Y = new Float64Array(T * nOut);
  for (let t = 0; t < T; t++) {
    const xo = t * nIn;
    const yo = t * nOut;
    for (let o = 0; o < nOut; o++) {
      let z = b[o];
      const row = o * nIn;
      for (let i = 0; i < nIn; i++) z += W[row + i] * X[xo + i];
      Y[yo + o] = z;
    }
  }
  return Y;
}

function linearBack(dY, X, T, nIn, nOut, W, dW, db) {
  const dX = new Float64Array(T * nIn);
  for (let t = 0; t < T; t++) {
    const xo = t * nIn;
    const yo = t * nOut;
    for (let o = 0; o < nOut; o++) {
      const g = dY[yo + o];
      if (g === 0) continue;
      db[o] += g;
      const row = o * nIn;
      for (let i = 0; i < nIn; i++) {
        dW[row + i] += g * X[xo + i];
        dX[xo + i] += g * W[row + i];
      }
    }
  }
  return dX;
}

function layerNorm(X, T, d, g, b) {
  const Y = new Float64Array(T * d);
  const nhat = new Float64Array(T * d);
  const inv = new Float64Array(T);
  for (let t = 0; t < T; t++) {
    const o = t * d;
    let mu = 0;
    for (let i = 0; i < d; i++) mu += X[o + i];
    mu /= d;
    let v = 0;
    for (let i = 0; i < d; i++) v += (X[o + i] - mu) ** 2;
    const k = 1 / Math.sqrt(v / d + EPS);
    inv[t] = k;
    for (let i = 0; i < d; i++) {
      const n = (X[o + i] - mu) * k;
      nhat[o + i] = n;
      Y[o + i] = g[i] * n + b[i];
    }
  }
  return { Y, nhat, inv };
}

function layerNormBack(dY, ln, T, d, g, dg, db) {
  const dX = new Float64Array(T * d);
  for (let t = 0; t < T; t++) {
    const o = t * d;
    let m1 = 0;
    let m2 = 0;
    for (let i = 0; i < d; i++) {
      const dn = dY[o + i] * g[i];
      dg[i] += dY[o + i] * ln.nhat[o + i];
      db[i] += dY[o + i];
      m1 += dn;
      m2 += dn * ln.nhat[o + i];
    }
    m1 /= d;
    m2 /= d;
    for (let i = 0; i < d; i++) dX[o + i] = ln.inv[t] * (dY[o + i] * g[i] - m1 - ln.nhat[o + i] * m2);
  }
  return dX;
}

export class DeepNet {
  constructor(config = {}, { seed = 1 } = {}) {
    this.c = { ...DEFAULTS, ...config };
    if (this.c.d % this.c.heads) throw new Error('d must divide by heads');
    this.spec = layout(this.c);
    this.size = this.spec.reduce((s, x) => s + x.n, 0);
    this.theta = new Float64Array(this.size);
    this.p = views(this.theta, this.spec);
    const rng = mulberry32(seed);
    for (const s of this.spec) {
      const v = this.p[s.name];
      if (typeof s.init === 'number') v.fill(s.init);
      else if (s.init[0] === 'n') for (let i = 0; i < v.length; i++) v[i] = gaussian(rng) * s.init[1];
      else {
        const sd = Math.sqrt(2 / (s.init[1] + s.init[2]));
        for (let i = 0; i < v.length; i++) v[i] = gaussian(rng) * sd;
      }
    }
    // The scaler for the senses (set when trained) and the per-desk win/loss sizes.
    this.scaler = null;
  }

  newGrad() {
    const g = new Float64Array(this.size);
    return { flat: g, v: views(g, this.spec) };
  }

  // A mask over theta: 1 where weight decay applies (the weight matrices).
  decayMask() {
    const m = new Uint8Array(this.size);
    let o = 0;
    for (const s of this.spec) {
      if (s.decay) m.fill(1, o, o + s.n);
      o += s.n;
    }
    return m;
  }

  // ex: { tok (Float64Array nC×feats), slots (nC ints), x (senses, already scaled) or null,
  // market (0..experts-1) }. mode 'trade' adds the idea token and answers with the experts;
  // 'pretrain' reads the candles only and answers "higher in 15 minutes?" from the last one.
  forward(ex, mode = 'trade') {
    const c = this.c;
    const d = c.d;
    const P = this.p;
    const nC = ex.slots.length;
    const idea = mode === 'trade';
    const T = nC + (idea ? 1 : 0);
    if (!T) throw new Error('nothing to read');
    const X0 = new Float64Array(T * d);
    for (let t = 0; t < nC; t++) {
      const fo = t * c.feats;
      const po = ex.slots[t] * d;
      for (let o = 0; o < d; o++) {
        let z = P.bc[o] + P.P[po + o];
        const row = o * c.feats;
        for (let i = 0; i < c.feats; i++) z += P.Wc[row + i] * ex.tok[fo + i];
        X0[t * d + o] = z;
      }
    }
    if (idea) {
      const po = (c.slots - 1) * d;
      for (let o = 0; o < d; o++) {
        let z = P.bi[o] + P.P[po + o];
        if (ex.x) {
          const row = o * c.senses;
          for (let i = 0; i < c.senses; i++) z += P.Wi[row + i] * ex.x[i];
        }
        X0[nC * d + o] = z;
      }
    }
    const cache = { ex, mode, T, nC, idea, layers: [] };
    let H = X0;
    const dh = d / c.heads;
    const scale = 1 / Math.sqrt(dh);
    // Nobody reads the idea token but the idea itself.
    const allowed = (i, j) => !(idea && j === T - 1 && i !== T - 1);
    for (let l = 0; l < c.layers; l++) {
      const ln1 = layerNorm(H, T, d, P[`g1_${l}`], P[`b1_${l}`]);
      const Q = linear(ln1.Y, T, d, d, P[`Wq_${l}`], P[`bq_${l}`]);
      const K = linear(ln1.Y, T, d, d, P[`Wk_${l}`], P[`bk_${l}`]);
      const V = linear(ln1.Y, T, d, d, P[`Wv_${l}`], P[`bv_${l}`]);
      const alpha = new Float64Array(c.heads * T * T);
      const O = new Float64Array(T * d);
      for (let h = 0; h < c.heads; h++) {
        const ho = h * dh;
        for (let i = 0; i < T; i++) {
          const ao = (h * T + i) * T;
          let mx = -Infinity;
          for (let j = 0; j < T; j++) {
            if (!allowed(i, j)) continue;
            let s = 0;
            for (let k = 0; k < dh; k++) s += Q[i * d + ho + k] * K[j * d + ho + k];
            s *= scale;
            alpha[ao + j] = s;
            if (s > mx) mx = s;
          }
          let sum = 0;
          for (let j = 0; j < T; j++) {
            if (!allowed(i, j)) { alpha[ao + j] = 0; continue; }
            const e = Math.exp(alpha[ao + j] - mx);
            alpha[ao + j] = e;
            sum += e;
          }
          for (let j = 0; j < T; j++) alpha[ao + j] /= sum;
          for (let j = 0; j < T; j++) {
            const a = alpha[ao + j];
            if (!a) continue;
            for (let k = 0; k < dh; k++) O[i * d + ho + k] += a * V[j * d + ho + k];
          }
        }
      }
      const Z = linear(O, T, d, d, P[`Wo_${l}`], P[`bo_${l}`]);
      const X1 = new Float64Array(T * d);
      for (let i = 0; i < T * d; i++) X1[i] = H[i] + Z[i];
      const ln2 = layerNorm(X1, T, d, P[`g2_${l}`], P[`b2_${l}`]);
      const U = linear(ln2.Y, T, d, c.ffn, P[`W1_${l}`], P[`c1_${l}`]);
      const G = new Float64Array(U.length);
      for (let i = 0; i < U.length; i++) G[i] = gelu(U[i]);
      const Y = linear(G, T, c.ffn, d, P[`W2_${l}`], P[`c2_${l}`]);
      const Hn = new Float64Array(T * d);
      for (let i = 0; i < T * d; i++) Hn[i] = X1[i] + Y[i];
      cache.layers.push({ H, ln1, Q, K, V, alpha, O, X1, ln2, U, G });
      H = Hn;
    }
    cache.HL = H;
    cache.lnf = layerNorm(H, T, d, P.gf, P.bf);
    const h = cache.lnf.Y.subarray((T - 1) * d, T * d);
    cache.h = h;
    if (!idea) {
      let z = P.bp[0];
      for (let i = 0; i < d; i++) z += P.wp[i] * h[i];
      cache.logit = z;
      cache.p = sigmoid(z);
      return cache;
    }
    // The router and the experts.
    const E = c.experts;
    const HH = c.expertHidden;
    const r = new Float64Array(E);
    let mx = -Infinity;
    for (let e = 0; e < E; e++) {
      let z = P.br[e] + (e === ex.market ? P.prior[0] : 0);
      for (let i = 0; i < d; i++) z += P.Wr[e * d + i] * h[i];
      r[e] = z;
      if (z > mx) mx = z;
    }
    const gates = new Float64Array(E);
    let sum = 0;
    for (let e = 0; e < E; e++) { gates[e] = Math.exp(r[e] - mx); sum += gates[e]; }
    for (let e = 0; e < E; e++) gates[e] /= sum;
    const u = new Float64Array(E * HH);
    const a = new Float64Array(E * HH);
    const z = new Float64Array(E);
    let logit = 0;
    for (let e = 0; e < E; e++) {
      let ze = P.ce[e];
      for (let k = 0; k < HH; k++) {
        const row = (e * HH + k) * d;
        let s = P.be[e * HH + k];
        for (let i = 0; i < d; i++) s += P.We[row + i] * h[i];
        u[e * HH + k] = s;
        a[e * HH + k] = gelu(s);
        ze += P.we[e * HH + k] * a[e * HH + k];
      }
      z[e] = ze;
      logit += gates[e] * ze;
    }
    Object.assign(cache, { gates, u, a, z, logit, p: sigmoid(logit) });
    return cache;
  }

  // Gradients of the loss for dLogit (the loss's slope at the logit), added into grad.v.
  backward(cache, dLogit, grad) {
    const c = this.c;
    const d = c.d;
    const P = this.p;
    const G = grad.v;
    const { T, nC, idea, ex } = cache;
    const h = cache.h;
    const dh = new Float64Array(d);
    if (!idea) {
      G.bp[0] += dLogit;
      for (let i = 0; i < d; i++) { G.wp[i] += dLogit * h[i]; dh[i] += dLogit * P.wp[i]; }
    } else {
      const E = c.experts;
      const HH = c.expertHidden;
      const { gates, u, a, z } = cache;
      const dg = new Float64Array(E);
      let gdg = 0;
      for (let e = 0; e < E; e++) {
        const dz = dLogit * gates[e];
        dg[e] = dLogit * z[e];
        gdg += gates[e] * dg[e];
        G.ce[e] += dz;
        for (let k = 0; k < HH; k++) {
          const q = e * HH + k;
          G.we[q] += dz * a[q];
          const du = dz * P.we[q] * geluGrad(u[q]);
          G.be[q] += du;
          const row = q * d;
          for (let i = 0; i < d; i++) {
            G.We[row + i] += du * h[i];
            dh[i] += du * P.We[row + i];
          }
        }
      }
      for (let e = 0; e < E; e++) {
        const dr = gates[e] * (dg[e] - gdg);
        G.br[e] += dr;
        if (e === ex.market) G.prior[0] += dr;
        for (let i = 0; i < d; i++) {
          G.Wr[e * d + i] += dr * h[i];
          dh[i] += dr * P.Wr[e * d + i];
        }
      }
    }
    // Back through the final norm (only the last token's output was used).
    const dF = new Float64Array(T * d);
    dF.set(dh, (T - 1) * d);
    let dH = layerNormBack(dF, cache.lnf, T, d, P.gf, G.gf, G.bf);
    const dhd = d / c.heads;
    const scale = 1 / Math.sqrt(dhd);
    for (let l = c.layers - 1; l >= 0; l--) {
      const L = cache.layers[l];
      // H_next = X1 + FFN(LN2(X1))
      const dY = dH;
      const dG = linearBack(dY, L.G, T, c.ffn, d, P[`W2_${l}`], G[`W2_${l}`], G[`c2_${l}`]);
      const dU = new Float64Array(dG.length);
      for (let i = 0; i < dG.length; i++) dU[i] = dG[i] * geluGrad(L.U[i]);
      const dB = linearBack(dU, L.ln2.Y, T, d, c.ffn, P[`W1_${l}`], G[`W1_${l}`], G[`c1_${l}`]);
      const dX1 = layerNormBack(dB, L.ln2, T, d, P[`g2_${l}`], G[`g2_${l}`], G[`b2_${l}`]);
      for (let i = 0; i < T * d; i++) dX1[i] += dY[i];
      // X1 = H + Attn(LN1(H))
      const dO = linearBack(dX1, L.O, T, d, d, P[`Wo_${l}`], G[`Wo_${l}`], G[`bo_${l}`]);
      const dQ = new Float64Array(T * d);
      const dK = new Float64Array(T * d);
      const dV = new Float64Array(T * d);
      const da = new Float64Array(T);
      for (let hh = 0; hh < c.heads; hh++) {
        const ho = hh * dhd;
        for (let i = 0; i < T; i++) {
          const ao = (hh * T + i) * T;
          let s = 0;
          for (let j = 0; j < T; j++) {
            const al = L.alpha[ao + j];
            if (!al) { da[j] = 0; continue; }
            let v = 0;
            for (let k = 0; k < dhd; k++) {
              v += dO[i * d + ho + k] * L.V[j * d + ho + k];
              dV[j * d + ho + k] += al * dO[i * d + ho + k];
            }
            da[j] = v;
            s += al * v;
          }
          for (let j = 0; j < T; j++) {
            const al = L.alpha[ao + j];
            if (!al) continue;
            const ds = al * (da[j] - s) * scale;
            for (let k = 0; k < dhd; k++) {
              dQ[i * d + ho + k] += ds * L.K[j * d + ho + k];
              dK[j * d + ho + k] += ds * L.Q[i * d + ho + k];
            }
          }
        }
      }
      const dA = linearBack(dQ, L.ln1.Y, T, d, d, P[`Wq_${l}`], G[`Wq_${l}`], G[`bq_${l}`]);
      const dAk = linearBack(dK, L.ln1.Y, T, d, d, P[`Wk_${l}`], G[`Wk_${l}`], G[`bk_${l}`]);
      const dAv = linearBack(dV, L.ln1.Y, T, d, d, P[`Wv_${l}`], G[`Wv_${l}`], G[`bv_${l}`]);
      for (let i = 0; i < T * d; i++) dA[i] += dAk[i] + dAv[i];
      const dHin = layerNormBack(dA, L.ln1, T, d, P[`g1_${l}`], G[`g1_${l}`], G[`b1_${l}`]);
      for (let i = 0; i < T * d; i++) dHin[i] += dX1[i];
      dH = dHin;
    }
    // Into the embeddings.
    for (let t = 0; t < nC; t++) {
      const fo = t * c.feats;
      const po = ex.slots[t] * d;
      for (let o = 0; o < d; o++) {
        const g = dH[t * d + o];
        G.bc[o] += g;
        G.P[po + o] += g;
        const row = o * c.feats;
        for (let i = 0; i < c.feats; i++) G.Wc[row + i] += g * ex.tok[fo + i];
      }
    }
    if (idea) {
      const po = (c.slots - 1) * d;
      for (let o = 0; o < d; o++) {
        const g = dH[nC * d + o];
        G.bi[o] += g;
        G.P[po + o] += g;
        if (ex.x) {
          const row = o * c.senses;
          for (let i = 0; i < c.senses; i++) G.Wi[row + i] += g * ex.x[i];
        }
      }
    }
  }

  // What the idea token looked at: [layer][head][candle] weights (the idea's own slot left out).
  attention(cache) {
    const { T, nC } = cache;
    if (!cache.idea) return [];
    return cache.layers.map((L) => Array.from({ length: this.c.heads }, (_, h) => Array.from({ length: nC }, (_, j) => L.alpha[(h * T + T - 1) * T + j])));
  }

  predict(ex) {
    return this.forward(ex, 'trade').p;
  }

  toJSON() {
    return { v: MODEL_V, config: this.c, theta: Array.from(this.theta, (x) => Math.round(x * 1e7) / 1e7), scaler: this.scaler };
  }

  static from(json) {
    if (!json || json.v !== MODEL_V || !Array.isArray(json.theta)) throw new Error('not a saved deep brain');
    const net = new DeepNet(json.config);
    if (json.theta.length !== net.size) throw new Error('the saved deep brain has a different shape');
    net.theta.set(json.theta);
    net.scaler = json.scaler || null;
    return net;
  }
}

// AdamW with global-norm gradient clipping.
export class Adam {
  constructor(net, { lr = 2e-3, wd = 1e-4, b1 = 0.9, b2 = 0.999, clip = 1 } = {}) {
    Object.assign(this, { net, lr, wd, b1, b2, clip, t: 0 });
    this.m = new Float64Array(net.size);
    this.v = new Float64Array(net.size);
    this.mask = net.decayMask();
  }

  step(grad, n = 1) {
    const g = grad.flat;
    let norm = 0;
    for (let i = 0; i < g.length; i++) { g[i] /= n; norm += g[i] * g[i]; }
    norm = Math.sqrt(norm);
    const k = norm > this.clip ? this.clip / norm : 1;
    this.t++;
    const c1 = 1 - this.b1 ** this.t;
    const c2 = 1 - this.b2 ** this.t;
    const th = this.net.theta;
    for (let i = 0; i < g.length; i++) {
      const gi = g[i] * k;
      this.m[i] = this.b1 * this.m[i] + (1 - this.b1) * gi;
      this.v[i] = this.b2 * this.v[i] + (1 - this.b2) * gi * gi;
      if (this.mask[i]) th[i] -= this.lr * this.wd * th[i];
      th[i] -= (this.lr * (this.m[i] / c1)) / (Math.sqrt(this.v[i] / c2) + 1e-8);
    }
    g.fill(0);
    return norm;
  }
}

export { sigmoid };
