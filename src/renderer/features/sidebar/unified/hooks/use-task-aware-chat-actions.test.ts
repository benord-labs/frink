// @vitest-environment happy-dom
import { renderHook } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { useTaskAwareChatActions } from './use-task-aware-chat-actions';

const { cancelMutate, getChatQuery, getTaskByIdQuery, setManuallyAborted } = vi.hoisted(() => ({
  cancelMutate: vi.fn(),
  getChatQuery: vi.fn(),
  getTaskByIdQuery: vi.fn(),
  setManuallyAborted: vi.fn(),
}));

vi.mock('../../../../lib/trpc', () => ({
  trpcClient: {
    chats: {
      get: {
        query: getChatQuery,
      },
    },
    tasks: {
      getById: {
        query: getTaskByIdQuery,
      },
      cancel: {
        mutate: cancelMutate,
      },
    },
  },
}));

vi.mock('../../../agents/stores/agent-chat-store', () => ({
  agentChatStore: {
    setManuallyAborted,
  },
}));

describe('useTaskAwareChatActions', () => {
  beforeEach(() => {
    cancelMutate.mockReset();
    getChatQuery.mockReset();
    getTaskByIdQuery.mockReset();
    setManuallyAborted.mockReset();
    vi.restoreAllMocks();
  });

  it('resolves active linked tasks by linkedChatId and chat.taskId fallback', () => {
    const { result } = renderHook(() =>
      useTaskAwareChatActions({
        activeTasks: [
          { id: 'task-1', status: 'running', linkedChatId: 'chat-1' },
          { id: 'task-2', status: 'plan_ready', linkedChatId: null },
        ],
        chats: [
          { id: 'chat-1', taskId: 'task-1' },
          { id: 'chat-2', taskId: 'task-2' },
          { id: 'chat-3', taskId: 'task-3' },
        ],
        invalidateTasks: vi.fn(async () => undefined),
      }),
    );

    const resolved = result.current.getActiveLinkedTasksForChatIds(['chat-1', 'chat-2', 'chat-3']);

    expect(resolved.activeTasks).toEqual([
      { taskId: 'task-1', chatId: 'chat-1' },
      { taskId: 'task-2', chatId: 'chat-2' },
    ]);
    expect(resolved.unresolvedTaskLinks).toBe(1);
  });

  it('cancels deduped task ids and returns failed count', async () => {
    const invalidateTasks = vi.fn(async () => undefined);
    cancelMutate.mockImplementation(async (taskId: string) => {
      if (taskId === 'task-bad') throw new Error('boom');
      return { id: taskId };
    });

    const { result } = renderHook(() =>
      useTaskAwareChatActions({
        activeTasks: [],
        chats: [],
        invalidateTasks,
      }),
    );

    const outcome = await result.current.cancelTasksBestEffort(['task-ok', 'task-bad', 'task-ok']);

    expect(cancelMutate).toHaveBeenCalledTimes(2);
    expect(invalidateTasks).toHaveBeenCalledTimes(1);
    expect(outcome.failed).toBe(1);
  });

  it('resolves unresolved chat task link via getById fallback', async () => {
    getTaskByIdQuery.mockResolvedValue({ id: 'task-3', status: 'running' });

    const { result } = renderHook(() =>
      useTaskAwareChatActions({
        activeTasks: [],
        chats: [{ id: 'chat-3', taskId: 'task-3' }],
        invalidateTasks: vi.fn(async () => undefined),
      }),
    );

    const resolved = await result.current.getActiveLinkedTasksForChatIdsWithFallback(['chat-3']);

    expect(getTaskByIdQuery).toHaveBeenCalledWith('task-3');
    expect(resolved.activeTasks).toEqual([{ taskId: 'task-3', chatId: 'chat-3' }]);
    expect(resolved.unresolvedTaskLinks).toBe(0);
  });

  it('short-circuits fallback when base resolution already succeeds', async () => {
    const { result } = renderHook(() =>
      useTaskAwareChatActions({
        activeTasks: [{ id: 'task-1', status: 'running', linkedChatId: 'chat-1' }],
        chats: [{ id: 'chat-1', taskId: 'task-1' }],
        invalidateTasks: vi.fn(async () => undefined),
      }),
    );

    const resolved = await result.current.getActiveLinkedTasksForChatIdsWithFallback(['chat-1']);

    expect(getTaskByIdQuery).not.toHaveBeenCalled();
    expect(resolved.activeTasks).toEqual([{ taskId: 'task-1', chatId: 'chat-1' }]);
    expect(resolved.unresolvedTaskLinks).toBe(0);
  });

  it('keeps unresolved links when getById fallback fails', async () => {
    getTaskByIdQuery.mockRejectedValue(new Error('timeout'));

    const { result } = renderHook(() =>
      useTaskAwareChatActions({
        activeTasks: [],
        chats: [{ id: 'chat-3', taskId: 'task-3' }],
        invalidateTasks: vi.fn(async () => undefined),
      }),
    );

    const resolved = await result.current.getActiveLinkedTasksForChatIdsWithFallback(['chat-3']);

    expect(getTaskByIdQuery).toHaveBeenCalledWith('task-3');
    expect(resolved.activeTasks).toEqual([]);
    expect(resolved.unresolvedTaskLinks).toBe(1);
  });

  it('does not promote inactive fallback task status to active link', async () => {
    getTaskByIdQuery.mockResolvedValue({ id: 'task-3', status: 'completed' });

    const { result } = renderHook(() =>
      useTaskAwareChatActions({
        activeTasks: [],
        chats: [{ id: 'chat-3', taskId: 'task-3' }],
        invalidateTasks: vi.fn(async () => undefined),
      }),
    );

    const resolved = await result.current.getActiveLinkedTasksForChatIdsWithFallback(['chat-3']);

    expect(getTaskByIdQuery).toHaveBeenCalledWith('task-3');
    expect(resolved.activeTasks).toEqual([]);
    expect(resolved.unresolvedTaskLinks).toBe(0);
  });

  it('treats null getById fallback result as non-active without unresolved increment', async () => {
    getTaskByIdQuery.mockResolvedValue(null);

    const { result } = renderHook(() =>
      useTaskAwareChatActions({
        activeTasks: [],
        chats: [{ id: 'chat-3', taskId: 'task-3' }],
        invalidateTasks: vi.fn(async () => undefined),
      }),
    );

    const resolved = await result.current.getActiveLinkedTasksForChatIdsWithFallback(['chat-3']);

    expect(getTaskByIdQuery).toHaveBeenCalledWith('task-3');
    expect(resolved.activeTasks).toEqual([]);
    expect(resolved.unresolvedTaskLinks).toBe(0);
  });

  it('dedupes fallback getById calls for shared task id across chats', async () => {
    getTaskByIdQuery.mockResolvedValue({ id: 'task-shared', status: 'running' });

    const { result } = renderHook(() =>
      useTaskAwareChatActions({
        activeTasks: [],
        chats: [
          { id: 'chat-1', taskId: 'task-shared' },
          { id: 'chat-2', taskId: 'task-shared' },
        ],
        invalidateTasks: vi.fn(async () => undefined),
      }),
    );

    const resolved = await result.current.getActiveLinkedTasksForChatIdsWithFallback([
      'chat-1',
      'chat-2',
    ]);

    expect(getTaskByIdQuery).toHaveBeenCalledTimes(1);
    expect(getTaskByIdQuery).toHaveBeenCalledWith('task-shared');
    expect(resolved.activeTasks).toEqual([
      { taskId: 'task-shared', chatId: 'chat-1' },
      { taskId: 'task-shared', chatId: 'chat-2' },
    ]);
    expect(resolved.unresolvedTaskLinks).toBe(0);
  });

  it('skips fallback lookups when unresolved task ids exceed safety cap', async () => {
    const chats = Array.from({ length: 26 }, (_, index) => ({
      id: `chat-${index + 1}`,
      taskId: `task-${index + 1}`,
    }));
    const chatIds = chats.map((chat) => chat.id);

    const { result } = renderHook(() =>
      useTaskAwareChatActions({
        activeTasks: [],
        chats,
        invalidateTasks: vi.fn(async () => undefined),
      }),
    );

    const resolved = await result.current.getActiveLinkedTasksForChatIdsWithFallback(chatIds);

    expect(getTaskByIdQuery).not.toHaveBeenCalled();
    expect(resolved.activeTasks).toEqual([]);
    expect(resolved.unresolvedTaskLinks).toBe(26);
  });

  it('handles concurrent fallback resolutions for the same chat ids', async () => {
    getTaskByIdQuery.mockImplementation(
      () =>
        new Promise((resolve) =>
          setTimeout(() => resolve({ id: 'task-shared', status: 'running' }), 5),
        ),
    );

    const { result } = renderHook(() =>
      useTaskAwareChatActions({
        activeTasks: [],
        chats: [{ id: 'chat-1', taskId: 'task-shared' }],
        invalidateTasks: vi.fn(async () => undefined),
      }),
    );

    const [first, second] = await Promise.all([
      result.current.getActiveLinkedTasksForChatIdsWithFallback(['chat-1']),
      result.current.getActiveLinkedTasksForChatIdsWithFallback(['chat-1']),
    ]);

    expect(getTaskByIdQuery).toHaveBeenCalledTimes(2);
    expect(first).toEqual({
      activeTasks: [{ taskId: 'task-shared', chatId: 'chat-1' }],
      unresolvedTaskLinks: 0,
    });
    expect(second).toEqual({
      activeTasks: [{ taskId: 'task-shared', chatId: 'chat-1' }],
      unresolvedTaskLinks: 0,
    });
  });

  it('aborts all subchat streams best-effort', async () => {
    getChatQuery.mockImplementation(async ({ id }: { id: string }) => {
      if (id === 'chat-1') {
        return { subChats: [{ id: 'sub-1' }, { id: 'sub-2' }] };
      }
      return { subChats: [] };
    });

    const { result } = renderHook(() =>
      useTaskAwareChatActions({
        activeTasks: [],
        chats: [],
        invalidateTasks: vi.fn(async () => undefined),
      }),
    );

    await result.current.abortTaskChatStreamsBestEffort(['chat-1', 'chat-2']);

    expect(setManuallyAborted).toHaveBeenCalledTimes(2);
    expect(setManuallyAborted).toHaveBeenCalledWith('sub-1', true);
    expect(setManuallyAborted).toHaveBeenCalledWith('sub-2', true);
  });

  it('does not treat non-active statuses as task-aware blockers', () => {
    const { result } = renderHook(() =>
      useTaskAwareChatActions({
        activeTasks: [
          { id: 'task-1', status: 'failed', linkedChatId: 'chat-1' },
          { id: 'task-2', status: 'needs_attention', linkedChatId: 'chat-2' },
        ],
        chats: [
          { id: 'chat-1', taskId: 'task-1' },
          { id: 'chat-2', taskId: 'task-2' },
        ],
        invalidateTasks: vi.fn(async () => undefined),
      }),
    );

    const resolved = result.current.getActiveLinkedTasksForChatIds(['chat-1', 'chat-2']);
    expect(resolved.activeTasks).toEqual([]);
    // Both are present in the snapshot with a known, non-stoppable status — resolved as "nothing to
    // stop", NOT unresolved (an unresolved count would needlessly trigger a getById fallback).
    expect(resolved.unresolvedTaskLinks).toBe(0);
  });

  // A `done` task has finished and is awaiting review — terminal, not cancellable. Deleting its
  // chat must NOT open the stop-before-delete dialog or attempt a cancel (which the backend rejects).
  // It is also NOT "unresolved": the task IS in the snapshot with a known status, so it must not be
  // counted as an unknown link (which would trigger a needless fallback lookup + a false warning).
  it('does not treat a done (awaiting-review) task as a stop-before-delete blocker', () => {
    const { result } = renderHook(() =>
      useTaskAwareChatActions({
        activeTasks: [{ id: 'task-done', status: 'done', linkedChatId: 'chat-done' }],
        chats: [{ id: 'chat-done', taskId: 'task-done' }],
        invalidateTasks: vi.fn(async () => undefined),
      }),
    );

    const resolved = result.current.getActiveLinkedTasksForChatIds(['chat-done']);
    expect(resolved.activeTasks).toEqual([]);
    expect(resolved.unresolvedTaskLinks).toBe(0);
  });

  // Mixed batch delete: only the still-running task is stopped; the finished `done` task is skipped
  // (known-but-not-stoppable, not unresolved), so the batch produces no failed-cancel attempt.
  it('stops only in-flight tasks in a mixed done + running batch', () => {
    const { result } = renderHook(() =>
      useTaskAwareChatActions({
        activeTasks: [
          { id: 'task-run', status: 'running', linkedChatId: 'chat-run' },
          { id: 'task-done', status: 'done', linkedChatId: 'chat-done' },
        ],
        chats: [
          { id: 'chat-run', taskId: 'task-run' },
          { id: 'chat-done', taskId: 'task-done' },
        ],
        invalidateTasks: vi.fn(async () => undefined),
      }),
    );

    const resolved = result.current.getActiveLinkedTasksForChatIds(['chat-run', 'chat-done']);
    expect(resolved.activeTasks).toEqual([{ taskId: 'task-run', chatId: 'chat-run' }]);
    expect(resolved.unresolvedTaskLinks).toBe(0);
  });

  // A done task already present in the polled snapshot is a KNOWN non-stoppable link — the fallback
  // must not fire a redundant getById round-trip (perf) nor surface a "details unavailable" warning.
  it('does not fall back to getById for a done task already in the snapshot', async () => {
    const { result } = renderHook(() =>
      useTaskAwareChatActions({
        activeTasks: [{ id: 'task-done', status: 'done', linkedChatId: 'chat-done' }],
        chats: [{ id: 'chat-done', taskId: 'task-done' }],
        invalidateTasks: vi.fn(async () => undefined),
      }),
    );

    const resolved = await result.current.getActiveLinkedTasksForChatIdsWithFallback(['chat-done']);

    expect(getTaskByIdQuery).not.toHaveBeenCalled();
    expect(resolved.activeTasks).toEqual([]);
    expect(resolved.unresolvedTaskLinks).toBe(0);
  });

  /**
   * Identity must survive a poll that changes only the input arrays' identity — and the callbacks
   * must still read the latest inputs, which is the risk the ref they close over introduces.
   */
  describe('callback identity across polls', () => {
    const invalidateTasks = vi.fn(async () => undefined);
    const renderWith = (
      activeTasks: Array<{
        id: string;
        status?: string | null;
        linkedChatId?: string | null;
      }>,
      chats: Array<{ id: string; taskId: string | null }>,
    ) =>
      renderHook(
        (props: { activeTasks: typeof activeTasks; chats: typeof chats }) =>
          useTaskAwareChatActions({ ...props, invalidateTasks }),
        { initialProps: { activeTasks, chats } },
      );

    it('holds identity when the polled inputs change identity but not content', () => {
      const { result, rerender } = renderWith(
        [{ id: 'task-1', status: 'running', linkedChatId: 'chat-1' }],
        [{ id: 'chat-1', taskId: 'task-1' }],
      );
      const before = {
        sync: result.current.getActiveLinkedTasksForChatIds,
        fallback: result.current.getActiveLinkedTasksForChatIdsWithFallback,
      };

      rerender({
        activeTasks: [{ id: 'task-1', status: 'running', linkedChatId: 'chat-1' }],
        chats: [{ id: 'chat-1', taskId: 'task-1' }],
      });

      expect(result.current.getActiveLinkedTasksForChatIds).toBe(before.sync);
      expect(result.current.getActiveLinkedTasksForChatIdsWithFallback).toBe(before.fallback);
    });

    /**
     * A poll can land inside the fallback's await. Answering from the entry snapshot is what stops
     * a chat that left the list mid-flight dropping out of the stop set on a batch delete.
     */
    it('resolves against the entry snapshot when a poll drops the chat mid-flight', async () => {
      type FallbackTask = { id: string; status: string };
      let release: ((task: FallbackTask) => void) | undefined;
      getTaskByIdQuery.mockImplementation(
        () =>
          new Promise((resolve) => {
            release = resolve;
          }),
      );

      const { result, rerender } = renderWith([], [{ id: 'chat-1', taskId: 'task-a' }]);
      const pending = result.current.getActiveLinkedTasksForChatIdsWithFallback(['chat-1']);

      // A poll lands mid-await and the chat is gone from the newest snapshot.
      rerender({ activeTasks: [], chats: [] });
      release?.({ id: 'task-a', status: 'running' });

      await expect(pending).resolves.toEqual({
        activeTasks: [{ taskId: 'task-a', chatId: 'chat-1' }],
        unresolvedTaskLinks: 0,
      });
    });

    it('still resolves against the newest polled inputs', () => {
      const { result, rerender } = renderWith([], []);
      expect(result.current.getActiveLinkedTasksForChatIds(['chat-1']).activeTasks).toEqual([]);

      rerender({
        activeTasks: [{ id: 'task-1', status: 'running', linkedChatId: 'chat-1' }],
        chats: [{ id: 'chat-1', taskId: 'task-1' }],
      });

      expect(result.current.getActiveLinkedTasksForChatIds(['chat-1']).activeTasks).toEqual([
        { taskId: 'task-1', chatId: 'chat-1' },
      ]);
    });
  });
});
