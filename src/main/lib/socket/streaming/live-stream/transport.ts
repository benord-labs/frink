import log from 'electron-log';
import type { TranscriptTerminalDurability } from '../../../../../shared/types/assistant-message';
import { getDatabase } from '../../../db';
import { finalizeAssistantMessage as finalizeAssistantMessageLocal } from '../../../db/repos/sub-chats';
import type { ErrorPayload, ExecuteCompletePayload, StreamChunkPayload } from '../../client';
import {
  clearChunkCounter,
  persistAssistantChunkLocally,
  recordStreamChunk,
} from '../assistant-chunk-checkpoint';
import { withDeclaredRunIdentity } from '../run-identity';
import { recordPrUrl } from './pr-url';
import {
  beginLiveStreamCompletion,
  canRecordLiveStreamChunk,
  isLiveStreamEpochCurrent,
  markLiveStreamCompletionFinalized,
  recordLiveStreamChunk,
  recordLiveStreamError,
  resolveLiveStreamEpoch,
  settleLiveStreamCompletion,
  getLiveStreamGeneration,
} from './registry';

type Broadcast = (channel: string, payload: unknown) => void;
type StreamSettledPayload = {
  chatId: string;
  subChatId: string;
  assistantMessageId: string;
  streamEpoch?: string;
  terminalDurability?: TranscriptTerminalDurability;
};

function createStreamSettledSender(broadcast: Broadcast) {
  return (rawPayload: StreamSettledPayload): void => {
    const streamEpoch =
      rawPayload.streamEpoch ??
      resolveLiveStreamEpoch(rawPayload.subChatId, rawPayload.assistantMessageId);
    const terminalDurability = rawPayload.terminalDurability ?? { durability: 'non-durable' };
    clearChunkCounter(rawPayload.subChatId, rawPayload.assistantMessageId, streamEpoch);
    // A held epoch may have been replaced under the same presentation id before its wait retracts.
    // Settle that exact retained record before consulting current-epoch admission.
    if (
      settleLiveStreamCompletion({
        subChatId: rawPayload.subChatId,
        assistantMessageId: rawPayload.assistantMessageId,
        streamEpoch,
        terminalDurability,
      })
    ) {
      broadcast('socket:stream-settled', { ...rawPayload, streamEpoch, terminalDurability });
      return;
    }
    const observerOwned = beginLiveStreamCompletion({
      ...rawPayload,
      streamEpoch,
      continuesWakeHold: false,
      observerOwned: true,
    });
    if (observerOwned === undefined) return;
    settleLiveStreamCompletion({
      subChatId: rawPayload.subChatId,
      assistantMessageId: rawPayload.assistantMessageId,
      streamEpoch,
      terminalDurability,
    });
    broadcast('socket:stream-settled', { ...rawPayload, streamEpoch, terminalDurability });
  };
}

export function createLiveStreamTransport(input: { broadcast: Broadcast }) {
  /** A run streaming without a registered epoch cannot prove which transcript it belongs to, so its
   * writes are refused — silent transcript loss unless it reaches Sentry. */
  const reportMissingFence = (subChatId: string, stage: 'checkpoint' | 'finalize'): void => {
    log.warn(`[Socket] No live-stream fence for ${subChatId}; ${stage} skipped`);
    void import('../../../sentry/init')
      .then(({ captureMainMessage }) =>
        captureMainMessage('live-stream write skipped: no fence for this epoch', 'error', {
          surface: 'live-stream-fence',
          stage,
        }),
      )
      // Telemetry must never raise into the stream: a failed capture would surface as an
      // unhandled rejection instead of the refused write it reports.
      .catch(() => {});
  };

  const finalizeCompletion = async (
    payload: ExecuteCompletePayload,
  ): Promise<TranscriptTerminalDurability> => {
    const generation = getLiveStreamGeneration(
      payload.subChatId,
      payload.assistantMessageId,
      payload.streamEpoch ?? resolveLiveStreamEpoch(payload.subChatId, payload.assistantMessageId),
    );
    if (generation === undefined) {
      reportMissingFence(payload.subChatId, 'finalize');
      return { durability: 'non-durable' };
    }
    try {
      const finalized = await finalizeAssistantMessageLocal(
        getDatabase(),
        payload.subChatId,
        payload.assistantMessageId,
        payload.finalParts ?? [],
        payload.sessionId ?? null,
        payload.metadata,
        generation,
      );
      if (!finalized) {
        log.error('[Socket] Local finalize found no sub-chat row');
        return { durability: 'non-durable' };
      }
      // Reads the parts finalize actually stored (a contentless finalize keeps checkpointed parts)
      // and runs before stream-settled is broadcast, so the renderer's settle refetch sees the PR.
      const stored = finalized.messages.find((m) => m.id === payload.assistantMessageId);
      await recordPrUrl(getDatabase(), payload.chatId, stored?.parts ?? []);
      return { durability: 'committed' };
    } catch (err) {
      log.error('[Socket] Local finalize failed:', err);
      return { durability: 'non-durable' };
    }
  };

  const sendStreamChunkDirect = (rawPayload: StreamChunkPayload): void => {
    const streamEpoch =
      rawPayload.streamEpoch ??
      resolveLiveStreamEpoch(rawPayload.subChatId, rawPayload.assistantMessageId);
    if (!canRecordLiveStreamChunk({ ...rawPayload, streamEpoch })) return;
    const { messageIndex, isCheckpoint } = recordStreamChunk({ ...rawPayload, streamEpoch });
    const payload = withDeclaredRunIdentity({ ...rawPayload, streamEpoch, messageIndex });
    if (!recordLiveStreamChunk({ ...payload, streamEpoch, messageIndex })) return;
    const { parts: _parts, wakeBurst: _wakeBurst, ...localPayload } = payload;
    input.broadcast('socket:stream-chunk', localPayload);

    const generation = getLiveStreamGeneration(
      payload.subChatId,
      payload.assistantMessageId,
      streamEpoch,
    );
    if (isCheckpoint) {
      if (generation === undefined) reportMissingFence(payload.subChatId, 'checkpoint');
      else void persistAssistantChunkLocally(payload, generation);
    }
  };

  const sendExecuteCompleteDirect = (rawPayload: ExecuteCompletePayload): Promise<void> => {
    const streamEpoch =
      rawPayload.streamEpoch ??
      resolveLiveStreamEpoch(rawPayload.subChatId, rawPayload.assistantMessageId);
    const continuesWakeHold = rawPayload.continuesWakeHold === true;
    const observerOwned = beginLiveStreamCompletion({
      ...rawPayload,
      streamEpoch,
      continuesWakeHold,
    });
    if (observerOwned === undefined) return Promise.resolve();
    const payload: ExecuteCompletePayload = {
      ...rawPayload,
      streamEpoch,
      continuesWakeHold,
      observerOwned,
    };
    if (!continuesWakeHold) {
      clearChunkCounter(payload.subChatId, payload.assistantMessageId, streamEpoch);
    }
    input.broadcast('socket:execute-complete', payload);
    return (async () => {
      const terminalDurability = await finalizeCompletion(payload);
      markLiveStreamCompletionFinalized({
        subChatId: payload.subChatId,
        assistantMessageId: payload.assistantMessageId,
        streamEpoch,
        terminalDurability,
      });
      if (
        settleLiveStreamCompletion({
          subChatId: payload.subChatId,
          assistantMessageId: payload.assistantMessageId,
          streamEpoch,
          terminalDurability,
        })
      ) {
        input.broadcast('socket:stream-settled', {
          chatId: payload.chatId,
          subChatId: payload.subChatId,
          assistantMessageId: payload.assistantMessageId,
          streamEpoch,
          terminalDurability,
        });
      }
    })();
  };

  const emitErrorDirect = (
    rawPayload: ErrorPayload,
    terminalDurability: TranscriptTerminalDurability = { durability: 'non-durable' },
  ): void => {
    const streamEpoch = rawPayload.assistantMessageId
      ? (rawPayload.streamEpoch ??
        resolveLiveStreamEpoch(rawPayload.subChatId, rawPayload.assistantMessageId))
      : undefined;
    const payload: ErrorPayload = {
      ...rawPayload,
      ...(streamEpoch ? { streamEpoch, terminalDurability } : {}),
    };
    if (payload.assistantMessageId && streamEpoch) {
      const accepted = recordLiveStreamError({
        chatId: payload.chatId,
        subChatId: payload.subChatId,
        assistantMessageId: payload.assistantMessageId,
        streamEpoch,
        error: payload.error,
        category: payload.category,
        terminalDurability,
      });
      if (!accepted) return;
      clearChunkCounter(payload.subChatId, payload.assistantMessageId, streamEpoch);
    }
    input.broadcast('socket:error', payload);
  };

  const sendErrorDirect = (
    rawPayload: ErrorPayload,
    finalization?: ExecuteCompletePayload,
  ): void | Promise<void> => {
    if (!finalization || !rawPayload.assistantMessageId) {
      emitErrorDirect(rawPayload);
      return;
    }
    const streamEpoch =
      rawPayload.streamEpoch ??
      resolveLiveStreamEpoch(rawPayload.subChatId, rawPayload.assistantMessageId);
    if (
      !isLiveStreamEpochCurrent(rawPayload.subChatId, rawPayload.assistantMessageId, streamEpoch)
    ) {
      return Promise.resolve();
    }
    const observerOwned = beginLiveStreamCompletion({
      ...finalization,
      chatId: rawPayload.chatId,
      subChatId: rawPayload.subChatId,
      assistantMessageId: rawPayload.assistantMessageId,
      streamEpoch,
      continuesWakeHold: false,
    });
    if (observerOwned === undefined) return Promise.resolve();
    return (async () => {
      const terminalDurability = await finalizeCompletion({ ...finalization, streamEpoch });
      emitErrorDirect({ ...rawPayload, streamEpoch }, terminalDurability);
    })();
  };

  const sendStreamSettledDirect = createStreamSettledSender(input.broadcast);

  return {
    sendErrorDirect,
    sendExecuteCompleteDirect,
    sendStreamChunkDirect,
    sendStreamSettledDirect,
  };
}
