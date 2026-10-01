/** The async tail of every in-place un-park: commit the command under the admission transaction,
 * re-arm the watcher for the driving task in the commit's tick, then re-emit started events. */

import type { NodeRun } from '../../db/schema';
import { loadRunContext } from '../advance';
import { emitNodeStarted, emitRunStarted } from '../event-emit';
import { findNodeById } from '../graph';
import { forgetAdvancedTask } from '../task-completion-watcher';

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
  const graphNode = findNodeById(ctx.graph.nodes, node.nodeId);
  emitRunStarted(ctx.meta, flowRunId);
  emitNodeStarted(ctx.meta, flowRunId, node.nodeId, node.blockType, graphNode?.label);
}
