// @vitest-environment happy-dom
import '@testing-library/jest-dom/vitest';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { createRef } from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { AgentUserQuestionHandle } from '../../../AgentUserQuestion';
import type { PendingUserQuestion } from '../../../atoms';
import { UserQuestionsPanel } from './UserQuestionsPanel';

afterEach(cleanup);

const QUESTIONS: PendingUserQuestion = {
  subChatId: 'sub-1',
  parentChatId: 'chat-1',
  toolUseId: 'toolu_1',
  questions: [
    {
      question: 'Which store?',
      header: 'Store',
      options: [
        { label: 'Postgres', description: '' },
        { label: 'SQLite', description: '' },
      ],
      multiSelect: false,
    },
  ],
};

function renderPanel(overrides: { canStopTurn?: boolean; onStopTurn?: () => void } = {}) {
  const ref = createRef<AgentUserQuestionHandle>();
  render(
    <UserQuestionsPanel
      pendingQuestions={QUESTIONS}
      questionRef={ref}
      canStopTurn={overrides.canStopTurn ?? false}
      onStopTurn={overrides.onStopTurn ?? (() => undefined)}
      handleQuestionsAnswer={async () => true}
      handleQuestionsSkip={async () => true}
    />,
  );
}

describe('UserQuestionsPanel', () => {
  /**
   * This card holds the composer's slot, so it is the ONLY input surface while a question is up.
   * Both cases below pin an escape from it — without one, a user who does not want to answer has
   * no way back to a free composer.
   */
  it('offers Skip All, the way back to a free composer', () => {
    renderPanel();

    expect(screen.getByText('Skip All')).toBeInTheDocument();
  });

  it('offers Stop while it owns the composer slot with a live turn behind it', () => {
    const onStopTurn = vi.fn();
    renderPanel({ canStopTurn: true, onStopTurn });

    fireEvent.click(screen.getByText('Stop'));

    expect(onStopTurn).toHaveBeenCalledTimes(1);
  });

  it('offers no Stop when a flow surface holds the slot and its own Stop', () => {
    renderPanel({ canStopTurn: false });

    expect(screen.queryByText('Stop')).toBeNull();
  });

  it('renders nothing without a question, leaving the composer its slot', () => {
    const ref = createRef<AgentUserQuestionHandle>();
    const { container } = render(
      <UserQuestionsPanel
        pendingQuestions={null}
        questionRef={ref}
        canStopTurn
        onStopTurn={() => undefined}
        handleQuestionsAnswer={async () => true}
        handleQuestionsSkip={async () => true}
      />,
    );

    expect(container).toBeEmptyDOMElement();
  });
});
