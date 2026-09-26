import { useEffect } from 'react';

/**
 * Shared hook for global file-tree keyboard shortcuts.
 *
 * Registers three shortcuts on the `window` keydown event (capture phase):
 * - CMD+Shift+N      → new file
 * - CMD+Shift+Opt+N  → new folder
 * - CMD+Backspace     → delete selected file/folder
 *
 * If the file tree is closed when a creation shortcut fires, it will be
 * auto-opened before starting the action. Delete requires a selected node
 * and an open tree.
 *
 * Used by both `FilesSidebar` (single-pane) and `SplitViewContainer`
 * (active pane in split view).
 */

type UseFileTreeShortcutsParams = {
  /** Absolute project path — shortcuts are disabled when falsy. */
  projectPath: string | undefined;
  /** Whether the file tree panel is currently open/visible. */
  isOpen: boolean;
  /** Callback to open the file tree panel when it's closed. */
  onOpen: () => void;
  /** Callback to start inline creation of a file or folder at root level. */
  onSetRootCreating: (type: 'file' | 'folder') => void;
  /** Callback to delete the currently selected file/folder. */
  onDeleteFile: (path: string) => void;
  /** Currently selected node (needed for delete shortcut). */
  selectedNodePath: string | null;
  /** Whether an inline input (rename/create) is currently active — shortcuts are suppressed. */
  isInlineActive: boolean;
  /** Ref to the tree container element — will be focused after creation starts. */
  treeContainerRef: React.RefObject<HTMLElement | null>;
  /** Callback to batch-delete multiple selected paths. */
  onBatchDelete?: (paths: string[]) => void;
  /** Get all selected paths for batch operations. */
  getSelectedPaths?: () => string[];
};

export function useFileTreeHotkeys({
  projectPath,
  isOpen,
  onOpen,
  onSetRootCreating,
  onDeleteFile,
  selectedNodePath,
  isInlineActive,
  treeContainerRef,
  onBatchDelete,
  getSelectedPaths,
}: UseFileTreeShortcutsParams): void {
  useEffect(() => {
    // Shortcuts require a project to target
    if (!projectPath) return;

    const handleGlobalFileShortcut = (e: KeyboardEvent) => {
      // Skip if an inline input is active
      if (isInlineActive) return;

      const isMeta = e.metaKey || e.ctrlKey;
      const isShift = e.shiftKey;
      const isAlt = e.altKey;

      // Cmd+Backspace: Delete selected file(s)/folder(s)
      if (isMeta && e.key === 'Backspace' && isOpen) {
        const paths = getSelectedPaths?.() ?? [];
        if (paths.length > 1 && onBatchDelete) {
          e.preventDefault();
          e.stopPropagation();
          onBatchDelete(paths);
          return;
        }
        if (selectedNodePath) {
          e.preventDefault();
          e.stopPropagation();
          onDeleteFile(selectedNodePath);
          return;
        }
      }

      // Use e.code for letter keys — Alt transforms e.key on macOS (e.g. Alt+N → ñ)

      // Cmd+Shift+Opt+N: New folder (check first — more specific combo)
      if (isMeta && isShift && isAlt && e.code === 'KeyN') {
        e.preventDefault();
        e.stopPropagation();
        if (!isOpen) onOpen();
        onSetRootCreating('folder');
        treeContainerRef.current?.focus();
        return;
      }

      // Cmd+Shift+N: New file
      if (isMeta && isShift && !isAlt && e.code === 'KeyN') {
        e.preventDefault();
        e.stopPropagation();
        if (!isOpen) onOpen();
        onSetRootCreating('file');
        treeContainerRef.current?.focus();
        return;
      }
    };

    window.addEventListener('keydown', handleGlobalFileShortcut, true);
    return () => window.removeEventListener('keydown', handleGlobalFileShortcut, true);
  }, [
    projectPath,
    isOpen,
    onOpen,
    onSetRootCreating,
    onDeleteFile,
    selectedNodePath,
    isInlineActive,
    treeContainerRef,
    onBatchDelete,
    getSelectedPaths,
  ]);
}
