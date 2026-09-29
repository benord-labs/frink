// @vitest-environment happy-dom
import '@testing-library/jest-dom/vitest';
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import type { Ref } from 'react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import type { PendingUserQuestions } from '../atoms';
import {
  AgentUserQuestion,
  type AgentUserQuestionHandle,
  combineAnswer,
  hasOwnOtherOption,
} from './index';

describe('combineAnswer', () => {
  it('returns picked labels joined when there is no Other text', () => {
    expect(combineAnswer(['A', 'B'])).toBe('A, B');
  });

  it('appends "Other: <text>" after picked labels', () => {
    expect(combineAnswer(['A'], 'use postgres')).toBe('A, Other: use postgres');
  });

  it('returns just the Other text when nothing was picked', () => {
    expect(combineAnswer([], 'freeform')).toBe('Other: freeform');
  });

  it('drops empty / whitespace-only Other text', () => {
    expect(combineAnswer(['A'], '   ')).toBe('A');
    expect(combineAnswer([], '')).toBe('');
  });

  it('trims surrounding whitespace from non-empty Other text', () => {
    expect(combineAnswer([], '  use postgres  ')).toBe('Other: use postgres');
  });
});

describe('hasOwnOtherOption', () => {
  it('detects an agent-supplied option labelled "Other" (case/space-insensitive)', () => {
    expect(hasOwnOtherOption([{ label: 'A' }, { label: ' Other ' }])).toBe(true);
    expect(hasOwnOtherOption([{ label: 'other' }])).toBe(true);
  });

  it('is false when no option is labelled "Other"', () => {
    expect(hasOwnOtherOption([{ label: 'A' }, { label: 'B' }])).toBe(false);
  });
});

// Answer formatting now lives with the marker that carries it:
// src/shared/lib/agent-questions/answered-questions.test.ts

const makeMultiQ = (question: string, labels: string[], multiSelect = false) => ({
  question,
  header: question,
  options: labels.map((label) => ({ label, description: '' })),
  multiSelect,
});

const makeQuestion = (question: string, label: string, multiSelect = false) =>
  makeMultiQ(question, [label], multiSelect);

const makePending = (questions: PendingUserQuestions['questions']): PendingUserQuestions => ({
  subChatId: 'sub-1',
  parentChatId: 'parent-1',
  toolUseId: 'tool-1',
  questions,
});

const renderCard = (
  questions: PendingUserQuestions['questions'],
  opts: { ref?: Ref<AgentUserQuestionHandle> } = {},
) => {
  const onAnswer = vi.fn();
  const onSkip = vi.fn();
  render(
    <AgentUserQuestion
      ref={opts.ref}
      pendingQuestions={makePending(questions)}
      onAnswer={onAnswer}
      onSkip={onSkip}
    />,
  );
  return { onAnswer, onSkip };
};

const otherInput = () => screen.getByPlaceholderText('Type your answer…');
const otherInputOrNull = () => screen.queryByPlaceholderText('Type your answer…');
const clickText = (text: string) => fireEvent.click(screen.getByText(text));
const typeOther = (value: string) => fireEvent.change(otherInput(), { target: { value } });

describe('AgentUserQuestion — inline Other', () => {
  beforeEach(() => {
    cleanup();
  });

  it('folds per-question Other text onto the right question across a multi-question ask', () => {
    const { onAnswer } = renderCard([makeQuestion('Q1', 'A'), makeQuestion('Q2', 'B')]);

    // Q1: choose Other and type a custom answer (no auto-advance for Other).
    clickText('Other');
    typeOther('custom one');
    clickText('Continue');

    // Q2: pick the supplied option, then submit.
    clickText('B');
    clickText('Submit');

    expect(onAnswer).toHaveBeenCalledWith({ Q1: 'Other: custom one', Q2: 'B' });
  });

  it('makes a real single-select pick mutually exclusive with Other', () => {
    const { onAnswer } = renderCard([makeQuestion('Q1', 'A')]);

    clickText('Other');
    typeOther('ignored');
    // Picking the real option clears the Other text and hides the input.
    clickText('A');
    expect(otherInputOrNull()).not.toBeInTheDocument();

    clickText('Submit');
    expect(onAnswer).toHaveBeenCalledWith({ Q1: 'A' });
  });

  it('does not submit while Other is selected but empty', () => {
    const { onAnswer } = renderCard([makeQuestion('Q1', 'A')]);

    clickText('Other');
    clickText('Submit');
    expect(onAnswer).not.toHaveBeenCalled();
  });

  it('suppresses the auto-added Other row when the agent already supplied one', () => {
    renderCard([makeQuestion('Q1', 'Other')]);

    // Only the agent's own "Other" option — no duplicate auto-added row, no free-text input.
    expect(screen.getAllByText('Other')).toHaveLength(1);
    expect(otherInputOrNull()).not.toBeInTheDocument();
  });

  it('composes Other text alongside a picked option in a multi-select question', () => {
    const { onAnswer } = renderCard([makeQuestion('Q1', 'B', true)]);

    clickText('B');
    clickText('Other');
    typeOther('extra');
    clickText('Submit');

    expect(onAnswer).toHaveBeenCalledWith({ Q1: 'B, Other: extra' });
  });

  it('clears a prior single-select pick when Other is then chosen', () => {
    const { onAnswer } = renderCard([makeQuestion('Q1', 'A')]);

    clickText('A');
    clickText('Other');
    typeOther('x');
    clickText('Submit');

    expect(onAnswer).toHaveBeenCalledWith({ Q1: 'Other: x' });
  });

  it('submits Other text containing markdown syntax verbatim', () => {
    const { onAnswer } = renderCard([makeQuestion('Q1', 'A')]);

    clickText('Other');
    typeOther('a*b*c');
    fireEvent.keyDown(otherInput(), { key: 'Enter' });

    // Markdown is presentation-only; escaping the payload here would corrupt what the agent sees.
    expect(onAnswer).toHaveBeenCalledWith({ Q1: 'Other: a*b*c' });
  });

  it('does not submit on Enter while an IME composition is active', () => {
    const { onAnswer } = renderCard([makeQuestion('Q1', 'A')]);

    clickText('Other');
    typeOther('partial');

    // Enter that confirms a CJK/IME composition must NOT submit the answer.
    fireEvent.keyDown(otherInput(), { key: 'Enter', isComposing: true });
    expect(onAnswer).not.toHaveBeenCalled();

    // A real Enter (composition finished) submits.
    fireEvent.keyDown(otherInput(), { key: 'Enter' });
    expect(onAnswer).toHaveBeenCalledWith({ Q1: 'Other: partial' });
  });
});

describe('AgentUserQuestion — keyboard & navigation', () => {
  beforeEach(() => {
    cleanup();
  });

  it('selects an option by number key and submits on Enter', () => {
    const { onAnswer } = renderCard([makeQuestion('Q1', 'A')]);

    fireEvent.keyDown(document.body, { key: '1' });
    fireEvent.keyDown(document.body, { key: 'Enter' });
    expect(onAnswer).toHaveBeenCalledWith({ Q1: 'A' });
  });

  it('does not handle retained question keys while Work Queue is visible', () => {
    const { onAnswer } = renderCard([makeQuestion('Q1', 'A')]);
    const workQueue = document.createElement('main');
    workQueue.dataset.agentsDestination = 'workqueue';
    document.body.append(workQueue);

    fireEvent.keyDown(document.body, { key: '1' });
    fireEvent.keyDown(document.body, { key: 'Enter' });
    expect(onAnswer).not.toHaveBeenCalled();
    workQueue.remove();
  });

  it('moves focus with ArrowDown and selects the focused option on Enter', () => {
    const { onAnswer } = renderCard([makeMultiQ('Q1', ['A', 'B'])]);

    fireEvent.keyDown(document.body, { key: 'ArrowDown' }); // focus A -> B
    fireEvent.keyDown(document.body, { key: 'Enter' }); // selects focused B
    fireEvent.keyDown(document.body, { key: 'Enter' }); // now answered -> submit
    expect(onAnswer).toHaveBeenCalledWith({ Q1: 'B' });
  });

  it('invokes onSkip when Skip All is clicked', () => {
    const { onSkip } = renderCard([makeQuestion('Q1', 'A')]);

    clickText('Skip All');
    expect(onSkip).toHaveBeenCalledTimes(1);
  });

  it('auto-advances to the next question after a single-select pick', async () => {
    const { onAnswer } = renderCard([makeQuestion('Q1', 'A'), makeQuestion('Q2', 'B')]);

    expect(screen.getByText('A')).toBeInTheDocument();
    clickText('A'); // single-select, not last -> auto-advance
    await waitFor(() => expect(screen.getByText('B')).toBeInTheDocument());

    clickText('B');
    clickText('Submit');
    expect(onAnswer).toHaveBeenCalledWith({ Q1: 'A', Q2: 'B' });
  });

  it('lets a focused navigation button handle Enter exactly once', () => {
    renderCard([
      makeQuestion('Q1', 'A', true),
      makeQuestion('Q2', 'B', true),
      makeQuestion('Q3', 'C', true),
    ]);

    clickText('A');
    const nextButton = screen.getByRole('button', { name: 'Next question' });

    // Electron follows this keydown with the button's native click. The document shortcut must
    // leave the keydown alone, or the two paths advance from question 1 straight to question 3.
    fireEvent.keyDown(nextButton, { key: 'Enter' });
    expect(screen.getByText('1 / 3')).toBeInTheDocument();

    fireEvent.click(nextButton);
    expect(screen.getByText('2 / 3')).toBeInTheDocument();
  });

  it('lets a focused Submit button own Enter and submits once', () => {
    const { onAnswer } = renderCard([makeQuestion('Q1', 'A', true)]);

    clickText('A');
    const submitButton = screen.getByRole('button', { name: 'Submit' });

    fireEvent.keyDown(submitButton, { key: 'Enter' });
    expect(onAnswer).not.toHaveBeenCalled();

    fireEvent.click(submitButton);
    expect(onAnswer).toHaveBeenCalledTimes(1);
    expect(onAnswer).toHaveBeenCalledWith({ Q1: 'A' });
  });

  it('keeps row-level Enter from also firing the document shortcut handler', () => {
    const { onAnswer } = renderCard([makeMultiQ('Q1', ['A', 'B'], true)]);

    const options = within(screen.getByRole('listbox')).getAllByRole('option');
    // Rows are divs, so the document handler's button early-return no longer shields them.
    // Without stopPropagation both handlers toggle the same option in one keystroke —
    // selecting then deselecting it in multi-select.
    fireEvent.keyDown(options[0], { key: 'Enter' });

    expect(options[0]).toHaveAttribute('aria-selected', 'true');
    expect(onAnswer).not.toHaveBeenCalled();
  });

  it('selects a focused row on Space like the native button it replaced', () => {
    renderCard([makeMultiQ('Q1', ['A', 'B'], true)]);

    const options = within(screen.getByRole('listbox')).getAllByRole('option');
    fireEvent.keyDown(options[1], { key: ' ' });
    expect(options[1]).toHaveAttribute('aria-selected', 'true');
  });

  it('ignores option interaction while a skip is submitting', () => {
    renderCard([makeQuestion('Q1', 'A')]);

    clickText('Skip All');
    const options = within(screen.getByRole('listbox')).getAllByRole('option');
    // The div conversion lost the native disabled attribute; the hand-rolled guard must hold
    // for both pointer and keyboard activation.
    fireEvent.click(options[0]);
    fireEvent.keyDown(options[0], { key: 'Enter' });

    expect(options[0]).toHaveAttribute('aria-selected', 'false');
    expect(options[0]).toHaveAttribute('aria-disabled', 'true');
  });

  it('reveals the Other input when its number key is pressed', () => {
    renderCard([makeQuestion('Q1', 'A')]);

    expect(otherInputOrNull()).not.toBeInTheDocument();
    fireEvent.keyDown(document.body, { key: '2' }); // option A = 1, Other row = 2
    expect(otherInput()).toBeInTheDocument();
  });

  it('focuses the Other row via ArrowDown and activates it on Enter', () => {
    renderCard([makeQuestion('Q1', 'A')]);

    fireEvent.keyDown(document.body, { key: 'ArrowDown' }); // option A (0) -> Other row (1)
    fireEvent.keyDown(document.body, { key: 'Enter' }); // not answered, focus on Other -> reveal input
    expect(otherInput()).toBeInTheDocument();
  });
});

describe('AgentUserQuestion — markdown rendering', () => {
  beforeEach(() => {
    cleanup();
  });

  it('renders question, label, and description markdown instead of literal syntax', () => {
    renderCard([
      {
        question: 'Pick **carefully** now',
        header: 'Q',
        options: [{ label: 'Use `--strict`', description: 'The **safe** default' }],
        multiSelect: false,
      },
    ]);

    expect(screen.getByText('carefully').tagName).toBe('STRONG');
    expect(screen.getByText('safe').tagName).toBe('STRONG');
    expect(screen.getByText('--strict')).toBeInTheDocument();
    expect(screen.queryByText(/\*\*/)).not.toBeInTheDocument();
    expect(screen.queryByText(/`/)).not.toBeInTheDocument();
  });

  it('still selects an option when its markdown-rendered label is clicked', () => {
    const { onAnswer } = renderCard([
      {
        question: 'Q1',
        header: 'Q1',
        options: [{ label: 'Pick **me**', description: '' }],
        multiSelect: false,
      },
    ]);

    fireEvent.click(screen.getByText('me')); // click lands inside the rendered <strong>
    clickText('Submit');
    // The submitted answer carries the RAW label — markdown is presentation only.
    expect(onAnswer).toHaveBeenCalledWith({ Q1: 'Pick **me**' });
  });

  it('exposes the option rows as a listbox with selection state', () => {
    renderCard([makeQuestion('Q1', 'A')]);

    const options = within(screen.getByRole('listbox')).getAllByRole('option');
    expect(options).toHaveLength(2); // A + the auto-added Other row
    // Roving focus: exactly the focused row is tabbable.
    expect(options[0]).toHaveAttribute('tabindex', '0');
    expect(options[1]).toHaveAttribute('tabindex', '-1');
    fireEvent.click(options[0]);
    expect(options[0]).toHaveAttribute('aria-selected', 'true');
  });

  it('does not select the option when a markdown link inside it is activated', () => {
    (window as { desktopApi?: unknown }).desktopApi = { openExternal: vi.fn() };
    renderCard([
      {
        question: 'Q1',
        header: 'Q1',
        options: [{ label: 'See [docs](https://example.com)', description: '' }],
        multiSelect: false,
      },
    ]);

    const link = screen.getByText('docs');
    fireEvent.click(link); // opening the link must not double as a row selection
    fireEvent.keyDown(link, { key: 'Enter' }); // a focused link keeps its native Enter

    const options = within(screen.getByRole('listbox')).getAllByRole('option');
    expect(options[0]).toHaveAttribute('aria-selected', 'false');
  });

  it('drops raw HTML in agent-authored strings instead of rendering it', () => {
    renderCard([
      {
        question: 'Click <img src=x onerror="window.__pwned = true"> now',
        header: 'Q',
        options: [
          { label: 'Continue <b onclick="window.__pwned = true">boldly</b>', description: '' },
        ],
        multiSelect: false,
      },
    ]);

    // Streamdown's sanitize pipeline drops dangerous tags but may keep benign formatting ones
    // (the <b> can survive). What must never survive is an executable attribute.
    expect(document.querySelector('img')).toBeNull();
    for (const el of Array.from(document.querySelectorAll('*'))) {
      expect(el.getAttribute('onclick')).toBeNull();
      expect(el.getAttribute('onerror')).toBeNull();
    }
    expect(screen.getByText(/Click/)).toBeInTheDocument();
    expect(screen.getByText(/boldly/)).toBeInTheDocument();
  });
});

describe('AgentUserQuestion — long question text', () => {
  beforeEach(() => {
    cleanup();
  });

  const longQuestion = `Which scope should this take? (A) minimal, (B) moderate, ${'padding '.repeat(80)}(C) structural, (D) full rewrite`;

  /** The bounded scroll region wrapping the question prose. */
  const questionRegion = () => screen.getByTestId('question-scroll-region');

  it('renders a question far longer than the old 500-char bound in full', () => {
    renderCard([makeQuestion(longQuestion, 'A')]);

    expect(longQuestion.length).toBeGreaterThan(500);
    expect(questionRegion()).toHaveTextContent('(D) full rewrite');
  });

  it('scrolls the question text while keeping the options and footer pinned', () => {
    renderCard([makeQuestion(longQuestion, 'A')]);

    // jsdom/happy-dom computes no layout, so pin the contract that produces the behaviour: the
    // question prose is the ONLY region allowed to scroll or shrink.
    const region = questionRegion();
    expect(region.className).toContain('overflow-y-auto');
    expect(region.className).toContain('min-h-0');
    expect(region.className).toMatch(/max-h-/);

    const listbox = screen.getByRole('listbox');
    expect(listbox.className).toContain('overflow-y-auto');
    expect(listbox.className).toMatch(/max-h-/);
    expect(screen.getByText('Submit').closest('div')?.className).toContain('shrink-0');
  });

  it('rewinds the options list when moving to the next question', async () => {
    renderCard([makeQuestion(longQuestion, 'A'), makeQuestion('Q2', 'B')]);

    const listbox = screen.getByRole('listbox');
    listbox.scrollTop = 120;
    expect(listbox.scrollTop).toBe(120);

    fireEvent.click(screen.getByText('A')); // single-select auto-advances

    await waitFor(() => expect(within(questionRegion()).getByText('Q2')).toBeInTheDocument());
    expect(screen.getByRole('listbox').scrollTop).toBe(0);
  });

  it('rewinds the question text when a new question set replaces the current one', () => {
    const onAnswer = vi.fn();
    const onSkip = vi.fn();
    const { rerender } = render(
      <AgentUserQuestion
        pendingQuestions={makePending([makeQuestion(longQuestion, 'A')])}
        onAnswer={onAnswer}
        onSkip={onSkip}
      />,
    );

    const region = questionRegion();
    region.scrollTop = 240;
    expect(region.scrollTop).toBe(240);

    rerender(
      <AgentUserQuestion
        pendingQuestions={{
          ...makePending([makeQuestion(`${longQuestion} (second ask)`, 'B')]),
          toolUseId: 'tool-2',
        }}
        onAnswer={onAnswer}
        onSkip={onSkip}
      />,
    );

    expect(questionRegion().scrollTop).toBe(0);
  });

  it('rewinds the question text when moving to the next question', async () => {
    renderCard([makeQuestion(longQuestion, 'A'), makeQuestion('Q2', 'B')]);

    const region = questionRegion();
    region.scrollTop = 240;
    // Guard against a vacuous assertion: if the environment refuses to store scrollTop, the reset
    // below would "pass" without the component doing anything.
    expect(region.scrollTop).toBe(240);

    fireEvent.click(screen.getByText('A')); // single-select auto-advances

    await waitFor(() => expect(within(questionRegion()).getByText('Q2')).toBeInTheDocument());
    expect(questionRegion().scrollTop).toBe(0);
  });
});
