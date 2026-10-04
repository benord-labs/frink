/** Sibling Fan Out branches a terminal resume re-dispatches with its anchor, so the item barrier
 * (fan-out-step.ts) can close. Pure graph/node_run analysis — no engine imports. */

import type { FanOutBranch } from '../../../../shared/lib/compute-fan-out-body-chain';
import type { NodeOutput } from '../../../../shared/types/flow';
import type { NodeRun } from '../../db/schema';
import {
  type FlowGraphNode,
  findNodeById,
  type ParsedFlowGraph,
  resolveFanOutStructure,
} from '../graph';

export type SiblingBranchResumeTarget = {
  node: FlowGraphNode;
  /** The completed predecessor's output when the branch resumes at its next node. */
  previousOutput?: NodeOutput;
};

const isDone = (nr: NodeRun): boolean => nr.status === 'completed' || nr.status === 'skipped';
/** Ended without finishing: the only rows a resume re-dispatches. Live rows are left alone. */
const isStopped = (nr: NodeRun): boolean => nr.status === 'cancelled' || nr.status === 'failed';

type BranchResumePoint = { nodeId: string; previousOutput?: NodeOutput };

/** One branch's resume point from its newest row in the lane; undefined when it has nothing to do. */
function branchResumePoint(
  branch: FanOutBranch,
  laneRuns: NodeRun[],
): BranchResumePoint | undefined {
  const latest = laneRuns.filter((nr) => branch.nodeIds.includes(nr.nodeId)).at(-1);
  if (!latest) return { nodeId: branch.rootNodeId };
  if (isStopped(latest)) return { nodeId: latest.nodeId };
  if (!isDone(latest) || latest.nodeId === branch.tailNodeId) return undefined;
  const nodeId = branch.nodeIds[branch.nodeIds.indexOf(latest.nodeId) + 1];
  const previousOutput = (latest.nodeOutput as NodeOutput | null) ?? undefined;
  return nodeId ? { nodeId, previousOutput } : undefined;
}

/** The anchor's Fan Out branches, or undefined when the anchor is not inside a resolvable Fan Out. */
function anchorBranches(graph: ParsedFlowGraph, anchor: NodeRun): FanOutBranch[] | undefined {
  if (!anchor.parentFanOutNodeRunId || anchor.laneIndex === null) return undefined;
  const fanOutNodeId = findNodeById(graph.nodes, anchor.nodeId)?.parentId;
  if (!fanOutNodeId) return undefined;
  const resolution = resolveFanOutStructure(graph.nodes, graph.edges, fanOutNodeId);
  return resolution.ok ? resolution.structure.branches : undefined;
}

/** Where each OTHER branch of the anchor's Fan Out item resumes; [] outside a Fan Out lane. */
export function siblingBranchResumeTargets(
  graph: ParsedFlowGraph,
  nodeRunsForRun: NodeRun[],
  anchor: NodeRun,
): SiblingBranchResumeTarget[] {
  const branches = anchorBranches(graph, anchor) ?? [];
  const laneRuns = nodeRunsForRun.filter(
    (nr) =>
      nr.parentFanOutNodeRunId === anchor.parentFanOutNodeRunId &&
      nr.laneIndex === anchor.laneIndex,
  );
  return branches
    .filter((branch) => !branch.nodeIds.includes(anchor.nodeId))
    .flatMap((branch) => {
      const point = branchResumePoint(branch, laneRuns);
      const node = point ? findNodeById(graph.nodes, point.nodeId) : undefined;
      if (!node) return [];
      return point?.previousOutput ? [{ node, previousOutput: point.previousOutput }] : [{ node }];
    });
}
