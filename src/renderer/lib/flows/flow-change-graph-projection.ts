import { isPlainObject } from '../../../shared/lib/case-converter';
import { normalizeFlowChangeText } from '../../../shared/lib/flows/flow-change-text';
import {
  MAX_PRESENTATION_EDGES,
  MAX_PRESENTATION_NODES,
  safeEdge,
  safeNode,
} from '../../../shared/lib/flows/flow-change-topology';
import type {
  FlowChangeGraph,
  FlowChangeGraphEdge,
  FlowChangeGraphNode,
} from '../../../shared/types/flows/flow-change-presentation';

const MAX_PRESENTATION_OPERATIONS = 100;

type UnknownRecord = Record<string, unknown>;
type ProposalOperationHandler = (graph: FlowChangeGraph, operation: UnknownRecord) => void;

function isSafeIdentifier(value: unknown): value is string {
  return typeof value === 'string' && value.trim().length > 0;
}

function canUpsert<T extends { id: string }>(items: T[], id: string, cap: number): boolean {
  return items.some((candidate) => candidate.id === id) || items.length < cap;
}

function upsertById<T extends { id: string }>(items: T[], item: T): T[] {
  return [...items.filter((candidate) => candidate.id !== item.id), item];
}

function proposedNode(operation: UnknownRecord): FlowChangeGraphNode | undefined {
  if (!isPlainObject(operation.node)) return undefined;
  const node = operation.node;
  if (!isSafeIdentifier(node.id) || typeof node.blockType !== 'string') return undefined;
  return safeNode({
    id: node.id,
    blockType: node.blockType,
    label: typeof node.label === 'string' ? node.label : undefined,
  });
}

function applyAddNode(graph: FlowChangeGraph, operation: UnknownRecord): void {
  const node = proposedNode(operation);
  if (!node || !canUpsert(graph.nodes, node.id, MAX_PRESENTATION_NODES)) return;
  graph.nodes = upsertById(graph.nodes, node);
}

function updatedNode(
  node: FlowChangeGraphNode,
  nodeId: string,
  label: unknown,
): FlowChangeGraphNode {
  if (node.id !== nodeId || typeof label !== 'string') return node;
  return { ...node, label: normalizeFlowChangeText(label, node.label) };
}

function applyUpdateNode(graph: FlowChangeGraph, operation: UnknownRecord): void {
  if (typeof operation.nodeId !== 'string') return;
  const nodeId = operation.nodeId;
  graph.nodes = graph.nodes.map((node) => updatedNode(node, nodeId, operation.label));
}

function applyRemoveNode(graph: FlowChangeGraph, operation: UnknownRecord): void {
  if (typeof operation.nodeId !== 'string') return;
  const nodeId = operation.nodeId;
  graph.nodes = graph.nodes.filter((node) => node.id !== nodeId);
  graph.edges = graph.edges.filter((edge) => edge.source !== nodeId && edge.target !== nodeId);
}

function proposedEdge(operation: UnknownRecord): FlowChangeGraphEdge | undefined {
  if (!isPlainObject(operation.edge)) return undefined;
  const edge = operation.edge;
  if (
    !isSafeIdentifier(edge.id) ||
    !isSafeIdentifier(edge.source) ||
    !isSafeIdentifier(edge.target)
  ) {
    return undefined;
  }
  return safeEdge({
    id: edge.id,
    source: edge.source,
    target: edge.target,
    sourceHandle: typeof edge.sourceHandle === 'string' ? edge.sourceHandle : undefined,
    label: typeof edge.label === 'string' ? edge.label : undefined,
  });
}

function hasEndpoint(graph: FlowChangeGraph, nodeId: string): boolean {
  return graph.nodes.some((node) => node.id === nodeId);
}

function applyAddEdge(graph: FlowChangeGraph, operation: UnknownRecord): void {
  const edge = proposedEdge(operation);
  if (!edge) return;
  if (!hasEndpoint(graph, edge.source) || !hasEndpoint(graph, edge.target)) return;
  if (!canUpsert(graph.edges, edge.id, MAX_PRESENTATION_EDGES)) return;
  graph.edges = upsertById(graph.edges, edge);
}

function applyRemoveEdge(graph: FlowChangeGraph, operation: UnknownRecord): void {
  if (typeof operation.edgeId !== 'string') return;
  graph.edges = graph.edges.filter((edge) => edge.id !== operation.edgeId);
}

function updatedEdge(
  edge: FlowChangeGraphEdge,
  edgeId: string,
  operation: UnknownRecord,
): FlowChangeGraphEdge {
  if (edge.id !== edgeId) return edge;
  return {
    ...edge,
    ...(typeof operation.label === 'string'
      ? { label: normalizeFlowChangeText(operation.label, 'Route') }
      : {}),
    ...(typeof operation.sourceHandle === 'string' ? { sourceHandle: operation.sourceHandle } : {}),
  };
}

function applyUpdateEdge(graph: FlowChangeGraph, operation: UnknownRecord): void {
  if (typeof operation.edgeId !== 'string') return;
  const edgeId = operation.edgeId;
  graph.edges = graph.edges.map((edge) => updatedEdge(edge, edgeId, operation));
}

const PROPOSAL_OPERATION_HANDLERS = new Map<string, ProposalOperationHandler>([
  ['add_edge', applyAddEdge],
  ['add_node', applyAddNode],
  ['remove_edge', applyRemoveEdge],
  ['remove_node', applyRemoveNode],
  ['update_edge', applyUpdateEdge],
  ['update_node', applyUpdateNode],
]);

function applyProposalOperation(graph: FlowChangeGraph, operation: unknown): void {
  if (!isPlainObject(operation) || typeof operation.op !== 'string') return;
  PROPOSAL_OPERATION_HANDLERS.get(operation.op)?.(graph, operation);
}

/** Apply only structural/label fields from an MCP proposal. Config and setting values are ignored. */
export function projectProposedFlowGraph(
  baseGraph: FlowChangeGraph | undefined,
  operations: unknown[],
): FlowChangeGraph {
  const graph: FlowChangeGraph = {
    nodes: baseGraph?.nodes.map((node) => ({ ...node })) ?? [],
    edges: baseGraph?.edges.map((edge) => ({ ...edge })) ?? [],
  };
  for (const operation of operations.slice(0, MAX_PRESENTATION_OPERATIONS)) {
    applyProposalOperation(graph, operation);
  }
  return graph;
}
