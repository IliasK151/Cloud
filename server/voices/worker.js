import { parentPort, workerData } from 'node:worker_threads';
import { pathToFileURL } from 'node:url';
import path from 'node:path';

// Runs the Kokoro text-to-speech model off the main thread so speech never stalls the desks.

const MODEL = 'onnx-community/Kokoro-82M-v1.0-ONNX';
const { engineDir, cacheDir } = workerData;
let tts = null;

parentPort.on('message', async (m) => {
  if (m.type === 'load') {
    try {
      const mod = await import(pathToFileURL(path.join(engineDir, 'entry.mjs')).href);
      mod.env.cacheDir = cacheDir;
      const seen = new Map();
      let last = 0;
      tts = await mod.KokoroTTS.from_pretrained(MODEL, {
        dtype: 'q8',
        device: 'cpu',
        progress_callback: (p) => {
          if (p.status !== 'progress' || !p.total) return;
          seen.set(p.file, [p.loaded, p.total]);
          if (Date.now() - last < 300) return;
          last = Date.now();
          let loaded = 0;
          let total = 0;
          for (const [l, t] of seen.values()) {
            loaded += l;
            total += t;
          }
          parentPort.postMessage({ type: 'progress', loaded, total });
        },
      });
      await tts.generate('Ready.', { voice: 'af_heart' });
      parentPort.postMessage({ type: 'ready' });
    } catch (err) {
      parentPort.postMessage({ type: 'error', message: String(err?.message || err), stack: String(err?.stack || '') });
    }
  } else if (m.type === 'speak') {
    if (!tts) {
      parentPort.postMessage({ type: 'audio', id: m.id, error: 'The voice model is not loaded' });
      return;
    }
    try {
      const t0 = Date.now();
      const out = await tts.generate(m.text, { voice: m.voice, speed: m.speed || 1 });
      const samples = new Float32Array(out.audio);
      parentPort.postMessage({ type: 'audio', id: m.id, samples, rate: out.sampling_rate, ms: Date.now() - t0 }, [samples.buffer]);
    } catch (err) {
      parentPort.postMessage({ type: 'audio', id: m.id, error: String(err?.message || err) });
    }
  }
});
