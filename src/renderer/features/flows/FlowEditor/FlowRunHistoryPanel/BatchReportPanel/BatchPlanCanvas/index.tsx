/* eslint-disable max-lines, max-lines-per-function */
/**
 * React Flow canvas rendering batch stages as an interactive dependency DAG.
 *
 * Designed for the 380px-wide FlowRunHistoryPanel side panel.
 * Uses compact node dimensions (140×52px) and no MiniMap.
 * Viewport fit uses useCanvasFitView only (no ReactFlow fitView prop), matching FlowCanvas/BatchDagCanvas.
 *
 * Memoization layers:
 * 1. `topologyKey` (cheap string) — changes only when IDs/deps change (including localDeps edits).
 * 2. `layoutGraph` (expensive dagre) — keyed on frozen topology key; stable during editing.
 *    During editing, dagre is frozen to the topology at edit-mode entry to prevent node jumps.
 * 3. `rfNodes` (cheap overlay) — keyed on layout + selectedStageId + callbacks + editability;
 *    updates selection and navigation callbacks without re-running dagre.
 */

import '@xyflow/react/dist/style.css';

import { Button } from '@benord-labs/frink-primitives';
import {
  Background,
  BackgroundVariant,
  type Edge,
  ReactFlow,
  ReactFlowProvider,
} from '@xyflow/react';
import { RotateCcw, Save, X } from 'lucide-react';
import { useTheme } from 'next-themes';
import { type ReactElement, useCallback, useMemo, useRef } from 'react';
import type { BatchStageDetail } from '../../../../../../../shared/types/flows/flow-batch';
import { useDirtyNavGuard } from '../../../../../../hooks/use-dirty-nav-guard';
import { cn } from '../../../../../../lib/utils';
import { CanvasControls } from '../../../CanvasControls';
import { useCanvasFitView } from '../../../hooks/useCanvasFitView';
import { DirtyNavAlertDialog } from '../DirtyNavAlertDialog';
import { getEdgeStrokeColor } from '../stage-status-styles';
import type { BatchPlanEdgeData } from './BatchPlanEdge';
import { BatchPlanEdge } from './BatchPlanEdge';
import { BatchStageNode } from './BatchStageNode';
import { buildBatchPlanGraph, computeTopologyKey } from './build-batch-plan-graph';
import { BATCH_FIT_VIEW_PADDING } from './constants';
import { useBatchEdgeEditing } from './use-batch-edge-editing';
import { WorkstreamLegend, type WorkstreamLegendEntry } from './WorkstreamLegend';

const nodeTypes = { batchStage: BatchStageNode };
const edgeTypes = { batchDep: BatchPlanEdge };

// Stable no-op for the layout-only buildBatchPlanGraph call (selection not needed there).
const noop = () => {};

type BatchPlanCanvasProps = {
  stages: BatchStageDetail[];
  selectedStageId: string | null;
  onSelectStage: (stageId: string | null) => void;
  flowId?: string;
  batchId?: string;
  /** Called after save (success or partial failure) — use to invalidate tRPC listBatchStages. */
  onSaveSuccess?: () => void;
  /** Wrapper sizing override — defaults to the 300px rail strip; the monitor pane passes full height. */
  className?: string;
};

function BatchPlanCanvasInner({
  stages,
  selectedStageId,
  onSelectStage,
  flowId = '',
  batchId = '',
  onSaveSuccess,
}: BatchPlanCanvasProps): ReactElement {
  const { resolvedTheme } = useTheme();
  // Dirty-state guard: owns the single AlertDialog for the canvas, not per-node.
  const { showDialog, requestNav, confirmNav, cancelNav } = useDirtyNavGuard();

  // Edge editing hook: manages local dep overrides, undo stack, validation, and save.
  const {
    localDeps,
    isDirty,
    canUndo,
    isSaving,
    handleConnect,
    isValidConnection,
    handleDeleteEdge,
    handleUndo,
    handleSave,
    handleDiscard,
    saveError,
    clearSaveError,
  } = useBatchEdgeEditing(stages, flowId, batchId, onSaveSuccess);

  // Stable callback: passed into node data so nodes can trigger navigation without atom subscriptions.
  const handleOpenChat = useCallback(
    (chatId: string) => {
      requestNav(chatId);
    },
    [requestNav],
  );

  // Layer 1: topology key — changes when IDs/deps change (including local edits).
  // When dirty, derive from localDeps so topology key reflects current editing state.
  // IMPORTANT: During editing, we freeze the topology key used for dagre layout so node
  // positions don't jump on every edge add/remove. The layoutTopologyKey only tracks the
  // initial topology; it updates again only after save/discard (when isDirty becomes false).
  const currentTopologyKey = useMemo(
    () => computeTopologyKey(stages, isDirty ? localDeps : undefined),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [isDirty ? localDeps : stages],
  );

  // Frozen layout topology key: the key when editing started. Reset after save/discard.
  const frozenLayoutKeyRef = useRef<string | null>(null);
  if (!isDirty) {
    // Not editing: always update to current topology.
    frozenLayoutKeyRef.current = null;
  } else if (frozenLayoutKeyRef.current === null) {
    // Editing just started: freeze current topology so dagre doesn't re-run on each edit.
    frozenLayoutKeyRef.current = computeTopologyKey(stages);
  }
  const layoutTopologyKey = frozenLayoutKeyRef.current ?? currentTopologyKey;

  // Layer 2: dagre layout — expensive, keyed on layout topology key only.
  // Status-only changes and selection changes do NOT trigger this.
  // Frozen during editing to prevent node position jumps when edges are added/removed.
  // eslint-disable-next-line react-hooks/exhaustive-deps
  const layoutGraph = useMemo(() => buildBatchPlanGraph(stages, null, noop), [layoutTopologyKey]);

  // Layer 3: node data overlay — cheap, merges selection + navigation callbacks + editability.
  // Workstream data lives on stage objects (visual-only, no topology impact).
  const rfNodes = useMemo(() => {
    // layoutGraph is keyed on topology only, so its node.data.stage goes stale between layouts:
    // take the latest stage (status, progress, linked chat) from the stages prop.
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
          // Only wire onOpenChat when the stage has a linked chat (latest_chat_id is non-null).
          onOpenChat: stage.latest_chat_id ? handleOpenChat : undefined,
          // Handle interactivity derived from current stage status (not frozen topology).
          sourceEditable: n.data.sourceEditable,
          targetEditable: n.data.targetEditable,
        },
      };
    });
  }, [layoutGraph.nodes, stages, selectedStageId, onSelectStage, handleOpenChat]);

  // Build edges inline — avoids calling buildBatchPlanGraph (which triggers dagre) for edge-only updates.
  // Positions are frozen from layoutGraph; only edge connectivity and callbacks change during editing.
  const rfEdges = useMemo((): Edge<BatchPlanEdgeData>[] => {
    const stageIdSet = new Set(stages.map((s) => s.id));
    const pendingStageIds = new Set(stages.filter((s) => s.status === 'pending').map((s) => s.id));
    const depSource = isDirty ? localDeps : null;
    const edges: Edge<BatchPlanEdgeData>[] = [];
    for (const stage of stages) {
      const depIds = depSource ? (depSource.get(stage.id) ?? []) : stage.depends_on_stage_ids;
      for (const depId of depIds) {
        if (!stageIdSet.has(depId)) continue;
        const dep = stages.find((s) => s.id === depId);
        edges.push({
          id: `e-${depId}-${stage.id}`,
          source: depId,
          target: stage.id,
          type: 'batchDep',
          style: { strokeWidth: 1.5, stroke: getEdgeStrokeColor(dep?.status ?? 'pending') },
          data: {
            editable: pendingStageIds.has(stage.id),
            onDelete: () => handleDeleteEdge(depId, stage.id),
          },
        });
      }
    }
    return edges;
  }, [isDirty, localDeps, stages, handleDeleteEdge]);

  // Derive unique workstreams for legend. Sorted alphabetically for stable ordering.
  // Hidden when < 2 workstreams (single-workstream batches don't need visual distinction).
  const legendWorkstreams = useMemo((): WorkstreamLegendEntry[] => {
    const seen = new Set<string>();
    for (const stage of stages) {
      for (const ws of stage.workstream_ids) {
        const id = ws.trim();
        if (id) seen.add(id);
      }
    }
    if (seen.size < 2) return [];
    return Array.from(seen)
      .sort()
      .map((workstreamId) => ({ workstreamId }));
  }, [stages]);

  const handleFitView = useCanvasFitView(rfNodes.length, {
    padding: BATCH_FIT_VIEW_PADDING,
    resetKey: layoutTopologyKey,
    skipNodesInitialized: true,
  });

  return (
    <>
      {/* Save/Discard/Undo toolbar — shown only when there are unsaved edge changes */}
      {isDirty && (
        <div className="flex items-center gap-1.5 px-2 py-1.5 border-b border-border bg-card/80 shrink-0">
          <Button
            type="button"
            size="sm"
            variant="primary"
            className="h-6 px-2 text-xs"
            disabled={isSaving}
            onClick={() => void handleSave()}
          >
            <Save className="h-3 w-3 mr-1" aria-hidden />
            {isSaving ? 'Saving…' : 'Save'}
          </Button>
          <Button
            type="button"
            size="sm"
            variant="ghost"
            className="h-6 px-2 text-xs text-muted-foreground"
            disabled={isSaving}
            onClick={handleDiscard}
          >
            <X className="h-3 w-3 mr-1" aria-hidden />
            Discard
          </Button>
          {canUndo && (
            <Button
              type="button"
              size="sm"
              variant="ghost"
              className="h-6 px-2 text-xs text-muted-foreground"
              disabled={isSaving}
              onClick={handleUndo}
            >
              <RotateCcw className="h-3 w-3 mr-1" aria-hidden />
              Undo
            </Button>
          )}
          {saveError && (
            <div role="alert" className="ml-1 min-w-0 flex-1">
              <Button
                variant="ghost"
                size="auto"
                className="w-full justify-start text-left font-normal block truncate p-0 text-xs text-destructive hover:bg-transparent hover:underline"
                onClick={clearSaveError}
                title={saveError}
              >
                {saveError}
              </Button>
            </div>
          )}
        </div>
      )}

      <ReactFlow
        colorMode={resolvedTheme === 'dark' ? 'dark' : 'light'}
        nodes={rfNodes}
        edges={rfEdges}
        nodeTypes={nodeTypes}
        edgeTypes={edgeTypes}
        nodesDraggable={false}
        nodesConnectable={true}
        edgesFocusable={true}
        elementsSelectable={false}
        nodesFocusable={false}
        deleteKeyCode={null}
        panOnScroll={false}
        zoomOnScroll={false}
        zoomOnPinch={true}
        panOnDrag={true}
        proOptions={{ hideAttribution: true }}
        onConnect={handleConnect}
        isValidConnection={(conn) =>
          isValidConnection({
            source: (conn.source ?? '') as string,
            target: (conn.target ?? '') as string,
            sourceHandle: conn.sourceHandle ?? null,
            targetHandle: conn.targetHandle ?? null,
          })
        }
      >
        <Background variant={BackgroundVariant.Dots} gap={12} size={1} />
        <CanvasControls onFitView={handleFitView} />
      </ReactFlow>

      {legendWorkstreams.length > 0 && <WorkstreamLegend workstreams={legendWorkstreams} />}

      {/* Single dirty-state dialog for the entire canvas — not per-node. */}
      <DirtyNavAlertDialog showDialog={showDialog} onConfirm={confirmNav} onCancel={cancelNav} />
    </>
  );
}

export function BatchPlanCanvas({ className, ...props }: BatchPlanCanvasProps): ReactElement {
  return (
    <div
      className={cn(
        'relative flex flex-col w-full shrink-0 overflow-hidden',
        className ?? 'h-[300px]',
      )}
    >
      <ReactFlowProvider>
        <BatchPlanCanvasInner {...props} />
      </ReactFlowProvider>
    </div>
  );
}
