/* eslint-disable max-lines, max-lines-per-function */
import { hashKey, useQueryClient } from '@tanstack/react-query';
import { getQueryKey } from '@trpc/react-query';
import { useEffect, useRef } from 'react';
import { toast } from 'sonner';
import { runLiveAtomFamily } from '@/lib/stores/active-transport-registry';
import {
  isLiveRunHydrationComplete,
  onLiveRunHydrationChange,
} from '@/lib/stores/renderer-recovery-ready';
import { isValidTaskStatus } from '../../../../shared/types/task-status';
import { trackMessageSent } from '../../../lib/analytics';
import { appStore } from '../../../lib/jotai-store';
import { api } from '../../../lib/mock-api';
import { trpc } from '../../../lib/trpc';
import { notifySidebarChatActivity } from '../../sidebar/unified/sidebar-chat-activity';
import {
  approvedPlanContextAtomFamily,
  clearLoading,
  loadingSubChatsAtom,
  pendingModeIntentAtomFamily,
  setLoading,
} from '../atoms';
import { type AgentQueueItem, buildQueuedMessageParts } from '../lib/queue-utils';
import { invalidateTaskQueries } from '../main/active-chat/utils/task-query';
import { agentChatStore, onChatRegistered } from '../stores/agent-chat-store';
import { reconcileRestoredHolds } from '../lib/archive-queue-hold';
import { useMessageQueueStore } from '../stores/message-queue-store';
import { useStreamingStatusStore } from '../stores/streaming-status-store';
import { armApprovedPlanState, useAgentSubChatStore } from '../stores/sub-chat-store';

/** Delay between processing queue items (ms). Exported for tests. */
export const QUEUE_PROCESS_DELAY_MS = 1000;

/** Spacing between the account gate's own fetches per parent: a rejection re-enters the gate via
 * the cache subscription, so without it a failing lookup would call main back-to-back. */
export const ACCOUNT_REFETCH_COOLDOWN_MS = 10_000;
/** Ceiling for the doubling backoff between consecutive failed account fetches for one parent. */
export const ACCOUNT_REFETCH_MAX_DELAY_MS = 300_000;
/** How long an account fetch may stay in flight before the gate cancels it and fetches again. */
export const ACCOUNT_FETCH_TIMEOUT_MS = 30_000;

const accountRetryDelay = (tries: number): number =>
  Math.min(ACCOUNT_REFETCH_COOLDOWN_MS * 2 ** Math.max(tries - 1, 0), ACCOUNT_REFETCH_MAX_DELAY_MS);

type GenericDesktopListener = (
  channel: string,
  callback: (payload?: unknown) => void,
) => (() => void) | undefined;

function armPlanApproval(subChatId: string, item: AgentQueueItem): void {
  const context = item.approvedPlanContext;
  if (!context) return;
  armApprovedPlanState(subChatId, context);
  appStore.set(pendingModeIntentAtomFamily(subChatId), 'agent');
}

function disarmFailedPlanApproval(subChatId: string, item: AgentQueueItem): void {
  const context = item.approvedPlanContext;
  if (!context) return;
  const contextAtom = approvedPlanContextAtomFamily(subChatId);
  if (appStore.get(contextAtom) === context) appStore.set(contextAtom, null);
  const intentAtom = pendingModeIntentAtomFamily(subChatId);
  if (appStore.get(intentAtom) === 'agent') appStore.set(intentAtom, null);
}

/**
 * Global queue processor component.
 *
 * This component runs at the app level (AgentsLayout) and processes
 * message queues for ALL sub-chats, regardless of which one is currently active.
 *
 * Key insight: Unlike the previous local useEffect in ChatViewInner which only
 * processed the currently active sub-chat's queue, this component listens to
 * ALL queues and streaming statuses globally.
 */
export function QueueProcessor() {
  // Track which sub-chats are currently being processed to avoid double-sends
  const processingRef = useRef<Set<string>>(new Set());
  // Track timers for cleanup
  const timersRef = useRef<Map<string, NodeJS.Timeout>>(new Map());
  const queryClient = useQueryClient();
  const utils = api.useUtils();
  const trpcUtils = trpc.useUtils();
  // The queue effect below must not re-subscribe when this identity changes; read it via a ref.
  const trpcUtilsRef = useRef(trpcUtils);
  trpcUtilsRef.current = trpcUtils;

  // Global execute-complete: refetch chat so UI shows response even when that chat's transport
  // was torn down (e.g. panel closed and reopened). Transport's onExecuteComplete only runs
  // if the transport listener is active; this ensures we always refetch.
  useEffect(() => {
    const desktopApi = window.desktopApi;
    if (!desktopApi?.onSocketExecuteComplete) return;
    const invalidateCompletedChat = (payload: { chatId: string }): void => {
      void utils.agents.getAgentChat.invalidate({ chatId: payload.chatId });
      invalidateTaskQueries(trpcUtils);
      notifySidebarChatActivity(payload.chatId);
    };
    const cleanupComplete = desktopApi.onSocketExecuteComplete(invalidateCompletedChat);
    // execute-complete intentionally precedes the durable DB finalize. A renderer that seeds a
    // `settling` stream missed that event, so the post-finalize edge is its authoritative refetch.
    const onGeneric = desktopApi.on as unknown as GenericDesktopListener | undefined;
    const cleanupSettled = onGeneric?.('socket:stream-settled', (value) => {
      const payload = value as { chatId?: string };
      if (typeof payload.chatId === 'string') invalidateCompletedChat({ chatId: payload.chatId });
    });
    // A failed turn never reaches execute-complete, so without this the chat row keeps whatever
    // sub_chats.sessionId it was last fetched with — which the failed-turn recovery controls read.
    const cleanupError = desktopApi.onSocketError?.((payload: { chatId?: string }) => {
      if (payload.chatId) void utils.agents.getAgentChat.invalidate({ chatId: payload.chatId });
    });
    return () => {
      cleanupComplete?.();
      cleanupSettled?.();
      cleanupError?.();
    };
  }, [utils, trpcUtils]);

  // Optimistic task status update: when the agent calls frink_task_signal mid-stream,
  // the signal is immediately persisted and this event fires. We update the cache now
  // rather than waiting for the stream to end, giving instant UI feedback.
  useEffect(() => {
    const desktopApi = window.desktopApi;
    if (!desktopApi?.onSocketTaskSignalPersisted) return;
    const cleanup = desktopApi.onSocketTaskSignalPersisted(({ taskId, status, isFlowLinked }) => {
      // For non-flow tasks: immediately reflect the new status in the task detail cache.
      // Flow-linked anchor tasks are intentionally kept "running" server-side until the
      // entire flow completes, so we skip the optimistic write for them.
      if (!isFlowLinked) {
        trpcUtils.tasks.getById.setData(taskId, (old) => {
          if (!old) return old;
          if (!isValidTaskStatus(status)) return old;
          return { ...old, status };
        });
      }
      // Trigger a background refetch so all task query caches (list, counts, detail)
      // converge to server truth quickly.
      invalidateTaskQueries(trpcUtils);
    });
    return () => cleanup?.();
  }, [trpcUtils]);

  useEffect(() => {
    // False after effect cleanup so async `finally` in processQueue does not schedule post-unmount.
    const activeRef = { current: true };
    void reconcileRestoredHolds();

    let checkAllQueues: () => void = () => {};

    // One-shot runLive watchers for sub-chats held on main's liveness gate, keyed by sub-chat.
    const settleWatchers = new Map<string, () => void>();

    // Last time the account gate fetched `getResolvedAccount` itself, keyed by parent chat.
    const accountFetchAttempts = new Map<string, { at: number; tries: number }>();
    // Start time of the current in-flight account fetch (any caller's), keyed by query hash. The
    // cache subscription stamps it when the fetch starts and clears it the moment it settles.
    const accountFetchInFlightSince = new Map<string, number>();

    // One delayed re-check per parent whose account fetch is cooling down. Lives in timersRef
    // (under a prefixed key) so unmount cleanup clears it with the dispatch timers.
    const scheduleAccountRecheck = (parentChatId: string, delayMs: number) => {
      const key = `account-refetch:${parentChatId}`;
      if (timersRef.current.has(key)) return;
      const timer = setTimeout(() => {
        timersRef.current.delete(key);
        if (activeRef.current) checkAllQueues();
      }, delayMs);
      timersRef.current.set(key, timer);
    };

    const watchRunSettle = (subChatId: string) => {
      if (settleWatchers.has(subChatId)) return;
      const liveAtom = runLiveAtomFamily(subChatId);
      const unsubscribe = appStore.sub(liveAtom, () => {
        if (appStore.get(liveAtom)) return;
        settleWatchers.get(subChatId)?.();
        settleWatchers.delete(subChatId);
        if (activeRef.current) checkAllQueues();
      });
      settleWatchers.set(subChatId, unsubscribe);
    };

    // Schedule processing for a sub-chat with delay. First-wins: if a timer is already pending
    // for this sub-chat, leave it alone rather than restarting its wait on every store write.
    const scheduleProcessing = (subChatId: string) => {
      if (timersRef.current.has(subChatId)) return;

      const head = useMessageQueueStore.getState().queues[subChatId]?.[0];
      const timer = setTimeout(
        () => {
          timersRef.current.delete(subChatId);
          void processQueue(subChatId);
        },
        head?.sendOnSettle ? 0 : QUEUE_PROCESS_DELAY_MS,
      );

      timersRef.current.set(subChatId, timer);
    };

    // Function to process queue for a specific sub-chat
    const processQueue = async (subChatId: string) => {
      if (!isLiveRunHydrationComplete()) return;

      // Check if already processing this sub-chat
      if (processingRef.current.has(subChatId)) {
        return;
      }

      // Check streaming status
      const status = useStreamingStatusStore.getState().getStatus(subChatId);
      if (status !== 'ready') {
        return;
      }

      // Main's liveness, not the status store (never written for a turn this window owns): a send on
      // top of a live run makes main abort it. The settle publish skips the status write while this
      // window owns the transport, so the flag clearing is the only release edge — watch it.
      if (appStore.get(runLiveAtomFamily(subChatId))) {
        watchRunSettle(subChatId);
        return;
      }

      // Get queue for this sub-chat
      const queue = useMessageQueueStore.getState().queues[subChatId] || [];
      if (queue.length === 0) {
        return;
      }

      // Skip if the user is currently editing the next item — the original is held in the queue
      // (with an "Editing…" badge) until they send the edited version, which removes it. We must
      // not pop and auto-send it here or the original would fire while their edit is still in
      // the input.
      const editingId = useMessageQueueStore.getState().editingItemIds[subChatId];
      if (editingId && editingId === queue[0].id) {
        return;
      }

      // A turn restored after a reload without its attachments waits for the user: sending the text
      // alone would silently drop what it referred to.
      if (queue[0].attachmentsLost) {
        return;
      }

      // Get the Chat object from agentChatStore
      const chat = agentChatStore.get(subChatId);
      if (!chat) {
        return;
      }

      const parentChatIdForAccount = agentChatStore.getParentChatId(subChatId);
      // Archiving aborts the chat's run mid-mutation, which drops the sub-chat to 'ready'. Hold the
      // queue until the archive settles: it is then cleared (archived) or released (archive failed).
      if (useMessageQueueStore.getState().isChatHeld(parentChatIdForAccount)) {
        return;
      }
      if (parentChatIdForAccount) {
        const resolvedKey = getQueryKey(
          trpc.claudeCode.getResolvedAccount,
          { chatId: parentChatIdForAccount },
          'query',
        );
        const resolvedState = queryClient.getQueryState(resolvedKey);
        if (resolvedState?.status !== 'success') {
          const now = Date.now();
          const attempt = accountFetchAttempts.get(parentChatIdForAccount);
          if (resolvedState?.fetchStatus === 'fetching') {
            // Settling re-runs this gate via the cache subscription; one that never settles (a hung
            // IPC call) is cancelled after the timeout — cancelling rejects even if IPC can't abort.
            const hash = hashKey(resolvedKey); // A fetch begun before mount was never stamped.
            const since = accountFetchInFlightSince.get(hash) ?? now;
            accountFetchInFlightSince.set(hash, since);
            if (now - since >= ACCOUNT_FETCH_TIMEOUT_MS) {
              void queryClient.cancelQueries({ queryKey: resolvedKey });
            } else {
              scheduleAccountRecheck(
                parentChatIdForAccount,
                ACCOUNT_FETCH_TIMEOUT_MS - (now - since),
              );
            }
            return;
          }
          // Absent (GC'd, or not prefetched after a reload) or failed: nothing else fetches it for
          // an unopened chat, so fetch here, backing off per failure with a re-check armed.
          const wait = attempt ? accountRetryDelay(attempt.tries) - (now - attempt.at) : 0;
          if (wait <= 0) {
            const tries = (attempt?.tries ?? 0) + 1;
            accountFetchAttempts.set(parentChatIdForAccount, { at: now, tries });
            void trpcUtilsRef.current.claudeCode.getResolvedAccount
              .fetch({ chatId: parentChatIdForAccount })
              .catch(() => {});
            scheduleAccountRecheck(parentChatIdForAccount, accountRetryDelay(tries));
          } else {
            scheduleAccountRecheck(parentChatIdForAccount, wait);
          }
          return;
        }
        accountFetchAttempts.delete(parentChatIdForAccount);
      }

      // Mark as processing
      processingRef.current.add(subChatId);

      // Pop the first item from queue (atomic operation)
      const clearEpoch = useMessageQueueStore.getState().getClearEpoch(subChatId);
      const item = useMessageQueueStore.getState().popItem(subChatId, queue[0].id);
      if (!item) {
        processingRef.current.delete(subChatId);
        if (activeRef.current) {
          checkAllQueues();
        }
        return;
      }

      try {
        const parts = buildQueuedMessageParts(item);

        // Nothing sendable: never dispatch an empty turn (it reads as a delivered message that
        // carried nothing), and never requeue it — that would retry forever. Say so and move on.
        if (parts.length === 0) {
          toast.error('A queued message was empty and was not sent.');
          return;
        }

        // This internal recovery item owns its plan context and mode intent. Arm them only after
        // the exact item is popped, with no await before its send, so an older queued turn cannot
        // consume them.
        armPlanApproval(subChatId, item);

        // Get mode from sub-chat store for analytics
        const subChatMeta = useAgentSubChatStore.getState().subChatsById[subChatId];
        const mode = subChatMeta?.mode || 'agent';

        // Track message sent
        trackMessageSent({
          workspaceId: subChatId,
          messageLength: item.message.length,
          mode,
        });

        // Update timestamps
        useAgentSubChatStore.getState().updateSubChatTimestamp(subChatId);

        // Set loading state for sidebar indicator
        const parentChatId = agentChatStore.getParentChatId(subChatId);
        if (parentChatId) {
          notifySidebarChatActivity(parentChatId);
          setLoading(
            (fn) => appStore.set(loadingSubChatsAtom, fn(appStore.get(loadingSubChatsAtom))),
            subChatId,
            parentChatId,
          );
        }

        // Flow-dispatched prompts carry their source in metadata so the transport does not read
        // them as approve-then-execute replies to a parked plan card (decision
        // `flow-agent-node-mode`); dispatchTaskId lets main bind the turn's mode to the
        // dispatching task by identity. Auto Mode is not carried here — the Flow seeds the
        // chat's own setting on dispatch instead.
        const metadata = {
          ...(item.source ? { source: item.source } : {}),
          ...(item.dispatchTaskId ? { dispatchTaskId: item.dispatchTaskId } : {}),
        };
        await chat.sendMessage({
          role: 'user',
          parts,
          ...(Object.keys(metadata).length > 0 ? { metadata } : {}),
        });
      } catch (_error) {
        disarmFailedPlanApproval(subChatId, item);
        // Requeue at the front for a retry, unless the queue was cleared mid-send (e.g. archived).
        const queueStore = useMessageQueueStore.getState();
        const requeued = queueStore.getClearEpoch(subChatId) === clearEpoch;
        if (requeued) {
          queueStore.prependItem(subChatId, item);
          // Set error status (will be cleared on next successful send or manual retry)
          useStreamingStatusStore.getState().setStatus(subChatId, 'error');
        }

        // Clear loading state since send failed
        clearLoading(
          (fn) => appStore.set(loadingSubChatsAtom, fn(appStore.get(loadingSubChatsAtom))),
          subChatId,
        );

        // Only promise a retry for an item that is back in the queue.
        if (requeued) toast.error('Failed to send queued message. It will be retried.');
      } finally {
        processingRef.current.delete(subChatId);
        if (activeRef.current) {
          checkAllQueues();
        }
      }
    };

    // Check all queues and schedule processing for ready sub-chats
    checkAllQueues = () => {
      if (!isLiveRunHydrationComplete()) return;

      const queues = useMessageQueueStore.getState().queues;

      for (const subChatId of Object.keys(queues)) {
        const queue = queues[subChatId];
        if (!queue || queue.length === 0) continue;

        const status = useStreamingStatusStore.getState().getStatus(subChatId);

        // Process when ready, or retry on error status
        if ((status === 'ready' || status === 'error') && !processingRef.current.has(subChatId)) {
          // If error status, clear it before retrying
          if (status === 'error') {
            useStreamingStatusStore.getState().setStatus(subChatId, 'ready');
          }
          scheduleProcessing(subChatId);
        }
      }
    };

    // Subscribe to queue changes with selector (requires subscribeWithSelector middleware)
    const unsubscribeQueue = useMessageQueueStore.subscribe(
      (state) => state.queues,
      () => checkAllQueues(),
    );

    // Re-evaluate when an editing lock is set/cleared so the processor can resume the item once
    // the user finishes editing (or abandons it).
    const unsubscribeEditing = useMessageQueueStore.subscribe(
      (state) => state.editingItemIds,
      () => checkAllQueues(),
    );

    // A released archive hold (the archive failed) must resume the queue it paused.
    const unsubscribeHeld = useMessageQueueStore.subscribe(
      (state) => state.heldChatIds,
      () => checkAllQueues(),
    );

    // Subscribe to streaming status changes with selector
    const unsubscribeStatus = useStreamingStatusStore.subscribe(
      (state) => state.statuses,
      () => checkAllQueues(),
    );

    // A Chat arriving is the only dispatch gate with no store behind it: `processQueue` bails when
    // `agentChatStore.get` is empty, and without this edge that item waits for an unrelated store
    // write instead of for the thing it was actually blocked on.
    const unsubscribeChatRegistered = onChatRegistered(() => checkAllQueues());

    // A renderer restart closes queue admission until main's surviving-run registry has been
    // projected into the renderer stores. Re-check immediately when that listener-first pull
    // finishes; otherwise a queued turn would wait for an unrelated store mutation.
    const unsubscribeHydration = onLiveRunHydrationChange(() => checkAllQueues());

    // Initial check
    checkAllQueues();

    const unsubCache = queryClient.getQueryCache().subscribe((event) => {
      if (!activeRef.current) return;
      if (event.type === 'removed') accountFetchInFlightSince.delete(event.query.queryHash);
      if (event.type !== 'updated' && event.type !== 'added') return;
      const keyStr = JSON.stringify(event.query.queryKey);
      if (keyStr.includes('getResolvedAccount')) {
        const { queryHash, state } = event.query;
        if (state.fetchStatus !== 'fetching') accountFetchInFlightSince.delete(queryHash);
        else if (!accountFetchInFlightSince.has(queryHash))
          accountFetchInFlightSince.set(queryHash, Date.now());
        checkAllQueues();
      }
    });

    // Cleanup
    return () => {
      activeRef.current = false;
      unsubCache();
      unsubscribeQueue();
      unsubscribeEditing();
      unsubscribeHeld();
      unsubscribeStatus();
      unsubscribeHydration();
      unsubscribeChatRegistered();

      for (const unsubscribe of settleWatchers.values()) {
        unsubscribe();
      }
      settleWatchers.clear();

      // Clear all timers
      for (const timer of timersRef.current.values()) {
        clearTimeout(timer);
      }
      timersRef.current.clear();
    };
  }, [queryClient]);

  // This component doesn't render anything
  return null;
}
