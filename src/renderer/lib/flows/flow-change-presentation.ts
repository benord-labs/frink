import { isPlainObject } from '../../../shared/lib/case-converter';
import {
  flowChangeStringValue,
  normalizeFlowChangeText,
} from '../../../shared/lib/flows/flow-change-text';
import type {
  FlowChangeAction,
  FlowChangeGraph,
  FlowChangeKind,
  FlowChangeMode,
  FlowChangeOperationStatus,
  FlowChangePhase,
  FlowChangePresentation,
  FlowPatchChangeSummary,
  FlowSemanticChange,
} from '../../../shared/types/flows/flow-change-presentation';
import { FLOW_PATCH_REASON_CODES } from '../../../shared/types/flows/flow-change-presentation';
import { describeFallbackFlowChange } from './flow-change-fallback';
import { type FlowToolPart, phaseFor, rawOutput } from './flow-change-phase';
import {
  markFlowChangeGraph,
  projectProposedFlowGraph,
  toSafeFlowChangeGraph,
} from './flow-change-graph';

export type FlowBaseSnapshot = {
  id: string;
  name: string;
  graph?: unknown;
  versionNumber?: number;
};

type BuildFlowChangePresentationOptions = {
  baseFlow?: FlowBaseSnapshot;
  interrupted?: boolean;
};

const ACTIONS = new Set<FlowChangeAction>(['add', 'update', 'remove']);
const KINDS = new Set<FlowChangeKind>(['node', 'edge', 'settings']);
const REASON_CODES = new Set(FLOW_PATCH_REASON_CODES);
const STATUSES = new Set<FlowChangeOperationStatus>([
  'pending',
  'applied',
  'failed',
  'skipped',
  'unchanged',
  'unknown',
]);
const MAX_PRESENTATION_OPERATIONS = 100;
const MAX_RELATED_NODE_IDS = 16;

function numberValue(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined;
}

function operationsFrom(part: FlowToolPart): unknown[] {
  return Array.isArray(part.input?.operations)
    ? part.input.operations.slice(0, MAX_PRESENTATION_OPERATIONS)
    : [];
}

function combineGraphs(...graphs: Array<FlowChangeGraph | undefined>): FlowChangeGraph {
  const nodes = new Map<string, FlowChangeGraph['nodes'][number]>();
  const edges = new Map<string, FlowChangeGraph['edges'][number]>();
  for (const graph of graphs) {
    for (const node of graph?.nodes ?? []) nodes.set(node.id, node);
    for (const edge of graph?.edges ?? []) edges.set(edge.id, edge);
  }
  return { nodes: [...nodes.values()], edges: [...edges.values()] };
}

function operationIndexValue(value: unknown): number | undefined {
  if (typeof value !== 'number' || !Number.isInteger(value)) return undefined;
  return value >= 0 && value < MAX_PRESENTATION_OPERATIONS ? value : undefined;
}

function setValue<T extends string>(value: unknown, values: Set<T>): T | undefined {
  return typeof value === 'string' && values.has(value as T) ? (value as T) : undefined;
}

function relatedNodeIdsValue(value: unknown): string[] | undefined {
  if (!Array.isArray(value)) return undefined;
  return value.flatMap((id) => flowChangeStringValue(id) ?? []).slice(0, MAX_RELATED_NODE_IDS);
}

type RequiredServerChange = Pick<
  FlowSemanticChange,
  'operationIndex' | 'action' | 'kind' | 'status'
>;

function requiredServerChange(value: Record<string, unknown>): RequiredServerChange | undefined {
  const operationIndex = operationIndexValue(value.operationIndex);
  const action = setValue(value.action, ACTIONS);
  const kind = setValue(value.kind, KINDS);
  const status = setValue(value.status, STATUSES);
  if (operationIndex === undefined || !action || !kind || !status) return undefined;
  return { operationIndex, action, kind, status };
}

function detailValue(value: unknown): string | undefined {
  return typeof value === 'string' ? normalizeFlowChangeText(value, '') : undefined;
}

function parseServerChange(value: unknown): FlowSemanticChange | undefined {
  if (!isPlainObject(value)) return undefined;
  const required = requiredServerChange(value);
  if (!required) return undefined;
  return {
    ...required,
    label: normalizeFlowChangeText(value.label, 'Flow change'),
    detail: detailValue(value.detail),
    nodeId: flowChangeStringValue(value.nodeId),
    edgeId: flowChangeStringValue(value.edgeId),
    relatedNodeIds: relatedNodeIdsValue(value.relatedNodeIds),
    blockType: flowChangeStringValue(value.blockType),
    reasonCode: setValue(value.reasonCode, REASON_CODES),
  };
}

function parseServerSummary(value: unknown): FlowPatchChangeSummary | undefined {
  if (!isPlainObject(value) || value.schemaVersion !== 1 || !Array.isArray(value.changes)) {
    return undefined;
  }
  const mode = value.mode === 'create' || value.mode === 'update' ? value.mode : undefined;
  const baseVersionNumber = numberValue(value.baseVersionNumber);
  const versionNumber = numberValue(value.versionNumber);
  if (!mode || baseVersionNumber === undefined || versionNumber === undefined) return undefined;
  const changes = value.changes
    .slice(0, MAX_PRESENTATION_OPERATIONS)
    .map(parseServerChange)
    .filter((change) => change !== undefined);
  return { schemaVersion: 1, mode, baseVersionNumber, versionNumber, changes };
}

function indexSet(value: unknown): Set<number> {
  if (!Array.isArray(value)) return new Set();
  return new Set(
    value.slice(0, MAX_PRESENTATION_OPERATIONS * 2).flatMap((entry) => {
      if (typeof entry === 'number') return [entry];
      if (isPlainObject(entry) && typeof entry.index === 'number') return [entry.index];
      return [];
    }),
  );
}

const PHASE_STATUS_OVERRIDE: Partial<Record<FlowChangePhase, FlowChangeOperationStatus>> = {
  unconfirmed: 'unknown',
  unread: 'unknown',
  interrupted: 'unknown',
  unchanged: 'unchanged',
  denied: 'skipped',
  failed: 'failed',
  stale: 'failed',
};

function receiptOperationStatus(
  index: number,
  output: Record<string, unknown> | undefined,
): FlowChangeOperationStatus | undefined {
  const receiptLists: Array<[unknown, FlowChangeOperationStatus]> = [
    [output?.failed, 'failed'],
    [output?.skipped, 'skipped'],
    [output?.applied, 'applied'],
  ];
  return receiptLists.find(([value]) => indexSet(value).has(index))?.[1];
}

function fallbackStatus(
  index: number,
  phase: FlowChangePhase,
  output: Record<string, unknown> | undefined,
): FlowChangeOperationStatus {
  return (
    PHASE_STATUS_OVERRIDE[phase] ??
    receiptOperationStatus(index, output) ??
    (phase === 'applied' ? 'applied' : 'pending')
  );
}

function statusForPhase(
  status: FlowChangeOperationStatus,
  phase: FlowChangePhase,
): FlowChangeOperationStatus {
  if (phase === 'proposed' || phase === 'applying') return 'pending';
  return PHASE_STATUS_OVERRIDE[phase] ?? status;
}

function warningCount(output: Record<string, unknown> | undefined): number {
  return ['templateWarnings', 'webhookSetup'].reduce(
    (count, key) => count + (Array.isArray(output?.[key]) ? output[key].length : 0),
    0,
  );
}

function denialReason(
  output: Record<string, unknown> | undefined,
  phase: FlowChangePhase,
): string | undefined {
  if (phase !== 'denied' || typeof output?.userMessage !== 'string') return undefined;
  return normalizeFlowChangeText(output.userMessage, '') || undefined;
}

type PresentationGraphs = {
  baseGraph: FlowChangeGraph;
  proposalGraph: FlowChangeGraph;
  referenceGraph: FlowChangeGraph;
  resultGraph: FlowChangeGraph;
};

function presentationGraphs(
  operations: unknown[],
  baseFlow: FlowBaseSnapshot | undefined,
  output: Record<string, unknown> | undefined,
): PresentationGraphs {
  const baseGraph = toSafeFlowChangeGraph(baseFlow?.graph) ?? { nodes: [], edges: [] };
  const proposalGraph = projectProposedFlowGraph(baseGraph, operations);
  const outputGraph = toSafeFlowChangeGraph(output?.graph);
  return {
    baseGraph,
    proposalGraph,
    referenceGraph: combineGraphs(baseGraph, proposalGraph, outputGraph),
    resultGraph: outputGraph ?? proposalGraph,
  };
}

const BASE_ONLY_PHASES = new Set<FlowChangePhase>(['denied', 'failed', 'stale']);

function resultGraphForPhase(graphs: PresentationGraphs, phase: FlowChangePhase): FlowChangeGraph {
  return BASE_ONLY_PHASES.has(phase) ? graphs.baseGraph : graphs.resultGraph;
}

function changesForGraphMarking(
  graph: FlowChangeGraph,
  changes: FlowSemanticChange[],
  phase: FlowChangePhase,
): FlowSemanticChange[] {
  if (!BASE_ONLY_PHASES.has(phase)) return changes;

  const nodeIds = new Set(graph.nodes.map((node) => node.id));
  const edgeIds = new Set(graph.edges.map((edge) => edge.id));
  return changes.filter(
    (change) =>
      (!change.nodeId || nodeIds.has(change.nodeId)) &&
      (!change.edgeId || edgeIds.has(change.edgeId)),
  );
}

function fallbackChanges(
  operations: unknown[],
  graph: FlowChangeGraph,
  phase: FlowChangePhase,
  output: Record<string, unknown> | undefined,
): FlowSemanticChange[] {
  return operations.flatMap((operation, index) => {
    const change = describeFallbackFlowChange(
      operation,
      index,
      graph,
      fallbackStatus(index, phase, output),
    );
    return change ? [change] : [];
  });
}

function refineLegacyStepDetail(
  change: FlowSemanticChange,
  operation: unknown,
  graph: FlowChangeGraph,
): FlowSemanticChange {
  if (!change.detail?.split(' · ').includes('Step setup')) return change;
  const fallback = describeFallbackFlowChange(
    operation,
    change.operationIndex,
    graph,
    change.status,
  );
  if (!fallback?.detail || fallback.detail === 'Step setup') return change;
  return { ...change, detail: fallback.detail };
}

function presentationChanges(
  serverSummary: FlowPatchChangeSummary | undefined,
  operations: unknown[],
  graph: FlowChangeGraph,
  phase: FlowChangePhase,
  output: Record<string, unknown> | undefined,
): FlowSemanticChange[] {
  if (!serverSummary) return fallbackChanges(operations, graph, phase, output);
  return serverSummary.changes.map((change) =>
    refineLegacyStepDetail(
      { ...change, status: statusForPhase(change.status, phase) },
      operations[change.operationIndex],
      graph,
    ),
  );
}

function presentationMode(
  serverSummary: FlowPatchChangeSummary | undefined,
  part: FlowToolPart,
): FlowChangeMode {
  if (serverSummary) return serverSummary.mode;
  return typeof part.input?.name === 'string' ? 'create' : 'update';
}

const CONFIRMED_PHASES = new Set<FlowChangePhase>(['applied', 'partial', 'unchanged']);

function hasRecoverableAutoCreate(
  mode: FlowChangeMode,
  phase: FlowChangePhase,
  output: Record<string, unknown> | undefined,
): boolean {
  return (
    (phase === 'unconfirmed' || phase === 'stale') &&
    mode === 'create' &&
    output?.status === 'failure' &&
    output.persistence === undefined
  );
}

function presentationFlowId(
  part: FlowToolPart,
  options: BuildFlowChangePresentationOptions,
  output: Record<string, unknown> | undefined,
  mode: FlowChangeMode,
  phase: FlowChangePhase,
): string | undefined {
  const knownFlowId = flowChangeStringValue(part.input?.flowId) ?? options.baseFlow?.id;
  if (knownFlowId) return knownFlowId;
  const canTrustOutput =
    CONFIRMED_PHASES.has(phase) || hasRecoverableAutoCreate(mode, phase, output);
  return canTrustOutput ? flowChangeStringValue(output?.flowId) : undefined;
}

function presentationVersion(
  phase: FlowChangePhase,
  serverSummary: FlowPatchChangeSummary | undefined,
  output: Record<string, unknown> | undefined,
): number | undefined {
  if (!CONFIRMED_PHASES.has(phase)) return undefined;
  return serverSummary?.versionNumber ?? numberValue(output?.versionNumber);
}

export function buildFlowChangePresentation(
  part: FlowToolPart,
  options: BuildFlowChangePresentationOptions = {},
): FlowChangePresentation {
  const output = rawOutput(part);
  const operations = operationsFrom(part);
  const graphs = presentationGraphs(operations, options.baseFlow, output);
  const phase = phaseFor(part, output, options.interrupted === true);
  const serverSummary = parseServerSummary(output?.flowChange);
  const changes = presentationChanges(
    serverSummary,
    operations,
    graphs.referenceGraph,
    phase,
    output,
  );
  const resultGraph = resultGraphForPhase(graphs, phase);
  const graph = markFlowChangeGraph(
    resultGraph,
    graphs.referenceGraph,
    changesForGraphMarking(resultGraph, changes, phase),
  );
  const mode = presentationMode(serverSummary, part);

  return {
    flowId: presentationFlowId(part, options, output, mode, phase),
    name: normalizeFlowChangeText(
      output?.name ?? part.input?.name ?? options.baseFlow?.name,
      mode === 'create' ? 'New Flow' : 'Flow update',
    ),
    mode,
    phase,
    denialReason: denialReason(output, phase),
    baseVersionNumber: serverSummary?.baseVersionNumber ?? options.baseFlow?.versionNumber,
    versionNumber: presentationVersion(phase, serverSummary, output),
    graph,
    changes,
    warningCount: warningCount(output),
  };
}
