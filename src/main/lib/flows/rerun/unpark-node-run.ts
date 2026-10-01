/** The async tail of every in-place un-park: commit the command under the admission transaction,
 * re-arm the watcher for the driving task in the commit's tick, then re-emit started events. */

import { eq } from 'drizzle-orm';
import { getDatabase } from '../../db';
import { type NodeRun, nodeRuns } from '../../db/schema';
import { loadRunContext } from '../advance';
import { emitNodeStarted, emitRunStarted } from '../event-emit';
import { findNodeById } from '../graph';
import { forgetAdvancedTask } from '../task-completion-watcher';
import { readRunFence } from '../transitions/fence';

/** True when the command un-parked a node. Commands decline with no writes. */
export async function commitUnpark(
  flowRunId: string,
  command: () => NodeRun | null,
  drivingTaskId?: string,
): Promise<boolean> {
  const { transitionFlowRun } = await import('../admission/runtime');
  const node = await transitionFlowRun(command, (unparked) => {
    if (unparked && drivingTaskId) forgetAdvancedTask(drivingTaskId);
  });
  if (node) await emitUnparked(flowRunId, node);
  return node !== null;
}

export async function emitUnparked(flowRunId: string, node: NodeRun): Promise<void> {
  const ctx = await loadRunContext(flowRunId);
  if (!ctx) return;
  // Re-read after loadRunContext's awaits: a Cancel or settle that committed since the un-park wins.
  const db = getDatabase();
  const nodeRow = db
    .select({ status: nodeRuns.status })
    .from(nodeRuns)
    .where(eq(nodeRuns.id, node.id))
    .get();
  if (readRunFence(db, flowRunId)) emitRunStarted(ctx.meta, flowRunId);
  if (nodeRow?.status !== 'running') return;
  const graphNode = findNodeById(ctx.graph.nodes, node.nodeId);
  emitNodeStarted(ctx.meta, flowRunId, node.nodeId, node.blockType, graphNode?.label);
}
