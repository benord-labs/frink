/* eslint-disable max-lines, max-lines-per-function */
import { Button, Input } from '@benord-labs/frink-primitives';
import { ChevronDown, ChevronUp, CornerDownLeft } from 'lucide-react';
import {
  forwardRef,
  memo,
  useCallback,
  useEffect,
  useImperativeHandle,
  useRef,
  useState,
} from 'react';
import { ChatMarkdownRenderer } from '../../../components/chat-markdown-renderer';
import { combineAnswer, hasOwnOtherOption } from '../../../lib/agent-chat/questions/answer-utils';
import { useQuestionKeyboard } from '../../../lib/agent-chat/questions/use-question-keyboard';
import { cn } from '../../../lib/utils';
import { chatOwnsKeyboardShortcuts } from '../../../lib/work-queue/chat-owns-keyboard-shortcuts';
import type { PendingUserQuestions } from '../atoms';
import { agentsChatComposerShellClass } from '../main/chat-composer-shell-classes';
import { OptionRow } from './OptionRow';

export { combineAnswer, hasOwnOtherOption } from '../../../lib/agent-chat/questions/answer-utils';

type AgentUserQuestionProps = {
  pendingQuestions: PendingUserQuestions;
  onAnswer: (answers: Record<string, string>) => void;
  onSkip: () => void;
  /**
   * When false, the "Skip All" action is hidden. Parked-task cards pass false: skip has no meaning
   * there (the agent is awaiting an answer), and a skip would set `isSubmitting` and leave the card
   * permanently disabled. Defaults true.
   */
  allowSkip?: boolean;
};

export type AgentUserQuestionHandle = {
  /** Re-enable the card after a submit that did not actually send (e.g. socket offline). */
  reset: (message?: string) => void;
};

export const AgentUserQuestion = memo(
  forwardRef<AgentUserQuestionHandle, AgentUserQuestionProps>(function AgentUserQuestion(
    { pendingQuestions, onAnswer, onSkip, allowSkip = true }: AgentUserQuestionProps,
    ref,
  ) {
    const { questions, toolUseId } = pendingQuestions;
    const [currentQuestionIndex, setCurrentQuestionIndex] = useState(0);
    const [answers, setAnswers] = useState<Record<string, string[]>>({});
    // Per-question free-text. A `question` key present (value may be '') means its "Other" row is
    // active and its input revealed; kept separate from `answers` so it never aliases a real option
    // literally labelled "Other".
    const [otherText, setOtherText] = useState<Record<string, string>>({});
    const [focusedOptionIndex, setFocusedOptionIndex] = useState(0);
    const [isVisible, setIsVisible] = useState(true);
    const [isSubmitting, setIsSubmitting] = useState(false);
    const [submissionError, setSubmissionError] = useState<string | null>(null);
    const prevIndexRef = useRef(currentQuestionIndex);
    const prevToolUseIdRef = useRef(toolUseId);
    /** The scrollable question-text region — reused across questions, so it needs rewinding. */
    const questionScrollRef = useRef<HTMLDivElement>(null);

    // The card is the only answer surface, so the parent's one job on the ref is re-enabling it
    // after a submit that did not send.
    useImperativeHandle(
      ref,
      () => ({
        reset: (message) => {
          setIsSubmitting(false);
          setSubmissionError(message ?? null);
        },
      }),
      [],
    );

    // Reset when toolUseId changes (new question set). The scroll rewind cannot be left to the
    // index-keyed effect below: a replacement set resets the index to 0, which is NOT a change when
    // the card was already on question 0 — so the new question would open at the old one's offset.
    useEffect(() => {
      if (prevToolUseIdRef.current !== toolUseId) {
        setIsSubmitting(false);
        if (questionScrollRef.current) questionScrollRef.current.scrollTop = 0;
        setCurrentQuestionIndex(0);
        setAnswers({});
        setOtherText({});
        setFocusedOptionIndex(0);
        setSubmissionError(null);
        prevToolUseIdRef.current = toolUseId;
      }
    }, [toolUseId]);

    // Animate on question change, and rewind the question text. The scroll container is reused
    // rather than remounted, so without this the next question opens at the previous one's offset.
    useEffect(() => {
      if (prevIndexRef.current !== currentQuestionIndex) {
        setIsVisible(false);
        if (questionScrollRef.current) questionScrollRef.current.scrollTop = 0;
        const timer = setTimeout(() => {
          setIsVisible(true);
        }, 50);
        prevIndexRef.current = currentQuestionIndex;
        return () => clearTimeout(timer);
      }
    }, [currentQuestionIndex]);

    const currentQuestion = questions[currentQuestionIndex];
    const currentOptions = currentQuestion?.options || [];

    const isOptionSelected = (questionText: string, optionLabel: string) => {
      return answers[questionText]?.includes(optionLabel) || false;
    };

    // Handle option click - auto-advance for single-select questions
    const handleOptionClick = useCallback(
      (questionText: string, optionLabel: string, questionIndex: number) => {
        const question = questions[questionIndex];
        const allowMultiple = question?.multiSelect || false;
        const isLastQuestion = questionIndex === questions.length - 1;

        // Single-select: a real pick is mutually exclusive with "Other" — deselect it.
        if (!allowMultiple) {
          setOtherText((prev) => {
            if (!(questionText in prev)) return prev;
            const next = { ...prev };
            delete next[questionText];
            return next;
          });
        }

        setAnswers((prev) => {
          const currentAnswers = prev[questionText] || [];

          if (allowMultiple) {
            if (currentAnswers.includes(optionLabel)) {
              return {
                ...prev,
                [questionText]: currentAnswers.filter((l) => l !== optionLabel),
              };
            } else {
              return {
                ...prev,
                [questionText]: [...currentAnswers, optionLabel],
              };
            }
          } else {
            return {
              ...prev,
              [questionText]: [optionLabel],
            };
          }
        });

        // For single-select questions, auto-advance to next question
        if (!allowMultiple && !isLastQuestion) {
          setTimeout(() => {
            setCurrentQuestionIndex(questionIndex + 1);
            setFocusedOptionIndex(0);
          }, 150);
        }
      },
      [questions],
    );

    // Toggle/activate the inline "Other" free-text row. Single-select: clears picked options (mutual
    // exclusion) and reveals the input without auto-advancing (the user still has to type). Multi-select:
    // toggles the row alongside any picked options. Re-clicking preserves already-typed text.
    const handleOtherClick = useCallback(
      (questionText: string, questionIndex: number) => {
        const allowMultiple = questions[questionIndex]?.multiSelect || false;
        if (allowMultiple) {
          setOtherText((prev) => {
            if (questionText in prev) {
              const next = { ...prev };
              delete next[questionText];
              return next;
            }
            return { ...prev, [questionText]: '' };
          });
        } else {
          setAnswers((prev) => ({ ...prev, [questionText]: [] }));
          setOtherText((prev) => (questionText in prev ? prev : { ...prev, [questionText]: '' }));
        }
      },
      [questions],
    );

    const clearOther = useCallback((questionText: string) => {
      setOtherText((prev) => {
        if (!(questionText in prev)) return prev;
        const next = { ...prev };
        delete next[questionText];
        return next;
      });
    }, []);

    const handlePrevious = () => {
      if (currentQuestionIndex > 0) {
        setCurrentQuestionIndex(currentQuestionIndex - 1);
        setFocusedOptionIndex(0);
      }
    };

    const handleNext = () => {
      if (currentQuestionIndex < questions.length - 1) {
        setCurrentQuestionIndex(currentQuestionIndex + 1);
        setFocusedOptionIndex(0);
      }
    };

    // A question counts as answered when it has a picked option OR non-empty "Other" text. A revealed
    // but untyped "Other" does not count.
    const isQuestionAnswered = useCallback(
      (questionText: string) =>
        (answers[questionText]?.length ?? 0) > 0 || (otherText[questionText]?.trim() ?? '') !== '',
      [answers, otherText],
    );

    const handleContinue = useCallback(() => {
      if (isSubmitting) return;

      if (!isQuestionAnswered(currentQuestion?.question)) return;

      if (currentQuestionIndex < questions.length - 1) {
        setCurrentQuestionIndex(currentQuestionIndex + 1);
        setFocusedOptionIndex(0);
      } else {
        // On the last question, validate ALL questions are answered before submit
        const allAnswered = questions.every((q) => isQuestionAnswered(q.question));
        if (allAnswered) {
          setSubmissionError(null);
          setIsSubmitting(true);
          // SDK format: { questionText: "label1, label2, Other: <text>" } — per-question "Other" folded in.
          const formattedAnswers: Record<string, string> = {};
          for (const question of questions) {
            formattedAnswers[question.question] = combineAnswer(
              answers[question.question] || [],
              otherText[question.question],
            );
          }
          onAnswer(formattedAnswers);
        }
      }
    }, [
      onAnswer,
      answers,
      otherText,
      isQuestionAnswered,
      currentQuestionIndex,
      questions,
      currentQuestion?.question,
      isSubmitting,
    ]);

    const handleSkipWithGuard = useCallback(() => {
      if (isSubmitting) return;
      setSubmissionError(null);
      setIsSubmitting(true);
      onSkip();
    }, [isSubmitting, onSkip]);

    const getOptionNumber = (index: number) => String(index + 1);

    const currentQuestionHasAnswer = isQuestionAnswered(currentQuestion?.question);
    const allQuestionsAnswered = questions.every((q) => isQuestionAnswered(q.question));
    const isLastQuestion = currentQuestionIndex === questions.length - 1;
    useQuestionKeyboard({
      questions,
      currentQuestion,
      currentOptions,
      currentQuestionIndex,
      focusedOptionIndex,
      currentQuestionHasAnswer,
      isSubmitting,
      ownsShortcuts: () => chatOwnsKeyboardShortcuts(questionScrollRef.current),
      setCurrentQuestionIndex,
      setFocusedOptionIndex,
      onPickOption: handleOptionClick,
      onPickOther: handleOtherClick,
      onContinue: handleContinue,
    });

    // Early return after all hooks
    if (questions.length === 0) {
      return null;
    }

    return (
      <div
        className={cn(
          agentsChatComposerShellClass(false, false),
          'flex flex-col gap-0 overflow-hidden',
        )}
      >
        {/* Header */}
        <div className="flex shrink-0 items-center justify-between py-1.5">
          <div className="flex items-center gap-1.5">
            <span className="text-[12px] text-muted-foreground">
              {currentQuestion?.header || 'Question'}
            </span>
            <span className="text-muted-foreground/50">•</span>
            <span className="text-[12px] text-muted-foreground">
              {currentQuestion?.multiSelect ? 'Multi-select' : 'Single-select'}
            </span>
          </div>

          {/* Navigation */}
          {questions.length > 1 && (
            <div className="flex items-center gap-1">
              <Button
                variant="ghost"
                size="icon"
                aria-label="Previous question"
                onClick={handlePrevious}
                disabled={currentQuestionIndex === 0}
                className="rounded disabled:opacity-30 disabled:cursor-not-allowed outline-hidden"
              >
                <ChevronUp className="w-4 h-4 text-muted-foreground" />
              </Button>
              <span className="text-xs text-muted-foreground px-1">
                {currentQuestionIndex + 1} / {questions.length}
              </span>
              <Button
                variant="ghost"
                size="icon"
                aria-label="Next question"
                onClick={handleNext}
                disabled={currentQuestionIndex === questions.length - 1}
                className="rounded disabled:opacity-30 disabled:cursor-not-allowed outline-hidden"
              >
                <ChevronDown className="w-4 h-4 text-muted-foreground" />
              </Button>
            </div>
          )}
        </div>

        {/* Current Question. The question text and the options list are each height-bounded and
            scroll independently, so neither a long question nor 20 long options can push the
            footer's Submit/Skip out of view. Without a bound the card — which has no height of its
            own — is squeezed by the chat column and silently clipped by the `overflow-hidden`
            above. */}
        <div
          className={cn(
            'flex min-h-0 flex-col pb-2 transition-opacity duration-150 ease-out',
            isVisible ? 'opacity-100' : 'opacity-0',
          )}
        >
          <div className="text-[14px] font-[450] text-foreground mb-3 pt-1 flex min-h-0 gap-1.5">
            <span className="text-muted-foreground shrink-0">{currentQuestionIndex + 1}.</span>
            {/* Viewport-relative, not a fixed px cap: the height that has to be left over for the
                options and the footer is a share of the window, and a split pane halves it. */}
            <div
              ref={questionScrollRef}
              data-testid="question-scroll-region"
              className="min-w-0 min-h-0 flex-1 max-h-[35vh] overflow-y-auto"
            >
              <ChatMarkdownRenderer
                content={currentQuestion?.question ?? ''}
                size="sm"
                className="text-[14px] [&_p]:text-foreground [&_p]:py-0"
              />
            </div>
          </div>

          <div
            // Keyed per question so the list remounts: reused rows would otherwise keep both the
            // previous scroll offset and an already-true `isFocused`, leaving the focused first
            // option of the new question scrolled out of sight.
            key={currentQuestionIndex}
            className="min-h-0 max-h-[30vh] overflow-y-auto space-y-1"
            role="listbox"
            aria-label={currentQuestion?.question}
            aria-multiselectable={currentQuestion?.multiSelect || undefined}
          >
            {currentOptions.map((option, optIndex) => {
              const isSelected = isOptionSelected(currentQuestion.question, option.label);
              const isFocused = focusedOptionIndex === optIndex;
              const number = getOptionNumber(optIndex);

              return (
                <OptionRow
                  key={option.label}
                  number={number}
                  isSelected={isSelected}
                  isFocused={isFocused}
                  isSubmitting={isSubmitting}
                  onSelect={() => {
                    handleOptionClick(currentQuestion.question, option.label, currentQuestionIndex);
                    setFocusedOptionIndex(optIndex);
                  }}
                >
                  <ChatMarkdownRenderer
                    content={option.label}
                    size="sm"
                    className="font-medium text-sm [&_p]:text-sm [&_p]:text-foreground [&_p]:py-0"
                  />
                  {option.description && (
                    <ChatMarkdownRenderer
                      content={option.description}
                      size="sm"
                      className="text-[12px] [&_p]:text-[12px] [&_p]:text-muted-foreground [&_p]:py-0"
                    />
                  )}
                </OptionRow>
              );
            })}

            {/* "Other" — auto-added to every question (unless the agent already supplied one);
                reveals a free-text input when selected. */}
            {!hasOwnOtherOption(currentOptions) && (
              <>
                <OptionRow
                  number={getOptionNumber(currentOptions.length)}
                  isSelected={currentQuestion.question in otherText}
                  isFocused={focusedOptionIndex === currentOptions.length}
                  isSubmitting={isSubmitting}
                  onSelect={() => {
                    handleOtherClick(currentQuestion.question, currentQuestionIndex);
                    setFocusedOptionIndex(currentOptions.length);
                  }}
                >
                  <span className="text-sm font-medium wrap-break-word text-foreground">Other</span>
                </OptionRow>

                {currentQuestion.question in otherText && (
                  <Input
                    // Single-select: focus immediately (Other is exclusive). Multi-select: do NOT
                    // grab focus, so the document-level number/arrow keys can still pick options
                    // alongside the typed answer.
                    autoFocus={!currentQuestion.multiSelect}
                    aria-label="Other answer"
                    size="sm"
                    value={otherText[currentQuestion.question] ?? ''}
                    onChange={(e) =>
                      setOtherText((prev) => ({
                        ...prev,
                        [currentQuestion.question]: e.target.value,
                      }))
                    }
                    onKeyDown={(e) => {
                      // Guard isComposing so confirming a CJK/IME composition with Enter does not
                      // prematurely submit the answer (matches the editor/prompt-input convention).
                      if (e.key === 'Enter' && !e.nativeEvent.isComposing) {
                        e.preventDefault();
                        handleContinue();
                      } else if (e.key === 'Escape') {
                        e.preventDefault();
                        clearOther(currentQuestion.question);
                        e.currentTarget.blur();
                      }
                    }}
                    disabled={isSubmitting}
                    placeholder="Type your answer…"
                    className="mt-1 text-sm"
                  />
                )}
              </>
            )}
          </div>
        </div>

        {/* Footer */}
        <div className="flex shrink-0 items-center justify-end gap-2 border-t border-border/35 pt-2.5">
          {allowSkip && (
            <Button variant="ghost" size="xs" onClick={handleSkipWithGuard} disabled={isSubmitting}>
              Skip All
            </Button>
          )}
          <Button
            size="xs"
            onClick={handleContinue}
            disabled={
              isSubmitting || (isLastQuestion ? !allQuestionsAnswered : !currentQuestionHasAnswer)
            }
            className="px-3 rounded-md"
          >
            {isSubmitting ? (
              'Sending...'
            ) : (
              <>
                {isLastQuestion ? 'Submit' : 'Continue'}
                <CornerDownLeft className="w-3 h-3 ml-1 opacity-60" />
              </>
            )}
          </Button>
        </div>
        {submissionError && (
          <p className="pt-1 text-xs text-destructive" role="status" aria-live="polite">
            {submissionError}
          </p>
        )}
      </div>
    );
  }),
);
