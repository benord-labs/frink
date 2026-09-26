import { useCallback } from 'react';
import type { api } from '../../../../../lib/mock-api';
import { trpc } from '../../../../../lib/trpc';

type UseGitOperationsProps = {
  chatId: string;
  utils: ReturnType<typeof api.useUtils>;
};

type UseGitOperationsReturn = {
  handleRestoreWorkspace: () => void;
  restoreWorkspaceMutation: ReturnType<typeof trpc.chats.restore.useMutation>;
};

export function useGitOperations({ chatId, utils }: UseGitOperationsProps): UseGitOperationsReturn {
  const trpcUtils = trpc.useUtils();

  // Restore archived workspace mutation (silent - no toast)
  const restoreWorkspaceMutation = trpc.chats.restore.useMutation({
    onSuccess: (restoredChat) => {
      if (restoredChat) {
        // Update the main chat list cache
        trpcUtils.chats.list.setData({}, (oldData) => {
          if (!oldData) return [restoredChat];
          if (oldData.some((c) => c.id === restoredChat.id)) return oldData;
          return [restoredChat, ...oldData];
        });
      }
      // Invalidate both lists to refresh
      trpcUtils.chats.list.invalidate();
      trpcUtils.chats.listCounts.invalidate();
      trpcUtils.chats.listArchived.invalidate();
      // Invalidate this chat's data to update isArchived state
      utils.agents.getAgentChat.invalidate({ chatId });
    },
  });

  // `mutate` is stable across renders; the mutation object is rebuilt on every one.
  const { mutate: restoreWorkspace } = restoreWorkspaceMutation;
  const handleRestoreWorkspace = useCallback(() => {
    restoreWorkspace({ id: chatId });
  }, [chatId, restoreWorkspace]);

  return {
    handleRestoreWorkspace,
    restoreWorkspaceMutation,
  };
}
