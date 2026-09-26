// @vitest-environment happy-dom
import '@testing-library/jest-dom/vitest';
import { cleanup, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';
import { QUESTION_TIMED_OUT_RESULT } from '../../../../shared/lib/agent-questions/answered-questions';
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
