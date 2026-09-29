// Realistic agent voices: the Kokoro-82M text-to-speech model (Apache-2.0), running entirely
// on this computer in a Web Worker. The library comes from jsDelivr and the model from
// Hugging Face on first use; the browser caches both, so later starts work from the cache.

const LIB = 'https://cdn.jsdelivr.net/npm/kokoro-js@1.2.1/dist/kokoro.web.js';
const MODEL = 'onnx-community/Kokoro-82M-v1.0-ONNX';

let tts = null;

async function load(device) {
  const { KokoroTTS } = await import(LIB);
  const seen = new Map();
  tts = await KokoroTTS.from_pretrained(MODEL, {
    device,
    dtype: device === 'webgpu' ? 'fp32' : 'q8',
    progress_callback: (p) => {
      if (p.status !== 'progress' || !p.total) return;
      seen.set(p.file, [p.loaded, p.total]);
      let loaded = 0;
      let total = 0;
      for (const [l, t] of seen.values()) {
        loaded += l;
        total += t;
      }
      postMessage({ type: 'progress', loaded, total });
    },
  });
}

onmessage = async ({ data: m }) => {
  if (m.type === 'load') {
    try {
      let device = 'wasm';
      if (m.webgpu) {
        try {
          await load('webgpu');
          device = 'webgpu';
        } catch {
          await load('wasm');
        }
      } else {
        await load('wasm');
      }
      // Warm up so the first real sentence starts quickly.
      await tts.generate('Ready.', { voice: 'af_heart' });
      postMessage({ type: 'ready', device });
    } catch (err) {
      postMessage({ type: 'error', message: String(err?.message || err) });
    }
  } else if (m.type === 'speak') {
    if (!tts) {
      postMessage({ type: 'audio', id: m.id, error: 'not loaded' });
      return;
    }
    try {
      const out = await tts.generate(m.text, { voice: m.voice, speed: m.speed || 1 });
      const samples = out.audio;
      postMessage({ type: 'audio', id: m.id, samples, rate: out.sampling_rate }, [samples.buffer]);
    } catch (err) {
      postMessage({ type: 'audio', id: m.id, error: String(err?.message || err) });
    }
  }
};
