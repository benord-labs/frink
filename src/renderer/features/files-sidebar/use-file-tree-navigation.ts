import { useCallback, useEffect } from 'react';
import type { FileTreeSelection } from './types';
import { scrollTreeNodeIntoView } from './utils/scroll-tree-node-into-view';

type FileTreeKeyboardCallbacks = {
  /** Currently selected node */
  selectedNode: FileTreeSelection;
  /** Lazily compute the ordered list of visible node paths from the DOM. */
  getVisiblePaths: () => string[];
  /** Whether an inline input is currently active (create/rename) */
  isInlineActive: boolean;
  /** Set the selected node by path */
  onSelectByPath: (path: string) => void;
  /** Clear selection */
  onClearSelection: () => void;
  /** Start rename for the selected node */
  onStartRename: (path: string) => void;
  /** Duplicate the selected file/folder */
  onDuplicate: (path: string) => void;
  /** Copy the selected path to internal clipboard */
  onCopy: (path: string) => void;
  /** Expand a folder node */
  onExpand: (path: string) => void;
  /** Collapse a folder node */
  onCollapse: (path: string) => void;
  /** Get the expanded state of a folder */
  isExpanded: (path: string) => boolean;
  /** Open a file in the editor */
  onOpenFile: (path: string) => void;
  /** Extend selection range (Shift+Arrow) — if provided, enables multi-select */
  onExtendSelection?: (toPath: string) => void;
  /** Select all visible paths (Cmd+A) */
  onSelectAll?: () => void;
};

/**
 * Context-dependent keyboard shortcuts for the file tree.
 * Only fires when the tree container has focus.
 *
 * Handles: Rename (Enter/F2), Duplicate (Cmd+D), Copy (Cmd+C), Paste (Cmd+V),
 *          Arrow navigation, Space (open/toggle), Escape (clear selection).
 *
 * Global file shortcuts (Cmd+Backspace, Cmd+Shift+N, Cmd+Shift+Opt+N) are
 * handled separately in FilesSidebar via a window-level listener.
 */
export function useFileTreeNavigation(
  containerRef: React.RefObject<HTMLDivElement | null>,
  callbacks: FileTreeKeyboardCallbacks,
) {
  const {
    selectedNode,
    getVisiblePaths,
    isInlineActive,
    onSelectByPath,
    onClearSelection,
    onStartRename,
    onDuplicate,
    onCopy,
    onExpand,
    onCollapse,
    isExpanded,
    onOpenFile,
    onExtendSelection,
    onSelectAll,
  } = callbacks;

  // biome-ignore lint/correctness/useExhaustiveDependencies: containerRef is a stable ref — .current is read at call time
  const handleKeyDown = useCallback(
    (e: KeyboardEvent) => {
      // Don't handle keys when an inline input is active
      if (isInlineActive) return;

      // Don't handle if target is an input element (e.g. search)
      const target = e.target as HTMLElement;
      if (target.tagName === 'INPUT' || target.tagName === 'TEXTAREA') return;

      const isMeta = e.metaKey || e.ctrlKey;
      const isShift = e.shiftKey;
      const isAlt = e.altKey;

      // --- Enter or F2: Rename ---
      if ((e.key === 'Enter' || e.key === 'F2') && !isMeta && !isShift && selectedNode) {
        e.preventDefault();
        e.stopPropagation();
        onStartRename(selectedNode.path);
        return;
      }

      // --- Cmd+D: Duplicate ---
      if (isMeta && !isShift && e.key.toLowerCase() === 'd' && selectedNode) {
        e.preventDefault();
        e.stopPropagation();
        onDuplicate(selectedNode.path);
        return;
      }

      // --- Cmd+C: Copy ---
      if (isMeta && !isShift && e.key.toLowerCase() === 'c' && selectedNode) {
        e.preventDefault();
        e.stopPropagation();
        onCopy(selectedNode.path);
        return;
      }

      // Cmd+V is handled by the paste event on the tree container so both external
      // (clipboard file URIs) and internal (copied path) paste can be supported.

      // --- Escape: Clear selection ---
      if (e.key === 'Escape') {
        e.preventDefault();
        e.stopPropagation();
        onClearSelection();
        return;
      }

      // --- Cmd+A: Select all ---
      if (isMeta && !isShift && e.key.toLowerCase() === 'a' && onSelectAll) {
        e.preventDefault();
        e.stopPropagation();
        onSelectAll();
        return;
      }

      // --- Arrow key navigation (with optional Shift for multi-select) ---
      if (!isMeta && !isAlt) {
        // Compute visible paths lazily from the DOM (avoids stale memoized arrays)
        const visiblePaths = getVisiblePaths();
        const currentIndex = selectedNode ? visiblePaths.indexOf(selectedNode.path) : -1;
        const container = containerRef.current;

        switch (e.key) {
          case 'ArrowDown': {
            e.preventDefault();
            e.stopPropagation();
            const nextIndex = currentIndex + 1;
            if (nextIndex < visiblePaths.length) {
              const nextPath = visiblePaths[nextIndex];
              if (isShift && onExtendSelection) {
                onExtendSelection(nextPath);
              } else {
                onSelectByPath(nextPath);
              }
              scrollTreeNodeIntoView(container, nextPath);
            } else if (visiblePaths.length > 0 && currentIndex === -1) {
              onSelectByPath(visiblePaths[0]);
              scrollTreeNodeIntoView(container, visiblePaths[0]);
            }
            return;
          }
          case 'ArrowUp': {
            e.preventDefault();
            e.stopPropagation();
            const prevIndex = currentIndex - 1;
            if (prevIndex >= 0) {
              const prevPath = visiblePaths[prevIndex];
              if (isShift && onExtendSelection) {
                onExtendSelection(prevPath);
              } else {
                onSelectByPath(prevPath);
              }
              scrollTreeNodeIntoView(container, prevPath);
            } else if (visiblePaths.length > 0 && currentIndex === -1) {
              const lastPath = visiblePaths[visiblePaths.length - 1];
              onSelectByPath(lastPath);
              scrollTreeNodeIntoView(container, lastPath);
            }
            return;
          }
          case 'ArrowRight': {
            if (selectedNode?.type !== 'folder') return;
            e.preventDefault();
            e.stopPropagation();
            if (!isExpanded(selectedNode.path)) {
              onExpand(selectedNode.path);
            } else {
              const childIndex = currentIndex + 1;
              if (childIndex < visiblePaths.length) {
                onSelectByPath(visiblePaths[childIndex]);
              }
            }
            return;
          }
          case 'ArrowLeft': {
            if (!selectedNode) return;
            e.preventDefault();
            e.stopPropagation();
            if (selectedNode.type === 'folder' && isExpanded(selectedNode.path)) {
              onCollapse(selectedNode.path);
            } else {
              const parentPath = selectedNode.path.includes('/')
                ? selectedNode.path.slice(0, selectedNode.path.lastIndexOf('/'))
                : '';
              if (parentPath) {
                onSelectByPath(parentPath);
              }
            }
            return;
          }
          case ' ': {
            if (isShift) return; // Don't handle Shift+Space
            if (!selectedNode) return;
            e.preventDefault();
            e.stopPropagation();
            if (selectedNode.type === 'file') {
              onOpenFile(selectedNode.path);
            } else {
              if (isExpanded(selectedNode.path)) {
                onCollapse(selectedNode.path);
              } else {
                onExpand(selectedNode.path);
              }
            }
            return;
          }
        }
      }
    },
    [
      selectedNode,
      getVisiblePaths,
      isInlineActive,
      onStartRename,
      onDuplicate,
      onCopy,
      onClearSelection,
      onSelectByPath,
      onExpand,
      onCollapse,
      isExpanded,
      onOpenFile,
      onExtendSelection,
      onSelectAll,
    ],
  );

  useEffect(() => {
    const container = containerRef.current;
    if (!container) return;

    container.addEventListener('keydown', handleKeyDown);
    return () => container.removeEventListener('keydown', handleKeyDown);
  }, [containerRef, handleKeyDown]);
}
