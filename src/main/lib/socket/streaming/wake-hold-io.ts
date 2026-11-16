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

import log from 'electron-log';
import { z } from 'zod';
import type { TranscriptTerminalDurability } from '../../../../shared/types/assistant-message';
import type { ExecutionSettings } from '../../../../shared/types/execution';
import { PLAN_APPROVAL_EXECUTION_TRIGGER_TEXT } from '../../../../shared/types/plan';
import type { TaskSignalPayload } from '../../../../shared/types/task-signal';
import type { WakeHoldChangedPayload } from '../../../../shared/types/wake-hold';
import type { UIMessageChunk } from '../../claude/types';
import { reportWork } from '../../power/work-activity';
import { captureMainException } from '../../sentry/init';
import { persistLinkedTaskSignal } from '../../trpc/routers/frink-task-signal-persist';
import type { WakeHoldIo } from '../claude-wake-hold';
import type {
  ExecuteCompletePayload,
  MessagePart,
  MessageSendPayload,
  StreamChunkPayload,
} from '../client';
import { ChatBusyError, DuplicateMessageError } from '../execution/send-admission';
import { lastFinishMetadata, stampTurnUsage } from '../execution/turn-usage';
import { clearChunkCounter } from './assistant-chunk-checkpoint';
import { emitBurstPlanCard } from './burst-chunks';
import { finishHeldLiveStreams } from './live-stream';

/** Waits the user sees as held, one entry per execution's IO so a stale hold can't clear its successor. */
const heldWaits = new Set<WakeHoldIo>();

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
  sendMessage: (payload: MessageSendPayload, options: { rejectIfBusy: boolean }) => Promise<void>;
};

/** What Frink's own approval turn needs for an auto-approve node's plan turn. */
type PlanAutoApproval = {
  projectId: string;
  settings: ExecutionSettings | undefined;
  signalTaskId: string | null;
};

/** The executor's expected refusals of a send into a Flow run that ended or will resume itself. */
const ExpectedFlowDecline = z.object({ category: z.enum(['FLOW_RUN_ENDED', 'FLOW_RUN_RESUMING']) });

/** Approve an auto-approve node's carded plan as a person's Approve does: a new Agent-mode turn
 * that adopts the held session. A failure parks the task now, never at the idle ceiling. */
async function sendPlanApproval(
  params: { chatId: string; subChatId: string; msgId: string; planText: string },
  approval: PlanAutoApproval,
  sendMessage: BurstSenders['sendMessage'],
): Promise<void> {
  const { chatId, subChatId, msgId, planText } = params;
  try {
    // The arming turn's settings carry the Flow's Auto choice; without them the turn would prompt.
    if (!approval.settings) throw new Error("this run's settings could not be read");
    await sendMessage(
      {
        chatId,
        subChatId,
        projectId: approval.projectId,
        userMessage: {
          id: `plan-approval-${msgId}`,
          role: 'user',
          parts: [{ type: 'text', text: PLAN_APPROVAL_EXECUTION_TRIGGER_TEXT }],
        },
        mode: 'agent',
        settings: approval.settings,
        approvedPlanContext: { planText },
        expectedFlowTaskId: approval.signalTaskId ?? undefined,
      },
      { rejectIfBusy: true },
    );
  } catch (error) {
    // Already owned: a user turn, this same approval, or the Flow run. Nothing is stuck to park.
    if (error instanceof ChatBusyError || error instanceof DuplicateMessageError) return;
    if (ExpectedFlowDecline.safeParse(error).success) return;
    const cause = error instanceof Error ? error.message : String(error);
    log.warn(`[Socket Executor] Auto-approved plan could not start for ${subChatId}: ${cause}`);
    captureMainException(error, { surface: 'plan-auto-approval' });
    await persistLinkedTaskSignal({
      taskIdForExecution: approval.signalTaskId,
      signal: {
        state: 'blocked',
        summary: `The plan was approved, but implementing it could not start (${cause}). Reply to carry on.`,
        at: new Date().toISOString(),
      },
    }).catch((parkError) =>
      captureMainException(parkError, { surface: 'plan-auto-approval-park' }),
    );
  }
}

export function buildWakeHoldIo(params: {
  chatId: string;
  subChatId: string;
  /** Executor-owned: folds a burst's chunks into the parts we persist (plan-mode filtering et al).
   * MUST be built with the ARMING TURN'S REAL MODE, never a constant: a plan turn's bursts can emit
   * a plan card, and only the plan branch dedupes that card against the prose repeating it. Folding
   * as 'agent' shows that prose on reload above a card the live view had filtered out. */
  buildFinalParts: (chunks: UIMessageChunk[]) => MessagePart[];
  /** The linked task each burst re-stamps with the message's context usage (turn-usage.ts). */
  usageTaskId: string | null;
  /** Plan-card treatment for this execution: flow runs render differently. */
  flowDriven: boolean;
  /** Set only on an auto-approve node's plan turn, whose burst-finished plan Frink approves. */
  planAutoApproval: PlanAutoApproval | null;
  /** The burst's shared stream index — a plan card must continue it, never restart. */
  nextMessageIndex: () => number;
  send: BurstSenders;
  clearPendingApprovals: (reason: string, subChatId: string) => void;
  getLatestTaskSignal: (executionContextId: string) => TaskSignalPayload | null | undefined;
  clearCurrentExecutionChat: (executionContextId: string) => void;
}): WakeHoldIo {
  const { chatId, subChatId, buildFinalParts, send, planAutoApproval } = params;
  let holdActive = false;
  /** A carded auto-approved plan, sent once the burst that carded it is persisted. */
  let approvedPlanText: string | null = null;
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
        const finalParts = buildFinalParts(chunks);
        await send.sendExecuteCompleteDirect({
          chatId,
          subChatId,
          assistantMessageId: msgId,
          finalParts,
          wakeBurst: true,
          continuesWakeHold: holdActive,
        });
        // Before the caller settles the burst's signal, which may flip the task terminal.
        const metadata = lastFinishMetadata(chunks);
        await stampTurnUsage(params.usageTaskId, msgId, metadata, finalParts, true);
      }
      const planText = approvedPlanText;
      approvedPlanText = null;
      // Not awaited: the approval turn adopts this hold, which waits for this burst to finish.
      if (planText && planAutoApproval)
        void sendPlanApproval(
          { chatId, subChatId, msgId, planText },
          planAutoApproval,
          send.sendMessage,
        );
    },
    setHeld: (held, pending, endReason) => {
      // Latch before any asynchronous completion can inspect it. `wakeBurst` identifies the
      // observer lane; it does not prove the wait still exists after Stop/reload retracted it.
      holdActive = held;
      if (held) heldWaits.add(io);
      else heldWaits.delete(io);
      reportWork('background-waits', heldWaits.size > 0);
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
    emitPlanCard: async (msgId, chunks, startIndex, deniedToolIdsWithMessages, turn) => {
      approvedPlanText ??= await emitBurstPlanCard({
        chatId,
        subChatId,
        msgId,
        chunks,
        startIndex,
        deniedToolIdsWithMessages,
        flowDriven: params.flowDriven,
        planAutoApprove: planAutoApproval !== null,
        nextMessageIndex: params.nextMessageIndex,
        streamChunk: io.streamChunk,
        onSubmitted: turn.onSubmitted,
        planAlreadySubmitted: turn.planAlreadySubmitted,
        waitStartedMs: turn.waitStartedMs,
      });
    },
  };
  return io;
}
