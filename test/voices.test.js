import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { EventEmitter } from 'node:events';
import { VoiceEngine, toWav } from '../server/voices/engine.js';

const quiet = { info() {}, warn() {} };

// Stand-ins for `npm install` and the Kokoro worker thread.
function fakeNpm(dir) {
  return () => {
    const child = new EventEmitter();
    child.stdout = new EventEmitter();
    child.stderr = new EventEmitter();
    child.kill = () => {};
    setImmediate(() => {
      fs.mkdirSync(path.join(dir, 'voice-engine', 'node_modules', 'kokoro-js'), { recursive: true });
      fs.writeFileSync(path.join(dir, 'voice-engine', 'node_modules', 'kokoro-js', 'package.json'), '{}');
      child.stdout.emit('data', 'added 56 packages');
      child.emit('exit', 0);
    });
    return child;
  };
}

class FakeWorker extends EventEmitter {
  constructor(file, opts) {
    super();
    FakeWorker.last = { file, opts };
  }
  postMessage(m) {
    setImmediate(() => {
      if (m.type === 'load') {
        this.emit('message', { type: 'progress', loaded: 45e6, total: 90e6 });
        this.emit('message', { type: 'ready' });
      } else if (m.type === 'speak') {
        const samples = new Float32Array(2400).map((_, i) => Math.sin(i / 5) * 0.5);
        this.emit('message', { type: 'audio', id: m.id, samples, rate: 24000, ms: 120 });
      }
    });
  }
  terminate() {}
}

test('realistic voices install once, load in a worker and speak', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'voices-'));
  const states = [];
  const engine = new VoiceEngine({ dataDir: dir, log: quiet, spawnImpl: fakeNpm(dir), WorkerImpl: FakeWorker });
  engine.on('change', (s) => states.push(s.state));
  assert.equal(engine.status().state, 'absent');
  await engine.setup();
  assert.equal(engine.status().state, 'ready');
  assert.ok(states.includes('installing') && states.includes('loading'));
  assert.ok(fs.existsSync(path.join(dir, 'voice-engine', 'entry.mjs')), 'entry module copied');
  assert.equal(FakeWorker.last.opts.workerData.cacheDir, path.join(dir, 'voice-engine', 'models'));
  const out = await engine.speak('Hello boss!', 'am_michael');
  assert.equal(out.rate, 24000);
  assert.equal(out.samples.length, 2400);
  // The choice is remembered so the engine comes back on the next start.
  assert.equal(JSON.parse(fs.readFileSync(path.join(dir, 'voices.json'), 'utf8')).enabled, true);
  engine.disable();
  assert.equal(JSON.parse(fs.readFileSync(path.join(dir, 'voices.json'), 'utf8')).enabled, false);
});

test('a failed model download is reported clearly', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'voices-'));
  class FailingWorker extends FakeWorker {
    postMessage() {
      setImmediate(() => this.emit('message', { type: 'error', message: 'fetch failed: getaddrinfo ENOTFOUND huggingface.co.' }));
    }
  }
  const engine = new VoiceEngine({ dataDir: dir, log: quiet, spawnImpl: fakeNpm(dir), WorkerImpl: FailingWorker });
  await engine.setup();
  const st = engine.status();
  assert.equal(st.state, 'error');
  assert.match(st.error, /could not load \(fetch failed: getaddrinfo ENOTFOUND huggingface\.co\)\. Check your internet connection/);
  await assert.rejects(() => engine.speak('Hi', 'am_michael'), /not ready/);
});

test('speech is encoded as 16-bit mono WAV', () => {
  const wav = toWav(new Float32Array([0, 1, -1, 0.5]), 24000);
  assert.equal(wav.toString('ascii', 0, 4), 'RIFF');
  assert.equal(wav.toString('ascii', 8, 12), 'WAVE');
  assert.equal(wav.readUInt16LE(22), 1); // mono
  assert.equal(wav.readUInt32LE(24), 24000);
  assert.equal(wav.readUInt32LE(40), 8); // 4 samples × 2 bytes
  assert.equal(wav.readInt16LE(46), 32767);
  assert.equal(wav.readInt16LE(48), -32768);
});
