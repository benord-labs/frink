/** Rebuilds the previousOutput advance.ts first handed a node, from persisted node_runs. Pure. */

import { z } from 'zod';
import type { NodeOutput } from '../../../../shared/types/flow';
import type { NodeRun } from '../../db/schema';
import {
  type FanOutItemSource,
  fanOutCompletedOutput,
  iterationOutput,
  laneItemOutputs,
} from '../fan-out';
import { findNodeById, type ParsedFlowGraph, resolveFanOutStructure } from '../graph';

export type FanOutLaneScope = { laneIndex: number; parentFanOutNodeRunId: string };

/** The node_run columns the rebuild reads. */
export type ReplayRow = Pick<
  NodeRun,
  'id' | 'nodeId' | 'status' | 'laneIndex' | 'parentFanOutNodeRunId' | 'nodeOutput'
>;

const ITERATING_FAN_OUT = z.object({
  outputs: z.object({ totalCount: z.number().int().nonnegative() }),
});

const isDone = (nr: ReplayRow): boolean => nr.status === 'completed' || nr.status === 'skipped';
const outputOf = (nr: ReplayRow | undefined): NodeOutput | undefined =>
  // SAFETY: node_output is only written by advanceFlowRun (setNodeRunStatus) with a NodeOutput.
  (nr?.nodeOutput as NodeOutput | null | undefined) ?? undefined;
const inLane = (nr: ReplayRow, scope: FanOutLaneScope): boolean =>
  nr.parentFanOutNodeRunId === scope.parentFanOutNodeRunId && nr.laneIndex === scope.laneIndex;

/** Rows created before the anchor attempt; every row when there is no anchor yet. */
function rowsBefore(nodeRuns: ReplayRow[], beforeNodeRunId: string | undefined): ReplayRow[] {
  const cut = beforeNodeRunId ? nodeRuns.findIndex((nr) => nr.id === beforeNodeRunId) : -1;
  return cut === -1 ? nodeRuns : nodeRuns.slice(0, cut);
}

/** The aggregate a finished Fan Out handed its continuation, from its per-item tail rows. */
function continuationOutput(
  graph: ParsedFlowGraph,
  rows: ReplayRow[],
  fanOutNodeId: string,
): NodeOutput | undefined {
  const fanOutRow = rows.findLast(
    (nr) => nr.nodeId === fanOutNodeId && nr.parentFanOutNodeRunId === null && isDone(nr),
  );
  const fanOutOutput = outputOf(fanOutRow);
  if (!fanOutRow || !fanOutOutput) return undefined;
  // An empty array finishes the Fan Out in one step: its own output reaches the continuation.
  if (fanOutOutput.outputs?._fanOutState === 'completed') return fanOutOutput;
  const resolution = resolveFanOutStructure(graph.nodes, graph.edges, fanOutNodeId);
  const iterating = ITERATING_FAN_OUT.safeParse(fanOutOutput);
  if (!resolution.ok || !iterating.success) return undefined;
  const { totalCount } = iterating.data.outputs;
  const { branches } = resolution.structure;
  const tailIds = new Set(branches.map((branch) => branch.tailNodeId));
  const items: Array<NodeOutput['outputs']> = [];
  for (let laneIndex = 0; laneIndex < totalCount; laneIndex++) {
    const tails = rows.filter(
      (nr) =>
        inLane(nr, { laneIndex, parentFanOutNodeRunId: fanOutRow.id }) &&
        tailIds.has(nr.nodeId) &&
        isDone(nr),
    );
    // A short aggregate would read as a different result; better absent than wrong.
    if (new Set(tails.map((nr) => nr.nodeId)).size !== tailIds.size) return undefined;
    items.push(laneItemOutputs(branches, tails));
  }
  return fanOutCompletedOutput(items);
}

export function reconstructPreviousOutput(args: {
  graph: ParsedFlowGraph;
  /** In listNodeRunsForFlowRun order (createdAt, rowid). */
  nodeRuns: ReplayRow[];
  nodeId: string;
  /** The Fan Out item the node runs in; absent for a top-level node. */
  scope?: FanOutLaneScope;
  /** The attempt being replaced: only rows before it can have fed it. */
  beforeNodeRunId?: string;
  /** Live iteration state of the node's Fan Out, needed to rebuild a body root's item. */
  fanOutState?: FanOutItemSource;
}): NodeOutput | undefined {
  const { graph, nodeId, scope, fanOutState } = args;
  const node = findNodeById(graph.nodes, nodeId);
  if (!node) return undefined;
  const rows = rowsBefore(args.nodeRuns, args.beforeNodeRunId);
  const sourceIds = new Set(graph.edges.filter((e) => e.target === nodeId).map((e) => e.source));

  if (node.parentId) {
    if (!scope) return undefined;
    if (sourceIds.has(node.parentId)) {
      if (fanOutState) return iterationOutput(fanOutState, scope.laneIndex);
      // Item 0's root is handed the fan_out's own output, which needs no live state.
      if (scope.laneIndex !== 0) return undefined;
      return outputOf(rows.find((nr) => nr.id === scope.parentFanOutNodeRunId && isDone(nr)));
    }
    return outputOf(
      rows.findLast((nr) => sourceIds.has(nr.nodeId) && inLane(nr, scope) && isDone(nr)),
    );
  }

  const fanOutOwners = new Set(
    [...sourceIds].map((id) => findNodeById(graph.nodes, id)?.parentId).filter(Boolean),
  );
  const [fanOutNodeId] = fanOutOwners;
  if (fanOutNodeId) return continuationOutput(graph, rows, fanOutNodeId);

  return outputOf(
    rows.findLast(
      (nr) => sourceIds.has(nr.nodeId) && nr.parentFanOutNodeRunId === null && isDone(nr),
    ),
  );
}
