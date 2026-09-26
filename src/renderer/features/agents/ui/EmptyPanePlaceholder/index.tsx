/**
 * EmptyPanePlaceholder - Shown in split panes that haven't been filled yet (null chatId).
 *
 * Displays a prompt to select an existing chat or start a new one.
 * Clicking "New Chat" transitions the pane to NEW_CHAT_PANE (shows NewChatForm).
 * Clicking an existing chat in the sidebar fills the pane via fillActivePane.
 */

import { Button } from '@benord-labs/frink-primitives';
import { useSetAtom } from 'jotai';
import { MessageSquarePlus } from 'lucide-react';
import { memo, useCallback } from 'react';
import { NEW_CHAT_PANE, type SplitViewState, splitViewAtom } from '../../atoms';

type EmptyPanePlaceholderProps = {
  paneIndex: number;
};

function EmptyPanePlaceholderComponent({ paneIndex }: EmptyPanePlaceholderProps) {
  const setSplitView = useSetAtom(splitViewAtom);

  const handleNewChat = useCallback(() => {
    setSplitView((prev: SplitViewState) => {
      if (paneIndex < 0 || paneIndex >= prev.chatIds.length) return prev;
      if (prev.chatIds[paneIndex] !== null) return prev;
      const newChatIds = [...prev.chatIds];
      newChatIds[paneIndex] = NEW_CHAT_PANE;
      return { ...prev, chatIds: newChatIds, activePaneIndex: paneIndex };
    });
  }, [setSplitView, paneIndex]);

  return (
    <div className="flex flex-col items-center justify-center h-full gap-4 px-4 text-muted-foreground">
      <p className="text-sm font-medium select-none text-center text-balance leading-relaxed">
        Select a chat from the sidebar or start a new one
      </p>
      <Button
        variant="secondary"
        size="sm"
        className="gap-1.5 touch-target-h7"
        onClick={handleNewChat}
      >
        <MessageSquarePlus className="h-3.5 w-3.5" />
        New Chat
      </Button>
    </div>
  );
}

export const EmptyPanePlaceholder = memo(EmptyPanePlaceholderComponent);
