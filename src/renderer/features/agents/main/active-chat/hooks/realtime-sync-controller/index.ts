import type { UIMessage } from 'ai';
import { useCallback, useEffect } from 'react';
import type { TranscriptTerminalDurability } from '../../../../../../../shared/types/assistant-message';
import { appStore } from '../../../../../../lib/jotai-store';
import { trpcClient } from '../../../../../../lib/trpc';
import { isDesktopApp } from '../../../../../../lib/utils/platform';
import { applyAskUserQuestionChunk } from '../../../../lib/ask-user-question-chunks';
import { hasActiveTransport } from '../../../../lib/websocket-chat-transport';
import {
  chatStatusAtom,
  remoteStreamingAtom,
  syncMessagesWithStatusAtom,
} from '../../../../stores/message-store';
import {
  LocalStreamReconciler,
  type LocalStreamSeedResult,
} from '../../utils/local-stream-reconciler';
import {
  applyExecuteComplete,
  applyExecuteError,
  applyLegacyStreamSnapshot,
  type ExecuteCompletePayload,
  type ExecuteErrorPayload,
  type GenericDesktopListener,
  type RealtimeSyncRefs,
  type RecoverySocketClient,
  type StreamChunkPayload,
} from '../../utils/realtime-sync-recovery';
import { clearFlowRunEndedErrorSignal } from '../../utils/task-execution-error-signal';

type RealtimeSyncControllerOptions = {
  subChatId: string;
  chatId: string;
  refs: RealtimeSyncRefs;
};

type RecoveryCallbacks = {
  fetchLocalSeed: () => Promise<LocalStreamSeedResult>;
  publishLocalParts: (
    assistantMessageId: string,
    parts: UIMessage['parts'],
    status: 'streaming' | 'ready',
  ) => void;
};

type RealtimeHandlers = {
  handleExecuteComplete: (payload: ExecuteCompletePayload) => void;
  handleExecuteError: (payload: ExecuteErrorPayload) => void;
  handleExecuteStart: (payload: {
    chatId: string;
    subChatId: string;
    assistantMessageId: string;
  }) => void;
  handleMessageSaved: (payload: {
    chatId: string;
    subChatId: string;
    message: { id: string; role: string; parts: unknown[] };
  }) => void;
  handleStreamChunk: (payload: StreamChunkPayload) => void;
};

function useLocalStreamRecovery({
  subChatId,
  refs,
}: RealtimeSyncControllerOptions): RecoveryCallbacks {
  const { setMessagesRef, isActiveRef, pendingLocalPartsRef, publicationFrameRef } = refs;

  const publishLocalParts = useCallback(
    (assistantMessageId: string, parts: UIMessage['parts'], status: 'streaming' | 'ready') => {
      pendingLocalPartsRef.current.set(assistantMessageId, { parts, status });
      if (publicationFrameRef.current !== null) return;
      publicationFrameRef.current = window.requestAnimationFrame(() => {
        publicationFrameRef.current = null;
        const pending = new Map(pendingLocalPartsRef.current);
        pendingLocalPartsRef.current.clear();
        if (pending.size === 0) return;

        setMessagesRef.current((previous) => {
          let newMessages = previous;
          let latestStatus: 'streaming' | 'ready' = 'ready';
          for (const [messageId, update] of pending) {
            latestStatus = update.status === 'streaming' ? 'streaming' : latestStatus;
            const index = newMessages.findIndex((message) => message.id === messageId);
            newMessages =
              index >= 0
                ? newMessages.map((message, messageIndex) =>
                    messageIndex === index ? { ...message, parts: update.parts } : message,
                  )
                : [
                    ...newMessages,
                    { id: messageId, role: 'assistant' as const, parts: update.parts },
                  ];
          }
          appStore.set(syncMessagesWithStatusAtom, {
            messages: newMessages,
            status: latestStatus,
            subChatId,
            isActive: isActiveRef.current,
          });
          return newMessages;
        });
      });
    },
    [subChatId, isActiveRef, pendingLocalPartsRef, publicationFrameRef, setMessagesRef],
  );

  const fetchLocalSeed = useCallback(async (): Promise<LocalStreamSeedResult> => {
    const socket = trpcClient.socket as unknown as RecoverySocketClient | undefined;
    if (!socket?.getLiveStreamSeed) return { streams: [], terminals: [] };
    return socket.getLiveStreamSeed.query({ subChatId });
  }, [subChatId]);

  return { fetchLocalSeed, publishLocalParts };
}

function useRealtimeStreamHandlers({
  subChatId,
  chatId,
  refs,
}: RealtimeSyncControllerOptions): Pick<
  RealtimeHandlers,
  'handleMessageSaved' | 'handleStreamChunk'
> {
  const {
    setMessagesRef,
    isActiveRef,
    remoteAssistantIdRef,
    highWaterRef,
    reconcilerRef,
  } = refs;
  const handleStreamChunk = useCallback(
    (payload: StreamChunkPayload) => {
      if (payload.subChatId !== subChatId) return;
      if (hasActiveTransport(subChatId)) return;

      const chunk = payload.chunk as { type: string };
      if (chunk.type === 'start' || chunk.type === 'start-step') {
        clearFlowRunEndedErrorSignal(subChatId);
      }
      applyAskUserQuestionChunk({
        chunk: chunk as Parameters<typeof applyAskUserQuestionChunk>[0]['chunk'],
        subChatId,
        parentChatId: chatId,
      });

      if (typeof payload.streamEpoch === 'string') {
        reconcilerRef.current?.observeChunk({
          ...payload,
          streamEpoch: payload.streamEpoch,
          chunk,
        });
        return;
      }
      applyLegacyStreamSnapshot(
        payload,
        { highWaterRef, setMessagesRef, remoteAssistantIdRef, isActiveRef },
        subChatId,
      );
    },
    [
      subChatId,
      chatId,
      highWaterRef,
      isActiveRef,
      reconcilerRef,
      remoteAssistantIdRef,
      setMessagesRef,
    ],
  );

  const handleMessageSaved = useCallback(
    (payload: {
      chatId: string;
      subChatId: string;
      message: { id: string; role: string; parts: unknown[] };
    }) => {
      if (payload.subChatId !== subChatId || payload.message.role !== 'user') return;
      setMessagesRef.current((previous) => {
        if (previous.find((message) => message.id === payload.message.id)) return previous;
        return [
          ...previous,
          {
            id: payload.message.id,
            role: 'user' as const,
            parts: (payload.message.parts || []).map((part) => part as UIMessage['parts'][0]),
          },
        ];
      });
    },
    [subChatId, setMessagesRef],
  );

  return { handleMessageSaved, handleStreamChunk };
}

function useRealtimeExecutionHandlers({
  subChatId,
  chatId,
  refs,
}: RealtimeSyncControllerOptions): Pick<
  RealtimeHandlers,
  'handleExecuteComplete' | 'handleExecuteError' | 'handleExecuteStart'
> {
  const {
    setMessagesRef,
    isActiveRef,
    remoteAssistantIdRef,
    highWaterRef,
    invalidateSubChatMessagesRef,
    reconcilerRef,
  } = refs;
  const handleExecuteStart = useCallback(
    (payload: { chatId: string; subChatId: string; assistantMessageId: string }) => {
      if (payload.subChatId !== subChatId || hasActiveTransport(subChatId)) return;
      if (isActiveRef.current) {
        appStore.set(remoteStreamingAtom, true);
        appStore.set(chatStatusAtom, 'streaming');
      }

      remoteAssistantIdRef.current = payload.assistantMessageId;
      setMessagesRef.current((previous) => {
        if (previous.find((message) => message.id === payload.assistantMessageId)) return previous;
        const newMessages = [
          ...previous,
          { id: payload.assistantMessageId, role: 'assistant' as const, parts: [] },
        ];
        appStore.set(syncMessagesWithStatusAtom, {
          messages: newMessages,
          status: 'streaming',
          subChatId,
          isActive: isActiveRef.current,
        });
        return newMessages;
      });
    },
    [subChatId, isActiveRef, remoteAssistantIdRef, setMessagesRef],
  );

  const handleExecuteComplete = useCallback(
    (payload: ExecuteCompletePayload) => {
      applyExecuteComplete(
        payload,
        {
          highWaterRef,
          isActiveRef,
          reconcilerRef,
          remoteAssistantIdRef,
          setMessagesRef,
        },
        subChatId,
      );
    },
    [
      subChatId,
      highWaterRef,
      isActiveRef,
      reconcilerRef,
      remoteAssistantIdRef,
      setMessagesRef,
    ],
  );

  const handleExecuteError = useCallback(
    (payload: ExecuteErrorPayload) => {
      applyExecuteError(
        payload,
        {
          invalidateSubChatMessagesRef,
          isActiveRef,
          reconcilerRef,
          remoteAssistantIdRef,
        },
        subChatId,
        chatId,
      );
    },
    [
      subChatId,
      chatId,
      invalidateSubChatMessagesRef,
      isActiveRef,
      reconcilerRef,
      remoteAssistantIdRef,
    ],
  );

  return { handleExecuteComplete, handleExecuteError, handleExecuteStart };
}

function useRealtimeSyncSubscription(
  { subChatId, chatId, refs }: RealtimeSyncControllerOptions,
  recovery: RecoveryCallbacks,
  handlers: RealtimeHandlers,
): void {
  const { reconcilerRef, pendingLocalPartsRef, publicationFrameRef, invalidateSubChatMessagesRef } =
    refs;
  const { fetchLocalSeed, publishLocalParts } = recovery;
  const {
    handleExecuteStart,
    handleStreamChunk,
    handleMessageSaved,
    handleExecuteComplete,
    handleExecuteError,
  } = handlers;

  useEffect(() => {
    if (!isDesktopApp()) return;
    const desktopApi = window.desktopApi;
    if (!desktopApi) return;

    // Staleness is the reconciler's own job (its `disposed`/`isCurrentState` checks) — a seed
    // pull that resolves after this effect re-runs is already bound to the disposed instance.
    // A run that failed while this renderer was down has no live error event left to deliver it:
    // the seed's error terminal is surfaced exactly once through the same path a live one takes.
    const surfacedErrorEpochs = new Set<string>();
    const reconciler = new LocalStreamReconciler({
      fetchSeed: async () => {
        const result = await fetchLocalSeed();
        for (const terminal of result.terminals) {
          if (terminal.status !== 'error' || surfacedErrorEpochs.has(terminal.streamEpoch))
            continue;
          surfacedErrorEpochs.add(terminal.streamEpoch);
          handleExecuteError({
            chatId,
            subChatId,
            assistantMessageId: terminal.assistantMessageId,
            streamEpoch: terminal.streamEpoch,
            error: terminal.error ?? 'Execution failed',
            category: terminal.category,
            terminalDurability:
              terminal.durability === 'committed'
                ? { durability: 'committed' }
                : { durability: 'non-durable' },
          });
        }
        return result;
      },
      publish: publishLocalParts,
    });
    reconcilerRef.current = reconciler;
    const cleanupExecuteStart = desktopApi.onSocketExecuteStart?.(handleExecuteStart);
    const cleanupStreamChunk = desktopApi.onSocketStreamChunk?.(handleStreamChunk);
    const cleanupMessageSaved = desktopApi.onSocketMessageSaved?.(handleMessageSaved);
    const cleanupExecuteComplete = desktopApi.onSocketExecuteComplete?.(handleExecuteComplete);
    const cleanupExecuteError = desktopApi.onSocketError?.(handleExecuteError);
    const onGeneric = desktopApi.on as unknown as GenericDesktopListener | undefined;
    const cleanupSettled = onGeneric?.('socket:stream-settled', (value) => {
      const payload = value as {
        subChatId?: string;
        assistantMessageId?: string;
        streamEpoch?: string;
        terminalDurability?: TranscriptTerminalDurability;
      };
      if (
        payload.subChatId === subChatId &&
        typeof payload.assistantMessageId === 'string' &&
        typeof payload.streamEpoch === 'string'
      ) {
        if (payload.terminalDurability?.durability === 'committed') {
          void invalidateSubChatMessagesRef.current({ subChatId });
        }
        reconciler.settle(payload.assistantMessageId, payload.streamEpoch);
      }
    });
    void reconciler.hydrate();

    return () => {
      reconciler.dispose();
      if (reconcilerRef.current === reconciler) reconcilerRef.current = null;
      cleanupExecuteStart?.();
      cleanupStreamChunk?.();
      cleanupMessageSaved?.();
      cleanupExecuteComplete?.();
      cleanupExecuteError?.();
      cleanupSettled?.();
      if (publicationFrameRef.current !== null) {
        window.cancelAnimationFrame(publicationFrameRef.current);
        publicationFrameRef.current = null;
      }
      pendingLocalPartsRef.current.clear();
    };
  }, [
    chatId,
    fetchLocalSeed,
    publishLocalParts,
    handleExecuteStart,
    handleStreamChunk,
    handleMessageSaved,
    handleExecuteComplete,
    handleExecuteError,
    invalidateSubChatMessagesRef,
    pendingLocalPartsRef,
    publicationFrameRef,
    reconcilerRef,
    subChatId,
  ]);
}

export function useRealtimeSyncController(options: RealtimeSyncControllerOptions): void {
  const recovery = useLocalStreamRecovery(options);
  const streamHandlers = useRealtimeStreamHandlers(options);
  const executionHandlers = useRealtimeExecutionHandlers(options);
  const handlers = { ...streamHandlers, ...executionHandlers };

  useRealtimeSyncSubscription(options, recovery, handlers);
}
