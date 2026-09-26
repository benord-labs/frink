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
import { QUEUE_PROCESS_DELAY_MS, QueueProcessor } from './queue-processor';

const SUB_CHAT_ID = 'sub-needs-parent-account';
const PARENT_CHAT_ID = 'parent-chat-1';

const { mockSendMessage, getResolvedAccountProcedure } = vi.hoisted(() => {
  const proc = {
    _def: () => ({ path: ['claudeCode', 'getResolvedAccount'] as const }),
  };
  return {
    mockSendMessage: vi.fn(),
    getResolvedAccountProcedure: proc,
  };
});

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
};

vi.mock('../../../lib/mock-api', () => ({
  api: { useUtils: vi.fn(() => mockApiUtils) },
}));

const mockApiUtils = {
  agents: { getAgentChat: { invalidate: vi.fn() } },
};

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
    get: (id: string) => (id === SUB_CHAT_ID ? { sendMessage: mockSendMessage } : undefined),
    getParentChatId: vi.fn((id: string) => (id === SUB_CHAT_ID ? PARENT_CHAT_ID : null)),
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
});
