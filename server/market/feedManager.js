import { EventEmitter } from 'node:events';
import { SYMBOLS } from './symbols.js';
import { SimFeed } from './simFeed.js';
import { BinanceFeed } from './binanceFeed.js';
import { YahooFeed } from './yahooFeed.js';

const LOOP_MS = 250;
// After a live source failed at startup: try again after these delays (then every 10 min).
const RECOVER_DELAYS_MS = [90_000, 3 * 60_000, 6 * 60_000, 10 * 60_000];

// Wires the right data source to every instrument.
//  FEED=sim  → everything simulated on an accelerated virtual clock (always works offline)
//  FEED=live → Binance (crypto) + Yahoo (futures/FX). A market whose source can't be reached
//              runs on a real-time simulation so the floor keeps running (paper only: those
//              prices never trade the prop account), and the real feed is retried in the
//              background until it answers. MT5, when connected, takes over mapped markets
//              with the broker's own prices.
// Emits 'recovered' (id, source) when a simulated market switches to real prices.
export class FeedManager extends EventEmitter {
  constructor({ md, clock, mode, log = console, calendar = null, yahooOptions = {}, recoverDelaysMs = RECOVER_DELAYS_MS }) {
    super();
    this.md = md;
    this.calendar = calendar;
    this.clock = clock;
    this.mode = mode;
    this.log = log;
    this.yahooOptions = yahooOptions;
    this.recoverDelaysMs = recoverDelaysMs;
    this.sim = null;
    this.feeds = [];
    this.yahoo = null;
    this.timer = null;
    this.recoverTimer = null;
    this.recoverAttempt = 0;
    this.simulated = new Set();
    this.hooks = { sessionClose: () => {}, sessionOpen: () => {} };
    this.notes = [];
    // Real prices taking over a simulated market (Yahoo recovered, or MT5's broker feed).
    md.on('claim', (id, source) => {
      if (this.simulated.has(id) && source !== 'sim') this.#promote(id, source);
    });
  }

  onSession(hooks) {
    Object.assign(this.hooks, hooks);
  }

  async start() {
    const all = Object.values(SYMBOLS);
    if (this.mode === 'sim') {
      this.sim = new SimFeed(this.md, this.clock, all.map((s) => s.id), { calendar: this.calendar });
      this.sim.warmup(420);
      for (const s of all) this.md.setStatus(s.id, 'SIM', 'sim');
      this.notes.push('Simulation mode: all markets simulated on an accelerated clock.');
    } else {
      const fallback = [];
      const binanceSyms = all.filter((s) => s.source.type === 'binance');
      const yahooSyms = all.filter((s) => s.source.type === 'yahoo');

      const binance = new BinanceFeed(this.md, binanceSyms, this.log);
      const yahoo = new YahooFeed(this.md, yahooSyms, this.log, this.yahooOptions);
      this.yahoo = yahoo;
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
        const failed = yRes.value.failed;
        const limited = failed.filter((f) => f.rateLimited).map((f) => f.id);
        if (limited.length) {
          this.log.warn(`[feed] Yahoo Finance is rate-limiting this internet connection (HTTP 429), so ${limited.join(', ')} start on simulated prices.`);
          this.log.warn('[feed]   The floor retries Yahoo in the background and switches them to real prices when it answers.');
          this.log.warn('[feed]   With MT5 connected, those markets use your broker\'s prices instead. Simulated prices never trade the FTMO account.');
        }
        for (const f of failed) {
          if (!f.rateLimited) this.log.warn(`[feed] Yahoo ${f.id}: ${f.error} → simulating for now (retrying in the background)`);
          fallback.push(f.id);
        }
      } else {
        fallback.push(...yahooSyms.map((s) => s.id));
      }

      if (fallback.length) {
        this.sim = new SimFeed(this.md, this.clock, fallback, { useSessionShape: false, calendar: this.calendar });
        this.sim.warmup(420);
        for (const id of fallback) {
          this.md.setStatus(id, 'SIM', 'sim');
          this.simulated.add(id);
        }
        this.notes.push(`Simulated (live source unreachable): ${fallback.join(', ')}`);
        if (fallback.some((id) => SYMBOLS[id].source.type === 'yahoo')) this.#scheduleRecovery();
      }
    }
    this.#loop();
  }

  #scheduleRecovery() {
    clearTimeout(this.recoverTimer);
    const delays = this.recoverDelaysMs;
    const ms = delays[Math.min(this.recoverAttempt, delays.length - 1)];
    this.recoverTimer = setTimeout(() => this.#recover(), ms);
    this.recoverTimer.unref?.();
  }

  // One market at a time; a rate limit ends the round (the client is paused anyway).
  async #recover() {
    this.recoverAttempt++;
    const pending = [...this.simulated].filter((id) => SYMBOLS[id].source.type === 'yahoo');
    for (const id of pending) {
      try {
        if (await this.yahoo.recover(id)) this.log.info(`[feed] Yahoo is answering again: ${id} is back on real prices`);
      } catch (err) {
        if (err.rateLimited) break;
      }
    }
    if ([...this.simulated].some((id) => SYMBOLS[id].source.type === 'yahoo')) this.#scheduleRecovery();
    else if (this.yahoo && !this.feeds.includes(this.yahoo)) this.feeds.push(this.yahoo);
  }

  #promote(id, source) {
    this.simulated.delete(id);
    this.sim?.remove(id);
    const left = [...this.simulated].join(', ');
    this.notes = this.notes.map((n) => (n.startsWith('Simulated') ? (left ? `Simulated (live source unreachable): ${left}` : null) : n)).filter(Boolean);
    this.emit('recovered', id, source);
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
    clearTimeout(this.recoverTimer);
    for (const f of this.feeds) f.stop();
    this.yahoo?.stop();
  }
}
