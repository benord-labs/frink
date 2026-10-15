// @vitest-environment happy-dom
/* eslint-disable max-lines */
import '@testing-library/jest-dom/vitest';
vi.mock('./QueuePauseControl', () => ({ QueuePauseControl: () => null }));
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeAll, describe, expect, it, type Mock, vi } from 'vitest';
import { useAgentSubChatStore } from '../../agents/stores/sub-chat-store';
import type { ConfirmedRecovery } from '../types';
import { buildFailedRetryRow, reviewedPlanMessages } from './test-fixtures';

const overviewLaneSpy = vi.fn();
const historyTaskListSpy = vi.fn();
const {
  retryTaskMutateMock,
  retryTaskMutationErrorMessageMock,
  overviewCountsMock,
  paginatedLoadingMock,
} = vi.hoisted(() => ({
  retryTaskMutateMock: vi.fn(),
  retryTaskMutationErrorMessageMock: vi.fn<() => string | null>(() => null),
  overviewCountsMock: vi.fn(() => ({ queued: 0, review: 1, running: 0 })),
  paginatedLoadingMock: vi.fn<() => boolean>(() => false),
}));
const {
  getSubChatQueryMock,
  getChatQueryMock,
  toastErrorMock,
  toastSuccessMock,
  setAtomMock,
  prependItemMock,
  createAgentChatMock,
  agentChatHasMock,
  getResolvedAccountFetchMock,
  getResolvedAccountDataMock,
  storeGetMock,
  storeSetMock,
  startExecutionMutateAsyncMock,
  completeTaskMutateMock,
  deleteMutateMock,
  cancelMutateMock,
  deleteMatchingMutateAsyncMock,
  listPaginatedInvalidateMock,
  listCountsInvalidateMock,
  trpcClientTasksListPaginatedQueryMock,
  deleteMutationSuccessValueMock,
  deleteMutationErrorMessageMock,
  workQueueRows,
  overviewOnlyTaskIds,
  paginatedResponseCache,
  overviewRefetchMocks,
} = vi.hoisted(() => {
  const at = (minute: string) => `2026-03-10T00:${minute}:00.000Z`;
  const makeRow = <T extends Record<string, unknown>>(overrides: T) => ({
    description: 'Fallback',
    status: 'pending',
    source: 'manual',
    result: null,
    projectName: null,
    projectId: null,
    linkedChatId: null,
    triggerContext: null,
    ...overrides,
  });
  const makeTriggerContext = (
    timestamp: string,
    config?: Record<string, unknown>,
    subject = 'Subject',
  ) => ({
    source: 'gmail',
    sourceAccountId: 'acc',
    sourceAccountName: 'gmail',
    triggerRuleId: 'rule',
    triggerRuleName: 'Email rule',
    eventType: 'email_received',
    triggeredBy: {},
    timestamp,
    fullContent: { from: 'notify@example.com', subject, snippet: 'Receipt' },
    autoStart: false,
    ...(config ? { _config: config } : {}),
  });
  return {
    getSubChatQueryMock: vi.fn(),
    getChatQueryMock: vi.fn(),
    toastErrorMock: vi.fn(),
    toastSuccessMock: vi.fn(),
    setAtomMock: vi.fn(),
    prependItemMock: vi.fn(),
    createAgentChatMock: vi.fn(),
    agentChatHasMock: vi.fn(() => false),
    getResolvedAccountFetchMock: vi.fn(),
    getResolvedAccountDataMock: vi.fn(() => ({ type: 'claude-code' as const })),
    storeGetMock: vi.fn<(...args: unknown[]) => unknown>(() => 'workqueue'),
    storeSetMock: vi.fn(),
    startExecutionMutateAsyncMock: vi.fn(),
    completeTaskMutateMock: vi.fn(),
    deleteMutateMock: vi.fn(),
    cancelMutateMock: vi.fn(),
    deleteMatchingMutateAsyncMock: vi.fn(),
    listPaginatedInvalidateMock: vi.fn(),
    listCountsInvalidateMock: vi.fn(),
    trpcClientTasksListPaginatedQueryMock: vi.fn(),
    deleteMutationSuccessValueMock: vi.fn(() => ({ success: true })),
    deleteMutationErrorMessageMock: vi.fn<() => string | null>(() => null),
    workQueueRows: [
      makeRow({
        id: 'task-1',
        title: 'Email: No subject',
        status: 'needs_attention',
        source: 'gmail',
        createdAt: at('00'),
        triggerContext: makeTriggerContext(at('00'), { model: 'opus' }, ''),
      }),
      makeRow({
        id: 'task-no-trigger',
        title: 'Manual task',
        description: 'No trigger context',
        status: 'needs_attention',
        createdAt: at('04'),
      }),
      makeRow({
        id: 'task-review-1',
        title: 'Review task',
        description: 'Review this plan',
        status: 'plan_ready',
        result: { chatId: 'chat-review-missing' },
        createdAt: at('05'),
      }),
    ] as Array<Record<string, unknown> & { id: string; createdAt: string; status: string }>,
    overviewOnlyTaskIds: new Set<string>(),
    paginatedResponseCache: new Map<
      string,
      {
        isLoading: boolean;
        isFetching: boolean;
        data: {
          items: unknown[];
          hasMore: boolean;
          nextCursor: { createdAt: string; id: string } | null;
        };
      }
    >(),
    overviewRefetchMocks: {
      attention: vi.fn(async () => undefined),
      running: vi.fn(async () => undefined),
    },
  };
});
let WorkQueueComponent: typeof import('./index').WorkQueue;
const defaultWorkQueueProps = { onRequestClose: vi.fn(), onNavigateToChat: vi.fn() };
function WorkQueue(props: Partial<Parameters<typeof WorkQueueComponent>[0]> = {}) {
  return <WorkQueueComponent {...defaultWorkQueueProps} {...props} />;
}
function renderWorkQueue(props: Partial<Parameters<typeof WorkQueueComponent>[0]> = {}) {
  return render(<WorkQueue {...props} />);
}
vi.mock('jotai', async (importOriginal) => {
  const actual = await importOriginal<typeof import('jotai')>();
  return {
    ...actual,
    useSetAtom: () => setAtomMock,
    useStore: () => ({
      get: (...args: unknown[]) => storeGetMock(...args),
      set: (...args: unknown[]) => storeSetMock(...args) !== false,
    }),
  };
});
vi.mock('../../../lib/utils/platform', () => ({ isMacOS: () => true }));
vi.mock('../../../features/agents/atoms', () => ({
  selectedAgentChatIdAtom: Symbol('selectedAgentChatIdAtom'),
  pendingBuildPlanSubChatIdAtom: Symbol('pendingBuildPlanSubChatIdAtom'),
  chatModeAtomFamily: (chatId: string) => `chatMode:${chatId}`,
  lastSelectedModelIdAtomFamily: (chatId: string) => `lastSelectedModelId:${chatId}`,
}));
vi.mock('../../agents/stores/message-queue-store', () => ({
  useMessageQueueStore: { getState: () => ({ prependItem: prependItemMock }) },
}));
vi.mock('../../agents/lib/create-agent-chat', () => ({ createAgentChat: createAgentChatMock }));
vi.mock('../hooks/use-work-queue-overview-counts', () => ({
  useWorkQueueOverviewCounts: () => overviewCountsMock(),
}));
vi.mock('../../agents/stores/agent-chat-store', () => ({
  agentChatStore: { has: agentChatHasMock },
}));
vi.mock('./EmptyState', () => ({
  EmptyState: () => <div>empty</div>,
}));
vi.mock('./HistoryTaskList', () => ({
  HistoryTaskList: (props: unknown) => {
    historyTaskListSpy(props);
    return null;
  },
}));

vi.mock('./QueueOverview', () => ({
  QueueOverview: (props: {
    attentionTasks: Array<{ status: string }>;
    runningTasks: Array<{ status: string }>;
    taskActions: Record<string, unknown>;
  }) => {
    const observeLane = (laneKey: string, tasks: Array<{ status: string }>) =>
      overviewLaneSpy({ ...props.taskActions, laneKey, tasks });
    observeLane(
      'review',
      props.attentionTasks.filter((task) => task.status === 'plan_ready'),
    );
    observeLane(
      'needs-attention',
      props.attentionTasks.filter(
        (task) => task.status === 'needs_attention' || task.status === 'interrupted',
      ),
    );
    observeLane(
      'failed',
      props.attentionTasks.filter((task) => task.status === 'failed'),
    );
    observeLane(
      'done',
      props.attentionTasks.filter((task) => task.status === 'done'),
    );
    observeLane('running', props.runningTasks);
    return null;
  },
}));

vi.mock('../../../lib/trpc', () => ({
  trpc: {
    useUtils: () => ({
      tasks: {
        listPaginated: { invalidate: listPaginatedInvalidateMock },
        listCounts: { invalidate: listCountsInvalidateMock },
        workQueueOverviewCounts: { invalidate: vi.fn() },
      },
      chats: {
        list: { invalidate: vi.fn() },
        listCounts: { invalidate: vi.fn() },
        listByFolder: { invalidate: vi.fn() },
      },
      claudeCode: {
        getResolvedAccount: {
          fetch: getResolvedAccountFetchMock,
          getData: getResolvedAccountDataMock,
        },
      },
    }),
    tasks: {
      listCounts: {
        useQuery: () => ({
          data: (() => {
            const counts = {
              pending: 0,
              planReady: 0,
              needsAttention: 0,
              running: 0,
              done: 0,
              completed: 0,
              failed: 0,
              cancelled: 0,
              total: workQueueRows.length,
            };
            for (const row of workQueueRows) {
              if (row.status === 'pending') counts.pending += 1;
              if (row.status === 'plan_ready') counts.planReady += 1;
              if (row.status === 'needs_attention') counts.needsAttention += 1;
              if (row.status === 'running') counts.running += 1;
              if (row.status === 'done') counts.done += 1;
              if (row.status === 'completed') counts.completed += 1;
              if (row.status === 'failed') counts.failed += 1;
              if (row.status === 'cancelled') counts.cancelled += 1;
            }
            return counts;
          })(),
        }),
      },
      listPaginated: {
        useQuery: (input?: {
          statuses?: string[];
          workQueueSection?: 'attention' | 'running';
          limit?: number;
          cursor?: { createdAt: string; id: string } | null;
        }) => {
          const allRows = input?.workQueueSection
            ? workQueueRows
            : workQueueRows.filter((row) => !overviewOnlyTaskIds.has(row.id));
          const statuses = input?.statuses ?? [];
          const statusesKey =
            input?.workQueueSection ??
            (statuses.length > 0 ? [...statuses].sort().join(',') : '__all__');
          const cursorKey = input?.cursor ? `${input.cursor.createdAt}:${input.cursor.id}` : 'null';
          const limitKey = typeof input?.limit === 'number' ? String(input.limit) : 'null';
          const key = `${statusesKey}|${cursorKey}|${limitKey}`;
          const cached = paginatedResponseCache.get(key);
          if (cached) return cached;
          const filteredRows = input?.workQueueSection
            ? allRows.filter((row) => {
                const status = String(row.effectiveStatus ?? row.status);
                if (input.workQueueSection === 'attention')
                  return [
                    'plan_ready',
                    'needs_attention',
                    'interrupted',
                    'failed',
                    'done',
                  ].includes(status);
                return status === 'running';
              })
            : statuses.length > 0
              ? allRows.filter((row) => statuses.includes(row.status))
              : allRows;
          const limit =
            typeof input?.limit === 'number' && input.limit > 0 ? input.limit : filteredRows.length;
          const startIndex = input?.cursor
            ? Math.max(
                0,
                filteredRows.findIndex(
                  (row) => row.id === input.cursor?.id && row.createdAt === input.cursor?.createdAt,
                ) + 1,
              )
            : 0;
          const items = filteredRows.slice(startIndex, startIndex + limit);
          const hasMore = startIndex + limit < filteredRows.length;
          const nextCursor =
            hasMore && items.length > 0
              ? {
                  createdAt: items[items.length - 1].createdAt,
                  id: items[items.length - 1].id,
                }
              : null;
          const response = {
            isLoading: paginatedLoadingMock(),
            isFetching: false,
            data: { items, hasMore, nextCursor },
            refetch: input?.workQueueSection
              ? overviewRefetchMocks[input.workQueueSection]
              : vi.fn(async () => undefined),
          };
          paginatedResponseCache.set(key, response);
          return response;
        },
      },
      complete: {
        useMutation: (options?: {
          onSuccess?: (data: unknown, variables: { taskId: string }) => void;
          onError?: (error: Error) => void;
        }) => ({
          mutate: (variables: { taskId: string; result?: Record<string, unknown> }) => {
            completeTaskMutateMock(variables);
            options?.onSuccess?.(undefined, variables);
          },
          isPending: false,
        }),
      },
      fail: { useMutation: () => ({ mutate: vi.fn(), isPending: false }) },
      cancel: {
        useMutation: (options?: { onSuccess?: (result: unknown, taskId: string) => void }) => ({
          mutate: (taskId: string) => {
            cancelMutateMock(taskId);
            options?.onSuccess?.(undefined, taskId);
          },
          isPending: false,
        }),
      },
      delete: {
        useMutation: (options?: {
          onSuccess?: (result: { success: boolean }, taskId: string) => void;
          onError?: (error: Error) => void;
        }) => ({
          mutate: (taskId: string) => {
            deleteMutateMock(taskId);
            const errorMessage = deleteMutationErrorMessageMock();
            if (typeof errorMessage === 'string') {
              options?.onError?.(new Error(errorMessage));
              return;
            }
            options?.onSuccess?.(deleteMutationSuccessValueMock(), taskId);
          },
          isPending: false,
        }),
      },
      startExecution: {
        useMutation: () => ({ mutateAsync: startExecutionMutateAsyncMock, isPending: false }),
      },
      deleteMatching: {
        useMutation: (options?: { onSuccess?: () => void; onError?: (error: Error) => void }) => ({
          mutateAsync: async (input: { statuses: string[] }) => {
            try {
              const result = await deleteMatchingMutateAsyncMock(input);
              options?.onSuccess?.();
              return result;
            } catch (error) {
              options?.onError?.(error as Error);
              throw error;
            }
          },
          isPending: false,
        }),
      },
      recover: {
        useMutation: (options?: {
          onSuccess?: (data: { ok: true }, variables: { taskId: string; kind: string }) => void;
          onError?: (error: Error) => void;
        }) => ({
          mutate: (
            variables: { taskId: string; kind: string },
            mutateOptions?: {
              onSuccess?: (data: { ok: true }, variables: { taskId: string; kind: string }) => void;
              onError?: (error: Error) => void;
            },
          ) => {
            retryTaskMutateMock(variables, mutateOptions);
            const errorMessage = retryTaskMutationErrorMessageMock();
            if (typeof errorMessage === 'string') {
              const error = new Error(errorMessage);
              mutateOptions?.onError?.(error);
              options?.onError?.(error);
              return;
            }
            options?.onSuccess?.({ ok: true }, variables);
            mutateOptions?.onSuccess?.({ ok: true }, variables);
          },
          isPending: false,
        }),
      },
    },
  },
  trpcClient: {
    tasks: {
      listPaginated: { query: trpcClientTasksListPaginatedQueryMock },
    },
    chats: {
      getSubChat: { query: getSubChatQueryMock },
      get: { query: getChatQueryMock },
    },
  },
}));

vi.mock('sonner', () => ({
  toast: {
    error: toastErrorMock,
    success: toastSuccessMock,
    message: vi.fn(),
  },
}));

beforeAll(async () => {
  ({ WorkQueue: WorkQueueComponent } = await import('./index'));
});

afterEach(() => {
  cleanup();
  trpcClientTasksListPaginatedQueryMock.mockReset();
  retryTaskMutateMock.mockReset();
  retryTaskMutationErrorMessageMock.mockReset();
  deleteMatchingMutateAsyncMock.mockReset();
  toastSuccessMock.mockReset();
  paginatedLoadingMock.mockReset();
  paginatedLoadingMock.mockReturnValue(false);
  overviewCountsMock.mockReset();
  overviewCountsMock.mockReturnValue({ queued: 0, review: 1, running: 0 });
  defaultWorkQueueProps.onRequestClose.mockReset();
  defaultWorkQueueProps.onNavigateToChat.mockReset();
  storeGetMock.mockReset();
  storeGetMock.mockReturnValue('workqueue');
  prependItemMock.mockReset();
  createAgentChatMock.mockReset();
  agentChatHasMock.mockReset();
  agentChatHasMock.mockReturnValue(false);
  getResolvedAccountFetchMock.mockReset();
  getResolvedAccountFetchMock.mockResolvedValue(undefined);
  getResolvedAccountDataMock.mockReset();
  getResolvedAccountDataMock.mockReturnValue({ type: 'claude-code' });
  paginatedResponseCache.clear();
  historyTaskListSpy.mockClear();
  overviewOnlyTaskIds.clear();
  Object.values(overviewRefetchMocks).forEach((mock) => {
    mock.mockReset();
  });
});

function makeNotFoundError(): unknown {
  return { data: { code: 'NOT_FOUND' } } as unknown;
}

function expectCalledBefore(first: Mock, second: Mock): void {
  expect(first.mock.invocationCallOrder[0]).toBeLessThan(second.mock.invocationCallOrder[0]);
}
function findOverviewLaneProps<T = Record<string, unknown>>(laneKey: string): T | undefined {
  return [...overviewLaneSpy.mock.calls]
    .reverse()
    .find(([props]) => (props as { laneKey?: string }).laneKey === laneKey)?.[0] as T | undefined;
}
function getOverviewLaneProps<T = Record<string, unknown>>(laneKey: string): T {
  const props = findOverviewLaneProps<T>(laneKey);
  expect(props).toBeDefined();
  return props as T;
}

describe('WorkQueue mapTask trigger context', () => {
  it('keeps queued admissions and completed history out of the empty state', () => {
    const originalRows = workQueueRows.splice(0);
    try {
      overviewCountsMock.mockReturnValue({ queued: 1, review: 0, running: 0 });
      renderWorkQueue();
      expect(screen.queryByText('empty')).not.toBeInTheDocument();

      cleanup();
      paginatedResponseCache.clear();
      overviewCountsMock.mockReturnValue({ queued: 0, review: 0, running: 0 });
      workQueueRows.push({
        ...originalRows[0],
        id: 'history-only',
        status: 'completed',
      });
      renderWorkQueue();
      expect(screen.queryByText('empty')).not.toBeInTheDocument();
    } finally {
      workQueueRows.splice(0);
      workQueueRows.push(...originalRows);
    }
  });

  it('opens a chronological, tab-free History surface with terminal-only bulk delete', async () => {
    deleteMatchingMutateAsyncMock.mockResolvedValue({ deletedCount: 2 });
    const historyRows = [
      {
        ...workQueueRows[0],
        id: 'completed-overview',
        status: 'completed',
        createdAt: '2026-03-12T00:00:00.000Z',
      },
      {
        ...workQueueRows[0],
        id: 'cancelled-overview',
        status: 'cancelled',
        createdAt: '2026-03-12T00:01:00.000Z',
      },
      {
        ...workQueueRows[0],
        id: 'done-overview',
        status: 'done',
        createdAt: '2026-03-12T00:02:00.000Z',
      },
    ];
    paginatedResponseCache.set('cancelled,completed|null|50', {
      isLoading: false,
      isFetching: false,
      data: {
        items: historyRows.slice(0, 2),
        hasMore: true,
        nextCursor: { createdAt: '2026-03-11T00:00:00.000Z', id: 'history-page-1' },
      },
    });
    trpcClientTasksListPaginatedQueryMock.mockResolvedValue({
      items: [{ ...historyRows[0], id: 'completed-older' }],
      nextCursor: null,
    });
    workQueueRows.push(...historyRows);
    try {
      render(<WorkQueue />);
      expect(screen.queryByRole('button', { name: 'Browse all work' })).not.toBeInTheDocument();
      expect(screen.queryByRole('button', { name: 'Clear Inbox' })).not.toBeInTheDocument();
      expect(screen.queryByRole('button', { name: 'Back to overview' })).not.toBeInTheDocument();
      expect(screen.queryByRole('button', { name: 'Delete all' })).not.toBeInTheDocument();
      expect(screen.queryByRole('tab', { name: /Inbox \(/i })).not.toBeInTheDocument();
      fireEvent.click(screen.getByRole('button', { name: 'View task history' }));
      expect(screen.queryByRole('tab')).not.toBeInTheDocument();
      expect(screen.queryByRole('button', { name: 'Accept all' })).not.toBeInTheDocument();
      expect(
        (historyTaskListSpy.mock.lastCall?.[0] as { tasks: Array<{ id: string }> }).tasks.map(
          ({ id }) => id,
        ),
      ).toEqual(['cancelled-overview', 'completed-overview']);
      const historySection = historyTaskListSpy.mock.lastCall?.[0] as {
        canLoadMore: boolean;
        onLoadMore: () => Promise<void>;
      };
      expect(historySection.canLoadMore).toBe(true);
      await waitFor(() => expect(trpcClientTasksListPaginatedQueryMock).toHaveBeenCalledTimes(1));
      await act(historySection.onLoadMore);
      const finalHistorySection = historyTaskListSpy.mock.lastCall?.[0] as {
        canLoadMore: boolean;
        onLoadMore: () => Promise<void>;
      };
      expect(finalHistorySection.canLoadMore).toBe(false);
      await act(finalHistorySection.onLoadMore);
      expect(trpcClientTasksListPaginatedQueryMock).toHaveBeenCalledTimes(1);
      fireEvent.click(screen.getByRole('button', { name: 'Delete all' }));
      fireEvent.click(
        within(screen.getByRole('alertdialog')).getByRole('button', { name: 'Delete all' }),
      );
      await waitFor(() =>
        expect(deleteMatchingMutateAsyncMock).toHaveBeenCalledWith({
          statuses: ['completed', 'cancelled'],
        }),
      );

      fireEvent.click(screen.getByRole('button', { name: 'Back to overview' }));
      expect(screen.getByRole('button', { name: 'View task history' })).toHaveFocus();
    } finally {
      workQueueRows.splice(-historyRows.length, historyRows.length);
    }
  });

  it('passes trigger context objects to Overview lanes', () => {
    overviewLaneSpy.mockClear();
    renderWorkQueue();
    const attentionProps = getOverviewLaneProps<{
      tasks?: Array<{ triggerContext?: { source?: string } | null }>;
    }>('needs-attention');
    expect(attentionProps.tasks?.[0]?.triggerContext?.source).toBe('gmail');
    expect(screen.getByRole('banner')).toHaveClass(
      'drag-region',
      'flex-wrap',
      '[--open-sidebar-button-position:fixed]',
    );
    expect(screen.getByRole('banner')).toHaveClass('max-[599px]:pt-7');
    expect(screen.getByRole('banner')).not.toHaveClass('pt-7', 'pt-3', 'min-[600px]:pt-2');
    expect(screen.getByRole('banner')).not.toHaveClass('min-[400px]:max-[599px]:pl-20');
    expect(screen.getByRole('button', { name: 'Close Work Queue' }).parentElement).toHaveClass(
      'no-drag',
    );
  });
  it('announces its loading state', () => {
    paginatedLoadingMock.mockReturnValue(true);
    paginatedResponseCache.clear();
    renderWorkQueue();
    expect(screen.getByRole('status').outerHTML).toMatch(
      /aria-live="polite"[\s\S]*motion-reduce:animate-none/,
    );
  });
  it('renders a supplied sidebar trigger in the header', () => {
    renderWorkQueue({ sidebarTrigger: <div data-testid="sidebar-trigger-stub" /> });
    expect(screen.getByTestId('sidebar-trigger-stub')).toBeInTheDocument();
    expect(screen.getByRole('banner')).toHaveClass('pt-3', 'min-[600px]:pt-2');
    expect(screen.getByRole('banner')).not.toHaveClass('max-[599px]:pt-7');
  });
  it('gates stale task outcomes by live navigation ownership', async () => {
    overviewLaneSpy.mockClear();
    const onNavigateToChat = vi.fn();
    getChatQueryMock.mockResolvedValue({ id: 'chat-1', subChats: [{ id: 'subchat-1' }] });
    getSubChatQueryMock.mockResolvedValue({ id: 'subchat-1', messages: [] });
    const view = renderWorkQueue({ onNavigateToChat });
    const attentionProps = getOverviewLaneProps<{
      tasks: Array<Record<string, unknown>>;
      onOpenChat: (task: unknown, chatId: string) => Promise<void>;
    }>('needs-attention');
    // Open chat only navigates, even into an empty sub-chat: there is no write to send.
    await attentionProps.onOpenChat(attentionProps.tasks[0], 'chat-1');
    expect(onNavigateToChat).toHaveBeenCalledWith('chat-1');
    expect(useAgentSubChatStore.getState().activeSubChatId).toBe('subchat-1');
    expect(defaultWorkQueueProps.onRequestClose).not.toHaveBeenCalled();
    let resolveLookup: (chat: unknown) => void = () => undefined;
    getChatQueryMock.mockReturnValueOnce(new Promise((resolve) => (resolveLookup = resolve)));
    const staleOpen = attentionProps.onOpenChat(attentionProps.tasks[0], 'chat-stale');
    view.unmount();
    overviewLaneSpy.mockClear();
    const freshView = renderWorkQueue({ onNavigateToChat });
    const freshAttentionProps = getOverviewLaneProps<typeof attentionProps>('needs-attention');
    await freshAttentionProps.onOpenChat(freshAttentionProps.tasks[0], 'chat-stale');
    const stateAfterFreshOpen = useAgentSubChatStore.getState();
    resolveLookup({ id: 'chat-stale', subChats: [{ id: 'subchat-stale' }] });
    await staleOpen;
    expect(onNavigateToChat).toHaveBeenCalledTimes(2);
    expect(useAgentSubChatStore.getState()).toEqual(stateAfterFreshOpen);
    freshView.unmount();
    renderWorkQueue({ onNavigateToChat });
    const subChatStateBeforeExecution = useAgentSubChatStore.getState();
    onNavigateToChat.mockClear();
    setAtomMock.mockReset();
    toastErrorMock.mockReset();
    startExecutionMutateAsyncMock.mockReset();
    getChatQueryMock.mockResolvedValue({ id: 'chat-review-missing' });
    getSubChatQueryMock.mockResolvedValue({
      id: 'subchat-review',
      messages: reviewedPlanMessages(),
    });
    storeSetMock.mockReset();
    const reviewProps = getOverviewLaneProps<{
      onStartExecution: (taskId: string) => Promise<void>;
    }>('review');
    let resolveStartExecution: (task: unknown) => void = () => undefined;
    startExecutionMutateAsyncMock.mockReturnValueOnce(
      new Promise((resolve) => (resolveStartExecution = resolve)),
    );
    const ownershipLostDuringCas = reviewProps.onStartExecution('task-review-1');
    await waitFor(() => expect(startExecutionMutateAsyncMock).toHaveBeenCalledTimes(1));
    storeSetMock.mockReturnValueOnce(false);
    resolveStartExecution({ result: { subChatId: 'subchat-from-mutation' } });
    await ownershipLostDuringCas;
    expect(onNavigateToChat).not.toHaveBeenCalled();
    expect(setAtomMock).not.toHaveBeenCalled();
    expect(prependItemMock).toHaveBeenCalledTimes(1);
    expect(prependItemMock).toHaveBeenCalledWith(
      'subchat-review',
      expect.objectContaining({
        message: 'Implement the approved plan from the approved_plan context.',
        approvedPlanContext: expect.objectContaining({ planId: 'plan-review' }),
      }),
    );
    expect(createAgentChatMock).toHaveBeenCalledWith(
      expect.objectContaining({
        chatId: 'chat-review-missing',
        subChatId: 'subchat-review',
        mode: 'agent',
        initialMessages: reviewedPlanMessages(),
      }),
    );
    expect(getResolvedAccountFetchMock).toHaveBeenCalledWith({ chatId: 'chat-review-missing' });
    expectCalledBefore(prependItemMock, createAgentChatMock);
    expectCalledBefore(createAgentChatMock, getResolvedAccountFetchMock);
    expect(useAgentSubChatStore.getState()).toEqual(subChatStateBeforeExecution);
  });
  it('shows error toast and blocks navigation when linked chat is missing', async () => {
    overviewLaneSpy.mockClear();
    getSubChatQueryMock.mockReset();
    getChatQueryMock.mockReset();
    toastErrorMock.mockReset();
    getChatQueryMock.mockRejectedValue(makeNotFoundError());
    renderWorkQueue();
    const attentionProps = getOverviewLaneProps<{
      tasks: Array<Record<string, unknown>>;
      onOpenChat: (task: unknown, chatId: string) => Promise<void>;
    }>('needs-attention');
    await attentionProps.onOpenChat(attentionProps.tasks[0], 'chat-missing');
    expect(getSubChatQueryMock).not.toHaveBeenCalled();
    expect(toastErrorMock).toHaveBeenCalledWith(
      'This chat was deleted',
      expect.objectContaining({
        description:
          'This is a leftover from a previous deletion. You can safely remove this task.',
      }),
    );
  });
  it('blocks start execution when review chat is deleted', async () => {
    overviewLaneSpy.mockClear();
    getChatQueryMock.mockReset();
    toastErrorMock.mockReset();
    startExecutionMutateAsyncMock.mockReset();
    getChatQueryMock.mockRejectedValue(makeNotFoundError());
    renderWorkQueue();
    const reviewProps = getOverviewLaneProps<{
      onStartExecution: (taskId: string) => Promise<void>;
    }>('review');
    await reviewProps.onStartExecution('task-review-1');
    expect(startExecutionMutateAsyncMock).not.toHaveBeenCalled();
    expect(toastErrorMock).toHaveBeenCalledWith(
      'This chat was deleted',
      expect.objectContaining({
        description:
          'This is a leftover from a previous deletion. You can safely remove this task.',
      }),
    );
  });
  it('shows a generic verification error for non-not-found chat lookup failures', async () => {
    overviewLaneSpy.mockClear();
    getSubChatQueryMock.mockReset();
    getChatQueryMock.mockReset();
    toastErrorMock.mockReset();
    setAtomMock.mockReset();
    getChatQueryMock.mockRejectedValue(new Error('network down'));
    renderWorkQueue();
    const attentionProps = getOverviewLaneProps<{
      tasks: Array<Record<string, unknown>>;
      onOpenChat: (task: unknown, chatId: string) => Promise<void>;
    }>('needs-attention');
    await attentionProps.onOpenChat(attentionProps.tasks[0], 'chat-network-error');
    expect(getSubChatQueryMock).not.toHaveBeenCalled();
    expect(toastErrorMock).toHaveBeenCalledWith(
      "Couldn't verify this chat right now",
      expect.objectContaining({
        description: 'Please try again in a moment.',
      }),
    );
    expect(toastErrorMock).not.toHaveBeenCalledWith('This chat was deleted', expect.any(Object));
    expect(setAtomMock).not.toHaveBeenCalledWith('chat-network-error');
  });
  it('shows toast when delete returns success=false', () => {
    overviewLaneSpy.mockClear();
    toastErrorMock.mockReset();
    deleteMutateMock.mockReset();
    deleteMutationErrorMessageMock.mockReturnValue(null);
    deleteMutationSuccessValueMock.mockReturnValue({ success: false });
    renderWorkQueue();
    const attentionProps = getOverviewLaneProps<{ onDelete: (taskId: string) => void }>(
      'needs-attention',
    );
    attentionProps.onDelete('task-1');
    expect(deleteMutateMock).toHaveBeenCalledWith('task-1');
    expect(toastErrorMock).toHaveBeenCalledWith(
      'Could not delete task',
      expect.objectContaining({
        description:
          'Only pending, plan-ready, done, completed, cancelled, or failed tasks can be deleted.',
      }),
    );
  });
  it('refreshes the canonical Overview lanes when delete succeeds', () => {
    overviewLaneSpy.mockClear();
    deleteMutateMock.mockReset();
    listCountsInvalidateMock.mockReset();
    deleteMutationErrorMessageMock.mockReturnValue(null);
    deleteMutationSuccessValueMock.mockReturnValue({ success: true });
    renderWorkQueue();
    const attentionProps = getOverviewLaneProps<{ onDelete: (taskId: string) => void }>(
      'needs-attention',
    );
    attentionProps.onDelete('task-1');
    expect(deleteMutateMock).toHaveBeenCalledWith('task-1');
    expect(overviewRefetchMocks.attention).toHaveBeenCalledTimes(1);
    expect(overviewRefetchMocks.running).toHaveBeenCalledTimes(1);
    expect(listCountsInvalidateMock).toHaveBeenCalledTimes(1);
  });
  it('shows toast when delete mutation errors', () => {
    overviewLaneSpy.mockClear();
    toastErrorMock.mockReset();
    deleteMutateMock.mockReset();
    deleteMutationSuccessValueMock.mockReturnValue({ success: true });
    deleteMutationErrorMessageMock.mockReturnValue('backend exploded');
    renderWorkQueue();
    const attentionProps = getOverviewLaneProps<{ onDelete: (taskId: string) => void }>(
      'needs-attention',
    );
    attentionProps.onDelete('task-1');
    expect(deleteMutateMock).toHaveBeenCalledWith('task-1');
    expect(toastErrorMock).toHaveBeenCalledWith(
      'Could not delete task',
      expect.objectContaining({ description: 'backend exploded' }),
    );
  });
  it('exposes attention task actions through Overview lanes', () => {
    overviewLaneSpy.mockClear();
    renderWorkQueue();

    expect(
      getOverviewLaneProps<{ tasks: Array<{ id: string }> }>('needs-attention').tasks.map(
        (task) => task.id,
      ),
    ).toContain('task-1');
    expect(
      getOverviewLaneProps<{ tasks: Array<{ id: string }> }>('review').tasks.map((task) => task.id),
    ).toEqual(['task-review-1']);
    expect(getOverviewLaneProps<{ tasks: unknown[] }>('running').tasks).toEqual([]);
    expect(screen.queryByRole('tab')).not.toBeInTheDocument();
  });
  it.each([
    ['a standalone', null, 'continue'],
    ['a Flow-linked', 'run-1', 'retry'],
  ] as const)(
    "recovers %s failed Overview task with the row's recovery kind",
    (_, flowRunId, kind) => {
      overviewLaneSpy.mockClear();
      retryTaskMutateMock.mockReset();
      const failedRow = {
        ...buildFailedRetryRow('task-failed-retry', '2026-03-10T01:20:00.000Z'),
        flowRunId,
        recoveryKind: kind,
      };
      workQueueRows.push(failedRow);
      try {
        renderWorkQueue();
        const failedProps = getOverviewLaneProps<{
          onRetryTask: (taskId: string) => void;
        }>('failed');
        failedProps.onRetryTask('task-failed-retry');
        expect(retryTaskMutateMock).toHaveBeenCalledWith(
          expect.objectContaining({ taskId: 'task-failed-retry', kind }),
          expect.objectContaining({
            onError: expect.any(Function),
          }),
        );
      } finally {
        workQueueRows.pop();
      }
    },
  );
  it('keeps Overview rows deduplicated while repeated retries await refetch', () => {
    overviewLaneSpy.mockClear();
    const failedRow = buildFailedRetryRow(
      'task-failed-retry-spam',
      '2026-03-10T01:21:00.000Z',
      'Retry spam',
    );
    workQueueRows.push(failedRow);
    try {
      renderWorkQueue();
      const failedProps = getOverviewLaneProps<{
        onRetryTask: (taskId: string) => void;
      }>('failed');
      failedProps.onRetryTask('task-failed-retry-spam');
      failedProps.onRetryTask('task-failed-retry-spam');
      const attentionProps = getOverviewLaneProps<{
        tasks: Array<{ id: string; status: string }>;
      }>('needs-attention');
      const copies = attentionProps.tasks.filter((task) => task.id === 'task-1');
      expect(copies).toHaveLength(1);
      expect(copies[0]?.status).toBe('needs_attention');
      expect(retryTaskMutateMock).toHaveBeenCalledTimes(2);
    } finally {
      workQueueRows.pop();
    }
  });
  it('refreshes queue when optimistic retry fails', () => {
    overviewLaneSpy.mockClear();
    retryTaskMutateMock.mockReset();
    retryTaskMutationErrorMessageMock.mockReturnValue('network failed');
    listCountsInvalidateMock.mockReset();
    toastErrorMock.mockReset();
    const failedRow = buildFailedRetryRow(
      'task-failed-retry-error',
      '2026-03-10T01:22:00.000Z',
      'Retry error',
    );
    workQueueRows.push(failedRow);
    try {
      renderWorkQueue();
      const failedProps = getOverviewLaneProps<{
        onRetryTask: (taskId: string) => void;
      }>('failed');
      failedProps.onRetryTask('task-failed-retry-error');
      expect(retryTaskMutateMock).toHaveBeenCalledWith(
        expect.objectContaining({ taskId: 'task-failed-retry-error', kind: 'continue' }),
        expect.objectContaining({ onError: expect.any(Function) }),
      );
      expect(toastErrorMock).toHaveBeenCalledWith(
        'Could not continue task',
        expect.objectContaining({ description: 'network failed' }),
      );
      expect(overviewRefetchMocks.attention).toHaveBeenCalledTimes(1);
      expect(overviewRefetchMocks.running).toHaveBeenCalledTimes(1);
      expect(listCountsInvalidateMock).toHaveBeenCalledTimes(1);
    } finally {
      workQueueRows.pop();
    }
  });
  it('handles rapid repeated delete actions for the same task', () => {
    overviewLaneSpy.mockClear();
    deleteMutateMock.mockReset();
    deleteMutationErrorMessageMock.mockReturnValue(null);
    deleteMutationSuccessValueMock.mockReturnValue({ success: true });
    renderWorkQueue();
    const attentionProps = getOverviewLaneProps<{ onDelete: (taskId: string) => void }>(
      'needs-attention',
    );
    attentionProps.onDelete('task-1');
    attentionProps.onDelete('task-1');
    expect(deleteMutateMock).toHaveBeenCalledTimes(2);
    expect(deleteMutateMock).toHaveBeenNthCalledWith(1, 'task-1');
    expect(deleteMutateMock).toHaveBeenNthCalledWith(2, 'task-1');
  });
  it('supports out-of-order status intents on the same task', () => {
    overviewLaneSpy.mockClear();
    cancelMutateMock.mockReset();
    const needsAttentionTask = {
      id: 'task-needs-attention-order',
      title: 'Needs attention ordering',
      description: 'Race between complete and cancel',
      status: 'needs_attention' as const,
      source: 'manual',
      result: { chatId: 'chat-order', subChatId: 'sub-order', startMode: 'execute' as const },
      createdAt: '2026-03-10T01:10:00.000Z',
      projectName: null,
      projectId: null,
      linkedChatId: null,
      triggerContext: null,
    };
    workQueueRows.push(needsAttentionTask);
    try {
      renderWorkQueue();
      const needsAttentionProps = getOverviewLaneProps<{
        onMarkComplete: (taskId: string) => void;
        onCancel: (taskId: string) => void;
      }>('needs-attention');
      needsAttentionProps.onMarkComplete('task-needs-attention-order');
      needsAttentionProps.onCancel('task-needs-attention-order');
      expect(completeTaskMutateMock).toHaveBeenCalledWith(
        expect.objectContaining({ taskId: 'task-needs-attention-order' }),
      );
      expect(cancelMutateMock).toHaveBeenCalledWith('task-needs-attention-order');
      expect(overviewRefetchMocks.attention).toHaveBeenCalledTimes(2);
      expect(overviewRefetchMocks.running).toHaveBeenCalledTimes(2);
    } finally {
      workQueueRows.pop();
    }
  });
  it('folds an interrupted run into the Needs Attention section', () => {
    overviewLaneSpy.mockClear();
    const interruptedRow = {
      id: 'task-interrupted-fold',
      title: 'Interrupted flow',
      description: 'Restart-interrupted, resumable',
      status: 'interrupted' as const,
      source: 'flow',
      result: { chatId: 'chat-int', subChatId: 'sub-int', startMode: 'execute' as const },
      createdAt: '2026-03-10T02:00:00.000Z',
      projectName: null,
      projectId: null,
      linkedChatId: null,
      triggerContext: null,
    };
    workQueueRows.push(interruptedRow);
    try {
      renderWorkQueue();
      const needsAttention = getOverviewLaneProps<{ tasks: { id: string }[] }>('needs-attention');
      expect(needsAttention.tasks.some((t) => t.id === 'task-interrupted-fold')).toBe(true);
      expect(findOverviewLaneProps('interrupted')).toBeUndefined();
    } finally {
      workQueueRows.pop();
    }
  });
  // Its raw row is an earlier `done` step, which the failed-task retry check would refuse.
  it.each([
    ['an interrupted run', 'interrupted', 'needs-attention'],
    ['a run failed on a later non-agent step', 'failed', 'failed'],
  ] as const)(
    "recovers %s with its row's kind, skipping the failed-task check",
    (_, status, key) => {
      overviewLaneSpy.mockClear();
      retryTaskMutateMock.mockReset();
      toastErrorMock.mockReset();
      workQueueRows.push({
        ...buildFailedRetryRow('task-interrupted-recover', '2026-03-10T02:01:00.000Z'),
        status: 'done' as const,
        effectiveStatus: status,
        flowRunId: 'run-int',
        recoveryKind: 'retry' as const,
        confirmSideEffects: true,
      });
      try {
        renderWorkQueue();
        const lane = getOverviewLaneProps<{
          tasks: Array<{ id: string; confirmSideEffects?: boolean }>;
          onRetryTask: (taskId: string) => void;
        }>(key);
        // The row menu reads this flag to confirm before a Retry that may repeat side effects.
        expect(
          lane.tasks.find((t) => t.id === 'task-interrupted-recover')?.confirmSideEffects,
        ).toBe(true);
        lane.onRetryTask('task-interrupted-recover');
        expect(toastErrorMock).not.toHaveBeenCalled();
        expect(retryTaskMutateMock).toHaveBeenCalledWith(
          { taskId: 'task-interrupted-recover', kind: 'retry' },
          expect.objectContaining({ onError: expect.any(Function) }),
        );
      } finally {
        workQueueRows.pop();
      }
    },
  );
  // The server refuses a confirmed Retry once the row's step is no longer the one confirmed.
  it('sends a confirmed Retry pinned to the step its dialog showed', () => {
    overviewLaneSpy.mockClear();
    retryTaskMutateMock.mockReset();
    workQueueRows.push({
      ...buildFailedRetryRow('task-confirmed', '2026-03-10T02:02:00.000Z'),
      flowRunId: 'run-confirmed',
      recoveryKind: 'retry' as const,
      confirmSideEffects: true,
      recoveryNodeRunId: 'nr-newer',
    });
    try {
      renderWorkQueue();
      const lane = getOverviewLaneProps<{
        onRetryTask: (taskId: string, confirmed: ConfirmedRecovery) => void;
      }>('failed');
      lane.onRetryTask('task-confirmed', { kind: 'retry', recoveryNodeRunId: 'nr-shown' });
      expect(retryTaskMutateMock).toHaveBeenCalledWith(
        { taskId: 'task-confirmed', kind: 'retry', recoveryNodeRunId: 'nr-shown' },
        expect.objectContaining({ onError: expect.any(Function) }),
      );
    } finally {
      workQueueRows.pop();
    }
  });
  it('preserves existing result fields when marking complete; Cancel sends only the id', () => {
    overviewLaneSpy.mockClear();
    cancelMutateMock.mockReset();
    const needsAttentionTask = {
      id: 'task-needs-attention-1',
      title: 'Needs attention',
      description: 'Awaiting signal',
      status: 'needs_attention' as const,
      source: 'manual',
      result: { chatId: 'chat-1', subChatId: 'sub-1', startMode: 'execute' as const },
      createdAt: '2026-03-10T01:00:00.000Z',
      projectName: null,
      projectId: null,
      linkedChatId: null,
      triggerContext: null,
    };
    workQueueRows.push(needsAttentionTask);
    try {
      renderWorkQueue();
      const needsAttentionProps = getOverviewLaneProps<{
        onMarkComplete: (taskId: string) => void;
        onCancel: (taskId: string) => void;
      }>('needs-attention');

      needsAttentionProps.onMarkComplete('task-needs-attention-1');
      needsAttentionProps.onCancel('task-needs-attention-1');

      expect(completeTaskMutateMock).toHaveBeenCalledWith(
        expect.objectContaining({
          taskId: 'task-needs-attention-1',
          result: expect.objectContaining({
            chatId: 'chat-1',
            subChatId: 'sub-1',
            startMode: 'execute',
            summary: 'Marked complete from work queue',
          }),
        }),
      );

      expect(cancelMutateMock).toHaveBeenCalledWith('task-needs-attention-1');
      expect(overviewRefetchMocks.attention).toHaveBeenCalledTimes(2);
      expect(overviewRefetchMocks.running).toHaveBeenCalledTimes(2);
    } finally {
      workQueueRows.pop();
    }
  });
});
