import { useEffect, useRef } from 'react';
import type { AgentUserQuestion } from '../../../../shared/types/task-signal';
import { hasOwnOtherOption } from './answer-utils';

type QuestionKeyboardParams = {
  questions: AgentUserQuestion[];
  currentQuestion: AgentUserQuestion | undefined;
  currentOptions: AgentUserQuestion['options'];
  currentQuestionIndex: number;
  focusedOptionIndex: number;
  currentQuestionHasAnswer: boolean;
  isSubmitting: boolean;
  /** True while the chat — not the work queue or another surface — owns the shortcuts. */
  ownsShortcuts: () => boolean;
  setCurrentQuestionIndex: (index: number) => void;
  setFocusedOptionIndex: (index: number) => void;
  onPickOption: (questionText: string, optionLabel: string, questionIndex: number) => void;
  onPickOther: (questionText: string, questionIndex: number) => void;
  onContinue: () => void;
};

/** Typing anywhere with a text caret belongs to that field, never to the option list. */
function isTextEntryFocused(): boolean {
  const activeEl = document.activeElement;
  return (
    activeEl instanceof HTMLInputElement ||
    activeEl instanceof HTMLTextAreaElement ||
    activeEl?.getAttribute('contenteditable') === 'true'
  );
}

/**
 * Index of the auto-added "Other" row — one past the last real option, or -1 when the agent
 * supplied its own "Other" and no extra row exists.
 */
function otherRowIndex(options: AgentUserQuestion['options']): number {
  return hasOwnOtherOption(options) ? -1 : options.length;
}

function lastRowIndex(options: AgentUserQuestion['options']): number {
  const other = otherRowIndex(options);
  return other === -1 ? options.length - 1 : other;
}

function moveDown(p: QuestionKeyboardParams): void {
  if (p.focusedOptionIndex < lastRowIndex(p.currentOptions)) {
    p.setFocusedOptionIndex(p.focusedOptionIndex + 1);
    return;
  }
  if (p.currentQuestionIndex < p.questions.length - 1) {
    p.setCurrentQuestionIndex(p.currentQuestionIndex + 1);
    p.setFocusedOptionIndex(0);
  }
}

function moveUp(p: QuestionKeyboardParams): void {
  if (p.focusedOptionIndex > 0) {
    p.setFocusedOptionIndex(p.focusedOptionIndex - 1);
    return;
  }
  if (p.currentQuestionIndex === 0) return;
  const prevOptions = p.questions[p.currentQuestionIndex - 1]?.options || [];
  p.setCurrentQuestionIndex(p.currentQuestionIndex - 1);
  p.setFocusedOptionIndex(lastRowIndex(prevOptions));
}

function activateFocused(p: QuestionKeyboardParams): void {
  if (p.currentQuestionHasAnswer) {
    p.onContinue();
    return;
  }
  if (!p.currentQuestion) return;
  if (p.focusedOptionIndex === otherRowIndex(p.currentOptions)) {
    p.onPickOther(p.currentQuestion.question, p.currentQuestionIndex);
    return;
  }
  const option = p.currentOptions[p.focusedOptionIndex];
  if (option) p.onPickOption(p.currentQuestion.question, option.label, p.currentQuestionIndex);
}

/** Number keys pick the nth row directly. Returns whether the key addressed a row. */
function pickByNumber(p: QuestionKeyboardParams, key: string): boolean {
  if (!p.currentQuestion || key < '1' || key > '9') return false;
  const index = parseInt(key, 10) - 1;
  const option = p.currentOptions[index];
  if (option) {
    p.onPickOption(p.currentQuestion.question, option.label, p.currentQuestionIndex);
    p.setFocusedOptionIndex(index);
    return true;
  }
  if (index === otherRowIndex(p.currentOptions)) {
    p.onPickOther(p.currentQuestion.question, p.currentQuestionIndex);
    p.setFocusedOptionIndex(index);
    return true;
  }
  return false;
}

type KeyAction = (p: QuestionKeyboardParams, e: KeyboardEvent) => boolean;

/** Named keys → the action they run. Each returns whether it consumed the key. */
const KEY_ACTIONS = new Map<string, KeyAction>([
  [
    'ArrowDown',
    (p) => {
      moveDown(p);
      return true;
    },
  ],
  [
    'ArrowUp',
    (p) => {
      moveUp(p);
      return true;
    },
  ],
  [
    'Enter',
    (p, e) => {
      // A focused button owns its own Enter (the nav chevrons, Submit).
      if (e.target instanceof HTMLButtonElement) return false;
      activateFocused(p);
      return true;
    },
  ],
]);

export function useQuestionKeyboard(params: QuestionKeyboardParams): void {
  // The listener is bound ONCE and reads the latest props through this ref. Depending on `params`
  // — freshly allocated every render — would tear down and re-add a document listener each time.
  // The ref is written in the COMMIT phase, never during render: a discarded speculative render
  // must not be able to hand the live listener a question set that was never committed.
  const latest = useRef(params);
  useEffect(() => {
    latest.current = params;
  });

  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      const p = latest.current;
      if (!p.ownsShortcuts() || p.isSubmitting || isTextEntryFocused()) return;

      const action = KEY_ACTIONS.get(e.key);
      const handled = action ? action(p, e) : pickByNumber(p, e.key);
      if (handled) e.preventDefault();
    };

    document.addEventListener('keydown', handleKeyDown);
    return () => document.removeEventListener('keydown', handleKeyDown);
  }, []);
}
