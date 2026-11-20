import { parentPort, workerData } from 'node:worker_threads';
import { type ContentSearchJob, searchContents } from './content-search';

// Runs in a worker thread, so a slow walk or a runaway regex never holds the main process.
// Its last message is always `done`; the runner reads an exit without one as a failure.
const port = parentPort;
if (port) {
  // SAFETY: runContentSearch is the only creator of this worker and always passes a ContentSearchJob.
  const job = workerData as ContentSearchJob;
  void searchContents(job, (matches) => {
    port.postMessage({ type: 'matches', matches });
  }).then(({ invalidRegex }) => port.postMessage({ type: 'done', invalidRegex }));
}
