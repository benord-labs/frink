/* eslint-disable max-lines, max-lines-per-function */
/** biome-ignore-all lint/style/useNamingConvention: Support for screaming snake case object keys */
/**
 * WebSocket Chat Transport
 *
 * Unified transport for all chat execution via WebSocket.
 * All messages flow through the socket server for real-time sync.
 * Execution happens on the machine with project files.
 */

import * as Sentry from '@sentry/electron/renderer';
import type { ChatTransport, UIMessage, UIMessageChunk } from 'ai';
import { toast } from 'sonner';
import type { UIMessageChunk as BaseUIMessageChunk } from '../../../../main/lib/claude/types';
import { stripMessageMarkers } from '../../../../shared/lib/message-markers/strip-message-markers';
import {
  claudeModelRequires1M,
  getClaudeEffortSettings,
  getClaudeThinkingBudget,
} from '../../../../shared/lib/models';
import { isUserAbortErrorMessage } from '../../../../shared/lib/user-abort-error';
import { isPlanApprovalTriggerText } from '../../../../shared/types/plan';
import { normalizeErrorTextPrefix } from '../../../../shared/utils/error-prefixes';
import {
  ERROR_TOAST_CONFIG,
  shouldPersistChatRetry,
  toastDedupId,
} from '../../../lib/agent-chat/errors/error-toast-config';
import {
  extendedThinkingEnabledAtom,
  type MCPServer,
  pendingAccountAuthAtom,
  sessionInfoAtom,
} from '../../../lib/atoms';
import { codexFastModeSetting } from '../../../lib/atoms/codex-fast-mode';
import { appStore } from '../../../lib/jotai-store';
import {
  activeListeners,
  observedRunAtomFamily,
} from '../../../lib/stores/active-transport-registry';
import {
  ackModeIntent,
  armModeIntentIfEmpty,
  takeModeIntentForSend,
} from '../../../lib/stores/mode-intent';
import { trpcClient } from '../../../lib/trpc';
import { messagesHaveFlowDrivenPlanReady } from '../../../utils/flow-plan';
import {
  approvedPlanContextAtomFamily,
  autoModePerChatAtomFamily,
  compactingSubChatsAtom,
  enableTasksAtom,
  lastSelectedModelIdAtomFamily,
  navigationSessionIdAtomFamily,
  pendingChatRetryAtomFamily,
  retryInFlightAtomFamily,
  taskExecutionErrorAtomFamily,
} from '../atoms';
import {
  type ExecutionAccountKind,
  resolveExecutionModelCliString,
  supportsNativeAutoReview,
} from '../lib/resolve-execution-model-cli';
import { createTaskExecutionErrorSignal, isExecutionLevelFailure } from '../main/active-chat/utils';
import { applyRollbackFilter } from '../stores/message-store';
import { useStreamingStatusStore } from '../stores/streaming-status-store';
import { useAgentSubChatStore } from '../stores/sub-chat-store';
import { applyAskUserQuestionChunk } from './ask-user-question-chunks';
import {
  type ExtractedImage,
  extractImages,
  extractText,
  type ResolvedImagePart,
} from './message-parts';
import { FLOW_DISPATCH_SOURCE } from './queue-utils';

const MESSAGE_SEND_TIMEOUT_MS = 30_000;

// Extended chunk type with debug info
type ExtendedUIMessageChunk = BaseUIMessageChunk & {
  debugInfo?: {
    category?: string;
    [key: string]: unknown;
  };
};

function hasDebugInfo(
  chunk: BaseUIMessageChunk,
): chunk is BaseUIMessageChunk & { debugInfo: { category?: string } } {
  return 'debugInfo' in chunk && typeof chunk.debugInfo === 'object' && chunk.debugInfo !== null;
}

type WebSocketChatTransportConfig = {
  chatId: string;
  subChatId: string;
  projectId: string;
  mode: 'plan' | 'agent' | 'debug';
  /**
   * Resolved AI account for this chat/project — read at send time (not ctor snapshot only).
   */
  getExecutionAccountType: () => ExecutionAccountKind;
  /**
   * Parent chat's linked task id when known — forwarded so the executor only applies the
   * flow-continuation in-memory override when it matches (see `expectedFlowTaskId`).
   */
  expectedFlowTaskId?: string | null;
  /** When execution fails, call with subChatId so UI can remove the failed send */
  onExecutionError?: (subChatId: string) => void;
  /** When execution completes (e.g. execute:complete), call so UI can refetch chat and show persisted message if stream was missed */
  onExecuteComplete?: (chatId: string) => void;
};

function normalizeErrorText(raw: string): string {
  return normalizeErrorTextPrefix(raw, { stripRetriablePrefix: true });
}

function shouldRollbackExecutionError(rawError: string, category: string): boolean {
  return isExecutionLevelFailure(rawError, category);
}

/**
 * Post-surface follow-ups for a failed turn: roll the send back only for execution-level
 * failures, and offer a persisted Retry only for retryable categories. The retry write is last,
 * deliberately — it is localStorage-backed and can throw (quota); nothing may depend on it.
 */
function dispatchFailureFollowups(
  errorText: string,
  category: string,
  rollback: () => void,
  persistRetry: (errorCategory: string, rawErrorText: string) => void,
): void {
  if (shouldRollbackExecutionError(errorText, category)) {
    rollback();
  }
  if (shouldPersistChatRetry(category)) {
    persistRetry(category, errorText);
  }
}

/** Latch the per-sub-chat error signal and show the category's toast (or the generic one). */
function surfaceExecutionError(
  subChatId: string,
  errorText: string,
  category: string | undefined,
): void {
  appStore.set(
    taskExecutionErrorAtomFamily(subChatId),
    createTaskExecutionErrorSignal(errorText, category),
  );
  const toastConfig = ERROR_TOAST_CONFIG[category ?? 'UNKNOWN'];
  toast.error(toastConfig?.title ?? 'Execution failed', {
    description: toastConfig?.description || errorText || 'Unknown error',
    action: toastConfig?.action,
    ...toastDedupId(toastConfig, subChatId),
  });
}

function isUserInitiatedAbortError(rawError: string): boolean {
  const normalized = normalizeErrorText(rawError);
  return isUserAbortErrorMessage(normalized);
}

// activeListeners (the live-transport Map) + hasActiveTransport live in a dependency-free module
// (lib/stores/active-transport-registry) so lightweight readers can check liveness without importing
// this transport and its trpc/Sentry deps. Re-exported here to keep the public API stable.
const inFlightSendsBySubChat = new Map<string, number>();

export { hasActiveTransport } from '../../../lib/stores/active-transport-registry';

/** Remove a sub-chat's socket listeners; teardown also closes the stream so its sender settles. */
export function cleanupTransportListeners(subChatId: string, clearInFlight = true): void {
  const cleanup = activeListeners.get(subChatId);
  if (cleanup) {
    cleanup(clearInFlight);
    activeListeners.delete(subChatId);
  }
  if (clearInFlight) {
    // Defensive cleanup for interrupted/destroyed sub-chats while sends are in-flight.
    inFlightSendsBySubChat.delete(subChatId);
    // Teardown only (chat deleted/moved, or the run aborted): the flag must not outlive the chat
    // and strand a streaming indicator. Deliberately NOT on the `false` path — that one runs at the
    // START of every send, and a wake burst adopted via takeWakeHold keeps streaming under its own
    // assistant id long after. Clearing there would make the observer lane skip that burst's
    // finalParts on its later execute-complete, silently losing its tail.
    appStore.set(observedRunAtomFamily(subChatId), false);
  }
}

/** The execution settings a send from this chat carries, read from its settings at call time. */
function buildExecutionSettings(chatId: string, accountType: ExecutionAccountKind) {
  const selectedModelId = appStore.get(lastSelectedModelIdAtomFamily(chatId));
  const isClaude = accountType === 'claude-code';
  // The thinking budget is Claude-Code-only: Codex carries its own reasoning_effort field.
  const maxThinkingTokens =
    isClaude && appStore.get(extendedThinkingEnabledAtom)
      ? (getClaudeThinkingBudget(selectedModelId) ?? 32_000)
      : undefined;
  return {
    maxThinkingTokens,
    ...(maxThinkingTokens != null ? getClaudeEffortSettings(selectedModelId) : {}),
    model: resolveExecutionModelCliString(accountType, selectedModelId),
    enableTasks: appStore.get(enableTasksAtom),
    // Enable 1M context beta when a 1M model variant is selected (Claude SDK only)
    ...(isClaude && claudeModelRequires1M(selectedModelId) && { betas: ['context-1m-2025-08-07'] }),
    // One Auto value governs every turn in this chat, whoever sent it: a Flow seeds it on dispatch.
    // Plan mode is NOT excluded — the executor still opens a plan turn in `permissionMode: 'plan'`,
    // but can only arm the reviewer at plan approval if it knows the chat consented.
    ...(appStore.get(autoModePerChatAtomFamily(chatId)) &&
    supportsNativeAutoReview(accountType, selectedModelId)
      ? { autoReviewTools: true }
      : {}),
    ...codexFastModeSetting(chatId, selectedModelId),
  };
}

/** Start this chat's CLI with what its next send carries (Approve's agent mode if a plan waits). */
export function requestClaudePrewarm(chatId: string, subChatId: string, awaitingApproval: boolean) {
  const settings = buildExecutionSettings(chatId, 'claude-code');
  const mode = awaitingApproval ? 'agent' : takeModeIntentForSend(subChatId);
  void trpcClient.socket.prewarmClaudeSession
    .mutate({ chatId, subChatId, mode, settings })
    .catch(() => {});
}

/** Execution goes renderer→main over IPC, so images stay inline base64. */
function resolveOutgoingImages(images: ExtractedImage[]): ResolvedImagePart[] {
  return images.map((img) => ({ mimeType: img.mimeType, data: img.data }));
}

export class WebSocketChatTransport implements ChatTransport<UIMessage> {
  constructor(private config: WebSocketChatTransportConfig) {}

  /**
   * Reconnect to an existing stream (for background streaming support)
   */
  async reconnectToStream(_options: {
    chatId: string;
  }): Promise<ReadableStream<UIMessageChunk> | null> {
    // TODO: Implement stream reconnection via WebSocket
    // For now, return null (no reconnection support)
    return null;
  }

  async sendMessages(options: {
    trigger: 'submit-message' | 'regenerate-message';
    chatId: string;
    messageId: string | undefined;
    messages: UIMessage[];
    abortSignal: AbortSignal | undefined;
  }): Promise<ReadableStream<UIMessageChunk>> {
    const { chatId, subChatId, projectId } = this.config;

    // Strip rolled-back messages — useChat's internal state still contains them
    // even after rollback, and would otherwise leak into the agent's context.
    const filteredMessages = applyRollbackFilter(subChatId, options.messages);

    // Extract prompt from last user message
    const lastUser = [...filteredMessages].reverse().find((m) => m.role === 'user');
    const prompt = extractText(lastUser);
    const images = extractImages(lastUser);

    // Machine-dispatch identity (queue item → metadata): forwarded top-level so main binds the
    // turn's mode to the dispatching task.
    const lastUserMetadata = lastUser?.metadata as
      | { source?: string; dispatchTaskId?: string }
      | undefined;
    const dispatchTaskId = lastUserMetadata?.dispatchTaskId || undefined;

    // A human reply on a parked flow plan approves it (`flow-agent-node-mode`); dispatched
    // prompts and armed toggles are exempt. The wipeable store's mode is never consulted.
    const isFlowDispatchedPrompt = lastUserMetadata?.source === FLOW_DISPATCH_SOURCE;
    if (
      options.trigger === 'submit-message' &&
      !isFlowDispatchedPrompt &&
      messagesHaveFlowDrivenPlanReady(filteredMessages) &&
      armModeIntentIfEmpty(subChatId, 'agent')
    ) {
      useAgentSubChatStore.getState().updateSubChatMode(subChatId, 'agent');
    }
    // Optional TRANSITION INTENT (`sub-chat-mode-ownership`); absent → main resolves the row.
    // A machine-dispatched send never takes it: main binds its mode by dispatch identity, and a
    // user toggle armed meanwhile stays armed for the user's own next turn (never falsely acked).
    const modeIntent = dispatchTaskId ? undefined : takeModeIntentForSend(subChatId);

    // Only offer Retry when the turn has something to re-send. Retry re-runs this same turn from
    // the message list, so the gate must match what the send actually carries — `images` already
    // excludes malformed image parts (missing base64Data), and file parts never reach the payload.
    const persistPendingRetry = (errorCategory: string, rawErrorText: string) => {
      if (!prompt && images.length === 0) return;
      appStore.set(pendingChatRetryAtomFamily(subChatId), {
        chatId,
        subChatId,
        projectId,
        trigger: options.trigger,
        messageId: options.messageId,
        errorCategory,
        errorText: normalizeErrorText(rawErrorText),
        createdAt: Date.now(),
      });
    };

    const history = filteredMessages.flatMap((m) => {
      if (m === lastUser || (m.role !== 'user' && m.role !== 'assistant')) return [];
      const content = stripMessageMarkers(extractText(m));
      return content ? [{ role: m.role as 'user' | 'assistant', content }] : [];
    });

    let ownedCleanup: (() => void) | null = null;
    const cleanupIfOwner = () => {
      const activeCleanup = activeListeners.get(subChatId);
      if (ownedCleanup && activeCleanup === ownedCleanup) {
        cleanupTransportListeners(subChatId);
      }
    };

    return new ReadableStream({
      cancel: cleanupIfOwner,
      start: async (controller) => {
        let timeoutId: ReturnType<typeof setTimeout> | null = null;
        let ackSend: () => void = () => {};
        const currentInFlightSends = (inFlightSendsBySubChat.get(subChatId) ?? 0) + 1;
        inFlightSendsBySubChat.set(subChatId, currentInFlightSends);

        try {
          // Room joining is handled by ChatView when the chat is opened

          // Clean up any existing listeners for this subChatId before adding new ones
          cleanupTransportListeners(subChatId, false);

          const sendAcked = new Promise<void>((resolve) => (ackSend = resolve));
          const cleanup = this.setupSocketListeners(
            subChatId,
            controller,
            persistPendingRetry,
            () => sendAcked,
          );
          ownedCleanup = cleanup;
          activeListeners.set(subChatId, cleanup);

          // Register abort handler BEFORE any await so a Stop click during
          // the image upload below still fires sendStop. Registering after
          // the upload would lose the abort event entirely while the upload
          // is in flight.
          if (options.abortSignal) {
            options.abortSignal.addEventListener('abort', async () => {
              if (timeoutId) clearTimeout(timeoutId);
              await trpcClient.socket.sendStop.mutate({ chatId, subChatId });
              // Aborted runs must not leave stale approved plan context behind.
              appStore.set(approvedPlanContextAtomFamily(subChatId), null);
              cleanupIfOwner();
              try {
                controller.close();
              } catch {
                // Already closed
              }
            });
          }

          // Upload AFTER registering the listener: a microtask before `start()` would let React flush
          // the SDK's `submitted` status while `!hasActiveTransport`, downgrading it to `ready`.
          const resolvedImages = resolveOutgoingImages(images);
          // Short-circuit if Stop was clicked during the upload — abort
          // handler has already run sendStop + cleanup; do not also send a
          // phantom sendMessage that the server would start executing.
          if (options.abortSignal?.aborted) {
            return;
          }
          const userMessage = {
            // Reuse the AI SDK's id so the persisted DB row matches the rendered
            // bubble. Without this, rollback-by-id can't locate freshly-sent
            // messages — the UI id and DB id would diverge.
            id: lastUser?.id ?? `msg-${Date.now()}`,
            role: 'user' as const,
            // Display-only provenance must reach persistence and other windows; the model reads
            // only `parts`, so this cannot become prompt context.
            ...(lastUser?.metadata ? { metadata: lastUser.metadata } : {}),
            parts: [
              { type: 'text' as const, text: prompt },
              ...resolvedImages.map((img) => ({
                type: 'file' as const,
                mimeType: img.mimeType,
                data: img.data,
              })),
            ],
          };
          // Set up timeout for message sending
          const timeoutPromise = new Promise<never>((_, reject) => {
            timeoutId = setTimeout(() => {
              reject(new Error('MESSAGE_TIMEOUT'));
            }, MESSAGE_SEND_TIMEOUT_MS);
          });
          const pendingApprovedPlanContext = appStore.get(approvedPlanContextAtomFamily(subChatId));
          const isPlanApprovalTurn = isPlanApprovalTriggerText(prompt);
          const approvedPlanContext = isPlanApprovalTurn
            ? (pendingApprovedPlanContext ?? undefined)
            : undefined;
          const navigationSessionValue = appStore.get(navigationSessionIdAtomFamily(subChatId));
          const navigationSessionId =
            typeof navigationSessionValue === 'string' && navigationSessionValue.length > 0
              ? navigationSessionValue
              : undefined;
          const shouldClearStaleContextAfterSuccess =
            !isPlanApprovalTurn && pendingApprovedPlanContext != null;

          // Send message via WebSocket with timeout (server handles persistence + routing)
          const sendResult = await Promise.race([
            trpcClient.socket.sendMessage.mutate({
              chatId,
              subChatId,
              projectId,
              trigger: options.trigger,
              userMessage,
              ...(modeIntent ? { mode: modeIntent } : {}),
              history: history.length > 0 ? history : undefined,
              settings: buildExecutionSettings(chatId, this.config.getExecutionAccountType()),
              // Include approved plan context for compression-safe execution handoff.
              approvedPlanContext,
              ...(navigationSessionId ? { navigationSessionId } : {}),
              ...(typeof this.config.expectedFlowTaskId === 'string' &&
              this.config.expectedFlowTaskId.length > 0
                ? { expectedFlowTaskId: this.config.expectedFlowTaskId }
                : {}),
              ...(dispatchTaskId ? { dispatchTaskId } : {}),
            }),
            timeoutPromise,
          ]);

          if (sendResult && sendResult.success === false) {
            throw new Error(sendResult.reason || 'Failed to send message');
          }

          // Clear timeout if message sent successfully
          if (timeoutId) clearTimeout(timeoutId);
          if (modeIntent) ackModeIntent(subChatId, modeIntent);
          // Clear approved plan context only after successful send.
          if (approvedPlanContext) {
            appStore.set(approvedPlanContextAtomFamily(subChatId), null);
          } else if (shouldClearStaleContextAfterSuccess) {
            const inFlightNow = inFlightSendsBySubChat.get(subChatId) ?? 0;
            const latestContext = appStore.get(approvedPlanContextAtomFamily(subChatId));
            // Avoid racing a concurrent trigger send for this same sub-chat.
            if (inFlightNow <= 1 && latestContext === pendingApprovedPlanContext) {
              appStore.set(approvedPlanContextAtomFamily(subChatId), null);
            }
          }

          // Enqueue start immediately so UI shows streaming/thinking state before first backend
          // chunk (a provider can take several seconds before first output)
          try {
            controller.enqueue({ type: 'start' } as UIMessageChunk);
          } catch {
            // Stream already closed
          }
        } catch (error) {
          // Clear timeout on error
          if (timeoutId) clearTimeout(timeoutId);

          const errorMessage = error instanceof Error ? error.message : String(error);

          // Determine error category and show appropriate toast
          let category = 'UNKNOWN';
          if (errorMessage === 'MESSAGE_TIMEOUT') {
            category = 'MESSAGE_TIMEOUT';
          } else if (
            errorMessage.includes('offline') ||
            errorMessage.includes('not currently online')
          ) {
            category = 'MACHINE_OFFLINE';
          } else if (
            errorMessage.includes('Socket not connected') ||
            errorMessage.includes('not connected')
          ) {
            category = 'SOCKET_NOT_CONNECTED';
          } else if (errorMessage.includes('network') || errorMessage.includes('ECONNREFUSED')) {
            category = 'NETWORK_ERROR';
          }

          const config = ERROR_TOAST_CONFIG[category];
          const title = config?.title || 'Failed to send message';
          const description = config?.description || errorMessage;

          toast.error(title, {
            description,
            action: config?.action,
            ...toastDedupId(config, subChatId),
          });
          if (shouldPersistChatRetry(category)) {
            persistPendingRetry(category, errorMessage);
          }

          controller.enqueue({
            type: 'error',
            errorText: errorMessage,
          } as UIMessageChunk);
          controller.close();
          cleanupIfOwner();
        } finally {
          ackSend();
          const remaining = (inFlightSendsBySubChat.get(subChatId) ?? 1) - 1;
          if (remaining <= 0) {
            inFlightSendsBySubChat.delete(subChatId);
          } else {
            inFlightSendsBySubChat.set(subChatId, remaining);
          }
        }
      },
    });
  }

  /**
   * Set up IPC listeners for socket events from main process
   */
  private setupSocketListeners(
    subChatId: string,
    controller: ReadableStreamDefaultController<UIMessageChunk>,
    persistPendingRetry: (errorCategory: string, rawErrorText: string) => void,
    awaitSendAck: () => Promise<void>,
  ): (closeStream?: boolean) => void {
    const desktopApi = window.desktopApi;

    if (!desktopApi) {
      return () => {};
    }

    let isClosed = false;
    /** assistantMessageId for the active run, sourced from execute:start and stream chunks. */
    let activeAssistantMessageId: string | null = null;
    let pendingExecuteCompletePayload: { subChatId: string; assistantMessageId?: string } | null =
      null;
    const seenToolInputIds = new Set<string>();

    const safeEnqueue = (chunk: UIMessageChunk) => {
      if (isClosed) return;
      try {
        controller.enqueue(chunk);
      } catch {
        isClosed = true;
      }
    };

    const safeClose = () => {
      if (isClosed) return;
      isClosed = true;
      try {
        controller.close();
      } catch {
        // Already closed
      }
    };

    let hasFinalized = false;
    const finalizeRun = () => {
      if (hasFinalized) return;
      hasFinalized = true;
      // Clear any stale approved plan context once the execution turn fully completes.
      appStore.set(approvedPlanContextAtomFamily(subChatId), null);
      safeEnqueue({ type: 'finish' } as UIMessageChunk);
      safeClose();
      useStreamingStatusStore.getState().setStatus(subChatId, 'ready');
      // Remove IPC listeners registered for this run. Without calling the stored
      // cleanup, preload ipcRenderer.on handlers stay attached across every future
      // stream, so each completed chat leaks a full set of socket:* listeners.
      const listenerCleanup = activeListeners.get(subChatId);
      activeListeners.delete(subChatId);
      listenerCleanup?.();
      // Refetch chat so UI shows persisted assistant message if stream was missed (e.g. new-chat first message)
      this.config.onExecuteComplete?.(this.config.chatId);
    };

    const cleanupExecuteStart =
      desktopApi.onSocketExecuteStart?.((payload) => {
        if (payload.subChatId !== subChatId) return;
        if (activeAssistantMessageId && payload.assistantMessageId !== activeAssistantMessageId) {
          Sentry.addBreadcrumb({
            category: 'socket-transport',
            level: 'warning',
            message: 'Ignored stale execute:start with mismatched assistantMessageId',
            data: {
              subChatId,
              activeAssistantMessageId,
              incomingAssistantMessageId: payload.assistantMessageId,
            },
          });
          return;
        }
        activeAssistantMessageId = payload.assistantMessageId;
        if (
          pendingExecuteCompletePayload &&
          pendingExecuteCompletePayload.assistantMessageId === activeAssistantMessageId
        ) {
          pendingExecuteCompletePayload = null;
          finalizeRun();
        }
      }) ?? (() => {});

    // Handle extended chunk types
    const handleExtendedChunk = (chunk: ExtendedUIMessageChunk) => {
      if (chunk.type === 'start' || chunk.type === 'start-step') {
        appStore.set(pendingChatRetryAtomFamily(subChatId), null);
        appStore.set(retryInFlightAtomFamily(subChatId), false);
      }

      // AskUserQuestion lifecycle (raise / expire / resolve / retire on move-on) — shared with the
      // observer lane so a wake burst's question raises the same card.
      applyAskUserQuestionChunk({
        chunk: chunk as Parameters<typeof applyAskUserQuestionChunk>[0]['chunk'],
        subChatId,
        parentChatId: this.config.chatId,
      });

      // Live "Compacting" affordances only (status-card label, context-meter pulse); the transcript
      // card is a separate surface fed by the same chunk. A FAILED compaction emits no boundary, so
      // anything other than 'input-streaming' must clear these or they stay on for the session.
      if (chunk.type === 'data-compact') {
        // SAFETY: only the compaction mapper mints data-compact, and its type declares data.state.
        const state = (chunk as ExtendedUIMessageChunk & { data?: { state?: string } }).data?.state;
        const compacting = new Set(appStore.get(compactingSubChatsAtom));
        if (state === 'input-streaming') compacting.add(subChatId);
        else compacting.delete(subChatId);
        appStore.set(compactingSubChatsAtom, compacting);
      }

      // Handle session init
      if (chunk.type === 'session-init') {
        const typedChunk = chunk as ExtendedUIMessageChunk & {
          tools: string[];
          mcpServers: Array<{ name: string; status: string }>;
          plugins: Array<{ name: string; path: string }>;
          skills: string[];
        };
        appStore.set(sessionInfoAtom, {
          tools: typedChunk.tools,
          mcpServers: typedChunk.mcpServers as MCPServer[],
          plugins: typedChunk.plugins,
          skills: typedChunk.skills,
        });
      }

      // Auth errors: a `claude-passthrough` account goes to ConnectClaudeAccountPage in "reauth"
      // mode; other sources surface the error in the stream and reconnect from Settings.
      if (chunk.type === 'auth-error') {
        void (async () => {
          try {
            const resolved = await trpcClient.claudeCode.getResolvedAccount.query({
              chatId: this.config.chatId,
              projectId: this.config.projectId ?? undefined,
            });
            if (resolved?.source === 'claude-passthrough') {
              appStore.set(pendingAccountAuthAtom, {
                accountLabel: resolved.label,
                mode: 'reauth',
                returnToSettings: false,
              });
            }
          } catch (err) {
            Sentry.captureException(err, {
              tags: { component: 'websocket-chat-transport', area: 'auth-error-routing' },
            });
          }
        })();
      }

      // Handle errors with toast
      if (chunk.type === 'error') {
        const rawError = (chunk as { errorText?: string }).errorText || 'WebSocket transport error';
        const category = hasDebugInfo(chunk) ? chunk.debugInfo.category || 'UNKNOWN' : 'UNKNOWN';
        if (isUserInitiatedAbortError(rawError)) {
          appStore.set(taskExecutionErrorAtomFamily(subChatId), null);
          return;
        }
        const normalizedError = normalizeErrorText(rawError);

        Sentry.captureException(new Error(rawError), {
          tags: { errorCategory: category },
          extra: {
            debugInfo: hasDebugInfo(chunk) ? chunk.debugInfo : undefined,
            chatId: this.config.chatId,
            subChatId,
          },
        });

        const config = ERROR_TOAST_CONFIG[category];
        const title = config?.title || 'Chat error';
        const description = config?.description || normalizedError || 'Unknown error';

        toast.error(title, {
          description,
          action: config?.action,
          ...toastDedupId(config, subChatId),
        });
        appStore.set(
          taskExecutionErrorAtomFamily(subChatId),
          createTaskExecutionErrorSignal(normalizedError, category),
        );
        if (shouldPersistChatRetry(category)) {
          persistPendingRetry(category, rawError);
        }

        if (shouldRollbackExecutionError(rawError, category)) {
          this.config.onExecutionError?.(subChatId);
        }
      }
    };

    // Stream chunk handler
    const cleanupStreamChunk = desktopApi.onSocketStreamChunk((payload) => {
      if (payload.subChatId !== subChatId) return;
      if (payload.assistantMessageId) {
        activeAssistantMessageId = payload.assistantMessageId;
      }
      const chunk = payload.chunk as ExtendedUIMessageChunk;
      if (chunk.type === 'tool-input-available') {
        seenToolInputIds.add(chunk.toolCallId);
      } else if (
        (chunk.type === 'tool-output-available' || chunk.type === 'tool-output-error') &&
        !seenToolInputIds.has(chunk.toolCallId)
      ) {
        // Maintain tool chunk ordering guarantees for UI reducers.
        const syntheticInput: UIMessageChunk = {
          type: 'tool-input-available',
          toolCallId: chunk.toolCallId,
          toolName: 'UnknownTool',
          input: {},
        };
        handleExtendedChunk(syntheticInput as ExtendedUIMessageChunk);
        safeEnqueue(syntheticInput);
        seenToolInputIds.add(chunk.toolCallId);
      }
      handleExtendedChunk(chunk);
      safeEnqueue(chunk as UIMessageChunk);

      if (
        pendingExecuteCompletePayload &&
        activeAssistantMessageId &&
        pendingExecuteCompletePayload.assistantMessageId === activeAssistantMessageId
      ) {
        pendingExecuteCompletePayload = null;
        finalizeRun();
      }
    });

    // Execute complete handler
    const cleanupExecuteComplete = desktopApi.onSocketExecuteComplete((payload) => {
      if (payload.subChatId !== subChatId) return;
      if (!payload.assistantMessageId) {
        // Some backends complete without a run-scoped assistant id.
        // Close immediately to avoid hanging transport listeners.
        finalizeRun();
        return;
      }
      // Buffer execute-complete if it arrives before first stream chunk.
      // We flush once run identity is established from execute:start or stream chunks.
      if (activeAssistantMessageId == null) {
        pendingExecuteCompletePayload = payload;
        return;
      }
      if (payload.assistantMessageId !== activeAssistantMessageId) return;
      finalizeRun();
    });

    // Error handler (execute:error from backend - show toast so user sees why message was rolled back)
    const cleanupError = desktopApi.onSocketError((payload) => {
      if (payload.subChatId !== subChatId) return;
      if (
        payload.assistantMessageId &&
        activeAssistantMessageId &&
        payload.assistantMessageId !== activeAssistantMessageId
      ) {
        // Stale socket:error from a previous run in the same sub-chat.
        return;
      }
      const errorText = normalizeErrorText(payload.error);
      if (payload.failedSessionId) {
        // Stale-resume failure: backend already cleared sub_chats.session_id (UUID-scoped).
        // Surfaces to Sentry/log dashboards via console; UX hint tracked in sc-698.
        // biome-ignore lint/suspicious/noConsole: intentional renderer-side observability hook
        console.warn('[WebSocketChatTransport] Stale Claude session cleared', {
          subChatId,
          failedSessionId: payload.failedSessionId,
          error: errorText,
        });
      }
      if (isUserInitiatedAbortError(errorText)) {
        const registeredCleanup = activeListeners.get(subChatId);
        registeredCleanup?.();
        activeListeners.delete(subChatId);
        safeClose();
        appStore.set(taskExecutionErrorAtomFamily(subChatId), null);
        appStore.set(approvedPlanContextAtomFamily(subChatId), null);
        useStreamingStatusStore.getState().setStatus(subChatId, 'ready');
        return;
      }
      // Category travels from the executor (e.g. 'RATE_LIMIT_SDK' on usage limit); without it
      // every error here classified as execution-level and mis-failed limit-interrupted tasks.
      const category = payload.category ?? 'UNKNOWN';
      surfaceExecutionError(subChatId, errorText, payload.category);
      safeEnqueue({
        type: 'error',
        errorText,
      } as UIMessageChunk);
      safeClose();
      appStore.set(approvedPlanContextAtomFamily(subChatId), null);
      useStreamingStatusStore.getState().setStatus(subChatId, 'ready');
      // Call the stored cleanup so IPC listeners registered for this run don't
      // survive the error — mirrors the user-abort branch above and finalizeRun.
      const errorPathCleanup = activeListeners.get(subChatId);
      activeListeners.delete(subChatId);
      errorPathCleanup?.();
      dispatchFailureFollowups(
        errorText,
        category,
        () => this.config.onExecutionError?.(subChatId),
        persistPendingRetry,
      );
    });

    // Message saved handler (confirmation from server)
    const cleanupMessageSaved = desktopApi.onSocketMessageSaved((payload) => {
      if (payload.subChatId !== subChatId) return;
      // Message confirmed saved by server
    });

    return (closeStream = false) => {
      // Teardown waits for the send result, so an unaccepted prompt still lands (or errors) first.
      if (closeStream) void awaitSendAck().then(safeClose);
      cleanupExecuteStart();
      cleanupStreamChunk();
      cleanupExecuteComplete();
      cleanupError();
      cleanupMessageSaved();
    };
  }
}
