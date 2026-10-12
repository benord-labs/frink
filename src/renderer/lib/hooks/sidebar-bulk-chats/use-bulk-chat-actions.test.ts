// @vitest-environment happy-dom
import { act, renderHook } from '@testing-library/react';
import { toast } from 'sonner';
import { describe, expect, it, vi } from 'vitest';
import { createIdSelectionStore } from '../../tree-navigation';
import { useBulkChatActions } from './use-bulk-chat-actions';

type SetupOverrides = {
  invalidateBatchViews?: () => Promise<void>;
  moveOne?: (chatId: string, target: string | null) => Promise<void>;
  archiveMutateAsync?: (input: { id: string; killTerminals?: boolean }) => Promise<object | null>;
  activeTasks?: Array<{ taskId: string }>;
  getActiveLinkedTasks?: () => Promise<{
    activeTasks: Array<{ taskId: string }>;
    unresolvedTaskLinks: number;
  }>;
};

function setup({
  invalidateBatchViews = async () => {},
  moveOne = vi.fn(async () => {}),
  archiveMutateAsync = vi.fn(async () => ({})),
  activeTasks = [],
  getActiveLinkedTasks = async () => ({ activeTasks, unresolvedTaskLinks: 0 }),
}: SetupOverrides = {}) {
  const selection = createIdSelectionStore();
  const invalidate = vi.fn(async () => {});
  const deps = {
    restorePaneAt: vi.fn(),
    removeChatsFromLoadedFolders: vi.fn(),
    setSelectedChatId: vi.fn(),
    setShowArchived: vi.fn(),
    openTaskAwareDialog: vi.fn(),
    deleteMutateAsync: vi.fn(async () => ({})),
  };
  const { result } = renderHook(() =>
    useBulkChatActions({
      selection,
      utilsRef: {
        current: {
          chats: {
            list: { invalidate },
            listByBatch: { invalidate },
            listBatchGroups: { invalidate },
          },
        },
      },
      invalidateBatchViews,
      loadedChats: [
        { id: 'a', projectId: 'p1', taskId: null },
        { id: 'b', projectId: 'p1', taskId: null },
        { id: 'task', projectId: 'p1', taskId: 't1' },
        { id: 'there', projectId: 'p2', taskId: null },
      ],
      // Chat 'a' is open in split pane 1.
      clearPanesForChat: (chatId) => (chatId === 'a' ? [1] : []),
      restorePaneAt: deps.restorePaneAt,
      removeChatsFromLoadedFolders: deps.removeChatsFromLoadedFolders,
      syncSidebarCountsOrFullRefresh: vi.fn(async () => {}),
      setSelectedChatId: deps.setSelectedChatId,
      setShowArchived: deps.setShowArchived,
      deleteMutRef: { current: { mutateAsync: deps.deleteMutateAsync } },
      archiveMutRef: { current: { mutateAsync: archiveMutateAsync } },
      moveOne,
      getActiveLinkedTasks,
      openTaskAwareDialog: deps.openTaskAwareDialog,
    }),
  );
  return { selection, result, invalidate, deps };
}

describe('useBulkChatActions moveChats', () => {
  it('moves the selection one chat at a time, skipping task chats and chats already there', async () => {
    const order: string[] = [];
    let inFlight = 0;
    const moveOne = vi.fn(async (id: string) => {
      expect(inFlight).toBe(0);
      inFlight++;
      await Promise.resolve();
      order.push(id);
      inFlight--;
    });
    const { selection, result } = setup({ moveOne });
    // 'batch-member' stands in for a batch row: rendered from listByBatch, absent from folder maps.
    for (const id of ['a', 'b', 'task', 'there', 'batch-member']) selection.toggle(id);

    const toastInfo = vi.spyOn(toast, 'info').mockImplementation(() => '');

    await act(() => result.current.moveChats('a', 'p2', 'p1'));

    expect(order).toEqual(['a', 'b']);
    expect(toastInfo).toHaveBeenCalledWith('2 flow chats stayed put', expect.anything());
    toastInfo.mockRestore();
  });

  it('queues a second drop behind a multi-move that is still running', async () => {
    let inFlight = 0;
    const order: string[] = [];
    const moveOne = vi.fn(async (id: string) => {
      expect(inFlight).toBe(0);
      inFlight++;
      await new Promise((resolve) => setTimeout(resolve, 0));
      order.push(id);
      inFlight--;
    });
    const { selection, result } = setup({ moveOne });
    selection.toggle('a');
    selection.toggle('b');

    await act(() =>
      Promise.all([
        result.current.moveChats('a', 'p2', 'p1'),
        result.current.moveChats('there', 'p1', 'p2'),
      ]),
    );

    expect(order).toEqual(['a', 'b', 'there']);
  });

  it('moves the rest of the selection when dropped on the dragged chat’s own project', async () => {
    const moveOne = vi.fn(async () => {});
    const { selection, result } = setup({ moveOne });
    selection.toggle('a');
    selection.toggle('there');

    await act(() => result.current.moveChats('a', 'p1', 'p1'));

    expect(moveOne.mock.calls).toEqual([['there', 'p1']]);
  });

  it('keeps a dragged flow chat in its project and says so', async () => {
    const toastInfo = vi.spyOn(toast, 'info').mockImplementation(() => '');
    const moveOne = vi.fn(async () => {});
    const { result } = setup({ moveOne });

    await act(() => result.current.moveChats('task', 'p2', 'p1'));

    expect(moveOne).not.toHaveBeenCalled();
    expect(toastInfo).toHaveBeenCalledWith('1 flow chat stayed put', expect.anything());
    toastInfo.mockRestore();
  });

  it('moves only the dragged chat when it is not part of the selection', async () => {
    const moveOne = vi.fn(async () => {});
    const { selection, result } = setup({ moveOne });
    selection.toggle('b');

    await act(() => result.current.moveChats('a', 'p2', 'p1'));

    expect(moveOne).toHaveBeenCalledTimes(1);
    expect(moveOne).toHaveBeenCalledWith('a', 'p2');
  });

  it('keeps going past a failed move and reports it in one toast', async () => {
    const toastError = vi.spyOn(toast, 'error').mockImplementation(() => '');
    const moveOne = vi.fn(async (id: string) => {
      if (id === 'a') throw new Error('boom');
    });
    const { selection, result } = setup({ moveOne });
    selection.toggle('a');
    selection.toggle('b');

    await act(() => result.current.moveChats('a', 'p2', 'p1'));

    expect(moveOne).toHaveBeenCalledTimes(2);
    expect(toastError).toHaveBeenCalledTimes(1);
    expect(toastError).toHaveBeenCalledWith('Moved 1 of 2 chats', expect.anything());
    toastError.mockRestore();
  });
});

describe('useBulkChatActions bulk archive and delete', () => {
  it('restores the pane of a chat that failed to archive and drops only the archived ones', async () => {
    const toastError = vi.spyOn(toast, 'error').mockImplementation(() => '');
    const archiveMutateAsync = vi.fn(async ({ id }: { id: string }) => {
      if (id === 'a') throw new Error('boom');
      return {};
    });
    const { result, invalidate, deps } = setup({ archiveMutateAsync });

    await act(() => result.current.requestArchive(['a', 'b']));

    expect(archiveMutateAsync).toHaveBeenCalledWith({ id: 'b', killTerminals: undefined });
    expect(deps.restorePaneAt).toHaveBeenCalledWith(1, 'a');
    expect([...deps.removeChatsFromLoadedFolders.mock.calls[0][0]]).toEqual(['b']);
    const clearActive = deps.setSelectedChatId.mock.calls[0][0];
    expect(clearActive('b')).toBeNull();
    expect(clearActive('a')).toBe('a');
    expect(toastError).toHaveBeenCalledWith('Archived 1 of 2 chats. 1 failed — try again.');
    expect(invalidate).toHaveBeenCalled();
    expect(deps.setShowArchived).toHaveBeenCalledWith(true);
    toastError.mockRestore();
  });

  it('ignores a second Archive click while the first bulk archive is running', async () => {
    const archiveMutateAsync = vi.fn(async () => ({}));
    const { result } = setup({ archiveMutateAsync });

    await act(() =>
      Promise.all([
        result.current.requestArchive(['a', 'b']),
        result.current.requestArchive(['a', 'b']),
      ]),
    );

    expect(archiveMutateAsync).toHaveBeenCalledTimes(2);
  });

  it('ignores Delete while a bulk archive of the selection is still running', async () => {
    let finishArchive = () => {};
    const archiveMutateAsync = vi.fn(
      () => new Promise<object>((resolve) => (finishArchive = () => resolve({}))),
    );
    const { result } = setup({ archiveMutateAsync });

    let archiving: Promise<void> = Promise.resolve();
    await act(async () => {
      archiving = result.current.requestArchive(['a']);
      await Promise.resolve();
    });
    await act(() => result.current.requestDelete(['a']));
    expect(result.current.pendingDeleteCount).toBe(0);

    await act(async () => {
      finishArchive();
      await archiving;
    });
  });

  it('ignores Archive while a bulk delete is still checking for linked tasks', async () => {
    let finishTaskCheck = () => {};
    const getActiveLinkedTasks = vi.fn(
      () =>
        new Promise<{ activeTasks: Array<{ taskId: string }>; unresolvedTaskLinks: number }>(
          (resolve) =>
            (finishTaskCheck = () => resolve({ activeTasks: [], unresolvedTaskLinks: 0 })),
        ),
    );
    const archiveMutateAsync = vi.fn(async () => ({}));
    const { result } = setup({ archiveMutateAsync, getActiveLinkedTasks });

    let deleting: Promise<void> = Promise.resolve();
    await act(async () => {
      deleting = result.current.requestDelete(['a']);
      await Promise.resolve();
    });
    await act(() => result.current.requestArchive(['a']));
    expect(archiveMutateAsync).not.toHaveBeenCalled();

    await act(async () => {
      finishTaskCheck();
      await deleting;
    });
    expect(result.current.pendingDeleteCount).toBe(1);
  });

  it('stays on the chat list when every archive fails', async () => {
    const toastError = vi.spyOn(toast, 'error').mockImplementation(() => '');
    const archiveMutateAsync = vi.fn(async () => {
      throw new Error('offline');
    });
    const { result, deps } = setup({ archiveMutateAsync });

    await act(() => result.current.requestArchive(['a', 'b']));

    expect(toastError).toHaveBeenCalledWith('Archived 0 of 2 chats. 2 failed — try again.');
    expect(deps.setShowArchived).not.toHaveBeenCalled();
    toastError.mockRestore();
  });

  it('hands a bulk delete with a live linked task to the task-aware dialog, skipping the confirm', async () => {
    const { result, deps } = setup({ activeTasks: [{ taskId: 'task-1' }] });

    await act(() => result.current.requestDelete(['a', 'b']));

    expect(deps.openTaskAwareDialog).toHaveBeenCalledWith(
      expect.objectContaining({
        operation: 'delete_batch',
        chatIds: ['a', 'b'],
        taskIds: ['task-1'],
      }),
    );
    expect(result.current.pendingDeleteCount).toBe(0);
  });
});

describe('useBulkChatActions runChatsAtomically', () => {
  it('restores every pane and keeps the chats when the one mutation fails (sc-3279)', async () => {
    const { result, deps } = setup();
    const failure = new Error('database is locked');

    await expect(
      act(() =>
        result.current.runChatsAtomically([{ id: 'a' }, { id: 'b' }], async () => {
          throw failure;
        }),
      ),
    ).rejects.toBe(failure);

    expect(deps.restorePaneAt).toHaveBeenCalledWith(1, 'a');
    expect(deps.removeChatsFromLoadedFolders).not.toHaveBeenCalled();
    expect(deps.setSelectedChatId).not.toHaveBeenCalled();
    expect(deps.deleteMutateAsync).not.toHaveBeenCalled();
  });

  it('drops every chat from the sidebar once the one mutation succeeds', async () => {
    const { result, deps } = setup();
    const mutateAll = vi.fn(async () => ['a', 'b']);

    await act(() => result.current.runChatsAtomically([{ id: 'a' }, { id: 'b' }], mutateAll));

    expect(mutateAll).toHaveBeenCalledTimes(1);
    expect(deps.deleteMutateAsync).not.toHaveBeenCalled();
    expect(deps.restorePaneAt).not.toHaveBeenCalled();
    expect(deps.removeChatsFromLoadedFolders).toHaveBeenCalledWith(new Set(['a', 'b']));
    const clearSelection = deps.setSelectedChatId.mock.calls[0][0];
    expect(clearSelection('b')).toBeNull();
    expect(clearSelection('there')).toBe('there');
  });

  it('still runs the one mutation for a project with no chats', async () => {
    const { result, deps } = setup();
    const mutateAll = vi.fn(async (): Promise<string[]> => []);

    await act(() => result.current.runChatsAtomically([], mutateAll));

    expect(mutateAll).toHaveBeenCalledTimes(1);
    expect(deps.restorePaneAt).not.toHaveBeenCalled();
    expect(deps.removeChatsFromLoadedFolders).toHaveBeenCalledWith(new Set());
  });

  it('warns instead of failing when the refresh after a committed delete fails', async () => {
    const toastWarning = vi.spyOn(toast, 'warning').mockImplementation(() => '');
    const { result, deps } = setup({
      invalidateBatchViews: async () => {
        throw new Error('refetch failed');
      },
    });

    await act(() => result.current.runChatsAtomically([{ id: 'a' }], async () => ['a']));

    expect(toastWarning).toHaveBeenCalledWith('Deleted; refreshing sidebar', {
      description: 'refetch failed',
    });
    toastWarning.mockRestore();

    expect(deps.removeChatsFromLoadedFolders).toHaveBeenCalledWith(new Set(['a']));
    expect(deps.restorePaneAt).not.toHaveBeenCalled();
    const clearSelection = deps.setSelectedChatId.mock.calls[0][0];
    expect(clearSelection('a')).toBeNull();
  });

  it('keeps a chat the delete did not remove (moved to another project meanwhile)', async () => {
    const { result, deps } = setup();

    await act(() =>
      result.current.runChatsAtomically([{ id: 'a' }, { id: 'b' }], async () => ['b']),
    );

    expect(deps.restorePaneAt.mock.calls).toEqual([[1, 'a']]);
    expect(deps.removeChatsFromLoadedFolders).toHaveBeenCalledWith(new Set(['b']));
    const clearSelection = deps.setSelectedChatId.mock.calls[0][0];
    expect(clearSelection('a')).toBe('a');
  });
});
