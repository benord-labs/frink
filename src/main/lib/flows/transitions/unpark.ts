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
import { batchStageRuns, flowRuns, flowVersions, type NodeRun, nodeRuns } from '../../db/schema';
import { liveAdmissionForRun } from '../admission/store';
import { parseGraph } from '../graph';
import { siblingBranchResumeTargets } from '../rerun/fan-out-lane-resume';
import { type AttemptRow, lastUnfinishedNodeRun } from '../rerun/resume-point';
import { type RunFence, readRunFence } from './fence';
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

/** A run's node_runs, oldest first, read synchronously for a transaction. */
export const readNodeRuns = (db: Db, flowRunId: string): NodeRun[] =>
  db
    .select()
    .from(nodeRuns)
    .where(eq(nodeRuns.flowRunId, flowRunId))
    .orderBy(asc(nodeRuns.createdAt), asc(drizzleSql`rowid`))
    .all();

/** One run's last unfinished node_run when it carries the restart-interruption marker. */
function markedAmong<T extends AttemptRow>(nodeRunsForRun: T[]): T | undefined {
  const last = lastUnfinishedNodeRun(nodeRunsForRun);
  const output = last?.nodeOutput as NodeOutput | null | undefined;
  return output?.error?.message === RESTART_INTERRUPTION_REASON ? last : undefined;
}

export const restartMarkedNode = (db: Db, flowRunId: string): NodeRun | undefined =>
  markedAmong(readNodeRuns(db, flowRunId));

/** A settled run whose stopped step may still recover. */
export type SettledRun = { id: string; status: 'failed' | 'cancelled' };

/** A settled run's stop candidate: only the fields the stop rule and its recovery read. */
export type StopNode = AttemptRow & Pick<NodeRun, 'id' | 'flowRunId' | 'blockType' | 'startedAt'>;

/** Only the parts of node_output the stop rule reads (a sweep's status, a restart's marker), so a
 * Work Queue page never loads every step's output blob. */
const stopRuleOutput = drizzleSql<NodeRun['nodeOutput']>`json_object(
  'status', json_extract(${nodeRuns.nodeOutput}, '$.status'),
  'error', json_object('message', json_extract(${nodeRuns.nodeOutput}, '$.error.message'))
)`.mapWith(nodeRuns.nodeOutput);

/** The step each settled run stopped on, in a single read for any number of runs: a failed run's
 * last unfinished step, a cancelled run's restart-marked one (a user Stop has none). */
export function settledStopNodes(db: Db, runs: readonly SettledRun[]): StopNode[] {
  const byRun = new Map<string, StopNode[]>();
  const rows = db
    .select({
      id: nodeRuns.id,
      flowRunId: nodeRuns.flowRunId,
      nodeId: nodeRuns.nodeId,
      status: nodeRuns.status,
      blockType: nodeRuns.blockType,
      startedAt: nodeRuns.startedAt,
      parentFanOutNodeRunId: nodeRuns.parentFanOutNodeRunId,
      laneIndex: nodeRuns.laneIndex,
      nodeOutput: stopRuleOutput,
    })
    .from(nodeRuns)
    .where(
      inArray(
        nodeRuns.flowRunId,
        runs.map((run) => run.id),
      ),
    )
    .orderBy(asc(nodeRuns.createdAt), asc(drizzleSql`rowid`))
    .all();
  for (const row of rows) {
    const runRows = byRun.get(row.flowRunId) ?? [];
    runRows.push(row);
    byRun.set(row.flowRunId, runRows);
  }
  return runs.flatMap((run) => {
    const runRows = byRun.get(run.id) ?? [];
    return (run.status === 'failed' ? lastUnfinishedNodeRun(runRows) : markedAmong(runRows)) ?? [];
  });
}

/** Cancelled by a restart, not by the user: the run is `cancelled` and still carries the marker. */
export const isRestartInterrupted = (db: Db, flowRunId: string): boolean =>
  readRun(db, flowRunId)?.status === 'cancelled' && restartMarkedNode(db, flowRunId) !== undefined;

/** Cancelled by the user: `cancelled` without a restart's marker, so only a fresh run may follow. */
export const isUserCancelled = (db: Db, flowRunId: string): boolean =>
  readRun(db, flowRunId)?.status === 'cancelled' && restartMarkedNode(db, flowRunId) === undefined;

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

/** A failed Fan Out branch whose failure swept its siblings: un-parking it alone would strand the
 * item's barrier, so only the run-level re-dispatch (which resumes every branch) may continue it. */
function leavesSiblingBranchesBehind(
  db: Db,
  flowVersionId: string,
  attempts: NodeRun[],
  anchor: NodeRun,
): boolean {
  if (!anchor.parentFanOutNodeRunId) return false;
  const version = db
    .select({ graph: flowVersions.graph })
    .from(flowVersions)
    .where(eq(flowVersions.id, flowVersionId))
    .get();
  if (!version) return false;
  return siblingBranchResumeTargets(parseGraph(version.graph), attempts, anchor).length > 0;
}

/** Un-parks a failed or paused run's last unfinished node; never a cancelled run. A batch member
 * only while its stage still waits for it. */
export function unparkFailedRunCommand(db: Db, flowRunId: string): NodeRun | null {
  const run = readRun(db, flowRunId);
  if (!run || run.status === 'cancelled') return null;
  if (run.batchId != null) {
    const stage = db
      .select({ status: batchStageRuns.status })
      .from(batchStageRuns)
      .where(eq(batchStageRuns.flowRunId, flowRunId))
      .get();
    if (stage?.status !== 'dispatched') return null;
  }
  const attempts = readNodeRuns(db, flowRunId);
  const last = lastUnfinishedNodeRun(attempts);
  if (!last) return null;
  if (
    run.status === 'failed' &&
    leavesSiblingBranchesBehind(db, run.flowVersionId, attempts, last)
  ) {
    return null;
  }
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

export type ReopenDeclined = 'run-changed' | 'node-changed' | 'no-slot';

/** Reopens a paused run for a renderer approve, retry or skip, only while it is still paused on the
 * node the user reviewed and still holds its active slot; returns the fence the resume carries. */
export function reopenPausedRunCommand(
  db: Db,
  flowRunId: string,
  nodeRunId: string,
  allowedNodeStatuses: readonly string[],
  snapshot?: FlowResumeSnapshot,
): RunFence | ReopenDeclined {
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
  return readRunFence(db, flowRunId) ?? 'run-changed';
}
