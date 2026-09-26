/* eslint-disable max-lines, max-lines-per-function */
import { ChevronRight, Loader2, Files, Folder } from 'lucide-react';
import type { ReactElement } from 'react';
import { memo, useCallback, useEffect, useMemo, useState } from 'react';
import { toast } from 'sonner';
import { ContextMenu, ContextMenuContent, ContextMenuTrigger } from '@/components/ui/context-menu';
import { useContextMenuFocusHandoff } from '@/hooks/use-context-menu-focus-handoff';
import { trpc, trpcClient } from '@/lib/trpc';
import { cn } from '@/lib/utils';
import type { FileStatus } from '../../../../shared/changes-types';
import { getFileIconByExtension } from '../../agents/mentions/agents-file-mention';
import { getStatusBackgroundColor, getStatusColor } from '@/lib/utils/diff/git-file-status';
import { TREE_BASE_PADDING, TREE_CHEVRON_SPACER_PX, TREE_INDENT_WIDTH } from '../constants';
import type { CreatingItem, FileTreeNode } from '../types';
import { InlineInput } from './InlineInput';
import { useIsSelected, useSelectionActions, useSelectionStore } from './MultiSelectContext';
import { useModifiedFilter } from './modified-filter-context';
import { useRefreshTrigger } from './RefreshContext';
import { DragButton, DropRoot } from './TreeNode.dnd';
import { TreeNodeMenu } from './TreeNodeMenu';

/** Copy text to clipboard with toast feedback (module-level — no component deps) */
async function copyToClipboard(text: string, label: string): Promise<void> {
  try {
    await navigator.clipboard.writeText(text);
    toast.success(label);
  } catch {
    toast.error('Failed to copy to clipboard');
  }
}

export type TreeNodeDragData = {
  type: 'tree-node';
  nodePath: string;
  nodeType: 'file' | 'folder';
  nodeName: string;
  /** Absolute project path the node belongs to (for cross-project DnD) */
  projectPath: string;
  /** Split-pane source index when dragging inside shared split view */
  paneIndex?: number;
  /** Additional selected items when dragging from a multi-selection */
  batchItems?: Array<{ path: string; name: string; type: 'file' | 'folder' }>;
};

export type TreeNodeDropData = {
  type: 'tree-folder' | 'tree-root';
  folderPath: string;
  /** Absolute project path the drop target belongs to */
  projectPath: string;
};

type Props = {
  node: FileTreeNode;
  level: number;
  projectPath: string;
  /** Split-pane source index when dragging inside shared split view */
  paneIndex?: number;
  onFileClick: (path: string) => void;
  searchQuery?: string;
  /** Called when the user requests to create a new file/folder inside a folder */
  onCreateItem?: (parentFolder: string, type: 'file' | 'folder') => void;
  /** Called when the user requests to delete a file/folder */
  onDeleteItem?: (relativePath: string) => void;
  /** Current inline-create state (managed by FileTree) */
  creatingItem?: CreatingItem | null;
  /** Called when inline input confirms a name */
  onInlineConfirm?: (name: string) => void;
  /** Called when inline input is cancelled */
  onInlineCancel?: () => void;
  /** Called when a node is clicked to set it as selected */
  onSelect?: (path: string, name: string, type: 'file' | 'folder') => void;
  /** Path currently being renamed (shows inline input instead of label) */
  renamingPath?: string | null;
  /** Called when rename is confirmed */
  onRenameConfirm?: (newName: string) => void;
  /** Called when rename is cancelled */
  onRenameCancel?: () => void;
  /** Called to initiate rename on a node (from context menu) */
  onStartRename?: (path: string) => void;
  /** Called to copy a node path into the internal file-tree clipboard */
  onCopyItem?: (path: string) => void;
  /** Called to paste into a resolved destination folder */
  onPasteIntoFolder?: (targetFolder: string) => void;
  /** Whether internal file-tree clipboard currently has a copied item */
  hasCopiedItem?: boolean;
  /** When set, folder with this path should expand (e.g. after drop); parent clears after tick */
  pathToExpandAfterDrop?: string | null;
};

/** Get git status indicator letter and color (VS Code style) */
function getGitStatusIndicator(status?: FileStatus): {
  letter: string;
  className: string;
} | null {
  if (!status) return null;

  let letter: string;
  switch (status) {
    case 'added':
      letter = 'A';
      break;
    case 'modified':
      letter = 'M';
      break;
    case 'deleted':
      letter = 'D';
      break;
    case 'renamed':
      letter = 'R';
      break;
    case 'copied':
      letter = 'C';
      break;
    case 'untracked':
      letter = 'U';
      break;
    default:
      return null;
  }

  return {
    letter,
    className: getStatusColor(status),
  };
}

function getRevealPathForSubtree(nodePath: string, revealPath?: string | null): string | null {
  if (!revealPath) return null;
  return revealPath === nodePath || revealPath.startsWith(`${nodePath}/`) ? revealPath : null;
}

function areTreeNodePropsEqual(prev: Readonly<Props>, next: Readonly<Props>): boolean {
  return (
    prev.node === next.node &&
    prev.level === next.level &&
    prev.projectPath === next.projectPath &&
    prev.paneIndex === next.paneIndex &&
    prev.onFileClick === next.onFileClick &&
    prev.searchQuery === next.searchQuery &&
    prev.onCreateItem === next.onCreateItem &&
    prev.onDeleteItem === next.onDeleteItem &&
    prev.creatingItem === next.creatingItem &&
    prev.onInlineConfirm === next.onInlineConfirm &&
    prev.onInlineCancel === next.onInlineCancel &&
    prev.onSelect === next.onSelect &&
    prev.renamingPath === next.renamingPath &&
    prev.onRenameConfirm === next.onRenameConfirm &&
    prev.onRenameCancel === next.onRenameCancel &&
    prev.onStartRename === next.onStartRename &&
    prev.onCopyItem === next.onCopyItem &&
    prev.onPasteIntoFolder === next.onPasteIntoFolder &&
    prev.hasCopiedItem === next.hasCopiedItem &&
    getRevealPathForSubtree(prev.node.path, prev.pathToExpandAfterDrop) ===
      getRevealPathForSubtree(next.node.path, next.pathToExpandAfterDrop)
  );
}

export const TreeNode = memo(function TreeNode({
  node,
  level,
  projectPath,
  paneIndex,
  onFileClick,
  searchQuery,
  onCreateItem,
  onDeleteItem,
  creatingItem,
  onInlineConfirm,
  onInlineCancel,
  onSelect,
  renamingPath,
  onRenameConfirm,
  onRenameCancel,
  onStartRename,
  onCopyItem,
  onPasteIntoFolder,
  hasCopiedItem,
  pathToExpandAfterDrop,
}: Props): ReactElement | null {
  const showModifiedOnly = useModifiedFilter();
  // Stable store handle (never re-renders from context); subscribe only to this node's bit.
  const store = useSelectionStore();
  const isMultiSelected = useIsSelected(node.path);
  const { onModifiedClick, onBatchDelete, deselectDescendants } = useSelectionActions();
  const { markNextCloseForInputFocus, handleCloseAutoFocus } = useContextMenuFocusHandoff();
  const [isExpanded, setIsExpanded] = useState(false);
  const [children, setChildren] = useState<FileTreeNode[] | undefined>(node.children);
  const [isLoading, setIsLoading] = useState(false);
  const [hasLoaded, setHasLoaded] = useState(node.childrenLoaded ?? false);
  const refreshTrigger = useRefreshTrigger();

  const isFolder = node.type === 'folder';
  const hasChildren = children && children.length > 0;

  // --- Drag-and-drop ---
  const draggableData = useMemo<TreeNodeDragData>(
    () => ({
      type: 'tree-node',
      nodePath: node.path,
      nodeType: node.type,
      nodeName: node.name,
      projectPath,
      paneIndex,
      // Live getter: this node may not re-render when the selection changes, so
      // snapshotting batchItems here would go stale. @dnd-kit keeps this data
      // object by reference and reads batchItems live at drag time — do not
      // spread/clone this object downstream or the getter freezes.
      get batchItems() {
        return store.getBatchDragItems(node.path);
      },
    }),
    [node.path, node.type, node.name, projectPath, paneIndex, store],
  );

  const droppableData = useMemo<TreeNodeDropData>(
    () => ({ type: 'tree-folder', folderPath: node.path, projectPath }),
    [node.path, projectPath],
  );

  const dragId = `tree-drag-${projectPath}:${node.path}`;
  const dropId = `tree-drop-${projectPath}:${node.path}`;

  // Refetch directory contents (used for initial load and for refresh-in-place)
  const fetchChildren = useCallback(async () => {
    if (!isFolder) return;
    const result = await trpcClient.files.listDirectory.query({
      projectPath,
      relativePath: node.path,
    });
    return result.map((entry) => ({
      id: entry.path,
      name: entry.name,
      path: entry.path,
      type: entry.type,
      gitStatus: entry.gitStatus,
      isGitIgnored: entry.isGitIgnored,
      children: undefined,
      childrenLoaded: false,
    })) as FileTreeNode[];
  }, [isFolder, projectPath, node.path]);

  // --- Context menu actions ---
  const absolutePath = `${projectPath}/${node.path}`;
  const openInFinderMutation = trpc.external.openInFinder.useMutation();

  // Batch actions read the live selection snapshot at call time — the node itself
  // does not subscribe to the full path set, so it never re-renders on count changes.
  const handleCopyPath = useCallback(async () => {
    const { paths } = store.getSnapshot();
    if (paths.has(node.path) && paths.size > 1) {
      const list = Array.from(paths).map((p) => `${projectPath}/${p}`);
      await copyToClipboard(list.join('\n'), `Copied ${list.length} paths`);
    } else {
      await copyToClipboard(absolutePath, 'Copied path');
    }
  }, [store, node.path, absolutePath, projectPath]);

  const handleCopyRelativePath = useCallback(async () => {
    const { paths } = store.getSnapshot();
    if (paths.has(node.path) && paths.size > 1) {
      const list = Array.from(paths);
      await copyToClipboard(list.join('\n'), `Copied ${list.length} relative paths`);
    } else {
      await copyToClipboard(node.path, 'Copied relative path');
    }
  }, [store, node.path]);

  const handleRevealInFinder = useCallback(() => {
    const { paths } = store.getSnapshot();
    if (paths.has(node.path) && paths.size > 1) {
      // Reveal the common parent folder when many items are selected
      const list = Array.from(paths);
      if (list.length <= 3) {
        for (const p of list) openInFinderMutation.mutate(`${projectPath}/${p}`);
      } else {
        // Find common parent directory
        const segments = list[0]?.split('/') ?? [];
        let common = '';
        for (let i = 0; i < segments.length; i++) {
          const prefix = segments.slice(0, i + 1).join('/');
          if (list.every((p) => p === prefix || p.startsWith(`${prefix}/`))) common = prefix;
          else break;
        }
        openInFinderMutation.mutate(`${projectPath}/${common || ''}`);
      }
    } else {
      openInFinderMutation.mutate(absolutePath);
    }
  }, [store, node.path, absolutePath, projectPath, openInFinderMutation]);

  const handleDelete = useCallback(() => {
    if (!onDeleteItem) return;
    const label = isFolder ? 'folder' : 'file';
    if (window.confirm(`Move ${label} "${node.name}" to Trash?`)) {
      onDeleteItem(node.path);
    }
  }, [onDeleteItem, isFolder, node.name, node.path]);

  const handleCopyItem = useCallback(() => {
    onCopyItem?.(node.path);
  }, [onCopyItem, node.path]);

  const handlePasteItem = useCallback(() => {
    if (!onPasteIntoFolder) return;
    if (isFolder) {
      onPasteIntoFolder(node.path);
      return;
    }
    const lastSlash = node.path.lastIndexOf('/');
    const parentFolder = lastSlash === -1 ? '' : node.path.slice(0, lastSlash);
    onPasteIntoFolder(parentFolder);
  }, [onPasteIntoFolder, isFolder, node.path]);

  const expandAndCreate = useCallback(
    (type: 'file' | 'folder') => {
      if (!isFolder || !onCreateItem) return;
      // Expand the folder first so the inline input is visible
      if (!isExpanded) {
        setIsExpanded(true);
        if (!hasLoaded) {
          void (async () => {
            setIsLoading(true);
            try {
              const loadedChildren = await fetchChildren();
              setChildren(loadedChildren);
              setHasLoaded(true);
            } catch (_error) {
              // Failed to load
            } finally {
              setIsLoading(false);
            }
          })();
        }
      }
      onCreateItem(node.path, type);
    },
    [isFolder, onCreateItem, node.path, isExpanded, hasLoaded, fetchChildren],
  );

  const handleNewFile = useCallback(() => {
    markNextCloseForInputFocus();
    expandAndCreate('file');
  }, [expandAndCreate, markNextCloseForInputFocus]);

  const handleNewFolder = useCallback(() => {
    markNextCloseForInputFocus();
    expandAndCreate('folder');
  }, [expandAndCreate, markNextCloseForInputFocus]);

  // When refresh trigger changes, refetch in place so git status updates without collapsing the tree
  // biome-ignore lint/correctness/useExhaustiveDependencies: refreshTrigger is the signal to refetch when git status changes
  useEffect(() => {
    if (!isFolder || !isExpanded || !hasLoaded) return;
    let cancelled = false;
    void (async () => {
      try {
        const loadedChildren = await fetchChildren();
        if (!cancelled) setChildren(loadedChildren);
      } catch (_error) {
        // Keep existing children on error
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [refreshTrigger, isFolder, isExpanded, hasLoaded, fetchChildren]);

  // Get file icon component
  // biome-ignore lint/style/useNamingConvention: component type variable
  const FileIconComponent = isFolder ? null : getFileIconByExtension(node.name);

  // Lazy load children on first expand
  const loadChildren = useCallback(async () => {
    if (hasLoaded || !isFolder) return;
    setIsLoading(true);
    try {
      const loadedChildren = await fetchChildren();
      setChildren(loadedChildren);
      setHasLoaded(true);
    } catch (_error) {
      // Failed to load directory contents
    } finally {
      setIsLoading(false);
    }
  }, [hasLoaded, isFolder, fetchChildren]);

  // Expand this folder when parent set pathToExpandAfterDrop (e.g. after drop)
  useEffect(() => {
    if (!isFolder || pathToExpandAfterDrop !== node.path) return;
    setIsExpanded(true);
    if (!hasLoaded) void loadChildren();
  }, [pathToExpandAfterDrop, node.path, isFolder, hasLoaded, loadChildren]);

  const handleClick = useCallback(
    async (e: React.MouseEvent) => {
      const hasModifier = e.metaKey || e.ctrlKey || e.shiftKey;

      // If modifier keys are held and onModifiedClick is provided, delegate
      if (hasModifier && onModifiedClick) {
        onModifiedClick(node.path, node.name, node.type, {
          shift: e.shiftKey,
          meta: e.metaKey || e.ctrlKey,
        });
        // Still toggle folders on Shift/Cmd+Click if not expanded
        if (isFolder && !isExpanded && !hasLoaded) {
          await loadChildren();
          setIsExpanded(true);
        }
        return;
      }

      // Plain click — single select
      onSelect?.(node.path, node.name, node.type);

      if (isFolder) {
        if (!isExpanded && !hasLoaded) {
          await loadChildren();
        }
        const willCollapse = isExpanded;
        setIsExpanded(!isExpanded);
        // Remove collapsed children from multi-selection to avoid hidden items
        if (willCollapse) {
          deselectDescendants?.(node.path);
        }
      } else {
        onFileClick(node.path);
      }
    },
    [
      isFolder,
      isExpanded,
      hasLoaded,
      loadChildren,
      onFileClick,
      onSelect,
      onModifiedClick,
      deselectDescendants,
      node.path,
      node.name,
      node.type,
    ],
  );

  const gitIndicator = getGitStatusIndicator(node.gitStatus);
  const gitColorClass = node.gitStatus ? getStatusColor(node.gitStatus) : '';
  const gitDotBgClass = node.gitStatus ? getStatusBackgroundColor(node.gitStatus) : '';
  const visibleChildren =
    showModifiedOnly && children ? children.filter((child) => Boolean(child.gitStatus)) : children;

  const isSelected = isMultiSelected;
  const isRenaming = renamingPath === node.path;

  // --- Render: button content (shared between context menu trigger and button) ---
  const buttonClassName = cn(
    'relative flex w-full items-center gap-1.5 rounded-md px-2 py-1.5 text-left text-sm transition-colors',
    'text-foreground/85 hover:bg-foreground/5 hover:text-foreground',
    'focus-visible:outline-hidden focus-visible:ring-2 focus-visible:ring-primary/40',
    !isFolder && 'cursor-pointer',
    node.isGitIgnored && 'opacity-50',
    isSelected && 'bg-foreground/10 text-foreground',
  );

  const nodeButton = isRenaming ? (
    <InlineInput
      type={node.type}
      level={level}
      defaultValue={node.name}
      onConfirm={(newName) => onRenameConfirm?.(newName)}
      onCancel={() => onRenameCancel?.()}
    />
  ) : (
    <DragButton
      draggableId={dragId}
      draggableData={draggableData}
      type="button"
      data-tree-path={node.path}
      data-tree-type={node.type}
      aria-expanded={isFolder ? isExpanded : undefined}
      aria-busy={isLoading ? 'true' : undefined}
      aria-level={level + 1}
      onClick={handleClick}
      className={buttonClassName}
      style={{
        paddingLeft: `${level * TREE_INDENT_WIDTH + TREE_BASE_PADDING}px`,
        ...(node.isGitIgnored ? { opacity: 0.5 } : {}),
      }}
      role="treeitem"
      aria-selected={isSelected}
    >
      {isFolder &&
        (isLoading ? (
          <Loader2
            className="h-3.5 w-3.5 shrink-0 text-muted-foreground animate-spin"
            aria-hidden="true"
          />
        ) : (
          <ChevronRight
            className={cn(
              'h-3.5 w-3.5 shrink-0 text-muted-foreground transition-transform duration-150',
              isExpanded && 'rotate-90',
            )}
            aria-hidden="true"
          />
        ))}
      {!isFolder && (
        <span className="shrink-0" style={{ width: TREE_CHEVRON_SPACER_PX }} aria-hidden="true" />
      )}
      {isFolder ? (
        <Folder className="h-4 w-4 shrink-0 text-muted-foreground" aria-hidden="true" />
      ) : FileIconComponent ? (
        <FileIconComponent className="h-4 w-4 shrink-0" aria-hidden="true" />
      ) : (
        <Files className="h-4 w-4 shrink-0 text-muted-foreground" aria-hidden="true" />
      )}
      <span className={cn('truncate', gitColorClass)}>{node.name}</span>
      {/* Git status indicator */}
      {node.gitStatus && isFolder && (
        <span className="ml-auto shrink-0 flex items-center" title="Contains changes">
          <span className={cn('inline-block size-2 rounded-full', gitDotBgClass)} />
        </span>
      )}
      {node.gitStatus && !isFolder && gitIndicator && (
        <span
          className={cn('ml-auto text-xs font-semibold shrink-0', gitIndicator.className)}
          title={`Git status: ${node.gitStatus}`}
        >
          {gitIndicator.letter}
        </span>
      )}
    </DragButton>
  );

  // DropRoot: no content-visibility — it skewed @dnd-kit activeNodeRect vs the drag handle (DragOverlay offset); trade-off is less offscreen paint skip on huge trees.
  return (
    <DropRoot
      id={dropId}
      data={droppableData}
      disabled={!isFolder}
      className="relative"
      overClassName="bg-primary/10 rounded-md"
    >
      {/* Indent guide line - only show for nested items */}
      {level > 0 && (
        <div
          className="absolute top-0 bottom-0 w-px bg-border"
          style={{ left: `${(level - 1) * TREE_INDENT_WIDTH + TREE_BASE_PADDING + 6}px` }}
          aria-hidden="true"
        />
      )}

      <ContextMenu>
        <ContextMenuTrigger asChild>{nodeButton}</ContextMenuTrigger>
        <ContextMenuContent className="w-52" onCloseAutoFocus={handleCloseAutoFocus}>
          <TreeNodeMenu
            nodePath={node.path}
            hasCopiedItem={hasCopiedItem}
            canCreate={isFolder && Boolean(onCreateItem)}
            canDelete={Boolean(onDeleteItem)}
            onNewFile={handleNewFile}
            onNewFolder={handleNewFolder}
            onCopyPath={handleCopyPath}
            onCopyRelativePath={handleCopyRelativePath}
            onRevealInFinder={handleRevealInFinder}
            onCopyItem={handleCopyItem}
            onPasteItem={handlePasteItem}
            onDelete={handleDelete}
            onRename={onStartRename ? () => onStartRename(node.path) : undefined}
            onBatchDelete={onBatchDelete}
          />
        </ContextMenuContent>
      </ContextMenu>

      {isFolder &&
        isExpanded &&
        (hasChildren || creatingItem?.parentFolder === node.path) && (
          // Tree children container: role="group" is correct per ARIA tree pattern; fieldset is for form grouping.
          // biome-ignore lint/a11y/useSemanticElements: tree structure, not a form fieldset
          <div role="group" className="space-y-0.5">
            {/* Inline input at the top of this folder's children */}
            {creatingItem?.parentFolder === node.path && onInlineConfirm && onInlineCancel && (
              <InlineInput
                type={creatingItem.type}
                level={level + 1}
                onConfirm={onInlineConfirm}
                onCancel={onInlineCancel}
              />
            )}
            {visibleChildren?.map((child: FileTreeNode) => (
              <TreeNode
                key={child.id}
                node={child}
                level={level + 1}
                projectPath={projectPath}
                paneIndex={paneIndex}
                onFileClick={onFileClick}
                searchQuery={searchQuery}
                onCreateItem={onCreateItem}
                onDeleteItem={onDeleteItem}
                creatingItem={creatingItem}
                onInlineConfirm={onInlineConfirm}
                onInlineCancel={onInlineCancel}
                onSelect={onSelect}
                renamingPath={renamingPath}
                onRenameConfirm={onRenameConfirm}
                onRenameCancel={onRenameCancel}
                onStartRename={onStartRename}
                onCopyItem={onCopyItem}
                onPasteIntoFolder={onPasteIntoFolder}
                hasCopiedItem={hasCopiedItem}
                pathToExpandAfterDrop={pathToExpandAfterDrop}
              />
            ))}
          </div>
        )}
    </DropRoot>
  );
}, areTreeNodePropsEqual);
