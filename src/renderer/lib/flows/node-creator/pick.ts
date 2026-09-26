/**
 * Picking a block in the node creator, as a pure step: the editor applies `graph` then selects
 * `selectId`, so a created step is the one in the config panel.
 */
import {
  addEdgeToGraph,
  addNodeToGraph,
  splitEdgeInGraph,
} from '../../../../shared/lib/flow-graph-mutations';
import {
  type FlowGraph,
  MAX_FLOW_GRAPH_NODES,
} from '../../../../shared/lib/validate-flow-graph';

/** Where a picked block lands: a free point, appended to a node's output, or splitting an edge. */
export type NodeCreatorMode =
  | { kind: 'floating'; position?: { x: number; y: number } }
  | { kind: 'append'; sourceId: string; sourceHandle: string | undefined }
  | { kind: 'insert_edge'; edgeId: string };

export type CreatorPickResult =
  | { ok: true; graph: FlowGraph; selectId: string }
  | { ok: false; error: string };

const NODE_CAP = `Maximum of ${MAX_FLOW_GRAPH_NODES} nodes reached`;

/** A fan_out node parents its own branch; anything else passes its parent on. */
function branchParentId(graph: FlowGraph, sourceId: string): string | undefined {
  const source = graph.nodes.find((node) => node.id === sourceId);
  return source?.blockType === 'fan_out' ? source.id : source?.parentId;
}

function appendBranch(
  graph: FlowGraph,
  mode: Extract<NodeCreatorMode, { kind: 'append' }>,
  blockType: string,
): CreatorPickResult {
  // No position: the layout places the step beside the source it was appended to.
  const added = addNodeToGraph(graph, blockType, undefined, branchParentId(graph, mode.sourceId));
  if (!added.success) return { ok: false, error: `Cannot add node: ${NODE_CAP}` };
  const connected = addEdgeToGraph(added.graph, {
    source: mode.sourceId,
    target: added.nodeId,
    sourceHandle: mode.sourceHandle ?? null,
  });
  if (!connected.success) return { ok: false, error: connected.error };
  return { ok: true, graph: connected.graph, selectId: added.nodeId };
}

export function applyCreatorPick(
  graph: FlowGraph,
  mode: NodeCreatorMode,
  blockType: string,
): CreatorPickResult {
  if (mode.kind === 'append') return appendBranch(graph, mode, blockType);
  if (mode.kind === 'insert_edge') {
    const split = splitEdgeInGraph(graph, mode.edgeId, blockType);
    if (split.success) return { ok: true, graph: split.graph, selectId: split.nodeId };
    const reason = split.error === 'MAX_NODES_REACHED' ? NODE_CAP : 'Edge not found';
    return { ok: false, error: `Cannot split edge: ${reason}` };
  }
  // A floating step keeps the position the gesture named (a double-clicked point); without one the
  // layout places it, which beats a random spot the author may be panned away from.
  const added = addNodeToGraph(graph, blockType, mode.position);
  return added.success
    ? { ok: true, graph: added.graph, selectId: added.nodeId }
    : { ok: false, error: `Cannot add node: ${NODE_CAP}` };
}
