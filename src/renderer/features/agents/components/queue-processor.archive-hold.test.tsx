// @vitest-environment happy-dom
/** sc-682: archive aborts the run mid-mutation, so the sub-chat goes 'ready' early. Nothing queued may
 * be sent into the chat being archived; a failed archive hands the queue back. */
import '@testing-library/jest-dom/vitest';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { act, render } from '@testing-library/react';
import { getQueryKey } from '@trpc/react-query';
import { toast } from 'sonner';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { archiveWithQueueHold } from '../lib/archive-queue-hold';
import { createQueueItem } from '../lib/queue-utils';
import { useMessageQueueStore } from '../stores/message-queue-store';
import { useStreamingStatusStore } from '../stores/streaming-status-store';
import { QUEUE_PROCESS_DELAY_MS, QueueProcessor } from './queue-processor';

const ARCHIVED_CHAT = 'chat-being-archived';
const OTHER_CHAT = 'chat-still-open';
const ARCHIVED_SUB = 'sub-of-archived-chat';
const OTHER_SUB = 'sub-of-open-chat';
const PARENTS: Record<string, string> = { [ARCHIVED_SUB]: ARCHIVED_CHAT, [OTHER_SUB]: OTHER_CHAT };

const { mockSendMessage, getResolvedAccountProcedure } = vi.hoisted(() => ({
  mockSendMessage: vi.fn(),
  getResolvedAccountProcedure: {
    _def: () => ({ path: ['claudeCode', 'getResolvedAccount'] as const }),
  },
}));

vi.mock('../../../lib/trpc', () => ({
  trpc: {
    useUtils: vi.fn(() => mockTrpcUtils),
    claudeCode: { getResolvedAccount: getResolvedAccountProcedure },
  },
}));
const mockTrpcUtils = {
  tasks: {
    getById: { setData: vi.fn(), invalidate: vi.fn() },
    listPaginated: { invalidate: vi.fn() },
    listCounts: { invalidate: vi.fn() },
  },
  agents: { getAgentChat: { invalidate: vi.fn() } },
};
vi.mock('../../../lib/mock-api', () => ({
  api: { useUtils: vi.fn(() => ({ agents: { getAgentChat: { invalidate: vi.fn() } } })) },
}));
vi.mock('../../../lib/analytics', () => ({ trackMessageSent: vi.fn() }));
vi.mock('../../../lib/jotai-store', () => ({ appStore: { get: vi.fn(), set: vi.fn() } }));
vi.mock('sonner', () => ({ toast: { error: vi.fn() } }));
vi.mock('../../sidebar/unified/sidebar-chat-activity', () => ({
  notifySidebarChatActivity: vi.fn(),
}));
vi.mock('../atoms', () => ({
  clearLoading: vi.fn(),
  loadingSubChatsAtom: {},
  setLoading: vi.fn(),
}));
vi.mock('../stores/agent-chat-store', () => ({
  agentChatStore: {
    get: (id: string) => (id in PARENTS ? { sendMessage: mockSendMessage } : undefined),
    getParentChatId: (id: string) => PARENTS[id],
    getSubChatIdsForChat: (chatId: string) =>
      Object.keys(PARENTS).filter((id) => PARENTS[id] === chatId),
  },
  onChatRegistered: vi.fn(() => vi.fn()),
}));
vi.mock('../stores/sub-chat-store', () => ({
  useAgentSubChatStore: {
    getState: () => ({ subChatsById: {}, updateSubChatTimestamp: vi.fn() }),
  },
}));

function renderProcessor() {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  // Satisfy the resolved-account gate up front so only the archive hold can block a send.
  for (const chatId of [ARCHIVED_CHAT, OTHER_CHAT]) {
    queryClient.setQueryData(
      getQueryKey(
        getResolvedAccountProcedure as unknown as Parameters<typeof getQueryKey>[0],
        { chatId },
        'query',
      ),
      { type: 'claude-code', label: 't', isProjectOverride: false, isAuthenticated: true },
    );
  }
  render(
    <QueryClientProvider client={queryClient}>
      <QueueProcessor />
    </QueryClientProvider>,
  );
}

/** A mutation the test settles by hand, standing in for chats.archive. */
function deferredArchive() {
  let settle: { resolve: () => void; reject: (error: Error) => void } = {
    resolve: () => {},
    reject: () => {},
  };
  const promise = new Promise<{ id: string }>((resolve, reject) => {
    settle = { resolve: () => resolve({ id: ARCHIVED_CHAT }), reject };
  });
  return { promise, settle: () => settle };
}

const advance = (ms: number) =>
  act(async () => {
    await vi.advanceTimersByTimeAsync(ms);
  });

describe('QueueProcessor — archive hold', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    Object.defineProperty(window, 'desktopApi', {
      configurable: true,
      writable: true,
      value: {
        onSocketExecuteComplete: vi.fn(() => () => {}),
        onSocketTaskSignalPersisted: vi.fn(() => () => {}),
      },
    });
    useMessageQueueStore.setState({ queues: {}, editingItemIds: {}, heldChatIds: {} });
    useStreamingStatusStore.setState({ statuses: {} });
    mockSendMessage.mockReset();
    mockSendMessage.mockResolvedValue(undefined);
    vi.mocked(toast.error).mockClear();
  });

  afterEach(() => {
    vi.clearAllTimers();
    vi.useRealTimers();
    delete (window as { desktopApi?: unknown }).desktopApi;
  });

  it('never sends a queued message into a chat whose archive is in flight, then drops it', async () => {
    renderProcessor();
    const archive = deferredArchive();
    const archiving = archiveWithQueueHold(ARCHIVED_CHAT, () => archive.promise);

    // Main aborts the run mid-mutation: the sub-chat goes idle with a follow-up waiting, marked to
    // go the instant the run settles.
    await act(async () => {
      useMessageQueueStore.setState({
        queues: { [ARCHIVED_SUB]: [{ ...createQueueItem('q1', 'follow-up'), sendOnSettle: true }] },
      });
      useStreamingStatusStore.getState().setStatus(ARCHIVED_SUB, 'ready');
    });
    await advance(QUEUE_PROCESS_DELAY_MS * 3);
    expect(mockSendMessage).not.toHaveBeenCalled();

    archive.settle().resolve();
    await act(async () => {
      await archiving;
    });
    await advance(QUEUE_PROCESS_DELAY_MS * 3);

    expect(mockSendMessage).not.toHaveBeenCalled();
    expect(useMessageQueueStore.getState().queues[ARCHIVED_SUB]).toBeUndefined();
  });

  it('hands the queue back and sends it when the archive fails', async () => {
    renderProcessor();
    const archive = deferredArchive();
    const archiving = archiveWithQueueHold(ARCHIVED_CHAT, () => archive.promise);
    await act(async () => {
      useMessageQueueStore.setState({
        queues: { [ARCHIVED_SUB]: [createQueueItem('q1', 'keep me')] },
      });
      useStreamingStatusStore.getState().setStatus(ARCHIVED_SUB, 'ready');
    });
    await advance(QUEUE_PROCESS_DELAY_MS * 2);
    expect(mockSendMessage).not.toHaveBeenCalled();

    archive.settle().reject(new Error('archive failed'));
    await act(async () => {
      await expect(archiving).rejects.toThrow('archive failed');
    });
    // Releasing the hold is the only store change here, so this also proves the processor
    // re-checks queues when a hold is lifted.
    await advance(QUEUE_PROCESS_DELAY_MS * 2);

    expect(mockSendMessage).toHaveBeenCalledTimes(1);
  });

  it('keeps sending for other chats while one chat is being archived', async () => {
    renderProcessor();
    const archive = deferredArchive();
    void archiveWithQueueHold(ARCHIVED_CHAT, () => archive.promise);
    await act(async () => {
      useMessageQueueStore.setState({
        queues: {
          [ARCHIVED_SUB]: [createQueueItem('held', 'held')],
          [OTHER_SUB]: [createQueueItem('free', 'free')],
        },
      });
      useStreamingStatusStore.getState().setStatus(ARCHIVED_SUB, 'ready');
      useStreamingStatusStore.getState().setStatus(OTHER_SUB, 'ready');
    });
    await advance(QUEUE_PROCESS_DELAY_MS * 3);

    expect(mockSendMessage).toHaveBeenCalledTimes(1);
    expect(useMessageQueueStore.getState().queues[ARCHIVED_SUB]?.map((i) => i.id)).toEqual([
      'held',
    ]);
    archive.settle().resolve();
  });

  it('does not resurrect a message whose send fails after the archive cleared the queue', async () => {
    renderProcessor();
    // The send was already in flight when archive began; it fails after the queue is dropped.
    let failSend: () => void = () => {};
    mockSendMessage.mockImplementationOnce(
      () =>
        new Promise((_resolve, reject) => {
          failSend = () => reject(new Error('socket closed'));
        }),
    );
    await act(async () => {
      useMessageQueueStore.setState({
        queues: { [ARCHIVED_SUB]: [createQueueItem('in-flight', 'follow-up')] },
      });
      useStreamingStatusStore.getState().setStatus(ARCHIVED_SUB, 'ready');
    });
    await advance(QUEUE_PROCESS_DELAY_MS);
    expect(mockSendMessage).toHaveBeenCalledTimes(1);

    await act(async () => {
      await archiveWithQueueHold(ARCHIVED_CHAT, async () => ({ id: ARCHIVED_CHAT }));
    });
    await act(async () => {
      failSend();
    });
    await advance(QUEUE_PROCESS_DELAY_MS * 3);

    expect(useMessageQueueStore.getState().queues[ARCHIVED_SUB]).toBeUndefined();
    expect(mockSendMessage).toHaveBeenCalledTimes(1);
    // Nothing is left to retry, so no "will be retried" toast and no error state.
    expect(toast.error).not.toHaveBeenCalled();
    expect(useStreamingStatusStore.getState().getStatus(ARCHIVED_SUB)).not.toBe('error');
  });

  it('still requeues a failed send when nothing cleared the queue meanwhile', async () => {
    renderProcessor();
    mockSendMessage.mockRejectedValueOnce(new Error('socket closed'));
    await act(async () => {
      useMessageQueueStore.setState({
        queues: { [OTHER_SUB]: [createQueueItem('retry-me', 'retry')] },
      });
      useStreamingStatusStore.getState().setStatus(OTHER_SUB, 'ready');
    });
    await advance(QUEUE_PROCESS_DELAY_MS);

    expect(useMessageQueueStore.getState().queues[OTHER_SUB]?.map((i) => i.id)).toEqual([
      'retry-me',
    ]);
    expect(toast.error).toHaveBeenCalledWith('Failed to send queued message. It will be retried.');
  });

  it('stays held while a second pane is still archiving the same chat', async () => {
    renderProcessor();
    const first = deferredArchive();
    const second = deferredArchive();
    const firstArchiving = archiveWithQueueHold(ARCHIVED_CHAT, () => first.promise);
    void archiveWithQueueHold(ARCHIVED_CHAT, () => second.promise);

    // The first pane's attempt fails and releases its hold; the second is still in flight.
    first.settle().reject(new Error('first pane failed'));
    await act(async () => {
      await expect(firstArchiving).rejects.toThrow();
    });
    await act(async () => {
      useMessageQueueStore.setState({
        queues: { [ARCHIVED_SUB]: [createQueueItem('q1', 'follow-up')] },
      });
      useStreamingStatusStore.getState().setStatus(ARCHIVED_SUB, 'ready');
    });
    await advance(QUEUE_PROCESS_DELAY_MS * 3);

    expect(mockSendMessage).not.toHaveBeenCalled();
    second.settle().resolve();
  });
});
