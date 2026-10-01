/**
 * FlowChatBottomSurface — renders the flow-chat bottom surface state machine (decision
 * flow-run-chat-surface). While a flow run drives the sub-chat the composer is replaced by a
 * state-matched surface: the running strip (Pause/Stop/add-a-note), the paused bar (reply + Resume
 * + Stop), or the park answer surface. Terminal runs and non-flow chats render the composer — unless
 * an AskUserQuestion card is up, which owns that slot so the chat never offers two ways to answer
 * one question. Owns the flow-specific affordances on top of ONE guarded send.
 *
 * The surface renders in the composer's slot in place of the composer child; ChatDock keeps the
 * workspace row, split-pane sync and scroll button mounted outside it.
 */
import { memo, type ReactNode, useCallback } from 'react';
import { buildHiddenWakeMessage } from '../../../../../../../shared/lib/message-markers/hidden-wake-marker';
import type { TaskResultRecord } from '../../../../../../../shared/types/task-result';
import type { FlowChatBottomSurface as BottomSurfaceState } from '../../../../../../lib/agent-chat/flow-chat-surface-state';
import { RESUME_PAUSED_WAKE_TEXT } from '../../../../../../lib/agent-chat/resume-wake-text';
import { useSteerOrQueue } from '../../../../../../lib/agent-chat/steer';
import { createQueueItem, generateQueueId } from '../../../../lib/queue-utils';
import { useMessageQueueStore } from '../../../../stores/message-queue-store';
import { FlowPausedBar, FlowRunStrip } from '../FlowRunStrip';
import { ParkAnswerSurface } from '../ParkAnswerSurface';

type Props = {
  subChatId: string;
  /** The driving flow task (ActiveChat owns the query) — the park surface reads its signal. */
  task: {
    id: string;
    status: string;
    result?: TaskResultRecord | null;
    flowRunId?: string | null;
  } | null;
  parentChatId: string | null;
  /**
   * The live-or-expired AskUserQuestion card, or null. It OWNS the composer slot wherever the
   * composer would otherwise render, so the chat never shows two competing input surfaces; at every
   * other kind the slot already belongs to a flow surface, so the card renders above it instead.
   * Its presence also suppresses the park surface, so the two cards never stack.
   */
  questionCard: ReactNode | null;
  bottomSurface: BottomSurfaceState;
  /** Submitted/streaming state for failure recovery if a resume turn ends without unparking. */
  isTurnActive: boolean;
  /**
   * Guarded chat send (socket/account checks + autoscroll); returns whether it actually sent.
   * Optional display-only message metadata (e.g. the answer card) rides along; the model never sees it.
   */
  guardedSend: (text: string, metadata?: Record<string, unknown>) => boolean;
  /** Aborts the local in-flight turn (composer stop) — combined with flows.cancelRun for Stop. */
  onStopTurn: () => Promise<void> | void;
  /** The composer, rendered only at the composer kind with no question card in its slot. */
  children: ReactNode;
};

export const FlowChatBottomSurface = memo(function FlowChatBottomSurface({
  subChatId,
  task,
  parentChatId,
  questionCard,
  bottomSurface,
  isTurnActive,
  guardedSend,
  onStopTurn,
  children,
}: Props) {
  // The card takes the composer's own slot only where the composer would render; everywhere else a
  // flow surface already owns that slot and carries the run's only Pause/Stop.
  const cardOwnsComposerSlot = Boolean(questionCard) && bottomSurface.kind === 'composer';
  const addToQueue = useMessageQueueStore((s) => s.addToQueue);
  const steerOrQueue = useSteerOrQueue(subChatId);

  // Deliver a mid-run note INTO the running step. This is what steering unlocked: the note used to
  // be queue-only because a direct send supersedes (aborts) the in-flight turn via the executor's
  // duplicate-request path, so it would kill the very step it annotates. A steer costs the step
  // nothing, so the note finally reaches the node it is about.
  //
  // Still NEVER a direct send: anything the agent cannot take falls back to the queue (with a
  // toast), where the QueueProcessor delivers it at stream end and it stays visible/editable.
  const handleSteerNote = useCallback(
    (text: string): boolean => {
      void steerOrQueue(text, undefined, () =>
        addToQueue(subChatId, createQueueItem(generateQueueId(), text)),
      );
      // Reported sent regardless: the note is never dropped, and holding the field open on an
      // async round trip would make every note feel like it failed.
      return true;
    },
    [steerOrQueue, addToQueue, subChatId],
  );

  // Resume a user-paused flow without new instructions: a hidden wake message through the same
  // follow-up pipe a typed reply uses (resumeTaskOnFollowUpMessage unparks the run in place).
  const handleResume = useCallback((): boolean => {
    return guardedSend(buildHiddenWakeMessage(RESUME_PAUSED_WAKE_TEXT));
  }, [guardedSend]);

  return (
    <>
      {/* Above the composer slot: the park answer surface, and the question card whenever a flow
          surface holds the slot the card would otherwise take. */}
      {cardOwnsComposerSlot ? null : questionCard}
      {/* Answer surface for any user-input park of the driving task: clickable options when the
          signal carries structured questions, else summary + free-text reply. */}
      <ParkAnswerSurface
        task={task}
        subChatId={subChatId}
        parentChatId={parentChatId}
        suppressed={Boolean(questionCard)}
        onSubmitAnswer={guardedSend}
      />
      {/* The slot. A flow surface replaces the whole composer child, account states included: the
          composer is unusable during a run, so a reconnect card under a running strip is noise. */}
      {cardOwnsComposerSlot ? (
        questionCard
      ) : bottomSurface.kind === 'running' ? (
        // Keyed like the paused bar: the strip carries local state (an armed "Confirm stop", an
        // open note field), and a second run on the same sub-chat would otherwise inherit it.
        <FlowRunStrip
          key={bottomSurface.flowRunId}
          subChatId={subChatId}
          flowRunId={bottomSurface.flowRunId}
          canPause={bottomSurface.canPause}
          modelId={bottomSurface.modelId}
          mode={bottomSurface.mode}
          autoReviewTools={bottomSurface.autoReviewTools}
          codexSpeed={bottomSurface.codexSpeed}
          onAddNote={handleSteerNote}
          onStopTurn={onStopTurn}
        />
      ) : bottomSurface.kind === 'paused' ? (
        <FlowPausedBar
          key={bottomSurface.flowRunId}
          flowRunId={bottomSurface.flowRunId}
          subChatId={subChatId}
          modelId={bottomSurface.modelId}
          mode={bottomSurface.mode}
          autoReviewTools={bottomSurface.autoReviewTools}
          codexSpeed={bottomSurface.codexSpeed}
          isTurnActive={isTurnActive}
          onSubmitAnswer={guardedSend}
          onResume={handleResume}
          onStopTurn={onStopTurn}
        />
      ) : bottomSurface.kind === 'park' ? null : (
        children
      )}
    </>
  );
});
