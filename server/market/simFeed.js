import { SYMBOLS, roundToTick } from './symbols.js';
import { nyMinuteOfDay } from './session.js';
import { impactFor } from './calendar.js';
import { mulberry32, gaussian } from '../util/random.js';

// Regime-switching market simulator.
// Each instrument alternates between trends, mean-reverting ranges, volatility
// squeezes and breakouts, with volatility clustering and occasional stop-run spikes.
// ETH and SOL load on a common crypto factor (BTC) so the stat-arb desk has a real spread.

const TRADING_SECONDS_PER_YEAR = 252 * 23_400;

export { mulberry32 };

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
  constructor(md, clock, symbolIds, { seed = Date.now() % 1e9, startPrices = {}, useSessionShape = true, calendar = null, source = 'sim' } = {}) {
    this.md = md;
    this.clock = clock;
    this.ids = symbolIds;
    this.rng = mulberry32(seed);
    this.useSessionShape = useSessionShape;
    this.calendar = calendar; // economic releases move the simulated markets
    this.source = source;
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
      const next = Math.min(end, t + 60_000);
      this.#scheduleNews(t, next);
      for (let s = t; s < next; s += 5_000) this.#advance(s, Math.min(next, s + 5_000), 5);
      t = next;
    }
  }

  step(fromMs, toMs) {
    const total = (toMs - fromMs) / 1000;
    if (total <= 0) return;
    this.#scheduleNews(fromMs, toMs);
    const n = Math.max(1, Math.ceil(total));
    this.#advance(fromMs, toMs, total / n);
  }

  #scheduleNews(fromMs, toMs) {
    if (!this.calendar?.settings) return;
    for (const ev of this.calendar.releasedBetween(fromMs, toMs)) this.news(ev);
  }

  // A data release: the market jumps the way the surprise points (over ~40 seconds) and
  // volatility spikes, then fades over the next several minutes.
  news(ev, at = ev.time) {
    for (const st of this.state.values()) {
      const impact = impactFor(ev, st.id);
      if (!impact) continue;
      const high = impact === 'high';
      const z = Number.isFinite(ev.surprise) ? ev.surprise : Math.round(gaussian(this.rng));
      let dir = this.#reaction(ev, st.id) * Math.sign(z);
      if (!dir) dir = this.rng() < 0.5 ? 1 : -1;
      const sigmaMin = st.sigma * Math.sqrt(60);
      const size = (high ? 1.8 : 0.9) * (1 + 0.8 * Math.min(3, Math.abs(z))) * sigmaMin * (0.7 + 0.6 * this.rng());
      // ETH and SOL already follow BTC's jump through their beta.
      st.news = { t0: at, total: st.beta ? 0 : dir * size, applied: 0, secs: 40, boost: high ? 3.2 : 1.8, tau: high ? 420 : 240 };
    }
  }

  #reaction(ev, id) {
    if (ev.oil && id === 'USOIL') return ev.oil;
    const usd = ev.usd ?? 0;
    const risk = ev.risk ?? 0;
    if (id === 'EURUSD') return ev.currency === 'EUR' ? 1 : -usd;
    if (id === 'USDJPY') return ev.currency === 'JPY' ? -1 : usd;
    if (id === 'XAUUSD') return -usd;
    return risk; // indices, oil on macro data, crypto
  }

  #newsEffect(st, t, dtSec) {
    const n = st.news;
    if (!n || t < n.t0) return { vol: 1, jump: 0 };
    const age = (t - n.t0) / 1000;
    let jump = 0;
    if (n.applied !== n.total) {
      const want = n.total * Math.min(1, (age + dtSec) / n.secs);
      jump = want - n.applied;
      n.applied = want;
    }
    const vol = 1 + (n.boost - 1) * Math.exp(-age / n.tau);
    if (age > n.tau * 5) st.news = null;
    return { vol, jump };
  }

  #advance(fromMs, toMs, dtSec) {
    let t = fromMs;
    while (t < toMs - 1) {
      t = Math.min(toMs, t + dtSec * 1000);
      const sv = this.#sessionVol(t);
      let btcShock = gaussian(this.rng);
      let btcRet = 0;
      const btc = this.state.get('BTCUSD');
      const effects = new Map();
      for (const st of this.state.values()) if (st.news) effects.set(st, this.#newsEffect(st, t, dtSec));
      const fx = (st) => effects.get(st) || { vol: 1, jump: 0 };
      if (btc) btcRet = btc.process.step(dtSec, sv * fx(btc).vol, btcShock) + fx(btc).jump;
      else btcRet = btcShock * (SYMBOLS.BTCUSD.annualVol / Math.sqrt(TRADING_SECONDS_PER_YEAR)) * Math.sqrt(dtSec);
      for (const st of this.state.values()) {
        let ret;
        const e = fx(st);
        if (st.id === 'BTCUSD') ret = btcRet;
        else if (st.beta) ret = st.beta * btcRet + st.process.step(dtSec, sv * e.vol) + e.jump;
        else ret = st.process.step(dtSec, sv * e.vol) + e.jump;
        st.logPrice += ret;
        const price = roundToTick(st.id, Math.exp(st.logPrice));
        const sigmaStep = st.sigma * Math.sqrt(dtSec) || 1e-9;
        const activity = 1 + 2 * Math.min(4, Math.abs(ret) / sigmaStep);
        const volume = (st.sym.baseVolume / 60) * dtSec * sv * activity * Math.exp(0.5 * gaussian(this.rng) - 0.125);
        this.md.applyTick(st.id, price, volume * (e.vol > 1 ? e.vol : 1), t, this.source);
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
