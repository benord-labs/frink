/**
 * In-memory registries written at task dispatch time and consumed at execution/send time.
 * Cleared on process exit; not persisted (restart invalidates in-flight runs, and a re-claim
 * that will actually re-send registers again through `handleClaimedTask`).
 */

import log from 'electron-log';
import { type ResolvedTaskStartMode, toChatMode } from '../../../shared/lib/trigger-rule-config';
import type { ChatMode } from '../../../shared/types/chat-mode';
import type { TaskChatReadyData } from '../../../shared/types/task-chat-ready';
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
 * The record also holds the dispatch's payload until its send lands, for a renderer that missed
 * the one-shot `task:chat-ready` event (see {@link listUndeliveredDispatches}).
 */
const pendingDispatchMode = new Map<
  string,
  { mode: ChatMode; registeredAtMs: number; payload?: TaskChatReadyData }
>();

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

/** taskId → its latest dispatch, kept past {@link consumeDispatchMode} so the undelivered-dispatch
 * watchdog (sc-2775) can re-send a prompt whose send landed but never started a turn. */
const lastDispatchByTask = new Map<
  string,
  { startMode: ResolvedTaskStartMode; payload: TaskChatReadyData; heldAtMs: number }
>();
/** Past the soft cap, only dispatches older than the watchdog's whole redeliver-then-fail window go:
 * a younger one may still need its redelivery. */
const REDELIVERY_HORIZON_MS = 30 * 60 * 1000;
/** Memory bound regardless of age: past it the oldest go, and their watchdog fails rather than resends. */
const HELD_DISPATCH_HARD_CAP = 5000;

/** A send's proof of which dispatch ATTEMPT it delivers: retries and re-claims reuse the task id. */
export type DispatchProvenance = { taskId: string; dispatchedAt: string };

/** The held flow dispatch a send delivers — only when it names that dispatch's attempt, so a stale
 * send from an earlier attempt of the same task never claims the current one. Peek, like the mode. */
export function heldDispatchProvenance(
  subChatId: string,
  taskId: string | undefined,
  generation: string | undefined,
): DispatchProvenance | null {
  if (!taskId || !generation) return null;
  const record = pendingDispatchMode.get(dispatchKey(subChatId, taskId));
  // No TTL: the generation is the proof, and a prompt may wait behind a long turn. Consume, forget
  // and redelivery clear a flow record.
  if (record?.payload?.dispatchGeneration !== generation) return null;
  return { taskId, dispatchedAt: generation };
}

/** The task's latest dispatch, for one redelivery; null when none is held (restart, evicted). */
export function getRedeliverableDispatch(
  taskId: string,
): { startMode: ResolvedTaskStartMode; payload: TaskChatReadyData } | null {
  const held = lastDispatchByTask.get(taskId);
  return held ? { startMode: held.startMode, payload: held.payload } : null;
}

export function registerPendingDispatchMode(
  subChatId: string,
  taskId: string,
  startMode: ResolvedTaskStartMode,
  payload?: TaskChatReadyData,
): void {
  pendingDispatchMode.set(dispatchKey(subChatId, taskId), {
    mode: toChatMode(startMode),
    registeredAtMs: Date.now(),
    payload,
  });
  if (payload) {
    lastDispatchByTask.delete(taskId);
    lastDispatchByTask.set(taskId, { startMode, payload, heldAtMs: Date.now() });
    // Insertion order is dispatch order: past the cap, the oldest dispatches are long settled.
    for (const [oldest, held] of lastDispatchByTask) {
      if (lastDispatchByTask.size <= DISPATCHED_SOFT_CAP) break;
      const young = Date.now() - held.heldAtMs < REDELIVERY_HORIZON_MS;
      if (young && lastDispatchByTask.size <= HELD_DISPATCH_HARD_CAP) break;
      lastDispatchByTask.delete(oldest);
    }
  }
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
  generation?: string,
): ChatMode | null {
  if (!dispatchTaskId) return null;
  const key = dispatchKey(subChatId, dispatchTaskId);
  const record = pendingDispatchMode.get(key);
  if (!record || !isSendForRecord(record, generation)) return null;
  const expired = Date.now() - record.registeredAtMs > PENDING_DISPATCH_TTL_MS;
  if (expired && !record.payload?.dispatchGeneration) {
    pendingDispatchMode.delete(key);
    return null;
  }
  log.info('[DispatchRegistry] task-dispatched send bound to task mode', {
    subChatId,
    mode: record.mode,
  });
  return record.mode;
}

/** Unsent dispatch payloads: a renderer that missed the one-shot `task:chat-ready` (reload, listener
 * not mounted yet) pulls these once listening; its queued/sent dedup makes re-delivery idempotent. */
export function listUndeliveredDispatches(): TaskChatReadyData[] {
  const nowMs = Date.now();
  return [...pendingDispatchMode.values()].flatMap((record) =>
    record.payload && nowMs - record.registeredAtMs <= PENDING_DISPATCH_TTL_MS
      ? [record.payload]
      : [],
  );
}

/** True until the dispatch's send lands ({@link consumeDispatchMode}). */
export function isDispatchPending(subChatId: string, taskId: string): boolean {
  return pendingDispatchMode.has(dispatchKey(subChatId, taskId));
}

type PendingDispatchRecord = NonNullable<ReturnType<typeof pendingDispatchMode.get>>;

/** sc-2775: a flow record belongs only to the send naming its attempt — a stale attempt's send must
 * neither take the current attempt's mode nor settle its record. Generation-less records match. */
function isSendForRecord(record: PendingDispatchRecord, generation: string | undefined): boolean {
  const held = record.payload?.dispatchGeneration;
  return held === undefined || held === generation;
}

/** Settle a matched record after its send's mode write landed (write failure → record stays).
 * Returns it so a send that then fails to start a turn can {@link restoreDispatchRecord} it. */
export function consumeDispatchMode(
  subChatId: string,
  dispatchTaskId: string,
  generation?: string,
): PendingDispatchRecord | undefined {
  const key = dispatchKey(subChatId, dispatchTaskId);
  const record = pendingDispatchMode.get(key);
  if (record && !isSendForRecord(record, generation)) return undefined;
  pendingDispatchMode.delete(key);
  if (record) noteDispatchSend(dispatchTaskId);
  return record;
}

/** taskId → when a send of its dispatch last landed in main (sc-2775). */
const lastSendByTask = new Map<string, number>();
/** A send this recent may still be on its way to admission: redelivering now would run it twice. */
const SEND_IN_FLIGHT_MS = 2 * 60 * 1000;

function noteDispatchSend(taskId: string): void {
  const now = Date.now();
  lastSendByTask.delete(taskId);
  lastSendByTask.set(taskId, now);
  // Bounded: an entry only matters for SEND_IN_FLIGHT_MS, and never more than the soft cap are kept
  // (insertion order is send order, so the oldest go first).
  for (const [id, at] of lastSendByTask) {
    if (now - at < SEND_IN_FLIGHT_MS && lastSendByTask.size <= DISPATCHED_SOFT_CAP) break;
    lastSendByTask.delete(id);
  }
}

export function isDispatchSendInFlight(taskId: string): boolean {
  const at = lastSendByTask.get(taskId);
  if (at === undefined) return false;
  if (Date.now() - at < SEND_IN_FLIGHT_MS) return true;
  lastSendByTask.delete(taskId);
  return false;
}

/** sc-2775: a consumed dispatch whose send never started a turn is still pending — unless it is no
 * longer the task's latest dispatch. */
export function restoreDispatchRecord(
  subChatId: string,
  dispatchTaskId: string,
  record: PendingDispatchRecord,
): void {
  const key = dispatchKey(subChatId, dispatchTaskId);
  const latest = lastDispatchByTask.get(dispatchTaskId)?.payload;
  if (latest !== record.payload || pendingDispatchMode.has(key)) return;
  pendingDispatchMode.set(key, record);
}

/** sc-2775: a dispatch the watchdog failed must not be pulled or re-sent later. */
export function forgetDispatch(subChatId: string, taskId: string): void {
  pendingDispatchMode.delete(dispatchKey(subChatId, taskId));
  lastDispatchByTask.delete(taskId);
  lastSendByTask.delete(taskId);
}

/** The live dispatched turns, by abort signal: which step each one is delivering (sc-2775). */
const deliveringTurns = new WeakMap<AbortSignal, string>();

export function markDeliveringTurn(signal: AbortSignal, taskId: string): void {
  deliveringTurns.set(signal, taskId);
}

export function unmarkDeliveringTurn(signal: AbortSignal): void {
  deliveringTurns.delete(signal);
}

export function deliveringTaskOf(signal: AbortSignal): string | undefined {
  return deliveringTurns.get(signal);
}

/** True while the sub-chat's live turn is delivering this task's dispatch. Synchronous, so a claim
 * reading it right before its own write cannot miss a delivery that is mid-stamp. */
export function isTaskBeingDelivered(taskId: string, subChatId: string): boolean {
  const live = getActiveExecution(subChatId);
  return live !== undefined && deliveringTurns.get(live.controller.signal) === taskId;
}
