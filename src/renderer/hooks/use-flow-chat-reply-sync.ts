/**
 * Listens for flow Chat Reply persistence notifications from the main process
 * and invalidates agent chat + sub-chat message queries so the open chat updates.
 */

import { useEffect } from 'react';
import { trpc } from '../lib/trpc';
import { isDesktopApp } from '../lib/utils/platform';

export function useFlowChatReplySync(): void {
  const utils = trpc.useUtils();

  useEffect(() => {
    if (!isDesktopApp()) return;
    if (!window.desktopApi?.onSocketFlowChatReply) return;

    const unsubscribe = window.desktopApi.onSocketFlowChatReply((payload) => {
      void utils.chats.get.invalidate({ id: payload.chatId });
      void utils.chats.getSubChatMessages.invalidate({ subChatId: payload.subChatId });
    });

    return unsubscribe;
  }, [utils.chats.get, utils.chats.getSubChatMessages]);
}
