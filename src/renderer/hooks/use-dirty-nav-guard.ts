/**
 * Shared navigation guard for agent chat navigation when the flow editor may have
 * unsaved changes. Used by BatchRunRowItem and BatchPlanCanvasInner.
 *
 * Navigation order (per memory note): dirty=false → overlay=null → chatId.
 * This is enforced by navigateToAgentChatAtom — callers only need to pass a chatId.
 */

import { useAtomValue, useSetAtom } from 'jotai';
import { useCallback, useState } from 'react';
import { flowEditorDirtyAtom, navigateToAgentChatAtom } from '../lib/atoms';

type DirtyNavGuard = {
  showDialog: boolean;
  requestNav: (chatId: string) => void;
  confirmNav: () => void;
  cancelNav: () => void;
};

export function useDirtyNavGuard(): DirtyNavGuard {
  const isDirty = useAtomValue(flowEditorDirtyAtom);
  const navigateToChat = useSetAtom(navigateToAgentChatAtom);
  const [showDialog, setShowDialog] = useState(false);
  const [pendingChatId, setPendingChatId] = useState<string | null>(null);

  const requestNav = useCallback(
    (chatId: string) => {
      if (isDirty) {
        setPendingChatId(chatId);
        setShowDialog(true);
      } else {
        navigateToChat(chatId);
      }
    },
    [isDirty, navigateToChat],
  );

  const confirmNav = useCallback(() => {
    if (pendingChatId) navigateToChat(pendingChatId);
    setShowDialog(false);
    setPendingChatId(null);
  }, [pendingChatId, navigateToChat]);

  const cancelNav = useCallback(() => {
    setShowDialog(false);
    setPendingChatId(null);
  }, []);

  return { showDialog, requestNav, confirmNav, cancelNav };
}
