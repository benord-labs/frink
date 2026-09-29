import {
  FRINK_DYNAMIC_CHAT_MCP_KEY,
  FRINK_MUTATING_FLOW_TOOLS,
} from '../../../../../shared/lib/mcp-tool-name';
import type { FlowGraph } from '../../../../../shared/lib/validate-flow-graph';
import type { ChatMode } from '../../../../../shared/types/chat-mode';
import type {
  CustomNodeRegistrationPresentation,
  PermissionPresentation,
} from '../../../../../shared/types/permissions';
import { FRINK_CUSTOM_NODES_DIR } from '../../../frink-custom-nodes-dir';
import { type McpToolResult, toolResult } from '../../tool-result';
import { FLOWS_TOOL_NAMES, handleFlowsToolCall } from '..';
import type { RegisterNodeOptions } from '../register-node';
import {
  flowPermissionSummary,
  isUserDecline,
  MISSING_FLOW_PROJECT_MESSAGE,
  STALE_FLOW_CONTEXT_MESSAGE,
} from './consent-messages';
import type { RequestFlowConsent } from './flow-invocation-consent';
import { gateFlowInvocation, releaseBatchConsent } from './flow-invocation-gate';

const FLOW_PATCH_TOOL_NAME = 'frink_flows_patch';
const REGISTER_NODE_TOOL_NAME = 'frink_register_node';

/**
 * The slice of the flow store the consent gate needs, injected by the
 * dynamic-chat server for the same reason `validateWrite` is: this module must
 * stay free of the db import chain. It is a parameter rather than a lazy
 * `import()` because two concurrent gate calls racing a dynamic import is not
 * something a permission decision may depend on.
 */
export type FlowConsentStore = {
  getFlow: (id: string) => Promise<{
    name: string;
    agent_invocable: boolean;
    is_enabled: boolean;
    graph: FlowGraph | null;
  }>;
  updateFlow: (id: string, patch: { agentInvocable: boolean }) => Promise<void>;
  listFlowBatchStages: (
    flowId: string,
    batchId: string,
  ) => Promise<{ stages: { run_count?: number | null }[] }>;
};

/** The slice of the dynamic-chat ExecutionContext the flow-write gate reads. */
export type FlowGateContext = {
  chatId: string;
  subChatId: string;
  projectPath?: string;
  runtime?: 'claude' | 'codex';
  autoReviewTools?: boolean;
  planAutoDenyFloor?: () => boolean;
  isFlowDrivenTurn?: boolean;
  abortSignal?: AbortSignal;
};

/**
 * `validateToolPermission`'s shape, injected by the dynamic-chat server so this
 * module never imports the executor (which would close an import cycle).
 */
export type ValidateFlowWrite = (
  toolName: string,
  toolInput: Record<string, unknown>,
  projectPath: string | undefined,
  chatId: string,
  subChatId: string,
  reason?: string,
  permissionPathOverride?: string,
  isFlowDrivenTurn?: boolean,
  deferAskToProvider?: boolean,
  abortSignal?: AbortSignal,
  trustedFrinkOwnedMcp?: boolean,
  mcpIdentity?: { server: string; tool: string },
  presentation?: PermissionPresentation,
) => Promise<{ allowed: true } | { allowed: false; message: string } | { allowed: null }>;

type DispatchFlowToolCallOptions = {
  name: string;
  args: Record<string, unknown>;
  executionId?: string;
  /** True when the request addressed a per-sub-chat channel. */
  channelAddressed?: boolean;
  ctx?: FlowGateContext | null;
  projectPath?: string;
  mode?: ChatMode;
  flowsEnabled: boolean;
  validateWrite: ValidateFlowWrite;
  /** Exact one-shot approval from the provider callback for this MCP call. */
  providerPreapproved?: boolean;
  /** Absent when there is no chat to raise a consent card in (bare-local callers). */
  requestFlowConsent?: RequestFlowConsent;
  /** Absent only in callers that cannot reach the flow store; consent then no-ops. */
  flowStore?: FlowConsentStore;
  isExecutionCurrent?: () => boolean;
};

function unavailableFlowToolResult(name: string, message: string): McpToolResult {
  const text =
    name === FLOW_PATCH_TOOL_NAME
      ? JSON.stringify({ status: 'failure', persistence: 'none', message })
      : message;
  return toolResult(text, true);
}

/**
 * `permissionDenied` means the USER said no — the agent's guidance keys "do not
 * retry" off it. A stale turn, a missing project, a timeout, or a consent card
 * that is pending / expired / superseded / undeliverable is not a decline, and
 * must not be reported as one. Derived from the message here so no call site
 * can get it wrong.
 */
function deniedFlowToolResult(message: string): McpToolResult {
  return toolResult(
    JSON.stringify({
      status: 'failure',
      persistence: 'none',
      permissionDenied: isUserDecline(message),
      userMessage: flowPermissionSummary(message),
      message,
    }),
    true,
  );
}

export type FlowWriteDecision = { allowed: true } | { allowed: false; message: string };

/** Gate a mutating flow-tool call through the v2 permission dispatcher. A Claude run passes: its
 * SDK permission callbacks already asked, and its channel resolves only to its own CLI's run. */
export async function gateFlowWrite(
  ctx: FlowGateContext | null | undefined,
  toolName: string,
  args: Record<string, unknown>,
  validateWrite: ValidateFlowWrite,
  channelAddressed?: boolean,
  presentation?: PermissionPresentation,
): Promise<FlowWriteDecision> {
  // No live context: a channel-addressed request is a straggler from an ended turn. Only a bare
  // local call with no identity is trusted (custom nodes run unsandboxed); its harness gates it.
  if (!ctx) {
    if (!channelAddressed) return { allowed: true };
    return { allowed: false, message: STALE_FLOW_CONTEXT_MESSAGE };
  }
  if (!presentation && ctx.runtime === 'claude') {
    return { allowed: true };
  }
  // Registration is user-global, so the global nodes root is its permission
  // scope (works without a project); every other Flow mutation remains project-scoped.
  const permissionRoot = presentation ? FRINK_CUSTOM_NODES_DIR : ctx.projectPath;
  if (!permissionRoot) return { allowed: false, message: MISSING_FLOW_PROJECT_MESSAGE };
  const permissionArgs = [
    `mcp__${FRINK_DYNAMIC_CHAT_MCP_KEY}__${toolName}`,
    args,
    permissionRoot,
    ctx.chatId,
    ctx.subChatId,
    `Flow tool: ${toolName}`,
    `flow tool: ${toolName}`,
    ctx.isFlowDrivenTurn,
    ctx.autoReviewTools === true,
    ctx.abortSignal,
  ] as const;
  const result = presentation
    ? await validateWrite(
        `mcp__${FRINK_DYNAMIC_CHAT_MCP_KEY}__${toolName}`,
        args,
        permissionRoot,
        ctx.chatId,
        ctx.subChatId,
        `Flow tool: ${toolName}`,
        `flow tool: ${toolName}`,
        ctx.isFlowDrivenTurn,
        ctx.autoReviewTools === true,
        ctx.abortSignal,
        undefined,
        undefined,
        presentation,
      )
    : await validateWrite(...permissionArgs);
  // A null residual is the turn's Auto consent after explicit rules ran.
  if (result.allowed === null) {
    return ctx.planAutoDenyFloor?.()
      ? { allowed: false, message: 'Provider review was not available' }
      : { allowed: true };
  }
  return result;
}

/**
 * Dispatch a Flow MCP tool after applying availability and permission gates.
 * Returns null for non-Flow tools so the dynamic server can continue its normal dispatch chain.
 */
export function dispatchFlowToolCall(
  options: DispatchFlowToolCallOptions,
): Promise<McpToolResult> | null {
  if (!FLOWS_TOOL_NAMES.has(options.name)) return null;
  return dispatchKnownFlowToolCall(options);
}

function flowUnavailableReason({
  mode,
  flowsEnabled,
}: DispatchFlowToolCallOptions): string | undefined {
  if (!flowsEnabled) {
    return 'Flow tools are not available in this version.';
  }
  return mode === 'plan'
    ? 'Flow tools are not available in plan mode. Put the Flow change in your plan instead; it can run once the plan is approved.'
    : undefined;
}

function staleFlowExecutionResult(
  isExecutionCurrent: DispatchFlowToolCallOptions['isExecutionCurrent'],
): McpToolResult | null {
  return isExecutionCurrent?.() === false ? deniedFlowToolResult(STALE_FLOW_CONTEXT_MESSAGE) : null;
}

async function flowMutationDenial(
  options: DispatchFlowToolCallOptions,
): Promise<McpToolResult | null> {
  if (!FRINK_MUTATING_FLOW_TOOLS.has(options.name)) return null;
  const staleBeforeGate = staleFlowExecutionResult(options.isExecutionCurrent);
  if (staleBeforeGate) return staleBeforeGate;
  if (options.name === REGISTER_NODE_TOOL_NAME) return null;

  const decision = options.providerPreapproved
    ? { allowed: true as const }
    : await gateFlowWrite(
        options.ctx,
        options.name,
        options.args,
        options.validateWrite,
        options.channelAddressed,
      );
  const staleAfterGate = staleFlowExecutionResult(options.isExecutionCurrent);
  if (staleAfterGate) return staleAfterGate;
  return decision.allowed ? null : deniedFlowToolResult(decision.message);
}

function registrationOptions(
  options: DispatchFlowToolCallOptions,
): RegisterNodeOptions | undefined {
  if (options.name !== REGISTER_NODE_TOOL_NAME) return undefined;
  return {
    chatScoped: Boolean(options.ctx),
    signal: options.ctx?.abortSignal,
    isExecutionCurrent: options.isExecutionCurrent,
    authorize: async (presentation: CustomNodeRegistrationPresentation) => {
      const staleBeforeGate = staleFlowExecutionResult(options.isExecutionCurrent);
      if (staleBeforeGate) {
        return { allowed: false, reason: STALE_FLOW_CONTEXT_MESSAGE };
      }
      const decision = await gateFlowWrite(
        options.ctx,
        options.name,
        options.args,
        options.validateWrite,
        options.channelAddressed,
        presentation,
      );
      const staleAfterGate = staleFlowExecutionResult(options.isExecutionCurrent);
      if (staleAfterGate) {
        return { allowed: false, reason: STALE_FLOW_CONTEXT_MESSAGE };
      }
      return decision.allowed ? { allowed: true } : { allowed: false, reason: decision.message };
    },
  };
}

async function dispatchKnownFlowToolCall(
  options: DispatchFlowToolCallOptions,
): Promise<McpToolResult> {
  const unavailableReason = flowUnavailableReason(options);
  if (unavailableReason) return unavailableFlowToolResult(options.name, unavailableReason);

  const mutationDenial = await flowMutationDenial(options);
  if (mutationDenial) return mutationDenial;

  // The gate owns the post-consent liveness re-check: it must happen before a
  // one-call approval is spent, which only the gate can see.
  const invocation = await gateFlowInvocation(
    options.ctx,
    options.name,
    options.args,
    options.requestFlowConsent,
    options.flowStore,
    options.executionId,
    options.isExecutionCurrent,
  );
  if (!invocation.allowed) return deniedFlowToolResult(invocation.message);

  try {
    // Every tool re-checks liveness before running: the consent await above is
    // only one way a turn can die mid-call, and read/edit tools never reach the
    // gate's own check because they return from it early.
    const stale = staleFlowExecutionResult(options.isExecutionCurrent);
    if (stale) return stale;
    const result = await handleFlowsToolCall(
      options.name,
      options.args,
      options.executionId,
      options.projectPath,
      { invocationConsented: invocation.invocationConsented, registerNode: registrationOptions(options) },
    );
    return result ?? toolResult(`Unhandled flow tool: ${options.name}`, true);
  } finally {
    // The batch stays locked against growth right through dispatch, which
    // re-reads the pending stages — and through every early return above, or
    // the hold would be stranded and later add_stage_runs refused forever.
    if (invocation.heldBatchId) releaseBatchConsent(invocation.heldBatchId);
  }
}
