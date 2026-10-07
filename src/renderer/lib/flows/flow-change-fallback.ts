import { isPlainObject } from '../../../shared/lib/case-converter';
import { describeFlowNodeConfigChange } from '../../../shared/lib/flows/flow-change-config-detail';
import { flowChangeStringValue } from '../../../shared/lib/flows/flow-change-text';
import type {
  FlowChangeGraph,
  FlowChangeOperationStatus,
  FlowSemanticChange,
} from '../../../shared/types/flows/flow-change-presentation';

const SETTINGS_LABELS: Record<string, string> = {
  defaultModel: 'Default model',
  defaultProjectId: 'Default project',
  briefing: 'Flow briefing',
  pauseOnFailure: 'Failure handling',
  maxBatchConcurrency: 'Batch concurrency',
  batchTriggerSchema: 'Batch trigger inputs',
};

function nodeName(graph: FlowChangeGraph, id: unknown): string {
  if (typeof id !== 'string') return 'A flow step';
  return graph.nodes.find((node) => node.id === id)?.label ?? 'A flow step';
}

function edgeName(graph: FlowChangeGraph, source: unknown, target: unknown): string {
  if (typeof source !== 'string' || typeof target !== 'string') return 'A flow route';
  return `${nodeName(graph, source)} → ${nodeName(graph, target)}`;
}

type FallbackChangeCommon = Pick<FlowSemanticChange, 'operationIndex' | 'status'>;

function describeAddedNode(
  operation: Record<string, unknown>,
  common: FallbackChangeCommon,
  graph: FlowChangeGraph,
): FlowSemanticChange | undefined {
  if (!isPlainObject(operation.node)) return undefined;
  const nodeId = flowChangeStringValue(operation.node.id);
  if (!nodeId) return undefined;
  const blockType = flowChangeStringValue(operation.node.blockType);
  return {
    ...common,
    action: 'add',
    kind: 'node',
    label: nodeName(graph, nodeId),
    detail: 'New step',
    nodeId,
    ...(blockType ? { blockType } : {}),
  };
}

function nodeChangeDetail(operation: Record<string, unknown>): string {
  return [
    operation.label !== undefined ? 'Step label' : '',
    operation.config !== undefined ? describeFlowNodeConfigChange(operation.config) : '',
    operation.position !== undefined ? 'Canvas position' : '',
  ]
    .filter(Boolean)
    .join(' · ');
}

function describeExistingNode(
  operation: Record<string, unknown>,
  common: FallbackChangeCommon,
  graph: FlowChangeGraph,
): FlowSemanticChange | undefined {
  const nodeId = flowChangeStringValue(operation.nodeId);
  if (!nodeId) return undefined;
  const removing = operation.op === 'remove_node';
  return {
    ...common,
    action: removing ? 'remove' : 'update',
    kind: 'node',
    label: nodeName(graph, nodeId),
    detail: removing ? 'Step and connected routes' : nodeChangeDetail(operation),
    nodeId,
  };
}

function describeAddedEdge(
  operation: Record<string, unknown>,
  common: FallbackChangeCommon,
  graph: FlowChangeGraph,
): FlowSemanticChange | undefined {
  if (!isPlainObject(operation.edge)) return undefined;
  const edgeId = flowChangeStringValue(operation.edge.id);
  if (!edgeId) return undefined;
  return {
    ...common,
    action: 'add',
    kind: 'edge',
    label: edgeName(graph, operation.edge.source, operation.edge.target),
    detail: 'Route',
    edgeId,
    relatedNodeIds: [operation.edge.source, operation.edge.target].flatMap(
      (id) => flowChangeStringValue(id) ?? [],
    ),
  };
}

function describeExistingEdge(
  operation: Record<string, unknown>,
  common: FallbackChangeCommon,
  graph: FlowChangeGraph,
): FlowSemanticChange | undefined {
  const edgeId = flowChangeStringValue(operation.edgeId);
  if (!edgeId) return undefined;
  const edge = graph.edges.find((candidate) => candidate.id === edgeId);
  return {
    ...common,
    action: operation.op === 'remove_edge' ? 'remove' : 'update',
    kind: 'edge',
    label: edge ? edgeName(graph, edge.source, edge.target) : 'A flow route',
    detail: 'Route',
    edgeId,
    relatedNodeIds: edge ? [edge.source, edge.target] : undefined,
  };
}

function describeSettingsChange(
  operation: Record<string, unknown>,
  common: FallbackChangeCommon,
): FlowSemanticChange {
  const settings = isPlainObject(operation.settings) ? operation.settings : {};
  const labels = Object.keys(settings).flatMap((key) => SETTINGS_LABELS[key] ?? []);
  return {
    ...common,
    action: 'update',
    kind: 'settings',
    label: 'Flow settings',
    detail: labels.length > 0 ? labels.join(' · ') : 'Flow behavior',
  };
}

function describeLayoutReset(common: FallbackChangeCommon): FlowSemanticChange {
  return {
    ...common,
    action: 'update',
    kind: 'settings',
    label: 'Canvas layout',
    detail: 'Reset to automatic layout',
  };
}

type FallbackChangeHandler = (
  operation: Record<string, unknown>,
  common: FallbackChangeCommon,
  graph: FlowChangeGraph,
) => FlowSemanticChange | undefined;

const FALLBACK_CHANGE_HANDLERS = new Map<string, FallbackChangeHandler>([
  ['add_node', describeAddedNode],
  ['update_node', describeExistingNode],
  ['remove_node', describeExistingNode],
  ['add_edge', describeAddedEdge],
  ['update_edge', describeExistingEdge],
  ['remove_edge', describeExistingEdge],
  ['update_settings', describeSettingsChange],
  ['auto_layout', (_operation, common) => describeLayoutReset(common)],
]);

export function describeFallbackFlowChange(
  operation: unknown,
  operationIndex: number,
  graph: FlowChangeGraph,
  status: FlowChangeOperationStatus,
): FlowSemanticChange | undefined {
  if (!isPlainObject(operation) || typeof operation.op !== 'string') return undefined;
  return FALLBACK_CHANGE_HANDLERS.get(operation.op)?.(operation, { operationIndex, status }, graph);
}
