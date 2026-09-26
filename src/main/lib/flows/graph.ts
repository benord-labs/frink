/**
 * Flow graph traversal helpers — parse + edge lookup + next-node selection.
 */

import { resolveFanOutStructure as resolveSharedFanOutStructure } from '../../../shared/lib/compute-fan-out-body-chain';
import { CONDITION_TRUE_RESULT } from '../../../shared/types/flow';

export type FlowGraphNode = {
  id: string;
  blockType: string;
  parentId?: string;
  label?: string;
  config?: Record<string, unknown>;
  position?: { x: number; y: number };
};

export type FlowGraphEdge = {
  id: string;
  source: string;
  target: string;
  sourceHandle?: string;
  label?: string;
};

export type ParsedFlowGraph = {
  nodes: FlowGraphNode[];
  edges: FlowGraphEdge[];
  settings?: Record<string, unknown>;
};

class FlowGraphParseError extends Error {
  constructor(detail: string) {
    super(`flow graph: ${detail}`);
    this.name = 'FlowGraphParseError';
  }
}

export function parseGraph(raw: unknown): ParsedFlowGraph {
  if (raw === null || typeof raw !== 'object') {
    throw new FlowGraphParseError('graph must be an object');
  }
  const obj = raw as { nodes?: unknown; edges?: unknown; settings?: unknown };
  if (!Array.isArray(obj.nodes)) {
    throw new FlowGraphParseError('graph.nodes missing');
  }
  if (!Array.isArray(obj.edges)) {
    throw new FlowGraphParseError('graph.edges missing');
  }
  return {
    nodes: obj.nodes as FlowGraphNode[],
    edges: obj.edges as FlowGraphEdge[],
    settings: (obj.settings as Record<string, unknown>) ?? undefined,
  };
}

export function findNodeById(nodes: FlowGraphNode[], nodeId: string): FlowGraphNode | undefined {
  return nodes.find((n) => n.id === nodeId);
}

export function findUpstreamNodeIds(graph: ParsedFlowGraph, nodeId: string): string[] {
  const ownerId = findNodeById(graph.nodes, nodeId)?.parentId;
  const result: string[] = [];
  const queue = graph.edges
    .filter((edge) => edge.target === nodeId)
    .map((edge) => ({ nodeId: edge.source, outsideOwner: false }));
  const seen = new Set<string>();

  while (queue.length > 0) {
    const currentEntry = queue.shift();
    if (!currentEntry || seen.has(currentEntry.nodeId)) continue;
    const { nodeId: currentId, outsideOwner } = currentEntry;
    seen.add(currentId);
    if (currentId === ownerId) {
      queue.push(
        ...graph.edges
          .filter((edge) => edge.target === currentId)
          .map((edge) => ({ nodeId: edge.source, outsideOwner: true })),
      );
      continue;
    }
    const current = findNodeById(graph.nodes, currentId);
    if (!current || (ownerId && !outsideOwner && current.parentId !== ownerId)) {
      continue;
    }
    result.push(currentId);
    queue.push(
      ...graph.edges
        .filter((edge) => edge.target === currentId)
        .map((edge) => ({ nodeId: edge.source, outsideOwner })),
    );
  }
  return result;
}

function edgesFromSource(edges: FlowGraphEdge[], sourceId: string): FlowGraphEdge[] {
  return edges.filter((e) => e.source === sourceId);
}

/**
 * Selects the next node ID after `currentNodeId` finishes.
 *
 * For condition nodes, the engine passes `conditionResult` (`'continue' | 'stop'`)
 * — we pick the edge whose `sourceHandle` matches (`'true'` or `'false'`); falling
 * back to the first edge if no labelled match exists.
 *
 * For all other nodes, returns the first outgoing edge's target. Returns undefined
 * when no outgoing edges exist (terminal).
 */
export function pickNextTargetNodeId(
  edges: FlowGraphEdge[],
  currentNodeId: string,
  conditionResult?: 'continue' | 'stop',
): string | undefined {
  const outgoing = edgesFromSource(edges, currentNodeId);
  if (outgoing.length === 0) return undefined;

  if (conditionResult !== undefined) {
    const wantHandle = conditionResult === CONDITION_TRUE_RESULT ? 'true' : 'false';
    const matched = outgoing.find((e) => e.sourceHandle === wantHandle);
    if (matched) return matched.target;
    // No labelled branch — for `stop` (false), terminate; for `continue`, fall through.
    if (conditionResult === 'stop') return undefined;
  }

  return outgoing[0].target;
}

export function resolveFanOutStructure(
  nodes: FlowGraphNode[],
  edges: FlowGraphEdge[],
  fanOutNodeId: string,
) {
  return resolveSharedFanOutStructure(nodes, edges, fanOutNodeId);
}
