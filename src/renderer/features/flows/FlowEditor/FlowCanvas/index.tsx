/* eslint-disable max-lines, max-lines-per-function */
/**
 * React Flow canvas: freeform DAG (edges are source of truth).
 */

import '@xyflow/react/dist/style.css';
import './flowCanvasChrome.css';
import './flowCanvasEdges.css';
import './flowCanvasExecution.css';

import {
  applyNodeChanges,
  Background,
  BackgroundVariant,
  type Connection,
  type Node,
  type NodeChange,
  Panel,
  PanOnScrollMode,
  ReactFlow,
  ReactFlowProvider,
  type Edge as RFEdge,
  SelectionMode,
  useReactFlow,
} from '@xyflow/react';
import { useTheme } from 'next-themes';
import { type ReactElement, useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { toast } from 'sonner';
import { isTriggerBlockType } from '../../../../../shared/lib/block-registry';
import { findBackEdges } from '../../../../../shared/lib/flow-graph-cycle';
import type { CustomNodeInputsByType } from '../../../../../shared/lib/flows/custom-node-required-inputs';
import {
  cycleBodyLength,
  type FlowConnectionLike,
  getConnectionBlockReason,
  outgoingHandleSlotKey,
} from '../../../../../shared/lib/flow-graph-mutations';
import type { FlowGraph } from '../../../../../shared/lib/validate-flow-graph';
import { GhostRunButton } from '../../GhostRunButton';
import { GhostRunHeaderStrip } from '../../GhostRunHeaderStrip';
import { CanvasControls } from '../CanvasControls';
import { CanvasMiniMap } from '../CanvasMiniMap';
import { useCanvasFitView } from '../hooks/useCanvasFitView';
import type { FlowNodeCanvasContext } from '../nodeSummary';
import { fanOutFitDimensions } from './compute-dagre-positions';
import { FLOW_CANVAS_DOT_SIZE, FLOW_CANVAS_GRID_SIZE } from './constants';
import { FlowConnectionLine } from './FlowConnectionLine';
import { FlowGraphEdge, type FlowGraphEdgeData } from './FlowGraphEdge';
import type { FlowStepRfData } from './FlowNode';
import { FlowStepRf } from './FlowNode';
import { minimapNodeColor } from './minimapNodeColor';
import {
  collectFinishedResizes,
  type ResizeMoves,
} from '../../../../lib/flows/canvas-resize/collect-finished-resizes';
import { backEdgeFacts, mapFlowStepNodes, useFlowLayout } from './useFlowLayout';

const nodeTypes = { flowStep: FlowStepRf };
const edgeTypes = { flowGraph: FlowGraphEdge };

function toConn(c: Connection): FlowConnectionLike | null {
  if (!c.source || !c.target) return null;
  return {
    source: c.source,
    target: c.target,
    sourceHandle: c.sourceHandle,
    targetHandle: c.targetHandle,
  };
}

type FlowCanvasProps = {
  graph: FlowGraph;
  /** Resets fit + layout sync when switching flows */
  flowMountKey: string;
  selectedNodeIds: string[];
  selectedEdgeId: string | null;
  flowDefaultProjectId?: string;
  /** Manifest icon keys for custom blocks (block type name → Lucide key). */
  customBlockIcons?: ReadonlyMap<string, string>;
  /** Declared inputs per custom node, for the rehearsal. Undefined while manifests are unknown. */
  customNodeInputs?: CustomNodeInputsByType;
  /** Canvas summaries + catalog presence for custom node steps. */
  customFlowCanvasContext?: FlowNodeCanvasContext;
  /** Scopes the canvas execution overlay to the correct flow. */
  flowId?: string;
  /** Muted execution styling when overlay is from run history inspection. */
  canvasHistoricalInspection?: boolean;
  onSelectNodes: (nodeIds: string[]) => void;
  onSelectEdge: (edgeId: string | null) => void;
  onConnect: (conn: FlowConnectionLike) => void;
  onNodesDelete: (nodeIds: string[]) => void;
  onEdgesDelete: (edgeIds: string[]) => void;
  onNodePosition: (nodeId: string, position: { x: number; y: number }) => void;
  onNodesPosition: (updates: Array<{ id: string; position: { x: number; y: number } }>) => void;
  /** Persists a finished Fan Out resize: its size plus the positions of it and its children. */
  onNodeResize: (
    nodeId: string,
    size: { width: number; height: number },
    positions: Array<{ id: string; position: { x: number; y: number } }>,
  ) => void;
  onRemoveNode: (nodeId: string) => void;
  onRequestInsertOnEdge?: (edgeId: string) => void;
  onRequestAddConnectedStep?: (sourceId: string, sourceHandle: string | undefined) => void;
  onPaneDoubleClickFlowPosition?: (position: { x: number; y: number }) => void;
  /** Deep-link from a node's missing-project warning to the flow settings Project field. */
  onRequestOpenFlowSettings?: () => void;
};

function FlowCanvasInner({
  graph,
  flowMountKey,
  selectedNodeIds,
  selectedEdgeId,
  flowDefaultProjectId,
  customBlockIcons,
  customNodeInputs,
  customFlowCanvasContext,
  flowId,
  canvasHistoricalInspection = false,
  onSelectNodes,
  onSelectEdge,
  onConnect,
  onNodesDelete,
  onEdgesDelete,
  onNodePosition,
  onNodesPosition,
  onNodeResize,
  onRemoveNode,
  onRequestInsertOnEdge,
  onRequestAddConnectedStep,
  onPaneDoubleClickFlowPosition,
  onRequestOpenFlowSettings,
}: FlowCanvasProps): ReactElement {
  const { resolvedTheme } = useTheme();
  const { screenToFlowPosition, getNodes, fitView } = useReactFlow();
  // Edge highlight is a single-node affordance; collapse multi-select to null.
  const highlightNodeId = selectedNodeIds.length === 1 ? selectedNodeIds[0] : null;
  const { nodes: layoutNodes, edges: layoutEdges } = useFlowLayout(graph, highlightNodeId);

  const onSelectRef = useRef(onSelectNodes);
  const onRemoveRef = useRef(onRemoveNode);
  const onNodeResizeRef = useRef(onNodeResize);
  const onRequestAddRef = useRef(onRequestAddConnectedStep);
  const onRequestOpenFlowSettingsRef = useRef(onRequestOpenFlowSettings);
  useEffect(() => {
    onSelectRef.current = onSelectNodes;
    onRemoveRef.current = onRemoveNode;
    onNodeResizeRef.current = onNodeResize;
    onRequestAddRef.current = onRequestAddConnectedStep;
    onRequestOpenFlowSettingsRef.current = onRequestOpenFlowSettings;
  }, [
    onSelectNodes,
    onRemoveNode,
    onNodeResize,
    onRequestAddConnectedStep,
    onRequestOpenFlowSettings,
  ]);

  // Select + frame a node when a Ghost Run finding is clicked (selection alone doesn't scroll).
  // fitView centres on the node correctly — no manual dimension math.
  const focusNode = useCallback(
    (nodeId: string) => {
      onSelectRef.current([nodeId]);
      fitView({ nodes: [{ id: nodeId }], duration: 400, maxZoom: 1 });
    },
    [fitView],
  );

  const outgoingHandlesByNode = useMemo(() => {
    const m = new Map<string, Set<string>>();
    for (const e of graph.edges) {
      if (!m.has(e.source)) m.set(e.source, new Set());
      const handles = m.get(e.source);
      if (handles) handles.add(outgoingHandleSlotKey(e.sourceHandle));
    }
    return m;
  }, [graph.edges]);

  const backEdgeIds = useMemo(() => findBackEdges(graph), [graph]);

  const enrichedNodes = useMemo(() => {
    const selectedSet = new Set(selectedNodeIds);
    return mapFlowStepNodes(graph, layoutNodes, (def, index, glen) => {
      const isTrigger = isTriggerBlockType(def.blockType);
      const isCondition = def.blockType === 'condition';
      const isEnd = def.blockType === 'end';
      const outgoing = outgoingHandlesByNode.get(def.id) ?? new Set();
      const stubDefault =
        !isCondition && !isEnd && (def.blockType === 'fan_out' || !outgoing.has('__default__'));
      const stubTrue = isCondition && !outgoing.has('true');
      const stubFalse = isCondition && !outgoing.has('false');
      const data: FlowStepRfData = {
        kind: 'step',
        index,
        node: def,
        isTrigger,
        isCondition,
        isEnd,
        graphLength: glen,
        isSelected: selectedSet.has(def.id),
        showAppendStubDefault: stubDefault,
        showAppendStubTrue: stubTrue,
        showAppendStubFalse: stubFalse,
        customBlockIcon: customBlockIcons?.get(def.blockType),
        customFlowCanvasContext,
        flowDefaultProjectId,
        flowId,
        canvasHistoricalInspection,
        onSelect: () => onSelectRef.current([def.id]),
        onDelete: () => onRemoveRef.current(def.id),
        onRequestAddStep: (sourceHandle) => onRequestAddRef.current?.(def.id, sourceHandle),
        onRequestOpenFlowSettings: () => onRequestOpenFlowSettingsRef.current?.(),
        fanOutMinSize: def.blockType === 'fan_out' ? fanOutFitDimensions(graph, def.id) : undefined,
      };
      return { data, selected: selectedSet.has(def.id) };
    });
  }, [
    graph.nodes,
    layoutNodes,
    outgoingHandlesByNode,
    selectedNodeIds,
    flowDefaultProjectId,
    flowId,
    canvasHistoricalInspection,
    customBlockIcons,
    customFlowCanvasContext,
  ]);

  const [rfNodes, setRfNodes] = useState<Node[]>(enrichedNodes);

  // Sync rfNodes with the canonical enrichedNodes during render (not in a
  // useEffect) to avoid the commit → effect → setState → re-commit cycle that
  // gives React Flow an intermediate frame with unmeasured nodes and triggers
  // cascading Handle re-registration that blows the max-update-depth limit.
  const prevFlowKeyRef = useRef(flowMountKey);
  const prevEnrichedRef = useRef(enrichedNodes);
  if (prevFlowKeyRef.current !== flowMountKey) {
    // Switching flows — full reset (fresh dagre positions, no preserved drag).
    prevFlowKeyRef.current = flowMountKey;
    prevEnrichedRef.current = enrichedNodes;
    setRfNodes(enrichedNodes);
  } else if (prevEnrichedRef.current !== enrichedNodes) {
    // Same flow, graph changed — merge: keep each existing node's RF-managed
    // position / measured / dragging so React Flow doesn't re-measure them.
    prevEnrichedRef.current = enrichedNodes;
    setRfNodes((prev) => {
      const prevMap = new Map(prev.map((p) => [p.id, p]));
      return enrichedNodes.map((en) => {
        const p = prevMap.get(en.id);
        if (!p) return en;
        return {
          ...en,
          position: p.position,
          dragging: p.dragging,
          selected: en.selected,
          measured: p.measured,
        };
      });
    });
  }

  const onEdgesDeleteRef = useRef(onEdgesDelete);
  useEffect(() => {
    onEdgesDeleteRef.current = onEdgesDelete;
  }, [onEdgesDelete]);

  const edges = useMemo(() => {
    const facts = backEdgeFacts(graph, backEdgeIds);
    return layoutEdges.map((e) => {
      const loop = facts(e);
      return {
        ...e,
        selected: e.id === selectedEdgeId,
        data: {
          onInsert:
            loop.isBackEdge || onRequestInsertOnEdge == null
              ? undefined
              : () => onRequestInsertOnEdge(e.id),
          onDelete: () => onEdgesDeleteRef.current([e.id]),
          ...loop,
        } satisfies FlowGraphEdgeData,
      };
    });
  }, [layoutEdges, selectedEdgeId, onRequestInsertOnEdge, backEdgeIds, graph.nodes]);

  const handleFitView = useCanvasFitView(rfNodes.length, {
    padding: 0.15,
    resetKey: flowMountKey,
  });

  const resizeMovesRef = useRef<ResizeMoves>(new Map());
  const handleNodesChange = useCallback((changes: NodeChange[]) => {
    // Filter out 'remove' changes - deletion is handled by onNodesDelete
    // to avoid double-processing when user presses Delete key
    setRfNodes((prev) =>
      applyNodeChanges(
        changes.filter((c) => c.type !== 'remove'),
        prev,
      ),
    );
    for (const r of collectFinishedResizes(changes, resizeMovesRef.current)) {
      onNodeResizeRef.current(r.id, r.size, r.positions);
    }
  }, []);

  const isValidConnection = useCallback(
    (c: Connection | RFEdge) => {
      const conn = toConn(c as Connection);
      if (!conn) return false;
      return getConnectionBlockReason(graph, conn) === null;
    },
    [graph],
  );

  const handleConnect = useCallback(
    (c: Connection) => {
      const conn = toConn(c);
      if (!conn) return;
      const reason = getConnectionBlockReason(graph, conn);
      if (reason) {
        toast.error(reason);
        return;
      }
      // Warn when a condition back-edge creates a long loop body (>2 intermediate nodes).
      if (conn.sourceHandle === 'true' || conn.sourceHandle === 'false') {
        const bodyLen = cycleBodyLength(graph, conn.source, conn.target);
        if (bodyLen > 2) {
          toast.info(
            `This loop contains ${bodyLen - 1} step${bodyLen - 1 === 1 ? '' : 's'} that will re-execute on each iteration.`,
            { duration: 5000 },
          );
        }
      }
      onConnect(conn);
    },
    [graph, onConnect],
  );

  const handleNodeDragStop = useCallback(
    (_: MouseEvent | TouchEvent, node: { id: string; position: { x: number; y: number } }) => {
      // Dragging a node that is part of a multi-selection moves every selected node, but RF only
      // hands us the grabbed `node` here — persist all selected so siblings aren't dropped on save.
      const selected = getNodes().filter((n) => n.selected);
      if (selected.length > 1) {
        onNodesPosition(selected.map((n) => ({ id: n.id, position: n.position })));
        return;
      }
      onNodePosition(node.id, node.position);
    },
    [getNodes, onNodePosition, onNodesPosition],
  );

  const handleSelectionDragStop = useCallback(
    (_: React.MouseEvent, nodes: Node[]) => {
      onNodesPosition(nodes.map((n) => ({ id: n.id, position: n.position })));
    },
    [onNodesPosition],
  );

  const handleNodesDelete = useCallback(
    (deleted: { id: string }[]) => {
      onNodesDelete(deleted.map((d) => d.id));
    },
    [onNodesDelete],
  );

  // Keyboard Delete/Backspace on a selected edge is intentionally immediate
  // (no inline confirmation). The confirmation flow is click-path only, via
  // the on-canvas × control in FlowGraphEdge.
  const handleEdgesDelete = useCallback(
    (deleted: RFEdge[]) => {
      onEdgesDelete(deleted.map((e) => e.id));
    },
    [onEdgesDelete],
  );

  // Sole selection authority: RF routes click, marquee, and pane-click through onSelectionChange
  // (nodes + edges), so no separate onNodeClick/onEdgeClick/onPaneClick handlers are needed.
  const handleSelectionChange = useCallback(
    ({ nodes: selNodes, edges: selEdges }: { nodes: { id: string }[]; edges: RFEdge[] }) => {
      if (selNodes.length > 0) {
        onSelectNodes(selNodes.map((n) => n.id));
        onSelectEdge(null);
        return;
      }
      if (selEdges.length > 0) {
        onSelectEdge(selEdges[0]?.id ?? null);
        onSelectNodes([]);
        return;
      }
      onSelectNodes([]);
      onSelectEdge(null);
    },
    [onSelectEdge, onSelectNodes],
  );

  const onWrapperDoubleClick = useCallback(
    (e: React.MouseEvent) => {
      if (!onPaneDoubleClickFlowPosition) return;
      const t = e.target as HTMLElement | null;
      if (t?.closest?.('.react-flow__node') || t?.closest?.('.react-flow__edge')) return;
      if (!t?.closest?.('.react-flow__pane')) return;
      e.preventDefault();
      onPaneDoubleClickFlowPosition(screenToFlowPosition({ x: e.clientX, y: e.clientY }));
    },
    [onPaneDoubleClickFlowPosition, screenToFlowPosition],
  );

  const snapGridTuple = useMemo(
    () => [FLOW_CANVAS_GRID_SIZE, FLOW_CANVAS_GRID_SIZE] as [number, number],
    [],
  );

  // Left/middle/right-drag pans (panOnDrag) plus trackpad/scroll (panOnScroll) and Space+drag (RF
  // default). Shift is the unified multi-select modifier: Shift+drag draws a marquee (default
  // selectionKeyCode="Shift", which forces panOnDrag off while held, so button 0 never steals it),
  // Shift+click adds individual nodes (multiSelectionKeyCode, keeping Meta for Mac Cmd+click).
  const panOnDragButtons = useMemo(() => [0, 1, 2], []);
  const multiSelectKeys = useMemo(() => ['Meta', 'Shift'], []);

  return (
    <ReactFlow
      id="flow-editor-canvas"
      className="flow-canvas-edges flow-canvas-atmosphere"
      colorMode={resolvedTheme === 'dark' ? 'dark' : 'light'}
      nodes={rfNodes}
      edges={edges}
      nodeTypes={nodeTypes}
      edgeTypes={edgeTypes}
      onNodesChange={handleNodesChange}
      nodesDraggable
      nodesConnectable
      elementsSelectable
      snapToGrid
      snapGrid={snapGridTuple}
      panOnScroll
      panOnScrollSpeed={0.65}
      panOnScrollMode={PanOnScrollMode.Free}
      selectionMode={SelectionMode.Partial}
      multiSelectionKeyCode={multiSelectKeys}
      panOnDrag={panOnDragButtons}
      zoomOnDoubleClick={false}
      deleteKeyCode={['Backspace', 'Delete']}
      onConnect={handleConnect}
      isValidConnection={isValidConnection}
      connectionLineComponent={FlowConnectionLine}
      onNodeDragStop={handleNodeDragStop}
      onSelectionDragStop={handleSelectionDragStop}
      onNodesDelete={handleNodesDelete}
      onEdgesDelete={handleEdgesDelete}
      onSelectionChange={handleSelectionChange}
      onDoubleClick={onWrapperDoubleClick}
    >
      <Background
        variant={BackgroundVariant.Dots}
        gap={FLOW_CANVAS_GRID_SIZE}
        size={FLOW_CANVAS_DOT_SIZE}
        color="hsl(var(--muted-foreground) / 0.35)"
      />
      <CanvasControls onFitView={handleFitView}>
        <GhostRunButton graph={graph} flowId={flowId} customNodeInputs={customNodeInputs} />
      </CanvasControls>
      {/* Rehearsal findings strip — self-gates on its atom; floats top-left over the canvas. */}
      <Panel position="top-left" className="max-w-112">
        <GhostRunHeaderStrip onFocusNode={focusNode} />
      </Panel>
      <CanvasMiniMap
        nodeColor={(node) => {
          const data = node.data as FlowStepRfData | undefined;
          if (data?.node?.blockType) {
            return minimapNodeColor(data.node.blockType);
          }
          return 'hsl(var(--muted-foreground) / 0.45)';
        }}
        maskColor="hsl(var(--background) / 0.65)"
      />
    </ReactFlow>
  );
}

export function FlowCanvas(props: FlowCanvasProps): ReactElement {
  return (
    <div className="flex h-full min-h-80 min-w-0 flex-1 border-r border-border/45">
      <ReactFlowProvider>
        <FlowCanvasInner {...props} />
      </ReactFlowProvider>
    </div>
  );
}
