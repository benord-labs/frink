/**
 * Pure helpers for editing `{ nodes, edges }` flow graphs (freeform DAG editor).
 */

import { findPluginActionByNodeName } from '../integrations/plugin-nodes';
import { getTriggerBlockTypes } from './block-registry';
import { buildAdjacency, wouldNewEdgeCreateCycle } from './flow-graph-cycle';
import type { FlowEdge, FlowGraph, FlowNode } from './validate-flow-graph';
import { MAX_FLOW_GRAPH_NODES } from './validate-flow-graph';

const TRIGGER_TYPES = new Set<string>(getTriggerBlockTypes());

/**
 * Maps `FlowEdge.sourceHandle` to a slot key for stub visibility: React Flow uses
 * handle id `out` for default outputs; null/empty mean the same logical slot as `out`.
 */
export function outgoingHandleSlotKey(sourceHandle: string | null | undefined): string {
  if (sourceHandle == null || sourceHandle === '' || sourceHandle === 'out') {
    return '__default__';
  }
  return sourceHandle;
}

function newEdgeId(): string {
  return `e-${crypto.randomUUID()}`;
}

export type AddNodeResult =
  | { success: true; graph: FlowGraph; nodeId: string }
  | { success: false; error: 'MAX_NODES_REACHED' };

export function addNodeToGraph(
  graph: FlowGraph,
  blockType: string,
  position?: { x: number; y: number },
  parentId?: string,
): AddNodeResult {
  if (graph.nodes.length >= MAX_FLOW_GRAPH_NODES) {
    return { success: false, error: 'MAX_NODES_REACHED' };
  }
  const id = crypto.randomUUID();
  // Frink-authored plugin steps are labelled from their catalog action at insert,
  // so no surface has to render the internal '.'-to-'_' node name.
  const pluginLabel = findPluginActionByNodeName(blockType)?.action.label;
  const node: FlowNode = {
    id,
    blockType,
    ...(pluginLabel ? { label: pluginLabel } : {}),
    ...(position ? { position } : {}),
    ...(parentId ? { parentId } : {}),
  };
  return {
    success: true,
    graph: { ...graph, nodes: [...graph.nodes, node], edges: [...graph.edges] },
    nodeId: id,
  };
}

export function removeNodeFromGraph(graph: FlowGraph, nodeId: string): FlowGraph {
  const removedIds = new Set([
    nodeId,
    ...graph.nodes.filter((node) => node.parentId === nodeId).map((node) => node.id),
  ]);
  const nodes = graph.nodes.filter((node) => !removedIds.has(node.id));
  const edges = graph.edges.filter(
    (edge) => !removedIds.has(edge.source) && !removedIds.has(edge.target),
  );
  return { ...graph, nodes, edges };
}

export type AddEdgeResult = { success: true; graph: FlowGraph } | { success: false; error: string };

export function addEdgeToGraph(
  graph: FlowGraph,
  params: { source: string; target: string; sourceHandle?: string | null },
): AddEdgeResult {
  const { source, target, sourceHandle } = params;
  const reason = getConnectionBlockReason(graph, {
    source,
    target,
    sourceHandle: sourceHandle ?? null,
  });
  if (reason !== null) {
    return { success: false, error: reason };
  }
  const edge: FlowEdge = {
    id: newEdgeId(),
    source,
    target,
    ...(sourceHandle ? { sourceHandle } : {}),
  };
  return { success: true, graph: { ...graph, nodes: graph.nodes, edges: [...graph.edges, edge] } };
}

export function removeEdgeFromGraph(graph: FlowGraph, edgeId: string): FlowGraph {
  return { ...graph, nodes: graph.nodes, edges: graph.edges.filter((e) => e.id !== edgeId) };
}

export type SplitEdgeResult =
  | { success: true; graph: FlowGraph; nodeId: string }
  | { success: false; error: 'MAX_NODES_REACHED' | 'EDGE_NOT_FOUND' };

export function splitEdgeInGraph(
  graph: FlowGraph,
  edgeId: string,
  blockType: string,
): SplitEdgeResult {
  if (graph.nodes.length >= MAX_FLOW_GRAPH_NODES) {
    return { success: false, error: 'MAX_NODES_REACHED' };
  }
  const edge = graph.edges.find((e) => e.id === edgeId);
  if (!edge) {
    return { success: false, error: 'EDGE_NOT_FOUND' };
  }
  const newNodeId = crypto.randomUUID();
  const sourceNode = graph.nodes.find((node) => node.id === edge.source);
  const targetNode = graph.nodes.find((node) => node.id === edge.target);
  const parentId =
    sourceNode?.blockType === 'fan_out' && targetNode?.parentId === sourceNode.id
      ? sourceNode.id
      : sourceNode?.parentId && sourceNode.parentId === targetNode?.parentId
        ? sourceNode.parentId
        : undefined;
  const newNode: FlowNode = { id: newNodeId, blockType, ...(parentId ? { parentId } : {}) };
  const e1: FlowEdge = {
    id: newEdgeId(),
    source: edge.source,
    target: newNodeId,
    ...(edge.sourceHandle ? { sourceHandle: edge.sourceHandle } : {}),
  };
  // For condition nodes the downstream connection belongs to the "true" branch so that
  // only the "false" output remains open for the user to wire up.
  const e2SourceHandle = blockType === 'condition' ? 'true' : undefined;
  const e2: FlowEdge = {
    id: newEdgeId(),
    source: newNodeId,
    target: edge.target,
    ...(e2SourceHandle ? { sourceHandle: e2SourceHandle } : {}),
  };
  const edges = graph.edges.filter((e) => e.id !== edgeId).concat([e1, e2]);
  return {
    success: true,
    graph: { ...graph, nodes: [...graph.nodes, newNode], edges },
    nodeId: newNodeId,
  };
}

export function updateNodePositionInGraph(
  graph: FlowGraph,
  nodeId: string,
  position: { x: number; y: number },
): FlowGraph {
  return {
    ...graph,
    nodes: graph.nodes.map((n) => (n.id === nodeId ? { ...n, position } : n)),
    edges: graph.edges,
  };
}

/**
 * Commits a finished resize as one graph update: the node's new size plus every position it moved
 * (resizing from the top/left edges shifts the node and, for a Fan Out, its children).
 */
export function resizeNodeInGraph(
  graph: FlowGraph,
  nodeId: string,
  size: { width: number; height: number },
  positions: ReadonlyArray<{ id: string; position: { x: number; y: number } }>,
): FlowGraph {
  const sized = graph.nodes.map((n) => (n.id === nodeId ? { ...n, size } : n));
  return updateNodePositionsInGraph({ ...graph, nodes: sized }, positions);
}

/**
 * Batch sibling of {@link updateNodePositionInGraph}: applies many position updates in a single
 * pass so a multi-node drag persists as one graph object (one dirty/save unit). Ids not present in
 * the graph are ignored; an empty `updates` returns the same graph reference.
 */
export function updateNodePositionsInGraph(
  graph: FlowGraph,
  updates: ReadonlyArray<{ id: string; position: { x: number; y: number } }>,
): FlowGraph {
  if (updates.length === 0) return graph;
  const byId = new Map(updates.map((u) => [u.id, u.position]));
  return {
    ...graph,
    nodes: graph.nodes.map((n) => {
      const position = byId.get(n.id);
      return position ? { ...n, position } : n;
    }),
    edges: graph.edges,
  };
}

export type FlowConnectionLike = {
  source: string;
  target: string;
  sourceHandle?: string | null;
  targetHandle?: string | null;
};

/**
 * Returns the number of nodes that would form the cycle body if a back-edge
 * source→target is added. Only meaningful when source is a condition node and
 * the edge would create a loop. Returns 0 if no path exists from target to source.
 */
export function cycleBodyLength(graph: FlowGraph, source: string, target: string): number {
  // BFS from target back to source to count intermediate hops
  const nodeIds = new Set(graph.nodes.map((n) => n.id));
  const adj = buildAdjacency(graph.edges, nodeIds);
  const queue: Array<{ id: string; depth: number }> = [{ id: target, depth: 1 }];
  const seen = new Set<string>([target]);
  let idx = 0;
  while (idx < queue.length) {
    const item = queue[idx++];
    if (item.id === source) return item.depth;
    for (const next of adj.get(item.id) ?? []) {
      if (!seen.has(next)) {
        seen.add(next);
        queue.push({ id: next, depth: item.depth + 1 });
      }
    }
  }
  return 0;
}

function fanOutConnectionBlockReason(sourceNode: FlowNode, targetNode: FlowNode): string | null {
  if (sourceNode.blockType === 'fan_out' && targetNode.parentId !== sourceNode.id) {
    return 'Fan Out must connect to a contained branch root';
  }
  if (
    targetNode.parentId &&
    sourceNode.id !== targetNode.parentId &&
    sourceNode.parentId !== targetNode.parentId
  ) {
    return 'Contained Fan Out steps can only be connected from within their body';
  }
  if (sourceNode.parentId && targetNode.parentId && sourceNode.parentId !== targetNode.parentId) {
    return 'Cannot connect steps from different Fan Out bodies';
  }
  return null;
}

/**
 * Returns null if connection is allowed, or a user-facing reason if not.
 */
export function getConnectionBlockReason(
  graph: FlowGraph,
  conn: FlowConnectionLike,
): string | null {
  const { source, target, sourceHandle } = conn;
  const sourceNode = graph.nodes.find((n) => n.id === source);
  const targetNode = graph.nodes.find((n) => n.id === target);
  if (!sourceNode || !targetNode) return 'Unknown node';
  if (TRIGGER_TYPES.has(targetNode.blockType)) return 'Cannot connect into a trigger';
  if (sourceNode.blockType === 'end') return 'End nodes cannot have outgoing connections';
  if (source === target) return 'Cannot connect a node to itself';
  const fanOutReason = fanOutConnectionBlockReason(sourceNode, targetNode);
  if (fanOutReason) return fanOutReason;

  const outgoing = graph.edges.filter((e) => e.source === source);
  if (sourceNode.blockType === 'condition') {
    if (sourceHandle !== 'true' && sourceHandle !== 'false') {
      return 'Use the true or false handle from a condition';
    }
    const sameHandle = outgoing.filter((e) => e.sourceHandle === sourceHandle).length;
    if (sameHandle >= 1) return 'This branch already has an outgoing edge';
  } else if (sourceNode.blockType === 'fan_out') {
    // Fan Out has one default handle with one edge per contained branch root.
  } else if (!TRIGGER_TYPES.has(sourceNode.blockType)) {
    if (outgoing.length >= 1) return 'This node already has an outgoing edge';
  } else {
    if (outgoing.length >= 1) return 'Trigger already has an outgoing edge';
  }

  const parallel = graph.edges.some(
    (e) =>
      e.source === source && e.target === target && (e.sourceHandle ?? '') === (sourceHandle ?? ''),
  );
  if (parallel) return 'Edge already exists';

  // Condition nodes may create back-edges to form loops — skip cycle guard for them.
  // Non-condition nodes still cannot create cycles.
  if (sourceNode.blockType !== 'condition' && wouldNewEdgeCreateCycle(graph, source, target)) {
    return 'This connection would create a cycle';
  }

  return null;
}

export { reconcileNodeProjectsOnDefaultChange } from './reconcile-node-projects-on-default-change';
