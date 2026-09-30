/** Abandon leg of the marker lifecycle: a restart interruption becomes a deliberate Stop once the marker
 * is removed run-wide (both oracles read it off different rows). Why: flow-run-restart-recovery. */
import { and, sql as drizzleSql, eq } from 'drizzle-orm';
import { RESTART_INTERRUPTION_REASON } from '../../../../../shared/types/flow';
import type { getDatabase } from '../..';
import { flowRuns, nodeRuns, tasks } from '../../schema';

type Db = ReturnType<typeof getDatabase>;

/** True when a marker was cleared. CAS: run still `cancelled`, no live node_run. Runs inside the
 * Work Queue Cancel command (cancelWorkQueueRunCommand), so no revive or dispatch interleaves. */
export function abandonRestartInterruption(db: Db, flowRunId: string): boolean {
  const runCancelled = drizzleSql`EXISTS (SELECT 1 FROM ${flowRuns}
    WHERE ${flowRuns.id} = ${flowRunId} AND ${flowRuns.status} = 'cancelled')
    AND NOT EXISTS (SELECT 1 FROM ${nodeRuns}
    WHERE ${nodeRuns.flowRunId} = ${flowRunId}
      AND ${nodeRuns.status} IN ('running', 'awaiting_input', 'blocked'))`;
  const clearedTasks = db
    .update(tasks)
    .set({ result: drizzleSql`json_patch(${tasks.result}, '{"error":null}')` })
    .where(
      and(
        eq(tasks.flowRunId, flowRunId),
        drizzleSql`json_extract(${tasks.result}, '$.error') = ${RESTART_INTERRUPTION_REASON}`,
        runCancelled,
      ),
    )
    .returning({ id: tasks.id })
    .all().length;
  const clearedNodes = db
    .update(nodeRuns)
    .set({ nodeOutput: drizzleSql`json_patch(${nodeRuns.nodeOutput}, '{"error":null}')` })
    .where(
      and(
        eq(nodeRuns.flowRunId, flowRunId),
        drizzleSql`json_extract(${nodeRuns.nodeOutput}, '$.error.message') = ${RESTART_INTERRUPTION_REASON}`,
        runCancelled,
      ),
    )
    .returning({ id: nodeRuns.id })
    .all().length;
  return clearedTasks + clearedNodes > 0;
}
