import { useCallback } from 'react';
import { useSubChatRenameAction } from '../../../hooks/use-sub-chat-rename-action';
import { useAgentSubChatStore } from '../../../stores/sub-chat-store';

/**
 * Reactive sub-chat name + a rename handler bound to the active sub-chat.
 * Persistence (optimistic update / revert / toast) is delegated to the shared
 * useSubChatRenameAction so this surface and the sub-chat tabs share one impl.
 */
export const useSubChatRename = (subChatId: string) => {
  const subChatName = useAgentSubChatStore((state) => state.subChatsById[subChatId]?.name || '');
  const renameSubChat = useSubChatRenameAction();
  const handleRenameSubChat = useCallback(
    (newName: string) => renameSubChat(subChatId, newName),
    [renameSubChat, subChatId],
  );

  return { subChatName, handleRenameSubChat };
};
