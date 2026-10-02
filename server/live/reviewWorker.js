import { parentPort } from 'node:worker_threads';
import { edgeReport } from '../../scripts/edge-report.js';

// The nightly review runs here, off the floor's thread: replaying every desk on months of
// minutes takes a few minutes of CPU, and the floor must keep trading meanwhile.
parentPort.on('message', (job) => {
  try {
    let i = 0;
    const report = edgeReport({
      ...job,
      log: (line) => parentPort.postMessage({ type: 'progress', id: job.id, line, i: ++i }),
    });
    parentPort.postMessage({ type: 'result', id: job.id, report });
  } catch (err) {
    parentPort.postMessage({ type: 'error', id: job.id, message: err.stack || err.message });
  }
});
