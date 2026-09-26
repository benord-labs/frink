// @vitest-environment happy-dom
import '@testing-library/jest-dom/vitest';
import { cleanup, render, screen } from '@testing-library/react';
import type { ReactNode } from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { FlowChatBottomSurface as BottomSurfaceState } from '../../../../../../lib/agent-chat/flow-chat-surface-state';
import { FlowChatBottomSurface } from './index';

vi.mock('../FlowRunStrip', () => ({
  FlowRunStrip: () => <div data-testid="flow-run-strip" />,
  FlowPausedBar: () => <div data-testid="flow-paused-bar" />,
}));

vi.mock('../ParkAnswerSurface', () => ({
  // Honours `suppressed` like the real one, so the "two cards never stack" case is observable here.
  ParkAnswerSurface: ({ suppressed }: { suppressed: boolean }) =>
    suppressed ? null : <div data-testid="park-answer-surface" />,
}));

vi.mock('../../../../stores/message-queue-store', () => ({
  useMessageQueueStore: (selector: (state: { addToQueue: () => void }) => unknown) =>
    selector({ addToQueue: vi.fn() }),
}));

// The surface pulls in the steer hook, whose module builds a tRPC ipc client at import time — that
// needs the Electron preload's electronTRPC global, absent under happy-dom, so the real import
// aborts collection before a single case runs. These cases only assert which surface renders, so
// stub the hook and cut that import chain.
vi.mock('../../../../../../lib/agent-chat/steer', () => ({
  useSteerOrQueue: () => vi.fn(async () => {}),
}));

afterEach(cleanup);

function renderSurface(bottomSurface: BottomSurfaceState, questionCard: ReactNode = null) {
  render(
    <FlowChatBottomSurface
      subChatId="sub-1"
      task={null}
      parentChatId="chat-1"
      questionCard={questionCard}
      bottomSurface={bottomSurface}
      isTurnActive={false}
      guardedSend={() => true}
      onStopTurn={() => undefined}
    >
      <div data-testid="composer" />
    </FlowChatBottomSurface>,
  );
}

// The note handler steers into the running turn. Mocked because the real module builds a tRPC
// client at import time, which needs an Electron preload global these renders do not have; these
// cases only assert which surface renders.
vi.mock('../../../../../../lib/agent-chat/steer', () => ({
  useSteerOrQueue: () => vi.fn(async () => {}),
}));

describe('FlowChatBottomSurface', () => {
  it('renders the composer for a terminal or non-flow chat', () => {
    renderSurface({ kind: 'composer' });

    expect(screen.getByTestId('composer')).toBeInTheDocument();
  });

  // The composer child is not rendered at all, so neither are its account states.
  it('renders the running strip in place of the composer', () => {
    renderSurface({ kind: 'running', flowRunId: 'run-1', canPause: true });

    expect(screen.getByTestId('flow-run-strip')).toBeInTheDocument();
    expect(screen.queryByTestId('composer')).toBeNull();
  });

  it('renders the paused bar in place of the composer', () => {
    renderSurface({ kind: 'paused', flowRunId: 'run-1' });

    expect(screen.getByTestId('flow-paused-bar')).toBeInTheDocument();
    expect(screen.queryByTestId('composer')).toBeNull();
  });

  it('leaves the slot empty at a park, where the answer card above owns the input', () => {
    renderSurface({ kind: 'park' });

    expect(screen.getByTestId('park-answer-surface')).toBeInTheDocument();
    expect(screen.queryByTestId('composer')).toBeNull();
  });

  /**
   * A question has ONE answer surface. Where the composer would render, the card takes its slot;
   * where a flow surface already holds that slot — and carries the run's only Pause/Stop — the card
   * renders above it instead.
   */
  describe('an AskUserQuestion card', () => {
    const card = <div data-testid="question-card" />;

    it('takes the composer slot instead of rendering beside the composer', () => {
      renderSurface({ kind: 'composer' }, card);

      expect(screen.getByTestId('question-card')).toBeInTheDocument();
      expect(screen.queryByTestId('composer')).toBeNull();
    });

    it('renders above the running strip rather than displacing it', () => {
      renderSurface({ kind: 'running', flowRunId: 'run-1', canPause: true }, card);

      expect(screen.getByTestId('question-card')).toBeInTheDocument();
      expect(screen.getByTestId('flow-run-strip')).toBeInTheDocument();
    });

    it('suppresses the park answer surface so two cards never stack', () => {
      renderSurface({ kind: 'park' }, card);

      expect(screen.getByTestId('question-card')).toBeInTheDocument();
      expect(screen.queryByTestId('park-answer-surface')).toBeNull();
    });
  });
});
