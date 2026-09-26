/**
 * Builds a React Flow graph (nodes + edges) from a flat list of BatchStageDetail records.
 *
 * Uses dagre for TB layout with compact dimensions suited to the 380px-wide BatchReportPanel.
 * Pure function — no side effects. Memoize callers on topology key, not the full stage objects,
 * so status-only changes update node data without triggering a dagre re-layout.
 */

import dagre from '@dagrejs/dagre';
import type { Edge, Node } from '@xyflow/react';
import type { BatchStageDetail } from '../../../../../../../shared/types/flows/flow-batch';
import { getEdgeStrokeColor } from '../stage-status-styles';
import type { BatchPlanEdgeData } from './BatchPlanEdge';
import {
  BATCH_DAGRE_OPTS,
  BATCH_NODE_HEIGHT,
  BATCH_NODE_WIDTH,
  NON_SOURCE_STATUSES,
} from './constants';

export type BatchStageNodeData = {
  stage: BatchStageDetail;
  isSelected: boolean;
  onSelect: (stageId: string | null) => void;
  /** Opens the stage's latest agent chat. Undefined when stage has no dispatched run with a chat. */
  onOpenChat?: (chatId: string) => void;
  /** Whether this stage's source handle (bottom) is interactive for creating new dep edges. */
  sourceEditable: boolean;
  /** Whether this stage's target handle (top) is interactive for receiving new dep edges. */
  targetEditable: boolean;
};

type BatchPlanGraph = {
  nodes: Node<BatchStageNodeData>[];
  edges: Edge<BatchPlanEdgeData>[];
  /**
   * Stable key representing the DAG topology (node IDs + dependency IDs only).
   * Callers should use this as the `useMemo` dependency instead of the full stages array
   * so status-only changes do not trigger dagre re-layout.
   */
  topologyKey: string;
};

/**
 * Returns a stable string key representing only the DAG topology (node IDs + dependency IDs).
 * Exported for use in component-level memoization to avoid re-running dagre layout on
 * status-only changes or selection changes.
 *
 * When localDeps is provided (editing mode), topology key is derived from localDeps so dagre
 * re-runs on user-initiated topology changes but not on workstream/status-only changes.
 */
export function computeTopologyKey(
  stages: BatchStageDetail[],
  localDeps?: Map<string, string[]>,
): string {
  return stages
    .map((s) => {
      const deps = localDeps ? (localDeps.get(s.id) ?? []) : s.depends_on_stage_ids;
      return `${s.id}:[${deps.slice().sort().join(',')}]`;
    })
    .join('|');
}

function computeDagrePositions(
  stages: BatchStageDetail[],
  validEdges: Array<{ source: string; target: string }>,
): Map<string, { x: number; y: number }> {
  const positions = new Map<string, { x: number; y: number }>();
  if (stages.length === 0) return positions;

  const g = new dagre.graphlib.Graph().setDefaultEdgeLabel(() => ({}));
  g.setGraph(BATCH_DAGRE_OPTS);

  for (const stage of stages) {
    g.setNode(stage.id, { width: BATCH_NODE_WIDTH, height: BATCH_NODE_HEIGHT });
  }
  for (const edge of validEdges) {
    g.setEdge(edge.source, edge.target);
  }

  dagre.layout(g);

  for (let i = 0; i < stages.length; i++) {
    const stage = stages[i];
    if (!stage) continue;
    const d = g.node(stage.id);
    const baseX = d ? d.x - BATCH_NODE_WIDTH / 2 : i * (BATCH_NODE_WIDTH + 20);
    const baseY = d ? d.y - BATCH_NODE_HEIGHT / 2 : i * (BATCH_NODE_HEIGHT + 20);
    positions.set(stage.id, { x: baseX, y: baseY });
  }

  return positions;
}

/**
 * Converts BatchStageDetail[] into React Flow nodes and edges.
 *
 * @param stages - Flat list of stages from listBatchStages
 * @param selectedStageId - Currently selected stage (for node highlight)
 * @param onSelectStage - Callback when a node is clicked (single-click selection)
 * @param onOpenChat - Callback to navigate to a stage's agent chat (double-click or icon click)
 * @param localDeps - Optional local dep overrides for editing mode. When provided, edges and
 *   topology key derive from localDeps rather than stage.depends_on_stage_ids.
 * @param onDeleteEdge - Optional callback for edge deletion (editing mode only).
 */
export function buildBatchPlanGraph(
  stages: BatchStageDetail[],
  selectedStageId: string | null,
  onSelectStage: (stageId: string | null) => void,
  onOpenChat?: (chatId: string) => void,
  localDeps?: Map<string, string[]>,
  onDeleteEdge?: (sourceId: string, targetId: string) => void,
): BatchPlanGraph {
  const topologyKey = computeTopologyKey(stages, localDeps);

  if (stages.length === 0) {
    return { nodes: [], edges: [], topologyKey };
  }

  const stageMap = new Map(stages.map((s) => [s.id, s] as const));
  const pendingStageIds = new Set(stages.filter((s) => s.status === 'pending').map((s) => s.id));

  // Build edge list using localDeps when in editing mode, otherwise stage.depends_on_stage_ids.
  const validEdges: Array<{ id: string; source: string; target: string; sourceStatus: string }> =
    [];
  for (const stage of stages) {
    const depIds = localDeps ? (localDeps.get(stage.id) ?? []) : stage.depends_on_stage_ids;
    for (const depId of depIds) {
      if (!stageMap.has(depId)) continue; // filter dangling reference
      const dep = stageMap.get(depId);
      validEdges.push({
        id: `e-${depId}-${stage.id}`,
        source: depId,
        target: stage.id,
        sourceStatus: dep?.status ?? 'pending',
      });
    }
  }

  const positions = computeDagrePositions(stages, validEdges);

  const nodes: Node<BatchStageNodeData>[] = stages.map((stage) => ({
    id: stage.id,
    type: 'batchStage',
    position: positions.get(stage.id) ?? { x: 0, y: 0 },
    data: {
      stage,
      isSelected: stage.id === selectedStageId,
      onSelect: onSelectStage,
      // Only pass onOpenChat when stage has a chat to navigate to.
      onOpenChat: stage.latest_chat_id && onOpenChat ? onOpenChat : undefined,
      sourceEditable: localDeps !== undefined && !NON_SOURCE_STATUSES.has(stage.status),
      targetEditable: localDeps !== undefined && pendingStageIds.has(stage.id),
    },
  }));

  const edges: Edge<BatchPlanEdgeData>[] = validEdges.map(
    ({ id, source, target, sourceStatus }) => ({
      id,
      source,
      target,
      type: 'batchDep',
      style: { strokeWidth: 1.5, stroke: getEdgeStrokeColor(sourceStatus) },
      data: {
        editable: pendingStageIds.has(target),
        onDelete: onDeleteEdge ? () => onDeleteEdge(source, target) : undefined,
      },
    }),
  );

  return { nodes, edges, topologyKey };
}
