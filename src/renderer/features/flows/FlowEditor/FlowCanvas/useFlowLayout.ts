/**
 * Dagre layout from real `graph.edges` (freeform DAG). Uses `FlowNode.position` when set (user drag).
 */

import { type Edge, MarkerType, type Node } from '@xyflow/react';
import { useMemo } from 'react';
import type { FlowGraph } from '../../../../../shared/lib/validate-flow-graph';
import { backEdgeLoopMaxIterations } from '../../../../lib/flows/edge-loop-config';
import { computeDagreLayoutPositions, fanOutContainerDimensions } from './compute-dagre-positions';

export type FlowStepNodeData = {
  kind: 'step';
  index: number;
};

export function useFlowLayout(
  graph: FlowGraph,
  selectedNodeId: string | null,
): { nodes: Node[]; edges: Edge[] } {
  return useMemo(() => {
    const list = [...graph.nodes].sort(
      (a, b) => Number(Boolean(a.parentId)) - Number(Boolean(b.parentId)),
    );
    if (list.length === 0) {
      return { nodes: [], edges: [] };
    }

    const dagreById = computeDagreLayoutPositions(graph);

    const nodes: Node[] = list.map((n, index) => {
      const fallback = dagreById.get(n.id);
      if (n.position === undefined && fallback === undefined) {
        console.warn(
          `[useFlowLayout] Missing dagre layout data for node ${n.id}, using (0,0) fallback`,
        );
      }
      const position =
        n.position !== undefined
          ? { x: n.position.x, y: n.position.y }
          : (fallback ?? { x: 0, y: 0 });
      return {
        id: n.id,
        type: 'flowStep',
        position,
        ...(n.parentId ? { parentId: n.parentId, extent: 'parent' as const } : {}),
        ...(n.blockType === 'fan_out'
          ? {
              style: fanOutContainerDimensions(graph, n.id),
            }
          : {}),
        data: { kind: 'step', index } satisfies FlowStepNodeData,
      };
    });

    const edges: Edge[] = graph.edges.map((e) => {
      const touchesSelected =
        selectedNodeId !== null && (e.source === selectedNodeId || e.target === selectedNodeId);
      const isFalse = e.sourceHandle === 'false';
      const strokeColor = touchesSelected ? 'hsl(var(--primary))' : 'hsl(var(--muted-foreground))';
      return {
        id: e.id,
        source: e.source,
        target: e.target,
        sourceHandle: e.sourceHandle ?? undefined,
        type: 'flowGraph' as const,
        label: e.sourceHandle === 'true' || e.sourceHandle === 'false' ? e.sourceHandle : undefined,
        labelStyle: { fill: 'var(--muted-foreground)', fontSize: 10 },
        markerEnd: {
          type: MarkerType.ArrowClosed,
          color: strokeColor,
          width: 18,
          height: 18,
        },
        style: {
          stroke: strokeColor,
          strokeWidth: touchesSelected ? 2.5 : 2,
          strokeDasharray: isFalse ? '8 4' : '6 3',
        },
      };
    });

    return { nodes, edges };
  }, [graph.nodes, graph.edges, selectedNodeId]);
}

/**
 * Pairs each laid-out step with its graph definition, index and the graph's node count, so the
 * editor and the read-only preview build their differing node data over one traversal.
 */
export function mapFlowStepNodes(
  graph: FlowGraph,
  layoutNodes: Node[],
  step: (def: FlowGraph['nodes'][number], index: number, graphLength: number) => Partial<Node>,
): Node[] {
  const graphLength = graph.nodes.length;
  const byId = new Map(graph.nodes.map((node, index) => [node.id, { node, index }]));
  return layoutNodes.map((n) => {
    const entry = n.type === 'flowStep' ? byId.get(n.id) : undefined;
    return entry ? { ...n, ...step(entry.node, entry.index, graphLength) } : n;
  });
}

/** Loop facts every rendered edge carries; the editor layers its own handlers on top. */
export function backEdgeFacts(
  graph: FlowGraph,
  backEdgeIds: ReadonlySet<string>,
): (edge: Edge) => { isBackEdge: boolean; loopMaxIterations: number | undefined } {
  const byId = new Map(graph.nodes.map((n) => [n.id, n]));
  return (edge) => {
    const isBackEdge = backEdgeIds.has(edge.id);
    return {
      isBackEdge,
      loopMaxIterations: isBackEdge ? backEdgeLoopMaxIterations(byId.get(edge.source)) : undefined,
    };
  };
}
