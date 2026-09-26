import { Button } from '@benord-labs/frink-primitives';
import type { ReactElement } from 'react';
import { AgentUserQuestion, type AgentUserQuestionHandle } from '../../../AgentUserQuestion';
import type { PendingUserQuestion } from '../../../atoms';
import { STRINGS } from '../constants';

type Props = {
  pendingQuestions: PendingUserQuestion | null;
  questionRef: React.RefObject<AgentUserQuestionHandle | null>;
  /**
   * True only where this card OWNS the composer slot with a live turn behind it: a held tool
   * approval keeps the turn streaming, and the composer it replaced carried the only visible Stop.
   * A flow strip keeps its own Stop, which also cancels the run — this one must not stand in for it.
   */
  canStopTurn: boolean;
  onStopTurn: () => void;
  handleQuestionsAnswer: (answers: Record<string, string>) => Promise<boolean>;
  handleQuestionsSkip: () => Promise<boolean>;
};

export function UserQuestionsPanel({
  pendingQuestions,
  questionRef,
  canStopTurn,
  onStopTurn,
  handleQuestionsAnswer,
  handleQuestionsSkip,
}: Props): ReactElement | null {
  const submitAnswer = async (answers: Record<string, string>): Promise<void> => {
    try {
      if (await handleQuestionsAnswer(answers)) return;
    } catch {
      // The card remains the recovery surface; report the retry below.
    }
    questionRef.current?.reset(STRINGS.QUESTION_ANSWER_RETRY);
  };
  const submitSkip = async (): Promise<void> => {
    try {
      if (await handleQuestionsSkip()) return;
    } catch {
      // The card remains the recovery surface; report the retry below.
    }
    questionRef.current?.reset(STRINGS.QUESTION_SKIP_RETRY);
  };

  if (!pendingQuestions) {
    return null;
  }

  // Match ChatInputArea: `px-2` + `mx-auto w-full max-w-2xl` so width aligns with the composer shell.
  return (
    <div className="relative z-20 min-w-0 px-2 pb-2">
      <div className="mx-auto w-full max-w-2xl">
        <AgentUserQuestion
          ref={questionRef}
          pendingQuestions={pendingQuestions}
          onAnswer={submitAnswer}
          onSkip={submitSkip}
        />
        {/* Aborting has to stay possible without first answering — the composer's Stop is gone
            while this card holds its slot, and Escape is bound to skipping the question. */}
        {canStopTurn && (
          <div className="flex justify-end pt-1.5">
            <Button
              variant="ghost"
              size="sm"
              onClick={onStopTurn}
              className="h-6 px-2 text-xs font-normal rounded-md glass-float border border-border"
            >
              Stop
            </Button>
          </div>
        )}
      </div>
    </div>
  );
}
