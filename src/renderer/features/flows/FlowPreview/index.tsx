/**
 * Read-only React Flow preview for embedding in chat tool results.
 *
 * Reuses FlowStepRf + FlowGraphEdge + useFlowLayout without the interactive
 * FlowCanvas machinery (no drag, connection, deletion, or minimap).
 */

import '@xyflow/react/dist/style.css';
import '../FlowEditor/FlowCanvas/flowCanvasChrome.css';
import '../FlowEditor/FlowCanvas/flowCanvasEdges.css';

import { Background, BackgroundVariant, ReactFlow, ReactFlowProvider } from '@xyflow/react';
import { useTheme } from 'next-themes';
import { type ReactElement, useMemo } from 'react';
import { isTriggerBlockType } from '../../../../shared/lib/block-registry';
import { findBackEdges } from '../../../../shared/lib/flow-graph-cycle';
import type { FlowGraph } from '../../../../shared/lib/validate-flow-graph';
import { cn } from '../../../lib/utils';
import { FLOW_CANVAS_DOT_SIZE, FLOW_CANVAS_GRID_SIZE } from '../FlowEditor/FlowCanvas/constants';
import { FlowGraphEdge, type FlowGraphEdgeData } from '../FlowEditor/FlowCanvas/FlowGraphEdge';
import type { FlowStepRfData } from '../FlowEditor/FlowCanvas/FlowNode';
import { FlowStepRf } from '../FlowEditor/FlowCanvas/FlowNode';
import {
  backEdgeFacts,
  mapFlowStepNodes,
  useFlowLayout,
} from '../FlowEditor/FlowCanvas/useFlowLayout';

const nodeTypes = { flowStep: FlowStepRf };
const edgeTypes = { flowGraph: FlowGraphEdge };

const NOOP = () => {};

type FlowPreviewProps = {
  graph: FlowGraph;
  className?: string;
  /** Scopes the canvas execution overlay (`nodeExecAtomFamily`) to a run; omit for a static preview. */
  flowId?: string;
};

/**
 * Content fingerprints for preview memo deps: full serialized graph payloads so any new
 * `FlowNode` / `FlowEdge` / `FlowGraph.settings` fields invalidate without listing them by hand.
 */
function flowPreviewNodesSignature(nodes: FlowGraph['nodes']): string {
  return JSON.stringify(nodes);
}

function flowPreviewEdgesSignature(edges: FlowGraph['edges']): string {
  return JSON.stringify(edges);
}

function flowPreviewSettingsSignature(settings: FlowGraph['settings']): string {
  return JSON.stringify(settings ?? null);
}

function FlowPreviewInner({ graph, className, flowId }: FlowPreviewProps): ReactElement {
  const { resolvedTheme } = useTheme();
  const { nodes: layoutNodes, edges: layoutEdges } = useFlowLayout(graph, null);

  const graphNodesSignature = flowPreviewNodesSignature(graph.nodes);
  const graphEdgesSignature = flowPreviewEdgesSignature(graph.edges);
  const graphSettingsSignature = flowPreviewSettingsSignature(graph.settings);

  const backEdgeIds = useMemo(
    () => findBackEdges(graph),
    [graphNodesSignature, graphEdgesSignature],
  );

  // Structural dep for node merge — avoids re-running when only `graph` array references change.
  const enrichedNodes = useMemo(
    () =>
      mapFlowStepNodes(graph, layoutNodes, (def, index, graphLength) => ({
        data: {
          kind: 'step',
          index,
          node: def,
          isTrigger: isTriggerBlockType(def.blockType),
          isCondition: def.blockType === 'condition',
          isEnd: def.blockType === 'end',
          graphLength,
          isSelected: false,
          showAppendStubDefault: false,
          showAppendStubTrue: false,
          showAppendStubFalse: false,
          flowDefaultProjectId: undefined,
          flowId,
          onSelect: NOOP,
          onDelete: NOOP,
          onRequestAddStep: NOOP,
          readOnly: true,
        } satisfies FlowStepRfData,
      })),
    [graphNodesSignature, graphSettingsSignature, layoutNodes, flowId],
  );

  const edges = useMemo(() => {
    const facts = backEdgeFacts(graph, backEdgeIds);
    return layoutEdges.map((e) => ({ ...e, data: facts(e) satisfies FlowGraphEdgeData }));
  }, [layoutEdges, backEdgeIds, graphNodesSignature, graphEdgesSignature, graphSettingsSignature]);

  return (
    <div
      className={cn(
        'h-[420px] overflow-hidden rounded-xl border border-border/60 bg-background',
        className,
      )}
    >
      <ReactFlow
        nodes={enrichedNodes}
        edges={edges}
        nodeTypes={nodeTypes}
        edgeTypes={edgeTypes}
        nodesDraggable={false}
        nodesConnectable={false}
        elementsSelectable={false}
        panOnDrag={false}
        zoomOnScroll={false}
        zoomOnPinch={false}
        zoomOnDoubleClick={false}
        deleteKeyCode={null}
        fitView
        fitViewOptions={{ padding: 0.2 }}
        colorMode={resolvedTheme === 'dark' ? 'dark' : 'light'}
        className="flow-canvas-edges bg-background"
        proOptions={{ hideAttribution: true }}
      >
        <Background
          variant={BackgroundVariant.Dots}
          gap={FLOW_CANVAS_GRID_SIZE}
          size={FLOW_CANVAS_DOT_SIZE}
          color="hsl(var(--muted-foreground) / 0.28)"
        />
      </ReactFlow>
    </div>
  );
}

export function FlowPreview(props: FlowPreviewProps): ReactElement {
  return (
    <ReactFlowProvider>
      <FlowPreviewInner {...props} />
    </ReactFlowProvider>
  );
}
