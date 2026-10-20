// @vitest-environment happy-dom
import '@testing-library/jest-dom/vitest';
import { cleanup, fireEvent, screen, waitFor } from '@testing-library/react';
import type { Operation } from '@trpc/client';
import type { ReactNode } from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { renderWithTrpc } from '@/lib/test-utils/render-with-trpc';
import type { TaskResultRecord } from '../../../../../../../shared/types/task-result';
import type { SecretRequest } from '../../../../../../../shared/types/task-signal';
import type { FlowChatBottomSurface as BottomSurfaceState } from '../../../../../../lib/agent-chat/flow-chat-surface-state';
import { FlowChatBottomSurface } from './index';

// `lib/trpc` wires its ipc client at import time, so the preload bridge must exist first.
vi.hoisted(() => {
  Object.assign(globalThis, {
    electronTRPC: { onMessage: () => () => undefined, sendMessage: () => undefined },
  });
});

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

type SurfaceOptions = {
  task?: { id: string; status: string; result: TaskResultRecord } | null;
  isTurnActive?: boolean;
  /** What `secretRequests.pending` answers until a submit closes it: the live request. */
  liveSecret?: SecretRequest | null;
  guardedSend?: (text: string) => boolean;
};

type RouterAnswer = SecretRequest | { ok: true } | null;

function renderSurface(
  bottomSurface: BottomSurfaceState,
  questionCard: ReactNode = null,
  { task = null, isTurnActive = false, liveSecret = null, guardedSend }: SurfaceOptions = {},
) {
  let open = liveSecret;
  const answer = async (op: Operation): Promise<RouterAnswer> => {
    if (op.path === 'secretRequests.pending') return open;
    if (op.path !== 'secretRequests.submit') throw new Error(`Unexpected operation: ${op.path}`);
    open = null;
    return { ok: true };
  };
  renderWithTrpc(
    <FlowChatBottomSurface
      subChatId="sub-1"
      task={task}
      parentChatId="chat-1"
      questionCard={questionCard}
      bottomSurface={bottomSurface}
      isTurnActive={isTurnActive}
      guardedSend={guardedSend ?? (() => true)}
      onStopTurn={() => undefined}
    >
      <div data-testid="composer" />
    </FlowChatBottomSurface>,
    answer,
  );
}

const SECRET: SecretRequest = {
  id: 'req-1',
  name: 'STRIPE_KEY',
  chatId: 'chat-1',
  file: '.env',
  cwd: '/repo',
  reason: 'Charge test cards',
  replaces: false,
  git: 'ignored',
};

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

  /** A secret request takes the input slot, so there is no chat box to paste the secret into. */
  describe('a secret request', () => {
    const parkedTask = {
      id: 'task-1',
      status: 'needs_attention',
      result: {
        agentSignal: {
          state: 'awaiting_input',
          summary: 'Needs STRIPE_KEY',
          secretRequest: SECRET,
        },
      },
    };

    it('replaces the park surface for a parked task', () => {
      renderSurface({ kind: 'park' }, null, { task: parkedTask });

      expect(screen.getByLabelText('Value for STRIPE_KEY')).toHaveAttribute('type', 'password');
      expect(screen.queryByTestId('park-answer-surface')).toBeNull();
      expect(screen.queryByTestId('composer')).toBeNull();
    });

    it('replaces the composer once a chat with no task has one open', async () => {
      renderSurface({ kind: 'composer' }, null, { liveSecret: SECRET });

      expect(await screen.findByLabelText('Value for STRIPE_KEY')).toBeInTheDocument();
      expect(screen.queryByTestId('composer')).toBeNull();
    });

    // Main saves and tells the agent; the chat's own send is never used for the answer.
    it('gives the composer back once main has saved the value and told the agent', async () => {
      const guardedSend = vi.fn((_text: string) => true);
      renderSurface({ kind: 'composer' }, null, { liveSecret: SECRET, guardedSend });

      fireEvent.change(await screen.findByLabelText('Value for STRIPE_KEY'), {
        target: { value: 'sk_live_1' },
      });
      fireEvent.click(screen.getByRole('button', { name: 'Save' }));

      expect(await screen.findByTestId('composer')).toBeInTheDocument();
      await waitFor(() => expect(screen.queryByLabelText('Value for STRIPE_KEY')).toBeNull());
      expect(guardedSend).not.toHaveBeenCalled();
    });

    it('keeps the composer and its Stop while a turn is running', () => {
      renderSurface({ kind: 'composer' }, null, { liveSecret: SECRET, isTurnActive: true });

      expect(screen.getByTestId('composer')).toBeInTheDocument();
      expect(screen.queryByLabelText('Value for STRIPE_KEY')).toBeNull();
    });
  });
});
