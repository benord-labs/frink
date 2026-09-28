/**
 * In-memory registries written at task dispatch time and consumed at execution/send time.
 * Cleared on process exit; not persisted (restart invalidates in-flight runs, and a re-claim
 * that will actually re-send registers again through `handleClaimedTask`).
 */

import log from 'electron-log';
import { type ResolvedTaskStartMode, toChatMode } from '../../../shared/lib/trigger-rule-config';
import type { ChatMode } from '../../../shared/types/chat-mode';
import { getActiveExecution } from '../socket/streaming/execution-registry';

/**
 * chatId → taskId for flow continuation tasks.
 * When a continuation agent reuses an existing chat, the chat row's task_id is stale
 * (points to the start_task). This map lets the executor resolve the correct task.
 */
const activeFlowTaskForChat = new Map<string, string>();

export function setActiveFlowTaskForChat(chatId: string, taskId: string): void {
  activeFlowTaskForChat.set(chatId, taskId);
}

export function getActiveFlowTaskForChat(chatId: string): string | null {
  return activeFlowTaskForChat.get(chatId) ?? null;
}

export function clearActiveFlowTaskForChat(chatId: string): void {
  activeFlowTaskForChat.delete(chatId);
}

/** Removes the map entry only if it still matches {@link expectedTaskId} (compare-and-clear). */
export function clearActiveFlowTaskForChatIfMatches(chatId: string, expectedTaskId: string): void {
  if (activeFlowTaskForChat.get(chatId) === expectedTaskId) {
    activeFlowTaskForChat.delete(chatId);
  }
}

export type FlowContinuationResolveInput = {
  chatId: string | undefined;
  chatRowTaskId: string | null | undefined;
  expectedFlowTaskId: string | undefined;
};

/**
 * Resolves which task id to use for execution when flow continuation may override the chat row.
 * Shared by socket executor and local Claude subscription to avoid drift.
 */
export function resolveFlowContinuationExecutionTask(input: FlowContinuationResolveInput): {
  taskIdForExecution: string | null;
  flowContinuationClearId: string | null;
} {
  let taskIdForExecution = input.chatRowTaskId ?? null;
  let flowContinuationClearId: string | null = null;
  if (input.chatId && input.expectedFlowTaskId) {
    const candidate = getActiveFlowTaskForChat(input.chatId);
    if (candidate === input.expectedFlowTaskId) {
      taskIdForExecution = candidate;
      flowContinuationClearId = candidate;
    }
  }
  return { taskIdForExecution, flowContinuationClearId };
}

/**
 * (subChatId, taskId) → the dispatch's task-resolved mode, written at `task:chat-ready`.
 * A send carrying the matching `dispatchTaskId` binds to this mode instead of renderer state
 * (decision `sub-chat-mode-ownership`, machine-turn amendment); user sends never carry the id.
 * Keyed per task so overlapping dispatches into one reused sub-chat each keep their binding.
 */
const pendingDispatchMode = new Map<string, { mode: ChatMode; registeredAtMs: number }>();

const PENDING_DISPATCH_TTL_MS = 15 * 60 * 1000;

const dispatchKey = (subChatId: string, taskId: string) => `${subChatId}\u0000${taskId}`;

/** taskId → the sub-chat its turn was dispatched into, so a Cancel still reaches a turn whose
 * `result.subChatId` stamp failed. Past the soft cap, only settled entries (no live turn) prune. */
const dispatchedSubChatByTask = new Map<string, { subChatId: string; registeredAtMs: number }>();
const DISPATCHED_SOFT_CAP = 500;
const DISPATCH_SETTLE_MS = 60_000;

export function getDispatchedSubChatForTask(taskId: string): string | null {
  return dispatchedSubChatByTask.get(taskId)?.subChatId ?? null;
}

function pruneSettledDispatches(nowMs: number): void {
  for (const [taskId, entry] of dispatchedSubChatByTask) {
    if (dispatchedSubChatByTask.size <= DISPATCHED_SOFT_CAP) return;
    const settled = nowMs - entry.registeredAtMs > DISPATCH_SETTLE_MS;
    if (settled && !getActiveExecution(entry.subChatId)) dispatchedSubChatByTask.delete(taskId);
  }
}

export function registerPendingDispatchMode(
  subChatId: string,
  taskId: string,
  startMode: ResolvedTaskStartMode,
): void {
  pendingDispatchMode.set(dispatchKey(subChatId, taskId), {
    mode: toChatMode(startMode),
    registeredAtMs: Date.now(),
  });
  const nowMs = Date.now();
  dispatchedSubChatByTask.delete(taskId);
  dispatchedSubChatByTask.set(taskId, { subChatId, registeredAtMs: nowMs });
  pruneSettledDispatches(nowMs);
}

/**
 * PEEK: the task-resolved mode for a send carrying the registered dispatch's task id; null for
 * any other send (user replies never carry one and resolve `intent ?? row` as usual). Does not
 * consume: call {@link consumeDispatchMode} once the matched send's row write has landed.
 */
export function matchDispatchModeForSend(
  subChatId: string,
  dispatchTaskId: string | undefined,
): ChatMode | null {
  if (!dispatchTaskId) return null;
  const key = dispatchKey(subChatId, dispatchTaskId);
  const record = pendingDispatchMode.get(key);
  if (!record) return null;
  if (Date.now() - record.registeredAtMs > PENDING_DISPATCH_TTL_MS) {
    pendingDispatchMode.delete(key);
    return null;
  }
  log.info('[DispatchRegistry] task-dispatched send bound to task mode', {
    subChatId,
    mode: record.mode,
  });
  return record.mode;
}

/** Settle a matched record after its send's mode write landed (write failure → record stays). */
export function consumeDispatchMode(subChatId: string, dispatchTaskId: string): void {
  pendingDispatchMode.delete(dispatchKey(subChatId, dispatchTaskId));
}
