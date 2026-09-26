/**
 * Directed cycle detection for flow graphs (editor + validation).
 * Uses structural typing so validate-flow-graph can import this without a cycle.
 *
 * Canonical source: `src/shared/lib/flow-graph-cycle.ts`. The deploy copy
 */

export type FlowGraphLike = {
  nodes: readonly { id: string }[];
  edges: readonly { source: string; target: string }[];
};

function nodeIdSet(graph: FlowGraphLike): Set<string> {
  return new Set(graph.nodes.map((n) => n.id));
}

export function buildAdjacency(
  edges: readonly { source: string; target: string }[],
  nodeIds: Set<string>,
): Map<string, string[]> {
  const adj = new Map<string, string[]>();
  for (const e of edges) {
    if (!nodeIds.has(e.source) || !nodeIds.has(e.target)) continue;
    const list = adj.get(e.source) ?? [];
    list.push(e.target);
    adj.set(e.source, list);
  }
  return adj;
}

/** Whether `goal` is reachable from `start` following directed edges. */
export function canReachInGraph(
  edges: readonly { source: string; target: string }[],
  start: string,
  goal: string,
  nodeIds: Set<string>,
): boolean {
  const adj = buildAdjacency(edges, nodeIds);
  const stack = [start];
  const seen = new Set<string>();
  while (stack.length > 0) {
    const u = stack.pop();
    if (u === undefined) break;
    if (u === goal) return true;
    if (seen.has(u)) continue;
    seen.add(u);
    for (const v of adj.get(u) ?? []) stack.push(v);
  }
  return false;
}

/** True if adding `source` → `target` would close a directed cycle. */
export function wouldNewEdgeCreateCycle(
  graph: FlowGraphLike,
  source: string,
  target: string,
): boolean {
  const nodeIds = nodeIdSet(graph);
  if (!nodeIds.has(source) || !nodeIds.has(target)) return false;
  return canReachInGraph(graph.edges, target, source, nodeIds);
}

const UNVISITED = 0;
const VISITING = 1;
const DONE = 2;

/** True if the graph contains any directed cycle. */
export function flowGraphHasDirectedCycle(graph: FlowGraphLike): boolean {
  const nodeIds = nodeIdSet(graph);
  const adj = buildAdjacency(graph.edges, nodeIds);
  const state = new Map<string, number>();

  function dfs(u: string): boolean {
    const s = state.get(u) ?? UNVISITED;
    if (s === VISITING) return true;
    if (s === DONE) return false;
    state.set(u, VISITING);
    for (const v of adj.get(u) ?? []) {
      if (dfs(v)) return true;
    }
    state.set(u, DONE);
    return false;
  }

  for (const id of nodeIds) {
    if ((state.get(id) ?? UNVISITED) === UNVISITED && dfs(id)) return true;
  }
  return false;
}

/**
 * Returns the set of edge IDs that are back-edges (create cycles) in the graph.
 * Uses DFS: an edge u→v is a back-edge when v is currently VISITING (on the DFS stack).
 * Topological sort cannot detect back-edges in cyclic graphs; DFS is required.
 */
export function findBackEdges(graph: {
  nodes: readonly { id: string }[];
  edges: readonly { id: string; source: string; target: string }[];
}): Set<string> {
  const nodeIds = nodeIdSet(graph);
  const outBySource = new Map<string, Array<{ target: string; id: string }>>();
  for (const e of graph.edges) {
    if (!nodeIds.has(e.source) || !nodeIds.has(e.target)) continue;
    const list = outBySource.get(e.source) ?? [];
    list.push({ target: e.target, id: e.id });
    outBySource.set(e.source, list);
  }

  const state = new Map<string, number>();
  const backEdgeIds = new Set<string>();

  function dfs(u: string): void {
    state.set(u, VISITING);
    for (const { target: v, id } of outBySource.get(u) ?? []) {
      const vs = state.get(v) ?? UNVISITED;
      if (vs === VISITING) {
        backEdgeIds.add(id);
      } else if (vs === UNVISITED) {
        dfs(v);
      }
    }
    state.set(u, DONE);
  }

  for (const id of nodeIds) {
    if ((state.get(id) ?? UNVISITED) === UNVISITED) dfs(id);
  }
  return backEdgeIds;
}
