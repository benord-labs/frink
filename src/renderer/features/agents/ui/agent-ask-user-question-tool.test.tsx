// @vitest-environment happy-dom
import '@testing-library/jest-dom/vitest';
import { cleanup, render, screen } from '@testing-library/react';
import { getDefaultStore } from 'jotai';
import { afterEach, describe, expect, it } from 'vitest';
import { QUESTION_TIMED_OUT_RESULT } from '../../../../shared/lib/agent-questions/answered-questions';
import { pendingUserQuestionsAtom } from '../atoms';
import { AgentAskUserQuestionTool } from './agent-ask-user-question-tool';

const QUESTIONS = [
  {
    header: 'Direction',
    question: 'How should this land?',
    options: [{ label: 'Split it', description: 'Pay the debt' }],
    multiSelect: false,
  },
];

type CardResult = React.ComponentProps<typeof AgentAskUserQuestionTool>['result'];

const renderCard = (result: CardResult, extra: { isError?: boolean } = {}) =>
  render(
    <AgentAskUserQuestionTool
      input={{ questions: QUESTIONS }}
      result={result}
      state="result"
      isError={extra.isError ?? false}
      isStreaming={false}
      toolCallId="tu-1"
    />,
  );

afterEach(cleanup);

/**
 * A STRING result is the REASON the question closed; only an `{answers}` OBJECT can still be
 * mid-sync. Conflating them left every reason but the two known strings spinning on "Submitting…".
 */
describe('AgentAskUserQuestionTool — how a closed question reads', () => {
  it('names an expiry as timed out', () => {
    renderCard(QUESTION_TIMED_OUT_RESULT);

    expect(screen.getByText('Timed out')).toBeInTheDocument();
    expect(screen.queryByText('Submitting...')).not.toBeInTheDocument();
  });

  // Every teardown resolves its pending approvals with its own reason — a pause, a stop, a
  // supersede. None of them is skipped or timed out, and none may spin forever.
  it('shows a teardown reason verbatim rather than spinning', () => {
    renderCard('Paused by user.');

    expect(screen.getByText('Paused by user.')).toBeInTheDocument();
    expect(screen.queryByText('Submitting...')).not.toBeInTheDocument();
  });

  it('still renders the answers card when the result carries real answers', () => {
    renderCard({ answers: { 'How should this land?': 'Split it' } });

    expect(screen.getByText('Split it')).toBeInTheDocument();
    expect(screen.queryByText('Submitting...')).not.toBeInTheDocument();
  });
});

/**
 * A reload re-raises a question main still holds, possibly for a sub-chat with no observed live run
 * — so the inline part is not streaming, yet the answer card is on screen. It must read as waiting.
 */
describe('AgentAskUserQuestionTool — an unanswered question with no live stream', () => {
  const renderPending = () =>
    render(
      <AgentAskUserQuestionTool
        input={{ questions: QUESTIONS }}
        state="call"
        isError={false}
        isStreaming={false}
        toolCallId="tu-held"
      />,
    );

  afterEach(() => getDefaultStore().set(pendingUserQuestionsAtom, new Map()));

  it('reads as waiting while its answer card is shown', () => {
    getDefaultStore().set(
      pendingUserQuestionsAtom,
      new Map([
        [
          'tu-held',
          {
            subChatId: 'sc1',
            parentChatId: 'c1',
            toolUseId: 'tu-held',
            questions: [{ ...QUESTIONS[0], options: [{ label: 'Split it', description: '' }] }],
          },
        ],
      ]),
    );
    renderPending();

    expect(screen.getByText('Waiting for response...')).toBeInTheDocument();
    expect(screen.queryByText('Interrupted')).not.toBeInTheDocument();
  });

  // Parallel questions and split panes share one map: only THIS tool call's card counts.
  it("is not marked waiting by another question's card", () => {
    getDefaultStore().set(
      pendingUserQuestionsAtom,
      new Map([
        [
          'tu-other',
          { subChatId: 'sc2', parentChatId: 'c1', toolUseId: 'tu-other', questions: [] },
        ],
      ]),
    );
    renderPending();

    expect(screen.getByText('Interrupted')).toBeInTheDocument();
  });

  // A closed question outranks a card that has not been retired yet.
  it('shows why it closed even while a stale card entry lingers', () => {
    getDefaultStore().set(
      pendingUserQuestionsAtom,
      new Map([
        ['tu-held', { subChatId: 'sc1', parentChatId: 'c1', toolUseId: 'tu-held', questions: [] }],
      ]),
    );
    render(
      <AgentAskUserQuestionTool
        input={{ questions: QUESTIONS }}
        result="Paused by user."
        state="result"
        isError={false}
        isStreaming={false}
        toolCallId="tu-held"
      />,
    );

    expect(screen.getByText('Paused by user.')).toBeInTheDocument();
    expect(screen.queryByText('Waiting for response...')).not.toBeInTheDocument();
  });

  it('still reads as interrupted when nothing holds it', () => {
    renderPending();

    expect(screen.getByText('Interrupted')).toBeInTheDocument();
  });
});
