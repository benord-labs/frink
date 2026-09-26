import { PencilLine } from 'lucide-react';
import type { ReactElement } from 'react';
import { ContextMenuItem, ContextMenuSeparator } from '@/components/ui/context-menu';
import { Hint } from '../Hint';

/** Rename — single-selection only, when a rename handler is available. */
export function RenameItem({
  show,
  hint,
  onRename,
}: {
  show: boolean;
  hint: string;
  onRename?: () => void;
}): ReactElement | null {
  if (!show || !onRename) return null;
  return (
    <>
      <ContextMenuSeparator />
      <ContextMenuItem onClick={onRename}>
        <PencilLine className="mr-2 size-4" />
        Rename
        <Hint text={hint} />
      </ContextMenuItem>
    </>
  );
}
