/**
 * ParkAnswerSurface — chat-level answer surface for the driving task parked at `needs_attention`.
 * Guarantees EVERY user-input park an in-place reply affordance (decision flow-park-answer-surface):
 * structured `questions` render the clickable AgentUserQuestion card; every other user-input park
 * (a prose awaiting_input ask, blocked, partial) renders the agent's summary + a free-text reply
 * box. Either path submits as a normal follow-up message (`onSubmitAnswer`), which the executor's
 * resumeTaskOnFollowUpMessage turns into a resume for both standalone and flow tasks — no bespoke
 * resume path. Transient parks (usage limit / API error) render nothing here: TaskControls owns
 * their Carry on / Retry. Hidden while a live AskUserQuestion is pending (`suppressed`) so two
 * cards never stack.
 */
import { memo, useRef } from 'react';
import { buildAnswerMessage } from '../../../../../../../shared/lib/agent-questions/answered-questions';
import { stripHiddenWakeMarker } from '../../../../../../../shared/lib/message-markers/hidden-wake-marker';
import type { TaskResultRecord } from '../../../../../../../shared/types/task-result';
import { deriveParkSurfaceState } from '../../../../../../lib/agent-chat/flow-chat-surface-state';
import { AgentUserQuestion, type AgentUserQuestionHandle } from '../../../../AgentUserQuestion';
import { FlowReplyBox } from '../FlowReplyBox';

type Props = {
  /**
   * The DRIVING flow task for the sub-chat, owned and polled by ActiveChat — never the chat's pinned
   * `taskId`: in a multi-node flow the pin stays on the FIRST node (goes terminal) while a later
   * node's task holds the `awaiting_input` signal + questions. Passed in rather than re-queried so
   * this surface and the bottom-surface state machine can never disagree about the same task.
   */
  task: ParkedFlowTask | null;
  subChatId: string;
  parentChatId: string | null;
  /** True while a live AskUserQuestion card is shown — suppress so the two cards never stack. */
  suppressed: boolean;
  /**
   * Sends the picked answer as a follow-up message; returns whether it actually sent. The optional
   * metadata is display-only (renders the answer card) and never reaches the model.
   */
  onSubmitAnswer: (text: string, metadata?: Record<string, unknown>) => boolean;
};

type ParkedFlowTask = {
  id: string;
  status: string;
  result?: TaskResultRecord | null;
  flowRunId?: string | null;
};

export const ParkAnswerSurface = memo(function ParkAnswerSurface({
  task,
  subChatId,
  parentChatId,
  suppressed,
  onSubmitAnswer,
}: Props) {
  const questionRef = useRef<AgentUserQuestionHandle | null>(null);

  const surface = deriveParkSurfaceState(task);
  if (suppressed || surface.kind === 'none' || !task) {
    return null;
  }
  // The free-text reply box is load-bearing only where the composer is hidden (flow chats — the
  // bottom-surface state machine swaps it out). A NON-flow prose park keeps the composer, and a
  // second text input above it would be redundant (the composer reply rides the same resume pipe).
  // The questions card still renders for both: it is a pick affordance, not a duplicate input.
  if (surface.kind === 'reply' && !task.flowRunId) {
    return null;
  }

  // Match UserQuestionsPanel: same composer-aligned slot styling for both variants.
  return (
    <div className="relative z-20 min-w-0 px-2 pb-2">
      <div className="mx-auto w-full max-w-2xl">
        {surface.kind === 'questions' ? (
          <AgentUserQuestion
            ref={questionRef}
            pendingQuestions={{
              subChatId,
              parentChatId: parentChatId ?? '',
              // Key on the DRIVING task's id (not the pinned `taskId`) so sequential parked nodes
              // on one sub-chat get distinct toolUseIds and the card resets its submitting-state
              // between them.
              toolUseId: `parked-${task.id}`,
              questions: surface.questions,
            }}
            onAnswer={(answers) => {
              // Re-enable the card if the pick didn't actually send (nothing picked, socket offline,
              // account not ready) — else AgentUserQuestion's isSubmitting stays stuck and the user
              // can never retry (the parked toolUseId never changes to auto-reset it).
              const answer = buildAnswerMessage(surface.questions, answers);
              // Human intake — same marker sanitize as FlowReplyBox/the composer.
              if (!answer || !onSubmitAnswer(stripHiddenWakeMarker(answer.text), answer.metadata)) {
                questionRef.current?.reset();
              }
            }}
            // Skip is meaningless for a parked task (the agent is awaiting an answer); hide it so a
            // Skip click can't leave the card permanently disabled. The user can still type
            // free-form.
            allowSkip={false}
            onSkip={() => {}}
          />
        ) : (
          // Key on the driving task so sequential parked nodes reset the draft between parks.
          <FlowReplyBox key={task.id} summary={surface.summary} onSubmit={onSubmitAnswer} />
        )}
      </div>
    </div>
  );
});
