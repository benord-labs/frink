import type {
  FlowChangeGraph,
  FlowChangeGraphEdge,
  FlowChangeGraphNode,
} from '../../types/flows/flow-change-presentation';
import { isPlainObject } from '../case-converter';
import { formatFlowNodeLabel, normalizeFlowGraph } from '../validate-flow-graph';
import { flowChangeStringValue, normalizeFlowChangeText } from './flow-change-text';

export const MAX_PRESENTATION_NODES = 50;
export const MAX_PRESENTATION_EDGES = 200;

export function safeNode(node: {
  id: string;
  blockType: string;
  label?: string;
}): FlowChangeGraphNode {
  return {
    id: node.id,
    blockType: node.blockType,
    label: normalizeFlowChangeText(formatFlowNodeLabel(node), 'Untitled step'),
  };
}

export function safeEdge(edge: {
  id: string;
  source: string;
  target: string;
  sourceHandle?: string;
  label?: string;
}): FlowChangeGraphEdge {
  return {
    id: edge.id,
    source: edge.source,
    target: edge.target,
    ...(edge.sourceHandle ? { sourceHandle: edge.sourceHandle } : {}),
    ...(edge.label ? { label: normalizeFlowChangeText(edge.label, 'Route') } : {}),
  };
}

function safeGraphNode(candidate: unknown): FlowChangeGraphNode | undefined {
  if (!isPlainObject(candidate)) return undefined;
  const id = flowChangeStringValue(candidate.id);
  const rawBlockType = flowChangeStringValue(candidate.blockType);
  if (!id || !rawBlockType) return undefined;
  const blockType = normalizeFlowChangeText(rawBlockType, 'step');
  const label = typeof candidate.label === 'string' ? candidate.label : undefined;
  return safeNode({ id, blockType, label });
}

function safeGraphEdge(
  candidate: unknown,
  nodes: Map<string, FlowChangeGraphNode>,
): FlowChangeGraphEdge | undefined {
  if (!isPlainObject(candidate)) return undefined;
  const id = flowChangeStringValue(candidate.id);
  const source = flowChangeStringValue(candidate.source);
  const target = flowChangeStringValue(candidate.target);
  if (!id || !source || !target) return undefined;
  if (!nodes.has(source) || !nodes.has(target)) return undefined;
  return safeEdge({
    id,
    source,
    target,
    sourceHandle: typeof candidate.sourceHandle === 'string' ? candidate.sourceHandle : undefined,
    label: typeof candidate.label === 'string' ? candidate.label : undefined,
  });
}

function collectFirstUnique<T extends { id: string }>(
  candidates: unknown[],
  cap: number,
  project: (candidate: unknown) => T | undefined,
): Map<string, T> {
  const result = new Map<string, T>();
  for (const candidate of candidates.slice(0, cap)) {
    const item = project(candidate);
    if (item && !result.has(item.id)) result.set(item.id, item);
  }
  return result;
}

/** Topology-only, redaction-safe view of a flow graph: no node config, so size tracks node count. */
export function toSafeFlowChangeGraph(value: unknown): FlowChangeGraph | undefined {
  const graph = normalizeFlowGraph(value);
  if (!graph) return undefined;
  const nodes = collectFirstUnique(graph.nodes, MAX_PRESENTATION_NODES, safeGraphNode);
  const edges = collectFirstUnique(graph.edges, MAX_PRESENTATION_EDGES, (candidate) =>
    safeGraphEdge(candidate, nodes),
  );
  return { nodes: [...nodes.values()], edges: [...edges.values()] };
}
