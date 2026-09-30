import { parentPort } from 'node:worker_threads';
import { research } from './search.js';

// Research runs here, off the main thread, so the floor never stutters while a desk
// tests a few hundred strategies.
parentPort.on('message', (job) => {
  try {
    const result = research({
      ...job,
      onProgress: (p) => parentPort.postMessage({ type: 'progress', id: job.id, ...p }),
    });
    parentPort.postMessage({ type: 'result', id: job.id, result });
  } catch (err) {
    parentPort.postMessage({ type: 'error', id: job.id, message: err.stack || err.message });
  }
});
