/** Cmd/Shift-click multi-selection of sidebar chat rows, and the chip that acts on it. */

import { Button } from '@benord-labs/frink-primitives';
import { Archive, Trash2, X } from 'lucide-react';
import {
  createContext,
  type MouseEvent,
  memo,
  type ReactElement,
  useCallback,
  useContext,
  useEffect,
  useSyncExternalStore,
} from 'react';
import { ConfirmDialog } from '../../../../../components/ui/confirm-dialog';
import { createIdSelectionStore, type IdSelectionStore } from '../../../../../lib/tree-navigation';
import { getVisibleItems } from '../../hooks/use-sidebar-navigation';

export const ChatSelectionContext = createContext<IdSelectionStore>(createIdSelectionStore());

/** Cmd/Ctrl+click toggles, Shift+click selects the visible range, a plain click opens the chat.
 * An unmounted row (collapsed, filtered, deleted) leaves the selection: bulk actions hit only visible rows. */
export function useChatRowSelection(chatId: string, open: (chatId: string) => void) {
  const store = useContext(ChatSelectionContext);
  const isMultiSelected = useSyncExternalStore(store.subscribe, () => store.isSelected(chatId));
  useEffect(() => () => store.deselect(chatId), [store, chatId]);

  const onClick = useCallback(
    (event: MouseEvent<HTMLElement>) => {
      if (event.metaKey || event.ctrlKey) return store.toggle(chatId);
      const tree = event.currentTarget.closest<HTMLElement>('[role="tree"]');
      if (event.shiftKey && tree) {
        const chatIds = getVisibleItems(tree).flatMap((item) =>
          item.type === 'chat' ? [item.id] : [],
        );
        return store.selectRange(chatId, chatIds);
      }
      store.clear(chatId);
      open(chatId);
    },
    [store, chatId, open],
  );

  return { isMultiSelected, onClick };
}

/** Count badge on the drag ghost when the dragged row carries the rest of the selection along. */
export function ChatSelectionDragBadge({ chatId }: { chatId: string }): ReactElement | null {
  const store = useContext(ChatSelectionContext);
  const selection = useSyncExternalStore(store.subscribe, store.getSnapshot);
  if (selection.size < 2 || !selection.has(chatId)) return null;
  return (
    <span className="absolute -top-1.5 right-1 rounded-full bg-primary px-1.5 text-[10px] font-medium leading-4 text-primary-foreground">
      {selection.size}
    </span>
  );
}

export type ChatSelectionChipProps = {
  onArchive: (chatIds: string[]) => Promise<void>;
  onDelete: (chatIds: string[]) => Promise<void>;
  pendingDeleteCount: number;
  onConfirmDelete: () => Promise<void>;
  onCancelDelete: () => void;
};

export const ChatSelectionChip = memo(function ChatSelectionChip({
  onArchive,
  onDelete,
  pendingDeleteCount,
  onConfirmDelete,
  onCancelDelete,
}: ChatSelectionChipProps): ReactElement {
  const store = useContext(ChatSelectionContext);
  const selection = useSyncExternalStore(store.subscribe, store.getSnapshot);
  const plural = pendingDeleteCount === 1 ? '' : 's';

  return (
    <>
      {selection.size > 0 && (
        <div
          role="toolbar"
          aria-label="Selected chats"
          className="mx-2 mb-1 flex items-center gap-0.5 rounded-md bg-primary/10 py-0.5 pl-2.5 pr-0.5 text-xs"
        >
          <span className="flex-1 font-medium text-foreground">{selection.size} selected</span>
          <Button variant="ghost" size="sm" onClick={() => void onArchive([...selection])}>
            <Archive className="h-3.5 w-3.5" />
            Archive
          </Button>
          <Button
            variant="ghost"
            size="sm"
            className="text-destructive hover:text-destructive"
            onClick={() => void onDelete([...selection])}
          >
            <Trash2 className="h-3.5 w-3.5" />
            Delete
          </Button>
          <Button
            variant="ghost"
            size="icon"
            aria-label="Clear selection"
            onClick={() => store.clear()}
          >
            <X className="h-3.5 w-3.5" />
          </Button>
        </div>
      )}
      <ConfirmDialog
        open={pendingDeleteCount > 0}
        onOpenChange={(open) => !open && onCancelDelete()}
        onConfirm={() => void onConfirmDelete()}
        title={`Delete ${pendingDeleteCount} chat${plural} permanently?`}
        description="Their messages and worktrees are removed. This cannot be undone."
      />
    </>
  );
});
