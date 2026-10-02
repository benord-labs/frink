/**
 * FolderRowMeta - the right side of a project row: which split panes its chats are open in and its
 * activity dot (both collapsed-only, since expanded rows carry them per chat), then the chat count.
 */

import { useMemo } from 'react';
import { getPaneColor } from '@/lib/pane-colors';
import { cn } from '../../../../../lib/utils';
import type { ChatItem } from '../../types';
import type { FolderActiveState } from '../../utils';

type FolderRowMetaProps = {
  isExpanded: boolean;
  chats: readonly ChatItem[];
  /** Map of chatId → 1-indexed pane number */
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

  return (
    <span className="flex items-center gap-1.5">
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
