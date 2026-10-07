import { useCallback, useRef, useState } from 'react';
import { toast } from 'sonner';
import { cleanupChatScopedState } from '../../atoms/atom-family-factory';
import type { IdSelectionStore } from '../../tree-navigation';

/** A chat mutation's resolved row; the batch runner only needs to know it settled. */
type ChatMutationResult = Promise<object | null>;

type ChatsBatchOptions = {
  clearPanesBefore?: boolean;
  onPartialFailure?: (succeeded: number, total: number, failed: number) => void;
};

type SidebarChatUtils = {
  chats: Record<'list' | 'listByBatch' | 'listBatchGroups', { invalidate: () => Promise<void> }>;
};

type BatchTaskAwareDialog = {
  open: true;
  mode: 'batch';
  operation: 'delete_batch';
  chatIds: string[];
  taskIds: string[];
  totalChats: number;
};

type MovableChat = { id: string; projectId: string | null; taskId: string | null };

type BulkChatActionsParams = {
  selection: IdSelectionStore;
  utilsRef: { current: SidebarChatUtils };
  /** The sidebar's own batch-view refetch, which every chat membership change must run. */
  invalidateBatchViews: (utils: SidebarChatUtils) => Promise<void>;
  loadedChats: readonly MovableChat[];
  clearPanesForChat: (chatId: string) => number[];
  restorePaneAt: (paneIndex: number, chatId: string) => void;
  removeChatsFromLoadedFolders: (chatIds: Iterable<string>) => void;
  syncSidebarCountsOrFullRefresh: (warningTitle: string) => Promise<void>;
  setSelectedChatId: (update: (current: string | null) => string | null) => void;
  setShowArchived: (show: boolean) => void;
  deleteMutRef: { current: { mutateAsync: (input: { id: string }) => ChatMutationResult } };
  archiveMutRef: {
    current: {
      mutateAsync: (input: { id: string }) => ChatMutationResult;
    };
  };
  moveOne: (chatId: string, targetProjectId: string | null) => Promise<void>;
  getActiveLinkedTasks: (
    chatIds: string[],
  ) => Promise<{ activeTasks: Array<{ taskId: string }>; unresolvedTaskLinks: number }>;
  openTaskAwareDialog: (state: BatchTaskAwareDialog) => void;
};

type DropTarget = { draggedId: string; draggedFrom: string | null; targetProjectId: string | null };

/** Splits a drop into chats that move and flow chats that stay; chats already there are dropped. */
function partitionMovable(ids: string[], loadedChats: readonly MovableChat[], drop: DropTarget) {
  const byId = new Map(loadedChats.map((chat) => [chat.id, chat]));
  const movable: string[] = [];
  let flowChats = 0;
  for (const id of ids) {
    const chat = byId.get(id);
    const isDragged = id === drop.draggedId;
    // Flow task chats and batch rows (absent from the folder maps) stay in their flow's project.
    if (isDragged ? chat?.taskId != null : chat?.taskId !== null) flowChats++;
    // The drag names its own source folder; the rest of the selection is looked up.
    else if ((isDragged ? drop.draggedFrom : chat?.projectId) !== drop.targetProjectId)
      movable.push(id);
  }
  return { movable, flowChats };
}

/** Never rejects: failures are counted and reported in one toast. */
async function moveSequentially(
  ids: string[],
  targetProjectId: string | null,
  moveOne: (chatId: string, targetProjectId: string | null) => Promise<void>,
): Promise<void> {
  let failed = 0;
  for (const id of ids) {
    try {
      await moveOne(id, targetProjectId);
    } catch {
      failed++;
    }
  }
  if (failed > 0) {
    toast.error(`Moved ${ids.length - failed} of ${ids.length} chats`, {
      description: `${failed} failed — try again.`,
    });
  }
}

export function toastPartialFailure(verb: 'Deleted' | 'Archived') {
  return (succeeded: number, total: number, failed: number) => {
    toast.error(`${verb} ${succeeded} of ${total} chats. ${failed} failed — try again.`);
  };
}

/** Delete / archive / move for many sidebar chats at once, plus the Cmd/Shift-click delete confirm. */
export function useBulkChatActions({
  selection,
  utilsRef,
  invalidateBatchViews,
  loadedChats,
  clearPanesForChat,
  restorePaneAt,
  removeChatsFromLoadedFolders,
  syncSidebarCountsOrFullRefresh,
  setSelectedChatId,
  setShowArchived,
  deleteMutRef,
  archiveMutRef,
  moveOne,
  getActiveLinkedTasks,
  openTaskAwareDialog,
}: BulkChatActionsParams) {
  const [pendingDeleteIds, setPendingDeleteIds] = useState<string[] | null>(null);
  const loadedChatsRef = useRef(loadedChats);
  const moveQueueRef = useRef<Promise<void>>(Promise.resolve());
  /** One bulk archive/delete at a time: a second would hit chats the first already changed. */
  const bulkBusyRef = useRef(false);
  loadedChatsRef.current = loadedChats;

  /** allSettled fan-out → restore panes of failed chats → drop the rest from every sidebar view. */
  const runChatsBatch = useCallback(
    async (
      chats: Array<{ id: string }>,
      mutateOne: (chatId: string) => ChatMutationResult,
      options?: ChatsBatchOptions,
    ): Promise<number> => {
      const clearedPanesByChat = new Map<string, number[]>();
      if (options?.clearPanesBefore)
        for (const chat of chats) clearedPanesByChat.set(chat.id, clearPanesForChat(chat.id));
      const results = await Promise.allSettled(chats.map((chat) => mutateOne(chat.id)));
      const succeededIds = new Set<string>();
      results.forEach((result, index) => {
        const chatId = chats[index]?.id;
        if (!chatId) return;
        if (result.status === 'fulfilled') succeededIds.add(chatId);
        else (clearedPanesByChat.get(chatId) ?? []).forEach((pane) => restorePaneAt(pane, chatId));
      });
      removeChatsFromLoadedFolders(succeededIds);
      await Promise.all([
        invalidateBatchViews(utilsRef.current),
        syncSidebarCountsOrFullRefresh('Chats updated'),
      ]);
      setSelectedChatId((current) => (current && succeededIds.has(current) ? null : current));
      for (const chatId of succeededIds) cleanupChatScopedState(chatId);
      const failed = chats.length - succeededIds.size;
      if (failed > 0) options?.onPartialFailure?.(succeededIds.size, chats.length, failed);
      return succeededIds.size;
    },
    [
      clearPanesForChat,
      restorePaneAt,
      removeChatsFromLoadedFolders,
      syncSidebarCountsOrFullRefresh,
      setSelectedChatId,
      utilsRef,
      invalidateBatchViews,
    ],
  );

  const deleteChatsBatch = useCallback(
    (chats: Array<{ id: string }>, options?: ChatsBatchOptions) =>
      runChatsBatch(chats, (id) => deleteMutRef.current.mutateAsync({ id }), options),
    [runChatsBatch, deleteMutRef],
  );

  const archiveChatsBatch = useCallback(
    async (chatIds: string[]) => {
      const archived = await runChatsBatch(
        chatIds.map((id) => ({ id })),
        (id) => archiveMutRef.current.mutateAsync({ id }),
        { clearPanesBefore: true, onPartialFailure: toastPartialFailure('Archived') },
      );
      await utilsRef.current.chats.list.invalidate();
      if (archived > 0) setShowArchived(true);
    },
    [runChatsBatch, archiveMutRef, utilsRef, setShowArchived],
  );

  /** True when a live linked task hands the delete to the task-aware dialog instead. */
  const deferToTaskAwareDialog = useCallback(
    async (chatIds: string[]) => {
      const { activeTasks, unresolvedTaskLinks } = await getActiveLinkedTasks(chatIds);
      if (unresolvedTaskLinks > 0) {
        toast.warning('Some linked task details were unavailable', {
          description: 'Manage unresolved tasks from Work Queue.',
        });
      }
      if (activeTasks.length === 0) return false;
      openTaskAwareDialog({
        open: true,
        mode: 'batch',
        operation: 'delete_batch',
        chatIds,
        taskIds: activeTasks.map((task) => task.taskId),
        totalChats: chatIds.length,
      });
      return true;
    },
    [getActiveLinkedTasks, openTaskAwareDialog],
  );

  const requestDelete = useCallback(
    async (chatIds: string[]) => {
      if (chatIds.length === 0 || bulkBusyRef.current) return;
      // Held through the task check only: the confirm dialog that follows is modal.
      bulkBusyRef.current = true;
      try {
        if (await deferToTaskAwareDialog(chatIds)) return;
        setPendingDeleteIds(chatIds);
      } finally {
        bulkBusyRef.current = false;
      }
    },
    [deferToTaskAwareDialog],
  );

  const confirmDelete = useCallback(async () => {
    if (!pendingDeleteIds || bulkBusyRef.current) return;
    setPendingDeleteIds(null);
    bulkBusyRef.current = true;
    try {
      await deleteChatsBatch(
        pendingDeleteIds.map((id) => ({ id })),
        { clearPanesBefore: true, onPartialFailure: toastPartialFailure('Deleted') },
      );
    } finally {
      bulkBusyRef.current = false;
    }
  }, [pendingDeleteIds, deleteChatsBatch]);

  const requestArchive = useCallback(
    async (chatIds: string[]) => {
      if (chatIds.length === 0 || bulkBusyRef.current) return;
      bulkBusyRef.current = true;
      try {
        await archiveChatsBatch(chatIds);
      } finally {
        bulkBusyRef.current = false;
      }
    },
    [archiveChatsBatch],
  );

  /** Dropping a selected row moves the whole selection. Every move, across drops too, runs one at a
   * time: each patches the sidebar maps and refetches counts, and parallel refetches land out of order. */
  const moveChats = useCallback(
    (
      draggedId: string,
      targetProjectId: string | null,
      draggedFrom: string | null,
    ): Promise<void> => {
      const selected = selection.getSnapshot();
      const ids = selected.has(draggedId) ? [...selected] : [draggedId];
      const { movable, flowChats } = partitionMovable(ids, loadedChatsRef.current, {
        draggedId,
        draggedFrom,
        targetProjectId,
      });
      if (flowChats > 0) {
        toast.info(`${flowChats} flow chat${flowChats === 1 ? '' : 's'} stayed put`, {
          description: 'Chats that belong to a flow can’t move between projects.',
        });
      }
      const run = () => moveSequentially(movable, targetProjectId, moveOne);
      // `run` never rejects, so one failed drop cannot stall the queue.
      moveQueueRef.current = moveQueueRef.current.then(run);
      return moveQueueRef.current;
    },
    [selection, moveOne],
  );

  return {
    deleteChatsBatch,
    archiveChatsBatch,
    requestDelete,
    requestArchive,
    moveChats,
    pendingDeleteCount: pendingDeleteIds?.length ?? 0,
    confirmDelete,
    cancelDelete: useCallback(() => setPendingDeleteIds(null), []),
  };
}
