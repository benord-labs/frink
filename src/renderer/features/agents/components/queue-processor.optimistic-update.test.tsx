// @vitest-environment happy-dom
/**
 * Edge-case tests for the optimistic task-status update added to QueueProcessor.
 *
 * When the socket executor persists a frink_task_signal mid-stream it broadcasts
 * `socket:task-signal-persisted` via IPC. The renderer should:
 *  - Call `trpcUtils.tasks.getById.setData` for non-flow-linked tasks (instant cache update)
 *  - Skip `setData` for flow-linked anchor tasks (server keeps them "running" until flow ends)
 *  - Always call `invalidateTaskQueries` (fast background refetch regardless)
 *
 * Covered edge cases:
 *  1. Non-flow task → setData + invalidate
 *  2. Flow-linked task → setData skipped, invalidate still fires
 *  3. Task not in cache (old === undefined) → updater is a no-op, no crash
 *  4. setData updater preserves all existing fields and merges only the new status
 *  5. Statuses other than 'done' (e.g. needs_attention, failed) also trigger setData
 *  6. Missing desktopApi.onSocketTaskSignalPersisted → no throw
 *  7. IPC listener removed on unmount (no stale callback / memory leak)
 *  8. Invalid IPC status string → setData updater returns old unchanged; invalidates still run
 *  9. Rapid sequential signals for the same task — last status wins
 */
import '@testing-library/jest-dom/vitest';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { act, render } from '@testing-library/react';
import type { ReactElement } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { QueueProcessor } from './queue-processor';

function renderQueueProcessor(ui: ReactElement = <QueueProcessor />) {
  const client = new QueryClient({
    defaultOptions: {
      queries: { retry: false },
      mutations: { retry: false },
    },
  });
  return render(<QueryClientProvider client={client}>{ui}</QueryClientProvider>);
}

// ---------------------------------------------------------------------------
// tRPC / API mocks
// ---------------------------------------------------------------------------
const mockSetData = vi.fn();
const mockListPaginatedInvalidate = vi.fn();
const mockListCountsInvalidate = vi.fn();
const mockGetByIdInvalidate = vi.fn();
const mockDrivingTaskInvalidate = vi.fn();
const mockActionableTaskInvalidate = vi.fn();
const mockGetAgentChatInvalidate = vi.fn();

const mockTrpcUtils = {
  tasks: {
    getById: { setData: mockSetData, invalidate: mockGetByIdInvalidate },
    listPaginated: { invalidate: mockListPaginatedInvalidate },
    listCounts: { invalidate: mockListCountsInvalidate },
    getDrivingTaskForSubChat: { invalidate: mockDrivingTaskInvalidate },
    getActionableTaskForSubChat: { invalidate: mockActionableTaskInvalidate },
  },
  agents: {
    getAgentChat: { invalidate: mockGetAgentChatInvalidate },
  },
};

const mockApiUtils = {
  agents: { getAgentChat: { invalidate: mockGetAgentChatInvalidate } },
};

vi.mock('../../../lib/trpc', () => ({
  trpc: { useUtils: vi.fn(() => mockTrpcUtils) },
}));

vi.mock('../../../lib/mock-api', () => ({
  api: { useUtils: vi.fn(() => mockApiUtils) },
}));

// ---------------------------------------------------------------------------
// Side-effect mocks (silence irrelevant behaviour)
// ---------------------------------------------------------------------------
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
  agentChatStore: { get: vi.fn(() => null), getParentChatId: vi.fn(() => null) },
  onChatRegistered: vi.fn(() => vi.fn()),
}));
vi.mock('../stores/message-queue-store', () => ({
  useMessageQueueStore: {
    subscribe: vi.fn(() => vi.fn()),
    getState: vi.fn(() => ({ queues: {}, popItem: vi.fn(), prependItem: vi.fn() })),
  },
}));
vi.mock('../stores/streaming-status-store', () => ({
  useStreamingStatusStore: {
    subscribe: vi.fn(() => vi.fn()),
    getState: vi.fn(() => ({ getStatus: vi.fn(() => 'ready'), setStatus: vi.fn() })),
  },
}));

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------
type SignalPayload = { taskId: string; status: string; isFlowLinked: boolean };

function setupDesktopApi(): { fireSignal: (payload: SignalPayload) => void; cleanup: () => void } {
  let signalCb: ((data: SignalPayload) => void) | null = null;
  let cleanupCalled = false;

  Object.defineProperty(window, 'desktopApi', {
    configurable: true,
    writable: true,
    value: {
      onSocketExecuteComplete: vi.fn(() => () => {}),
      onSocketTaskSignalPersisted: vi.fn((cb: (data: SignalPayload) => void) => {
        signalCb = cb;
        return () => {
          cleanupCalled = true;
          signalCb = null;
        };
      }),
    },
  });

  return {
    fireSignal: (payload: SignalPayload) => {
      if (!signalCb) throw new Error('Signal callback not registered');
      signalCb(payload);
    },
    cleanup: () => {
      return cleanupCalled;
    },
  };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------
describe('QueueProcessor – onSocketTaskSignalPersisted (optimistic update)', () => {
  let api: ReturnType<typeof setupDesktopApi>;

  beforeEach(() => {
    vi.resetAllMocks();
    api = setupDesktopApi();
  });

  afterEach(() => {
    delete (window as { desktopApi?: unknown }).desktopApi;
  });

  // 1. Core happy path: non-flow task
  it('calls setData and all invalidates for a non-flow-linked task', () => {
    renderQueueProcessor();

    act(() => api.fireSignal({ taskId: 'task-abc', status: 'done', isFlowLinked: false }));

    expect(mockSetData).toHaveBeenCalledWith('task-abc', expect.any(Function));
    expect(mockListPaginatedInvalidate).toHaveBeenCalled();
    expect(mockListCountsInvalidate).toHaveBeenCalled();
    expect(mockGetByIdInvalidate).toHaveBeenCalled();
    // The chat-level status-row queries (getDrivingTaskForSubChat / getActionableTaskForSubChat) are
    // part of "all invalidates" — they drive ParkAnswerSurface + TaskAcceptBar/TaskControls.
    expect(mockDrivingTaskInvalidate).toHaveBeenCalled();
    expect(mockActionableTaskInvalidate).toHaveBeenCalled();
  });

  // 2. Flow-linked anchor task: setData must be skipped
  it('skips setData but still calls invalidates for a flow-linked task', () => {
    renderQueueProcessor();

    act(() => api.fireSignal({ taskId: 'task-flow', status: 'done', isFlowLinked: true }));

    expect(mockSetData).not.toHaveBeenCalled();
    expect(mockListPaginatedInvalidate).toHaveBeenCalled();
    expect(mockListCountsInvalidate).toHaveBeenCalled();
    expect(mockGetByIdInvalidate).toHaveBeenCalled();
  });

  // 3. Task not in cache → updater receives undefined → no-op
  it('setData updater returns undefined when task is not in cache', () => {
    renderQueueProcessor();

    let updaterResult: unknown = 'sentinel';
    mockSetData.mockImplementation((_id: string, updater: (old: unknown) => unknown) => {
      updaterResult = updater(undefined);
    });

    act(() => api.fireSignal({ taskId: 'task-uncached', status: 'done', isFlowLinked: false }));

    expect(updaterResult).toBeUndefined();
  });

  // 4. Updater preserves all existing fields, merges only status
  it('setData updater merges the new status onto the cached task without clobbering other fields', () => {
    renderQueueProcessor();

    const cachedTask = {
      id: 'task-abc',
      status: 'running' as const,
      title: 'Review PR #42',
      result: { summary: 'in progress' },
      flow_run_id: null,
    };

    let updaterResult: unknown;
    mockSetData.mockImplementation((_id: string, updater: (old: unknown) => unknown) => {
      updaterResult = updater(cachedTask);
    });

    act(() => api.fireSignal({ taskId: 'task-abc', status: 'done', isFlowLinked: false }));

    expect(updaterResult).toMatchObject({
      id: 'task-abc',
      status: 'done',
      title: 'Review PR #42',
      result: { summary: 'in progress' },
    });
  });

  // 5. needs_attention and failed statuses also trigger the optimistic write
  it.each([['needs_attention'], ['failed'], ['completed']])(
    'triggers setData for status "%s" (not just done)',
    (status) => {
      renderQueueProcessor();

      const cachedTask = { id: 'task-1', status: 'running' };
      let captured: unknown;
      mockSetData.mockImplementation((_id: string, updater: (old: unknown) => unknown) => {
        captured = updater(cachedTask);
      });

      act(() => api.fireSignal({ taskId: 'task-1', status, isFlowLinked: false }));

      expect(captured).toMatchObject({ status });
    },
  );

  // 6. Missing handler in desktopApi → no crash
  it('does not throw when desktopApi.onSocketTaskSignalPersisted is absent', () => {
    Object.defineProperty(window, 'desktopApi', {
      configurable: true,
      writable: true,
      // omit onSocketTaskSignalPersisted deliberately
      value: { onSocketExecuteComplete: vi.fn(() => () => {}) },
    });

    expect(() => renderQueueProcessor()).not.toThrow();
    // nothing should have been registered
    expect(mockSetData).not.toHaveBeenCalled();
  });

  // 7. Listener removed on unmount (no stale callbacks / memory leak)
  it('removes the IPC listener on component unmount', () => {
    const { unmount } = renderQueueProcessor();

    unmount();

    // After unmount the callback slot is cleared by the returned cleanup fn
    expect(() => api.fireSignal({ taskId: 'task-1', status: 'done', isFlowLinked: false })).toThrow(
      'Signal callback not registered',
    );
  });

  // 8. Invalid status from IPC must not corrupt cache (regression guard for isValidTaskStatus)
  it('leaves cached task unchanged when IPC status is not a valid TaskStatus; still invalidates', () => {
    renderQueueProcessor();

    const cachedTask = { id: 'task-1', status: 'running' as const, title: 'x' };
    let updaterResult: unknown;

    mockSetData.mockImplementation((_id: string, updater: (old: unknown) => unknown) => {
      updaterResult = updater(cachedTask);
    });

    act(() =>
      api.fireSignal({
        taskId: 'task-1',
        status: 'not_a_valid_task_status',
        isFlowLinked: false,
      }),
    );

    expect(updaterResult).toBe(cachedTask);
    expect(mockListPaginatedInvalidate).toHaveBeenCalled();
    expect(mockListCountsInvalidate).toHaveBeenCalled();
    expect(mockGetByIdInvalidate).toHaveBeenCalled();
  });

  // 9. Rapid sequential signals for the same task: last one wins (setData overwrites)
  it('handles rapid sequential signals for the same task — last status wins', () => {
    renderQueueProcessor();

    const cachedTask = { id: 'task-1', status: 'running' };
    const capturedUpdates: unknown[] = [];

    mockSetData.mockImplementation((_id: string, updater: (old: unknown) => unknown) => {
      capturedUpdates.push(updater(cachedTask));
    });

    act(() => {
      api.fireSignal({ taskId: 'task-1', status: 'needs_attention', isFlowLinked: false });
      api.fireSignal({ taskId: 'task-1', status: 'done', isFlowLinked: false });
    });

    // Both signals trigger a setData call independently
    expect(mockSetData).toHaveBeenCalledTimes(2);
    // The second call reflects the final 'done' status
    expect(capturedUpdates[1]).toMatchObject({ status: 'done' });
  });
});
