import type {
  FlowChangeGraph,
  FlowSemanticChange,
} from '../../../shared/types/flows/flow-change-presentation';

export type AffectedFlowTopology = {
  graph: FlowChangeGraph;
  omittedNodeCount: number;
};

type TopologyIndex = {
  indegree: Map<string, number>;
  outgoing: Map<string, string[]>;
};

function addTopologyEdge(index: TopologyIndex, source: string, target: string): void {
  if (!index.indegree.has(source) || !index.indegree.has(target)) return;
  index.indegree.set(target, (index.indegree.get(target) ?? 0) + 1);
  index.outgoing.get(source)?.push(target);
}

function createTopologyIndex(graph: FlowChangeGraph): TopologyIndex {
  const indegree = new Map(graph.nodes.map((node) => [node.id, 0]));
  const outgoing = new Map(graph.nodes.map((node) => [node.id, [] as string[]]));
  for (const edge of graph.edges) {
    addTopologyEdge({ indegree, outgoing }, edge.source, edge.target);
  }
  return { indegree, outgoing };
}

function releaseTargets(current: string, queue: string[], index: TopologyIndex): void {
  for (const target of index.outgoing.get(current) ?? []) {
    const next = (index.indegree.get(target) ?? 1) - 1;
    index.indegree.set(target, next);
    if (next === 0) queue.push(target);
  }
}

function drainTopologicalQueue(queue: string[], index: TopologyIndex): string[] {
  const result: string[] = [];
  while (queue.length > 0) {
    const current = queue.shift();
    if (!current) break;
    result.push(current);
    releaseTargets(current, queue, index);
  }
  return result;
}

function appendCyclicNodeIds(graph: FlowChangeGraph, ordered: string[]): string[] {
  const orderedSet = new Set(ordered);
  return [
    ...ordered,
    ...graph.nodes.filter((node) => !orderedSet.has(node.id)).map((node) => node.id),
  ];
}

function topologicalNodeIds(graph: FlowChangeGraph): string[] {
  const index = createTopologyIndex(graph);
  const queue = graph.nodes
    .filter((node) => index.indegree.get(node.id) === 0)
    .map((node) => node.id);
  return appendCyclicNodeIds(graph, drainTopologicalQueue(queue, index));
}

function addChangedNodeIds(
  graph: FlowChangeGraph,
  changedIds: Set<string>,
  change: FlowSemanticChange,
): void {
  if (change.nodeId) changedIds.add(change.nodeId);
  for (const nodeId of change.relatedNodeIds ?? []) changedIds.add(nodeId);
  if (!change.edgeId) return;
  const edge = graph.edges.find((candidate) => candidate.id === change.edgeId);
  if (!edge) return;
  changedIds.add(edge.source);
  changedIds.add(edge.target);
}

function collectChangedNodeIds(graph: FlowChangeGraph, changes: FlowSemanticChange[]): Set<string> {
  const changedIds = new Set<string>();
  for (const change of changes) addChangedNodeIds(graph, changedIds, change);
  return changedIds;
}

function addVisibleNode(
  selected: Set<string>,
  visibleIds: Set<string>,
  maxNodes: number,
  nodeId: string,
): void {
  if (selected.size < maxNodes && visibleIds.has(nodeId)) selected.add(nodeId);
}

function selectChangedNodes(
  orderedIds: string[],
  changedIds: Set<string>,
  selected: Set<string>,
  visibleIds: Set<string>,
  maxNodes: number,
): void {
  for (const nodeId of orderedIds) {
    if (changedIds.has(nodeId)) addVisibleNode(selected, visibleIds, maxNodes, nodeId);
  }
}

function selectChangedNeighborhood(
  graph: FlowChangeGraph,
  changedIds: Set<string>,
  selected: Set<string>,
  visibleIds: Set<string>,
  maxNodes: number,
): void {
  for (const edge of graph.edges) {
    if (selected.size >= maxNodes) break;
    if (changedIds.has(edge.source) || changedIds.has(edge.target)) {
      addVisibleNode(selected, visibleIds, maxNodes, edge.source);
      addVisibleNode(selected, visibleIds, maxNodes, edge.target);
    }
  }
}

function fillFromTopology(
  orderedIds: string[],
  selected: Set<string>,
  visibleIds: Set<string>,
  maxNodes: number,
): void {
  for (const nodeId of orderedIds) {
    if (selected.size >= maxNodes) break;
    addVisibleNode(selected, visibleIds, maxNodes, nodeId);
  }
}

export function selectAffectedFlowTopology(
  graph: FlowChangeGraph,
  changes: FlowSemanticChange[],
  maxNodes = 7,
): AffectedFlowTopology {
  const orderedIds = topologicalNodeIds(graph);
  const changedIds = collectChangedNodeIds(graph, changes);
  const visibleIds = new Set(graph.nodes.map((node) => node.id));
  const selected = new Set<string>();
  selectChangedNodes(orderedIds, changedIds, selected, visibleIds, maxNodes);
  selectChangedNeighborhood(graph, changedIds, selected, visibleIds, maxNodes);
  fillFromTopology(orderedIds, selected, visibleIds, maxNodes);

  const nodes = graph.nodes.filter((node) => selected.has(node.id));
  const edges = graph.edges.filter(
    (edge) => selected.has(edge.source) && selected.has(edge.target),
  );

  return {
    graph: { nodes, edges },
    omittedNodeCount: Math.max(0, graph.nodes.length - nodes.length),
  };
}
