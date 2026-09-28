// @vitest-environment happy-dom
/**
 * QueueProcessor waits for parent chat `getResolvedAccount` query success before popping the queue
 * (parity with ChatViewInner `isResolvedExecutionAccountReady`).
 */
import '@testing-library/jest-dom/vitest';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { act, render } from '@testing-library/react';
import { getQueryKey } from '@trpc/react-query';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createQueueItem } from '../lib/queue-utils';
import { useMessageQueueStore } from '../stores/message-queue-store';
import { useStreamingStatusStore } from '../stores/streaming-status-store';
import {
  ACCOUNT_FETCH_TIMEOUT_MS,
  ACCOUNT_REFETCH_COOLDOWN_MS,
  ACCOUNT_REFETCH_MAX_DELAY_MS,
  QUEUE_PROCESS_DELAY_MS,
  QueueProcessor,
} from './queue-processor';

const SUB_CHAT_ID = 'sub-needs-parent-account';
const SIBLING_SUB_CHAT_ID = 'sub-sibling-same-parent';
const PARENT_CHAT_ID = 'parent-chat-1';

const { mockSendMessage, mockFetchResolvedAccount, getResolvedAccountProcedure } = vi.hoisted(
  () => {
    const proc = {
      _def: () => ({ path: ['claudeCode', 'getResolvedAccount'] as const }),
    };
    return {
      mockSendMessage: vi.fn(),
      mockFetchResolvedAccount: vi.fn(),
      getResolvedAccountProcedure: proc,
    };
  },
);

vi.mock('../../../lib/trpc', () => ({
  trpc: {
    useUtils: vi.fn(() => mockTrpcUtils),
    claudeCode: {
      getResolvedAccount: getResolvedAccountProcedure,
    },
  },
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
  claudeCode: {
    getResolvedAccount: { fetch: mockFetchResolvedAccount },
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
  appStore: { get: vi.fn(), set: vi.fn() },
}));
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
      id === SUB_CHAT_ID || id === SIBLING_SUB_CHAT_ID
        ? { sendMessage: mockSendMessage }
        : undefined,
    getParentChatId: vi.fn((id: string) =>
      id === SUB_CHAT_ID || id === SIBLING_SUB_CHAT_ID ? PARENT_CHAT_ID : null,
    ),
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

describe('QueueProcessor — getResolvedAccount gate', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    setupDesktopApiMinimal();
    useMessageQueueStore.setState({ queues: {} });
    useStreamingStatusStore.setState({ statuses: {} });
    mockSendMessage.mockReset();
    mockSendMessage.mockResolvedValue(undefined);
    mockFetchResolvedAccount.mockReset();
    // Default: an in-flight fetch that never settles, so the gate stays closed until a test decides.
    mockFetchResolvedAccount.mockImplementation(() => new Promise(() => {}));
  });

  afterEach(() => {
    vi.clearAllTimers();
    vi.useRealTimers();
    delete (window as { desktopApi?: unknown }).desktopApi;
  });

  it('defers pop until parent getResolvedAccount is in cache as success; resumes after setQueryData', async () => {
    const queryClient = new QueryClient({
      defaultOptions: {
        queries: { retry: false },
        mutations: { retry: false },
      },
    });
    const resolvedKey = getQueryKey(
      getResolvedAccountProcedure as unknown as Parameters<typeof getQueryKey>[0],
      { chatId: PARENT_CHAT_ID },
      'query',
    );

    const item = createQueueItem('q-acc', 'hello');
    useMessageQueueStore.setState({ queues: { [SUB_CHAT_ID]: [item] } });
    useStreamingStatusStore.getState().setStatus(SUB_CHAT_ID, 'ready');

    render(
      <QueryClientProvider client={queryClient}>
        <QueueProcessor />
      </QueryClientProvider>,
    );

    await act(async () => {
      await vi.advanceTimersByTimeAsync(QUEUE_PROCESS_DELAY_MS);
    });
    expect(mockSendMessage).not.toHaveBeenCalled();

    await act(async () => {
      queryClient.setQueryData(resolvedKey, {
        type: 'claude-code',
        label: 'test',
        isProjectOverride: false,
        isAuthenticated: true,
        projectId: null,
      });
    });

    await act(async () => {
      await vi.advanceTimersByTimeAsync(QUEUE_PROCESS_DELAY_MS);
    });
    expect(mockSendMessage).toHaveBeenCalledTimes(1);
  });

  const ACCOUNT = {
    type: 'claude-code',
    label: 'test',
    isProjectOverride: false,
    isAuthenticated: true,
    projectId: null,
  };

  function setup() {
    const queryClient = new QueryClient({
      defaultOptions: {
        queries: { retry: false },
        mutations: { retry: false },
      },
    });
    const resolvedKey = getQueryKey(
      getResolvedAccountProcedure as unknown as Parameters<typeof getQueryKey>[0],
      { chatId: PARENT_CHAT_ID },
      'query',
    );
    const view = render(
      <QueryClientProvider client={queryClient}>
        <QueueProcessor />
      </QueryClientProvider>,
    );
    return { queryClient, resolvedKey, view };
  }

  function enqueue(subChatId: string, id: string) {
    const current = useMessageQueueStore.getState().queues[subChatId] ?? [];
    useStreamingStatusStore.getState().setStatus(subChatId, 'ready');
    useMessageQueueStore.setState({
      queues: {
        ...useMessageQueueStore.getState().queues,
        [subChatId]: [...current, createQueueItem(id, 'hello')],
      },
    });
  }

  async function tick(ms = QUEUE_PROCESS_DELAY_MS) {
    await act(async () => {
      await vi.advanceTimersByTimeAsync(ms);
    });
  }

  /** Mirrors a real rejected fetch: the query lands in `error`, which emits a cache `updated`. */
  function rejectInto(queryClient: QueryClient, resolvedKey: readonly unknown[]) {
    return () =>
      queryClient.fetchQuery({
        queryKey: resolvedKey,
        queryFn: () => Promise.reject(new Error('ipc down')),
      });
  }

  it('fetches the account itself when the entry was garbage-collected, then sends', async () => {
    const { queryClient, resolvedKey } = setup();
    queryClient.setQueryData(resolvedKey, ACCOUNT);
    mockFetchResolvedAccount.mockImplementation(async () => {
      queryClient.setQueryData(resolvedKey, ACCOUNT);
      return ACCOUNT;
    });

    enqueue(SUB_CHAT_ID, 'q-gc');
    queryClient.removeQueries({ queryKey: resolvedKey });
    await tick();
    expect(mockFetchResolvedAccount).toHaveBeenCalledTimes(1);
    expect(mockFetchResolvedAccount).toHaveBeenCalledWith({
      chatId: PARENT_CHAT_ID,
    });

    await tick();
    expect(mockSendMessage).toHaveBeenCalledTimes(1);
  });

  it('does not start a second fetch while one is already in flight', async () => {
    const { queryClient, resolvedKey } = setup();
    void queryClient.fetchQuery({
      queryKey: resolvedKey,
      queryFn: () => new Promise(() => {}),
    });

    enqueue(SUB_CHAT_ID, 'q-inflight');
    await tick();
    await tick();
    expect(mockFetchResolvedAccount).not.toHaveBeenCalled();
    expect(mockSendMessage).not.toHaveBeenCalled();
  });

  it('cancels an account fetch that never settles and fetches again, then sends', async () => {
    const { queryClient, resolvedKey } = setup();
    void queryClient
      .fetchQuery({ queryKey: resolvedKey, queryFn: () => new Promise(() => {}) })
      .catch(() => {});
    mockFetchResolvedAccount.mockImplementation(async () => {
      queryClient.setQueryData(resolvedKey, ACCOUNT);
      return ACCOUNT;
    });

    enqueue(SUB_CHAT_ID, 'q-hung');
    await tick();
    await tick(ACCOUNT_FETCH_TIMEOUT_MS - QUEUE_PROCESS_DELAY_MS * 2);
    expect(mockFetchResolvedAccount).not.toHaveBeenCalled();

    await tick(QUEUE_PROCESS_DELAY_MS * 4);
    expect(mockFetchResolvedAccount).toHaveBeenCalledTimes(1);
    await tick();
    expect(mockSendMessage).toHaveBeenCalledTimes(1);
  });

  it("times a fresh fetch from when it started, not from the gate's last failed attempt", async () => {
    const { queryClient, resolvedKey } = setup();
    const calledAt: number[] = [];
    mockFetchResolvedAccount.mockImplementation(() => {
      calledAt.push(Date.now());
      return rejectInto(queryClient, resolvedKey)();
    });

    enqueue(SUB_CHAT_ID, 'q-fresh');
    // Three failures leave a 40s backoff, longer than the in-flight timeout.
    for (let i = 0; i < 200 && calledAt.length < 3; i++) await tick();
    expect(calledAt).toHaveLength(3);
    await tick(calledAt[2] + ACCOUNT_FETCH_TIMEOUT_MS + 5_000 - Date.now());
    expect(mockFetchResolvedAccount).toHaveBeenCalledTimes(3);

    // Another observer (the user opening the chat) starts a healthy fetch.
    void queryClient
      .fetchQuery({ queryKey: resolvedKey, queryFn: () => new Promise(() => {}) })
      .catch(() => {});
    await tick(QUEUE_PROCESS_DELAY_MS * 2);
    expect(queryClient.getQueryState(resolvedKey)?.fetchStatus).toBe('fetching');

    // It is only treated as hung once it has itself been in flight past the timeout.
    await tick(ACCOUNT_FETCH_TIMEOUT_MS);
    expect(queryClient.getQueryState(resolvedKey)?.fetchStatus).not.toBe('fetching');
  });

  it('restarts the hang timeout when one fetch settles and another starts between gate checks', async () => {
    const { queryClient, resolvedKey } = setup();
    let rejectA: (error: Error) => void = () => {};
    void queryClient
      .fetchQuery({
        queryKey: resolvedKey,
        queryFn: () => new Promise((_, reject) => (rejectA = reject)),
      })
      .catch(() => {});

    enqueue(SUB_CHAT_ID, 'q-a-then-b');
    await tick();
    const firstSeen = Date.now();
    await tick(ACCOUNT_FETCH_TIMEOUT_MS - 5_000);

    // A settles and B starts in the same tick, before the gate looks again.
    await act(async () => {
      rejectA(new Error('ipc down'));
      // Settle A fully (0ms flushes promises; the gate's next check is QUEUE_PROCESS_DELAY_MS away).
      await vi.advanceTimersByTimeAsync(0);
      expect(queryClient.getQueryState(resolvedKey)?.fetchStatus).toBe('idle');
      void queryClient
        .fetchQuery({ queryKey: resolvedKey, queryFn: () => new Promise(() => {}) })
        .catch(() => {});
    });

    // Past A's timeout window: B has only been in flight ~6s and must survive.
    await tick(firstSeen + ACCOUNT_FETCH_TIMEOUT_MS + 1_000 - Date.now());
    expect(queryClient.getQueryState(resolvedKey)?.fetchStatus).toBe('fetching');
    expect(mockFetchResolvedAccount).not.toHaveBeenCalled();
  });

  it('still times out a fetch that was already in flight when the processor mounted', async () => {
    const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    const resolvedKey = getQueryKey(
      getResolvedAccountProcedure as unknown as Parameters<typeof getQueryKey>[0],
      { chatId: PARENT_CHAT_ID },
      'query',
    );
    void queryClient
      .fetchQuery({ queryKey: resolvedKey, queryFn: () => new Promise(() => {}) })
      .catch(() => {});
    render(
      <QueryClientProvider client={queryClient}>
        <QueueProcessor />
      </QueryClientProvider>,
    );

    enqueue(SUB_CHAT_ID, 'q-premount');
    await tick(ACCOUNT_FETCH_TIMEOUT_MS + QUEUE_PROCESS_DELAY_MS * 4);
    expect(mockFetchResolvedAccount).toHaveBeenCalledTimes(1);
  });

  it('rate-limits refetches of a failing account: one per cooldown, no send, no hot loop', async () => {
    const { queryClient, resolvedKey } = setup();
    mockFetchResolvedAccount.mockImplementation(rejectInto(queryClient, resolvedKey));

    enqueue(SUB_CHAT_ID, 'q-err');
    await tick();
    // The rejection lands the query in `error` and wakes the processor through the cache
    // subscription; that wake is inside the cooldown and must not fetch again.
    await tick(QUEUE_PROCESS_DELAY_MS * 3);
    expect(mockFetchResolvedAccount).toHaveBeenCalledTimes(1);

    await tick(ACCOUNT_REFETCH_COOLDOWN_MS - QUEUE_PROCESS_DELAY_MS * 4 - 1);
    expect(mockFetchResolvedAccount).toHaveBeenCalledTimes(1);

    // The scheduled re-check fires with nothing else waking the processor, then the usual
    // dispatch spacing runs before the gate fetches again.
    await tick(QUEUE_PROCESS_DELAY_MS * 2 + 1);
    expect(mockFetchResolvedAccount).toHaveBeenCalledTimes(2);
    expect(mockSendMessage).not.toHaveBeenCalled();
  });

  it('backs off a persistently failing account fetch, doubling up to the cap', async () => {
    const { queryClient, resolvedKey } = setup();
    const calledAt: number[] = [];
    mockFetchResolvedAccount.mockImplementation(() => {
      calledAt.push(Date.now());
      return rejectInto(queryClient, resolvedKey)();
    });

    enqueue(SUB_CHAT_ID, 'q-backoff');
    await tick(ACCOUNT_REFETCH_MAX_DELAY_MS * 4);

    const gaps = calledAt.slice(1).map((at, i) => at - calledAt[i]);
    // Each gap is the backoff plus at most one dispatch delay before the gate re-runs.
    const expected = gaps.map((_, i) =>
      Math.min(ACCOUNT_REFETCH_COOLDOWN_MS * 2 ** i, ACCOUNT_REFETCH_MAX_DELAY_MS),
    );
    expect(gaps.length).toBeGreaterThanOrEqual(6);
    gaps.forEach((gap, i) => {
      expect(gap).toBeGreaterThanOrEqual(expected[i]);
      expect(gap).toBeLessThanOrEqual(expected[i] + QUEUE_PROCESS_DELAY_MS);
    });
    expect(mockSendMessage).not.toHaveBeenCalled();
  });

  it('recovers from a failed fetch: the retry after the cooldown succeeds and the item sends', async () => {
    const { queryClient, resolvedKey } = setup();
    mockFetchResolvedAccount.mockImplementationOnce(rejectInto(queryClient, resolvedKey));
    mockFetchResolvedAccount.mockImplementation(async () => {
      queryClient.setQueryData(resolvedKey, ACCOUNT);
      return ACCOUNT;
    });

    enqueue(SUB_CHAT_ID, 'q-recover');
    await tick();
    expect(mockSendMessage).not.toHaveBeenCalled();

    await tick(ACCOUNT_REFETCH_COOLDOWN_MS + QUEUE_PROCESS_DELAY_MS * 2);
    expect(mockFetchResolvedAccount).toHaveBeenCalledTimes(2);
    expect(mockSendMessage).toHaveBeenCalledTimes(1);
  });

  it('two sub-chats of one parent share a single fetch and both drain', async () => {
    const { queryClient, resolvedKey } = setup();
    let resolveFetch: () => void = () => {};
    mockFetchResolvedAccount.mockImplementation(
      () =>
        new Promise<void>((resolve) => {
          resolveFetch = () => {
            queryClient.setQueryData(resolvedKey, ACCOUNT);
            resolve();
          };
        }),
    );

    enqueue(SUB_CHAT_ID, 'q-a');
    enqueue(SIBLING_SUB_CHAT_ID, 'q-b');
    await tick();
    expect(mockFetchResolvedAccount).toHaveBeenCalledTimes(1);

    await act(async () => resolveFetch());
    await tick();
    expect(mockSendMessage).toHaveBeenCalledTimes(2);
  });

  it('a success resets the cooldown: a later GC refetches immediately', async () => {
    const { queryClient, resolvedKey } = setup();
    mockFetchResolvedAccount.mockImplementation(async () => {
      queryClient.setQueryData(resolvedKey, ACCOUNT);
      return ACCOUNT;
    });

    enqueue(SUB_CHAT_ID, 'q-1');
    await tick();
    await tick();
    expect(mockSendMessage).toHaveBeenCalledTimes(1);

    queryClient.removeQueries({ queryKey: resolvedKey });
    enqueue(SUB_CHAT_ID, 'q-2');
    await tick();
    expect(mockFetchResolvedAccount).toHaveBeenCalledTimes(2);
    await tick();
    expect(mockSendMessage).toHaveBeenCalledTimes(2);
  });

  it('does not block a send while a successful entry refetches in the background', async () => {
    const { queryClient, resolvedKey } = setup();
    queryClient.setQueryData(resolvedKey, ACCOUNT);
    void queryClient.fetchQuery({
      queryKey: resolvedKey,
      queryFn: () => new Promise(() => {}),
      staleTime: 0,
    });

    enqueue(SUB_CHAT_ID, 'q-bg');
    await tick();
    expect(mockFetchResolvedAccount).not.toHaveBeenCalled();
    expect(mockSendMessage).toHaveBeenCalledTimes(1);
  });

  it('clears the pending re-check on unmount (no fetch after teardown)', async () => {
    const { queryClient, resolvedKey, view } = setup();
    mockFetchResolvedAccount.mockImplementation(rejectInto(queryClient, resolvedKey));

    enqueue(SUB_CHAT_ID, 'q-unmount');
    await tick();
    expect(mockFetchResolvedAccount).toHaveBeenCalledTimes(1);

    view.unmount();
    await tick(ACCOUNT_REFETCH_COOLDOWN_MS * 2);
    expect(mockFetchResolvedAccount).toHaveBeenCalledTimes(1);
  });
});
