import type {
  FlowChangeGraph,
  FlowChangeGraphEdge,
  FlowChangeGraphNode,
  FlowChangeOperationStatus,
  FlowSemanticChange,
} from '../../../shared/types/flows/flow-change-presentation';

export { projectProposedFlowGraph, toSafeFlowChangeGraph } from './flow-change-graph-projection';

const STATUS_PRIORITY: Record<FlowChangeOperationStatus, number> = {
  applied: 0,
  unchanged: 0,
  skipped: 1,
  pending: 2,
  unknown: 3,
  failed: 4,
};

function shouldReplaceChange(
  current: FlowChangeOperationStatus | undefined,
  next: FlowChangeOperationStatus,
): boolean {
  return !current || STATUS_PRIORITY[next] >= STATUS_PRIORITY[current];
}

function withChangeMark<
  T extends {
    changeStatus?: FlowChangeOperationStatus;
    changeAction?: FlowSemanticChange['action'];
  },
>(entity: T, change: FlowSemanticChange): T {
  if (!shouldReplaceChange(entity.changeStatus, change.status)) return entity;
  return { ...entity, changeStatus: change.status, changeAction: change.action };
}

function isNotAppliedAddition(change: FlowSemanticChange): boolean {
  return change.action === 'add' && (change.status === 'failed' || change.status === 'skipped');
}

function applyNodeChange(
  nodes: Map<string, FlowChangeGraphNode>,
  fallbackGraph: FlowChangeGraph,
  change: FlowSemanticChange,
): void {
  if (!change.nodeId) return;
  if (isNotAppliedAddition(change)) return;
  const node =
    nodes.get(change.nodeId) ?? fallbackGraph.nodes.find((item) => item.id === change.nodeId);
  nodes.set(
    change.nodeId,
    node
      ? withChangeMark(node, change)
      : {
          id: change.nodeId,
          label: change.label,
          blockType: change.blockType ?? 'step',
          changeStatus: change.status,
          changeAction: change.action,
        },
  );
}

function ensurePlaceholderNode(nodes: Map<string, FlowChangeGraphNode>, id: string): void {
  if (nodes.has(id)) return;
  nodes.set(id, { id, label: 'Connected step', blockType: 'step' });
}

function applyEdgeChange(
  nodes: Map<string, FlowChangeGraphNode>,
  edges: Map<string, FlowChangeGraphEdge>,
  fallbackGraph: FlowChangeGraph,
  change: FlowSemanticChange,
): void {
  if (!change.edgeId) return;
  if (isNotAppliedAddition(change)) return;
  const edge =
    edges.get(change.edgeId) ?? fallbackGraph.edges.find((item) => item.id === change.edgeId);
  if (edge) {
    edges.set(change.edgeId, withChangeMark(edge, change));
    return;
  }
  const [source, target] = change.relatedNodeIds ?? [];
  if (!source || !target) return;
  ensurePlaceholderNode(nodes, source);
  ensurePlaceholderNode(nodes, target);
  edges.set(change.edgeId, {
    id: change.edgeId,
    source,
    target,
    changeStatus: change.status,
    changeAction: change.action,
  });
}

/** Mark changed entities and restore receipt targets from a safe fallback graph. */
export function markFlowChangeGraph(
  graph: FlowChangeGraph,
  fallbackGraph: FlowChangeGraph,
  changes: FlowSemanticChange[],
): FlowChangeGraph {
  const nodes = new Map(graph.nodes.map((node) => [node.id, { ...node }]));
  const edges = new Map(graph.edges.map((edge) => [edge.id, { ...edge }]));

  for (const change of changes) {
    applyNodeChange(nodes, fallbackGraph, change);
    applyEdgeChange(nodes, edges, fallbackGraph, change);
  }

  return { nodes: [...nodes.values()], edges: [...edges.values()] };
}
