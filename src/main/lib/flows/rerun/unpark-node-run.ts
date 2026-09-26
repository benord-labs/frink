/** Shared tail of every in-place resume: node_run → running, flow_run → running, evict the driving
 * task from the watcher's advanced-set, re-emit started events. Each write is a CAS on the row read. */

import type { getDatabase } from '../../db';
import { type FlowRunStatus, setFlowRunStatus } from '../../db/repos/flow-runs';
import {
  getNodeRun,
  listNodeRunsForFlowRun,
  type NodeRunStatus,
  setNodeRunStatus,
} from '../../db/repos/node-runs';
import type { NodeRun } from '../../db/schema';
import { loadRunContext } from '../advance';
import { emitNodeStarted, emitRunStarted } from '../event-emit';
import { findNodeById } from '../graph';
import { forgetAdvancedTask } from '../task-completion-watcher';

type Db = ReturnType<typeof getDatabase>;

/** The exact driving-task row an un-park was decided on (see setNodeRunStatus.expectDrivingTask). */
export type DrivingTaskRow = { id: string; status: string; result: unknown };

export type UnparkOptions = {
  /** Run states this entry point may re-open (CAS). */
  fromRunStatuses: readonly FlowRunStatus[];
  /** The driving-task row the caller read: the node write holds only while it is unchanged. */
  drivingTaskRow?: DrivingTaskRow;
  /** The node row the caller already read, so it is not read twice. */
  prior?: NodeRun;
};

export async function unparkNodeRunInPlace(
  db: Db,
  flowRunId: string,
  nodeRunId: string,
  drivingTaskId: string | undefined,
  expectStatuses: readonly NodeRunStatus[],
  opts: UnparkOptions,
): Promise<boolean> {
  const prior = opts.prior ?? (await getNodeRun(db, nodeRunId));
  if (!prior) return false;
  // SAFETY: `prior` is a node_runs row, whose status column only ever holds NodeRunStatus values.
  const priorStatus = prior.status as NodeRunStatus;
  // CAS on the exact status read, so a rollback can only ever restore the row it saw.
  if (!expectStatuses.includes(priorStatus)) return false;
  const updated = await setNodeRunStatus(db, nodeRunId, 'running', {
    completedAt: null,
    nodeOutput: null,
    expectStatuses: [priorStatus],
    expectDrivingTask: opts.drivingTaskRow,
  });
  if (!updated) return false;
  if (!(await hasParkedFanOutSibling(db, flowRunId, updated))) {
    const reopened = await reopenRun(db, flowRunId, opts.fromRunStatuses);
    if (!reopened) {
      await rollBackNode(db, nodeRunId, prior, priorStatus);
      return false;
    }
  }
  if (drivingTaskId) forgetAdvancedTask(drivingTaskId);
  await emitUnparked(flowRunId, updated);
  return true;
}

/** A fan-out lane stays paused while a sibling lane of the same iteration is still parked. */
async function hasParkedFanOutSibling(db: Db, flowRunId: string, node: NodeRun): Promise<boolean> {
  if (node.parentFanOutNodeRunId === null || node.laneIndex === null) return false;
  return (await listNodeRunsForFlowRun(db, flowRunId)).some(
    (sibling) =>
      sibling.id !== node.id &&
      sibling.parentFanOutNodeRunId === node.parentFanOutNodeRunId &&
      sibling.laneIndex === node.laneIndex &&
      (sibling.status === 'awaiting_input' || sibling.status === 'blocked'),
  );
}

/** CAS on the states this entry point may re-open: a run that ended under the unpark (a fast
 * terminal, a user cancel) is never resurrected and gets no started events. */
async function reopenRun(
  db: Db,
  flowRunId: string,
  fromRunStatuses: readonly FlowRunStatus[],
): Promise<boolean> {
  return Boolean(await setFlowRunStatus(db, flowRunId, 'running', {}, fromRunStatuses));
}

/** Put the node back to the parked row it was, so nothing runs beneath a finished flow. */
async function rollBackNode(
  db: Db,
  nodeRunId: string,
  prior: NodeRun,
  priorStatus: NodeRunStatus,
): Promise<void> {
  await setNodeRunStatus(db, nodeRunId, priorStatus, {
    completedAt: prior.completedAt,
    nodeOutput: prior.nodeOutput,
    expectStatuses: ['running'],
  });
}

async function emitUnparked(flowRunId: string, node: NodeRun): Promise<void> {
  const ctx = await loadRunContext(flowRunId);
  if (!ctx) return;
  const graphNode = findNodeById(ctx.graph.nodes, node.nodeId);
  emitRunStarted(ctx.meta, flowRunId);
  emitNodeStarted(ctx.meta, flowRunId, node.nodeId, node.blockType, graphNode?.label);
}
