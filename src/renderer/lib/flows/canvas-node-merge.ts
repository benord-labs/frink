/**
 * Pure collapse of DB node_runs into per-node canvas overlay states — extracted from
 * use-flow-canvas-execution so the hook stays subscription/atom wiring only. Typed structurally
 * (CanvasNodeRun) so this lib module never imports src/main types.
 */
import { computeFanOutBodyChain } from '../../../shared/lib/compute-fan-out-body-chain';
import type { FlowGraph } from '../../../shared/lib/validate-flow-graph';
import { countUniqueLanesByParent } from './count-unique-lanes-by-parent';

/**
 * The node_run columns the canvas merge reads (structural subset of DbNodeRun). snake_case is the
 * flows IPC casing contract (decision flows-ipc-casing-contract) — DTOs stay snake end-to-end.
 */
export type CanvasNodeRun = {
  id: string;
  // biome-ignore lint/style/useNamingConvention: flows IPC snake_case contract
  flow_run_id: string;
  // biome-ignore lint/style/useNamingConvention: flows IPC snake_case contract
  node_id: string;
  // biome-ignore lint/style/useNamingConvention: flows IPC snake_case contract
  block_type: string;
  status: string;
  // biome-ignore lint/style/useNamingConvention: flows IPC snake_case contract
  node_output: unknown;
  // biome-ignore lint/style/useNamingConvention: flows IPC snake_case contract
  attempt_number: number;
  // biome-ignore lint/style/useNamingConvention: flows IPC snake_case contract
  lane_index: number | null;
  // biome-ignore lint/style/useNamingConvention: flows IPC snake_case contract
  parent_fan_out_node_run_id: string | null;
};

type CanvasOverlayNodeStatus =
  | 'running'
  | 'completed'
  | 'failed'
  | 'skipped'
  | 'awaiting_input'
  | 'blocked';

export type CanvasOverlayNodeState = {
  status: CanvasOverlayNodeStatus;
  loopIteration?: number;
  loopTotalCount?: number;
};

/** Node_run statuses that count as "the node is occupying the canvas" (working or parked). */
export const ACTIVE_NODE_STATUSES = new Set(['running', 'awaiting_input', 'blocked']);

/**
 * Collapse a node's active rows to one overlay status by priority: any truly running lane paints
 * `running`; otherwise a park paints as itself (`awaiting_input` over `blocked`), so a waiting
 * flow no longer masquerades as working on the canvas.
 */
function activeStatusForCanvas(rows: CanvasNodeRun[]): CanvasOverlayNodeStatus {
  if (rows.some((r) => r.status === 'running')) return 'running';
  return rows.some((r) => r.status === 'awaiting_input') ? 'awaiting_input' : 'blocked';
}

/**
 * Whether `other` is a body run for this fan_out `nr`: parallel lane (`parent_fan_out_node_run_id`)
 * or sequential body chain from `graph` (same `flow_run_id`).
 */
function isFanOutBodyNodeRun(
  other: CanvasNodeRun,
  nr: CanvasNodeRun,
  bodyChainFromGraph: Set<string> | null,
): boolean {
  if (other.node_id === nr.node_id) return false;
  if (other.flow_run_id !== nr.flow_run_id) return false;
  if (other.parent_fan_out_node_run_id === nr.id) return true;
  return bodyChainFromGraph?.has(other.node_id) ?? false;
}

/**
 * Collapse DB node_runs (multiple rows per graph node_id in fan-out lanes) into one
 * canvas overlay state per node.
 *
 * @param graph When set, sequential fan_out loop badges use `computeFanOutBodyChain` so
 * `attempt_number` is scoped to that fan_out's body only (not unrelated graph nodes).
 */
export function mergeNodeRunsForCanvas(
  nodeRuns: CanvasNodeRun[],
  graph: FlowGraph | null | undefined,
): Map<string, CanvasOverlayNodeState> {
  const byNode = new Map<string, CanvasNodeRun[]>();
  for (const nr of nodeRuns) {
    const list = byNode.get(nr.node_id) ?? [];
    list.push(nr);
    byNode.set(nr.node_id, list);
  }

  const laneCounts = countUniqueLanesByParent(nodeRuns);

  const out = new Map<string, CanvasOverlayNodeState>();

  for (const [nodeId, rows] of byNode) {
    const activeLike = rows.filter((r) => ACTIVE_NODE_STATUSES.has(r.status));
    if (activeLike.length > 0) {
      let maxLane = -1;
      let parentFanOutRunId: string | null = null;
      for (const r of activeLike) {
        if (r.lane_index != null && r.lane_index > maxLane) {
          maxLane = r.lane_index;
          parentFanOutRunId = r.parent_fan_out_node_run_id;
        }
      }
      const laneCount =
        parentFanOutRunId != null ? (laneCounts.get(parentFanOutRunId) ?? undefined) : undefined;
      out.set(nodeId, {
        status: activeStatusForCanvas(activeLike),
        loopIteration: maxLane >= 0 ? maxLane : undefined,
        loopTotalCount: laneCount,
      });
      continue;
    }

    const hasPending = rows.some((r) => r.status === 'pending');
    const hasNonPending = rows.some((r) => r.status !== 'pending');
    if (hasPending && hasNonPending) {
      out.set(nodeId, { status: 'running' });
      continue;
    }
    if (hasPending && !hasNonPending) {
      continue;
    }

    if (rows.some((r) => r.status === 'failed')) {
      out.set(nodeId, { status: 'failed' });
      continue;
    }
    if (rows.every((r) => r.status === 'completed')) {
      out.set(nodeId, { status: 'completed' });
      continue;
    }
    if (rows.some((r) => r.status === 'skipped' || r.status === 'cancelled')) {
      out.set(nodeId, { status: 'skipped' });
    }
  }

  // If any body node is active under a fan_out parent, override the parent with the bodies'
  // collapsed active status (running beats a park). Handles parallel fan-out rehydration
  // (body nodes have parent_fan_out_node_run_id).
  const nodeRunById = new Map(nodeRuns.map((nr) => [nr.id, nr]));
  const activeBodiesByParent = new Map<string, CanvasNodeRun[]>();
  for (const nr of nodeRuns) {
    if (nr.parent_fan_out_node_run_id && ACTIVE_NODE_STATUSES.has(nr.status)) {
      const list = activeBodiesByParent.get(nr.parent_fan_out_node_run_id) ?? [];
      list.push(nr);
      activeBodiesByParent.set(nr.parent_fan_out_node_run_id, list);
    }
  }
  for (const [parentRunId, bodies] of activeBodiesByParent) {
    const parentRun = nodeRunById.get(parentRunId);
    if (parentRun && out.get(parentRun.node_id)?.status !== 'running') {
      out.set(parentRun.node_id, { status: activeStatusForCanvas(bodies) });
    }
  }

  // Sequential fan-out: derive iteration from attempt_number + fan_out node_output.
  // Parallel lanes use parent_fan_out_node_run_id (handled above). Sequential body rows omit
  // that link — scope by flow graph body chain + same flow_run so unrelated nodes / other
  // fan_outs do not inflate maxAttempt.
  const hasActiveNonFanOut = [...out.values()].some(
    (s) => s.status === 'running' && s.loopIteration == null,
  );
  if (hasActiveNonFanOut) {
    for (const nr of nodeRuns) {
      if (nr.block_type !== 'fan_out' || nr.status !== 'completed') continue;
      const nOut = nr.node_output as { outputs?: { totalCount?: number } } | null;
      const totalCount = nOut?.outputs?.totalCount;
      if (typeof totalCount !== 'number') continue;

      const bodyChainFromGraph =
        graph?.edges != null && graph.edges.length > 0
          ? new Set(computeFanOutBodyChain(graph.nodes, graph.edges, nr.node_id))
          : null;

      let maxAttempt = 0;
      for (const other of nodeRuns) {
        if (!isFanOutBodyNodeRun(other, nr, bodyChainFromGraph)) continue;
        if (other.attempt_number > maxAttempt) maxAttempt = other.attempt_number;
      }
      if (maxAttempt < 1) continue;

      const currentIteration = maxAttempt - 1;
      out.set(nr.node_id, {
        status: 'running',
        loopIteration: currentIteration,
        loopTotalCount: totalCount,
      });
      // Only fan_out + body chain: do not badge pre-loop nodes (trigger, fetch, condition).
      // Body nodes share attempt_number for the current iteration; pre-loop stays at 1.
      if (maxAttempt > 1) {
        const bodyNodeIds = new Set(
          nodeRuns
            .filter(
              (r) =>
                isFanOutBodyNodeRun(r, nr, bodyChainFromGraph) && r.attempt_number >= maxAttempt,
            )
            .map((r) => r.node_id),
        );
        // First-writer-wins for shared body nodes: only set when state.loopIteration is still
        // unset. If several completed fan_out rows run this block for overlapping bodies, the
        // first matching outer `nr` in `nodeRuns` order supplies currentIteration + totalCount;
        // later passes skip the assignment (guard) but may detect mismatch below.
        for (const [nodeId, state] of out) {
          if (!bodyNodeIds.has(nodeId)) continue;
          if (state.loopIteration == null) {
            state.loopIteration = currentIteration;
            state.loopTotalCount = totalCount;
            continue;
          }
          if (
            import.meta.env.DEV &&
            (state.loopIteration !== currentIteration || state.loopTotalCount !== totalCount)
          ) {
            // biome-ignore lint/suspicious/noConsole: dev-only when currentIteration/totalCount disagree with state.loopIteration/state.loopTotalCount
            console.warn(
              '[mergeNodeRunsForCanvas] fan_out loop badge skipped — already set (first writer wins)',
              {
                nodeId,
                currentIteration,
                totalCount,
                stateLoopIteration: state.loopIteration,
                stateLoopTotalCount: state.loopTotalCount,
              },
            );
          }
        }
      }
    }
  }

  return out;
}
