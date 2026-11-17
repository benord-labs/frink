/**
 * FolderRowMeta - the right side of a project row: which split panes its chats are open in and its
 * activity dot (both collapsed-only, since expanded rows carry them per chat), then the chat count.
 * Single view has no pane numbers, so there a chat icon marks the project holding the open chat.
 */

import { useAtomValue } from 'jotai';
import { MessageSquare } from 'lucide-react';
import { useMemo } from 'react';
import { getPaneColor } from '@/lib/pane-colors';
import { cn } from '../../../../../lib/utils';
import { selectedAgentChatIdAtom } from '../../../../../lib/atoms/agent-navigation-atoms';
import type { ChatItem } from '../../types';
import type { FolderActiveState } from '../../utils';

type FolderRowMetaProps = {
  isExpanded: boolean;
  chats: readonly Pick<ChatItem, 'id'>[];
  /** Map of chatId → 1-indexed pane number; absent in single view, which has no pane numbers */
  chatPaneMap?: Map<string, number>;
  folderState: FolderActiveState | null;
  totalChats: number;
};

export function FolderRowMeta({
  isExpanded,
  chats,
  chatPaneMap,
  folderState,
  totalChats,
}: FolderRowMetaProps) {
  const paneNumbers = useMemo(() => {
    if (isExpanded || !chatPaneMap) return [];
    return chats.flatMap((chat) => chatPaneMap.get(chat.id) ?? []).sort((a, b) => a - b);
  }, [isExpanded, chats, chatPaneMap]);
  const openChatId = useAtomValue(selectedAgentChatIdAtom);
  const holdsOpenChat = !isExpanded && !chatPaneMap && chats.some((chat) => chat.id === openChatId);

  return (
    <span className="flex items-center gap-1.5">
      {holdsOpenChat && (
        <MessageSquare
          role="img"
          aria-label="Open chat is in this project"
          className="h-3 w-3 text-primary"
        />
      )}
      {paneNumbers.length > 0 && (
        // One neutral chip with pane-coloured digits: a boxed badge per pane outweighed the project
        // name and its colours clashed with the activity dot beside it.
        <span
          className="inline-flex h-4 items-center gap-1 rounded bg-foreground/[0.06] px-1 text-xs leading-none font-semibold tabular-nums"
          title={`Open in pane${paneNumbers.length > 1 ? 's' : ''} ${paneNumbers.join(', ')}`}
        >
          <span className="sr-only">Open in pane </span>
          {paneNumbers.map((paneNumber) => (
            <span key={paneNumber} className={getPaneColor(paneNumber - 1).badgeText}>
              {paneNumber}
            </span>
          ))}
        </span>
      )}
      {folderState && (
        <span
          role="img"
          aria-label={`${folderState.label}: ${folderState.count}`}
          title={`${folderState.label}: ${folderState.count}`}
          className={cn('h-1.5 w-1.5 shrink-0 rounded-full', folderState.dotClassName)}
        />
      )}
      <span className="text-xs tabular-nums text-muted-foreground/60">{totalChats}</span>
    </span>
  );
}
