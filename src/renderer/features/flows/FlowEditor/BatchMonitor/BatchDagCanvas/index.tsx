/**
 * Full-width React Flow canvas for the Batch Monitor view.
 * Displays batch stages as an interactive read-only DAG with progress tracking.
 */

import '@xyflow/react/dist/style.css';

import { Button } from '@benord-labs/frink-primitives';
import { Background, BackgroundVariant, ReactFlow, ReactFlowProvider } from '@xyflow/react';
import { Loader2, XCircle } from 'lucide-react';
import { useTheme } from 'next-themes';
import { type ReactElement, useMemo } from 'react';
import type { BatchStageDetail } from '../../../../../../shared/types/flows/flow-batch';
import { CanvasControls } from '../../CanvasControls';
import { CanvasMiniMap } from '../../CanvasMiniMap';
import { getEdgeStrokeColor } from '../../FlowRunHistoryPanel/BatchReportPanel/stage-status-styles';
import { useCanvasFitView } from '../../hooks/useCanvasFitView';
import { BatchMonitorStageNode } from './BatchMonitorStageNode';
import { buildBatchMonitorGraph, computeMonitorTopologyKey } from './build-batch-dag-graph';
import { MINIMAP_STAGE_THRESHOLD, MONITOR_FIT_VIEW_PADDING } from './constants';
import { monitorMinimapNodeColor } from './monitorMinimapNodeColor';

const nodeTypes = { batchMonitorStage: BatchMonitorStageNode };

// Stable noop for layout-only buildBatchMonitorGraph call.
const noop = () => {};

type BatchDagCanvasProps = {
  stages: BatchStageDetail[];
  selectedStageId: string | null;
  onSelectStage: (stageId: string | null) => void;
  isStagesError: boolean;
  /** True until the first successful listBatchStages response (not refetch-only). */
  isStagesLoading: boolean;
  onStagesRetry: () => void;
  /**
   * Whether the monitor canvas is currently visible (not CSS-hidden).
   * Used to defer fitView until the pane has real dimensions.
   */
  isVisible: boolean;
};

function BatchDagCanvasInner({
  stages,
  selectedStageId,
  onSelectStage,
  isStagesError,
  isStagesLoading,
  onStagesRetry,
  isVisible,
}: BatchDagCanvasProps): ReactElement {
  const { resolvedTheme } = useTheme();
  // Layer 1: topology key — changes only when IDs/deps change.
  // eslint-disable-next-line react-hooks/exhaustive-deps
  const topologyKey = useMemo(() => computeMonitorTopologyKey(stages), [stages]);

  // Layer 2: dagre layout — expensive, keyed on topology only.
  // Status-only changes do not re-run dagre.
  // eslint-disable-next-line react-hooks/exhaustive-deps
  const layoutGraph = useMemo(() => buildBatchMonitorGraph(stages, null, noop), [topologyKey]);

  // Layer 3: merge latest `stage` from tRPC (status/progress) — layoutGraph is keyed on
  // topology only and would otherwise keep stale node.data.stage until the DAG changes.
  const rfNodes = useMemo(() => {
    const stageById = new Map(stages.map((s) => [s.id, s] as const));
    return layoutGraph.nodes.map((n) => {
      const stage = stageById.get(n.id) ?? n.data.stage;
      return {
        ...n,
        data: {
          ...n.data,
          stage,
          isSelected: n.id === selectedStageId,
          onSelect: onSelectStage,
        },
      };
    });
  }, [layoutGraph.nodes, stages, selectedStageId, onSelectStage]);

  const rfEdges = useMemo(() => {
    const stageById = new Map(stages.map((s) => [s.id, s] as const));
    return layoutGraph.edges.map((e) => {
      const dep = stageById.get(e.source);
      const stroke = getEdgeStrokeColor(dep?.status ?? 'pending');
      return {
        ...e,
        style: { strokeWidth: 1.5, stroke },
      };
    });
  }, [layoutGraph.edges, stages]);

  const handleFitView = useCanvasFitView(rfNodes.length, {
    padding: MONITOR_FIT_VIEW_PADDING,
    resetKey: topologyKey,
    isVisible,
    skipNodesInitialized: true,
  });

  if (isStagesError) {
    return (
      <div className="flex flex-1 flex-col items-center justify-center gap-3 py-10 text-center px-4">
        <XCircle className="h-8 w-8 text-destructive/50" aria-hidden />
        <p className="text-sm text-muted-foreground">Could not load batch stages.</p>
        <Button type="button" variant="secondary" size="sm" onClick={() => onStagesRetry()}>
          Retry
        </Button>
      </div>
    );
  }

  if (isStagesLoading) {
    return (
      <div className="flex flex-1 flex-col items-center justify-center gap-2 py-10 text-muted-foreground">
        <Loader2 className="h-8 w-8 animate-spin" aria-hidden />
        <p className="text-sm">Loading stages…</p>
      </div>
    );
  }

  if (stages.length === 0) {
    return (
      <div className="flex flex-1 flex-col items-center justify-center gap-1 py-10 text-center">
        <p className="text-sm text-muted-foreground">No stages defined yet.</p>
        <p className="text-xs text-muted-foreground/60">
          Stages appear here once the batch is configured.
        </p>
      </div>
    );
  }

  const showMiniMap = stages.length > MINIMAP_STAGE_THRESHOLD;

  return (
    <ReactFlow
      id="batch-monitor-canvas"
      className="h-full min-h-0 min-w-0 w-full flex-1"
      colorMode={resolvedTheme === 'dark' ? 'dark' : 'light'}
      nodes={rfNodes}
      edges={rfEdges}
      nodeTypes={nodeTypes}
      nodesDraggable={false}
      nodesConnectable={false}
      edgesFocusable={false}
      elementsSelectable={false}
      nodesFocusable={false}
      deleteKeyCode={null}
      panOnScroll={false}
      zoomOnScroll={true}
      zoomOnPinch={true}
      panOnDrag={true}
      proOptions={{ hideAttribution: true }}
    >
      <Background variant={BackgroundVariant.Dots} gap={12} size={1} />
      <CanvasControls onFitView={handleFitView} />
      {showMiniMap && <CanvasMiniMap nodeColor={monitorMinimapNodeColor} />}
    </ReactFlow>
  );
}

export function BatchDagCanvas(props: BatchDagCanvasProps): ReactElement {
  return (
    <div className="relative flex h-full min-h-0 min-w-0 flex-1 flex-col overflow-hidden">
      <ReactFlowProvider>
        <BatchDagCanvasInner {...props} />
      </ReactFlowProvider>
    </div>
  );
}
