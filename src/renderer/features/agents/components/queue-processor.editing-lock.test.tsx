// @vitest-environment happy-dom
/**
 * Editing-lock guard: when the user is editing a queued item, the processor must NOT
 * autonomously pop and send it from underneath them. Once the lock clears (send finishes,
 * abandon, switch sub-chat), the processor must resume draining.
 */
import '@testing-library/jest-dom/vitest';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { act, render } from '@testing-library/react';
import type { ReactElement } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createQueueItem } from '../lib/queue-utils';
import { useMessageQueueStore } from '../stores/message-queue-store';
import { useStreamingStatusStore } from '../stores/streaming-status-store';
import { QUEUE_PROCESS_DELAY_MS, QueueProcessor } from './queue-processor';

const SUB_A = 'sub-edit-lock-a';
const SUB_B = 'sub-edit-lock-b';

const { mockSendMessage } = vi.hoisted(() => ({
  mockSendMessage: vi.fn(),
}));

vi.mock('../../../lib/trpc', () => ({
  trpc: { useUtils: vi.fn(() => mockTrpcUtils) },
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
  api: { useUtils: vi.fn(() => mockApiUtils) },
}));
const mockApiUtils = { agents: { getAgentChat: { invalidate: vi.fn() } } };

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
    get: (id: string) =>
      id === SUB_A || id === SUB_B ? { sendMessage: mockSendMessage } : undefined,
    getParentChatId: vi.fn(() => null),
  },
  onChatRegistered: vi.fn(() => vi.fn()),
}));

vi.mock('../stores/sub-chat-store', () => ({
  useAgentSubChatStore: {
    getState: () => ({
      subChatsById: {},
      updateSubChatTimestamp: vi.fn(),
    }),
  },
}));

function setupDesktopApiMinimal() {
  Object.defineProperty(window, 'desktopApi', {
    configurable: true,
    writable: true,
    value: {
      onSocketExecuteComplete: vi.fn(() => () => {}),
      onSocketTaskSignalPersisted: vi.fn(() => () => {}),
    },
  });
}

function resetStores() {
  useMessageQueueStore.setState({ queues: {}, editingItemIds: {} });
  useStreamingStatusStore.setState({ statuses: {} });
}

function renderQueueProcessor(ui: ReactElement = <QueueProcessor />) {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  });
  return render(<QueryClientProvider client={client}>{ui}</QueryClientProvider>);
}

describe('QueueProcessor — editing-lock guard', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    setupDesktopApiMinimal();
    resetStores();
    mockSendMessage.mockReset();
    mockSendMessage.mockResolvedValue(undefined);
  });

  afterEach(() => {
    vi.clearAllTimers();
    vi.useRealTimers();
    delete (window as { desktopApi?: unknown }).desktopApi;
  });

  it('does NOT pop queue[0] while it is the item the user is editing', async () => {
    const a = createQueueItem('a', 'editing me');
    const b = createQueueItem('b', 'next up');
    useMessageQueueStore.setState({
      queues: { [SUB_A]: [a, b] },
      editingItemIds: { [SUB_A]: 'a' }, // user has item-a in the editor
    });
    useStreamingStatusStore.getState().setStatus(SUB_A, 'ready');

    renderQueueProcessor();

    await act(async () => {
      await vi.advanceTimersByTimeAsync(QUEUE_PROCESS_DELAY_MS * 3);
    });

    // The locked item must remain in the queue and no send fires.
    expect(mockSendMessage).not.toHaveBeenCalled();
    const queueAfter = useMessageQueueStore.getState().queues[SUB_A];
    expect(queueAfter?.map((i) => i.id)).toEqual(['a', 'b']);
  });

  it('resumes popping once the editing flag clears (send completes / user abandons)', async () => {
    const a = createQueueItem('a', 'editing me');
    const b = createQueueItem('b', 'next');
    useMessageQueueStore.setState({
      queues: { [SUB_A]: [a, b] },
      editingItemIds: { [SUB_A]: 'a' },
    });
    useStreamingStatusStore.getState().setStatus(SUB_A, 'ready');

    renderQueueProcessor();

    // Lock holds — no send.
    await act(async () => {
      await vi.advanceTimersByTimeAsync(QUEUE_PROCESS_DELAY_MS);
    });
    expect(mockSendMessage).not.toHaveBeenCalled();

    // User finishes the edit (which removes the original AND clears the flag, just like the
    // active-chat send wrapper does on success).
    act(() => {
      useMessageQueueStore.setState((prev) => ({
        queues: { ...prev.queues, [SUB_A]: [b] },
        editingItemIds: { ...prev.editingItemIds, [SUB_A]: null },
      }));
    });

    await act(async () => {
      await vi.advanceTimersByTimeAsync(QUEUE_PROCESS_DELAY_MS);
    });
    expect(mockSendMessage).toHaveBeenCalledTimes(1);
  });

  it('still pops queue[0] when the editing lock is set on a non-first item', async () => {
    const a = createQueueItem('a', 'first');
    const b = createQueueItem('b', 'editing me');
    useMessageQueueStore.setState({
      queues: { [SUB_A]: [a, b] },
      editingItemIds: { [SUB_A]: 'b' }, // user is editing the second item
    });
    useStreamingStatusStore.getState().setStatus(SUB_A, 'ready');

    renderQueueProcessor();

    await act(async () => {
      await vi.advanceTimersByTimeAsync(QUEUE_PROCESS_DELAY_MS);
    });

    // queue[0] (a) is not editing-locked, so it pops normally.
    expect(mockSendMessage).toHaveBeenCalledTimes(1);
    // 'b' is still in queue with the editing lock intact.
    expect(useMessageQueueStore.getState().queues[SUB_A]?.map((i) => i.id)).toEqual(['b']);
    expect(useMessageQueueStore.getState().editingItemIds[SUB_A]).toBe('b');
  });

  it('isolates editing-lock per sub-chat (other sub-chat queue still drains)', async () => {
    const a = createQueueItem('a', 'editing in sub A');
    const b = createQueueItem('b', 'plain in sub B');
    useMessageQueueStore.setState({
      queues: { [SUB_A]: [a], [SUB_B]: [b] },
      editingItemIds: { [SUB_A]: 'a' }, // only sub A is locked
    });
    useStreamingStatusStore.getState().setStatus(SUB_A, 'ready');
    useStreamingStatusStore.getState().setStatus(SUB_B, 'ready');

    renderQueueProcessor();

    await act(async () => {
      await vi.advanceTimersByTimeAsync(QUEUE_PROCESS_DELAY_MS * 2);
    });

    // Sub B drained, sub A still holding.
    expect(mockSendMessage).toHaveBeenCalledTimes(1);
    expect(useMessageQueueStore.getState().queues[SUB_A]?.map((i) => i.id)).toEqual(['a']);
    expect(useMessageQueueStore.getState().queues[SUB_B] ?? []).toEqual([]);
  });

  it('keeps the editing-lock after a reorder shuffles the locked item to queue[0]', async () => {
    // The lock is identified by ID, not by position. Verify that even if the user (or another
    // pane) drags a sibling past the editing item — moving the editing item into queue[0] —
    // the drainer still recognises the lock and refuses to pop it.
    const a = createQueueItem('a', 'first, not editing');
    const b = createQueueItem('b', 'editing me');
    const c = createQueueItem('c', 'last');
    useMessageQueueStore.setState({
      queues: { [SUB_A]: [a, b, c] },
      editingItemIds: { [SUB_A]: 'b' },
    });
    useStreamingStatusStore.getState().setStatus(SUB_A, 'ready');

    renderQueueProcessor();

    // Drag 'a' past 'b' so the queue becomes [b, c, a] — 'b' (editing) is now at position 0.
    act(() => {
      useMessageQueueStore.getState().reorderQueue(SUB_A, 0, 2);
    });

    await act(async () => {
      await vi.advanceTimersByTimeAsync(QUEUE_PROCESS_DELAY_MS * 2);
    });

    // Lock still in effect — drainer must skip the editing item even at queue[0].
    expect(mockSendMessage).not.toHaveBeenCalled();
    expect(useMessageQueueStore.getState().queues[SUB_A]?.map((i) => i.id)).toEqual([
      'b',
      'c',
      'a',
    ]);
    expect(useMessageQueueStore.getState().editingItemIds[SUB_A]).toBe('b');
  });

  it('does NOT block draining when editingItemIds points to an id that is no longer in the queue', async () => {
    // Defensive fail-open: if editing state goes stale (e.g. another pane removed the item, or
    // a buggy caller set a ghost id), the lock must not silently freeze the queue forever. The
    // drainer's check is a strict-equals against queue[0].id, so a ghost id never matches.
    const a = createQueueItem('a', 'normal item');
    useMessageQueueStore.setState({
      queues: { [SUB_A]: [a] },
      editingItemIds: { [SUB_A]: 'ghost-id-not-in-queue' },
    });
    useStreamingStatusStore.getState().setStatus(SUB_A, 'ready');

    renderQueueProcessor();

    await act(async () => {
      await vi.advanceTimersByTimeAsync(QUEUE_PROCESS_DELAY_MS * 2);
    });

    expect(mockSendMessage).toHaveBeenCalledTimes(1);
    expect(useMessageQueueStore.getState().queues[SUB_A] ?? []).toEqual([]);
  });
});
