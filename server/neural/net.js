import { mulberry32 } from '../util/random.js';

// A small neural network, written out in full so nothing is hidden: inputs → two hidden layers
// (tanh) → one output (the chance a trade works, 0 to 1). Each connection is one learned number
// (a weight); the 3D Brain view draws them as the lines between the neurons.
//
// Trained with Adam on binary cross-entropy, with weight decay (L2) and early stopping on a
// validation set held out by time: the network keeps the weights that did best on trades it
// didn't train on, not the ones that memorised its training trades. Seeded, so the same data
// trains the same brain.

const sigmoid = (z) => 1 / (1 + Math.exp(-Math.max(-35, Math.min(35, z))));

export class Net {
  // sizes: [inputs, hidden1, hidden2, 1]
  constructor(sizes, { seed = 1 } = {}) {
    this.sizes = sizes;
    const rng = mulberry32(seed);
    // Xavier/Glorot initialisation: small random weights scaled to each layer's size.
    const gauss = () => {
      const u = Math.max(1e-12, rng());
      return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * rng());
    };
    this.W = [];
    this.b = [];
    for (let l = 0; l < sizes.length - 1; l++) {
      const nIn = sizes[l];
      const nOut = sizes[l + 1];
      const s = Math.sqrt(2 / (nIn + nOut));
      this.W.push(Float64Array.from({ length: nIn * nOut }, () => gauss() * s));
      this.b.push(new Float64Array(nOut));
    }
  }

  get layers() {
    return this.W.length;
  }

  // Every layer's activations for input x (acts[0] = x, last = [p]).
  forward(x) {
    const acts = [x];
    let h = x;
    for (let l = 0; l < this.layers; l++) {
      const nIn = this.sizes[l];
      const nOut = this.sizes[l + 1];
      const W = this.W[l];
      const out = new Float64Array(nOut);
      for (let j = 0; j < nOut; j++) {
        let z = this.b[l][j];
        const row = j * nIn;
        for (let i = 0; i < nIn; i++) z += W[row + i] * h[i];
        out[j] = l === this.layers - 1 ? sigmoid(z) : Math.tanh(z);
      }
      acts.push(out);
      h = out;
    }
    return acts;
  }

  predict(x) {
    return this.forward(x)[this.layers][0];
  }

  // Train on rows X (arrays of inputs), labels y (0/1), optional sample weights w.
  // Returns { epochs, best: { epoch, valLoss }, history }.
  train(X, y, { w = null, valX = null, valY = null, epochs = 200, lr = 0.003, batch = 64, l2 = 1e-4, patience = 20, seed = 1 } = {}) {
    const rng = mulberry32(seed + 7);
    const L = this.layers;
    const mW = this.W.map((a) => new Float64Array(a.length));
    const vW = this.W.map((a) => new Float64Array(a.length));
    const mb = this.b.map((a) => new Float64Array(a.length));
    const vb = this.b.map((a) => new Float64Array(a.length));
    const gW = this.W.map((a) => new Float64Array(a.length));
    const gb = this.b.map((a) => new Float64Array(a.length));
    const b1 = 0.9;
    const b2 = 0.999;
    let t = 0;
    const order = Array.from({ length: X.length }, (_, i) => i);
    const history = [];
    let best = { epoch: -1, valLoss: Infinity, W: null, b: null };
    const snapshot = () => ({ W: this.W.map((a) => Float64Array.from(a)), b: this.b.map((a) => Float64Array.from(a)) });

    for (let epoch = 0; epoch < epochs; epoch++) {
      for (let i = order.length - 1; i > 0; i--) {
        const j = Math.floor(rng() * (i + 1));
        [order[i], order[j]] = [order[j], order[i]];
      }
      let trainLoss = 0;
      for (let s = 0; s < order.length; s += batch) {
        for (const g of gW) g.fill(0);
        for (const g of gb) g.fill(0);
        let wsum = 0;
        const end = Math.min(order.length, s + batch);
        for (let k = s; k < end; k++) {
          const idx = order[k];
          const wt = w ? w[idx] : 1;
          wsum += wt;
          const acts = this.forward(X[idx]);
          const p = acts[L][0];
          trainLoss += wt * -(y[idx] ? Math.log(Math.max(p, 1e-12)) : Math.log(Math.max(1 - p, 1e-12)));
          // Backpropagation: the output error, then each layer's share of it.
          let delta = new Float64Array([(p - y[idx]) * wt]);
          for (let l = L - 1; l >= 0; l--) {
            const nIn = this.sizes[l];
            const nOut = this.sizes[l + 1];
            const hIn = acts[l];
            const W = this.W[l];
            const prev = l > 0 ? new Float64Array(nIn) : null;
            for (let j = 0; j < nOut; j++) {
              const d = delta[j];
              if (d === 0) continue;
              gb[l][j] += d;
              const row = j * nIn;
              for (let i = 0; i < nIn; i++) {
                gW[l][row + i] += d * hIn[i];
                if (prev) prev[i] += d * W[row + i];
              }
            }
            if (prev) {
              for (let i = 0; i < nIn; i++) prev[i] *= 1 - hIn[i] * hIn[i]; // tanh'
              delta = prev;
            }
          }
        }
        // Adam step.
        t++;
        const c1 = 1 - b1 ** t;
        const c2 = 1 - b2 ** t;
        const scale = 1 / Math.max(1e-9, wsum);
        for (let l = 0; l < L; l++) {
          const W = this.W[l];
          for (let i = 0; i < W.length; i++) {
            const g = gW[l][i] * scale + l2 * W[i];
            mW[l][i] = b1 * mW[l][i] + (1 - b1) * g;
            vW[l][i] = b2 * vW[l][i] + (1 - b2) * g * g;
            W[i] -= (lr * (mW[l][i] / c1)) / (Math.sqrt(vW[l][i] / c2) + 1e-8);
          }
          const B = this.b[l];
          for (let j = 0; j < B.length; j++) {
            const g = gb[l][j] * scale;
            mb[l][j] = b1 * mb[l][j] + (1 - b1) * g;
            vb[l][j] = b2 * vb[l][j] + (1 - b2) * g * g;
            B[j] -= (lr * (mb[l][j] / c1)) / (Math.sqrt(vb[l][j] / c2) + 1e-8);
          }
        }
      }
      const totalW = w ? w.reduce((a, b) => a + b, 0) : X.length;
      const rec = { epoch, trainLoss: trainLoss / Math.max(1e-9, totalW) };
      if (valX?.length) {
        rec.valLoss = logLoss(valY, valX.map((v) => this.predict(v)));
        if (rec.valLoss < best.valLoss - 1e-5) best = { epoch, valLoss: rec.valLoss, ...snapshot() };
        else if (epoch - best.epoch >= patience) {
          history.push(rec);
          break;
        }
      }
      history.push(rec);
    }
    if (best.W) {
      this.W = best.W;
      this.b = best.b;
    }
    return { epochs: history.length, best: { epoch: best.epoch, valLoss: best.valLoss }, history };
  }

  // How much each connection carried for input x: activation × weight, per layer. The 3D
  // view lights the lines by this; positive pushes towards "trade", negative away from it.
  flows(x) {
    const acts = this.forward(x);
    const out = [];
    for (let l = 0; l < this.layers; l++) {
      const nIn = this.sizes[l];
      const nOut = this.sizes[l + 1];
      const f = new Float64Array(nIn * nOut);
      for (let j = 0; j < nOut; j++) for (let i = 0; i < nIn; i++) f[j * nIn + i] = acts[l][i] * this.W[l][j * nIn + i];
      out.push(f);
    }
    return { acts, flows: out };
  }

  toJSON() {
    const r = (a) => Array.from(a, (v) => Math.round(v * 1e6) / 1e6);
    return { sizes: this.sizes, W: this.W.map(r), b: this.b.map(r) };
  }

  static from(json) {
    if (!json || !Array.isArray(json.sizes) || !Array.isArray(json.W) || !Array.isArray(json.b)) throw new Error('not a saved network');
    const net = new Net(json.sizes);
    if (json.W.length !== net.layers || json.b.length !== net.layers) throw new Error('layer count mismatch');
    net.W = json.W.map((a, l) => {
      if (a.length !== net.sizes[l] * net.sizes[l + 1] || !a.every(Number.isFinite)) throw new Error(`layer ${l} weights are damaged`);
      return Float64Array.from(a);
    });
    net.b = json.b.map((a, l) => {
      if (a.length !== net.sizes[l + 1] || !a.every(Number.isFinite)) throw new Error(`layer ${l} biases are damaged`);
      return Float64Array.from(a);
    });
    return net;
  }
}

// ---- how good is a set of predictions? --------------------------------------------------------

export function logLoss(y, p) {
  let s = 0;
  for (let i = 0; i < y.length; i++) s += -(y[i] ? Math.log(Math.max(p[i], 1e-12)) : Math.log(Math.max(1 - p[i], 1e-12)));
  return y.length ? s / y.length : NaN;
}

// Area under the ROC curve: the chance a random winner is scored above a random loser
// (0.5 = no better than a coin, 1 = perfect). Optional weights w count some examples more
// (ties count half).
export function auc(y, p, w = null) {
  const idx = p.map((v, i) => i).sort((a, b) => p[a] - p[b]);
  let negBelow = 0;
  let sum = 0;
  let wPos = 0;
  let wNeg = 0;
  for (let k = 0; k < idx.length;) {
    let e = k;
    while (e + 1 < idx.length && p[idx[e + 1]] === p[idx[k]]) e++;
    let gp = 0;
    let gn = 0;
    for (let q = k; q <= e; q++) {
      const wt = w ? w[idx[q]] : 1;
      if (y[idx[q]]) gp += wt;
      else gn += wt;
    }
    sum += gp * (negBelow + gn / 2);
    negBelow += gn;
    wPos += gp;
    wNeg += gn;
    k = e + 1;
  }
  if (!wPos || !wNeg) return NaN;
  return sum / (wPos * wNeg);
}

// Calibration: when the brain says 60%, do those trades win about 60% of the time?
export function calibration(y, p, bins = 5) {
  const out = [];
  for (let b = 0; b < bins; b++) {
    const lo = b / bins;
    const hi = (b + 1) / bins;
    const idx = p.map((v, i) => i).filter((i) => p[i] >= lo && (p[i] < hi || (b === bins - 1 && p[i] <= 1)));
    if (!idx.length) continue;
    out.push({ from: lo, to: hi, n: idx.length, said: idx.reduce((s, i) => s + p[i], 0) / idx.length, won: idx.reduce((s, i) => s + y[i], 0) / idx.length });
  }
  return out;
}

// Standardise inputs with the training set's mean and spread (stored with the brain).
export function scaler(X) {
  const n = X[0]?.length || 0;
  const mean = new Float64Array(n);
  const sd = new Float64Array(n);
  for (const x of X) for (let i = 0; i < n; i++) mean[i] += x[i] / X.length;
  for (const x of X) for (let i = 0; i < n; i++) sd[i] += (x[i] - mean[i]) ** 2 / X.length;
  for (let i = 0; i < n; i++) sd[i] = Math.sqrt(sd[i]) || 1;
  return { mean: Array.from(mean), sd: Array.from(sd) };
}

export const scale = (x, s) => Float64Array.from(x, (v, i) => (v - s.mean[i]) / s.sd[i]);
