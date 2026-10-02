/**
 * In-process chat dispatch and the main→renderer event bridge (`socket:*` IPC channels).
 * Runs in the Electron main process.
 */

import { randomUUID } from 'node:crypto';
import { BrowserWindow } from 'electron';
import log from 'electron-log';
import type {
  AssistantMessageMetadata,
  TranscriptTerminalDurability,
} from '../../../shared/types/assistant-message';
import type { ChatMode } from '../../../shared/types/chat-mode';
import type { ExecutionSettings } from '../../../shared/types/execution';
import type {
  SocketPermissionProjection as PermissionRequestPayload,
  SocketPermissionResponsePayload as PermissionResponsePayload,
} from '../../../shared/types/permissions';
import type { ApprovedPlanContext } from '../../../shared/types/plan';
import type { WakeHoldChangedPayload } from '../../../shared/types/wake-hold';
import { getDatabase } from '../db';
import { assertChatLogin } from '../db/repos/project-ai-accounts';
import { withSubChatLock } from '../db/repos/sub-chat-mutex';
import {
  appendUserMessage as appendUserMessageLocal,
  getSubChatById as getSubChatByIdLocal,
  markPlanApproved as markPlanApprovedLocal,
  resolveSendMode as resolveSendModeLocal,
  setStreamId as setStreamIdLocal,
} from '../db/repos/sub-chats';
import { consumeDispatchMode, matchDispatchModeForSend } from '../task-executor/dispatch-registry';
import { abortIfTaskNoLongerRunning } from '../tasks/dispatch-cancel-fence';
import { runSendSideNaming } from './naming';
import { withMessageAdmission } from './execution/send-admission';
import { createLiveStreamTransport } from './streaming/live-stream/transport';

// Socket-specific message types (compatible with but distinct from renderer types)
export type MessagePart = {
  type: string;
  text?: string;
  mimeType?: string;
  data?: string;
  [key: string]: unknown;
};

type Message = {
  id: string;
  role: 'user' | 'assistant' | 'system';
  parts: MessagePart[];
  metadata?: AssistantMessageMetadata & {
    answeredQuestions?: Array<{ label: string; answer: string }>;
  };
};

// ============ Types ============

export type MessageSendPayload = {
  chatId: string;
  subChatId: string;
  projectId: string;
  trigger?: 'submit-message' | 'regenerate-message';
  userMessage: Message;
  /**
   * Explicit mode TRANSITION INTENT — present only when this send changes the sub-chat's mode
   * (footer toggle, plan approval, first turn of a not-yet-persisted sub-chat). Absent means
   * "no opinion": `sendMessage` resolves the mode from the sub-chat row, the single owner of
   * mode state, so a stale renderer store can never re-open a turn in a mode the user already
   * left (decision `sub-chat-mode-ownership`).
   */
  mode?: ChatMode;
  history?: Array<{ role: 'user' | 'assistant'; content: string }>;
  settings?: ExecutionSettings;
  /**
   * Approved plan context — injected into execution turns so the executor knows
   * what plan was approved, even when provider session memory is stale or missing.
   * Only set when mode=agent and the previous turn was a plan turn with an approval.
   */
  approvedPlanContext?: ApprovedPlanContext;
  /** Dynamic-chat navigation session continuity across chat switches. */
  navigationSessionId?: string;
  /**
   * Must match the in-memory flow continuation task for this chat when applying the override
   * (see executor `expectedFlowTaskId`).
   */
  expectedFlowTaskId?: string;
  dispatchTaskId?: string; // machine-dispatch identity → dispatch-registry mode binding
  /** Originating `webContents.id` when sending from Electron tRPC (for window-scoped abort). */
  sourceWebContentsId?: number;
};

export type StreamChunkPayload = {
  chatId: string;
  subChatId: string;
  assistantMessageId: string;
  chunk: unknown;
  /** Main-local recovery/checkpoint snapshot; stripped from the renderer IPC payload. */
  parts?: MessagePart[];
  messageIndex: number;
  /** Main-minted run identity; numeric indices and assistant ids may be reused. */
  streamEpoch?: string;
  /** Main-local provenance: only wake-pump chunks may resume an exact held epoch. */
  wakeBurst?: boolean;
};

export type ExecuteCompletePayload = {
  chatId: string;
  subChatId: string;
  assistantMessageId: string;
  sessionId?: string;
  metadata?: Message['metadata'];
  /** Optional authoritative final message parts snapshot. */
  finalParts?: MessagePart[];
  /**
   * True when this completion belongs to a between-turn wake burst rather than a turn some
   * transport started. It is the observer lane's OWNERSHIP signal: only the producer knows which
   * lane owns a run, and a consumer inferring it from `hasActiveTransport` gets it wrong — on a
   * pane remount the transport's own execute-complete listener registers first, so its
   * `finalizeRun` clears that flag before the observer's handler reads it in the same dispatch.
   */
  wakeBurst?: boolean;
  /** Foreground completion whose assistant message continues through a held wake pump. */
  continuesWakeHold?: boolean;
  streamEpoch?: string;
  /** Producer-declared lane; avoids same-dispatch transport ownership inference in renderer. */
  observerOwned?: boolean;
};

export type ErrorPayload = {
  chatId: string;
  subChatId: string;
  error: string;
  assistantMessageId?: string;
  /** Session UUID we attempted to resume; used by Frink Cloud to clear stale rows safely */
  failedSessionId?: string;
  /** Error classification (e.g. 'RATE_LIMIT_SDK') — drives renderer toast + failure handling */
  category?: string;
  streamEpoch?: string;
  terminalDurability?: TranscriptTerminalDurability;
};

export type StopPayload = {
  chatId: string;
  subChatId: string;
};

type ExecuteRequestPayload = {
  chatId: string;
  subChatId: string;
  projectId: string;
  message: string;
  /** Full user message parts (text + file/image) so executor can send images to Claude SDK */
  userMessageParts?: MessagePart[];
  mode: ChatMode;
  history?: Array<{ role: 'user' | 'assistant'; content: string }>;
  settings?: ExecutionSettings;
  assistantMessageId?: string;
  streamId?: string;
  sessionId?: string;
  continuity?: {
    status: 'ok' | 'degraded';
    reason?: string;
  };
  /** Approved plan context — injected into execution prompts to survive session loss */
  approvedPlanContext?: ApprovedPlanContext;
  /** Dynamic-chat navigation session continuity across chat switches. */
  navigationSessionId?: string;
  /** Flow continuation guard — must match active map entry to use continuation task id. */
  expectedFlowTaskId?: string;
  sourceWebContentsId?: number;
  onExecutionStarted?: (error?: Error) => void;
};

export type { PermissionRequestPayload, PermissionResponsePayload };

/** Tells the renderer to pop a pending prompt from its queue (e.g. on timeout)
 *  so a re-request doesn't stack onto a dead card. */
export type PermissionDismissPayload = {
  requestId: string;
  chatId?: string;
  subChatId?: string;
};

// ============ Event Callbacks ============

export type ExecuteRequestCallback = (payload: ExecuteRequestPayload) => void;
export type StopCallback = (payload: StopPayload) => void;
export type PermissionRequestCallback = (payload: PermissionRequestPayload) => void;
export type PermissionResponseCallback = (payload: PermissionResponsePayload) => void;

/** Unsubscribe function returned by each `on*` registrar. */
export type SocketEventUnsubscribe = () => void;

const executeRequestListeners = new Set<ExecuteRequestCallback>();
const stopListeners = new Set<StopCallback>();
const permissionRequestListeners = new Set<PermissionRequestCallback>();
const permissionResponseListeners = new Set<PermissionResponseCallback>();

function notifyListeners<P>(listeners: Set<(payload: P) => void>, payload: P): void {
  for (const fn of [...listeners]) {
    try {
      fn(payload);
    } catch (err) {
      log.error('[Socket] Event listener threw:', err);
    }
  }
}

// ============ Outgoing Events ============

/**
 * Persists the user message (and any plan approval) before dispatching the executor: the writes
 * are awaited so the renderer's read-after-send sees the new row.
 */
export async function sendMessage(
  payload: MessageSendPayload,
  options?: { rejectIfBusy: boolean; beforeSend?: () => Promise<void> },
): Promise<void> {
  if (options?.rejectIfBusy && executeRequestListeners.size === 0) {
    throw new Error('Chat execution is not ready.');
  }
  await withMessageAdmission(
    payload.subChatId,
    options?.rejectIfBusy ?? false,
    async (started) => {
      try {
        await options?.beforeSend?.();
        await persistAndDispatchMessage(payload, started, options?.rejectIfBusy);
      } catch (error) {
        started(error instanceof Error ? error : new Error('Could not start chat.'));
        throw error;
      }
    },
    options?.rejectIfBusy
      ? async () => {
          const subChat = await getSubChatByIdLocal(getDatabase(), payload.subChatId);
          return (
            subChat?.messages.some(
              (message) =>
                message !== null &&
                typeof message === 'object' &&
                'id' in message &&
                message.id === payload.userMessage.id,
            ) ?? false
          );
        }
      : undefined,
  );
}

/** The restart-resume gate reads `dispatchTaskId` as proof a task's prompt reached the chat, so only
 * the send's validated top-level id may set it; a copy inside caller metadata is dropped. */
function persistedUserMetadata(
  metadata: Message['metadata'],
  dispatchTaskId: string | undefined,
): Record<string, unknown> {
  const { dispatchTaskId: _supplied, ...rest } = (metadata ?? {}) as { dispatchTaskId?: unknown };
  return dispatchTaskId ? { ...rest, dispatchTaskId } : rest;
}

// Reason: Persistence and dispatch share one admission boundary; preserve their ordered writes.
// fallow-ignore-next-line complexity
async function persistAndDispatchMessage(
  payload: MessageSendPayload,
  onExecutionStarted: (error?: Error) => void,
  requirePersistence = false,
): Promise<void> {
  const { chatId, subChatId, dispatchTaskId } = payload;
  const messageText = payload.userMessage.parts?.find((p) => p.type === 'text')?.text ?? '';
  // A machine-dispatched prompt (flow/work-queue task) binds its mode from the dispatching
  // task, never from renderer state (`sub-chat-mode-ownership`, machine-turn amendment).
  const sendMode = matchDispatchModeForSend(subChatId, dispatchTaskId) ?? payload.mode;
  // Intent-or-row resolution BEFORE any persistence (see resolveSendMode), under the shared
  // per-sub-chat mutex so all sub_chats.mode writers serialize and every echo (the row's UI
  // mirror) announces its own landed write in order. Intents clear only via their correlated
  // acks, never echoes; the dispatch record settles only after the row write lands (fail→retry).
  const mode = await withSubChatLock(subChatId, async () => {
    const resolved = await resolveSendModeLocal(getDatabase(), subChatId, sendMode);
    if (dispatchTaskId) consumeDispatchMode(subChatId, dispatchTaskId);
    if (sendMode) sendSubChatModeChange({ chatId, subChatId, mode: sendMode });
    return resolved;
  });

  // 'submit-message' appends a fresh user message; 'regenerate-message' replays an existing one.
  if (payload.trigger !== 'regenerate-message') {
    try {
      const userMessage = {
        id: payload.userMessage.id,
        role: 'user' as const,
        parts: payload.userMessage.parts ?? [],
        ...(payload.userMessage.metadata || dispatchTaskId
          ? { metadata: persistedUserMetadata(payload.userMessage.metadata, dispatchTaskId) }
          : {}),
      };
      await appendUserMessageLocal(getDatabase(), payload.subChatId, userMessage);
      // A phone send has no desktop bubble: announce it before dispatch so it precedes the reply.
      // The sending window already holds this id and skips it.
      broadcastToRenderer('socket:message-saved', { chatId, subChatId, message: userMessage });
    } catch (err) {
      log.error('[Socket] Failed to persist user message locally:', err);
      if (requirePersistence) throw err;
    }

    // Fire-and-forget sub-chat + build-project naming (never blocks the send).
    runSendSideNaming({
      chatId: payload.chatId,
      subChatId: payload.subChatId,
      projectId: payload.projectId,
      userMessageParts: payload.userMessage.parts,
    });
  }

  if (payload.approvedPlanContext?.planId) {
    try {
      await markPlanApprovedLocal(
        getDatabase(),
        payload.subChatId,
        payload.approvedPlanContext.planId,
      );
    } catch (err) {
      log.error('[Socket] Failed to mark plan approved locally:', err);
    }
  }

  await assertChatLogin(getDatabase(), chatId, subChatId);
  // Synthesize the ExecuteRequestPayload and dispatch the executor in-process.
  const assistantMessageId = randomUUID();
  const streamId = randomUUID();

  let persistedSessionId: string | undefined;
  try {
    const subChat = await getSubChatByIdLocal(getDatabase(), payload.subChatId);
    persistedSessionId = subChat?.sessionId ?? undefined;
  } catch (err) {
    log.warn('[Socket] Local sub-chat session lookup failed:', err);
  }

  try {
    await setStreamIdLocal(getDatabase(), payload.subChatId, streamId);
  } catch (err) {
    log.warn('[Socket] Local setStreamId failed:', err);
  }

  if (executeRequestListeners.size === 0) throw new Error('Chat execution is not ready.');
  notifyListeners(executeRequestListeners, {
    chatId: payload.chatId,
    subChatId: payload.subChatId,
    projectId: payload.projectId,
    message: messageText,
    userMessageParts: payload.userMessage.parts,
    mode,
    history: payload.history,
    settings: payload.settings,
    assistantMessageId,
    streamId,
    sessionId: persistedSessionId,
    continuity: { status: 'ok' },
    approvedPlanContext: payload.approvedPlanContext,
    navigationSessionId: payload.navigationSessionId,
    expectedFlowTaskId: payload.expectedFlowTaskId,
    sourceWebContentsId: payload.sourceWebContentsId,
    // A dispatched turn re-checks its task once registered, closing the Cancel-before-start gap.
    onExecutionStarted: (error?: Error) => {
      onExecutionStarted(error);
      if (!error && dispatchTaskId) void abortIfTaskNoLongerRunning(dispatchTaskId, subChatId);
    },
  });
}

export function sendStop(payload: StopPayload): void {
  notifyListeners(stopListeners, payload);
  broadcastToRenderer('socket:stop', payload);
}

// ============ Permission Events ============

export function sendPermissionRequest(payload: PermissionRequestPayload): void {
  notifyListeners(permissionRequestListeners, payload);
  broadcastToRenderer('socket:permission-request', payload);
}

export function sendPermissionResponse(payload: PermissionResponsePayload): void {
  notifyListeners(permissionResponseListeners, payload);
  broadcastToRenderer('socket:permission-response', payload);
}

/** Mirror of {@link sendPermissionRequest}: tell every renderer to pop a prompt that was
 *  answered elsewhere, timed out, or aborted. */
export function sendPermissionDismiss(payload: PermissionDismissPayload): void {
  broadcastToRenderer('socket:permission-dismiss', payload);
}

// ============ Callback Registration ============

export function onExecuteRequest(callback: ExecuteRequestCallback): SocketEventUnsubscribe {
  executeRequestListeners.add(callback);
  return () => {
    executeRequestListeners.delete(callback);
  };
}

export function onStop(callback: StopCallback): SocketEventUnsubscribe {
  stopListeners.add(callback);
  return () => {
    stopListeners.delete(callback);
  };
}

export function onPermissionRequest(callback: PermissionRequestCallback): SocketEventUnsubscribe {
  permissionRequestListeners.add(callback);
  return () => {
    permissionRequestListeners.delete(callback);
  };
}

export function onPermissionResponse(callback: PermissionResponseCallback): SocketEventUnsubscribe {
  permissionResponseListeners.add(callback);
  return () => {
    permissionResponseListeners.delete(callback);
  };
}

// ============ IPC Bridge ============

// `isDestroyed()` stays FALSE across a renderer crash (only the frame dies) — check both.
export function broadcastToRenderer(channel: string, payload: unknown): void {
  for (const win of BrowserWindow.getAllWindows()) {
    if (!win.isDestroyed() && !win.webContents.isCrashed()) win.webContents.send(channel, payload);
  }
}

/** Mode changed mid-turn (e.g. agent → plan at EnterPlanMode); keeps the renderer's
 * input-bar mode toggle in sync with the actual session state. */
export function sendSubChatModeChange(payload: {
  chatId: string;
  subChatId: string;
  mode: ChatMode;
}): void {
  broadcastToRenderer('socket:sub-chat-mode-changed', payload);
}

/** Sub-chat is (or is no longer) held open waiting on background work. Nothing else
 * distinguishes "waiting between wake bursts" from "finished" (no transport, no observed run,
 * status 'ready' either way); the renderer withholds the end-of-turn treatment while true.
 * `pending` is re-sent per burst off THAT burst's own stop — the arming snapshot only shrinks
 * into a lie, which is why this used to carry no detail. */
export function sendWakeHoldChanged(payload: WakeHoldChangedPayload): void {
  broadcastToRenderer('socket:wake-hold-changed', payload);
}

export const {
  sendErrorDirect,
  sendExecuteCompleteDirect,
  sendStreamChunkDirect,
  sendStreamSettledDirect,
} = createLiveStreamTransport({
  broadcast: broadcastToRenderer,
});

/**
 * Notify the renderer immediately when a task signal has been persisted to the DB.
 * The renderer uses this to optimistically update task status without waiting for the stream to end.
 */
export function broadcastTaskSignalPersisted(payload: {
  taskId: string;
  status: string;
  isFlowLinked: boolean;
}): void {
  broadcastToRenderer('socket:task-signal-persisted', payload);
}
