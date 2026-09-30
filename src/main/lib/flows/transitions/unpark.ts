import { and, asc, sql as drizzleSql, eq, inArray, ne } from 'drizzle-orm';
import { type NodeOutput, RESTART_INTERRUPTION_REASON } from '../../../../shared/types/flow';
import type { FlowResumeSnapshot } from '../../../../shared/types/flow-run/resume';
import type { getDatabase } from '../../db';
import type { FlowRunStatus } from '../../db/repos/flow-runs';
import {
  nodeMatchesResumeSnapshot,
  type NodeRunStatus,
  setNodeRunStatus,
} from '../../db/repos/node-runs';
import { batchStageRuns, flowRuns, type NodeRun, nodeRuns } from '../../db/schema';
import { liveAdmissionForRun } from '../admission/store';
import { lastUnfinishedNodeRun } from '../rerun/resume-point';
import { readRun } from './run-rows';

type Db = ReturnType<typeof getDatabase>;

/** The exact driving-task row an un-park was decided on: the node write holds only while it is unchanged. */
export type DrivingTaskRow = { id: string; status: string; result: unknown };

type UnparkTarget = {
  nodeStatuses: readonly NodeRunStatus[];
  runStatuses: readonly FlowRunStatus[];
  drivingTaskRow?: DrivingTaskRow;
};

const PARKED_NODE_STATUSES: NodeRunStatus[] = ['awaiting_input', 'blocked'];

const hasActiveSlot = (db: Db, flowRunId: string): boolean =>
  liveAdmissionForRun(db, flowRunId)?.state === 'active';

const readNodeRuns = (db: Db, flowRunId: string): NodeRun[] =>
  db
    .select()
    .from(nodeRuns)
    .where(eq(nodeRuns.flowRunId, flowRunId))
    .orderBy(asc(nodeRuns.createdAt), asc(drizzleSql`rowid`))
    .all();

/** The run's last unfinished node_run when it carries the restart-interruption marker. */
export function restartMarkedNode(db: Db, flowRunId: string): NodeRun | undefined {
  const last = lastUnfinishedNodeRun(readNodeRuns(db, flowRunId));
  const output = last?.nodeOutput as NodeOutput | null | undefined;
  return output?.error?.message === RESTART_INTERRUPTION_REASON ? last : undefined;
}

/** Cancelled by a restart, not by the user: the run is `cancelled` and still carries the marker. */
export const isRestartInterrupted = (db: Db, flowRunId: string): boolean =>
  readRun(db, flowRunId)?.status === 'cancelled' && restartMarkedNode(db, flowRunId) !== undefined;

/** A fan-out lane stays paused while a sibling lane of the same iteration is still parked. */
function hasParkedFanOutSibling(db: Db, node: NodeRun): boolean {
  if (node.parentFanOutNodeRunId === null || node.laneIndex === null) return false;
  const sibling = db
    .select({ id: nodeRuns.id })
    .from(nodeRuns)
    .where(
      and(
        eq(nodeRuns.parentFanOutNodeRunId, node.parentFanOutNodeRunId),
        eq(nodeRuns.laneIndex, node.laneIndex),
        ne(nodeRuns.id, node.id),
        inArray(nodeRuns.status, PARKED_NODE_STATUSES),
      ),
    )
    .get();
  return sibling !== undefined;
}

/** Puts one node of the run back to running, and the run too unless a sibling lane is still parked.
 * An in-place un-park continues without re-admitting, so it needs the run's active slot. */
function unparkNode(
  db: Db,
  flowRunId: string,
  nodeRunId: string,
  target: UnparkTarget,
): NodeRun | null {
  const runStatus = readRun(db, flowRunId)?.status as FlowRunStatus | undefined;
  if (!runStatus || !target.runStatuses.includes(runStatus) || !hasActiveSlot(db, flowRunId)) {
    return null;
  }
  const node = setNodeRunStatus(db, nodeRunId, 'running', {
    completedAt: null,
    nodeOutput: null,
    expectStatuses: target.nodeStatuses,
    expectDrivingTask: target.drivingTaskRow,
    expectFlowRunId: flowRunId,
  });
  if (node && !hasParkedFanOutSibling(db, node)) {
    db.update(flowRuns).set({ status: 'running' }).where(eq(flowRuns.id, flowRunId)).run();
  }
  return node;
}

/** Un-parks a failed or paused run's last unfinished node, or a restart-interrupted run's marked
 * node. A batch member only while its stage still waits for it; a deliberate Cancel never. */
export function unparkFailedRunCommand(db: Db, flowRunId: string): NodeRun | null {
  const run = readRun(db, flowRunId);
  if (!run) return null;
  if (run.batchId != null) {
    const stage = db
      .select({ status: batchStageRuns.status })
      .from(batchStageRuns)
      .where(eq(batchStageRuns.flowRunId, flowRunId))
      .get();
    if (stage?.status !== 'dispatched') return null;
  }
  if (run.status === 'cancelled') return reviveMarkedNode(db, flowRunId);
  const last = lastUnfinishedNodeRun(readNodeRuns(db, flowRunId));
  if (!last) return null;
  return unparkNode(db, flowRunId, last.id, {
    nodeStatuses: ['failed', ...PARKED_NODE_STATUSES],
    runStatuses: ['failed', 'paused'],
  });
}

/** Un-parks the flow behind a task: its parked node of a paused run, else (a user's follow-up) a
 * failed run's last node. */
export function unparkFlowCommand(
  db: Db,
  flowRunId: string,
  nodeRunId: string | null,
  drivingTaskRow: DrivingTaskRow | undefined,
  failedRunFallback: boolean,
): NodeRun | null {
  const node = nodeRunId
    ? unparkNode(db, flowRunId, nodeRunId, {
        nodeStatuses: PARKED_NODE_STATUSES,
        runStatuses: ['paused'],
        drivingTaskRow,
      })
    : null;
  return node ?? (failedRunFallback ? unparkFailedRunCommand(db, flowRunId) : null);
}

/** Nothing to un-park counts as live too, when the node was never parked and the run still runs. */
export function flowStillRunning(db: Db, flowRunId: string, nodeRunId: string | null): boolean {
  if (!nodeRunId || readRun(db, flowRunId)?.status !== 'running') return false;
  const node = db.select().from(nodeRuns).where(eq(nodeRuns.id, nodeRunId)).get();
  return node?.status === 'running';
}

/** Revives a restart-interrupted (cancelled + marker) run's marked node in place. */
export function reviveMarkedNode(db: Db, flowRunId: string): NodeRun | null {
  const marked = restartMarkedNode(db, flowRunId);
  if (!marked) return null;
  return unparkNode(db, flowRunId, marked.id, {
    nodeStatuses: ['cancelled'],
    runStatuses: ['cancelled'],
  });
}

export type ReopenPausedRunOutcome = 'reopened' | 'run-changed' | 'node-changed' | 'no-slot';

/** Reopens a paused run for a renderer approve, retry or skip, only while it is still paused on the
 * node the user reviewed and still holds its active slot. */
export function reopenPausedRunCommand(
  db: Db,
  flowRunId: string,
  nodeRunId: string,
  allowedNodeStatuses: readonly string[],
  snapshot?: FlowResumeSnapshot,
): ReopenPausedRunOutcome {
  if (readRun(db, flowRunId)?.status !== 'paused') return 'run-changed';
  const node = db.select().from(nodeRuns).where(eq(nodeRuns.id, nodeRunId)).get();
  if (
    !node ||
    !allowedNodeStatuses.includes(node.status) ||
    (snapshot && !nodeMatchesResumeSnapshot(db, nodeRunId, snapshot))
  ) {
    return 'node-changed';
  }
  if (!hasActiveSlot(db, flowRunId)) return 'no-slot';
  db.update(flowRuns).set({ status: 'running' }).where(eq(flowRuns.id, flowRunId)).run();
  return 'reopened';
}
