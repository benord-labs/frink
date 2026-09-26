/**
 * Local scheduler — replaces pg-boss durable queue. Single-process, in-memory.
 *
 * What's implemented:
 * - Recovery sweep at startup: any `flow_runs.status = 'running'` or `node_runs.status =
 *   'running'` from a prior process gets marked failed (per Phase −1 audit P-3).
 * - Soft concurrency limit on dispatched nodes (in-process Promise.race semaphore).
 *
 * What's intentionally deferred (acceptable for single-machine):
 * - Cross-process retry for in-flight nodes — recovery sweep handles restart.
 * - Durable timeouts — node-dispatch uses AbortController + `AbortSignal.timeout`.
 */

import log from 'electron-log';
import { getDatabase } from '../db';
import { recoverOrphanedFlowRuns } from '../db/repos/flow-runs';
import { cleanupNodeRunsForTerminalFlows, recoverOrphanedNodeRuns } from '../db/repos/node-runs';

const MAX_CONCURRENT_NODES = 4;

let activeCount = 0;
const queue: Array<() => void> = [];

/** Run `task` after a free slot is available. Resolves when task settles. */
export async function withSlot<T>(task: () => Promise<T>): Promise<T> {
  if (activeCount >= MAX_CONCURRENT_NODES) {
    await new Promise<void>((resolve) => queue.push(resolve));
  }
  activeCount += 1;
  try {
    return await task();
  } finally {
    activeCount -= 1;
    const next = queue.shift();
    if (next) next();
  }
}

/**
 * Mark any orphaned 'running' rows as failed. Call once at app startup, after
 * the DB has been initialized and before the engine accepts new runs.
 */
export async function recoverOrphans(): Promise<{
  flowRuns: number;
  nodeRuns: number;
  cleanedNodeRuns: number;
}> {
  const db = getDatabase();
  // Orphan sweeps first — fail 'running' flow_runs + node_runs left by the dead process.
  const [flowRunsCount, nodeRunsCount] = await Promise.all([
    recoverOrphanedFlowRuns(db),
    recoverOrphanedNodeRuns(db),
  ]);
  // THEN terminalize node_runs left non-terminal (e.g. awaiting_input) under a now-terminal
  // flow_run. MUST run after recoverOrphanedFlowRuns so the just-failed runs are in scope.
  const cleanedNodeRuns = await cleanupNodeRunsForTerminalFlows(db);
  // Batch sweep LAST: the orphan sweeps above terminalize runs WITHOUT emitting
  // flowEventBus events, so stage advancement must be re-derived from the DB.
  const { recoverBatchStages } = await import('./batch-dispatch');
  await recoverBatchStages();
  if (flowRunsCount > 0 || nodeRunsCount > 0 || cleanedNodeRuns > 0) {
    log.info('[FlowsScheduler] recovered orphaned rows on startup', {
      flowRuns: flowRunsCount,
      nodeRuns: nodeRunsCount,
      cleanedNodeRuns,
    });
  }
  return { flowRuns: flowRunsCount, nodeRuns: nodeRunsCount, cleanedNodeRuns };
}
