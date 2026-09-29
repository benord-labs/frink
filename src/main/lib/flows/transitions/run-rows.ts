import { and, eq, inArray } from 'drizzle-orm';
import { FLOW_DRIVING_STATUSES } from '../../../../shared/types/flow';
import type { getDatabase } from '../../db';
import { cancelResultPatch } from '../../db/repos/task-parking/cancel-marker';
import { flowRuns, type NewNodeRun, type NodeRun, nodeRuns, tasks } from '../../db/schema';

type Db = ReturnType<typeof getDatabase>;

const CANCELLABLE_RUN_STATUSES = ['pending', 'running', 'paused'];
const DISPATCHABLE_RUN_STATUSES = ['running', 'paused'];
const ACTIVE_NODE_RUN_STATUSES = ['pending', 'running', 'awaiting_input', 'blocked'];

/** Cancels a live run with its unfinished node_runs and flow tasks; parked review tasks only with
 * `includeParked`. False, writing nothing, once the run is terminal. Runs inside a transition. */
export function cancelRunRows(
  db: Db,
  flowRunId: string,
  { includeParked }: { includeParked: boolean },
  now = new Date(),
): boolean {
  const cancelled = db
    .update(flowRuns)
    .set({ status: 'cancelled', completedAt: now })
    .where(and(eq(flowRuns.id, flowRunId), inArray(flowRuns.status, CANCELLABLE_RUN_STATUSES)))
    .returning({ id: flowRuns.id })
    .get();
  if (!cancelled) return false;
  db.update(nodeRuns)
    .set({ status: 'cancelled', completedAt: now })
    .where(
      and(eq(nodeRuns.flowRunId, flowRunId), inArray(nodeRuns.status, ACTIVE_NODE_RUN_STATUSES)),
    )
    .run();
  const taskStatuses = includeParked ? FLOW_DRIVING_STATUSES : (['pending', 'running'] as const);
  db.update(tasks)
    .set({ status: 'cancelled', completedAt: now, result: cancelResultPatch(false) })
    .where(and(eq(tasks.flowRunId, flowRunId), inArray(tasks.status, [...taskStatuses])))
    .run();
  return true;
}

/** Inserts a node_run only while its run is running or paused, so a dispatch decided before a Cancel
 * committed writes nothing (null). Runs inside `runTransition`. */
export function insertNodeRunIfLive(db: Db, input: NewNodeRun): NodeRun | null {
  const live = db
    .select({ id: flowRuns.id })
    .from(flowRuns)
    .where(
      and(eq(flowRuns.id, input.flowRunId), inArray(flowRuns.status, DISPATCHABLE_RUN_STATUSES)),
    )
    .get();
  return live ? db.insert(nodeRuns).values(input).returning().get() : null;
}
