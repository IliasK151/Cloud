import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { Worker } from 'node:worker_threads';
import { EventEmitter } from 'node:events';
import { fileURLToPath } from 'node:url';

// Realistic agent voices, served by the floor itself.
//
// Kokoro (an open, Apache-2.0 neural text-to-speech model) runs here on the Mac, in a worker
// thread, and the browser just plays the audio. Nothing is installed until the boss picks
// "Realistic voices": then the engine (kokoro-js + ONNX Runtime) is installed into
// data/voice-engine and the model (~90 MB) is downloaded once from Hugging Face into
// data/voice-engine/models. Every step is reported to the UI and the Terminal.

const HERE = path.dirname(fileURLToPath(import.meta.url));
const PACKAGE = 'kokoro-js';
const VERSION = '1.2.1';

export class VoiceEngine extends EventEmitter {
  constructor({ dataDir, log = console, spawnImpl = spawn, WorkerImpl = Worker }) {
    super();
    this.dir = path.join(dataDir, 'voice-engine');
    this.cacheDir = path.join(this.dir, 'models');
    this.settingsFile = path.join(dataDir, 'voices.json');
    this.log = log;
    this.spawn = spawnImpl;
    this.WorkerImpl = WorkerImpl;
    this.worker = null;
    this.pending = new Map();
    this.seq = 0;
    this.queue = Promise.resolve();
    this.logTail = [];
    this.state = { state: this.installed ? 'installed' : 'absent', step: '', progress: null, error: null, loaded: 0, total: 0, lastMs: null };
    this.wanted = false;
    try {
      this.wanted = !!JSON.parse(fs.readFileSync(this.settingsFile, 'utf8')).enabled;
    } catch {
      /* not chosen yet */
    }
  }

  get installed() {
    return fs.existsSync(path.join(this.dir, 'node_modules', PACKAGE, 'package.json')) && fs.existsSync(path.join(this.dir, 'entry.mjs'));
  }

  #set(patch) {
    Object.assign(this.state, patch);
    this.emit('change', this.status());
  }

  status() {
    return { ...this.state, wanted: this.wanted, ready: this.state.state === 'ready', log: this.logTail.slice(-4) };
  }

  #remember(enabled) {
    this.wanted = enabled;
    try {
      fs.writeFileSync(this.settingsFile, JSON.stringify({ enabled }));
    } catch {
      /* ignore */
    }
  }

  // Called at startup: bring the engine back if the boss chose realistic voices before.
  async init() {
    if (this.wanted && this.installed) this.setup().catch(() => {});
  }

  // Install (first time) and load the model. Safe to call repeatedly.
  setup() {
    this.#remember(true);
    if (this.state.state === 'ready' || this.busy) return this.busy || Promise.resolve(this.status());
    this.busy = (async () => {
      try {
        if (!this.installed) await this.#install();
        await this.#load();
      } catch (err) {
        this.#set({ state: 'error', error: err.message, progress: null });
        this.log.warn?.(`[voices] ${err.message}`);
      } finally {
        this.busy = null;
      }
      return this.status();
    })();
    return this.busy;
  }

  disable() {
    this.#remember(false);
    this.worker?.terminate();
    this.worker = null;
    this.#set({ state: this.installed ? 'installed' : 'absent', step: '', progress: null, error: null });
  }

  #npm() {
    const execPath = process.env.npm_execpath;
    if (execPath && /npm-cli\.[cm]?js$/.test(execPath)) return [process.execPath, [execPath]];
    const exe = process.platform === 'win32' ? 'npm.cmd' : 'npm';
    const beside = path.join(path.dirname(process.execPath), exe);
    return fs.existsSync(beside) ? [beside, []] : [exe, []];
  }

  #install() {
    fs.mkdirSync(this.dir, { recursive: true });
    fs.writeFileSync(path.join(this.dir, 'package.json'), JSON.stringify({ name: 'floor-voice-engine', private: true, type: 'module', dependencies: { [PACKAGE]: VERSION } }, null, 2));
    fs.copyFileSync(path.join(HERE, 'entry.mjs'), path.join(this.dir, 'entry.mjs'));
    this.#set({ state: 'installing', step: 'Installing the voice engine (one time, a minute or two)…', progress: null, error: null });
    this.log.info?.('[voices] installing the realistic voice engine into data/voice-engine (one time)…');
    const [cmd, pre] = this.#npm();
    return new Promise((resolve, reject) => {
      const child = this.spawn(cmd, [...pre, 'install', '--no-audit', '--no-fund', '--omit=dev', '--loglevel=error'], {
        cwd: this.dir,
        env: { ...process.env, ONNXRUNTIME_NODE_INSTALL_CUDA: 'skip', npm_config_update_notifier: 'false' },
        stdio: ['ignore', 'pipe', 'pipe'],
        shell: process.platform === 'win32',
      });
      const onData = (buf) => {
        for (const line of String(buf).split('\n').map((l) => l.trim()).filter(Boolean)) {
          this.logTail.push(line.slice(0, 200));
          if (this.logTail.length > 20) this.logTail.shift();
        }
      };
      child.stdout?.on('data', onData);
      child.stderr?.on('data', onData);
      const timer = setTimeout(() => child.kill(), 15 * 60_000);
      child.on('error', (err) => {
        clearTimeout(timer);
        reject(new Error(`Could not run npm to install the voice engine: ${err.message}`));
      });
      child.on('exit', (code) => {
        clearTimeout(timer);
        if (code === 0 && this.installed) {
          this.log.info?.('[voices] voice engine installed');
          resolve();
        } else {
          reject(new Error(`Installing the voice engine failed (npm exit ${code}). ${this.logTail.slice(-2).join(' ')}`.trim()));
        }
      });
    });
  }

  #load() {
    this.worker?.terminate();
    this.#set({ state: 'loading', step: 'Loading the voice model…', progress: null, error: null });
    return new Promise((resolve, reject) => {
      const worker = new this.WorkerImpl(path.join(HERE, 'worker.js'), { workerData: { engineDir: this.dir, cacheDir: this.cacheDir } });
      this.worker = worker;
      let logged = 0;
      worker.on('message', (m) => {
        if (m.type === 'progress') {
          const pct = m.total ? m.loaded / m.total : 0;
          this.#set({ step: 'Downloading the voice model (one time, about 90 MB)…', progress: pct, loaded: m.loaded, total: m.total });
          if (pct - logged >= 0.25) {
            logged = pct;
            this.log.info?.(`[voices] downloading the voice model… ${Math.round(pct * 100)}%`);
          }
        } else if (m.type === 'ready') {
          this.#set({ state: 'ready', step: '', progress: null, error: null });
          this.log.info?.('[voices] realistic voices are ready');
          resolve();
        } else if (m.type === 'error') {
          const msg = m.message.slice(0, 300).replace(/\.+$/, '');
          const hint = /forbidden|403|429/i.test(msg)
            ? ' Hugging Face refused the download just now; try again in a few minutes.'
            : /fetch|ENOTFOUND|ECONN|network|getaddrinfo|timed out/i.test(msg)
              ? ' Check your internet connection: the model downloads once from huggingface.co.'
              : '';
          worker.terminate();
          if (this.worker === worker) this.worker = null;
          reject(new Error(`The voice model could not load (${msg}).${hint}`));
        } else if (m.type === 'audio') {
          const r = this.pending.get(m.id);
          this.pending.delete(m.id);
          if (m.ms) this.state.lastMs = m.ms;
          r?.(m);
        }
      });
      worker.on('error', (err) => {
        if (this.worker === worker) this.worker = null;
        for (const r of this.pending.values()) r({ error: err.message });
        this.pending.clear();
        this.#set({ state: 'error', error: `The voice engine crashed: ${err.message}` });
        reject(err);
      });
      worker.postMessage({ type: 'load' });
    });
  }

  // Text → { samples: Float32Array, rate } (queued: one sentence at a time).
  speak(text, voice) {
    if (this.state.state !== 'ready' || !this.worker) return Promise.reject(new Error('Realistic voices are not ready'));
    const run = () => new Promise((resolve, reject) => {
      const id = ++this.seq;
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error('Speech took too long'));
      }, 30_000);
      this.pending.set(id, (m) => {
        clearTimeout(timer);
        if (m.error) reject(new Error(m.error));
        else resolve(m);
      });
      this.worker.postMessage({ type: 'speak', id, text: String(text).slice(0, 600), voice });
    });
    const job = this.queue.then(run, run);
    this.queue = job.catch(() => {});
    return job;
  }

  stop() {
    this.worker?.terminate();
    this.worker = null;
  }
}

// 16-bit PCM WAV, mono.
export function toWav(samples, rate) {
  const buf = Buffer.alloc(44 + samples.length * 2);
  buf.write('RIFF', 0);
  buf.writeUInt32LE(36 + samples.length * 2, 4);
  buf.write('WAVE', 8);
  buf.write('fmt ', 12);
  buf.writeUInt32LE(16, 16);
  buf.writeUInt16LE(1, 20);
  buf.writeUInt16LE(1, 22);
  buf.writeUInt32LE(rate, 24);
  buf.writeUInt32LE(rate * 2, 28);
  buf.writeUInt16LE(2, 32);
  buf.writeUInt16LE(16, 34);
  buf.write('data', 36);
  buf.writeUInt32LE(samples.length * 2, 40);
  for (let i = 0; i < samples.length; i++) {
    const v = Math.max(-1, Math.min(1, samples[i]));
    buf.writeInt16LE(Math.round(v < 0 ? v * 0x8000 : v * 0x7fff), 44 + i * 2);
  }
  return buf;
}
