/** Sibling Fan Out branches a terminal resume re-dispatches with its anchor, so the item barrier
 * (fan-out-step.ts) can close. Pure graph/node_run analysis — no engine imports. */

import type { FanOutBranch } from '../../../../shared/lib/compute-fan-out-body-chain';
import type { NodeOutput } from '../../../../shared/types/flow';
import type { NodeRun } from '../../db/schema';
import type { FanOutItemSource } from '../fan-out';
import {
  type FlowGraphNode,
  findNodeById,
  type ParsedFlowGraph,
  resolveFanOutStructure,
} from '../graph';
import { reconstructPreviousOutput } from './predecessor-output';

export type SiblingBranchResumeTarget = {
  node: FlowGraphNode;
  /** The output the branch's resume node was first dispatched with, when it can be rebuilt. */
  previousOutput?: NodeOutput;
};

const isDone = (nr: NodeRun): boolean => nr.status === 'completed' || nr.status === 'skipped';
/** Ended without finishing: the only rows a resume re-dispatches. Live rows are left alone. */
const isStopped = (nr: NodeRun): boolean => nr.status === 'cancelled' || nr.status === 'failed';

/** One branch's resume node from its newest row in the lane; undefined when it has nothing to do. */
function branchResumeNodeId(branch: FanOutBranch, laneRuns: NodeRun[]): string | undefined {
  const latest = laneRuns.filter((nr) => branch.nodeIds.includes(nr.nodeId)).at(-1);
  if (!latest) return branch.rootNodeId;
  if (isStopped(latest)) return latest.nodeId;
  if (!isDone(latest) || latest.nodeId === branch.tailNodeId) return undefined;
  return branch.nodeIds[branch.nodeIds.indexOf(latest.nodeId) + 1];
}

/** The anchor's Fan Out branches, or undefined when the anchor is not inside a resolvable Fan Out. */
function anchorBranches(graph: ParsedFlowGraph, anchor: NodeRun): FanOutBranch[] | undefined {
  if (!anchor.parentFanOutNodeRunId || anchor.laneIndex === null) return undefined;
  const fanOutNodeId = findNodeById(graph.nodes, anchor.nodeId)?.parentId;
  if (!fanOutNodeId) return undefined;
  const resolution = resolveFanOutStructure(graph.nodes, graph.edges, fanOutNodeId);
  return resolution.ok ? resolution.structure.branches : undefined;
}

/** Where each OTHER branch of the anchor's Fan Out item resumes, with the previousOutput it was
 * (or would have been) first dispatched with; [] outside a Fan Out lane. */
export function siblingBranchResumeTargets(
  graph: ParsedFlowGraph,
  nodeRunsForRun: NodeRun[],
  anchor: NodeRun,
  fanOutState?: FanOutItemSource,
): SiblingBranchResumeTarget[] {
  const branches = anchorBranches(graph, anchor) ?? [];
  const parentFanOutNodeRunId = anchor.parentFanOutNodeRunId;
  const laneIndex = anchor.laneIndex;
  if (!parentFanOutNodeRunId || laneIndex === null) return [];
  const laneRuns = nodeRunsForRun.filter(
    (nr) => nr.parentFanOutNodeRunId === parentFanOutNodeRunId && nr.laneIndex === laneIndex,
  );
  return branches
    .filter((branch) => !branch.nodeIds.includes(anchor.nodeId))
    .flatMap((branch) => {
      const nodeId = branchResumeNodeId(branch, laneRuns);
      const node = nodeId ? findNodeById(graph.nodes, nodeId) : undefined;
      if (!node) return [];
      const previousOutput = reconstructPreviousOutput({
        graph,
        nodeRuns: nodeRunsForRun,
        nodeId: node.id,
        scope: { laneIndex, parentFanOutNodeRunId },
        fanOutState,
      });
      return previousOutput ? [{ node, previousOutput }] : [{ node }];
    });
}
