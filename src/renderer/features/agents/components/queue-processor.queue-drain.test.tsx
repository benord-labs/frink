// @vitest-environment happy-dom
/**
 * Multi-item queue drain: after the first queued message completes, `checkAllQueues` must run
 * again (see queue-processor guarded `finally`). Regression tests for stuck "N in queue".
 */
import '@testing-library/jest-dom/vitest';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { act, render } from '@testing-library/react';
import type { ReactElement } from 'react';
import { flushSync } from 'react-dom';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { runLiveAtomFamily, runSettlingAtomFamily } from '@/lib/stores/active-transport-registry';
import { createQueueItem } from '../lib/queue-utils';
import { useMessageQueueStore } from '../stores/message-queue-store';
import { useStreamingStatusStore } from '../stores/streaming-status-store';
import { QUEUE_PROCESS_DELAY_MS, QueueProcessor } from './queue-processor';

const SUB_CHAT_ID = 'sub-chat-queue-drain';

const {
  mockAppStoreGet,
  mockAppStoreSet,
  mockGetChat,
  mockGetParentChatId,
  mockSendMessage,
  mockArmApprovedPlanState,
  mockUpdateSubChatMode,
  chatRegistrations,
} = vi.hoisted(() => ({
  mockAppStoreGet: vi.fn(),
  mockAppStoreSet: vi.fn(),
  mockGetChat: vi.fn(),
  mockGetParentChatId: vi.fn(() => null),
  mockSendMessage: vi.fn(),
  mockArmApprovedPlanState: vi.fn(),
  mockUpdateSubChatMode: vi.fn(),
  chatRegistrations: new Set<(subChatId: string) => void>(),
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
  agents: {
    getAgentChat: { invalidate: vi.fn() },
  },
};

vi.mock('../../../lib/mock-api', () => ({
  api: { useUtils: vi.fn(() => mockApiUtils) },
}));

const mockApiUtils = {
  agents: { getAgentChat: { invalidate: vi.fn() } },
};

vi.mock('../../../lib/analytics', () => ({ trackMessageSent: vi.fn() }));
vi.mock('../../../lib/jotai-store', () => ({
  appStore: { get: mockAppStoreGet, set: mockAppStoreSet },
}));
vi.mock('sonner', () => ({ toast: { error: vi.fn() } }));
vi.mock('../../sidebar/unified/sidebar-chat-activity', () => ({
  notifySidebarChatActivity: vi.fn(),
}));
vi.mock('../atoms', () => ({
  approvedPlanContextAtomFamily: (id: string) => `approvedPlanContext:${id}`,
  approvedPlanIdsAtomFamily: (id: string) => `approvedPlanIds:${id}`,
  clearLoading: vi.fn(),
  loadingSubChatsAtom: {},
  pendingModeIntentAtomFamily: (id: string) => `pendingModeIntent:${id}`,
  setLoading: vi.fn(),
}));
const SUB_CHAT_MULTI_A = 'sub-multi-a';
const SUB_CHAT_MULTI_B = 'sub-multi-b';

vi.mock('../stores/agent-chat-store', () => ({
  agentChatStore: {
    get: mockGetChat,
    getParentChatId: mockGetParentChatId,
  },
  onChatRegistered: (listener: (subChatId: string) => void) => {
    chatRegistrations.add(listener);
    return () => chatRegistrations.delete(listener);
  },
}));
vi.mock('../stores/sub-chat-store', () => ({
  armApprovedPlanState: mockArmApprovedPlanState,
  useAgentSubChatStore: {
    getState: () => ({
      subChatsById: {},
      updateSubChatMode: mockUpdateSubChatMode,
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
  useMessageQueueStore.setState({ queues: {} });
  useStreamingStatusStore.setState({ statuses: {} });
}

function renderQueueProcessor(ui: ReactElement = <QueueProcessor />) {
  const client = new QueryClient({
    defaultOptions: {
      queries: { retry: false },
      mutations: { retry: false },
    },
  });
  return render(<QueryClientProvider client={client}>{ui}</QueryClientProvider>);
}

describe('QueueProcessor — multi-item queue drain', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    setupDesktopApiMinimal();
    resetStores();
    mockSendMessage.mockReset();
    mockSendMessage.mockResolvedValue(undefined);
    mockAppStoreSet.mockReset();
    const atomValues = new Map<unknown, unknown>();
    mockAppStoreGet.mockReset();
    mockAppStoreGet.mockImplementation((atom: unknown) => {
      if (atomValues.has(atom)) return atomValues.get(atom);
      return String(atom).startsWith('approvedPlanIds:') ? new Set<string>() : undefined;
    });
    mockAppStoreSet.mockImplementation((atom: unknown, value: unknown) => {
      atomValues.set(atom, value);
    });
    mockArmApprovedPlanState.mockReset();
    mockArmApprovedPlanState.mockImplementation((subChatId: string, context: unknown) => {
      mockAppStoreSet(`approvedPlanContext:${subChatId}`, context);
      mockUpdateSubChatMode(subChatId, 'agent');
    });
    mockUpdateSubChatMode.mockReset();
    mockGetParentChatId.mockReset();
    mockGetParentChatId.mockReturnValue(null);
    chatRegistrations.clear();
    mockGetChat.mockReset();
    mockGetChat.mockImplementation((id: string) =>
      id === SUB_CHAT_ID || id === SUB_CHAT_MULTI_A || id === SUB_CHAT_MULTI_B
        ? { sendMessage: mockSendMessage }
        : undefined,
    );
  });

  afterEach(() => {
    vi.clearAllTimers();
    vi.useRealTimers();
    delete (window as { desktopApi?: unknown }).desktopApi;
  });

  it('does not schedule further processing after unmount when sendMessage resolves late', async () => {
    let resolveFirst!: (value: unknown) => void;
    const firstPending = new Promise<unknown>((resolve) => {
      resolveFirst = resolve;
    });
    mockSendMessage.mockImplementation(() => firstPending);

    const itemA = createQueueItem('q-a', 'first');
    const itemB = createQueueItem('q-b', 'second');
    useMessageQueueStore.setState({
      queues: { [SUB_CHAT_ID]: [itemA, itemB] },
    });
    useStreamingStatusStore.getState().setStatus(SUB_CHAT_ID, 'ready');

    const { unmount } = renderQueueProcessor();

    await act(async () => {
      await vi.advanceTimersByTimeAsync(QUEUE_PROCESS_DELAY_MS);
    });
    // First item popped and send in flight; second item still in queue; must stay at 1 send.
    expect(mockSendMessage).toHaveBeenCalledTimes(1);

    flushSync(() => {
      unmount();
    });

    await act(async () => {
      resolveFirst(undefined);
      await Promise.resolve();
    });
    // If activeRef were still true, finally would schedule another debounced run — not yet fired.
    expect(mockSendMessage).toHaveBeenCalledTimes(1);

    await act(async () => {
      await vi.advanceTimersByTimeAsync(QUEUE_PROCESS_DELAY_MS * 5);
    });
    expect(mockSendMessage).toHaveBeenCalledTimes(1);
  });

  it('drains an item whose Chat was missing at the dispatch tick, once that Chat registers', async () => {
    // Every other dispatch gate is a store the processor subscribes to, so a transient failure
    // re-fires when the value changes. The Chat is a plain Map: while a pane re-creates it, the
    // tick finds nothing and — without a registration edge — the item waits on an unrelated store
    // write that may never come, leaving a full queue beside a chat that works normally.
    mockGetChat.mockReturnValue(undefined);
    useMessageQueueStore.setState({
      queues: { [SUB_CHAT_ID]: [createQueueItem('q-a', 'first')] },
    });
    useStreamingStatusStore.getState().setStatus(SUB_CHAT_ID, 'ready');

    renderQueueProcessor();

    await act(async () => {
      await vi.advanceTimersByTimeAsync(QUEUE_PROCESS_DELAY_MS);
    });
    expect(mockSendMessage).not.toHaveBeenCalled();

    // The Chat arrives. Nothing else changes — no queue write, no status write, no reconnect.
    mockGetChat.mockImplementation((id: string) =>
      id === SUB_CHAT_ID ? { sendMessage: mockSendMessage } : undefined,
    );
    await act(async () => {
      for (const notify of chatRegistrations) notify(SUB_CHAT_ID);
      await vi.advanceTimersByTimeAsync(QUEUE_PROCESS_DELAY_MS);
    });

    expect(mockSendMessage).toHaveBeenCalledTimes(1);
  });

  it('processes two queued items: sendMessage called twice after debounce delays', async () => {
    const itemA = createQueueItem('q-a', 'first');
    const itemB = createQueueItem('q-b', 'second');
    useMessageQueueStore.setState({
      queues: { [SUB_CHAT_ID]: [itemA, itemB] },
    });
    useStreamingStatusStore.getState().setStatus(SUB_CHAT_ID, 'ready');

    renderQueueProcessor();

    await act(async () => {
      await vi.advanceTimersByTimeAsync(QUEUE_PROCESS_DELAY_MS);
    });
    expect(mockSendMessage).toHaveBeenCalledTimes(1);

    await act(async () => {
      await vi.advanceTimersByTimeAsync(QUEUE_PROCESS_DELAY_MS);
    });
    expect(mockSendMessage).toHaveBeenCalledTimes(2);
  });

  it('forwards a flow-dispatch source as message metadata; human items send without metadata', async () => {
    // The transport's approve-then-execute flip keys off this metadata — a dropped tag re-flips a
    // later plan node to agent mode; a wrongly-tagged human reply would stop resuming parked plans.
    const flowItem = {
      ...createQueueItem('q-flow', 'flow prompt'),
      source: 'flow-dispatch' as const,
    };
    const humanItem = createQueueItem('q-human', 'human reply');
    useMessageQueueStore.setState({
      queues: { [SUB_CHAT_ID]: [flowItem, humanItem] },
    });
    useStreamingStatusStore.getState().setStatus(SUB_CHAT_ID, 'ready');

    renderQueueProcessor();

    await act(async () => {
      await vi.advanceTimersByTimeAsync(QUEUE_PROCESS_DELAY_MS);
    });
    expect(mockSendMessage).toHaveBeenNthCalledWith(
      1,
      expect.objectContaining({ metadata: { source: 'flow-dispatch' } }),
    );

    await act(async () => {
      await vi.advanceTimersByTimeAsync(QUEUE_PROCESS_DELAY_MS);
    });
    expect(mockSendMessage).toHaveBeenCalledTimes(2);
    expect(mockSendMessage.mock.calls[1][0]).not.toHaveProperty('metadata');
  });

  it('does not duplicate send when second item is enqueued while first send is in flight (processingRef)', async () => {
    let resolveFirst!: (value: unknown) => void;
    mockSendMessage.mockImplementation(
      () =>
        new Promise((resolve) => {
          resolveFirst = resolve;
        }),
    );

    const item1 = createQueueItem('q-1', 'first');
    useMessageQueueStore.setState({
      queues: { [SUB_CHAT_ID]: [item1] },
    });
    useStreamingStatusStore.getState().setStatus(SUB_CHAT_ID, 'ready');

    renderQueueProcessor();

    await act(async () => {
      await vi.advanceTimersByTimeAsync(QUEUE_PROCESS_DELAY_MS);
    });
    expect(mockSendMessage).toHaveBeenCalledTimes(1);

    const item2 = createQueueItem('q-2', 'second');
    await act(async () => {
      useMessageQueueStore.setState({
        queues: { [SUB_CHAT_ID]: [item2] },
      });
    });
    // While mockSendMessage is still unresolved, nudge status to `ready` so the streaming-status
    // subscription runs again; processingRef should keep this sub-chat skipped so we still expect
    // mockSendMessage toHaveBeenCalledTimes(1) until the in-flight send finishes.
    useStreamingStatusStore.getState().setStatus(SUB_CHAT_ID, 'ready');
    expect(mockSendMessage).toHaveBeenCalledTimes(1);

    await act(async () => {
      resolveFirst(undefined);
      await Promise.resolve();
    });
    await act(async () => {
      await vi.advanceTimersByTimeAsync(QUEUE_PROCESS_DELAY_MS);
    });
    expect(mockSendMessage).toHaveBeenCalledTimes(2);
  });

  it('retries after sendMessage rejects: error path still drains via finally + checkAllQueues', async () => {
    mockSendMessage.mockRejectedValueOnce(new Error('send failed')).mockResolvedValue(undefined);

    const item = createQueueItem('q-retry', 'hello');
    useMessageQueueStore.setState({
      queues: { [SUB_CHAT_ID]: [item] },
    });
    useStreamingStatusStore.getState().setStatus(SUB_CHAT_ID, 'ready');

    renderQueueProcessor();

    await act(async () => {
      await vi.advanceTimersByTimeAsync(QUEUE_PROCESS_DELAY_MS);
    });
    expect(mockSendMessage).toHaveBeenCalledTimes(1);
    expect(useMessageQueueStore.getState().queues[SUB_CHAT_ID]?.length).toBe(1);

    await act(async () => {
      await vi.advanceTimersByTimeAsync(QUEUE_PROCESS_DELAY_MS);
    });
    expect(mockSendMessage).toHaveBeenCalledTimes(2);
    expect(useMessageQueueStore.getState().queues[SUB_CHAT_ID]?.length ?? 0).toBe(0);
  });

  it('arms a recovered approval only for its exact popped item and preserves it across retry', async () => {
    let resolveOlder!: (value: unknown) => void;
    mockSendMessage
      .mockImplementationOnce(
        () =>
          new Promise((resolve) => {
            resolveOlder = resolve;
          }),
      )
      .mockRejectedValueOnce(new Error('plan send failed'))
      .mockResolvedValueOnce(undefined);
    const context = {
      planId: 'plan-recovery',
      planText: 'Approved work',
    };
    useMessageQueueStore.setState({
      queues: { [SUB_CHAT_ID]: [createQueueItem('q-older', 'older')] },
    });
    useStreamingStatusStore.getState().setStatus(SUB_CHAT_ID, 'ready');
    renderQueueProcessor();

    await act(async () => {
      await vi.advanceTimersByTimeAsync(QUEUE_PROCESS_DELAY_MS);
    });
    useMessageQueueStore.getState().prependItem(SUB_CHAT_ID, {
      ...createQueueItem('q-plan', 'Implement the approved plan'),
      approvedPlanContext: context,
    });
    expect(mockSendMessage).toHaveBeenCalledTimes(1);
    expect(mockArmApprovedPlanState).not.toHaveBeenCalled();

    await act(async () => {
      resolveOlder(undefined);
      await Promise.resolve();
      await vi.advanceTimersByTimeAsync(QUEUE_PROCESS_DELAY_MS);
    });
    expect(mockSendMessage).toHaveBeenCalledTimes(2);
    expect(mockArmApprovedPlanState).toHaveBeenCalledWith(SUB_CHAT_ID, context);
    expect(mockAppStoreSet).toHaveBeenCalledWith(`pendingModeIntent:${SUB_CHAT_ID}`, 'agent');
    expect(mockUpdateSubChatMode).toHaveBeenCalledWith(SUB_CHAT_ID, 'agent');
    expect(useMessageQueueStore.getState().queues[SUB_CHAT_ID]?.[0]).toMatchObject({
      id: 'q-plan',
      approvedPlanContext: context,
    });
    expect(mockAppStoreSet).toHaveBeenCalledWith(`approvedPlanContext:${SUB_CHAT_ID}`, null);
    expect(mockAppStoreSet).toHaveBeenCalledWith(`pendingModeIntent:${SUB_CHAT_ID}`, null);

    useStreamingStatusStore.getState().setStatus(SUB_CHAT_ID, 'ready');
    await act(async () => {
      await vi.advanceTimersByTimeAsync(QUEUE_PROCESS_DELAY_MS);
    });
    expect(mockSendMessage).toHaveBeenCalledTimes(3);
    expect(useMessageQueueStore.getState().queues[SUB_CHAT_ID] ?? []).toEqual([]);
  });

  it('drains queues for two sub-chats independently (split-view style)', async () => {
    const itemA = createQueueItem('q-ma', 'a');
    const itemB = createQueueItem('q-mb', 'b');
    useMessageQueueStore.setState({
      queues: {
        [SUB_CHAT_MULTI_A]: [itemA],
        [SUB_CHAT_MULTI_B]: [itemB],
      },
    });
    useStreamingStatusStore.getState().setStatus(SUB_CHAT_MULTI_A, 'ready');
    useStreamingStatusStore.getState().setStatus(SUB_CHAT_MULTI_B, 'ready');

    renderQueueProcessor();

    // Both sub-chats schedule debounced runs; the first completion's `finally` can reschedule the
    // other and reset its timer — advance twice so both sends complete.
    await act(async () => {
      await vi.advanceTimersByTimeAsync(QUEUE_PROCESS_DELAY_MS);
    });
    await act(async () => {
      await vi.advanceTimersByTimeAsync(QUEUE_PROCESS_DELAY_MS);
    });
    expect(mockSendMessage).toHaveBeenCalledTimes(2);
  });

  it('holds a queued item while main reports the run live, and drains once it settles', async () => {
    // The status store is never written for a turn this window owns, so the queue keys on main's
    // liveness too: a send on top of a live run makes main abort that run as a duplicate.
    mockAppStoreSet(runLiveAtomFamily(SUB_CHAT_ID), true);
    useMessageQueueStore.setState({
      queues: { [SUB_CHAT_ID]: [createQueueItem('q-a', 'first')] },
    });
    useStreamingStatusStore.getState().setStatus(SUB_CHAT_ID, 'ready');

    renderQueueProcessor();

    await act(async () => {
      await vi.advanceTimersByTimeAsync(QUEUE_PROCESS_DELAY_MS * 3);
    });
    expect(mockSendMessage).not.toHaveBeenCalled();

    // Settle: the live-run lane flips the flag and writes the status store, nothing else.
    mockAppStoreSet(runLiveAtomFamily(SUB_CHAT_ID), false);
    await act(async () => {
      useStreamingStatusStore.getState().setStatus(SUB_CHAT_ID, 'ready');
      await vi.advanceTimersByTimeAsync(QUEUE_PROCESS_DELAY_MS);
    });
    expect(mockSendMessage).toHaveBeenCalledTimes(1);
  });

  describe('a turn queued after this window’s stream closed, while main settles it', () => {
    async function queueInSettleTail() {
      mockAppStoreSet(runLiveAtomFamily(SUB_CHAT_ID), true);
      mockAppStoreSet(runSettlingAtomFamily(SUB_CHAT_ID), true);
      useStreamingStatusStore.getState().setStatus(SUB_CHAT_ID, 'ready');
      renderQueueProcessor();
      await act(async () => {
        useMessageQueueStore.getState().addToQueue(SUB_CHAT_ID, createQueueItem('q-t', 'next'));
        await vi.advanceTimersByTimeAsync(QUEUE_PROCESS_DELAY_MS * 2);
      });
      expect(mockSendMessage).not.toHaveBeenCalled(); // never on top of the unsettled run
    }

    async function settle(advanceMs: number) {
      mockAppStoreSet(runLiveAtomFamily(SUB_CHAT_ID), false);
      mockAppStoreSet(runSettlingAtomFamily(SUB_CHAT_ID), false);
      await act(async () => {
        useStreamingStatusStore.getState().setStatus(SUB_CHAT_ID, 'ready');
        await vi.advanceTimersByTimeAsync(advanceMs);
      });
    }

    it('goes out the moment main settles, without the spacing between queued turns', async () => {
      await queueInSettleTail();
      await settle(0);
      expect(mockSendMessage).toHaveBeenCalledTimes(1);
    });

    it('retries a failed send on the normal spacing', async () => {
      mockSendMessage.mockRejectedValueOnce(new Error('send failed'));
      await queueInSettleTail();
      await settle(QUEUE_PROCESS_DELAY_MS - 1);
      expect(mockSendMessage).toHaveBeenCalledTimes(1);

      await act(async () => {
        await vi.advanceTimersByTimeAsync(1);
      });
      expect(mockSendMessage).toHaveBeenCalledTimes(2);
    });
  });

  it('keeps the spacing for a turn queued while this window still streamed the run', async () => {
    mockAppStoreSet(runLiveAtomFamily(SUB_CHAT_ID), true);
    useStreamingStatusStore.getState().setStatus(SUB_CHAT_ID, 'streaming');
    renderQueueProcessor();
    useMessageQueueStore.getState().addToQueue(SUB_CHAT_ID, createQueueItem('q-s', 'next'));

    // The stream closes here, then main settles.
    useStreamingStatusStore.getState().setStatus(SUB_CHAT_ID, 'ready');
    mockAppStoreSet(runLiveAtomFamily(SUB_CHAT_ID), false);
    await act(async () => {
      useStreamingStatusStore.getState().setStatus(SUB_CHAT_ID, 'ready');
      await vi.advanceTimersByTimeAsync(QUEUE_PROCESS_DELAY_MS - 1);
    });
    expect(mockSendMessage).not.toHaveBeenCalled();

    await act(async () => {
      await vi.advanceTimersByTimeAsync(1);
    });
    expect(mockSendMessage).toHaveBeenCalledTimes(1);
  });
});
