/* eslint-disable max-lines, max-lines-per-function */
/**
 * Runs Claude Code in this process and streams the result to the renderer over IPC. Permission
 * requests round-trip to the renderer (`socket:permission-request`/`-response`) under a timeout.
 */

import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import type { SDKMessage } from '@anthropic-ai/claude-agent-sdk';
import { eq } from 'drizzle-orm';
import { app } from 'electron';
import log from 'electron-log';
import { resolveCodexCliModel } from '../../../shared/lib/codex-cli-models';
import { stripHiddenWakeMarker } from '../../../shared/lib/message-markers/hidden-wake-marker';
import { stripMessageMarkers } from '../../../shared/lib/message-markers/strip-message-markers';
import { isUserAbortErrorMessage } from '../../../shared/lib/user-abort-error';
import {
  extractCanonicalPlanTextForFilter,
  filterCanonicalPlanParts,
} from '../../../shared/plan-parts-filter';
import type { ChatMode } from '../../../shared/types/chat-mode';
import type { ExecutionSettings } from '../../../shared/types/execution';
import type { PermissionPresentation } from '../../../shared/types/permissions';
import { runCodexAgent } from '../agent-runner';
import { createCodexHostPermissionCheck } from '../agent-runner/codex/permissions';
import { buildCodexDynamicChatMcpUrl } from '../agent-runner/codex/spawn-args';
import { buildFrinkPlanChunks } from '../agent-runner/plan-document';
import { createTransformer, getBundledClaudeBinaryPath } from '../claude';
import { clearPendingApprovals } from '../claude/ask-user-question-approval';
import { _resetConfigDirStagingForTests } from '../claude/session-config-dir';
import {
  getClaudeSessionPlansDir,
  isAllowedClaudePlanWritePath,
  isValidSubChatIdForSessionPaths,
  planPathFromExitPlanModeOutput,
  resolveLatestSessionPlanFile,
} from '../claude/session-plan-paths';
import {
  API_ERROR_RETRY_BACKOFF_MS,
  classifyApiErrorText,
  isResumeFailureText,
} from '../claude/stream-classifiers';
import type { MessageMetadata, UIMessageChunk } from '../claude/types';
import {
  getClaudeCodeTokenById,
  getDefaultClaudeCodeToken,
  isResolvedCredential,
} from '../credentials';
import { getDatabase } from '../db';
import { getChatWithProjectAccount } from '../db/repos/chats';
import { getProjectByPath } from '../db/repos/projects';
import { projects as projectsTable } from '../db/schema';
import { stageContinuationResume } from '../flows/admission/terminal-resume/continuation';
import { createRollbackStash } from '../git/stash';
import {
  type FlowConsentDecision,
  type FlowConsentRequest,
  readFlowConsentDecision,
} from '../mcp/flows-tools/gating/flow-invocation-consent';
import { resolveFrinkMcpServers } from '../mcp/runtime';
import type { createClaudeMcpConfigTransport } from '../mcp/runtime/mcp-config-transport';
import { getOperationFromToolName } from '../permissions';
import { isValidPermissionPresentation } from '../permissions/presentation-schema';
import { permissionTimeoutMessage } from '../permissions/prompt-timeout';
import { buildPermissionDecisionInput } from '../permissions/v2';
import { checkPermission } from '../permissions/v2/check';
import { formatDenyReason } from '../permissions/v2/deny-reason-format';
import { persistApprovedRule } from '../permissions/v2/persist-approved-rule';
import {
  disposeCleanStreamEnd,
  disposeFlowStreamError,
  disposeTrailingStreamErrorChunk,
  latchAbortReason,
  resolveErrorPayloadCategory,
  resumeParkedTaskInPlace,
  reviveRestartInterruptedFlow,
  stampedErrorCategory,
} from '../tasks';
import { broadcastWriteToolFileChangedIpc } from '../trpc/routers/claude-file-changed';
import {
  clearLinkedTaskQuietEnd,
  finalizeLinkedTaskSignalFromContext,
  suppressQuietEndForPlanTurn,
} from '../trpc/routers/frink-task-signal-persist';
import { buildClaudeUserMessage } from './claude-input-queue';
import {
  bindTurnAbort,
  type ClaudeSession,
  claimRetainedSession,
  endSession as endClaudeSession,
  getSession as getClaudeSession,
  isPumpAdoptRefusedError,
  releaseLeftoverSession as releaseLeftoverClaudeSession,
  retainSession as retainClaudeSession,
  retireRetainedSession,
  settlePrewarm,
} from './claude-session-registry';
import {
  adoptHeldExecution,
  applyChunkToParts,
  buildPartsFromChunks,
  createClaudeTurnContext,
  createPartsState,
  emitInlinePlanCard,
  matchDeniedToolMessage,
  type PartsState,
  partsSnapshot,
  sessionIdFromFrame,
} from './claude-turn-context';
import { armWakePump, hasWakeHold, releaseWakeHold, takeWakeHold } from './claude-wake-hold';
import {
  type MessagePart,
  onPermissionResponse,
  type PermissionRequestPayload,
  sendErrorDirect,
  sendExecuteCompleteDirect,
  sendPermissionDismiss,
  sendPermissionRequest,
  sendStreamChunkDirect,
  sendStreamSettledDirect,
  sendSubChatModeChange,
  sendWakeHoldChanged,
} from './client';
import { FlowExecutorResourceScope } from './execution';
import { resolveChatWorkspace } from './execution/chat-workspace';
import {
  _resetClaudeDebugSessionsForTests,
  attachTurn,
  buildClaudeSessionSpec,
  computeClaudeSessionKey,
  prepareClaudeSpawn,
  releaseClaudeDebugSession,
  spawnClaudeSession,
} from './execution/claude-session';
import { runTurn as runClaudeTurn } from './execution/claude-session-loop';
import * as flow from './execution/flow-resource-cleanup';
import { deliverProviderConfig } from './execution/provider-delivery';

import {
  applyApprovedPlanContextToPrompt,
  formatPromptWithHistory,
} from './execution/prompt-prefix';
import { logDisposedPendingWork } from './execution/wake-hold-signal';
import type { WakePump } from './execution/wake-pump-types';
import {
  requiresStrictSignalFinalization,
  resolveFlowSignalArming,
  finalizeFlowSignalBeforeSessionDisposition as settleSignal,
} from './flow-signal';
import { buildOperatorReminders, wrapRemindersForPrompt } from './operator-reminders';
import { normalizePlanHaltFinishChunk, shouldDropPostPlanChunkFromHistory } from './plan-mode-halt';
import { acquireRuntimeSlot } from './runtime-gate';
import { reportIfControlChannelClosed } from './stream-closed-sentinel';
import {
  deleteActiveExecution,
  getActiveExecution,
  getExecutionOwner,
  getExecutionStreamEpoch,
  hasActiveExecutions,
  listExecutionsForWebContents,
  setActiveExecution,
} from './streaming/execution-registry';

export {
  _clearActiveExecutionsForTests,
  _getActiveExecutionCountForTests,
  _hasActiveExecutionForTests,
  _registerExecutionForTests,
} from './streaming/execution-registry';

import { extractImagePartsFromMessage, writeImagePartsToTempFiles } from './streaming/image-parts';
import { recordLiveStreamStart } from './streaming/live-stream';
import {
  createPendingPermissionRequestBroker,
  generatePermissionRequestId,
} from './streaming/pending-permission/request';
import {
  adoptedTurnBeforePush,
  armAutoDuringPlan,
  armAutoReview,
  createModeFlip,
  isAutoReviewSupported,
  isPlanAutoDenyFloorActive,
  persistPlanFlipThenNotify,
  resolveAutoReviewModes,
  resolvePermissionMode,
} from './streaming/plan-auto-approve';
import {
  resolvePlanModeChunkSuppression,
  shouldSuppressPlanTextChunk,
} from './streaming/plan-mode-suppression';
import { buildWakeHoldIo } from './streaming/wake-hold-io';

// Provider session cache: subChatId → sessionId for native resume on follow-up messages.
// Capped to prevent unbounded growth over long-running sessions.
const codexSessionCache = new Map<string, string>();
const codexSessionParentChat = new Map<string, string>();
const SESSION_CACHE_MAX = 100;
export const executionAbortSources = new Map<string, string>();

/**
 * Plan-mode pipeline, in order and across files: `buildFrinkPlanChunks` emits the agent's plan
 * file verbatim as the awaiting-approval card, then approval feeds that same text to the next prompt.
 */

/**
 * Tracks the last `mode` the executor ran with for each sub-chat. When the next turn switches
 * out of plan mode while resuming the SDK session, the persisted transcript still contains the
 * SDK's `<system-reminder>Plan mode is active</system-reminder>`. Without an exit reminder the
 * model parrots that stale state. We mirror Claude Code TUI's `plan_mode_exit` attachment by
 * detecting the transition here and delivering a one-shot exit reminder — via the UserPromptSubmit
 * hook on the Claude path, or a prompt prepend on Codex (see `operator-reminders.ts`).
 */
const lastExecutedModeBySubChat = new Map<string, ChatMode>();

/** Test-only: reset module-level executor state so test order doesn't matter. */
export function _resetExecutorStateForTests(): void {
  lastExecutedModeBySubChat.clear();
  _resetConfigDirStagingForTests();
  _resetClaudeDebugSessionsForTests();
}

export { getClaudeSessionPlansDir, isAllowedClaudePlanWritePath };

const CLAUDE_EXECUTION_FAILURE_MESSAGE = 'Claude execution failed. Please try again.';

/** Positive allow-list of "real progress" chunk types for the turn-retry gates: any new SDK
 * lifecycle frame defaults to "no progress" (safe to retry) rather than blocking the heal path. */
const USER_VISIBLE_CHUNK_TYPES = new Set<UIMessageChunk['type']>([
  'text-start',
  'text-delta',
  'text-end',
  'reasoning',
  'reasoning-delta',
  'tool-input-start',
  'tool-input-delta',
  'tool-input-available',
  'tool-output-available',
  'tool-output-error',
  'data-compact',
  'ask-user-question',
  'ask-user-question-result',
  'ask-user-question-timeout',
  'task-signal',
  'error',
  'auth-error',
]);

/** Fire-and-forget persist of the first session id a stream announces — a turn that dies
 * mid-stream never reaches the finish-path persist, and Carry on then has no session to resume. */
function persistEarlySessionId(subChatId: string, sessionId: string): void {
  void import('../db/repos/sub-chats')
    .then(({ updateSubChatSession }) => updateSubChatSession(getDatabase(), subChatId, sessionId))
    .catch((err) => {
      log.warn(`[Socket Executor] early session-id persist failed for ${subChatId}:`, err);
    });
}

const PLAN_MUTATION_TOOLS = new Set(['Write', 'Edit', 'MultiEdit']);

/** Absolute path of a plan-dir `.md` mutation in plan mode, else null. */
function planWritePathFromInput(
  input: unknown,
  projectPath: string,
  subChatId: string,
): string | null {
  const fp = (input as { file_path?: string } | undefined)?.file_path;
  if (typeof fp !== 'string') return null;
  const resolved = path.isAbsolute(fp) ? fp : path.resolve(projectPath, fp);
  if (path.extname(resolved).toLowerCase() !== '.md') return null;
  return isAllowedClaudePlanWritePath(resolved, subChatId) ? resolved : null;
}

/** Clear the cached Codex resume thread for a chat (e.g., when the chat is deleted). */
export function clearCodexSession(chatId: string): void {
  for (const [subChatId, parentChatId] of codexSessionParentChat.entries()) {
    if (parentChatId !== chatId) continue;
    codexSessionParentChat.delete(subChatId);
    codexSessionCache.delete(subChatId);
  }
}

/** Cache a Codex resume thread, evicting the oldest entry if at capacity. LRU: delete-then-set refreshes insertion order. */
function setCodexSession(chatId: string, subChatId: string, sessionId: string): void {
  const sizeBefore = codexSessionCache.size;
  codexSessionCache.delete(subChatId); // Refresh insertion order for LRU
  if (codexSessionCache.size >= SESSION_CACHE_MAX) {
    const oldest = codexSessionCache.keys().next().value;
    if (oldest) {
      codexSessionCache.delete(oldest);
      codexSessionParentChat.delete(oldest);
      log.info(
        `[Socket Executor] Session cache eviction: removed oldest subChatId=${oldest}, inserted subChatId=${subChatId} (sizeBefore=${sizeBefore}, sizeAfterEvict=${codexSessionCache.size}, max=${SESSION_CACHE_MAX})`,
      );
    }
  }
  codexSessionParentChat.set(subChatId, chatId);
  codexSessionCache.set(subChatId, sessionId);
}

// Dynamic import for Claude SDK (ESM module)
let cachedClaudeQuery: typeof import('@anthropic-ai/claude-agent-sdk').query | null = null;
const getClaudeQuery = async () => {
  if (cachedClaudeQuery) {
    return cachedClaudeQuery;
  }
  const sdk = await import('@anthropic-ai/claude-agent-sdk');
  cachedClaudeQuery = sdk.query;
  return cachedClaudeQuery;
};

// Permission Types
// ============================================================================

const permissionRequests = createPendingPermissionRequestBroker({
  getExecutionSignal: (subChatId) => getActiveExecution(subChatId)?.controller.signal,
  onResponse: onPermissionResponse,
  sendDismiss: sendPermissionDismiss,
  sendRequest: sendPermissionRequest,
});
export const drainPendingPermissions = permissionRequests.drain;
export const hasPendingPermissionRequest = permissionRequests.hasPending;

/**
 * Ask the user whether an agent may run a specific flow.
 *
 * Rides the existing permission transport rather than adding a second approval
 * system: same pending map, same socket event, same timeout and dismissal. It
 * runs strictly AFTER the v2 tool decision, so it can only narrow — a deny rule
 * has already blocked the call before this is reached.
 */
export async function requestFlowInvocationConsent(
  request: FlowConsentRequest,
): Promise<FlowConsentDecision> {
  const response = await permissionRequests.request(
    {
      chatId: request.chatId,
      subChatId: request.subChatId,
      requestId: generatePermissionRequestId(),
      type: 'flow_consent',
      path: request.flowId,
      operation: 'flow_consent',
      reason: `Run flow: ${request.flowName}`,
      flowConsent: {
        flowId: request.flowId,
        flowName: request.flowName,
        summary: request.summary,
        allowOnce: request.allowOnce,
      },
    },
    // `null` detaches deliberately; `undefined` would fall back to the live
    // execution and let an ordinary next turn dismiss the card.
    request.abortSignal ?? null,
  );
  return readFlowConsentDecision(response);
}

// ============================================================================
// Permission Scope Resolution
// ============================================================================

/**
 * Validate tool permission via the v2 dispatcher for provider hooks, MCP calls,
 * and Codex host-permission requests.
 */
export async function validateToolPermission(
  toolName: string,
  toolInput: Record<string, unknown>,
  projectPath: string | undefined,
  chatId: string,
  subChatId: string,
  reason?: string,
  permissionPathOverride?: string,
  isFlowDrivenTurn?: boolean,
  deferAskToProvider = false,
  executionSignal?: AbortSignal,
  trustedFrinkOwnedMcp?: boolean,
  mcpIdentity?: { server: string; tool: string },
  presentation?: PermissionPresentation,
): Promise<{ allowed: true } | { allowed: false; message: string } | { allowed: null }> {
  if (!isValidPermissionPresentation(toolName, presentation)) {
    log.error('[executor] Rejected invalid permission presentation', { toolName });
    return { allowed: false, message: 'Invalid permission presentation — tool blocked' };
  }

  if (!projectPath) return { allowed: true };

  // From here every tool call is decided by the permission rules, which prompt when
  // no rule matches and deny outright when the rule store cannot be read.

  // permissionPathOverride is a FILE-level remap (worktree → canonical project
  // FILE path), not a project-root override. PATH tools feed it into the decision
  // input (rule matching against the canonical root); Bash/MCP keep it display-only.
  //
  // This read runs before checkPermission's own rule-store guard, so it carries the
  // same posture: a DB we cannot read denies instead of throwing past the gate.
  let project: Awaited<ReturnType<typeof getProjectByPath>>;
  try {
    project = await getProjectByPath(getDatabase(), projectPath);
  } catch (err) {
    log.error('[executor] Could not read project for permission check — denying', err);
    return { allowed: false, message: formatDenyReason({ kind: 'db:unavailable' }) };
  }

  // Session-dir auto-allow root: THIS chat's CLAUDE_CONFIG_DIR. `check-edit`
  // short-circuits Reads under its allow-listed subtrees (pasted/ + tool-result
  // spills) without prompting. Guarded by the same validator as planDirRoot.
  const sessionDirRoot = isValidSubChatIdForSessionPaths(subChatId)
    ? path.join(app.getPath('userData'), 'claude-sessions', subChatId)
    : undefined;

  // Plan-mode auto-allow: the SDK keeps plans under $CLAUDE_CONFIG_DIR/plans,
  // classified `outside` the project — pass the dir so check-edit short-circuits
  // plan reads/writes instead of prompting each one.
  const planDirRoot = isValidSubChatIdForSessionPaths(subChatId)
    ? getClaudeSessionPlansDir(subChatId)
    : undefined;

  const decisionInput = buildPermissionDecisionInput(toolName, toolInput, permissionPathOverride);
  const result = await checkPermission({
    tool: toolName,
    input: decisionInput,
    projectId: project?.id ?? '',
    projectPath,
    sessionDirRoot,
    planDirRoot,
    trustedFrinkOwnedMcp,
    mcpIdentity,
  });
  if (result.decision === 'allow') return { allowed: true };
  if (result.decision === 'deny') {
    return { allowed: false, message: formatDenyReason(result.reason) };
  }

  // Provider Auto Mode reviews the remaining `ask` bucket, uniformly across every tool
  // class — vendor plugin MCP servers included (auto-mode-tool-approval 2026-09-03 Target).
  if (deferAskToProvider) return { allowed: null };

  // ask → prompt the renderer in-process, persist + (for bash) sync cursor on approval.
  const isBash = toolName === 'Bash';
  const isMcp = toolName.startsWith('mcp__');
  const fallbackPath = isBash
    ? String((toolInput as { command?: string }).command ?? '')
    : String((toolInput as { file_path?: string }).file_path ?? '');
  // Apply worktree FILE-path override here only — for prompt rendering + rule.
  const remappedPath = permissionPathOverride ?? fallbackPath;
  const requestId = generatePermissionRequestId();
  const payload: PermissionRequestPayload = {
    chatId,
    subChatId,
    requestId,
    type: isMcp ? 'mcp_tool' : isBash ? 'bash' : 'file',
    path: remappedPath,
    operation: isMcp
      ? 'mcp_tool'
      : isBash
        ? 'bash'
        : (getOperationFromToolName(toolName) ?? 'read'),
    reason: reason ?? `Tool: ${toolName}`,
    prompt: presentation ? { ...result.prompt, presentation } : result.prompt,
    // projectPath enables the "Allow for project" button in FourButtonView
    // (`hasProject = !!request.projectPath`). Omitted when no project row
    // matches (general chat / virtual folder, where projectPath is the home
    // dir): persistApprovedRule cannot write a project rule there, so the
    // button must render disabled and steer the user to "On this machine".
    ...(project ? { projectPath } : {}),
    ...(project?.name ? { projectName: project.name } : {}),
    // MCP payloads include the tool name so the renderer can render the full identifier.
    ...(isMcp ? { toolName } : {}),
  };

  const promptResult = await permissionRequests.request(payload, executionSignal);

  // Timeout ≠ deny: the user may never have seen the prompt (rule writes gate on duration==='always').
  if (promptResult.timedOut) {
    log.info('[executor] Permission request timed out', { remappedPath, toolName, requestId });
    return { allowed: false, message: permissionTimeoutMessage(remappedPath, isFlowDrivenTurn) };
  }
  if (!promptResult.approved) {
    return { allowed: false, message: 'User denied permission' };
  }

  // The user approved this call; a failed rule write only means the next call prompts
  // again, so it must not turn the approval into a deny or a rejected promise.
  try {
    await persistApprovedRule({
      db: getDatabase(),
      projectPath,
      project: project ?? null,
      promptResult,
      isBash,
      logTag: '[executor]',
    });
  } catch (err) {
    log.warn('[executor] Could not persist approved rule', err);
  }

  return { allowed: true };
}

type ExecuteRequestPayload = {
  chatId: string;
  subChatId: string;
  projectId: string;
  message: string;
  /** Full user message parts (text + file/image) so executor can send images to Claude SDK */
  userMessageParts?: MessagePart[];
  mode: ChatMode;
  /** Conversation history for context */
  history?: Array<{ role: 'user' | 'assistant'; content: string }>;
  /** Execution settings from the requesting machine (validated by socket server) */
  settings?: ExecutionSettings;
  /** Assistant message ID (provided by server for new architecture) */
  assistantMessageId?: string;
  /** Stream ID for resume support */
  streamId?: string;
  /** Persisted sub-chat session ID from server-side storage (fallback when in-memory cache is cold). */
  sessionId?: string;
  /** Continuity lookup status from Frink Cloud ingress. */
  continuity?: {
    status: 'ok' | 'degraded';
    reason?: string;
  };
  /** Approved plan context — injected into execution prompts to survive session loss */
  approvedPlanContext?: import('../../../shared/types/plan').ApprovedPlanContext;
  /** Dynamic-chat navigation session continuity across chat switches. */
  navigationSessionId?: string;
  /**
   * When set, must match `getActiveFlowTaskForChat(chatId)` for this chat to use the flow
   * continuation task id instead of the chat row's possibly stale `task_id`.
   */
  expectedFlowTaskId?: string;
  /**
   * The originating `webContents.id` of the window that sent this turn (for aborting
   * only that window's agents on reload/crash).
   */
  sourceWebContentsId?: number;
};

/**
 * Format conversation history as context for Claude
 */
type TasksRepo = typeof import('../db/repos/tasks');
type SignalTaskRow = Awaited<ReturnType<TasksRepo['getTaskById']>>;

/**
 * Resume reads reuse the disarm-check prefetch when it already holds the target row, so a
 * follow-up turn does a single task read; a different target (the flow-driving task) fetches
 * its own row.
 */
async function getTaskRowForResume(
  db: Parameters<TasksRepo['getTaskById']>[0],
  targetTaskId: string,
  prefetched: SignalTaskRow,
): Promise<SignalTaskRow> {
  if (prefetched?.id === targetTaskId) return prefetched;
  const { getTaskById } = await import('../db/repos/tasks');
  return getTaskById(db, targetTaskId);
}

/**
 * The AI SDK stream reducer rejects a lone `text-delta`, and `text-end` is the checkpoint that
 * carries the `parts` payload to the observer lane — so a notice needs its own start/end wrapper.
 */
function buildNoticeChunks(text: string): UIMessageChunk[] {
  const id = crypto.randomUUID();
  return [
    { type: 'text-start', id },
    { type: 'text-delta', id, delta: text },
    { type: 'text-end', id },
  ];
}

export type PlanFallbackSend = {
  chunk: UIMessageChunk;
  /** Notice chunks are new and must be appended to the history; replayed prose is already in it. */
  isNotice: boolean;
  messageIndex: number;
};

/**
 * Post-stream sends for a plan turn that produced no reviewable card: the prose hidden live by
 * {@link shouldSuppressPlanTextChunk}, then an optional notice explaining the failure.
 *
 * Plan mode hides prose so it cannot compete with the canonical plan card, but the chunks are still
 * collected and persisted — so a turn that ends without a card must replay them or the live stream
 * stays blank while a reload shows the full text.
 *
 * Indices run from `startIndex` and increase strictly across BOTH groups: the renderer keeps a
 * high-water mark per assistant message and drops any payload at or below it, so a notice numbered
 * from the pre-replay history length would be discarded rather than shown.
 */
export function buildPlanFallbackSends(
  collectedChunks: UIMessageChunk[],
  startIndex: number,
  noticeText: string | null,
): PlanFallbackSend[] {
  const replayed = collectedChunks.filter((c) => shouldSuppressPlanTextChunk(c, true));
  const notice = noticeText ? buildNoticeChunks(noticeText) : [];
  return [...replayed, ...notice].map((chunk, i) => ({
    chunk,
    isNotice: i >= replayed.length,
    messageIndex: startIndex + i,
  }));
}

/**
 * Deliver {@link buildPlanFallbackSends} through `send`, appending any notice chunks to
 * `collectedChunks` as they go — the replayed prose is already in there, the notice is new.
 *
 * `parts` is cumulative and unchanged across the replay, so it is folded once and refreshed only
 * when a notice is appended. Returns the next free message index so a caller tracking its own
 * counter (the Claude path) stays in step.
 */
export function emitPlanFallbackSends(
  collectedChunks: UIMessageChunk[],
  startIndex: number,
  noticeText: string | null,
  send: (item: PlanFallbackSend, parts: MessagePart[]) => void,
): { nextIndex: number; replayedCount: number } {
  const sends = buildPlanFallbackSends(collectedChunks, startIndex, noticeText);
  let parts = buildPartsFromChunks(collectedChunks);
  let replayedCount = 0;
  for (const item of sends) {
    if (item.isNotice) {
      collectedChunks.push(item.chunk);
      parts = buildPartsFromChunks(collectedChunks);
    } else {
      replayedCount++;
    }
    send(item, parts);
  }
  return { nextIndex: startIndex + sends.length, replayedCount };
}

export function extractNativePlanPathFromChunks(chunks: UIMessageChunk[]): string | null {
  let nativePlanPath: string | null = null;
  const nonEmptyPath = (value: unknown): string | null =>
    typeof value === 'string' && value.length > 0 ? value : null;
  const extractPath = (value: unknown): string | null => {
    if (!value || typeof value !== 'object') return null;
    const record = value as Record<string, unknown>;
    const filePath = nonEmptyPath(record.filePath);
    if (filePath) return filePath;
    const planPath = nonEmptyPath(record.planPath);
    if (planPath) return planPath;
    const snakeCasePath = nonEmptyPath(record.file_path);
    if (snakeCasePath) return snakeCasePath;
    const plan = record.plan;
    if (!plan || typeof plan !== 'object') return null;
    const planRecord = plan as Record<string, unknown>;
    const nestedFilePath = nonEmptyPath(planRecord.filePath);
    if (nestedFilePath) return nestedFilePath;
    const nestedPlanPath = nonEmptyPath(planRecord.planPath);
    if (nestedPlanPath) return nestedPlanPath;
    const nestedSnakeCasePath = nonEmptyPath(planRecord.plan_path);
    if (nestedSnakeCasePath) return nestedSnakeCasePath;
    return null;
  };

  for (const chunk of chunks) {
    if (chunk.type !== 'tool-input-available' || !('toolName' in chunk)) {
      continue;
    }

    const input = chunk.input as Record<string, unknown> | undefined;
    if (chunk.toolName === 'PlanWrite') {
      const pathFromInput = extractPath(input);
      if (pathFromInput) nativePlanPath = pathFromInput;
    }
  }

  for (const chunk of chunks) {
    if (chunk.type !== 'tool-output-available') continue;
    const relatedInput = chunks.find(
      (candidate) =>
        candidate.type === 'tool-input-available' &&
        candidate.toolCallId === chunk.toolCallId &&
        candidate.toolName === 'PlanWrite',
    );
    if (!relatedInput) continue;
    const pathFromOutput = extractPath(chunk.output);
    if (!nativePlanPath && pathFromOutput) nativePlanPath = pathFromOutput;
  }
  return nativePlanPath;
}

/**
 * Persisted message parts for plan mode: match streamed IPC (dedupe plan markdown + drop native PlanWrite rows).
 */
function buildFinalPartsForPersist(
  mode: 'agent' | 'plan' | 'debug',
  collectedChunks: UIMessageChunk[],
): MessagePart[] {
  const raw = buildPartsFromChunks(collectedChunks);
  if (mode !== 'plan') return raw;
  const planText = extractCanonicalPlanTextForFilter(raw);
  return filterCanonicalPlanParts(raw, planText ?? undefined) as MessagePart[];
}

/**
 * Handle incoming execution request from another machine.
 * Verifies we have the project locally, then executes Claude and streams results back.
 * For general chats (empty projectId), executes in the home directory.
 */
/** Image extracted from user message parts for Claude SDK */
export async function handleRemoteExecute(payload: ExecuteRequestPayload): Promise<void> {
  const {
    chatId,
    subChatId,
    projectId,
    message: rawMessage,
    mode,
    history,
    settings,
    assistantMessageId,
    userMessageParts,
    sessionId: persistedSessionId,
    continuity,
    approvedPlanContext,
    navigationSessionId,
    expectedFlowTaskId,
    sourceWebContentsId: payloadSourceWebContentsId,
  } = payload;

  // Markers persist for the renderer (hide the bubble, or draw it as a card) — never for the model.
  const message = stripMessageMarkers(stripHiddenWakeMarker(rawMessage));

  if (continuity?.status === 'degraded') {
    log.warn(
      `[Socket Executor] Continuity lookup degraded for ${subChatId}: ${continuity.reason ?? 'unknown reason'}`,
    );
  }
  // Handle general chats (no project context)
  const isGeneralChat = !projectId;
  const msgId = assistantMessageId || crypto.randomUUID();

  // Fresh SDK-closure and terminal-error state lives in ClaudeTurnContext (claude-turn-context.ts).
  const turn = createClaudeTurnContext();
  turn.msgId = msgId;
  let executionContextId: string | undefined;
  /** The registry session THIS execute created, claimed or adopted (null once left idle). Every
   * disposal below is identity-guarded on it: a superseding duplicate-request registers a NEW
   * session under the same subChatId, and an unguarded by-key endSession from the loser's
   * teardown would destroy the winner's live session (same ABA as claude-wake-hold's guards). */
  let ownedClaudeSession: ClaudeSession | null = null;
  let claudeSessionRetained = false; // left idle in the registry, so this execute has no wake hold
  let taskIdForExecution: string | null = null;
  /** Provider-neutral task-signal target retained through outer teardown. */
  let linkedTaskSignalTaskId: string | null = null;
  /** True once the execution context has an MCP endpoint capable of recording a task signal. */
  let shouldFinalizeLinkedTaskSignal = false;
  /** Set only at the provider seam, after preflight and immediately before execution starts. */
  let linkedTaskPreparedForExecution = false;
  /** Claude can persist eagerly in canUseTool; Codex persists from context at teardown. */
  let hasExplicitTaskSignal = false;
  /** Agent signal target: current flow task, falling back to the chat's pinned task. */
  let effectiveSignalTaskId: string | null = null;
  /** When we applied the in-memory flow continuation override; used for compare-and-clear in `finally`. */
  let flowContinuationClearId: string | null = null;
  const flowResources = new FlowExecutorResourceScope();
  turn.waitForExecutionSettlement = flowResources.waitUntilSettled;
  /** Retained for provider-neutral teardown duties outside the try block. */
  let executionAbortController: AbortController | null = null;
  /** This run's own abort reason. Never read the sub-chat-keyed map directly — see latchAbortReason. */
  let abortReason: () => string | undefined = () => undefined;
  let isFlowExecutionTurn = false;
  let strictSignalFinalization = false;
  let signalFailure: { cause: unknown } | null = null;
  let executionFailed = false;
  /** Once the Agent SDK query starts, its errors are opaque at Frink's sink boundary. */
  let claudeQueryStarted = false;
  /** Immutable identity minted for this invocation. Never re-read the sub-chat-keyed registry:
   * a superseding duplicate may replace that record before this run's late emitter/teardown fires. */
  let executionStreamEpoch: string | undefined;
  const withExecutionStreamEpoch = <T extends { streamEpoch?: string }>(payload: T): T =>
    executionStreamEpoch ? { ...payload, streamEpoch: executionStreamEpoch } : payload;
  const sendRunStreamChunkDirect = (payload: Parameters<typeof sendStreamChunkDirect>[0]): void =>
    sendStreamChunkDirect(withExecutionStreamEpoch(payload));
  const sendRunExecuteCompleteDirect = (
    payload: Parameters<typeof sendExecuteCompleteDirect>[0],
  ): Promise<void> => sendExecuteCompleteDirect(withExecutionStreamEpoch(payload));
  const sendRunErrorDirect = (
    payload: Parameters<typeof sendErrorDirect>[0],
    finalization?: Parameters<typeof sendErrorDirect>[1],
  ): void | Promise<void> => {
    const runPayload = payload.assistantMessageId ? withExecutionStreamEpoch(payload) : payload;
    return finalization
      ? sendErrorDirect(runPayload, withExecutionStreamEpoch(finalization))
      : sendErrorDirect(runPayload);
  };
  const sendRunStreamSettledDirect = (
    payload: Parameters<typeof sendStreamSettledDirect>[0],
  ): void => sendStreamSettledDirect(withExecutionStreamEpoch(payload));
  let linkedTaskSignalFinalization: Promise<void> | null = null;
  let claudeMcpConfig: ReturnType<typeof createClaudeMcpConfigTransport> = null;
  const finalizeLinkedTaskSignal = async (): Promise<void> => {
    if (
      !linkedTaskPreparedForExecution ||
      !linkedTaskSignalTaskId ||
      !executionContextId ||
      hasExplicitTaskSignal
    ) {
      return;
    }
    linkedTaskSignalFinalization ??= finalizeLinkedTaskSignalFromContext({
      taskIdForExecution: linkedTaskSignalTaskId,
      executionContextId,
      shouldMarkQuietEnd: shouldFinalizeLinkedTaskSignal,
      isAborted: () => executionAbortController?.signal.aborted ?? true,
      subChatId,
      planSubmitted: ownedClaudeSession?.currentTurn?.planSubmitted ?? false,
      planTerminal: suppressQuietEndForPlanTurn(
        ownedClaudeSession?.currentTurn,
        mode,
        ownedClaudeSession?.stopHook?.lastPendingWork ?? null,
      ),
      throwOnError: strictSignalFinalization,
    });
    await linkedTaskSignalFinalization;
  };
  try {
    /** Bind to a local BrowserWindow only when the request carried an originating window. */
    const localRendererWebContentsId: number | undefined =
      payloadSourceWebContentsId !== undefined && Number.isFinite(payloadSourceWebContentsId)
        ? payloadSourceWebContentsId
        : undefined;

    // A project chat's row must exist; general chats have none (single-user local SQLite).
    let project: { id: string; name: string; path: string } | null = null;
    if (!isGeneralChat) {
      try {
        const [row] = await getDatabase()
          .select({ id: projectsTable.id, name: projectsTable.name, path: projectsTable.path })
          .from(projectsTable)
          .where(eq(projectsTable.id, projectId))
          .limit(1);
        project = row ?? null;
      } catch (err) {
        log.error(`[Socket Executor] Failed to look up project ${projectId}:`, err);
        sendRunErrorDirect({
          chatId,
          subChatId,
          assistantMessageId: msgId,
          error: `Could not look up project: ${err instanceof Error ? err.message : String(err)}`,
        });
        return;
      }

      if (!project) {
        sendRunErrorDirect({
          chatId,
          subChatId,
          assistantMessageId: msgId,
          error: `Project ${projectId} not found`,
        });
        return;
      }
    }

    log.info(`[Socket Executor] Starting execution for project ${projectId || '(general chat)'}`);

    // 2. Set up abort controller for stop signals (abort any existing execution for this subChat first)
    const existing = getActiveExecution(subChatId);
    if (existing) {
      executionAbortSources.set(subChatId, 'duplicate-request');
      log.warn(
        `[Socket Executor] Aborting previous execution for ${subChatId} (duplicate request)`,
      );
      clearPendingApprovals('Superseded by new execution.', subChatId);
      existing.controller.abort();
    }
    const abortController = new AbortController();
    executionAbortController = abortController;
    // Drop a dead run's leftover reason (its `finally` may not have run; it already latched its
    // own) — else the latch below mis-files this run's abort as that one's teardown.
    executionAbortSources.delete(subChatId);
    abortReason = latchAbortReason(abortController.signal, executionAbortSources, subChatId);
    setActiveExecution(subChatId, abortController, localRendererWebContentsId, {
      chatId,
      assistantMessageId: msgId,
    });
    executionStreamEpoch = getExecutionStreamEpoch(subChatId, msgId);
    if (!executionStreamEpoch) throw new Error('Active execution was registered without an epoch');
    recordLiveStreamStart({
      chatId,
      subChatId,
      assistantMessageId: msgId,
      streamEpoch: executionStreamEpoch,
    });

    // 3. Resolve chat metadata first, then build multi-project context with explicit current context.
    const chatAccountResult = chatId
      ? await getChatWithProjectAccount(getDatabase(), chatId).catch(() => null)
      : null;
    const workspace = await resolveChatWorkspace(project, chatAccountResult?.chat, mode);
    const { projectPath, permissionProjectPath } = workspace;
    // 4. Resolve credential from account result
    const { resolveFlowContinuationExecutionTask } = await import('../task-executor');
    const resolvedContinuation = resolveFlowContinuationExecutionTask({
      chatId: chatId ?? undefined,
      chatRowTaskId: chatAccountResult?.chat?.taskId ?? null,
      expectedFlowTaskId,
    });
    taskIdForExecution = resolvedContinuation.taskIdForExecution;
    flowContinuationClearId = resolvedContinuation.flowContinuationClearId;
    // Flow-driven execution suppresses in-chat plan Approve; the run panel is the sole surface.
    const armed = await resolveFlowSignalArming(subChatId, taskIdForExecution);
    const {
      isFlowDrivenExecution,
      flowPlanAutoApprove,
      taskSignalDisarmed,
      restartInterruptedFlowRunId,
    } = armed;
    isFlowExecutionTurn = isFlowDrivenExecution || restartInterruptedFlowRunId !== null;
    strictSignalFinalization = requiresStrictSignalFinalization(armed);
    const prefetchedSignalTask = armed.prefetchedSignalTask;
    effectiveSignalTaskId = armed.effectiveSignalTaskId;
    // Flow Briefing rides the SESSION system-prompt channel (injected once, prompt-cached, like
    // CLAUDE.md), not the per-turn message. Resolved from the newest flow task on this sub-chat (any
    // status) so it persists for the chat's life — including a manual follow-up typed after the flow
    // completes. Kept in its OWN try so a briefing-read fault never disarms the flow-signal logic
    // above; stays '' for interactive (non-flow) chats and on any fault (fail-open).
    let sessionFlowBriefing = '';
    if (subChatId) {
      try {
        const { getDatabase: getDbForBriefing } = await import('../db');
        const { getFlowBriefingForSubChat } = await import('../db/repos/tasks');
        sessionFlowBriefing = await getFlowBriefingForSubChat(getDbForBriefing(), subChatId);
      } catch (err) {
        log.warn('[Socket Executor] flow briefing lookup failed; omitting from system prompt', {
          subChatId,
          error: err instanceof Error ? err.message : String(err),
        });
      }
    }
    // Agent task signals persist to the flow-driving task (above), falling back to the pinned task
    // for interactive turns. Used by the integration gate + every (record/persist)LinkedTaskSignal.
    // Disarmed (null) when the only task link is terminal-final — the DB fault path above keeps
    // today's armed behavior (fail-open).
    const signalTaskId = taskSignalDisarmed ? null : (effectiveSignalTaskId ?? taskIdForExecution);
    linkedTaskSignalTaskId = signalTaskId;
    // Auto-approve plan node: once the plan card is emitted the agent implements in-turn, so flip the
    // sub-chat out of plan mode (input-bar label reflects the real execution state). One-time + called
    // from every card-emit path (inline ExitPlanMode + post-stream fallbacks) so the label is correct
    // regardless of which path produced the card.
    const flipToAgentModeForAutoApprove = createModeFlip(subChatId, flowPlanAutoApprove, () =>
      sendSubChatModeChange({ chatId, subChatId, mode: 'agent' }),
    );
    const resumeTaskOnFollowUpMessage = async (forceFreshRead = false) => {
      // Resume the FLOW-DRIVING task (signalTaskId), NOT the chat's pinned/first task. For a flow the
      // pinned task is an already-completed upstream node; the parked task that the agent's next
      // signal lands on is the driving one. Flipping it → running is what lets that signal be
      // accepted (canApplyTaskSignalForStatus requires 'running'), not silently dropped. Interactive
      // (non-flow) turns have signalTaskId === taskIdForExecution, so behaviour is unchanged.
      const resumeTargetTaskId = signalTaskId;
      if (!resumeTargetTaskId) return;
      const { getDatabase } = await import('../db');
      const db = getDatabase();
      // Restart-recovery: the driving task is a `cancelled` row whose run was interrupted by a
      // restart/reload. THIS follow-up turn is the continuation, so revive it in place (helper keeps
      // the closure's complexity in check; see reviveRestartInterruptedFlow).
      if (restartInterruptedFlowRunId) {
        await reviveRestartInterruptedFlow(
          resumeTargetTaskId,
          restartInterruptedFlowRunId,
          subChatId,
        );
        return;
      }
      // The race-recovery retry must NOT trust the turn-start prefetch: the sweep's park happened
      // after that snapshot, so a cached 'running' row would make the retry a silent no-op.
      const latestTask = await getTaskRowForResume(
        db,
        resumeTargetTaskId,
        forceFreshRead ? null : prefetchedSignalTask,
      );
      if (!latestTask) return;
      await resumeParkedTaskInPlace(latestTask, 'follow_up_message', subChatId);
    };
    const prepareLinkedTaskForExecution = async (): Promise<void> => {
      if (linkedTaskPreparedForExecution) return;
      await resumeTaskOnFollowUpMessage();
      // 'parked' = the quiet-idle sweep won the race with this turn's start — resume once more.
      if (signalTaskId && (await clearLinkedTaskQuietEnd(signalTaskId)) === 'parked') {
        await resumeTaskOnFollowUpMessage(true);
      }
      linkedTaskPreparedForExecution = true;
    };
    await flowResources.admit(armed, flowContinuationClearId, abortController, chatId);
    let storedCredential = await getDefaultClaudeCodeToken();

    const overrideAccount = chatAccountResult?.account;
    // Labels are nullable and non-unique; used for display only, never to resolve.
    const overrideLabel = overrideAccount?.label ?? 'Unnamed account';
    log.info(`[Socket Executor] Chat account lookup result:`, {
      chatId,
      accountLabel: overrideAccount?.label,
    });
    if (overrideAccount) {
      let projectCredential = await getClaudeCodeTokenById(overrideAccount.id);
      log.info(`[Socket Executor] Project credential lookup:`, {
        accountLabel: overrideAccount.label,
        hasToken: !!projectCredential.token,
        credentialLabel: projectCredential.label,
        credentialType: projectCredential.type,
      });
      // Codex is token-null passthrough (machine-local) so it resolves without a token;
      // the spawn-time detectCodexAccount() probe below is its real auth gate. Other
      // providers need a resolved token.
      if (isResolvedCredential(projectCredential)) {
        storedCredential = projectCredential;
      } else {
        // The account has to be connected here; there is no remote copy to recover it from.
        log.error(
          `[Socket Executor] Project account "${overrideLabel}" not authenticated on this machine`,
        );
        sendRunErrorDirect({
          chatId,
          subChatId,
          assistantMessageId: msgId,
          error: `Account "${overrideLabel}" is not authenticated on this machine. Please authenticate in Settings → AI providers.`,
        });
        return;
      }
    } else {
      log.info(`[Socket Executor] No project-specific account configured, using default`);
    }

    // Log execution details
    log.info(
      `[Socket Executor] Request: model=${settings?.model ?? 'default (sonnet)'}, thinking=${settings?.maxThinkingTokens ?? 'off'}, betas=${settings?.betas?.join(',') || 'none'}, tasks=${settings?.enableTasks ?? 'default'}`,
    );
    log.info(
      `[Socket Executor] Auth: type=${storedCredential?.isApiKey ? 'API Key' : 'OAuth'}, account=${storedCredential?.label ?? 'unknown'}, provider=${storedCredential?.type ?? 'unknown'}`,
    );

    // Passthrough (claude + codex) is token-null by design; shared with task-executor's gate.
    if (!isResolvedCredential(storedCredential)) {
      log.error('[Socket Executor] No Claude Code credentials found');
      sendRunErrorDirect({
        chatId,
        subChatId,
        assistantMessageId: msgId,
        error:
          'No Claude Code credentials configured. Please add your Claude Code account in Settings → AI providers.',
      });
      return;
    }

    // Codex is machine-local passthrough: confirm the `codex` binary is actually
    // logged in on THIS machine before doing any work. Catches a cross-machine
    // project account and a login that lapsed after connect — a clean message
    // instead of a cryptic deep app-server spawn failure. Runs before the runtime
    // slot so an unauthenticated codex never holds one.
    if (storedCredential.type === 'codex') {
      const { detectCodexAccount } = await import('../credentials/detect-codex');
      if (!detectCodexAccount().available) {
        log.error('[Socket Executor] Codex is not authenticated on this machine');
        sendRunErrorDirect({
          chatId,
          subChatId,
          assistantMessageId: msgId,
          error:
            'Codex isn’t authenticated on this machine. Run `codex login` (or use this project on a machine where Codex is signed in).',
        });
        return;
      }
    }

    const agentRuntime: 'codex' | 'claude' = storedCredential.type === 'codex' ? 'codex' : 'claude';
    const autoReviewRequested = settings?.autoReviewTools === true;
    const autoReviewSupported = isAutoReviewSupported(settings, storedCredential.type);
    const { nativeAutoReview, codexAutoReview, planAutoReview, autoReviewArmable } =
      resolveAutoReviewModes(autoReviewSupported, agentRuntime, mode);
    // Plan turns start the abstain flag OFF; armAutoDuringPlan sets it after the flip to 'plan'.
    turn.autoReviewTools = agentRuntime === 'claude' && nativeAutoReview;
    // On the turn, not closed over: canUseTool belongs to the session it was spawned for, so an
    // adopted cross-mode turn's deny-floor must read the ACTIVE turn's eligibility, not a constant.
    turn.planAutoReview = planAutoReview;
    if (autoReviewRequested && !nativeAutoReview && !planAutoReview && !codexAutoReview) {
      log.warn(
        `[Socket Executor] Auto Mode requested but unavailable for provider=${storedCredential.type}, model=${String(settings?.model ?? 'default')}, mode=${mode}`,
      );
    }
    // A provider switch ends the chat's live Claude wake hold or idle session first: only a Claude
    // turn can adopt it, and a pumping hold would stream wake bursts into the other turn.
    if (agentRuntime !== 'claude') {
      releaseWakeHold(subChatId, `provider-switch:${agentRuntime}`);
      retireRetainedSession(subChatId, 'provider-switch');
    }
    await flowResources.acquireRuntimeSlot(agentRuntime, mode, subChatId, () =>
      acquireRuntimeSlot(agentRuntime),
    );
    if (abortController.signal.aborted) {
      sendRunStreamSettledDirect({ chatId, subChatId, assistantMessageId: msgId });
      return;
    }
    // Set execution context only after credential validation succeeds.
    // This avoids exposing stale context to concurrent tool calls during early-failure paths.
    const chatServer = await import('../mcp/dynamic-chat-server');
    executionContextId =
      chatId && subChatId
        ? chatServer.setCurrentExecutionChat(
            chatId,
            subChatId,
            projectPath,
            mode,
            undefined,
            navigationSessionId,
            // Refuses a frink_task_signal call when no live task expects one; the tool list itself
            // comes from the URL toolset. Re-calls on the same executionId inherit it.
            Boolean(signalTaskId),
            agentRuntime,
            // Auto consent snapshot for gateFlowWrite — re-asserted here on EVERY send (never
            // inherited across sends), so toggling Auto off disarms the next turn.
            agentRuntime === 'codex' ? codexAutoReview : turn.autoReviewTools,
            isFlowExecutionTurn,
            abortController.signal,
            () => agentRuntime === 'claude' && isPlanAutoDenyFloorActive(turn),
          )
        : undefined;
    // Native Codex/Claude resumes already own the transcript; shipping Frink history duplicates it.
    const codexResumeThreadId =
      agentRuntime === 'codex'
        ? (codexSessionCache.get(subChatId) ?? persistedSessionId ?? undefined)
        : undefined;
    const willReplayHistoryViaResume =
      agentRuntime === 'codex'
        ? Boolean(codexResumeThreadId)
        : agentRuntime === 'claude' && Boolean(persistedSessionId);
    const hasResumeSession = Boolean(codexResumeThreadId ?? persistedSessionId);
    let fullPrompt = willReplayHistoryViaResume
      ? message
      : formatPromptWithHistory(message, history);
    // Operator reminders to inject this turn (mode-exit transitions + the disarmed task-signal notice).
    // Gating + copy live in ./operator-reminders. Claude delivers them as an in-conversation system
    // prompt via the UserPromptSubmit hook (the session's callbacks); Codex has no such channel
    // yet (sc-996) and gets a <system-reminder> prompt prepend.
    const { reminders: pendingReminders, isExitingDebugMode } = buildOperatorReminders({
      mode,
      previousMode: lastExecutedModeBySubChat.get(subChatId),
      hasResumeSession,
      taskSignalDisarmed,
      agentSawPriorTurns: willReplayHistoryViaResume || (history?.length ?? 0) > 0,
    });
    // Debug-exit cleanup: drop the ingest debug session. Side effect kept here, out of the pure util.
    if (isExitingDebugMode) releaseClaudeDebugSession(subChatId);
    if (pendingReminders.length > 0) {
      if (agentRuntime !== 'claude') {
        fullPrompt = `${wrapRemindersForPrompt(pendingReminders)}\n\n${fullPrompt}`;
      }
      log.info(
        `[Socket Executor] ${pendingReminders.length} operator reminder(s) for ${subChatId} via ${
          agentRuntime === 'claude' ? 'UserPromptSubmit hook' : 'prompt prepend'
        }`,
      );
    }
    // Inject approved plan context at the start of execution turns.
    // This is the compression-safe handoff — the agent always knows what plan was approved
    // even when provider session memory is stale or missing.
    if (approvedPlanContext?.planText) {
      fullPrompt = applyApprovedPlanContextToPrompt(fullPrompt, approvedPlanContext);
      log.info(
        `[Socket Executor] Injected approved plan context for ${subChatId} (${approvedPlanContext.planText.length} chars)`,
      );
    }

    let codexFreshThreadFallbackPrompt =
      agentRuntime === 'codex' && codexResumeThreadId
        ? fullPrompt.endsWith(message)
          ? `${fullPrompt.slice(0, fullPrompt.length - message.length)}${formatPromptWithHistory(message, history)}`
          : fullPrompt
        : undefined;
    if (sessionFlowBriefing && agentRuntime !== 'claude' && !hasResumeSession) {
      fullPrompt = `## Flow Briefing\n\n${sessionFlowBriefing}\n\n---\n\n${fullPrompt}`;
    }
    if (sessionFlowBriefing && codexFreshThreadFallbackPrompt !== undefined) {
      codexFreshThreadFallbackPrompt = `## Flow Briefing\n\n${sessionFlowBriefing}\n\n---\n\n${codexFreshThreadFallbackPrompt}`;
    }
    const { dynamicChatMcpUrl } = workspace;
    // Independent of the dynamic-chat MCP mount (gated on 2+ projects): an unsignalled linked task
    // needs the quiet-end marker regardless, or the flows sweep never parks it (stuck `running`).
    shouldFinalizeLinkedTaskSignal = Boolean(signalTaskId && executionContextId);
    // Extract image parts from user message so Claude SDK can receive them (Neon path supports images)
    const imageParts = extractImagePartsFromMessage(userMessageParts);
    const sendExecuteCompleteDeferred = (
      payload: Parameters<typeof sendExecuteCompleteDirect>[0],
    ): void => {
      const deferredPayload = {
        ...payload,
        streamEpoch: executionStreamEpoch,
        observerOwned: getExecutionOwner(subChatId) === undefined,
      };
      setImmediate(() => {
        sendRunExecuteCompleteDirect(deferredPayload);
      });
    };
    /** Codex reports CLI+API failures as a trailing `error` chunk instead of throwing. */
    const disposeTrailingProviderError = (chunks: ReadonlyArray<UIMessageChunk>): Promise<void> =>
      disposeTrailingStreamErrorChunk(subChatId, chunks, abortReason());

    // Codex uses a persistent app-server; Manual and Auto retain the write sandbox.
    if (storedCredential.type === 'codex') {
      await deliverProviderConfig(project, projectPath, 'codex');
      await flowResources.prepareProviderExecution(prepareLinkedTaskForExecution);

      let codexFullPrompt = fullPrompt;
      let codexFreshFallbackPrompt = codexFreshThreadFallbackPrompt;
      if (imageParts.length > 0) {
        const imagePaths = writeImagePartsToTempFiles(imageParts).join('\n');
        const imagePromptPrefix = `The user attached the following image(s). View them at these file paths:\n${imagePaths}\n\n`;
        codexFullPrompt = `${imagePromptPrefix}${codexFullPrompt}`;
        if (codexFreshFallbackPrompt !== undefined) {
          codexFreshFallbackPrompt = `${imagePromptPrefix}${codexFreshFallbackPrompt}`;
        }
      }

      const codexDynamicChatMcpUrl = buildCodexDynamicChatMcpUrl({
        baseUrl: dynamicChatMcpUrl,
        subChatId,
        projectPath,
        mode,
        hasSignalTask: Boolean(signalTaskId),
      });
      const frinkMcpInjected = codexDynamicChatMcpUrl !== null;
      const codexMcpRuntime = await resolveFrinkMcpServers({
        projectId,
        projectPath,
        dynamicChatMcpUrl: codexDynamicChatMcpUrl,
      });

      const checkApproval = createCodexHostPermissionCheck({
        chatId,
        subChatId,
        projectPath,
        permissionProjectPath,
        isFlowExecutionTurn,
        frinkMcpInjected,
        autoReview: codexAutoReview,
        executionSignal: abortController.signal,
        validateToolPermission,
      });

      const codexPartsState = createPartsState();
      const codexChunks: UIMessageChunk[] = [];
      let codexIdx = 0;
      let codexMetadata: MessageMetadata = {}; // session id + latest token usage, persisted below
      // settings.model carries the RAW codex picker id (e.g. codex-gpt-5.3-codex-high); the executor
      // is the single conversion boundary that splits it into the slug, effort and service tier the
      // v2 app-server wants.
      const codexModel = resolveCodexCliModel(settings?.model, settings?.codexFastMode);
      const codexId = storedCredential.label ?? 'codex-default';
      const unbindCodex = flowResources.bindCodex(abortController, projectPath, codexId, subChatId);
      try {
        flowResources.assertLive(abortController.signal, 'Codex');
        for await (const chunk of runCodexAgent({
          prompt: codexFullPrompt,
          freshThreadFallbackPrompt: codexFreshFallbackPrompt,
          cwd: projectPath,
          // Registry key component: stable per-account. label is the account identity
          // (CredentialResult has no id); falls back to a constant so a label-less default still
          // shares one warm server rather than spawning per turn.
          credentialId: codexId,
          // Registry key component: the dynamic Frink MCP URL is sub-chat-scoped, so a server
          // spawned for one sub-chat must never be handed to another (its tools would resolve into
          // the wrong chat's execution context).
          sessionKey: subChatId,
          env: process.env as Record<string, string>,
          abortController,
          mode,
          model: codexModel.model,
          effort: codexModel.effort,
          serviceTier: codexModel.serviceTier,
          resumeThreadId: codexResumeThreadId,
          canonicalMcpServers: codexMcpRuntime.servers,
          canonicalMcpEnvByServer: codexMcpRuntime.envByServer,
          taskSignalEnabled: Boolean(signalTaskId),
          hasOpenPermission: () => hasPendingPermissionRequest(subChatId),
          checkApproval,
          autoReview: codexAutoReview,
        })) {
          if (abortController.signal.aborted) break;
          if ('messageMetadata' in chunk)
            codexMetadata = { ...codexMetadata, ...chunk.messageMetadata };
          codexChunks.push(chunk);
          applyChunkToParts(codexPartsState, chunk);
          sendRunStreamChunkDirect({
            chatId,
            subChatId,
            assistantMessageId: msgId,
            chunk,
            parts: partsSnapshot(codexPartsState),
            messageIndex: codexIdx++,
          });
        }
        flowResources.assertLive(abortController.signal, 'Codex');

        await disposeTrailingProviderError(codexChunks);

        const codexSessionId = codexMetadata.sessionId;
        if (codexSessionId) setCodexSession(chatId, subChatId, codexSessionId);
        sendExecuteCompleteDeferred({
          chatId,
          subChatId,
          assistantMessageId: msgId,
          sessionId: codexSessionId,
          metadata: codexMetadata,
          finalParts: buildFinalPartsForPersist(mode, codexChunks),
        });
        log.info(`[Socket Executor] Codex execution complete for ${subChatId}`);
      } catch (err) {
        if (abortController.signal.aborted) throw err;
        log.error('[Socket Executor] Codex execution failed', err);
        // This catch swallows the throw, so the outer catch's disposition never runs — without
        // parking here a thrown Codex failure strands its flow task `running`.
        await disposeFlowStreamError(
          subChatId,
          err instanceof Error ? err.message : String(err),
          abortReason(),
        );
        sendRunErrorDirect({
          chatId,
          subChatId,
          assistantMessageId: msgId,
          error: err instanceof Error ? err.message : String(err),
        });
      } finally {
        unbindCodex();
      }
      if (!flowResources.admitted) {
        signalFailure = await settleSignal(finalizeLinkedTaskSignal());
      }
      return;
    }

    // Claude Code path: build env and continue with SDK
    if (!isValidSubChatIdForSessionPaths(subChatId)) {
      log.error(`[Socket Executor] Invalid subChatId for Claude session paths: ${subChatId}`);
      sendRunErrorDirect({
        chatId,
        subChatId,
        assistantMessageId: msgId,
        error: 'Invalid chat session id. Please restart the chat or try again.',
      });
      return;
    }

    const claudeQuery = await getClaudeQuery();
    const claudeBinaryPath = getBundledClaudeBinaryPath();

    // In dev: verify binary exists so we can fail with a clear error
    if (!app.isPackaged && !fs.existsSync(claudeBinaryPath)) {
      log.error(
        `[Socket Executor] Claude binary not found at ${claudeBinaryPath}. Run the download script if needed.`,
      );
      sendRunErrorDirect({
        chatId,
        subChatId,
        assistantMessageId: msgId,
        error: `Claude binary not found at ${claudeBinaryPath}. Check Settings or run the binary download script.`,
      });
      return;
    }

    await flowResources.prepareProviderExecution(prepareLinkedTaskForExecution);

    const claudeSpec = await buildClaudeSessionSpec({
      chatId,
      subChatId,
      project,
      projectId,
      projectPath,
      permissionProjectPath,
      mode,
      settings,
      storedCredential,
      nativeAutoReview,
      planAutoReview,
      persistedSessionId,
      claudeBinaryPath,
      dynamicChatMcpUrl,
      multiProjectPrefix: workspace.multiProjectPrefix,
      sessionFlowBriefing,
      signalTaskId,
      isFlowExecutionTurn,
      flowPlanAutoApprove,
      validateToolPermission,
      abortSources: executionAbortSources,
    });
    const sdkOptions = claudeSpec.options;
    claudeMcpConfig = claudeSpec.mcpConfig;

    // Track tool use IDs the session's hooks deny so we can emit synthetic tool-output-error after
    // the stream (SDK does not emit tool_result for denied tools, which would show "Task interrupted").
    const deniedToolIdsWithMessages = new Map<string, string>();
    turn.deniedToolIdsWithMessages = deniedToolIdsWithMessages;

    // Plan submitted outside auto: ExitPlanMode lifts the SDK's plan restrictions, so the session's
    // callbacks deny every tool until the halt interrupt lands.
    // Also read by the stream-error path: an interrupt surfacing as an iterator throw is the
    // normal halt, not an error.
    let planSubmissionHalt = false;
    turn.planSubmissionHalt = () => planSubmissionHalt;
    // A wake burst raises this through the arming turn when it surfaces a plan card of its own.
    turn.setPlanSubmissionHalt = () => {
      planSubmissionHalt = true;
    };

    // Plan mode finishes through ExitPlanMode alone: terminal signals stay refused until the plan
    // is submitted (`awaiting_input` still parks). On the turn: the session's callbacks read it.
    turn.planTerminalsLocked = mode === 'plan';

    turn.execution = {
      executionContextId,
      signalTaskId,
      taskSignalReady: claudeSpec.taskSignalReady,
      isFlowTurn: isFlowExecutionTurn,
      isPlanMode: mode === 'plan',
      flowPlanAutoApprove,
      abortController,
      sendChunk: sendRunStreamChunkDirect,
    };
    const ownExecution = turn.execution;

    // The session's streaming-input queue (its stdin / permission control channel) lives on the
    // registry session and is closed ONLY by endClaudeSession — never at a turn boundary. Closing
    // early is the "Stream closed" bug AND kills pending background work (the CLI stops
    // backgrounded tasks on stdin close), so turn-end disposition is decided post-stream:
    // pending work → wake pump holds the session; a clean end → retained; else endClaudeSession.

    const isExecutionAborted = (): boolean => abortController.signal.aborted;
    turn.isAborted = isExecutionAborted;

    // Track whether canUseTool already persisted a task signal during the stream.
    // When true, provider-neutral teardown persistence is skipped to avoid double-write and race.
    turn.setHasExplicitTaskSignal = (value) => {
      hasExplicitTaskSignal = value;
    };

    const collectedChunks: UIMessageChunk[] = [];
    let messageIndex = 0;
    // Incremental mirror of collectedChunks — O(1) per chunk where a per-chunk
    // buildPartsFromChunks walk is O(N²) across a long turn. Emitters outside the SDK loop
    // (AskUserQuestion, steering, the inline plan card) push into collectedChunks too; the
    // applied-count guard in onSdkMessage detects the skew and re-folds from scratch.
    let claudePartsState: PartsState = createPartsState();
    let claudePartsApplied = 0;
    let claudeResultErrored = false; // the last result read is the turn's own
    turn.lastCollectedChunks = collectedChunks;
    turn.nextMessageIndex = () => messageIndex++;
    turn.pendingReminders = pendingReminders;

    const shouldResumeClaudeSession = Boolean(persistedSessionId);
    const processClaudeStream = async (
      session: ClaudeSession,
      initialMessage: ReturnType<typeof buildClaudeUserMessage>,
      adoptedPump?: WakePump,
      claimed = false,
    ): Promise<void> => {
      // Create transformer for SDK messages -> UI chunks
      const transform = createTransformer();
      let stopConsuming = false;

      // Stream messages as they come
      const toolNameByCallId = new Map<string, string>();
      const toolInputByCallId = new Map<string, Record<string, unknown>>();
      // Claude Code plan mode: track ExitPlanMode tool call to stop stream after plan is complete.
      // SDK's native plan mode produces Write (plan file) → ExitPlanMode. When ExitPlanMode output
      // arrives, the plan is done and we break out — the post-stream handler converts it to frink-plan.
      let exitPlanModeToolCallId: string | null = null;
      let planCompletedByExitPlanMode = false;
      let stopStreamAfterExitPlanModeFinish = false;
      // Track last Write to an allowed Claude plan path for inline plan emission at ExitPlanMode
      let lastPlanFilePathInStream: string | null = null;
      let planEmittedInline = false;
      let planAutoArmed = false;
      // Plan mode: suppress duplicate IPC (text + native plan tools); chunks are still collected
      // for persistence (see shouldSuppress* helpers).
      const nativePlanStreamCallIds = new Set<string>();
      // Tool-use IDs whose tool-input-available was suppressed by the post-ExitPlanMode guard.
      // The synthetic-error loop skips these so a hook denial doesn't surface as an orphan
      // tool-output-error under the plan card for a tool the renderer never saw.
      const suppressedPostPlanToolCallIds = new Set<string>();
      // `effectivePlanMode` starts as the user-selected mode and flips to true if the model calls
      // EnterPlanMode mid-turn (SDK-initiated transition). All plan-mode-specific stream and
      // post-stream handling keys off this flag rather than the initial `mode` so mid-conversation
      // plan entry produces the canonical frink-plan card + halts after ExitPlanMode for approval.
      let effectivePlanMode = mode === 'plan';
      let suppressPlanModeClaudeSend = effectivePlanMode
        ? { suppressNativePlanTools: true, suppressPlanText: true }
        : null;
      // Session id normally persists at stream FINISH; a turn dying mid-stream leaves
      // sub_chats.session_id NULL and Carry on has nothing to resume — persist on first
      // announcement instead (the finish-path persist stays the authoritative overwrite).
      let earlySessionIdPersisted = false;
      /** tool-input bookkeeping + plan-mode stream tracking: records name/input for the broadcast
       * below, flips to plan mode on a mid-turn EnterPlanMode (persist + IPC keep the renderer's
       * toggle in sync), pins the FIRST ExitPlanMode call id (duplicates must not emit frink-plan
       * twice), and tracks the last plan-dir Write (only the final version is emitted). */
      const trackToolInputChunk = (chunk: UIMessageChunk): void => {
        if (chunk.type === 'tool-input-start') {
          toolNameByCallId.set(chunk.toolCallId, chunk.toolName);
        }
        if (chunk.type !== 'tool-input-available') return;
        toolNameByCallId.set(chunk.toolCallId, chunk.toolName);
        toolInputByCallId.set(chunk.toolCallId, chunk.input as Record<string, unknown>);
        if (chunk.toolName === 'EnterPlanMode' && !effectivePlanMode) {
          effectivePlanMode = true;
          // Planning mid-turn re-locks terminals: this turn now finishes via ExitPlanMode too.
          turn.planTerminalsLocked = true;
          suppressPlanModeClaudeSend = {
            suppressNativePlanTools: true,
            suppressPlanText: true,
          };
          // Row write before broadcast (`sub-chat-mode-ownership`): the mirror must not lead
          // the authority a follow-up turn resolves its mode from.
          persistPlanFlipThenNotify(subChatId, () =>
            sendSubChatModeChange({ chatId, subChatId, mode: 'plan' }),
          );
          log.info(
            `[Socket Executor] mid-turn EnterPlanMode detected for ${subChatId}; flipped to plan mode`,
          );
        }
        if (
          effectivePlanMode &&
          chunk.toolName === 'ExitPlanMode' &&
          exitPlanModeToolCallId === null
        ) {
          exitPlanModeToolCallId = chunk.toolCallId;
        }
        if (effectivePlanMode && PLAN_MUTATION_TOOLS.has(chunk.toolName)) {
          lastPlanFilePathInStream =
            planWritePathFromInput(chunk.input, projectPath, subChatId) ?? lastPlanFilePathInStream;
        }
      };

      /** ExitPlanMode completed: emit the frink-plan card inline (before the trailing 'finish')
       * and — outside auto-approve — halt at plan submission: allowing ExitPlanMode lifts the
       * SDK's plan-mode restrictions, so the model would implement in-turn before approval.
       * `planSubmissionHalt` denies every tool from this instant (the interrupt can lag); a
       * failed interrupt leaves tools denied and the history filter hides the text overrun. */
      const handleExitPlanModeCompletion = async (): Promise<void> => {
        planCompletedByExitPlanMode = true;
        // Plan submitted: an auto-approved node implements in-turn and must be able to signal a
        // real `done` to advance. (Non-auto turns are halted below by planSubmissionHalt anyway.)
        turn.planTerminalsLocked = false;
        turn.planSubmitted = true;
        lastPlanFilePathInStream ??= await resolveLatestSessionPlanFile(subChatId);
        if (lastPlanFilePathInStream) {
          // A null return keeps planEmittedInline = false so the post-stream fallback fires.
          const advancedIndex = await emitInlinePlanCard({
            chatId,
            subChatId,
            assistantMessageId: msgId,
            planPath: lastPlanFilePathInStream,
            collectedChunks,
            messageIndex,
            flowDriven: isFlowDrivenExecution,
            autoApproved: flowPlanAutoApprove,
            send: sendRunStreamChunkDirect,
          });
          if (advancedIndex !== null) {
            messageIndex = advancedIndex;
            planEmittedInline = true;
            flipToAgentModeForAutoApprove();
          }
        }
        if (flowPlanAutoApprove) {
          // An auto-approved node implements in THIS same turn. armAutoDuringPlan left the query at
          // prePlanMode 'default', so ExitPlanMode restored 'default' and turned the during-plan
          // classifier off — switch the implementation half to 'auto' here, on EVERY card path (not
          // just the inline one). `force` because planning already set the abstain flag, which would
          // otherwise no-op armAutoReview and leave the implementation half denying every tool.
          await armAutoReview(session, autoReviewArmable, planAutoReview);
        } else {
          // End this turn but keep the session (interrupt expected). Consumption continues so the
          // trailing finish chunk (session metadata) still lands while the interrupt is in flight.
          planSubmissionHalt = true;
          session.interruptExpected = true;
          void Promise.resolve()
            .then(() => session.query.interrupt())
            .catch((err) => {
              log.warn(`[Socket Executor] plan-halt interrupt failed for ${subChatId}:`, err);
            });
        }
      };

      /** tool-output side: broadcast file-changed IPC for tools whose input we tracked. */
      const broadcastToolOutputChunk = (chunk: UIMessageChunk): void => {
        if (chunk.type !== 'tool-output-available') return;
        const toolName = toolNameByCallId.get(chunk.toolCallId);
        const toolInput = toolInputByCallId.get(chunk.toolCallId);
        if (toolName !== undefined && toolInput !== undefined) {
          broadcastWriteToolFileChangedIpc(`tool-${toolName}`, toolInput, projectPath, subChatId);
        }
      };

      /** Non-auto plan, post-submission: keep racing chunks out of history (reload view must
       * equal live view). Returns the (possibly normalized) chunk to keep, or null to drop. */
      const filterPostPlanChunk = (chunk: UIMessageChunk): UIMessageChunk | null => {
        if (!(effectivePlanMode && planCompletedByExitPlanMode && !flowPlanAutoApprove)) {
          return chunk;
        }
        if (shouldDropPostPlanChunkFromHistory(chunk, exitPlanModeToolCallId)) return null;
        return normalizePlanHaltFinishChunk(chunk);
      };

      /** Plan-mode IPC suppression: auto-approve streams its in-turn implementation (hiding only
       * ExitPlanMode rows); non-auto hides everything post-ExitPlanMode until approval; drafting
       * dedupes plan artifacts. See resolvePlanModeChunkSuppression for the contract + tests. */
      const shouldSuppressPlanModeSend = (chunk: UIMessageChunk): boolean => {
        if (!suppressPlanModeClaudeSend) return false;
        return resolvePlanModeChunkSuppression(chunk, {
          planCompletedByExitPlanMode,
          flowPlanAutoApprove,
          suppressNativePlanTools: suppressPlanModeClaudeSend.suppressNativePlanTools,
          suppressPlanText: suppressPlanModeClaudeSend.suppressPlanText,
          toolNameByCallId,
          nativePlanStreamCallIds,
          suppressedPostPlanToolCallIds,
        });
      };

      const onSdkMessage = async (sdkMessage: SDKMessage): Promise<void> => {
        await claudeMcpConfig?.clear();
        // An aborted turn's session is already closing (bindTurnAbort); its late frames are dropped.
        if (stopConsuming || abortController.signal.aborted) return;
        if (sdkMessage.type === 'result') claudeResultErrored = sdkMessage.is_error;

        // First live frame of a plan-auto turn: arm the during-plan reviewer (plan→default→plan flip)
        // before the model emits any tool. The query stays in 'plan' throughout — never 'auto'.
        if (planAutoReview && !planAutoArmed) {
          planAutoArmed = true;
          await armAutoDuringPlan(session);
        }

        for (let chunk of transform(sdkMessage)) {
          if (!earlySessionIdPersisted) {
            const chunkSessionId = sessionIdFromFrame(sdkMessage, chunk);
            if (chunkSessionId) {
              earlySessionIdPersisted = true;
              session.sdkSessionId = chunkSessionId;
              persistEarlySessionId(subChatId, chunkSessionId);
            }
          }
          trackToolInputChunk(chunk);

          if (
            chunk.type === 'tool-output-available' &&
            exitPlanModeToolCallId &&
            chunk.toolCallId === exitPlanModeToolCallId
          ) {
            lastPlanFilePathInStream ??= planPathFromExitPlanModeOutput(chunk, subChatId);
            await handleExitPlanModeCompletion();
          }

          broadcastToolOutputChunk(chunk);

          const keptChunk = filterPostPlanChunk(chunk);
          if (keptChunk === null) continue;
          chunk = keptChunk;

          // Regression alarm for the "Stream closed" bug — names the closer so a recurrence is
          // diagnosable (which abort superseded the turn / whether a wake hold owned the session).
          reportIfControlChannelClosed(chunk, subChatId, {
            abortSource: executionAbortSources.get(subChatId),
            wakeHoldActive: hasWakeHold(subChatId),
            turnAborted: abortController.signal.aborted,
          });
          collectedChunks.push(chunk);

          if (collectedChunks.length === claudePartsApplied + 1) {
            applyChunkToParts(claudePartsState, chunk);
          } else {
            // An out-of-loop emitter appended to collectedChunks — re-fold WITHOUT the trailing
            // text flush of partsStateFromChunks, so an open paragraph keeps accumulating.
            claudePartsState = createPartsState();
            for (const collected of collectedChunks) {
              applyChunkToParts(claudePartsState, collected);
            }
          }
          claudePartsApplied = collectedChunks.length;
          const currentParts = partsSnapshot(claudePartsState);

          // Send stream chunk: Direct IPC so local renderer always receives (avoids empty UI when
          // execution finishes before transport is attached, e.g. new-chat first message).
          if (shouldSuppressPlanModeSend(chunk)) continue;

          sendRunStreamChunkDirect({
            chatId,
            subChatId,
            assistantMessageId: msgId,
            chunk,
            parts: currentParts,
            messageIndex,
          });

          messageIndex++;

          // In plan mode, preserve trailing finish metadata (e.g., sessionId) after ExitPlanMode,
          // then stop — the turn pauses for human approval. EXCEPT auto-approve plan nodes, which have
          // no approval gate: let the loop run to natural completion so the in-turn implementation
          // streams (the suppression branch above already lets it through).
          if (planCompletedByExitPlanMode && chunk.type === 'finish' && !flowPlanAutoApprove) {
            stopStreamAfterExitPlanModeFinish = true;
            log.info(
              `[Socket Executor] Claude plan mode: ExitPlanMode completed for ${subChatId}, finish chunk handled; stopping stream`,
            );
            break;
          }
        }
        // Plan halt: stop consuming only after the finish metadata has been captured. The
        // ExitPlanMode branch already fired the halt interrupt; this is the belt for the case
        // where the graceful `result` beats the interrupt onto the stream.
        if (stopStreamAfterExitPlanModeFinish) {
          stopConsuming = true;
        }
      };
      // No close-on-result: the session queue outlives the turn (registry-owned). Both paths return
      // at the turn's `result` frame; whether the session then holds for pending background work,
      // idles or ends is decided post-stream (armOrDisposeClaudeSession). An adopted turn goes
      // through ITS pump's own startTurn: the per-arming handle rejects adopt-refused if that exact
      // arming has died meanwhile, where a session-level dispatch would misread it as a fresh turn.
      const takeover = adoptedTurnBeforePush({
        session,
        turn,
        signal: abortController.signal,
        mode,
        nativeAutoReview,
        live: {
          model: sdkOptions.model,
          effort: (sdkOptions as { effort?: string }).effort,
          ultracode: Boolean(
            (sdkOptions as { settings?: { ultracode?: boolean } }).settings?.ultracode,
          ),
        },
        onTakeover: () => chatServer.bindChannelExecution(subChatId, executionContextId),
        onSetterRejected: claimed ? () => session.retire('setter-rejected') : undefined,
      });
      const turnDone = adoptedPump
        ? adoptedPump.startTurn(initialMessage, onSdkMessage, takeover)
        : runClaudeTurn(session, initialMessage, onSdkMessage, claimed ? takeover : undefined);
      const unbindTurnAbort = bindTurnAbort(session, abortController.signal);
      await turnDone.finally(unbindTurnAbort);

      // Emit synthetic tool-output-error for any tool we denied (SDK does not send tool_result for denials)
      const outputToolIds = new Set(
        collectedChunks.flatMap((c) =>
          c.type === 'tool-output-available' || c.type === 'tool-output-error'
            ? [c.toolCallId]
            : [],
        ),
      );
      const initialLength = collectedChunks.length;
      for (let i = 0; i < initialLength; i++) {
        const chunk = collectedChunks[i];
        if (chunk.type !== 'tool-input-available') continue;
        const toolCallId = chunk.toolCallId;
        if (outputToolIds.has(toolCallId)) continue;
        // Skip inputs that were hidden from the renderer by the post-ExitPlanMode guard --
        // dispatching a tool-output-error for a tool the UI never saw would render as orphan.
        if (suppressedPostPlanToolCallIds.has(toolCallId)) continue;
        const message = matchDeniedToolMessage(deniedToolIdsWithMessages, toolCallId);
        if (!message) continue;
        const errorChunk: UIMessageChunk = {
          type: 'tool-output-error',
          toolCallId,
          errorText: message,
          permissionDenied: true,
        };
        collectedChunks.push(errorChunk);
        sendRunStreamChunkDirect({
          chatId,
          subChatId,
          assistantMessageId: msgId,
          chunk: errorChunk,
          parts: buildPartsFromChunks(collectedChunks),
          messageIndex: messageIndex++,
        });
      }

      if (effectivePlanMode) {
        if (!planEmittedInline) {
          // Claude Code SDK native plan mode path. Two cases reach this branch: a first plan turn
          // whose inline emission failed/was skipped, and a follow-up amend turn that rewrote the
          // plan file without re-calling ExitPlanMode (without this branch that update never
          // reaches the UI card). Resolution: newest in-stream plan mutation, else the path the
          // stream already resolved (SDK filePath or mutation), else the plans-dir scan.
          let planFilePath: string | null = null;
          for (const c of collectedChunks) {
            if (c.type !== 'tool-input-available') continue;
            const name = toolNameByCallId.get(c.toolCallId) ?? c.toolName;
            if (!PLAN_MUTATION_TOOLS.has(name)) continue;
            planFilePath = planWritePathFromInput(c.input, projectPath, subChatId) ?? planFilePath;
          }
          planFilePath ??=
            lastPlanFilePathInStream ??
            (planCompletedByExitPlanMode ? await resolveLatestSessionPlanFile(subChatId) : null);

          let planEmittedPostStream = false;
          if (planFilePath) {
            try {
              const planContent = (await fs.promises.readFile(planFilePath, 'utf8')).trim();
              if (planContent.length > 0) {
                const frinkPlanChunks = buildFrinkPlanChunks(subChatId, planContent, planFilePath, {
                  flowDriven: isFlowDrivenExecution,
                  autoApproved: flowPlanAutoApprove,
                });
                for (const chunk of frinkPlanChunks) {
                  collectedChunks.push(chunk);
                  const parts = filterCanonicalPlanParts(
                    buildPartsFromChunks(collectedChunks),
                    planContent,
                  );
                  sendRunStreamChunkDirect({
                    chatId,
                    subChatId,
                    assistantMessageId: msgId,
                    chunk,
                    parts,
                    messageIndex: messageIndex++,
                  });
                }
                planEmittedPostStream = true;
                flipToAgentModeForAutoApprove();
                log.info(
                  `[Socket Executor] Claude plan mode: emitted frink-plan post-stream for ${subChatId} (planPath=${planFilePath}, exitPlanMode=${planCompletedByExitPlanMode})`,
                );
              } else {
                log.warn(
                  `[Socket Executor] Claude plan mode: plan file was empty for ${subChatId} (${planFilePath})`,
                );
              }
            } catch (err) {
              log.warn(
                `[Socket Executor] Claude plan mode: failed to read plan file for ${subChatId} (${planFilePath}):`,
                err,
              );
            }
          }
          if (!planEmittedPostStream) {
            // No card rendered — no plan artifact, or the resolved file vanished/was empty by
            // emission time. Replay the live-suppressed text chunks so the user sees the reply,
            // not a blank halted stream. Cannot double a card: planEmittedInline is false here.
            const { nextIndex, replayedCount } = emitPlanFallbackSends(
              collectedChunks,
              messageIndex,
              null,
              ({ chunk, messageIndex: sendIndex }, parts) =>
                sendRunStreamChunkDirect({
                  chatId,
                  subChatId,
                  assistantMessageId: msgId,
                  chunk,
                  parts,
                  messageIndex: sendIndex,
                }),
            );
            messageIndex = nextIndex;
            log.info(
              `[Socket Executor] Claude plan mode: no Write to an allowed plan path for ${subChatId} (exitPlanMode=${planCompletedByExitPlanMode}); replayed ${replayedCount} text chunk(s) as normal reply`,
            );
          }
        } else {
          // A plan card already rendered inline: replaying the prose would duplicate it and a
          // failure notice would contradict it, so this branch deliberately only logs.
          log.info(
            `[Socket Executor] Claude plan mode: plan card already emitted inline for ${subChatId}`,
          );
        }
      }
    };

    // One turn attempt. A live wake pump on this chat means the CLI is already alive holding
    // pending background work — adopt it (the turn takes the arming over; no new process, the
    // work survives — the "bypass coverage" scenario). Otherwise claim the chat's matching idle
    // session, else spawn fresh; an errored attempt disposes it so a retry spins up another.
    const runClaudeQueryAttempt = async (options: typeof sdkOptions): Promise<void> => {
      // A pre-warm of this chat lands first, so the claim below takes its CLI.
      await settlePrewarm(subChatId);
      flowResources.assertLive(abortController.signal, 'Claude');
      const initialMessage = buildClaudeUserMessage(fullPrompt, imageParts, mode);
      const hold = takeWakeHold(subChatId, flowResources.admitted);
      if (hold) {
        flowResources.adoptWakeHoldRuntimeSlot(hold);
        // Adopted turns keep the session's SDK options, Stop hook and tool list; the rest is this
        // turn's own, its MCP context included (bound at the takeover push).
        turn.execution = adoptHeldExecution(ownExecution, hold.execution);
        // The attach and the SDK permission-mode reconcile land at the pump's actual push time
        // (adoptedTurnBeforePush) — earlier would misattribute a still-streaming burst's hook
        // events to this turn and flip SDK policy under it (mid-burst adoption defers the push
        // until the burst's result). A refused reconcile rejects adopt-refused into the retry.
        ownedClaudeSession = hold.session;
        claudeQueryStarted = true;
        try {
          await processClaudeStream(hold.session, initialMessage, hold.pump);
        } catch (err) {
          if (!isPumpAdoptRefusedError(err)) throw err;
          // The pump exited before the takeover push (nothing streamed): unwind the adoption
          // and rethrow — the attempt-level retry reruns on a fresh session, as if takeWakeHold
          // had refused the dead hold in the first place.
          ownedClaudeSession = null;
          turn.execution = ownExecution;
          throw err;
        }
        return;
      }
      // A fresh session is spawned from this execute's own options, even when retrying a failed
      // adoption, so its callbacks and signal context must be this execute's own again.
      turn.execution = ownExecution;
      const keyParts = computeClaudeSessionKey(options, claudeSpec.mcpServers, claudeSpec.login);
      // The claim, busy and attach share this span (runTurn); the push follows the mode reconcile.
      const claim = claimRetainedSession(subChatId, {
        keyParts,
        persistedSessionId: options.resume,
        flowTurn: flowResources.admitted || isFlowExecutionTurn,
      });
      const claimed = 'miss' in claim ? null : claim;
      let session = claimed;
      try {
        if (!session) {
          // Waits out a busy sibling and releases any other leftover; a live hold adopts above.
          await releaseLeftoverClaudeSession(subChatId);
          await prepareClaudeSpawn(claudeSpec);
          await flowResources.ensureRuntimeSlot(() => acquireRuntimeSlot('claude'));
          flowResources.assertLive(abortController.signal, 'Claude');
          await claudeMcpConfig?.stage();
          claudeQueryStarted = true;
          session = spawnClaudeSession(claudeSpec, options, keyParts, claudeQuery, turn.startedAt);
          attachTurn(session, turn, () =>
            chatServer.bindChannelExecution(subChatId, executionContextId),
          );
        }
        claudeQueryStarted = true;
        ownedClaudeSession = session;
        await processClaudeStream(session, initialMessage, undefined, claimed !== null);
      } catch (err) {
        // Dead/errored attempt must not linger as a session (endSession is idempotent).
        // Identity-guarded: an evicted attempt may already have a successor under this key.
        if (session && getClaudeSession(subChatId) === session) endClaudeSession(subChatId);
        throw err;
      }
    };

    /**
     * Post-turn session disposition — THE fix for background waits dying at turn end. Pending harness
     * work (backgrounded commands, Monitors, ScheduleWakeup crons — read from the Stop hook) keeps the
     * CLI alive with a wake pump consuming the stream between turns: the harness wakes the model
     * itself and each burst extends THIS turn's assistant message. A clean ordinary turn end keeps
     * the session idle for the chat's next send; anything else ends it.
     */
    const armOrDisposeClaudeSession = async (): Promise<void> => {
      const session = ownedClaudeSession;
      // Superseded (a duplicate-request registered its own session under this key) → the
      // successor owns disposition; touching the key here would destroy its live session.
      if (!session || getClaudeSession(subChatId) !== session) return;
      const pendingWork = session.stopHook?.lastPendingWork ?? null;
      // Plan turns (mid-turn EnterPlanMode too) hold: bursts inherit the arming turn's plan locks
      // (armWakePump), so the terminal-signal predicate stays sound between wakes. Only a SUBMITTED
      // plan disposes — halted awaiting approval; follow-up spawns fresh (flow-quiet-wait-handling)
      const mustDispose =
        abortController.signal.aborted ||
        turn.planSubmissionHalt() ||
        session.busy ||
        session.queue.closed; // killed (question-park): dead input
      if (!pendingWork || mustDispose) {
        logDisposedPendingWork(subChatId, pendingWork, {
          aborted: abortController.signal.aborted,
          planHalted: turn.planSubmissionHalt(),
          killed: session.queue.closed,
        });
        const flowTurn = flowResources.admitted || isFlowExecutionTurn;
        // Never kept: an error result, a dropped follower, or a steer the turn may not have read.
        const unclean = claudeResultErrored || session.stopHook?.droppedFollower || turn.steered;
        if (mustDispose || flowTurn || unclean) endClaudeSession(subChatId);
        else {
          // The registry's now: this execute's teardown must not end it or a later send's claim.
          retainClaudeSession(session);
          ownedClaudeSession = null;
          claudeSessionRetained = true;
        }
        return;
      }
      const approvalOwnerController = executionAbortController;
      const hold = flowResources.armWakeHold((heldResources) =>
        armWakePump({
          session,
          pendingWork,
          subChatId,
          executionContextId,
          signalTaskId,
          ...heldResources,
          canClearPendingApprovals: () => {
            const current = getActiveExecution(subChatId);
            return !current || current.controller === approvalOwnerController;
          },
          io: buildWakeHoldIo({
            chatId,
            subChatId,
            flowDriven: isFlowDrivenExecution,
            planAutoApprove: flowPlanAutoApprove,
            nextMessageIndex: turn.nextMessageIndex,
            buildFinalParts: (chunks) => buildFinalPartsForPersist(mode, chunks),
            // Injected, not imported there: see the wake-hold-io module doc (import cycle).
            send: {
              sendStreamChunkDirect: sendRunStreamChunkDirect,
              sendExecuteCompleteDirect: sendRunExecuteCompleteDirect,
              sendStreamSettledDirect: sendRunStreamSettledDirect,
              sendWakeHoldChanged,
            },
            clearPendingApprovals,
            getLatestTaskSignal: chatServer.getLatestTaskSignal,
            clearCurrentExecutionChat: chatServer.clearCurrentExecutionChat,
          }),
        }),
      );
      // A Flow cancel reaches a held run only through this controller, which the hold keeps
      // registered until its pump ends, so the session stays bound to it until then.
      if (hold.unregisterFlowRunAbort) {
        const unbindFlowAbort = bindTurnAbort(session, abortController.signal);
        void hold.pump.done.then(unbindFlowAbort);
      }
    };

    /** Clean resume failure: rerun fresh without its selector, restoring suppressed history. */
    const retryWithoutResume = async (): Promise<void> => {
      log.warn(`[Socket Executor] Claude resume failed for ${subChatId}, retrying without resume`);
      const resolvedModelRetry = (sdkOptions as Record<string, unknown>).model ?? 'sonnet';
      const thinkingOptRetry = (sdkOptions as Record<string, unknown>).thinking;
      const resolvedThinkingRetry =
        thinkingOptRetry !== undefined
          ? JSON.stringify(thinkingOptRetry)
          : String((sdkOptions as Record<string, unknown>).maxThinkingTokens ?? 'off');
      const resolvedBetasRetry = ((sdkOptions as Record<string, unknown>).betas as string[]) ?? [];
      log.info(
        `[Socket Executor] SDK call (retry without resume): model=${resolvedModelRetry}, thinking=${resolvedThinkingRetry}, effort=${settings?.effort ?? 'default'}, betas=[${resolvedBetasRetry.join(',')}], resume=false, mode=${mode}, permissionMode=${resolvePermissionMode(mode, nativeAutoReview)}`,
      );
      const retryOptions: Record<string, unknown> = { ...sdkOptions };
      delete retryOptions.resume;
      if (willReplayHistoryViaResume && fullPrompt.endsWith(message)) {
        fullPrompt =
          fullPrompt.slice(0, fullPrompt.length - message.length) +
          formatPromptWithHistory(message, history);
      }
      await runClaudeQueryAttempt(retryOptions as typeof sdkOptions);
      log.info(
        `[Socket Executor] Resume retry succeeded for ${subChatId} after stale session ${persistedSessionId}`,
      );
    };

    const runWithOptionalResumeRetry = async (adoptRefusedRetried = false): Promise<void> => {
      try {
        await runClaudeQueryAttempt(sdkOptions);
      } catch (error) {
        const errorMessage = error instanceof Error ? error.message : String(error);
        // When resume fails, the SDK still emits a skeleton stream (start / start-step /
        // message-metadata / finish-step / finish) representing the empty failed result, then
        // throws. None of those frames carry user content — USER_VISIBLE_CHUNK_TYPES is the
        // "real progress" allow-list that gates every retry below.
        const hasUserVisibleProgress = collectedChunks.some((c) =>
          USER_VISIBLE_CHUNK_TYPES.has(c.type),
        );
        // Adopt-refused: a dead wake pump or claimed idle CLI never took the push, or a sibling
        // registered the chat's session first. Nothing streamed, so one fresh rerun is safe; its
        // own failure (a stale resume a claimed pre-warm died of) is classified as a first one's.
        if (
          isPumpAdoptRefusedError(error) &&
          !adoptRefusedRetried &&
          !hasUserVisibleProgress &&
          !abortController.signal.aborted
        ) {
          log.warn(
            `[Socket Executor] session adoption refused for ${subChatId} (dead wake pump, sibling or idle session); retrying on a fresh session`,
          );
          await runWithOptionalResumeRetry(true);
          return;
        }
        if (
          shouldResumeClaudeSession &&
          !hasUserVisibleProgress &&
          !abortController.signal.aborted &&
          isResumeFailureText(errorMessage)
        ) {
          await retryWithoutResume();
          return;
        }
        // Transient/auth API errors (401 expired token, 429, 529, 5xx): one retry KEEPING the
        // session resume — the session is fine, the API call failed. Gated on zero user-visible
        // progress so a half-done turn is never silently re-run (its side effects would double);
        // a progressed turn falls through to the terminal catch and parks instead.
        const apiErrorClass =
          !isUserAbortErrorMessage(errorMessage) && !hasUserVisibleProgress
            ? classifyApiErrorText(errorMessage)
            : null;
        if (apiErrorClass && !abortController.signal.aborted) {
          await retryAfterApiError(apiErrorClass, error);
          return;
        }
        throw error;
      }
    };

    /** One API-error retry. 'auth' re-resolves ONLY for api-key accounts (frink owns that
     * secret; a sync may have written a newer one) and retries only if the token CHANGED.
     * Passthrough has no token to swap — the CLI recovers from its own 401. */
    async function retryAfterApiError(
      apiErrorClass: NonNullable<ReturnType<typeof classifyApiErrorText>>,
      error: unknown,
    ): Promise<void> {
      const retryOptions: Record<string, unknown> = { ...sdkOptions };
      if (apiErrorClass.kind === 'auth' && storedCredential.isApiKey) {
        const fresh = chatAccountResult?.account
          ? await getClaudeCodeTokenById(chatAccountResult.account.id)
          : await getDefaultClaudeCodeToken();
        if (!fresh.token || fresh.token === storedCredential.token) {
          log.warn(
            `[Socket Executor] API auth error for ${subChatId}: credential re-resolve returned ${fresh.token ? 'the same token' : 'no token'} — not retrying`,
          );
          throw error;
        }
        if (fresh.type !== storedCredential.type) {
          log.warn(
            `[Socket Executor] API auth error for ${subChatId}: credential re-resolve changed provider ${storedCredential.type}→${fresh.type} — not retrying`,
          );
          throw error;
        }
        const retryEnv: Record<string, string> = { ...sdkOptions.env };
        delete retryEnv.ANTHROPIC_API_KEY;
        delete retryEnv.CLAUDE_CODE_OAUTH_TOKEN;
        if (fresh.isApiKey) retryEnv.ANTHROPIC_API_KEY = fresh.token;
        else retryEnv.CLAUDE_CODE_OAUTH_TOKEN = fresh.token;
        retryOptions.env = retryEnv;
        storedCredential = fresh;
      } else {
        await new Promise((resolve) =>
          setTimeout(resolve, API_ERROR_RETRY_BACKOFF_MS + Math.random() * 1000),
        );
      }
      log.warn(
        `[Socket Executor] API error (${apiErrorClass.kind}${apiErrorClass.status ? ` ${apiErrorClass.status}` : ''}) for ${subChatId}; retrying once${(retryOptions as { resume?: string }).resume ? ' with session resume' : ''}`,
      );
      await runClaudeQueryAttempt(retryOptions as typeof sdkOptions);
      log.info(`[Socket Executor] API-error retry succeeded for ${subChatId}`);
    }
    try {
      await runWithOptionalResumeRetry();
    } catch (error) {
      // The plan-halt interrupt can surface as an iterator throw instead of a graceful result.
      // The plan card is already emitted by then — finalize normally (a missing finish only means
      // no sessionId this turn; finalize keeps the row's existing one) instead of showing an error.
      if (!planSubmissionHalt) throw error;
      log.warn(
        `[Socket Executor] Claude plan mode: stream ended via interrupt throw for ${subChatId}:`,
      );
    }

    // 5. Extract metadata from finish chunk if present (use last: failed resume can leave an earlier `finish` before retry succeeds)
    let finishChunk: UIMessageChunk | undefined;
    for (let i = collectedChunks.length - 1; i >= 0; i--) {
      const c = collectedChunks[i];
      if (c.type === 'finish') {
        finishChunk = c;
        break;
      }
    }
    const metadata =
      finishChunk && 'messageMetadata' in finishChunk ? finishChunk.messageMetadata : undefined;

    // 6a. Clean-stream park (usage limit / API error as the final text part) — awaited before any
    // IPC emit so the renderer's completion refetch reads the parked status.
    const finalParts = buildFinalPartsForPersist(mode, collectedChunks);
    await disposeCleanStreamEnd(subChatId, finalParts);

    // Finalize the linked signal before session disposition, then snapshot the resulting hold state.
    // Reading hasWakeHold before this await races the async wake-pump arm and can publish a terminal
    // completion for an epoch that is about to stream another burst.
    signalFailure = await settleSignal(finalizeLinkedTaskSignal(), armOrDisposeClaudeSession);

    // Defer completion so the renderer processes synthetic tool-output-error chunks first (IPC order
    // can otherwise deliver execute-complete before stream-chunk, closing the stream early).
    const executeCompletePayload = {
      chatId,
      subChatId,
      assistantMessageId: msgId,
      sessionId: metadata?.sessionId,
      metadata,
      finalParts,
      streamEpoch: executionStreamEpoch,
      observerOwned: getExecutionOwner(subChatId) === undefined,
    };
    setImmediate(() => {
      // Re-read inside the deferred turn: Stop/pump exit may retract the hold after disposition.
      // sendExecuteCompleteDirect registers this value synchronously, so a later retraction sees
      // the held record and settles it instead of crossing an unregistered completion.
      sendRunExecuteCompleteDirect({
        ...executeCompletePayload,
        continuesWakeHold:
          !claudeSessionRetained && hasWakeHold(subChatId, ownedClaudeSession ?? undefined),
      });
    });

    // 5b (background). Create rollback checkpoint AFTER the UI-completion signal — git ops
    // (especially `git add -A`) can take 1-3s on dirty worktrees; blocking the user on this is
    // what the recent commit 1bf86eb2c missed.
    if (typeof metadata?.sdkMessageUuid === 'string' && projectPath) {
      const sdkMessageUuid = metadata.sdkMessageUuid;
      void createRollbackStash(projectPath, sdkMessageUuid).catch((error) => {
        log.error('[Socket Executor] Background createRollbackStash failed', {
          subChatId,
          sdkMessageUuid,
          error: error instanceof Error ? error.message : String(error),
        });
      });
    }

    lastExecutedModeBySubChat.set(subChatId, mode);
    log.info(`[Socket Executor] Execution complete for ${subChatId}`);
  } catch (error) {
    executionFailed = true;
    const errorMessage = error instanceof Error ? error.message : String(error);
    log.error('[Socket Executor] Claude execution failed');

    // Unconditional stream-error disposition (park before any IPC emit) — see the helper's doc
    // for the wedge this closes and the deliberate-stop semantics.
    const stampedCategory = stampedErrorCategory(error);
    const {
      isUsageLimit,
      terminalApiError,
      isUserStoppedExecution,
      involuntary,
      reportMessage,
      supersededDecline,
    } = await disposeFlowStreamError(subChatId, errorMessage, abortReason(), {
      stampedCategory,
      executionController: executionAbortController,
      ...(claudeQueryStarted ? { safeErrorMessage: CLAUDE_EXECUTION_FAILURE_MESSAGE } : {}),
    });

    // Held BY THIS EXECUTE'S SESSION: its pump owns these chunks and finalizes them — writing here
    // swaps `parts` wholesale and would lose its burst. A superseded session's draining hold must
    // not suppress finalizing OUR partials. `involuntary` finalizes even with nothing streamed.
    const held = !claudeSessionRetained && hasWakeHold(subChatId, ownedClaudeSession ?? undefined);
    const partialFinalParts =
      !held && turn.lastCollectedChunks.length > 0
        ? buildFinalPartsForPersist(mode, turn.lastCollectedChunks)
        : undefined;
    const didFinalize = !held && ((partialFinalParts?.length ?? 0) > 0 || !!involuntary);
    const wasSuperseded = supersededDecline();
    const shouldReportError = !isUserStoppedExecution && !wasSuperseded;
    const errorPayload = {
      chatId,
      subChatId,
      assistantMessageId: msgId,
      error: reportMessage,
      ...(persistedSessionId ? { failedSessionId: persistedSessionId } : {}),
      ...resolveErrorPayloadCategory(stampedCategory, isUsageLimit, terminalApiError),
    };
    if (didFinalize) {
      const finalizationPayload = {
        chatId,
        subChatId,
        assistantMessageId: msgId,
        finalParts: partialFinalParts,
        ...(involuntary ? { metadata: { interruptedBy: involuntary } } : {}),
        streamEpoch: executionStreamEpoch,
        observerOwned: getExecutionOwner(subChatId) === undefined,
      };
      if (shouldReportError) {
        // The error is the sole terminal event. Persist the partial transcript and interruption
        // marker before publishing it so the renderer's error refetch cannot race stale SQLite.
        await sendRunErrorDirect(errorPayload, finalizationPayload);
      } else {
        setImmediate(() => sendRunExecuteCompleteDirect(finalizationPayload));
      }
    } else if (shouldReportError) {
      sendRunErrorDirect(errorPayload);
    }

    if (!didFinalize && !held && (isUserStoppedExecution || wasSuperseded)) {
      sendRunStreamSettledDirect({
        chatId,
        subChatId,
        assistantMessageId: msgId,
        streamEpoch: executionStreamEpoch,
      });
    }
  } finally {
    await claudeMcpConfig?.clear();
    const fallbackSignalFailure: { current: { cause: unknown } | null } = { current: null };
    // Typed-reply decline-and-convert: staged BEFORE settle — the run's final activity
    // release (the reconcile that retires the prior admission) fires it, so the enqueue
    // never races an admission that is still active/releasing.
    const pendingResume = flowResources.takePendingContinuationResume();
    if (pendingResume) {
      // The corrective is delayed and carries no assistantMessageId, so it must never land
      // on a LIVE turn (a newer send/Retry owns the surface; its own outcome supersedes).
      stageContinuationResume(pendingResume, (message) => {
        if (getActiveExecution(subChatId)) return;
        sendRunErrorDirect({ chatId, subChatId, error: message, category: 'FLOW_RUN_ENDED' });
      });
    }
    await flowResources.settle({
      subChatId,
      resourcesTransferredToWakeHold: flowResources.hasArmedWakeHold,
      session: ownedClaudeSession,
      sessionRetained: claudeSessionRetained,
      executionContextId,
      clearExecutionContext: async (targetExecutionContextId) => {
        const { clearCurrentExecutionChat } = await import('../mcp/dynamic-chat-server');
        clearCurrentExecutionChat(targetExecutionContextId);
      },
      executionController: executionAbortController,
      getActiveController: () => getActiveExecution(subChatId)?.controller,
      deleteAbortSource: () => executionAbortSources.delete(subChatId),
      clearPendingApprovals: () => clearPendingApprovals('Execution ended.', subChatId),
      finalizeLinkedTaskSignal: async () => {
        if (flowResources.admitted) {
          await finalizeLinkedTaskSignal();
          return;
        }
        fallbackSignalFailure.current = await settleSignal(finalizeLinkedTaskSignal());
      },
      deleteActiveExecution: () => deleteActiveExecution(subChatId),
      chatId,
      flowContinuationClearId,
      clearFlowContinuation: async (targetChatId, taskId) => {
        const { clearActiveFlowTaskForChatIfMatches } = await import('../task-executor');
        clearActiveFlowTaskForChatIfMatches(targetChatId, taskId);
      },
    });
    // biome-ignore lint/correctness/noUnsafeFinally: completed-turn failure rejects after teardown.
    if (!executionFailed && signalFailure) throw signalFailure.cause;
    // biome-ignore lint/correctness/noUnsafeFinally: fallback failure rejects after mandatory teardown.
    if (fallbackSignalFailure.current) throw fallbackSignalFailure.current.cause;
  }
}

// User PAUSE: abort WITHOUT reconcileFlowTaskOnTeardown (it would CAS the fresh park to cancelled).
// Callers park FIRST (flows.pauseRun); the abort reads as a user stop, so the park survives.
// A between-turn wake hold counts as an active execution for pause purposes.
export function pauseActiveExecutionForSubChat(subChatId: string): boolean {
  const hadHold = hasWakeHold(subChatId);
  releaseWakeHold(subChatId, 'user-pause');
  const record = getActiveExecution(subChatId);
  if (!record) return hadHold;
  clearPendingApprovals('Paused by user.', subChatId);
  // Stamp before aborting, like every other stop path — unstamped, this pause is classified off
  // the SDK's error text alone, and a bare AbortError parks it as an api-error.
  executionAbortSources.set(subChatId, 'user-pause');
  record.controller.abort();
  deleteActiveExecution(subChatId);
  return true;
}

/**
 * Handle stop signal from remote machine
 */
export function handleRemoteStop(payload: { chatId: string; subChatId: string }): void {
  const record = getActiveExecution(payload.subChatId);
  const persistence = record
    ? flow.startFlowTaskTeardown(payload.subChatId, false, record.controller)
    : undefined;
  releaseWakeHold(payload.subChatId, 'remote-stop', persistence);
  if (record) {
    executionAbortSources.set(payload.subChatId, 'remote-stop');
    log.info(`[Socket Executor] Stopping execution for ${payload.subChatId}`);
    clearPendingApprovals('Session cancelled.', payload.subChatId);
    record.controller.abort();
    deleteActiveExecution(payload.subChatId);
  }
}

/**
 * Phase 1 ship-blocker fix (commit 6056c8): chats.delete used to leave the SDK streaming
 * and tool-calling against a worktree that fire-and-forget removeWorktree was about to
 * yank from under it. Callers (delete + archive paths) now invoke this BEFORE flipping
 * the local row, so the abort signal lands while the executor is still running.
 *
 * No-op when no execution is active for the given sub-chat.
 */
export function abortActiveExecutionsForSubChats(
  subChatIds: readonly string[],
  reason: string,
): void {
  for (const subChatId of subChatIds) {
    releaseWakeHold(subChatId, reason);
    retireRetainedSession(subChatId, reason);
  }
  if (!hasActiveExecutions() || subChatIds.length === 0) return;
  let aborted = 0;
  for (const subChatId of subChatIds) {
    const record = getActiveExecution(subChatId);
    if (!record) continue;
    executionAbortSources.set(subChatId, reason);
    clearPendingApprovals(`Session aborted: ${reason}.`, subChatId);
    record.controller.abort();
    deleteActiveExecution(subChatId);
    aborted += 1;
  }
  if (aborted > 0) {
    log.info(`[Socket Executor] Aborted ${aborted} execution(s) for sub-chats: ${reason}`);
  }
}

/**
 * Abort agent runs tied to a specific BrowserWindow (same `webContents.id`).
 * Entries without `localRendererWebContentsId` (e.g. executor runs for another
 * machine's request) are left running.
 */
export function abortActiveExecutionsForWebContents(webContentsId: number, reason: string): void {
  const toAbort = listExecutionsForWebContents(webContentsId);
  if (toAbort.length === 0) return;
  log.info(
    `[Socket Executor] Aborting ${toAbort.length} active execution(s) for webContents ${webContentsId}: ${reason}`,
  );
  for (const [subChatId, record] of toAbort) {
    const persistence = flow.startFlowTaskTeardown(subChatId, true, record.controller);
    releaseWakeHold(subChatId, `renderer-lifecycle:${reason}`, persistence);
    executionAbortSources.set(subChatId, reason);
    clearPendingApprovals(`Session aborted: ${reason}.`, subChatId);
    record.controller.abort();
    deleteActiveExecution(subChatId);
  }
}

export const _extractImagePartsFromMessageForTests = extractImagePartsFromMessage;
