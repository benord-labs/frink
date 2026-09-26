import type { ReactNode } from 'react';
import {
  ContextMenu,
  ContextMenuContent,
  ContextMenuItem,
  ContextMenuTrigger,
} from '@/components/ui/context-menu';
import { FilePlus, FolderPlus } from 'lucide-react';
import { useContextMenuFocusHandoff } from '@/hooks/use-context-menu-focus-handoff';

type Props = {
  /** Called with the kind to create; the caller renders the inline input in response. */
  onCreate: (type: 'file' | 'folder') => void;
  /** The right-clickable file tree container, rendered as the menu trigger. */
  children: ReactNode;
};

/**
 * Right-click menu for empty space in a file tree, offering root-level create actions.
 *
 * Owns the focus handoff so callers cannot forget it: Radix refocuses its trigger when a
 * menu closes, which would steal focus from the inline input that `onCreate` mounts. Marking
 * the close before invoking `onCreate` suppresses that refocus for exactly one close.
 *
 * Shared by the sidebar and split-pane file trees, which render identical root menus.
 */
export function RootCreateContextMenu({ onCreate, children }: Props) {
  const { markNextCloseForInputFocus, handleCloseAutoFocus } = useContextMenuFocusHandoff();

  const startCreate = (type: 'file' | 'folder') => {
    markNextCloseForInputFocus();
    onCreate(type);
  };

  return (
    <ContextMenu>
      <ContextMenuTrigger asChild>{children}</ContextMenuTrigger>
      <ContextMenuContent className="w-52" onCloseAutoFocus={handleCloseAutoFocus}>
        <ContextMenuItem onSelect={() => startCreate('file')}>
          <FilePlus className="mr-2 size-4" />
          New File...
        </ContextMenuItem>
        <ContextMenuItem onSelect={() => startCreate('folder')}>
          <FolderPlus className="mr-2 size-4" />
          New Folder...
        </ContextMenuItem>
      </ContextMenuContent>
    </ContextMenu>
  );
}
