import { useAtomValue } from 'jotai';
import { memo } from 'react';
import {
  QUESTION_TIMED_OUT_RESULT,
  toAnsweredQuestions,
} from '../../../../shared/lib/agent-questions/answered-questions';
import { TextShimmer } from '../../../components/ui/text-shimmer';
import {
  askUserQuestionResultsAtom,
  pendingUserQuestionsAtom,
  QUESTIONS_SKIPPED_MESSAGE,
} from '../atoms';
import { AnsweredQuestionsCard } from './AnsweredQuestionsCard';
import { areAskUserQuestionPropsEqual } from './agent-tool-utils';

type AgentAskUserQuestionToolProps = {
  input: {
    questions?: Array<{
      question: string;
      header: string;
      options: Array<{ label: string; description: string }>;
      multiSelect: boolean;
    }>;
  };
  result?:
    | {
        questions?: unknown;
        answers?: Record<string, string>;
      }
    | string;
  errorText?: string;
  /** This card's own settled/unsettled flag — not a `ToolPartState`. Do not conflate the two. */
  state: 'call' | 'result';
  isError?: boolean;
  isStreaming?: boolean; // Whether the message is currently streaming
  toolCallId?: string; // Tool call ID for looking up real-time results
};

export const AgentAskUserQuestionTool = memo(function AgentAskUserQuestionTool({
  input,
  result,
  errorText,
  state,
  isError,
  isStreaming,
  toolCallId,
}: AgentAskUserQuestionToolProps) {
  const questions = input?.questions ?? [];
  const questionCount = questions.length;

  // Get real-time results from atom (for immediate updates before DB sync)
  const resultsMap = useAtomValue(askUserQuestionResultsAtom);
  const realtimeResult = toolCallId ? resultsMap.get(toolCallId) : undefined;

  // Check if the question dialog is currently shown for this tool
  const pendingQuestionsMap = useAtomValue(pendingUserQuestionsAtom);
  const isDialogShown = toolCallId
    ? Array.from(pendingQuestionsMap.values()).some((q) => q.toolUseId === toolCallId)
    : false;

  // Use realtime result if available, otherwise fall back to prop
  const effectiveResult = realtimeResult ?? result;

  // For errors, SDK stores errorText separately - use it to detect skip/timeout
  const effectiveErrorText =
    errorText || (typeof effectiveResult === 'string' ? effectiveResult : undefined);

  // Extract answers for display
  const answers =
    effectiveResult && typeof effectiveResult === 'object' && 'answers' in effectiveResult
      ? (effectiveResult as { answers?: Record<string, string> }).answers
      : null;

  // Determine status
  const isSkipped = effectiveErrorText === QUESTIONS_SKIPPED_MESSAGE;
  const isTimedOut = effectiveErrorText === QUESTION_TIMED_OUT_RESULT;
  const isCompleted = state === 'result' && answers && !isSkipped && !isTimedOut && !isError;

  // Show loading state if:
  // 1. No questions yet (still streaming input)
  // 2. Streaming but dialog not yet shown (waiting for ask-user-question chunk)
  if (state === 'call' && (questionCount === 0 || (isStreaming && !isDialogShown))) {
    return (
      <div className="flex items-center gap-2 py-1 px-2 text-xs text-muted-foreground">
        <TextShimmer className="text-xs" duration={1.5}>
          Asking question...
        </TextShimmer>
      </div>
    );
  }

  // Show the reason the question closed. A STRING result is always terminal — skipped, timed out, or
  // a teardown reason like "Paused by user." — because only an `{answers}` OBJECT can still be
  // mid-sync. Matching the two known strings alone left every other reason falling through to the
  // "Submitting..." branch below, where it would spin forever.
  const closedReason = typeof effectiveResult === 'string' ? effectiveResult : undefined;
  if (state === 'result' && closedReason) {
    const firstQuestion = questions[0]?.header || questions[0]?.question;
    return (
      <div className="flex items-center gap-2 py-1 px-2 text-xs text-muted-foreground">
        <span className="min-w-0 truncate">{firstQuestion || 'Question'}</span>
        <span className="text-muted-foreground/50">•</span>
        <span>{isTimedOut ? 'Timed out' : isSkipped ? 'Skipped' : closedReason}</span>
      </div>
    );
  }

  // Show error state
  if (state === 'result' && isError) {
    return (
      <div className="flex items-center gap-2 py-1 px-2 text-xs text-muted-foreground">
        <span>Question</span>
        <span className="text-muted-foreground/50">•</span>
        <span className="text-red-500">{effectiveErrorText || 'Error'}</span>
      </div>
    );
  }

  // Show completed state with card layout. Prefer `questions`, so rows are labelled by the short
  // `header` exactly as the parked-answer card is. `input.questions` is optional on this tool part
  // (a result can outlive a truncated input), so fall back to the answers map, whose keys are the
  // full question text — a longer label, but never a missing one.
  if (isCompleted && answers) {
    const entries = questions.length
      ? toAnsweredQuestions(questions, answers)
      : Object.entries(answers).map(([label, answer]) => ({ label, answer }));
    return <AnsweredQuestionsCard entries={entries} className="mx-2" />;
  }

  // Show pending state
  const firstQuestion = questions[0]?.header || questions[0]?.question;

  // Waiting while THIS message streams, or while its answer card is shown: main still holds it,
  // even when a reload re-raised it with no live run observed.
  if (isStreaming || isDialogShown) {
    return (
      <div className="flex items-center gap-2 py-1 px-2 text-xs text-muted-foreground">
        <span className="min-w-0 truncate">{firstQuestion || 'Question'}</span>
        <span className="text-muted-foreground/50">•</span>
        <span>Waiting for response...</span>
      </div>
    );
  }

  // If we have a realtime result but it hasn't synced to the message yet,
  // show "Submitting..." (user just answered, waiting for sync)
  // Note: realtimeResult is set immediately when user answers via ask-user-question-result chunk
  // If there's no realtimeResult and no answers, the stream was interrupted without an answer
  if (state === 'result' && realtimeResult && !answers && !isError && !isSkipped && !isTimedOut) {
    return (
      <div className="flex items-center gap-2 py-1 px-2 text-xs text-muted-foreground">
        <span className="min-w-0 truncate">{firstQuestion || 'Question'}</span>
        <span className="text-muted-foreground/50">•</span>
        <span>Submitting...</span>
      </div>
    );
  }

  // Not streaming and state is "call" - it was truly interrupted
  return (
    <div className="flex items-center gap-2 py-1 px-2 text-xs text-muted-foreground">
      <span className="min-w-0 truncate">{firstQuestion || 'Question'}</span>
      <span className="text-muted-foreground/50">•</span>
      <span>Interrupted</span>
    </div>
  );
}, areAskUserQuestionPropsEqual);
