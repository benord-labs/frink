// @vitest-environment happy-dom
import '@testing-library/jest-dom/vitest';
import { cleanup, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { SubChatFileChange } from '../../../atoms';
import type { AgentQueueItem } from '../../../lib/queue-utils';
import { StatusAndQueueSection } from './StatusAndQueueSection';

// SAFETY: the trpc mock below echoes this back as the resolved account type; the union is the set
// the steer allow-list knows, plus undefined for a still-loading query.
const accountType = { current: 'claude-code' as 'claude-code' | 'codex' | undefined };

vi.mock('../../../../../lib/trpc', () => ({
  trpc: {
    claudeCode: {
      getResolvedAccount: {
        useQuery: () => ({ data: { type: accountType.current } }),
      },
    },
  },
}));

vi.mock('../../../ui/agent-queue-indicator', () => ({
  AgentQueueIndicator: ({ steerSupported }: { steerSupported?: boolean }) => (
    <div data-testid="queue-indicator" data-steer-supported={String(steerSupported)} />
  ),
}));

/** The real card self-nulls once every changed file is committed, even though the parent still sees
 *  a non-empty changedFiles prop. Switchable so that state is reachable from a test. */
const statusCardRenders = { current: true };

vi.mock('../../../ui/sub-chat-status-card', () => ({
  SubChatStatusCard: () => (statusCardRenders.current ? <div data-testid="status-card" /> : null),
}));

const noopAsync = async () => {};

function baseProps() {
  return {
    queue: [] as AgentQueueItem[],
    changedFilesForSubChat: [] as SubChatFileChange[],
    parentChatId: 'chat-1',
    subChatId: 'sub-1',
    isStreaming: false,
    isCompacting: false,
    projectPath: '/p',
    handleRemoveFromQueue: vi.fn(),
    handleSendFromQueue: vi.fn(),
    handleEditFromQueue: vi.fn(),
    handleReorderQueue: vi.fn(),
    editingItemId: null,
    inputHasContent: false,
    handleStop: noopAsync,
  };
}

const changedFile = [
  { filePath: '/p/a.ts', displayPath: 'a.ts', additions: 1, deletions: 0 },
] satisfies SubChatFileChange[];

afterEach(() => {
  cleanup();
  statusCardRenders.current = true;
});

describe('StatusAndQueueSection', () => {
  it('contributes no negative margin when queue and changed files are both empty', () => {
    const { container } = render(<StatusAndQueueSection {...baseProps()} />);
    expect(container.querySelector('.-mb-6')).toBeNull();
    expect(container.querySelector('[data-testid]')).toBeNull();
  });

  // The tuck must belong to a card that actually mounted. A status card whose files have all been
  // committed renders nothing, and a -24px pull left behind by it drags the surface below up over
  // the run-status row — hiding the background-wait row's Stop, its only in-app exit.
  it('contributes no negative margin when the status card self-nulls', () => {
    statusCardRenders.current = false;
    const { container } = render(
      <StatusAndQueueSection {...baseProps()} changedFilesForSubChat={changedFile} />,
    );
    expect(container.querySelector('.-mb-6')).toBeNull();
  });

  it('leaves the queue card as the only stacked card when the status card self-nulls', () => {
    statusCardRenders.current = false;
    const queue: AgentQueueItem[] = [
      { id: 'q1', message: 'hello', timestamp: new Date(), status: 'pending' },
    ];
    const { container, getByTestId } = render(
      <StatusAndQueueSection {...baseProps()} queue={queue} changedFilesForSubChat={changedFile} />,
    );
    expect(getByTestId('queue-indicator')).toBeInTheDocument();
    expect(container.querySelectorAll('[data-testid]')).toHaveLength(1);
  });

  it('renders stack wrapper when queue has items', () => {
    const queue: AgentQueueItem[] = [
      {
        id: 'q1',
        message: 'hello',
        timestamp: new Date(),
        status: 'pending',
      },
    ];
    const { getByTestId } = render(<StatusAndQueueSection {...baseProps()} queue={queue} />);
    expect(getByTestId('queue-indicator')).toBeInTheDocument();
  });

  it('renders status card when only changed files exist', () => {
    const { getByTestId } = render(
      <StatusAndQueueSection {...baseProps()} changedFilesForSubChat={changedFile} />,
    );
    expect(getByTestId('status-card')).toBeInTheDocument();
  });

  it('renders queue indicator and status card when both queue and changed files are present', () => {
    const queue: AgentQueueItem[] = [
      {
        id: 'q1',
        message: 'hello',
        timestamp: new Date(),
        status: 'pending',
      },
    ];
    const { getByTestId } = render(
      <StatusAndQueueSection {...baseProps()} queue={queue} changedFilesForSubChat={changedFile} />,
    );
    expect(getByTestId('queue-indicator')).toBeInTheDocument();
    expect(getByTestId('status-card')).toBeInTheDocument();
  });

  // The queue card's verb depends on this: without it the card advertises "Steer" on a runtime
  // that has no steer channel and every click silently falls back to the queue.
  const queuedItem: AgentQueueItem[] = [
    { id: 'q-steer', message: 'hello', timestamp: new Date(), status: 'pending' },
  ];

  it('reports steer support for a Claude-backed chat', () => {
    accountType.current = 'claude-code';
    render(<StatusAndQueueSection {...baseProps()} queue={queuedItem} />);
    expect(screen.getByTestId('queue-indicator')).toHaveAttribute('data-steer-supported', 'true');
  });

  it('withholds steer support while the runtime is still unknown (allow-list, not deny-list)', () => {
    accountType.current = undefined;
    render(<StatusAndQueueSection {...baseProps()} queue={queuedItem} />);
    expect(screen.getByTestId('queue-indicator')).toHaveAttribute('data-steer-supported', 'false');
  });

  // Any inset leaves transcript showing between a card's side and the surface's top edge.
  it('runs the cards the full width of the surface they sit on', () => {
    render(<StatusAndQueueSection {...baseProps()} queue={queuedItem} />);
    const column = screen.getByTestId('queue-indicator').parentElement;
    expect(column).toHaveClass('w-full', 'max-w-2xl', 'mx-auto');
    expect(column?.className).not.toMatch(/(^|\s)p[xlr]?-/);
  });
});
