/**
 * ArchivedChatsSection - Shows archived chats when toggled
 */

import { Button } from '@benord-labs/frink-primitives';
import { Archive, RotateCcw, Trash2 } from 'lucide-react';
import { memo, type ReactElement, useRef, useState } from 'react';
import { ConfirmDialog } from '../../../../../components/ui/confirm-dialog';
import { Tooltip, TooltipContent, TooltipTrigger } from '../../../../../components/ui/tooltip';
import { cn } from '../../../../../lib/utils';
import { STRINGS, TIMING } from '../../constants';

const EMPTY_DELETING_IDS: ReadonlySet<string> = new Set();

type ArchivedChatsSectionProps = {
  archivedChats: Array<{ id: string; name: string | null }>;
  /** Sidebar search query. Matches on name only — the sole field an archived row renders. */
  searchQuery: string;
  selectedChatId: string | null;
  onChatSelect: (chatId: string) => void;
  onChatRestore: (chatId: string) => void;
  /** Permanently deletes the chat. Confirmed by this section's dialog before it fires. */
  onChatDelete: (chatId: string) => void | Promise<void>;
};

function ArchivedChatsSectionComponent({
  archivedChats,
  searchQuery,
  selectedChatId,
  onChatSelect,
  onChatRestore,
  onChatDelete,
}: ArchivedChatsSectionProps): ReactElement {
  const query = searchQuery.trim().toLowerCase();
  const visibleChats = query
    ? archivedChats.filter((chat) => chat.name?.toLowerCase().includes(query))
    : archivedChats;

  const rootRef = useRef<HTMLDivElement>(null);
  const [pendingDelete, setPendingDelete] = useState<{
    id: string;
    name: string;
  } | null>(null);
  // Deleting awaits a linked-task lookup before anything visible happens, so the row's trash is
  // held disabled across that gap: without it the click reads as dead and fires twice. Tracked
  // per row, since deletes overlap and one finishing must not re-arm another still in flight.
  const [deletingIds, setDeletingIds] = useState<ReadonlySet<string>>(EMPTY_DELETING_IDS);

  const confirmDelete = async (chatId: string): Promise<void> => {
    setDeletingIds((prev) => new Set(prev).add(chatId));
    try {
      await onChatDelete(chatId);
    } finally {
      setDeletingIds((prev) => {
        const next = new Set(prev);
        next.delete(chatId);
        return next;
      });
    }
  };

  return (
    <div ref={rootRef} tabIndex={-1} className="px-2 py-2 border-t border-border/30 outline-none">
      {/* Count stays the archive total while filtering, so it agrees with the footer badge. */}
      <div className="text-xs font-medium text-muted-foreground mb-2 px-2">
        Archived ({archivedChats.length})
      </div>
      {visibleChats.length === 0 ? (
        <div role="note" className="py-1.5 px-2 text-xs text-muted-foreground/50 italic">
          {query ? 'No matches found' : 'No archived chats yet'}
        </div>
      ) : (
        <div className="space-y-0.5">
          {visibleChats.map((chat) => {
            const chatName = chat.name || STRINGS.UNTITLED_CHAT;
            return (
              <div key={chat.id} className="group flex items-center gap-1">
                <Tooltip delayDuration={TIMING.TOOLTIP_DELAY_MS}>
                  <TooltipTrigger asChild>
                    <Button
                      variant="ghost"
                      size="sm"
                      onClick={() => onChatSelect(chat.id)}
                      id={`sidebar-item-${chat.id}`}
                      role="treeitem"
                      aria-selected={selectedChatId === chat.id}
                      data-sidebar-item=""
                      data-item-type="chat"
                      data-item-id={chat.id}
                      className={cn(
                        'flex-1 justify-start gap-1.5 py-1 px-2 min-w-0',
                        'text-muted-foreground hover:text-foreground hover:bg-foreground/5',
                        'focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-1',
                        'opacity-60',
                        selectedChatId === chat.id && 'bg-foreground/10 text-foreground',
                      )}
                    >
                      <Archive className="h-3 w-3 shrink-0" />
                      <span className="truncate">{chatName}</span>
                    </Button>
                  </TooltipTrigger>
                  <TooltipContent side="right" className="text-xs max-w-72 break-all">
                    {chatName}
                  </TooltipContent>
                </Tooltip>

                <Tooltip delayDuration={TIMING.TOOLTIP_DELAY_MS}>
                  <TooltipTrigger asChild>
                    <Button
                      variant="ghost"
                      size="sm"
                      onClick={() => onChatRestore(chat.id)}
                      className={cn(
                        'shrink-0 text-muted-foreground hover:text-foreground',
                        'opacity-0 group-hover:opacity-100 group-focus-within:opacity-100',
                        'focus-visible:opacity-100 transition-opacity',
                        selectedChatId === chat.id && 'opacity-100',
                      )}
                      aria-label={`Restore ${chatName}`}
                      iconOnly
                    >
                      <RotateCcw className="h-3.5 w-3.5" />
                    </Button>
                  </TooltipTrigger>
                  <TooltipContent side="left" className="text-xs">
                    Restore chat
                  </TooltipContent>
                </Tooltip>

                <Tooltip delayDuration={TIMING.TOOLTIP_DELAY_MS}>
                  <TooltipTrigger asChild>
                    <Button
                      variant="ghost"
                      size="sm"
                      onClick={() => setPendingDelete({ id: chat.id, name: chatName })}
                      disabled={deletingIds.has(chat.id)}
                      className={cn(
                        'shrink-0 text-muted-foreground hover:text-destructive',
                        'opacity-0 group-hover:opacity-100 group-focus-within:opacity-100',
                        'focus-visible:opacity-100 transition-opacity',
                        selectedChatId === chat.id && 'opacity-100',
                      )}
                      aria-label={`Delete ${chatName}`}
                      iconOnly
                    >
                      <Trash2 className="h-3.5 w-3.5" />
                    </Button>
                  </TooltipTrigger>
                  <TooltipContent side="left" className="text-xs">
                    Delete permanently
                  </TooltipContent>
                </Tooltip>
              </div>
            );
          })}
        </div>
      )}

      {/*
        One dialog serves every row: a large archive would otherwise mount a dialog per row, and
        keeping the state here leaves UnifiedSidebar untouched. Confirming unmounts the trigger
        row, so focus is returned to this section rather than falling through to document.body.
      */}
      <ConfirmDialog
        open={pendingDelete !== null}
        onOpenChange={(open) => {
          if (!open) setPendingDelete(null);
        }}
        onConfirm={() => {
          if (pendingDelete) void confirmDelete(pendingDelete.id);
        }}
        onCloseAutoFocus={(event) => {
          event.preventDefault();
          rootRef.current?.focus();
        }}
        title={`Delete "${pendingDelete?.name ?? ''}" permanently?`}
        description="The chat, its history and its worktree will be removed."
      />
    </div>
  );
}

export const ArchivedChatsSection = memo(ArchivedChatsSectionComponent);
