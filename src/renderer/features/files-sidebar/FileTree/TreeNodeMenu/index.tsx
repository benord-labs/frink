import type { ReactElement } from 'react';
import { ContextMenuItem, ContextMenuSeparator } from '@/components/ui/context-menu';
import { Clipboard, Folder } from 'lucide-react';
import { getShortcutAction, keysToDisplay } from '@/lib/hotkeys/shortcut-registry';
import { getRevealLabel } from '@/lib/utils/platform';
import { useIsSelected, useSelectionCount, useSelectionStore } from '../MultiSelectContext';
import { useReadOnlyTree } from '../ReadOnlyContext';
import { AddToChatItem } from './AddToChatItem';
import { CopyPasteItems } from './CopyPasteItems';
import { CreateItems } from './CreateItems';
import { DeleteItem } from './DeleteItem';
import { RenameItem } from './RenameItem';

/** Resolve a shortcut hint from the registry (computed at render so mocks/config apply). */
function shortcutHint(
  actionId: 'file-copy' | 'file-paste' | 'file-rename',
  useAlt = false,
): string {
  const action = getShortcutAction(actionId);
  const keys = useAlt ? action?.altKeys : action?.defaultKeys;
  return keys ? keysToDisplay(keys) : '';
}

/** Labels + shortcut hints for the menu, derived from the current selection mode. */
function getMenuText(isBatch: boolean, count: number) {
  return {
    copyPathLabel: isBatch ? `Copy ${count} Paths` : 'Copy Path',
    copyRelLabel: isBatch ? `Copy ${count} Relative Paths` : 'Copy Relative Path',
    revealLabel: getRevealLabel(isBatch ? count : undefined),
    copyHint: shortcutHint('file-copy'),
    pasteHint: shortcutHint('file-paste'),
    renameHint: shortcutHint('file-rename', true),
  };
}

type Props = {
  /** The node this menu belongs to; its path checks its own selected-bit */
  node: { path: string; type: 'file' | 'folder' };
  hasCopiedItem?: boolean;
  /** Whether "New File/Folder" may be offered (folder + create handler present) */
  canCreate: boolean;
  /** Whether a delete action may be offered */
  canDelete: boolean;
  onNewFile: () => void;
  onNewFolder: () => void;
  onCopyPath: () => void;
  onCopyRelativePath: () => void;
  onRevealInFinder: () => void;
  onCopyItem: () => void;
  onPasteItem: () => void;
  onDelete: () => void;
  /** Bound to this node's path; absent when rename isn't available */
  onRename?: () => void;
  /** Batch delete callback for multi-selection */
  onBatchDelete?: (paths: string[]) => void;
};

/**
 * Context-menu body for a TreeNode. Rendered inside `<ContextMenuContent>`, which
 * Radix mounts only while the menu is open — so this is the ONLY place that
 * subscribes to the selection count. That keeps count-dependent labels fresh
 * without every tree node re-rendering on selection changes.
 */
export function TreeNodeMenu({
  node,
  hasCopiedItem,
  canCreate,
  canDelete,
  onNewFile,
  onNewFolder,
  onCopyPath,
  onCopyRelativePath,
  onRevealInFinder,
  onCopyItem,
  onPasteItem,
  onDelete,
  onRename,
  onBatchDelete,
}: Props): ReactElement {
  const store = useSelectionStore();
  const count = useSelectionCount();
  const isBatch = useIsSelected(node.path) && count > 1;
  // FileTree always hands rows a create handler, and Copy only feeds Paste, so a read-only tree
  // hides both here; Rename and Delete go with their missing handlers. Add to Chat is hidden too:
  // its paths are relative to the chat's own project, not to the project a read-only tree shows.
  const readOnly = useReadOnlyTree();
  const text = getMenuText(isBatch, count);

  return (
    <>
      <CreateItems
        show={canCreate && !isBatch && !readOnly}
        onNewFile={onNewFile}
        onNewFolder={onNewFolder}
      />
      <ContextMenuItem onClick={onCopyPath}>
        <Clipboard className="mr-2 size-4" />
        {text.copyPathLabel}
      </ContextMenuItem>
      <ContextMenuItem onClick={onCopyRelativePath}>
        <Clipboard className="mr-2 size-4" />
        {text.copyRelLabel}
      </ContextMenuItem>
      {!readOnly && <AddToChatItem node={node} isBatch={isBatch} count={count} store={store} />}
      <CopyPasteItems
        show={!isBatch && !readOnly}
        hasCopiedItem={hasCopiedItem}
        copyHint={text.copyHint}
        pasteHint={text.pasteHint}
        onCopyItem={onCopyItem}
        onPasteItem={onPasteItem}
      />
      <ContextMenuSeparator />
      <ContextMenuItem onClick={onRevealInFinder}>
        <Folder className="mr-2 size-4" />
        {text.revealLabel}
      </ContextMenuItem>
      <RenameItem show={!isBatch} hint={text.renameHint} onRename={onRename} />
      <DeleteItem
        show={canDelete}
        isBatch={isBatch}
        count={count}
        store={store}
        onBatchDelete={onBatchDelete}
        onDelete={onDelete}
      />
    </>
  );
}
