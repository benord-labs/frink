/**
 * Where a re-dispatched flow_run should resume from — pure graph/node_run analysis, no engine
 * imports (keeps it off the advance ↔ scheduler ↔ batch-dispatch cycle). Shared by restart and
 * terminal-resume recovery.
 */

import { isTriggerBlockType } from '../../../../shared/lib/block-registry';
import type { NodeRun } from '../../db/schema';
import { type ParsedFlowGraph, pickNextTargetNodeId } from '../graph';

/** The last node_run that did not finish successfully; undefined when every node completed/skipped. */
export function lastUnfinishedNodeRun(nodeRunsForRun: NodeRun[]): NodeRun | undefined {
  return [...nodeRunsForRun]
    .reverse()
    .find((nr) => nr.status !== 'completed' && nr.status !== 'skipped');
}

/**
 * The node a resume starts from: the first node AFTER `start_task` because the worktree/chat already
 * exist. Falls back to the first node after the trigger, else the first node.
 */
function rerunStartNode(graph: ParsedFlowGraph): string | undefined {
  const startTask = graph.nodes.find((n) => n.blockType === 'start_task');
  if (startTask) {
    return pickNextTargetNodeId(graph.edges, startTask.id) ?? startTask.id;
  }
  const trigger = graph.nodes.find((n) => isTriggerBlockType(n.blockType));
  if (trigger) return pickNextTargetNodeId(graph.edges, trigger.id);
  return graph.nodes[0]?.id;
}

/**
 * The node id to re-dispatch a run from: its last unfinished node, or — when every node completed
 * (a restart-recovery resume of a fully-successful run) — the first node after start_task (the
 * worktree/chat already exist). Returns undefined when the graph has no dispatchable node.
 */
export function resolveRerunStartNode(
  graph: ParsedFlowGraph,
  nodeRuns: NodeRun[],
): string | undefined {
  return lastUnfinishedNodeRun(nodeRuns)?.nodeId ?? rerunStartNode(graph);
}
