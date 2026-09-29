/**
 * Handles `task:chat-ready` IPC events from the main process.
 *
 * When a task is claimed, main creates the chat row + broadcasts this event. We
 * create the Chat object HEADLESSLY (via the shared factory) and register it in
 * `agentChatStore`, then deliver the initial prompt through the global message
 * queue — so the agent streams regardless of which chat (if any) is selected.
 * The global `QueueProcessor` drains the queue; its account-readiness gate holds
 * the send until the resolved-account query (prefetched here) succeeds.
 *
 * Flow tasks (`headless`) never pull focus — they are watched from the flow-run
 * panel. Non-flow work-queue tasks navigate to their chat as before.
 */

import * as Sentry from '@sentry/electron/renderer';
import type { UIMessage } from 'ai';
import { useSetAtom, useStore } from 'jotai';
import { useEffect } from 'react';
import { parseTriggerBubbleMessage } from '../../../../shared/lib/trigger-bubble-marker';
import { type ResolvedTaskStartMode, toChatMode } from '../../../../shared/lib/trigger-rule-config';
import {
  isTaskChatReadyData,
  type TaskChatReadyData,
} from '../../../../shared/types/task-chat-ready';
import { focusAgentChatAtom } from '../../../lib/atoms';
import { codexFastModeAtomFamily } from '../../../lib/atoms/codex-fast-mode';
import { api } from '../../../lib/mock-api';
import { trpc, trpcClient } from '../../../lib/trpc';
import {
  autoModePerChatAtomFamily,
  chatModeAtomFamily,
  lastSelectedModelIdAtomFamily,
} from '../atoms';
import { createAgentChat } from '../lib/create-agent-chat';
import { createQueueItem, FLOW_DISPATCH_SOURCE, generateQueueId } from '../lib/queue-utils';
import { agentChatStore } from '../stores/agent-chat-store';
import { useMessageQueueStore } from '../stores/message-queue-store';

/** Delay before re-pulling undelivered dispatches after a failed pull. Exported for tests. */
export const UNDELIVERED_PULL_RETRY_MS = 2_000;

type MaybeUserMessage = { role?: string; parts?: Array<{ type?: string; text?: string }> };

/**
 * A headless FLOW dispatch swallowed by the alreadySent dedup is a silent stall: a first dispatch
 * is never alreadySent and a deliberate re-dispatch carries isRetry, so that state means a flow
 * prompt was dropped and its run will sit `running` with no stream — capture it. An
 * already-queued swallow is benign (the pending queue item still delivers the prompt).
 */
function reportSwallowedFlowDispatch(
  data: TaskChatReadyData,
  subChatId: string,
  alreadySent: boolean,
): void {
  if (!alreadySent || data.isRetry || !data.headless) return;
  Sentry.captureException(
    new Error('Flow dispatch swallowed by alreadySent dedup — run will not stream'),
    {
      tags: { source: 'useTaskIpcHandler', area: 'flow-run-restart-recovery' },
      extra: { taskId: data.taskId, subChatId },
    },
  );
}

/**
 * True when `message` is a user turn whose text already equals `promptText` (raw or
 * trigger-bubble-marker-stripped). Used to avoid re-sending a task's initial prompt when
 * `task:chat-ready` re-fires for a chat that already has it — a re-claimed task after a
 * heartbeat lapse, or a second app window receiving the same broadcast.
 */
function userMessageMatchesPrompt(message: MaybeUserMessage, promptText: string): boolean {
  if (message.role !== 'user' || !Array.isArray(message.parts)) return false;
  const existingText = message.parts
    .filter((part) => part?.type === 'text')
    .map((part) => part?.text ?? '')
    .join('')
    .trim();
  if (existingText.length === 0) return false;
  return (
    existingText === promptText ||
    parseTriggerBubbleMessage(existingText).fullPrompt.trim() === promptText
  );
}

export function useTaskIpcHandler() {
  const focusAgentChat = useSetAtom(focusAgentChatAtom);
  const store = useStore();
  const utils = trpc.useUtils();
  // getAgentChat/getAgentChats live on the `api` client (lib/mock-api), not the main-process `trpc`
  // agents router — matching queue-processor.tsx + chat-name-update-bridge.tsx.
  const apiUtils = api.useUtils();

  useEffect(() => {
    if (!window.desktopApi?.onTaskChatReady) return;

    const handleChatReady = (data: unknown) => {
      if (!isTaskChatReadyData(data)) return;

      const { chatId, subChatId } = data;
      const mode = toChatMode(data.startMode as ResolvedTaskStartMode);

      // data.headless == Boolean(task.flowRunId) — the flow-only signal (data.taskId is NOT
      // flow-only). Mark unconditionally, even when the Chat already exists: it heals a Chat
      // created before the flow linked the chat (whose turns would otherwise chime per node).
      // Every flow turn — fresh node or park-answer continuation — is preceded by this event.
      if (data.headless) {
        agentChatStore.markFlowChat(chatId);
      }

      // A Flow's Auto setting SEEDS the chat's own persisted setting, so every turn the Flow causes
      // runs the way the Flow does — the dispatched turn, an answer to its parked question, a
      // Resume, and a reply the user types. Re-asserted per node dispatch exactly like mode + model
      // below: the Flow governs while it runs, and afterwards the value is the user's to change.
      // Keyed on the value's presence, not `headless`, because a cloud fire-and-forget agent task
      // carries the Flow's setting without a flow_run_id link (see resolveFlowAutoReviewToolsForTask).
      if (typeof data.autoReviewTools === 'boolean') {
        store.set(autoModePerChatAtomFamily(chatId), data.autoReviewTools);
      }

      // Same seed-and-re-assert contract for Codex Fast. Setting `false` matters as much as `true`:
      // the chat's value persists past the run, so a flow with Fast off must actively clear one a
      // previous Fast run left on rather than inheriting its billing.
      if (typeof data.codexFastMode === 'boolean') {
        store.set(codexFastModeAtomFamily(chatId), data.codexFastMode);
      }

      // Mode + model must be set before the queued prompt is sent: the transport reads the chat
      // mode and selected model at send time. Per-node flow agents each carry their own startMode,
      // so re-set these for THIS task (a plan node then an execute node in the same chat each land
      // the correct mode).
      store.set(chatModeAtomFamily(chatId), mode);
      if (data.model) {
        store.set(lastSelectedModelIdAtomFamily(chatId), data.model);
      }

      // The flow's start_task→agent dispatch just linked chats.taskId server-side. The open chat's
      // header reads agentChat.taskId from getAgentChat (staleTime, not polled), so refresh it here
      // so the "Task" badge appears live — matching the sidebar. Single-chat query, not the
      // paginated sidebar list, so this is safe (unlike invalidating chats.listByFolder).
      void apiUtils.agents.getAgentChat.invalidate({ chatId });

      void (async () => {
        // Create the Chat HEADLESSLY so it streams regardless of the selected tab. Idempotent: a
        // mounted ActiveChat (or a prior agent in the same chat) may already own the Chat — reuse
        // it rather than orphaning the in-flight stream.
        if (!agentChatStore.has(subChatId)) {
          // Seed DB history so a continue_chat agent (or a cold-continue after an app restart)
          // keeps prior context. Fresh chats return []. Best-effort: the server resumes the Claude
          // session for continue_chat even if this fails.
          let initialMessages: UIMessage[] = [];
          try {
            const res = await trpcClient.chats.getSubChatMessages.query({ subChatId });
            initialMessages = (res?.messages ?? []) as UIMessage[];
          } catch {
            // keep [] — server session resume covers continuation context
          }
          // Re-check after the await — a mounting ActiveChat may have created it meanwhile.
          if (!agentChatStore.has(subChatId)) {
            createAgentChat({
              chatId,
              subChatId,
              projectId: data.projectId ?? '',
              mode,
              initialMessages,
              projectPath: data.projectPath ?? undefined,
              // Read at SEND time from the resolved-account cache (prefetched below). QueueProcessor's
              // account-gate holds the send until that query succeeds, so this returns the real
              // account — never a premature default.
              getExecutionAccountType: () =>
                utils.claudeCode.getResolvedAccount.getData({ chatId })?.type ?? 'claude-code',
            });
          }
        }

        // Open QueueProcessor's account-gate for a chat the user never navigated to: it only sends
        // once getResolvedAccount is a successful query in the cache.
        void utils.claudeCode.getResolvedAccount.fetch({ chatId });

        // Dedup before enqueuing: a re-claimed task (heartbeat lapse) or a second app window
        // receiving the same broadcast re-fires task:chat-ready for a chat that already has this
        // prompt. Sending again double-executes (claude.ts isDuplicate only skips re-persist, not
        // the stream). Skip if the prompt is already a user message or already queued.
        // A user-requested retry (isRetry) bypasses the sent-message check ONLY: its prompt
        // legitimately already exists as a persisted user message from the failed attempt, and
        // without the send no stream listener is registered — the retry would be a dead-end.
        // alreadyQueued still applies (a retry while a retry is pending must not double-enqueue);
        // cross-window double-fire is bounded by the server-side claim CAS, same as fresh chats.
        const promptText = data.prompt.trim();
        const existingMessages = (agentChatStore.get(subChatId)?.messages ??
          []) as MaybeUserMessage[];
        const alreadySent = existingMessages.some((m) => userMessageMatchesPrompt(m, promptText));
        const alreadyQueued = useMessageQueueStore
          .getState()
          .getQueue(subChatId)
          .some((item) => item.message.trim() === promptText);
        if ((alreadySent && !data.isRetry) || alreadyQueued) {
          reportSwallowedFlowDispatch(data, subChatId, alreadySent);
          return;
        }

        // Deliver the initial prompt via the focus-independent message queue (drained by the global
        // QueueProcessor) — NOT the old isActive-gated pendingTaskPrompt path.
        const queuedImages = (data.images ?? []).map((img) => ({
          id: generateQueueId(),
          url: '',
          mediaType: img.mediaType,
          filename: img.filename,
          base64Data: img.base64Data,
        }));
        useMessageQueueStore.getState().addToQueue(subChatId, {
          ...createQueueItem(generateQueueId(), data.prompt, queuedImages),
          ...(data.headless ? { source: FLOW_DISPATCH_SOURCE } : {}),
          // Identity for main's dispatch-mode binding — every task dispatch, flow or work-queue.
          dispatchTaskId: data.taskId,
        });
      })();

      // Flow tasks run headless (watched from the flow-run panel); only user-initiated work-queue
      // tasks pull focus to their chat.
      if (!data.headless) {
        focusAgentChat(chatId);
      }
    };

    // Listener first, then pull: `task:chat-ready` is one-shot, so a dispatch that fired before this
    // mounted (renderer reload, slow lazy layout load) is only reachable through main's record.
    const cleanup = window.desktopApi.onTaskChatReady(handleChatReady);
    let unmounted = false;
    let retryTimer: ReturnType<typeof setTimeout> | undefined;
    // A failed pull is not "nothing pending": retry until main answers.
    const pullUndelivered = () => {
      trpcClient.tasks.listUndeliveredDispatches
        .query()
        .then((dispatches) => {
          if (!unmounted) for (const data of dispatches) handleChatReady(data);
        })
        .catch(() => {
          if (!unmounted) retryTimer = setTimeout(pullUndelivered, UNDELIVERED_PULL_RETRY_MS);
        });
    };
    pullUndelivered();

    return () => {
      unmounted = true;
      clearTimeout(retryTimer);
      cleanup();
    };
  }, [focusAgentChat, store, utils, apiUtils]);
}
