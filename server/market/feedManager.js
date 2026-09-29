import { SYMBOLS } from './symbols.js';
import { SimFeed } from './simFeed.js';
import { BinanceFeed } from './binanceFeed.js';
import { YahooFeed } from './yahooFeed.js';

const LOOP_MS = 250;

// Wires the right data source to every instrument.
//  FEED=sim  → everything simulated on an accelerated virtual clock (always works offline)
//  FEED=live → Binance (crypto) + Yahoo (futures/FX); any source that can't be reached
//              falls back to a real-time simulation so the floor keeps running.
export class FeedManager {
  constructor({ md, clock, mode, log = console }) {
    this.md = md;
    this.clock = clock;
    this.mode = mode;
    this.log = log;
    this.sim = null;
    this.feeds = [];
    this.timer = null;
    this.hooks = { sessionClose: () => {}, sessionOpen: () => {} };
    this.notes = [];
  }

  onSession(hooks) {
    Object.assign(this.hooks, hooks);
  }

  async start() {
    const all = Object.values(SYMBOLS);
    if (this.mode === 'sim') {
      this.sim = new SimFeed(this.md, this.clock, all.map((s) => s.id));
      this.sim.warmup(420);
      for (const s of all) this.md.setStatus(s.id, 'SIM', 'sim');
      this.notes.push('Simulation mode: all markets simulated on an accelerated clock.');
    } else {
      const fallback = [];
      const binanceSyms = all.filter((s) => s.source.type === 'binance');
      const yahooSyms = all.filter((s) => s.source.type === 'yahoo');

      const binance = new BinanceFeed(this.md, binanceSyms, this.log);
      const yahoo = new YahooFeed(this.md, yahooSyms, this.log);
      const [bRes, yRes] = await Promise.allSettled([binance.start(), yahoo.start()]);

      if (bRes.status === 'fulfilled') {
        this.feeds.push(binance);
        this.notes.push(`Binance live: ${binanceSyms.map((s) => s.id).join(', ')}`);
      } else {
        this.log.warn(`[feed] ${bRes.reason.message} → simulating ${binanceSyms.map((s) => s.id).join(', ')}`);
        fallback.push(...binanceSyms.map((s) => s.id));
      }
      if (yRes.status === 'fulfilled') {
        this.feeds.push(yahoo);
        if (yRes.value.ok.length) this.notes.push(`Yahoo live: ${yRes.value.ok.join(', ')}`);
        for (const f of yRes.value.failed) {
          this.log.warn(`[feed] Yahoo ${f.id}: ${f.error} → simulating`);
          fallback.push(f.id);
        }
      } else {
        fallback.push(...yahooSyms.map((s) => s.id));
      }

      if (fallback.length) {
        this.sim = new SimFeed(this.md, this.clock, fallback, { useSessionShape: false });
        this.sim.warmup(420);
        for (const id of fallback) this.md.setStatus(id, 'SIM', 'sim');
        this.notes.push(`Simulated (live source unreachable): ${fallback.join(', ')}`);
      }
    }
    this.#loop();
  }

  #loop() {
    let lastReal = Date.now();
    this.timer = setInterval(() => {
      const nowReal = Date.now();
      const dt = nowReal - lastReal;
      lastReal = nowReal;
      if (!this.sim) return;
      const from = this.clock.now();
      this.clock.advance(dt);
      const to = this.clock.now();
      this.sim.step(from, to);
      if (this.clock.sessionOver()) {
        this.hooks.sessionClose();
        const { from: f, to: t } = this.clock.jumpToNextOpen();
        this.sim.gap(f, t);
        this.hooks.sessionOpen();
      }
    }, LOOP_MS);
  }

  stop() {
    clearInterval(this.timer);
    for (const f of this.feeds) f.stop();
  }
}
