/* eslint-disable max-lines, max-lines-per-function */
import { useCallback, useLayoutEffect, useRef } from 'react';
import { cancelTasksBatch } from '../../../../lib/tasks/cancel-tasks-batch';
import { trpcClient } from '../../../../lib/trpc';
import { SIDEBAR_STOPPABLE_TASK_STATUSES } from '../constants';

type ActiveLinkedTask = {
  taskId: string;
  chatId: string;
};

type SidebarActiveTask = {
  id: string;
  linkedChatId?: string | null;
  status?: string | null;
};

type SidebarChatTaskLink = {
  id: string;
  taskId: string | null;
};

type UseTaskAwareChatActionsOptions = {
  activeTasks: SidebarActiveTask[];
  chats: SidebarChatTaskLink[];
  invalidateTasks: () => Promise<unknown>;
};

const STOPPABLE_TASK_STATUSES = new Set<string>(SIDEBAR_STOPPABLE_TASK_STATUSES);
const MAX_FALLBACK_TASK_LOOKUPS = 25;

type TaskSnapshot = {
  activeTaskById: Map<string, SidebarActiveTask>;
  activeTaskByLinkedChatId: Map<string, SidebarActiveTask>;
  /**
   * Every polled task, any status. Separates a known non-stoppable link from one genuinely absent
   * from the snapshot; only the latter is "unresolved" and worth a fallback lookup.
   */
  knownTaskIds: Set<string>;
  chatById: Map<string, SidebarChatTaskLink>;
};

const isStoppable = (task: SidebarActiveTask): boolean =>
  !!task.status && STOPPABLE_TASK_STATUSES.has(task.status);

/**
 * Build ONCE per call and thread it through: re-deriving mid-await could miss a chat that left the
 * snapshot, dropping its running task from the stop set.
 */
function buildTaskSnapshot(
  activeTasks: SidebarActiveTask[],
  chats: SidebarChatTaskLink[],
): TaskSnapshot {
  const activeTaskById = new Map<string, SidebarActiveTask>();
  const activeTaskByLinkedChatId = new Map<string, SidebarActiveTask>();
  const knownTaskIds = new Set<string>();
  for (const task of activeTasks) {
    knownTaskIds.add(task.id);
    if (!isStoppable(task)) continue;
    activeTaskById.set(task.id, task);
    if (task.linkedChatId) {
      activeTaskByLinkedChatId.set(task.linkedChatId, task);
    }
  }
  return {
    activeTaskById,
    activeTaskByLinkedChatId,
    knownTaskIds,
    chatById: new Map(chats.map((chat) => [chat.id, chat])),
  };
}

type ResolvedLinkedTasks = {
  activeTasks: ActiveLinkedTask[];
  unresolvedTaskLinks: number;
  /** Chats whose task is absent from the polled snapshot; only these are worth a fallback lookup. */
  unresolvedChatIds: string[];
};

function resolveActiveLinkedTasks(chatIds: string[], snapshot: TaskSnapshot): ResolvedLinkedTasks {
  const dedupedChatIds = Array.from(new Set(chatIds));
  const collectedTasks: ActiveLinkedTask[] = [];
  const unresolvedChatIds: string[] = [];
  let unresolvedTaskLinks = 0;

  for (const chatId of dedupedChatIds) {
    const linkedTask = snapshot.activeTaskByLinkedChatId.get(chatId);
    if (linkedTask) {
      collectedTasks.push({ taskId: linkedTask.id, chatId });
      continue;
    }

    const chat = snapshot.chatById.get(chatId);
    if (!chat?.taskId) continue;
    const taskById = snapshot.activeTaskById.get(chat.taskId);
    if (taskById) {
      collectedTasks.push({ taskId: chat.taskId, chatId });
      continue;
    }

    // In the snapshot but not stoppable -> resolved as "nothing to stop", not an unknown link.
    if (snapshot.knownTaskIds.has(chat.taskId)) continue;

    unresolvedTaskLinks += 1;
    unresolvedChatIds.push(chatId);
  }

  return { activeTasks: collectedTasks, unresolvedTaskLinks, unresolvedChatIds };
}

export function useTaskAwareChatActions({
  activeTasks,
  chats,
  invalidateTasks,
}: UseTaskAwareChatActionsOptions) {
  /**
   * Polled inputs behind a render-assigned ref. Both resolvers run only from user-event handlers,
   * so this reads the same values a closure would while keeping the callbacks identity-stable.
   */
  const inputsRef = useRef({ activeTasks, chats });
  // Layout effect, not render and not a passive effect: an aborted render must not publish inputs
  // the UI never showed, and the ref must be current before any click can reach a destructive action.
  useLayoutEffect(() => {
    inputsRef.current = { activeTasks, chats };
  }, [activeTasks, chats]);

  // biome-ignore lint/correctness/useExhaustiveDependencies: reads only inputsRef; listing the
  // polled inputs would re-create this every poll and defeat the sidebar row memos.
  const getActiveLinkedTasksForChatIds = useCallback(
    (chatIds: string[]) =>
      resolveActiveLinkedTasks(
        chatIds,
        buildTaskSnapshot(inputsRef.current.activeTasks, inputsRef.current.chats),
      ),
    [],
  );

  const getActiveLinkedTasksForChatIdsWithFallback = useCallback(
    async (
      chatIds: string[],
    ): Promise<{ activeTasks: ActiveLinkedTask[]; unresolvedTaskLinks: number }> => {
      const snapshot = buildTaskSnapshot(inputsRef.current.activeTasks, inputsRef.current.chats);
      const resolved = resolveActiveLinkedTasks(chatIds, snapshot);
      if (resolved.unresolvedTaskLinks === 0) {
        return {
          activeTasks: resolved.activeTasks,
          unresolvedTaskLinks: 0,
        };
      }

      const taskByIdCache = new Map<string, { status?: string | null } | null>();
      const failedTaskLookupIds = new Set<string>();
      const unresolvedChatToTaskId = new Map<string, string>();
      const unresolvedTaskIds = new Set<string>();

      for (const unresolvedChatId of resolved.unresolvedChatIds) {
        const chat = snapshot.chatById.get(unresolvedChatId);
        if (!chat?.taskId) {
          continue;
        }
        unresolvedChatToTaskId.set(unresolvedChatId, chat.taskId);
        unresolvedTaskIds.add(chat.taskId);
      }

      // Accepted trade-off: for very large unresolved sets we skip fallback preflight requests,
      // surface unresolved warnings, and avoid blocking batch actions behind 25+ network lookups.
      if (unresolvedTaskIds.size > MAX_FALLBACK_TASK_LOOKUPS) {
        return {
          activeTasks: resolved.activeTasks,
          unresolvedTaskLinks: resolved.unresolvedTaskLinks,
        };
      }

      await Promise.all(
        Array.from(unresolvedTaskIds).map(async (taskId) => {
          try {
            const task = (await trpcClient.tasks.getById.query(taskId)) as {
              status?: string | null;
            } | null;
            taskByIdCache.set(taskId, task);
          } catch {
            taskByIdCache.set(taskId, null);
            failedTaskLookupIds.add(taskId);
          }
        }),
      );
      const activeTaskByChatId = new Map<string, ActiveLinkedTask>();
      for (const task of resolved.activeTasks) {
        activeTaskByChatId.set(task.chatId, task);
      }

      let unresolvedAfterFallback = 0;
      for (const unresolvedChatId of resolved.unresolvedChatIds) {
        const taskId = unresolvedChatToTaskId.get(unresolvedChatId);
        if (!taskId) {
          continue;
        }

        const task = taskByIdCache.get(taskId);
        if (failedTaskLookupIds.has(taskId)) {
          unresolvedAfterFallback += 1;
          continue;
        }

        if (task?.status && STOPPABLE_TASK_STATUSES.has(task.status)) {
          activeTaskByChatId.set(unresolvedChatId, { taskId, chatId: unresolvedChatId });
        }
      }

      return {
        activeTasks: Array.from(activeTaskByChatId.values()),
        unresolvedTaskLinks: unresolvedAfterFallback,
      };
    },
    // biome-ignore lint/correctness/useExhaustiveDependencies: reads only inputsRef; see above.
    [],
  );

  const abortTaskChatStreamsBestEffort = useCallback(async (chatIds: string[]) => {
    const { agentChatStore } = await import('../../../agents/stores/agent-chat-store');

    const uniqueChatIds = Array.from(new Set(chatIds));
    await Promise.allSettled(
      uniqueChatIds.map(async (chatId) => {
        const chatData = await trpcClient.chats.get.query({ id: chatId });
        const subChats = (chatData as { subChats?: Array<{ id: string }> }).subChats ?? [];
        for (const subChat of subChats) {
          agentChatStore.setManuallyAborted(subChat.id, true);
        }
      }),
    );
  }, []);

  const cancelTasksBestEffort = useCallback(
    async (taskIds: string[]) => {
      const { failedCount } = await cancelTasksBatch(taskIds);
      await invalidateTasks();
      return { failed: failedCount };
    },
    [invalidateTasks],
  );

  return {
    getActiveLinkedTasksForChatIds,
    getActiveLinkedTasksForChatIdsWithFallback,
    abortTaskChatStreamsBestEffort,
    cancelTasksBestEffort,
  };
}
