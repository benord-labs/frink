import { describeFlowNodeConfigChange } from '../../../../shared/lib/flows/flow-change-config-detail';
import { normalizeFlowChangeText } from '../../../../shared/lib/flows/flow-change-text';
import { flowPatchOperationShape } from '../../../../shared/lib/flows/flow-patch-operation-shape';
import {
  type FlowEdge,
  type FlowGraph,
  formatFlowNodeLabel,
} from '../../../../shared/lib/validate-flow-graph';
import type {
  FlowChangeMode,
  FlowChangeOperationStatus,
  FlowPatchChangeSummary,
  FlowPatchReasonCode,
  FlowSemanticChange,
} from '../../../../shared/types/flows/flow-change-presentation';
import type { FailedOp, PatchOperation, SkippedOp } from './flow-patch';

const SETTING_LABELS: Record<string, string> = {
  defaultModel: 'Default model',
  defaultProjectId: 'Default project',
  briefing: 'Flow briefing',
  pauseOnFailure: 'Failure handling',
  maxBatchConcurrency: 'Batch concurrency',
  batchTriggerSchema: 'Batch trigger inputs',
};

type BuildFlowPatchChangeSummaryParams = {
  mode: FlowChangeMode;
  baseGraph: FlowGraph;
  finalGraph: FlowGraph;
  operations: PatchOperation[];
  applied: number[];
  failed: FailedOp[];
  skipped: SkippedOp[];
  baseVersionNumber: number;
  versionNumber: number;
  versionSaved?: boolean;
};

function nodeLabel(graph: FlowGraph, nodeId: string): string {
  const node = graph.nodes.find((candidate) => candidate.id === nodeId);
  return node
    ? normalizeFlowChangeText(formatFlowNodeLabel(node), 'Untitled step')
    : 'Unknown step';
}

function edgeFromGraphs(
  edgeId: string,
  baseGraph: FlowGraph,
  finalGraph: FlowGraph,
): FlowEdge | undefined {
  return (
    finalGraph.edges.find((edge) => edge.id === edgeId) ??
    baseGraph.edges.find((edge) => edge.id === edgeId)
  );
}

function edgeLabel(
  edge: FlowEdge | undefined,
  baseGraph: FlowGraph,
  finalGraph: FlowGraph,
): string {
  if (!edge) return 'Unknown route';
  const source = nodeLabel(finalGraph, edge.source);
  const sourceLabel = source === 'Unknown step' ? nodeLabel(baseGraph, edge.source) : source;
  const target = nodeLabel(finalGraph, edge.target);
  const targetLabel = target === 'Unknown step' ? nodeLabel(baseGraph, edge.target) : target;
  return `${sourceLabel} → ${targetLabel}`;
}

function statusForOperation(
  operationIndex: number,
  applied: Set<number>,
  failed: Set<number>,
  skipped: Set<number>,
  versionSaved: boolean,
): FlowChangeOperationStatus {
  if (failed.has(operationIndex)) return 'failed';
  if (skipped.has(operationIndex)) return 'skipped';
  if (applied.has(operationIndex)) return versionSaved ? 'applied' : 'unchanged';
  return 'pending';
}

function nodeUpdateDetail(op: Extract<PatchOperation, { op: 'update_node' }>): string | undefined {
  const details: string[] = [];
  if (op.label !== undefined) details.push('Step label');
  if (op.config !== undefined) details.push(describeFlowNodeConfigChange(op.config));
  if (op.position !== undefined) details.push('Canvas position');
  return details.length > 0 ? details.join(' · ') : undefined;
}

function settingsDetail(op: Extract<PatchOperation, { op: 'update_settings' }>): string {
  const labels = Object.keys(op.settings)
    .map((key) => SETTING_LABELS[key])
    .filter((label): label is string => label !== undefined);
  return labels.length > 0 ? labels.join(' · ') : 'Flow behavior';
}

type CommonChange = Pick<FlowSemanticChange, 'operationIndex' | 'status' | 'action' | 'kind'>;

function describeAddedNode(
  op: Extract<PatchOperation, { op: 'add_node' }>,
  common: CommonChange,
  finalGraph: FlowGraph,
): FlowSemanticChange {
  return {
    ...common,
    label: nodeLabel(finalGraph, op.node.id),
    detail: `${normalizeFlowChangeText(formatFlowNodeLabel(op.node), 'Step')} step`,
    nodeId: op.node.id,
    blockType: op.node.blockType,
  };
}

function describeUpdatedNode(
  op: Extract<PatchOperation, { op: 'update_node' }>,
  common: CommonChange,
  baseGraph: FlowGraph,
  finalGraph: FlowGraph,
): FlowSemanticChange {
  const finalLabel = nodeLabel(finalGraph, op.nodeId);
  return {
    ...common,
    label: finalLabel === 'Unknown step' ? nodeLabel(baseGraph, op.nodeId) : finalLabel,
    detail: nodeUpdateDetail(op),
    nodeId: op.nodeId,
  };
}

function describeRemovedNode(
  op: Extract<PatchOperation, { op: 'remove_node' }>,
  common: CommonChange,
  baseGraph: FlowGraph,
): FlowSemanticChange {
  return {
    ...common,
    label: nodeLabel(baseGraph, op.nodeId),
    detail: 'Step and connected routes',
    nodeId: op.nodeId,
    blockType: baseGraph.nodes.find((node) => node.id === op.nodeId)?.blockType,
  };
}

function describeAddedEdge(
  op: Extract<PatchOperation, { op: 'add_edge' }>,
  common: CommonChange,
  baseGraph: FlowGraph,
  finalGraph: FlowGraph,
): FlowSemanticChange {
  const branchLabel = op.edge.sourceHandle === 'true' ? 'True' : 'False';
  return {
    ...common,
    label: edgeLabel(op.edge, baseGraph, finalGraph),
    detail: op.edge.sourceHandle ? `${branchLabel} route` : 'Route',
    edgeId: op.edge.id,
    relatedNodeIds: [op.edge.source, op.edge.target],
  };
}

function describeExistingEdge(
  edgeId: string,
  detail: string,
  common: CommonChange,
  baseGraph: FlowGraph,
  finalGraph: FlowGraph,
): FlowSemanticChange {
  const edge = edgeFromGraphs(edgeId, baseGraph, finalGraph);
  return {
    ...common,
    label: edgeLabel(edge, baseGraph, finalGraph),
    detail,
    edgeId,
    relatedNodeIds: edge ? [edge.source, edge.target] : undefined,
  };
}

function describeOperation(
  op: PatchOperation,
  operationIndex: number,
  baseGraph: FlowGraph,
  finalGraph: FlowGraph,
  status: FlowChangeOperationStatus,
): FlowSemanticChange {
  const shape = flowPatchOperationShape(op.op);
  const common = { operationIndex, status, ...shape };

  switch (op.op) {
    case 'add_node':
      return describeAddedNode(op, common, finalGraph);
    case 'update_node':
      return describeUpdatedNode(op, common, baseGraph, finalGraph);
    case 'remove_node':
      return describeRemovedNode(op, common, baseGraph);
    case 'add_edge':
      return describeAddedEdge(op, common, baseGraph, finalGraph);
    case 'update_edge':
      return describeExistingEdge(op.edgeId, 'Route behavior', common, baseGraph, finalGraph);
    case 'remove_edge':
      return describeExistingEdge(op.edgeId, 'Route', common, baseGraph, finalGraph);
    case 'update_settings':
      return {
        ...common,
        label: 'Flow settings',
        detail: settingsDetail(op),
      };
  }
}

export function buildFlowPatchChangeSummary({
  mode,
  baseGraph,
  finalGraph,
  operations,
  applied,
  failed,
  skipped,
  baseVersionNumber,
  versionNumber,
  versionSaved = true,
}: BuildFlowPatchChangeSummaryParams): FlowPatchChangeSummary {
  const appliedSet = new Set(applied);
  const failedSet = new Set(failed.map((entry) => entry.index));
  const skippedSet = new Set(skipped.map((entry) => entry.index));
  // Only the closed code crosses into the receipt — the raw operation text stays agent-facing.
  const reasonCodes = new Map<number, FlowPatchReasonCode>();
  for (const entry of [...failed, ...skipped]) {
    if (entry.code !== undefined) reasonCodes.set(entry.index, entry.code);
  }

  return {
    schemaVersion: 1,
    mode,
    baseVersionNumber,
    versionNumber,
    changes: operations.map((operation, operationIndex) => {
      const change = describeOperation(
        operation,
        operationIndex,
        baseGraph,
        finalGraph,
        statusForOperation(operationIndex, appliedSet, failedSet, skippedSet, versionSaved),
      );
      const reasonCode = reasonCodes.get(operationIndex);
      return reasonCode === undefined ? change : { ...change, reasonCode };
    }),
  };
}
