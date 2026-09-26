import type { UIMessage } from 'ai';
import { useRef } from 'react';
import { toast } from 'sonner';
import type { TranscriptTerminalDurability } from '../../../../../../../shared/types/assistant-message';
import {
  ERROR_TOAST_CONFIG,
  toastDedupId,
} from '../../../../../../lib/agent-chat/errors/error-toast-config';
import { appStore } from '../../../../../../lib/jotai-store';
import { taskExecutionErrorAtomFamily } from '../../../../atoms';
import { hasActiveTransport } from '../../../../lib/websocket-chat-transport';
import {
  chatStatusAtom,
  remoteStreamingAtom,
  syncMessagesWithStatusAtom,
} from '../../../../stores/message-store';
import type { LocalStreamReconciler, LocalStreamSeedResult } from '../local-stream-reconciler';
import { createTaskExecutionErrorSignal } from '../task-execution-error-signal';

export type StreamChunkPayload = {
  chatId: string;
  subChatId: string;
  assistantMessageId: string;
  chunk: unknown;
  parts?: unknown[];
  messageIndex: number;
  streamEpoch?: string;
};

export type ExecuteCompletePayload = {
  chatId: string;
  subChatId: string;
  assistantMessageId: string;
  sessionId?: string;
  metadata?: unknown;
  finalParts?: unknown[];
  wakeBurst?: boolean;
  continuesWakeHold?: boolean;
  streamEpoch?: string;
  observerOwned?: boolean;
};

export type ExecuteErrorPayload = {
  chatId: string;
  subChatId: string;
  error: string;
  category?: string;
  assistantMessageId?: string;
  streamEpoch?: string;
  terminalDurability?: TranscriptTerminalDurability;
};

export type RecoverySocketClient = {
  getLiveStreamSeed?: {
    query: (input: { subChatId: string }) => Promise<LocalStreamSeedResult>;
  };
};

export type GenericDesktopListener = (
  channel: string,
  callback: (payload?: unknown) => void,
) => (() => void) | undefined;

type RealtimeSyncRefOptions = {
  messages: UIMessage[];
  setMessages: (messages: UIMessage[] | ((prev: UIMessage[]) => UIMessage[])) => void;
  isActive: boolean;
  invalidateSubChatMessages: (input: { subChatId: string }) => unknown;
};

export function useRealtimeSyncRefs({
  messages,
  setMessages,
  isActive,
  invalidateSubChatMessages,
}: RealtimeSyncRefOptions) {
  const invalidateSubChatMessagesRef = useRef(invalidateSubChatMessages);
  invalidateSubChatMessagesRef.current = invalidateSubChatMessages;
  const messagesRef = useRef(messages);
  messagesRef.current = messages;
  const setMessagesRef = useRef(setMessages);
  setMessagesRef.current = setMessages;
  const isActiveRef = useRef(isActive);
  isActiveRef.current = isActive;

  return {
    invalidateSubChatMessagesRef,
    messagesRef,
    setMessagesRef,
    isActiveRef,
    remoteAssistantIdRef: useRef<string | null>(null),
    highWaterRef: useRef(new Map<string, number>()),
    reconcilerRef: useRef<LocalStreamReconciler | null>(null),
    pendingLocalPartsRef: useRef(
      new Map<string, { parts: UIMessage['parts']; status: 'streaming' | 'ready' }>(),
    ),
    publicationFrameRef: useRef<number | null>(null),
  };
}

export type RealtimeSyncRefs = ReturnType<typeof useRealtimeSyncRefs>;

export function applyLegacyStreamSnapshot(
  payload: StreamChunkPayload,
  refs: Pick<
    RealtimeSyncRefs,
    'highWaterRef' | 'setMessagesRef' | 'remoteAssistantIdRef' | 'isActiveRef'
  >,
  subChatId: string,
): void {
  if (!Array.isArray(payload.parts)) return;
  const chunk = payload.chunk as { type: string };
  if (chunk.type === 'finish') return;
  const assistantId = payload.assistantMessageId;
  const lastIndex = refs.highWaterRef.current.get(assistantId);
  if (lastIndex !== undefined && payload.messageIndex <= lastIndex) return;
  refs.highWaterRef.current.set(assistantId, payload.messageIndex);
  const incomingParts = payload.parts as UIMessage['parts'];
  refs.setMessagesRef.current((prev) => {
    const existingIndex = prev.findIndex((message) => message.id === assistantId);
    const newMessages =
      existingIndex >= 0
        ? prev.map((message, index) =>
            index === existingIndex ? { ...message, parts: incomingParts } : message,
          )
        : [...prev, { id: assistantId, role: 'assistant' as const, parts: incomingParts }];
    if (existingIndex < 0) refs.remoteAssistantIdRef.current = assistantId;
    appStore.set(syncMessagesWithStatusAtom, {
      messages: newMessages,
      status: 'streaming',
      subChatId,
      isActive: refs.isActiveRef.current,
    });
    return newMessages;
  });
}

export function applyExecuteComplete(
  payload: ExecuteCompletePayload,
  refs: Pick<
    RealtimeSyncRefs,
    | 'highWaterRef'
    | 'isActiveRef'
    | 'reconcilerRef'
    | 'remoteAssistantIdRef'
    | 'setMessagesRef'
  >,
  subChatId: string,
): void {
  if (payload.subChatId !== subChatId) return;
  if (typeof payload.streamEpoch === 'string') {
    refs.reconcilerRef.current?.complete({
      assistantMessageId: payload.assistantMessageId,
      streamEpoch: payload.streamEpoch,
      finalParts: payload.finalParts,
      continuesWakeHold: payload.continuesWakeHold === true,
      observerOwned: payload.observerOwned === true,
    });
  }
  refs.highWaterRef.current.delete(payload.assistantMessageId);
  const meta = payload.metadata as Record<string, unknown> | undefined;
  if (meta?.sdkMessageUuid && payload.assistantMessageId) {
    refs.setMessagesRef.current((prev) =>
      prev.map((message) =>
        message.id === payload.assistantMessageId
          ? {
              ...message,
              metadata: {
                ...(message.metadata as Record<string, unknown> | undefined),
                sdkMessageUuid: meta.sdkMessageUuid,
              },
            }
          : message,
      ),
    );
  }
  if (payload.streamEpoch === undefined && payload.wakeBurst === true) {
    const finalParts = Array.isArray(payload.finalParts)
      ? (payload.finalParts as UIMessage['parts'])
      : null;
    refs.setMessagesRef.current((prev) => {
      const index = prev.findIndex((message) => message.id === payload.assistantMessageId);
      let newMessages: UIMessage[];
      if (finalParts) {
        newMessages =
          index >= 0
            ? prev.map((message, messageIndex) =>
                messageIndex === index ? { ...message, parts: finalParts } : message,
              )
            : [
                ...prev,
                { id: payload.assistantMessageId, role: 'assistant' as const, parts: finalParts },
              ];
      } else {
        newMessages = prev;
      }
      appStore.set(syncMessagesWithStatusAtom, {
        messages: newMessages,
        status: 'ready',
        subChatId,
        isActive: refs.isActiveRef.current,
      });
      return newMessages;
    });
  }
  if (refs.remoteAssistantIdRef.current === payload.assistantMessageId) {
    refs.remoteAssistantIdRef.current = null;
    appStore.set(remoteStreamingAtom, false);
    if (refs.isActiveRef.current) appStore.set(chatStatusAtom, 'ready');
  }
}

export function applyExecuteError(
  payload: ExecuteErrorPayload,
  refs: Pick<
    RealtimeSyncRefs,
    | 'invalidateSubChatMessagesRef'
    | 'isActiveRef'
    | 'reconcilerRef'
    | 'remoteAssistantIdRef'
  >,
  subChatId: string,
  chatId: string,
): void {
  if (payload.chatId !== chatId || payload.subChatId !== subChatId) {
    return;
  }
  if (typeof payload.assistantMessageId === 'string' && typeof payload.streamEpoch === 'string') {
    const terminalDurability = payload.terminalDurability ?? { durability: 'non-durable' };
    refs.reconcilerRef.current?.error(payload.assistantMessageId, payload.streamEpoch);
    if (terminalDurability.durability === 'committed') {
      void refs.invalidateSubChatMessagesRef.current({ subChatId });
    }
  }
  if (hasActiveTransport(subChatId)) return;
  refs.remoteAssistantIdRef.current = null;
  appStore.set(remoteStreamingAtom, false);
  if (refs.isActiveRef.current) appStore.set(chatStatusAtom, 'ready');
  if (!payload.error) return;
  appStore.set(
    taskExecutionErrorAtomFamily(subChatId),
    createTaskExecutionErrorSignal(payload.error, payload.category),
  );
  const categoryToast = payload.category ? ERROR_TOAST_CONFIG[payload.category] : undefined;
  if (categoryToast) {
    toast.error(categoryToast.title, {
      description: categoryToast.description,
      ...toastDedupId(categoryToast, subChatId),
    });
  } else {
    toast.error('Execution failed', { description: payload.error });
  }
}
