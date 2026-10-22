import { useStore } from 'jotai';
import { useEffect } from 'react';
import { chatModeAtomFamily } from '../features/agents/atoms';
import { useAgentSubChatStore } from '../features/agents/stores/sub-chat-store';
import { isDesktopApp } from '../lib/utils/platform';

/**
 * Listens for main-process notifications that a sub-chat's mode changed mid-session
 * (e.g. model called EnterPlanMode and frink flipped agent → plan) and updates the
 * renderer atoms + sub-chat store so the input-bar toggle stays in sync.
 */
export function useSubChatModeSync(): void {
  const store = useStore();

  useEffect(() => {
    if (!isDesktopApp()) return;
    if (!window.desktopApi?.onSubChatModeChanged) return;

    return window.desktopApi.onSubChatModeChanged(({ chatId, subChatId, mode }) => {
      // Mirrors ONLY — echoes never touch the pending intent (cleared solely by correlated CAS
      // acks; see mode-intent.ts). A chat has one sub-chat, so its footer atom always follows.
      useAgentSubChatStore.getState().updateSubChatMode(subChatId, mode, chatId);
      store.set(chatModeAtomFamily(chatId), mode);
    });
  }, [store]);
}
