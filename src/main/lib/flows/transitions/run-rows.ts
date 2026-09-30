import { and, eq, inArray } from 'drizzle-orm';
import { FLOW_DRIVING_STATUSES } from '../../../../shared/types/flow';
import type { getDatabase } from '../../db';
import type { FlowRunStatus } from '../../db/repos/flow-runs';
import { cancelResultPatch } from '../../db/repos/task-parking/cancel-marker';
import { flowRuns, type NewNodeRun, type NodeRun, nodeRuns, tasks } from '../../db/schema';
import { cancelAdmission, liveAdmissionForRun } from '../admission/store';

type Db = ReturnType<typeof getDatabase>;

const CANCELLABLE_RUN_STATUSES: FlowRunStatus[] = ['pending', 'running', 'paused'];
export const DISPATCHABLE_RUN_STATUSES: FlowRunStatus[] = ['running', 'paused'];
const ACTIVE_NODE_RUN_STATUSES = ['pending', 'running', 'awaiting_input', 'blocked'];
const UNDISPATCHED_ADMISSION_STATES = ['queued', 'claimed'];

export const isCancellableRunStatus = (status: string): boolean =>
  (CANCELLABLE_RUN_STATUSES as string[]).includes(status);

/** Cancels the run's queued or claimed ticket. Runs before the run rows, because a start ticket's
 * cancel only terminalizes a still-pending run. */
export function dropUndispatchedAdmission(db: Db, flowRunId: string, now = new Date()): boolean {
  const live = liveAdmissionForRun(db, flowRunId);
  if (!live || !UNDISPATCHED_ADMISSION_STATES.includes(live.state)) return false;
  return cancelAdmission(db, live.ticket, now) !== null;
}

/** Cancels the run's executing flow tasks, and its parked review tasks with `includeParked`. */
export function cancelFlowTaskRows(
  db: Db,
  flowRunId: string,
  includeParked: boolean,
  now = new Date(),
): number {
  const statuses = includeParked ? FLOW_DRIVING_STATUSES : (['pending', 'running'] as const);
  return db
    .update(tasks)
    .set({ status: 'cancelled', completedAt: now, result: cancelResultPatch(false) })
    .where(and(eq(tasks.flowRunId, flowRunId), inArray(tasks.status, [...statuses])))
    .returning({ id: tasks.id })
    .all().length;
}

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
  sweepUnfinishedRunRows(db, flowRunId, includeParked, now);
  return true;
}

/** Cancels the run's unfinished node_runs and flow tasks; parked review tasks only with `includeParked`. */
export function sweepUnfinishedRunRows(
  db: Db,
  flowRunId: string,
  includeParked: boolean,
  now = new Date(),
): void {
  db.update(nodeRuns)
    .set({ status: 'cancelled', completedAt: now })
    .where(
      and(eq(nodeRuns.flowRunId, flowRunId), inArray(nodeRuns.status, ACTIVE_NODE_RUN_STATUSES)),
    )
    .run();
  cancelFlowTaskRows(db, flowRunId, includeParked, now);
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
