import type {
  FlowChangeGraph,
  FlowChangeGraphEdge,
  FlowChangeGraphNode,
} from '../../../../shared/types/flows/flow-change-presentation';

export type DisplayEdge = FlowChangeGraphEdge & {
  originalEdgeIds: string[];
  omittedNodeIds: string[];
};

export type DisplayGraph = {
  nodes: FlowChangeGraphNode[];
  edges: DisplayEdge[];
  omittedBySource: Map<string, Set<string>>;
  omittedConnectionCount: number;
};

const MAX_DISPLAY_CONNECTIONS = 64;

type ConnectionTrace = {
  edge: FlowChangeGraphEdge;
  hiddenNodeIds: string[];
  originalEdgeIds: string[];
};

type ConnectionAccumulator = {
  visible: Map<string, DisplayEdge>;
  cappedKeys: Set<string>;
};

export function outlineEdgeLabel(
  edge: Pick<FlowChangeGraphEdge, 'sourceHandle' | 'label'>,
): string {
  if (edge.sourceHandle === 'true') return 'If yes';
  if (edge.sourceHandle === 'false') return 'If no';
  return edge.label?.trim() || 'Then';
}

export function sortEdges<T extends FlowChangeGraphEdge>(edges: readonly T[]): T[] {
  const rank = (edge: T): number =>
    edge.sourceHandle === 'true' ? 0 : edge.sourceHandle === 'false' ? 1 : 2;
  return [...edges].sort(
    (a, b) =>
      rank(a) - rank(b) ||
      outlineEdgeLabel(a).localeCompare(outlineEdgeLabel(b)) ||
      a.target.localeCompare(b.target) ||
      a.id.localeCompare(b.id),
  );
}

function recordVisibleConnection(
  source: string,
  first: FlowChangeGraphEdge,
  trace: ConnectionTrace,
  visibleIds: Set<string>,
  connections: ConnectionAccumulator,
): boolean {
  const target = trace.edge.target;
  if (!visibleIds.has(target)) return false;
  const key = `${source}\u0000${outlineEdgeLabel(first)}\u0000${target}`;
  const existing = connections.visible.get(key);
  if (existing) {
    connections.visible.set(key, {
      ...existing,
      originalEdgeIds: [...new Set([...existing.originalEdgeIds, ...trace.originalEdgeIds])],
      omittedNodeIds: [...new Set([...existing.omittedNodeIds, ...trace.hiddenNodeIds])],
    });
    return true;
  }
  if (connections.cappedKeys.has(key)) return true;
  if (connections.visible.size >= MAX_DISPLAY_CONNECTIONS) {
    connections.cappedKeys.add(key);
    return true;
  }
  connections.visible.set(key, {
    ...trace.edge,
    id:
      trace.hiddenNodeIds.length === 0 ? trace.edge.id : `outline:${source}:${first.id}:${target}`,
    source,
    sourceHandle: first.sourceHandle,
    label: first.label,
    originalEdgeIds: trace.originalEdgeIds,
    omittedNodeIds: trace.hiddenNodeIds,
  });
  return true;
}

function enqueueHiddenConnections(
  trace: ConnectionTrace,
  outgoing: Map<string, FlowChangeGraphEdge[]>,
  seen: Set<string>,
  omitted: Set<string>,
  queue: ConnectionTrace[],
): void {
  const target = trace.edge.target;
  if (seen.has(target)) return;
  seen.add(target);
  omitted.add(target);
  for (const next of outgoing.get(target) ?? []) {
    queue.push({
      edge: next,
      hiddenNodeIds: [...trace.hiddenNodeIds, target],
      originalEdgeIds: [...trace.originalEdgeIds, next.id],
    });
  }
}

function traceFirstBranch(
  source: string,
  first: FlowChangeGraphEdge,
  outgoing: Map<string, FlowChangeGraphEdge[]>,
  visibleIds: Set<string>,
  connections: ConnectionAccumulator,
  omitted: Set<string>,
): void {
  const queue: ConnectionTrace[] = [
    { edge: first, hiddenNodeIds: [], originalEdgeIds: [first.id] },
  ];
  const seen = new Set([source]);
  for (let cursor = 0; cursor < queue.length; cursor += 1) {
    const trace = queue[cursor];
    if (!trace) continue;
    if (recordVisibleConnection(source, first, trace, visibleIds, connections)) continue;
    enqueueHiddenConnections(trace, outgoing, seen, omitted, queue);
  }
}

export function buildDisplayGraph(graph: FlowChangeGraph, visibleIds: Set<string>): DisplayGraph {
  const fullOutgoing = new Map<string, FlowChangeGraphEdge[]>();
  for (const edge of graph.edges)
    fullOutgoing.set(edge.source, [...(fullOutgoing.get(edge.source) ?? []), edge]);
  for (const [source, edges] of fullOutgoing) fullOutgoing.set(source, sortEdges(edges));
  const connections: ConnectionAccumulator = {
    visible: new Map<string, DisplayEdge>(),
    cappedKeys: new Set<string>(),
  };
  const omittedBySource = new Map<string, Set<string>>();
  for (const source of [...visibleIds].sort()) {
    const omitted = new Set<string>();
    for (const edge of fullOutgoing.get(source) ?? []) {
      traceFirstBranch(source, edge, fullOutgoing, visibleIds, connections, omitted);
    }
    if (omitted.size > 0) omittedBySource.set(source, omitted);
  }
  return {
    nodes: graph.nodes.filter((node) => visibleIds.has(node.id)),
    edges: sortEdges([...connections.visible.values()]),
    omittedBySource,
    omittedConnectionCount: connections.cappedKeys.size,
  };
}
