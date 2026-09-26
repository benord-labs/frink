/**
 * Pure transform: DbFlowRunWithNodeRuns → compact summary for frink_flows_get_run.
 *
 * Separated from MCP tool scaffolding for testability and future sc-584 migration
 * (where this data will be served as an MCP resource instead of a tool).
 */

import { type FlowNode, formatFlowNodeLabel } from '../../../../shared/lib/validate-flow-graph';
import type { DbFlowRunWithNodeRuns, DbNodeRun } from '../../../../shared/types/flow-run';

export const MAX_SUMMARY_NODES = 50;

// ---------------------------------------------------------------------------
// Duration helpers
// ---------------------------------------------------------------------------

/** Duration in ms between two nullable ISO timestamps. Returns null if not started. */
function computeDurationMs(
  startedAt: string | null,
  completedAt: string | null,
): number | null {
  if (!startedAt) return null;
  const start = new Date(startedAt).getTime();
  if (Number.isNaN(start)) return null;
  if (completedAt) {
    const end = new Date(completedAt).getTime();
    if (Number.isNaN(end)) return null;
    return Math.max(0, end - start);
  }
  return Math.max(0, Date.now() - start);
}

// ---------------------------------------------------------------------------
// Error extraction
// ---------------------------------------------------------------------------

function extractError(nodeOutput: Record<string, unknown> | null): {
  error: string | null;
  retryable: boolean;
} {
  if (!nodeOutput) return { error: null, retryable: false };
  const err = nodeOutput.error as { message?: string; retryable?: boolean } | undefined;
  return {
    error: err?.message ?? null,
    retryable: err?.retryable ?? false,
  };
}

// ---------------------------------------------------------------------------
// Output types
// ---------------------------------------------------------------------------

type NodeSummary = {
  nodeRunId: string;
  nodeId: string;
  label: string;
  blockType: string;
  status: string;
  durationMs: number | null;
  attemptNumber: number;
  error: string | null;
  retryable: boolean;
};

export type FanOutSummary = {
  nodeRunId: string;
  nodeId: string;
  label: string;
  blockType: 'fan_out';
  status: string;
  durationMs: number | null;
  totalLanes: number;
  completedLanes: number;
  failedLanes: number;
  failedLaneNodeRunIds: string[];
};

export type NodeEntry = NodeSummary | FanOutSummary;

/** Narrows `NodeEntry` — `blockType === 'fan_out'` alone does not (NodeSummary.blockType is `string`). */
export function isFanOutSummary(entry: NodeEntry): entry is FanOutSummary {
  return entry.blockType === 'fan_out';
}

export type FlowRunSummary = {
  run: {
    id: string;
    status: string;
    startedAt: string | null;
    completedAt: string | null;
    durationMs: number | null;
  };
  nodes: NodeEntry[];
  totalNodeRuns: number;
  shownNodeRuns: number;
};

// ---------------------------------------------------------------------------
// Main transform
// ---------------------------------------------------------------------------

export function mapFlowRunToSummary(run: DbFlowRunWithNodeRuns): FlowRunSummary {
  const { nodeRuns, graph } = run;

  // Build nodeId → label map from graph snapshot
  const labelMap = new Map<string, string>();
  if (graph?.nodes) {
    for (const node of graph.nodes as FlowNode[]) {
      labelMap.set(node.id, formatFlowNodeLabel(node));
    }
  }

  function getLabel(nodeId: string, blockType: string): string {
    return labelMap.get(nodeId) ?? blockType;
  }

  // Partition: top-level vs fan-out lane children
  const topLevel: DbNodeRun[] = [];
  const childrenByFanOutRunId = new Map<string, DbNodeRun[]>();

  for (const nr of nodeRuns) {
    if (nr.parent_fan_out_node_run_id === null) {
      topLevel.push(nr);
    } else {
      const list = childrenByFanOutRunId.get(nr.parent_fan_out_node_run_id) ?? [];
      list.push(nr);
      childrenByFanOutRunId.set(nr.parent_fan_out_node_run_id, list);
    }
  }

  const entries: NodeEntry[] = [];

  for (const nr of topLevel) {
    if (nr.block_type === 'fan_out') {
      entries.push(buildFanOutEntry(nr, childrenByFanOutRunId, getLabel));
    } else {
      entries.push(buildNodeEntry(nr, getLabel));
    }
  }

  const totalNodeRuns = nodeRuns.length;
  const shown = entries.slice(0, MAX_SUMMARY_NODES);

  return {
    run: {
      id: run.id,
      status: run.status,
      startedAt: run.started_at,
      completedAt: run.completed_at,
      durationMs: computeDurationMs(run.started_at, run.completed_at),
    },
    nodes: shown,
    totalNodeRuns,
    shownNodeRuns: shown.length,
  };
}

// ---------------------------------------------------------------------------
// Entry builders
// ---------------------------------------------------------------------------

function buildNodeEntry(
  nr: DbNodeRun,
  getLabel: (nodeId: string, blockType: string) => string,
): NodeSummary {
  const { error, retryable } = extractError(nr.node_output);
  return {
    nodeRunId: nr.id,
    nodeId: nr.node_id,
    label: getLabel(nr.node_id, nr.block_type),
    blockType: nr.block_type,
    status: nr.status,
    durationMs: computeDurationMs(nr.started_at, nr.completed_at),
    attemptNumber: nr.attempt_number,
    error,
    retryable,
  };
}

function buildFanOutEntry(
  nr: DbNodeRun,
  childrenByFanOutRunId: Map<string, DbNodeRun[]>,
  getLabel: (nodeId: string, blockType: string) => string,
): FanOutSummary {
  const children = childrenByFanOutRunId.get(nr.id) ?? [];

  // Group by lane_index to get per-lane status
  const laneMap = new Map<number, DbNodeRun[]>();
  for (const child of children) {
    const laneIdx = child.lane_index ?? 0;
    const lane = laneMap.get(laneIdx) ?? [];
    lane.push(child);
    laneMap.set(laneIdx, lane);
  }

  const failedLaneNodeRunIds: string[] = [];
  let completedLanes = 0;
  let failedLanes = 0;

  for (const [, laneNodes] of laneMap) {
    const failingNode = laneNodes.find(
      (n) => n.status === 'failed' || n.status === 'cancelled' || n.status === 'timed_out',
    );
    if (failingNode) {
      failedLanes++;
      failedLaneNodeRunIds.push(failingNode.id);
    } else if (laneNodes.every((n) => n.status === 'completed')) {
      completedLanes++;
    }
  }

  return {
    nodeRunId: nr.id,
    nodeId: nr.node_id,
    label: getLabel(nr.node_id, nr.block_type),
    blockType: 'fan_out',
    status: nr.status,
    durationMs: computeDurationMs(nr.started_at, nr.completed_at),
    totalLanes: laneMap.size,
    completedLanes,
    failedLanes,
    failedLaneNodeRunIds,
  };
}
