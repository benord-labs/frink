/**
 * The executor's IO adapters for a between-turn wake pump.
 *
 * `claude-wake-hold` is deliberately IO-free — it takes these as injected thin adapters so it stays
 * out of the client↔executor import cycle and is trivially testable. Building them lives here
 * rather than inline in the executor so the seam is readable on its own.
 *
 * That is also why the senders arrive as PARAMETERS instead of being imported from `../client`:
 * the executor already imports them, and importing them here would close the very cycle the
 * injection exists to avoid (client → executor → wake-hold-io → client). Type-only imports are
 * fine; they erase.
 */

import type { TranscriptTerminalDurability } from '../../../../shared/types/assistant-message';
import type { TaskSignalPayload } from '../../../../shared/types/task-signal';
import type { WakeHoldChangedPayload } from '../../../../shared/types/wake-hold';
import type { UIMessageChunk } from '../../claude/types';
import type { WakeHoldIo } from '../claude-wake-hold';
import type { ExecuteCompletePayload, MessagePart, StreamChunkPayload } from '../client';
import { clearChunkCounter } from './assistant-chunk-checkpoint';
import { emitBurstPlanCard } from './burst-chunks';
import { finishHeldLiveStreams } from './live-stream';

/** The `./client` senders a burst needs, injected by the executor (see the module doc). */
type BurstSenders = {
  sendStreamChunkDirect: (payload: StreamChunkPayload) => void;
  sendExecuteCompleteDirect: (payload: ExecuteCompletePayload) => Promise<void>;
  sendStreamSettledDirect: (payload: {
    chatId: string;
    subChatId: string;
    assistantMessageId: string;
    streamEpoch: string;
    terminalDurability?: TranscriptTerminalDurability;
  }) => void;
  sendWakeHoldChanged: (payload: WakeHoldChangedPayload) => void;
};

export function buildWakeHoldIo(params: {
  chatId: string;
  subChatId: string;
  /** Executor-owned: folds a burst's chunks into the parts we persist (plan-mode filtering et al).
   * MUST be built with the ARMING TURN'S REAL MODE, never a constant: a plan turn's bursts can emit
   * a plan card, and only the plan branch dedupes that card against the prose repeating it. Folding
   * as 'agent' shows that prose on reload above a card the live view had filtered out. */
  buildFinalParts: (chunks: UIMessageChunk[]) => MessagePart[];
  /** Plan-card treatment for this execution: flow runs render differently, and an auto-approved
   * node is carved out of burst plan cards entirely (see {@link emitBurstPlanCard}). */
  flowDriven: boolean;
  planAutoApprove: boolean;
  /** The burst's shared stream index — a plan card must continue it, never restart. */
  nextMessageIndex: () => number;
  send: BurstSenders;
  clearPendingApprovals: (reason: string, subChatId: string) => void;
  getLatestTaskSignal: (executionContextId: string) => TaskSignalPayload | null | undefined;
  clearCurrentExecutionChat: (executionContextId: string) => void;
}): WakeHoldIo {
  const { chatId, subChatId, buildFinalParts, send } = params;
  let holdActive = false;
  const io: WakeHoldIo = {
    chatId,
    streamChunk: (msgId, chunk, parts, messageIndex) => {
      send.sendStreamChunkDirect({
        chatId,
        subChatId,
        assistantMessageId: msgId,
        chunk,
        parts,
        messageIndex,
        wakeBurst: true,
      });
    },
    completeBurst: async (msgId, chunks, hadContent) => {
      // An all-dropped burst has nothing to say — re-persisting the message unchanged would only
      // re-broadcast it. `chunks` carries the whole wait and is never empty, so the caller tells us.
      // Awaited: the caller may be about to dispose the session, and an abandoned write would leave
      // this burst's text only in the CLI's own transcript.
      if (hadContent) {
        await send.sendExecuteCompleteDirect({
          chatId,
          subChatId,
          assistantMessageId: msgId,
          finalParts: buildFinalParts(chunks),
          wakeBurst: true,
          continuesWakeHold: holdActive,
        });
      }
    },
    setHeld: (held, pending, endReason) => {
      // Latch before any asynchronous completion can inspect it. `wakeBurst` identifies the
      // observer lane; it does not prove the wait still exists after Stop/reload retracted it.
      holdActive = held;
      if (!held) {
        for (const finished of finishHeldLiveStreams(subChatId)) {
          clearChunkCounter(subChatId, finished.assistantMessageId, finished.streamEpoch);
          if (finished.terminalDurability) {
            send.sendStreamSettledDirect({
              chatId,
              subChatId,
              assistantMessageId: finished.assistantMessageId,
              streamEpoch: finished.streamEpoch,
              terminalDurability: finished.terminalDurability,
            });
          }
        }
      }
      // Spread rather than pass through: a retraction carries no detail, and `pending: undefined`
      // is a present key, so the frame would contradict the contract it is meant to satisfy.
      send.sendWakeHoldChanged({
        chatId,
        subChatId,
        held,
        ...(pending && { pending }),
        ...(endReason && { endReason }),
      });
    },
    clearPendingApprovals: params.clearPendingApprovals,
    getLatestTaskSignal: params.getLatestTaskSignal,
    clearCurrentExecutionChat: params.clearCurrentExecutionChat,
    emitPlanCard: (msgId, chunks, startIndex, deniedToolIdsWithMessages, turn) =>
      emitBurstPlanCard({
        chatId,
        subChatId,
        msgId,
        chunks,
        startIndex,
        deniedToolIdsWithMessages,
        flowDriven: params.flowDriven,
        planAutoApprove: params.planAutoApprove,
        nextMessageIndex: params.nextMessageIndex,
        streamChunk: io.streamChunk,
        onSubmitted: turn.onSubmitted,
        planAlreadySubmitted: turn.planAlreadySubmitted,
        waitStartedMs: turn.waitStartedMs,
      }),
  };
  return io;
}
