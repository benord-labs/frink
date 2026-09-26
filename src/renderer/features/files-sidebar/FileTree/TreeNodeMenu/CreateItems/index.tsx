import type { ReactElement } from 'react';
import { ContextMenuItem, ContextMenuSeparator } from '@/components/ui/context-menu';
import { FilePlus, FolderPlus } from 'lucide-react';

/** New File / New Folder — offered only for single-selected folders. */
export function CreateItems({
  show,
  onNewFile,
  onNewFolder,
}: {
  show: boolean;
  onNewFile: () => void;
  onNewFolder: () => void;
}): ReactElement | null {
  if (!show) return null;
  return (
    <>
      <ContextMenuItem onSelect={onNewFile}>
        <FilePlus className="mr-2 size-4" />
        New File...
      </ContextMenuItem>
      <ContextMenuItem onSelect={onNewFolder}>
        <FolderPlus className="mr-2 size-4" />
        New Folder...
      </ContextMenuItem>
      <ContextMenuSeparator />
    </>
  );
}
