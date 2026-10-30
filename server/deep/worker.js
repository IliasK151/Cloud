import { isMainThread, parentPort, workerData } from 'node:worker_threads';
import { learn } from './train.js';

// The deep brain learning, in a worker thread so the floor keeps trading while it trains
// (deep/train.js has the lesson; this only runs it and reports how it goes).
if (!isMainThread && workerData?.deepJob && parentPort) {
  learn(workerData, (p) => parentPort.postMessage({ type: 'progress', ...p }))
    .then((res) => parentPort.postMessage({ type: 'done', ...res }))
    .catch((err) => parentPort.postMessage({ type: 'done', ok: false, error: err?.message || String(err) }));
}
