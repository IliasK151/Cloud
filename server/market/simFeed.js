import { SYMBOLS, roundToTick } from './symbols.js';
import { nyMinuteOfDay } from './session.js';

// Regime-switching market simulator.
// Each instrument alternates between trends, mean-reverting ranges, volatility
// squeezes and breakouts, with volatility clustering and occasional stop-run spikes.
// ETH and SOL load on a common crypto factor (BTC) so the stat-arb desk has a real spread.

const TRADING_SECONDS_PER_YEAR = 252 * 23_400;

export function mulberry32(seed) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function gaussian(rng) {
  let u = 0;
  while (u === 0) u = rng();
  return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * rng());
}

const uniform = (rng, a, b) => a + (b - a) * rng();

class RegimeProcess {
  constructor(sigmaSec, rng, { trendy = 1, rangeOnly = false } = {}) {
    this.sigma = sigmaSec;
    this.rng = rng;
    this.trendy = trendy;
    this.rangeOnly = rangeOnly;
    this.level = 0; // log-price offset driven by this process
    this.volLog = 0; // volatility clustering state
    this.jumpDecay = 0;
    this.#enter(rangeOnly || rng() < 0.5 ? 'range' : 'trend');
  }

  #enter(type, dir) {
    const r = this.rng;
    this.type = type;
    this.dir = dir ?? (r() < 0.5 ? 1 : -1);
    this.anchor = this.level;
    if (type === 'trend') {
      this.remaining = uniform(r, 20, 70) * 60;
      this.drift = this.dir * uniform(r, 0.02, 0.05) * this.sigma * this.trendy;
      this.volMult = uniform(r, 0.9, 1.25);
      this.kappa = 0;
    } else if (type === 'range') {
      this.remaining = uniform(r, 25, 80) * 60;
      this.drift = 0;
      this.volMult = uniform(r, 0.8, 1.05);
      this.kappa = Math.LN2 / (uniform(r, 6, 14) * 60);
    } else if (type === 'squeeze') {
      this.remaining = uniform(r, 14, 30) * 60;
      this.drift = 0;
      this.volMult = uniform(r, 0.4, 0.55);
      this.kappa = Math.LN2 / (4 * 60);
    } else if (type === 'breakout') {
      this.remaining = uniform(r, 5, 12) * 60;
      this.drift = this.dir * uniform(r, 0.07, 0.11) * this.sigma;
      this.volMult = uniform(r, 1.4, 1.9);
      this.kappa = 0;
    }
  }

  #next() {
    if (this.rangeOnly) return this.#enter('range');
    const r = this.rng();
    switch (this.type) {
      case 'trend':
        if (r < 0.55) return this.#enter('range');
        if (r < 0.8) return this.#enter('squeeze');
        return this.#enter('trend', -this.dir);
      case 'range':
        if (r < 0.5) return this.#enter('trend');
        if (r < 0.85) return this.#enter('squeeze');
        return this.#enter('range');
      case 'squeeze':
        return this.#enter('breakout');
      case 'breakout':
        return this.#enter('trend', this.dir);
      default:
        return this.#enter('range');
    }
  }

  // Returns a log-return for `dt` seconds. `shock` lets callers inject a correlated normal draw.
  step(dt, sessionVol = 1, shock = null) {
    const r = this.rng;
    this.remaining -= dt;
    if (this.remaining <= 0) this.#next();

    // Volatility clustering: slow OU in log-vol space.
    this.volLog += -0.002 * this.volLog * dt + 0.02 * Math.sqrt(dt) * gaussian(r);
    const vol = this.sigma * this.volMult * Math.exp(this.volLog) * sessionVol;

    const z = shock ?? gaussian(r);
    let ret = this.drift * dt + vol * Math.sqrt(dt) * z;
    if (this.kappa > 0) ret += -this.kappa * (this.level - this.anchor) * dt;

    // Occasional liquidity spikes (stop runs) that partially retrace.
    if (r() < dt / (45 * 60)) {
      const sigmaMin = this.sigma * Math.sqrt(60);
      this.jumpDecay = (r() < 0.5 ? 1 : -1) * uniform(r, 2.2, 4) * sigmaMin;
      ret += this.jumpDecay;
    } else if (this.jumpDecay !== 0) {
      const give = this.jumpDecay * Math.min(1, dt / 240) * 0.6;
      ret -= give;
      this.jumpDecay -= give / 0.6;
      if (Math.abs(this.jumpDecay) < 1e-9) this.jumpDecay = 0;
    }

    this.level += ret;
    return ret;
  }
}

export class SimFeed {
  constructor(md, clock, symbolIds, { seed = Date.now() % 1e9, startPrices = {}, useSessionShape = true } = {}) {
    this.md = md;
    this.clock = clock;
    this.ids = symbolIds;
    this.rng = mulberry32(seed);
    this.useSessionShape = useSessionShape;
    this.state = new Map();
    for (const id of symbolIds) this.#addState(id, startPrices[id]);
  }

  #addState(id, startPrice) {
    const sym = SYMBOLS[id];
    const sigma = sym.annualVol / Math.sqrt(TRADING_SECONDS_PER_YEAR);
    const price = Number.isFinite(startPrice) && startPrice > 0 ? startPrice : sym.seedPrice;
    const st = { id, sym, sigma, logPrice: Math.log(price), process: new RegimeProcess(sigma, this.rng) };
    // ETH and SOL: beta to BTC plus a mean-reverting idiosyncratic spread.
    if (id === 'ETHUSD' || id === 'SOLUSD') {
      const rho = id === 'ETHUSD' ? 0.82 : 0.7;
      const btcSigma = SYMBOLS.BTCUSD.annualVol / Math.sqrt(TRADING_SECONDS_PER_YEAR);
      st.rho = rho;
      st.beta = (rho * sigma) / btcSigma;
      // ETH's idiosyncratic spread is mean-reverting (what stat-arb desks bet on); SOL's can trend.
      st.process = new RegimeProcess(sigma * Math.sqrt(1 - rho * rho), this.rng, { rangeOnly: id === 'ETHUSD' });
    }
    this.state.set(id, st);
  }

  #sessionVol(ms) {
    if (!this.useSessionShape) return 1;
    const m = nyMinuteOfDay(ms);
    if (m < 570 || m > 960) return 0.7;
    const open = Math.exp(-(m - 570) / 35);
    const close = Math.exp(-(960 - m) / 30);
    return 0.85 + 0.9 * open + 0.45 * close;
  }

  // Generate `minutes` of history ending at the current market time.
  warmup(minutes = 420) {
    const end = this.clock.now();
    let t = end - minutes * 60_000;
    while (t < end) {
      const next = Math.min(end, t + 5_000);
      this.#advance(t, next, 5);
      t = next;
    }
  }

  step(fromMs, toMs) {
    const total = (toMs - fromMs) / 1000;
    if (total <= 0) return;
    const n = Math.max(1, Math.ceil(total));
    this.#advance(fromMs, toMs, total / n);
  }

  #advance(fromMs, toMs, dtSec) {
    let t = fromMs;
    while (t < toMs - 1) {
      t = Math.min(toMs, t + dtSec * 1000);
      const sv = this.#sessionVol(t);
      let btcShock = gaussian(this.rng);
      let btcRet = 0;
      const btc = this.state.get('BTCUSD');
      if (btc) btcRet = btc.process.step(dtSec, sv, btcShock);
      else btcRet = btcShock * (SYMBOLS.BTCUSD.annualVol / Math.sqrt(TRADING_SECONDS_PER_YEAR)) * Math.sqrt(dtSec);
      for (const st of this.state.values()) {
        let ret;
        if (st.id === 'BTCUSD') ret = btcRet;
        else if (st.beta) ret = st.beta * btcRet + st.process.step(dtSec, sv);
        else ret = st.process.step(dtSec, sv);
        st.logPrice += ret;
        const price = roundToTick(st.id, Math.exp(st.logPrice));
        const sigmaStep = st.sigma * Math.sqrt(dtSec) || 1e-9;
        const activity = 1 + 2 * Math.min(4, Math.abs(ret) / sigmaStep);
        const volume = (st.sym.baseVolume / 60) * dtSec * sv * activity * Math.exp(0.5 * gaussian(this.rng) - 0.125);
        this.md.applyTick(st.id, price, volume, t, 'sim');
      }
    }
  }

  // Overnight gap between simulated sessions.
  gap(fromMs, toMs) {
    const hours = (toMs - fromMs) / 3_600_000;
    for (const st of this.state.values()) {
      const sd = st.sigma * Math.sqrt(hours * 3600) * 0.35;
      st.logPrice += sd * gaussian(this.rng);
      st.process.level = 0;
      st.process.anchor = 0;
    }
  }
}
