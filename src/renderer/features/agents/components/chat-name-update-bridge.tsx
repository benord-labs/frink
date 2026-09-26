import { useEffect } from 'react';
import { api } from '../../../lib/mock-api';
import { trpc } from '../../../lib/trpc';
import { useAgentSubChatStore } from '../stores/sub-chat-store';

type ChatNameUpdatedPayload = {
  chatId: string;
  subChatId: string;
  name: string;
};

function isPayload(data: unknown): data is ChatNameUpdatedPayload {
  return (
    !!data &&
    typeof data === 'object' &&
    typeof (data as { chatId?: unknown }).chatId === 'string' &&
    typeof (data as { subChatId?: unknown }).subChatId === 'string' &&
    typeof (data as { name?: unknown }).name === 'string'
  );
}

/**
 * Listens for `chats:name-updated` events emitted by the main process when the
 * naming pipeline (`autoNameSubChat`) resolves a chat's title. This is the
 * single propagation channel for both creation modes, so it updates every
 * surface the title appears on: the sidebar list/counts, the sub-chat tab
 * label store, and the active-chat header/sub-chat queries.
 */
export function ChatNameUpdateBridge() {
  const utils = trpc.useUtils();
  const apiUtils = api.useUtils();

  useEffect(() => {
    const desktopApi = window.desktopApi;
    if (!desktopApi?.on) return;

    return desktopApi.on('chats:name-updated', (data) => {
      if (!isPayload(data)) return;
      // Sub-chat tab label (separate Zustand store, not driven by the queries).
      useAgentSubChatStore.getState().updateSubChatName(data.subChatId, data.name);
      // Sidebar list + counts.
      void utils.chats.list.invalidate();
      void utils.chats.listCounts.invalidate();
      void utils.chats.get.invalidate({ id: data.chatId });
      // Batch-group rows also render the chat name; without these a renamed chat
      // keeps its old label in the batch summary (mirrors the sidebar's own rename).
      void utils.chats.listByBatch.invalidate();
      void utils.chats.listBatchGroups.invalidate();
      // Active-chat header + agents sidebar — refetch so the parent name is
      // truthful (only the first sub-chat renames the parent).
      void apiUtils.agents.getAgentChat.invalidate({ chatId: data.chatId });
      void apiUtils.agents.getAgentChats.invalidate();
    });
  }, [utils, apiUtils]);

  return null;
}
