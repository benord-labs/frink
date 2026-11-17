/**
 * Where a re-dispatched flow_run should resume from — pure graph/node_run analysis, no engine
 * imports (keeps it off the advance ↔ scheduler ↔ batch-dispatch cycle). Shared by restart and
 * terminal-resume recovery.
 */

import { isTriggerBlockType } from '../../../../shared/lib/block-registry';
import { SUPERSEDED_NODE_STATUS } from '../../../../shared/types/flow';
import type { NodeRun } from '../../db/schema';
import { type ParsedFlowGraph, pickNextTargetNodeId } from '../graph';

/** The fields that place an attempt and say whether it stopped the run. */
export type AttemptRow = Pick<
  NodeRun,
  'nodeId' | 'status' | 'parentFanOutNodeRunId' | 'laneIndex' | 'nodeOutput'
>;

/** A superseded attempt is history, not a resume point: its retry row stands in for it. */
const isUnfinished = (nr: AttemptRow): boolean =>
  nr.status !== 'completed' && nr.status !== 'skipped' && nr.status !== SUPERSEDED_NODE_STATUS;

/** Cancelled by the run-terminal sweep, which writes only the status: the row's own output never
 * says cancelled (a restart marker or a user Stop does). */
function isSwept(nr: AttemptRow): boolean {
  if (nr.status !== 'cancelled') return false;
  const output = nr.nodeOutput as { status?: unknown } | null | undefined;
  return output?.status !== 'cancelled';
}

const attemptSlot = (nr: AttemptRow): string =>
  `${nr.nodeId}\u0000${nr.parentFanOutNodeRunId ?? ''}\u0000${nr.laneIndex ?? ''}`;

/** The node_run that stopped the run: the newest unfinished latest attempt that the sweep did not
 * cancel, else the newest unfinished row; undefined when every node completed/skipped. */
export function lastUnfinishedNodeRun<T extends AttemptRow>(nodeRunsForRun: T[]): T | undefined {
  const newestFirst = [...nodeRunsForRun].reverse();
  const seenSlots = new Set<string>();
  const cause = newestFirst.find((nr) => {
    const slot = attemptSlot(nr);
    const latestAttempt = !seenSlots.has(slot);
    seenSlots.add(slot);
    return latestAttempt && isUnfinished(nr) && !isSwept(nr);
  });
  return cause ?? newestFirst.find(isUnfinished);
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
