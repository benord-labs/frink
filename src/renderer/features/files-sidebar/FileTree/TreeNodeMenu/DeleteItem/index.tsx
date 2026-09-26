import type { ReactElement } from 'react';
import { ContextMenuItem, ContextMenuSeparator } from '@/components/ui/context-menu';
import { Trash2 } from 'lucide-react';
import type { SelectionStore } from '../../use-multi-select';

/** Delete — batch variant when a >1 selection is active, single otherwise. */
export function DeleteItem({
  show,
  isBatch,
  count,
  store,
  onBatchDelete,
  onDelete,
}: {
  show: boolean;
  isBatch: boolean;
  count: number;
  store: SelectionStore;
  onBatchDelete?: (paths: string[]) => void;
  onDelete: () => void;
}): ReactElement | null {
  if (!show) return null;
  const batch = isBatch && onBatchDelete;
  return (
    <>
      <ContextMenuSeparator />
      <ContextMenuItem
        onClick={batch ? () => onBatchDelete(Array.from(store.getSnapshot().paths)) : onDelete}
        className="text-destructive focus:text-destructive"
      >
        <Trash2 className="mr-2 size-4" />
        {batch ? `Delete ${count} items` : 'Delete'}
      </ContextMenuItem>
    </>
  );
}
