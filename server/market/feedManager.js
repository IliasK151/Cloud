import { EventEmitter } from 'node:events';
import { SYMBOLS } from './symbols.js';
import { SimFeed } from './simFeed.js';
import { BinanceFeed } from './binanceFeed.js';
import { YahooFeed } from './yahooFeed.js';

const LOOP_MS = 250;
// After a live source failed at startup: try again after these delays (then every 10 min).
const RECOVER_DELAYS_MS = [90_000, 3 * 60_000, 6 * 60_000, 10 * 60_000];

// Wires the right data source to every instrument.
//  FEED=sim  → everything simulated on an accelerated virtual clock (demo mode, works offline)
//  FEED=live → real prices only: Binance (crypto) + Yahoo (futures/FX), and MT5, when
//              connected, takes over mapped markets with the broker's own prices. Nothing is
//              ever simulated here: a market whose source can't be reached has no prices
//              (status WAITING) and its desks stand aside, while the real feed is retried in
//              the background until it answers.
// Emits 'recovered' (id, source) when a waiting market gets real prices.
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
    this.binance = null;
    this.waiting = new Set(); // live mode: markets with no real prices yet
    this.hooks = { sessionClose: () => {}, sessionOpen: () => {} };
    this.notes = [];
    // Real prices arriving for a waiting market (Yahoo answering again, or MT5's broker feed).
    md.on('claim', (id, source) => {
      if (this.waiting.has(id) && source !== 'sim') this.#promote(id, source);
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
        this.binance = binance;
        this.notes.push(`Binance live: ${binanceSyms.map((s) => s.id).join(', ')}`);
      } else {
        this.log.warn(`[feed] ${bRes.reason.message}: ${binanceSyms.map((s) => s.id).join(', ')} wait for real prices (retrying in the background)`);
        fallback.push(...binanceSyms.map((s) => s.id));
      }
      if (yRes.status === 'fulfilled') {
        this.feeds.push(yahoo);
        if (yRes.value.ok.length) this.notes.push(`Yahoo live: ${yRes.value.ok.join(', ')}`);
        const failed = yRes.value.failed;
        const limited = failed.filter((f) => f.rateLimited).map((f) => f.id);
        if (limited.length) {
          this.log.warn(`[feed] Yahoo Finance is rate-limiting this internet connection (HTTP 429), so ${limited.join(', ')} have no prices yet.`);
          this.log.warn('[feed]   Nothing is simulated: their desks stand aside until real prices arrive. The floor retries Yahoo in the background,');
          this.log.warn('[feed]   and with MT5 connected, every market your broker lists is priced from your broker\'s feed instead.');
        }
        for (const f of failed) {
          if (!f.rateLimited) this.log.warn(`[feed] Yahoo ${f.id}: ${f.error}: waiting for real prices (retrying in the background)`);
          fallback.push(f.id);
        }
      } else {
        fallback.push(...yahooSyms.map((s) => s.id));
      }

      if (fallback.length) {
        for (const id of fallback) {
          this.md.setStatus(id, 'WAITING', 'none');
          this.waiting.add(id);
        }
        this.#noteWaiting();
        this.#scheduleRecovery();
      }
    }
    this.#loop();
  }

  #noteWaiting() {
    const left = [...this.waiting].join(', ');
    this.notes = this.notes.filter((n) => !n.startsWith('Waiting for real prices'));
    if (left) this.notes.push(`Waiting for real prices (live source unreachable, nothing simulated): ${left}`);
  }

  #scheduleRecovery() {
    clearTimeout(this.recoverTimer);
    const delays = this.recoverDelaysMs;
    const ms = delays[Math.min(this.recoverAttempt, delays.length - 1)];
    this.recoverTimer = setTimeout(() => this.#recover(), ms);
    this.recoverTimer.unref?.();
  }

  // Yahoo one market at a time (a rate limit ends the round: the client is paused anyway),
  // and Binance for the coins the broker doesn't already price.
  async #recover() {
    this.recoverAttempt++;
    const pending = [...this.waiting].filter((id) => SYMBOLS[id].source.type === 'yahoo');
    for (const id of pending) {
      try {
        if (await this.yahoo.recover(id)) this.log.info(`[feed] Yahoo is answering again: ${id} is on real prices`);
      } catch (err) {
        if (err.rateLimited) break;
      }
    }
    const coins = [...this.waiting].filter((id) => SYMBOLS[id].source.type === 'binance' && this.md.ownerOf(id) !== 'mt5');
    if (coins.length) {
      const feed = new BinanceFeed(this.md, coins.map((id) => SYMBOLS[id]), this.log);
      try {
        await feed.start();
        this.binance?.stop();
        this.binance = feed;
        this.feeds = this.feeds.filter((f) => !(f instanceof BinanceFeed)).concat(feed);
        this.log.info(`[feed] Binance is answering again: ${coins.join(', ')} ${coins.length === 1 ? 'is' : 'are'} on real prices`);
        for (const id of coins) this.#promote(id, 'binance');
      } catch {
        feed.stop();
      }
    }
    if (this.waiting.size) this.#scheduleRecovery();
    if (this.yahoo && !this.feeds.includes(this.yahoo)) this.feeds.push(this.yahoo);
  }

  #promote(id, source) {
    if (!this.waiting.delete(id)) return;
    this.#noteWaiting();
    this.emit('recovered', id, source);
  }

  // Demo mode only: the simulator runs on its own accelerated clock.
  #loop() {
    if (this.mode !== 'sim') return;
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
