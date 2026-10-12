/** Rich, durable chat artifact for frink_flows_patch. */

import { useSetAtom } from 'jotai';
import { type ReactElement, useMemo } from 'react';
import { isPlainObject } from '../../../../../shared/lib/case-converter';
import { describeFlowNodeConfigChange } from '../../../../../shared/lib/flows/flow-change-config-detail';
import { isSpilledToolResultText, unwrapMcpOutput } from '../../../../../shared/lib/mcp-output';
import type { FlowGraph } from '../../../../../shared/lib/validate-flow-graph';
import { normalizeFlowGraph } from '../../../../../shared/lib/validate-flow-graph';
import { flowChangeStringValue } from '../../../../../shared/lib/flows/flow-change-text';
import { useFlowBaseSnapshot } from '../../../../hooks/useFlowBaseSnapshot';
import { activeOverlayAtom, flowsSelectedFlowIdAtom } from '../../../../lib/atoms';
import { toSafeFlowChangeGraph } from '../../../../lib/flows/flow-change-graph';
import { buildFlowChangePresentation } from '../../../../lib/flows/flow-change-presentation';
import { FlowChangeArtifact } from '../../../flows/FlowChangeArtifact';
import type { MessagePart } from '../../stores/message-store';
import { getToolStatus } from '../agent-tool-registry';

type PatchOutput = {
  flowId: string;
  name: string;
  graph?: FlowGraph;
  status?: 'success' | 'partial';
};

function stringField(record: Record<string, unknown>, key: string): string | undefined {
  const value = record[key];
  return typeof value === 'string' ? value : undefined;
}

function projectStringFields(
  value: unknown,
  keys: readonly string[],
): Record<string, string | undefined> | undefined {
  if (!isPlainObject(value)) return undefined;
  return Object.fromEntries(keys.map((key) => [key, stringField(value, key)]));
}

function projectConfigKeyShape(value: unknown): string | undefined {
  if (value === undefined) return undefined;
  return describeFlowNodeConfigChange(value);
}

function projectInputOperation(operation: unknown): Record<string, unknown> | null {
  if (!isPlainObject(operation)) return null;
  const settings = isPlainObject(operation.settings) ? operation.settings : undefined;
  return {
    op: stringField(operation, 'op') ?? '',
    ...projectStringFields(operation, ['nodeId', 'edgeId', 'label', 'sourceHandle']),
    hasConfig: operation.config !== undefined,
    configKeyShape: projectConfigKeyShape(operation.config),
    hasPosition: operation.position !== undefined,
    node: projectStringFields(operation.node, ['id', 'blockType', 'label']),
    edge: projectStringFields(operation.edge, ['id', 'source', 'target', 'sourceHandle', 'label']),
    settingKeys: settings ? Object.keys(settings).sort() : undefined,
  };
}

/** Redaction-safe revision of only the proposal fields the chat presentation reads. */
function inputPresentationRevision(part: MessagePart): string {
  const operations = Array.isArray(part.input?.operations) ? part.input.operations : [];
  const projectedOperations = operations.slice(0, 100).map(projectInputOperation);
  return JSON.stringify({
    flowId: inputFlowId(part),
    name: typeof part.input?.name === 'string' ? part.input.name : undefined,
    operations: projectedOperations,
  });
}

function receiptIndexes(value: unknown): Array<number | null> | undefined {
  if (!Array.isArray(value)) return undefined;
  return value.slice(0, 200).map((entry) => {
    if (typeof entry === 'number') return entry;
    return isPlainObject(entry) && typeof entry.index === 'number' ? entry.index : null;
  });
}

function receiptChanges(value: unknown): Array<Record<string, unknown> | null> | undefined {
  if (!Array.isArray(value)) return undefined;
  return value.slice(0, 100).map((entry) => {
    if (!isPlainObject(entry)) return null;
    return {
      operationIndex: entry.operationIndex,
      action: entry.action,
      kind: entry.kind,
      status: entry.status,
      reasonCode: entry.reasonCode,
      label: entry.label,
      detail: entry.detail,
      nodeId: entry.nodeId,
      edgeId: entry.edgeId,
      relatedNodeIds: Array.isArray(entry.relatedNodeIds)
        ? entry.relatedNodeIds.slice(0, 16)
        : undefined,
      blockType: entry.blockType,
    };
  });
}

/** Stable, redaction-safe revision of only terminal receipt fields rendered by the artifact. */
export function outputPresentationRevision(part: MessagePart): string {
  const unwrapped = unwrapMcpOutput(part.output ?? part.result);
  // Same reading as the phase, so the key changes exactly when the phase can; never the path.
  if (isSpilledToolResultText(flowChangeStringValue(unwrapped) ?? '')) {
    return JSON.stringify({ kind: 'spill' });
  }
  if (!isPlainObject(unwrapped)) return JSON.stringify({ kind: typeof unwrapped });
  const flowChange = isPlainObject(unwrapped.flowChange) ? unwrapped.flowChange : undefined;
  const error = isPlainObject(unwrapped.error) ? unwrapped.error.message : unwrapped.error;
  return JSON.stringify({
    status: unwrapped.status,
    persistence: unwrapped.persistence,
    flowId: unwrapped.flowId,
    name: unwrapped.name,
    versionNumber: unwrapped.versionNumber,
    permissionDenied: unwrapped.permissionDenied,
    userMessage:
      unwrapped.permissionDenied === true ? stringField(unwrapped, 'userMessage') : undefined,
    rejected: unwrapped.rejected,
    error,
    graph: toSafeFlowChangeGraph(unwrapped.graph),
    flowChange: flowChange
      ? {
          schemaVersion: flowChange.schemaVersion,
          mode: flowChange.mode,
          baseVersionNumber: flowChange.baseVersionNumber,
          versionNumber: flowChange.versionNumber,
          changes: receiptChanges(flowChange.changes),
        }
      : undefined,
    applied: receiptIndexes(unwrapped.applied),
    failed: receiptIndexes(unwrapped.failed),
    skipped: receiptIndexes(unwrapped.skipped),
    templateWarningCount: Array.isArray(unwrapped.templateWarnings)
      ? unwrapped.templateWarnings.length
      : 0,
    webhookSetupCount: Array.isArray(unwrapped.webhookSetup) ? unwrapped.webhookSetup.length : 0,
  });
}

function inputFlowId(part: MessagePart): string | undefined {
  const value = part.input?.flowId;
  return typeof value === 'string' && value.trim().length > 0 ? value : undefined;
}

/** Compatibility parser used by focused MCP wrapper tests and older persisted messages. */
export function parseOutput(part: MessagePart): PatchOutput | null {
  const unwrapped = unwrapMcpOutput(part.output ?? part.result);
  if (!unwrapped || typeof unwrapped !== 'object' || Array.isArray(unwrapped)) return null;
  const raw = unwrapped as Record<string, unknown>;
  const flowId = typeof raw.flowId === 'string' ? raw.flowId : undefined;
  if (!flowId) return null;
  const output: PatchOutput = {
    flowId,
    name: typeof raw.name === 'string' ? raw.name : 'Untitled flow',
    graph: normalizeFlowGraph(raw.graph) ?? undefined,
  };
  if (raw.status === 'partial') output.status = raw.status;
  return output;
}

export type Props = {
  part: MessagePart;
  chatStatus?: string;
  /** Inside another glass card (a subagent's): a tint, not a second glass. */
  nested?: boolean;
};

export function AgentFlowTool({ part, chatStatus, nested }: Props): ReactElement {
  const status = getToolStatus(part, chatStatus);
  const outputRevision = outputPresentationRevision(part);
  // biome-ignore lint/correctness/useExhaustiveDependencies: the semantic receipt revision intentionally replaces mutable/fresh provider object identities.
  const parsedOutput = useMemo(() => parseOutput(part), [outputRevision]);
  const existingFlowId = inputFlowId(part);
  const needsBaseSnapshot = Boolean(existingFlowId && !parsedOutput?.graph);
  const baseFlow = useFlowBaseSnapshot(existingFlowId, needsBaseSnapshot);
  const inputRevision = inputPresentationRevision(part);
  // AI SDK message parts are mutated in place, so depend on their current fields rather than the
  // part object identity. The redaction-safe input revision catches streamed proposal changes;
  // stable terminal/base references keep the expensive graph projection and SVG layouts memoized
  // across parent task timers and unrelated chat renders.
  // biome-ignore lint/correctness/useExhaustiveDependencies: the current MessagePart fields and redaction-safe input revision intentionally replace object identity.
  const presentation = useMemo(
    () =>
      buildFlowChangePresentation(part, {
        baseFlow,
        interrupted: status.isInterrupted,
      }),
    [baseFlow, inputRevision, outputRevision, part.errorText, part.state, status.isInterrupted],
  );
  const setFlowId = useSetAtom(flowsSelectedFlowIdAtom);
  const setOverlay = useSetAtom(activeOverlayAtom);

  function handleOpenFlow(flowId: string): void {
    setFlowId(flowId);
    setOverlay('flows');
  }

  return (
    <div className="min-w-0 py-0.5">
      <FlowChangeArtifact presentation={presentation} onOpenFlow={handleOpenFlow} nested={nested} />
    </div>
  );
}
