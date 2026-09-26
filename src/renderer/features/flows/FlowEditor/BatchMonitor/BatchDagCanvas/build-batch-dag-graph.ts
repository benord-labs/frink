/**
 * Builds a React Flow graph (nodes + edges) from BatchStageDetail records.
 * Full-width Monitor view variant — larger nodes, read-only (no edge editing).
 * Pure function. Memoize callers on topology key (not full stages array)
 * so status-only changes do not trigger dagre re-layout.
 */

import dagre from '@dagrejs/dagre';
import type { Edge, Node } from '@xyflow/react';
import type { BatchStageDetail } from '../../../../../../shared/types/flows/flow-batch';
import { getEdgeStrokeColor } from '../../FlowRunHistoryPanel/BatchReportPanel/stage-status-styles';
import type { BatchMonitorStageNodeData } from './BatchMonitorStageNode';
import { MONITOR_DAGRE_OPTS, MONITOR_NODE_HEIGHT, MONITOR_NODE_WIDTH } from './constants';

type MonitorGraph = {
  nodes: Node<BatchMonitorStageNodeData>[];
  edges: Edge[];
};

/**
 * Returns a stable string key representing only the DAG topology (IDs + dependencies).
 * Use as useMemo dependency so status-only changes don't trigger dagre re-layout.
 */
export function computeMonitorTopologyKey(stages: BatchStageDetail[]): string {
  return stages
    .map((s) => `${s.id}:[${s.depends_on_stage_ids.slice().sort().join(',')}]`)
    .join('|');
}

function computeDagrePositions(
  stages: BatchStageDetail[],
  validEdges: Array<{ source: string; target: string }>,
): Map<string, { x: number; y: number }> {
  const positions = new Map<string, { x: number; y: number }>();
  if (stages.length === 0) return positions;

  const g = new dagre.graphlib.Graph().setDefaultEdgeLabel(() => ({}));
  g.setGraph(MONITOR_DAGRE_OPTS);

  for (const stage of stages) {
    g.setNode(stage.id, { width: MONITOR_NODE_WIDTH, height: MONITOR_NODE_HEIGHT });
  }
  for (const edge of validEdges) {
    g.setEdge(edge.source, edge.target);
  }

  dagre.layout(g);

  for (let i = 0; i < stages.length; i++) {
    const stage = stages[i];
    if (!stage) continue;
    const d = g.node(stage.id);
    const baseX = d ? d.x - MONITOR_NODE_WIDTH / 2 : i * (MONITOR_NODE_WIDTH + 24);
    const baseY = d ? d.y - MONITOR_NODE_HEIGHT / 2 : i * (MONITOR_NODE_HEIGHT + 24);
    positions.set(stage.id, { x: baseX, y: baseY });
  }

  return positions;
}

export function buildBatchMonitorGraph(
  stages: BatchStageDetail[],
  selectedStageId: string | null,
  onSelectStage: (stageId: string | null) => void,
): MonitorGraph {
  if (stages.length === 0) {
    return { nodes: [], edges: [] };
  }

  const stageMap = new Map(stages.map((s) => [s.id, s] as const));

  const validEdges: Array<{ id: string; source: string; target: string; sourceStatus: string }> =
    [];
  for (const stage of stages) {
    for (const depId of stage.depends_on_stage_ids) {
      if (!stageMap.has(depId)) continue;
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

  const nodes: Node<BatchMonitorStageNodeData>[] = stages.map((stage) => ({
    id: stage.id,
    type: 'batchMonitorStage',
    position: positions.get(stage.id) ?? { x: 0, y: 0 },
    /** Required for MiniMap + fitView bbox in @xyflow/react 12 (no rects until dimensions exist). */
    width: MONITOR_NODE_WIDTH,
    height: MONITOR_NODE_HEIGHT,
    data: {
      stage,
      isSelected: stage.id === selectedStageId,
      onSelect: onSelectStage,
    },
  }));

  const edges: Edge[] = validEdges.map(({ id, source, target, sourceStatus }) => ({
    id,
    source,
    target,
    style: { strokeWidth: 1.5, stroke: getEdgeStrokeColor(sourceStatus) },
  }));

  return { nodes, edges };
}
