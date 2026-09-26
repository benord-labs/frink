import { useCallback, useRef } from 'react';
import { toast } from 'sonner';
import { api } from '../../../lib/mock-api';
import { useAgentSubChatStore } from '../stores/sub-chat-store';

/**
 * Single source of truth for persisting a sub-chat rename: optimistic store update,
 * persist via tRPC, revert to the prior name on failure (toast surfaced by the
 * mutation's onError). Returns a bare action keyed by `subChatId` at call-time so
 * any surface (chat-header title editor, sub-chat tabs) can rename any sub-chat.
 *
 * Callers own their own edit/loading UI state and trim/unchanged guards — those
 * differ per surface (e.g. divergent click-outside policies) and stay local.
 */
export function useSubChatRenameAction() {
  const mutation = api.agents.renameSubChat.useMutation({
    onError: (error) => {
      toast.error(
        error.data?.code === 'NOT_FOUND'
          ? 'Send a message first before renaming this chat'
          : 'Failed to rename chat',
      );
    },
  });
  // Ref keeps the returned action stable (mutation object is a new ref each render).
  const mutationRef = useRef(mutation);
  mutationRef.current = mutation;

  return useCallback(async (subChatId: string, newName: string) => {
    const store = useAgentSubChatStore.getState();
    // Capture the prior name once, before the optimistic write, for revert.
    const oldName = store.subChatsById[subChatId]?.name ?? '';
    store.updateSubChatName(subChatId, newName);

    try {
      await mutationRef.current.mutateAsync({ subChatId, name: newName });
    } catch {
      // Revert on failure; the toast is shown by the mutation's onError.
      useAgentSubChatStore.getState().updateSubChatName(subChatId, oldName || 'New Chat');
    }
  }, []);
}
