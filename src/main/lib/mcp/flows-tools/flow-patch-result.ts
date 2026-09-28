import log from 'electron-log';
import { agentProseGraphWarnings } from '../../../../shared/lib/flows/agent-prose-limit';
import { type FlowGraph, formatFlowNodeLabel } from '../../../../shared/lib/validate-flow-graph';
import type { TemplateVariableWarning } from '../../../../shared/lib/validate-flow-templates';
import type {
  FlowChangeMode,
  FlowPatchChangeSummary,
} from '../../../../shared/types/flows/flow-change-presentation';
import { FLOW_PATCH_VERSION_CONFLICT_CODE } from '../../../../shared/types/flows/flow-change-presentation';
import { FlowVersionConflictError } from '../../db/repos/flow-versions';
import { type McpToolResult, toolResult } from '../tool-result';
import { buildFlowPatchChangeSummary } from './flow-change-presentation';
import type { FailedOp, PatchOperation, PatchResult, SkippedOp } from './flow-patch';

export type FlowPatchReceipt = {
  versionNumber: number;
  versionSaved: boolean;
  persistence: 'saved' | 'unchanged';
  flowChange: FlowPatchChangeSummary;
};

export type FlowPatchRollback = {
  confirmed: boolean;
  recoveryFlowId?: string;
};

type BuildFlowPatchReceiptParams = {
  mode: FlowChangeMode;
  baseGraph: FlowGraph;
  finalGraph: FlowGraph;
  operations: PatchOperation[];
  applied: number[];
  failed: FailedOp[];
  skipped: SkippedOp[];
  baseVersionNumber: number;
  persistedVersionNumber: unknown;
};

type PersistedPatch = Extract<PatchResult, { status: 'success' | 'partial' }>;

type BuildFlowPatchResultParams = {
  patch: PersistedPatch;
  receipt: FlowPatchReceipt;
  flowId: string;
  versionId: string;
  name: string;
  operationCount: number;
  creationProjectNote: string | null;
  createdFlow: boolean;
  templateWarnings: TemplateVariableWarning[];
  webhookSetup: string[];
};

type RollbackCreatedFlowParams = {
  flowId: string | null;
  context: 'patch auto-create' | 'command-expansion';
  deleteFlow: (flowId: string) => Promise<unknown>;
  releaseCreateSlot: () => void;
};

type ConditionalRollbackCreatedFlowParams = RollbackCreatedFlowParams & {
  persistenceCompleted: boolean;
};

type BuildUnexpectedErrorParams = {
  error: unknown;
  hadCreatedFlow: boolean;
  rollback: FlowPatchRollback;
  persistenceAttempted: boolean;
};

export function flowPatchError(
  message: string,
  persistence?: 'none',
  recoveryFlowId?: string,
): McpToolResult {
  return toolResult(
    JSON.stringify({
      status: 'failure',
      ...(persistence ? { persistence } : {}),
      ...(recoveryFlowId ? { flowId: recoveryFlowId } : {}),
      message,
    }),
    true,
  );
}

function flowPatchVersionConflictError(
  message: string,
  persistence?: 'none',
  recoveryFlowId?: string,
): McpToolResult {
  return toolResult(
    JSON.stringify({
      status: 'failure',
      ...(persistence ? { persistence } : {}),
      errorCode: FLOW_PATCH_VERSION_CONFLICT_CODE,
      ...(recoveryFlowId ? { flowId: recoveryFlowId } : {}),
      message,
    }),
    true,
  );
}

export function buildFlowPatchReceipt({
  mode,
  baseGraph,
  finalGraph,
  operations,
  applied,
  failed,
  skipped,
  baseVersionNumber,
  persistedVersionNumber,
}: BuildFlowPatchReceiptParams): FlowPatchReceipt {
  const versionNumber =
    typeof persistedVersionNumber === 'number' ? persistedVersionNumber : baseVersionNumber + 1;
  const versionSaved = versionNumber > baseVersionNumber;
  return {
    versionNumber,
    versionSaved,
    persistence: versionSaved ? 'saved' : 'unchanged',
    flowChange: buildFlowPatchChangeSummary({
      mode,
      baseGraph,
      finalGraph,
      operations,
      applied,
      failed,
      skipped,
      baseVersionNumber,
      versionNumber,
      versionSaved,
    }),
  };
}

/**
 * Operations worth re-sending. A skip is only retryable when its dependency could still be
 * satisfied; an already-satisfied skip is excluded so callers never retry a benign no-op.
 */
function retryOperationIndexes(failed: FailedOp[], skipped: SkippedOp[]): number[] {
  return [
    ...failed.map((entry) => entry.index),
    ...skipped.filter((entry) => entry.code === 'dependency-failed').map((entry) => entry.index),
  ].sort((left, right) => left - right);
}

/**
 * Every Start Task that runs opens its own sidebar chat, so a flow with several is visible clutter
 * on every run. Worded by node count, not a per-run total: Start Tasks on exclusive condition
 * branches never both run. Informational only — multiple sessions are sometimes intended.
 */
function sessionFootprintNote(graph: FlowGraph): string | null {
  const startTasks = graph.nodes.filter((node) => node.blockType === 'start_task');
  if (startTasks.length < 2) return null;
  const fanOutIds = new Set(
    graph.nodes.filter((node) => node.blockType === 'fan_out').map((node) => node.id),
  );
  const names = startTasks.map((node) => {
    const name = `"${formatFlowNodeLabel(node)}"`;
    return node.parentId && fanOutIds.has(node.parentId)
      ? `${name} (inside Fan Out, one chat per item)`
      : name;
  });
  return `This flow has ${startTasks.length} Start Tasks: ${names.join(', ')}. Each one that runs opens its own sidebar chat; add one only for a separate project, a separate branch/PR, isolated per-item context, or when the user asked for separate chats (frink-flows skill → Sessions).`;
}

function optionalPresentationFields(
  templateWarnings: Array<string | TemplateVariableWarning>,
  webhookSetup: string[],
  graph: FlowGraph,
): Record<string, unknown> {
  const sessions = sessionFootprintNote(graph);
  return {
    ...(templateWarnings.length > 0 ? { templateWarnings } : {}),
    ...(webhookSetup.length > 0 ? { webhookSetup } : {}),
    ...(sessions ? { sessions } : {}),
  };
}

function partialWarnings(
  templateWarnings: TemplateVariableWarning[],
  hasRetryableOps: boolean,
): Array<string | TemplateVariableWarning> {
  if (!hasRetryableOps) return templateWarnings;
  const partialNote =
    'Note: graph is partial — some warnings may resolve after retrying failed operations.';
  return [partialNote, ...templateWarnings];
}

function buildPartialFlowPatchResult(params: BuildFlowPatchResultParams): McpToolResult {
  const { patch, receipt } = params;
  const retryOps = retryOperationIndexes(patch.failed, patch.skipped);
  const retryNote =
    retryOps.length > 0
      ? " Re-send the operations listed in retryOps using 'flowId' (not 'name') to complete the update, correcting any whose cause is named in failed[] — an operation that failed on its own terms fails again if re-sent unchanged."
      : ' Nothing needs retrying — the remaining operations were already satisfied by earlier operations in this batch.';
  return toolResult(
    JSON.stringify(
      {
        status: 'partial',
        persistence: receipt.persistence,
        flowId: params.flowId,
        versionId: params.versionId,
        versionNumber: receipt.versionNumber,
        name: params.name,
        graph: patch.graph,
        flowChange: receipt.flowChange,
        applied: patch.applied,
        failed: patch.failed,
        skipped: patch.skipped,
        retryOps,
        message: `Flow "${params.name}" partially patched (${patch.applied.length}/${params.operationCount} operations applied).${receipt.versionSaved ? '' : ' The durable graph was already current, so no new version was saved.'}${retryNote}${params.creationProjectNote ? ` ${params.creationProjectNote}` : ''}`,
        ...optionalPresentationFields(
          partialWarnings(params.templateWarnings, retryOps.length > 0),
          params.webhookSetup,
          patch.graph,
        ),
      },
      null,
      2,
    ),
  );
}

function buildSuccessfulFlowPatchResult(params: BuildFlowPatchResultParams): McpToolResult {
  const { patch, receipt } = params;
  const action = receipt.versionSaved
    ? params.createdFlow
      ? 'created'
      : 'patched'
    : 'was already current';
  const versionMessage = receipt.versionSaved ? 'version saved' : 'no new version needed';
  // A brand-new flow starts with no standing agent-run grant. Saying so here —
  // at the moment the flow is born — is what stops an agent discovering it by
  // burning a failed run call and then reporting itself blocked.
  const runHint = params.createdFlow
    ? ' Agent runs are off for new flows by default (agent_invocable: false). Call frink_flows_run to verify it anyway — the user gets a one-click approval card in this chat and does not need to change any settings.'
    : '';
  return toolResult(
    JSON.stringify(
      {
        status: 'success',
        persistence: receipt.persistence,
        flowId: params.flowId,
        versionId: params.versionId,
        versionNumber: receipt.versionNumber,
        name: params.name,
        graph: patch.graph,
        flowChange: receipt.flowChange,
        applied: patch.applied,
        failed: patch.failed,
        skipped: patch.skipped,
        ...(params.createdFlow ? { agentInvocable: false } : {}),
        message: `Flow "${params.name}" ${action} successfully (${versionMessage}).${params.creationProjectNote ? ` ${params.creationProjectNote}` : ''}${runHint} A visual flow preview is already rendered in the chat automatically — do NOT describe the flow layout, draw a Mermaid diagram, or list the nodes/edges again. Just confirm what changed.`,
        ...optionalPresentationFields(params.templateWarnings, params.webhookSetup, patch.graph),
      },
      null,
      2,
    ),
  );
}

export function buildFlowPatchResult(params: BuildFlowPatchResultParams): McpToolResult {
  // Near-cap agent prose rides templateWarnings, the one warning channel a saved patch returns.
  const withProse = {
    ...params,
    templateWarnings: [
      ...params.templateWarnings,
      ...agentProseGraphWarnings(params.patch.graph.nodes),
    ],
  };
  return withProse.patch.status === 'partial'
    ? buildPartialFlowPatchResult(withProse)
    : buildSuccessfulFlowPatchResult(withProse);
}

export async function rollbackCreatedFlow({
  flowId,
  context,
  deleteFlow,
  releaseCreateSlot,
}: RollbackCreatedFlowParams): Promise<FlowPatchRollback> {
  if (!flowId) return { confirmed: true };
  try {
    await deleteFlow(flowId);
    return { confirmed: true };
  } catch (error) {
    log.warn(`[flows-tools] ${context} rollback failed:`, error);
    return { confirmed: false, recoveryFlowId: flowId };
  } finally {
    releaseCreateSlot();
  }
}

export function rollbackCreatedFlowUnlessPersisted({
  persistenceCompleted,
  ...rollbackParams
}: ConditionalRollbackCreatedFlowParams): Promise<FlowPatchRollback> {
  if (persistenceCompleted) {
    return Promise.resolve({
      confirmed: false,
      ...(rollbackParams.flowId ? { recoveryFlowId: rollbackParams.flowId } : {}),
    });
  }
  return rollbackCreatedFlow(rollbackParams);
}

function conflictVersion(error: unknown): number | undefined {
  return error instanceof FlowVersionConflictError ? error.actual : undefined;
}

function isVersionConflict(error: unknown): boolean {
  return error instanceof FlowVersionConflictError;
}

export function buildFlowPatchUnexpectedError({
  error,
  hadCreatedFlow,
  rollback,
  persistenceAttempted,
}: BuildUnexpectedErrorParams): McpToolResult {
  const message = error instanceof Error ? error.message : String(error);
  if (isVersionConflict(error)) {
    const version = conflictVersion(error);
    const hint =
      typeof version === 'number'
        ? ` Current max version is ${version} — call frink_flows_get and retry with the latest graph.`
        : '';
    if (hadCreatedFlow) {
      return flowPatchVersionConflictError(
        `Failed to save the newly created Flow: ${message}.${hint}`,
        rollback.confirmed ? 'none' : undefined,
        rollback.recoveryFlowId,
      );
    }
    return flowPatchVersionConflictError(
      `Failed to save patched flow version (conflict): ${message}.${hint}`,
      'none',
    );
  }
  return flowPatchError(
    `Failed to patch flow: ${message}`,
    rollback.confirmed && (!persistenceAttempted || hadCreatedFlow) ? 'none' : undefined,
    hadCreatedFlow ? rollback.recoveryFlowId : undefined,
  );
}
