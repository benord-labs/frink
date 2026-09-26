/* eslint-disable max-lines, max-lines-per-function */
/**
 * Lightweight per-pane file tree for split view.
 * Unlike FilesSidebar, this accepts `projectPath` as a prop instead of
 * reading from the global selectedProjectAtom, allowing multiple instances.
 */

import { Button } from '@benord-labs/frink-primitives';
import { useDndContext, useDroppable } from '@dnd-kit/core';
import { useComposedRefs } from '@radix-ui/react-compose-refs';
import { useSetAtom } from 'jotai';
import type { HTMLAttributes, ReactNode } from 'react';
import {
  forwardRef,
  memo,
  useCallback,
  useEffect,
  useImperativeHandle,
  useMemo,
  useRef,
  useState,
} from 'react';
import { openFileAtom } from '@/lib/code-editor/state';
import { trpc } from '@/lib/trpc';
import { cn } from '@/lib/utils';
import { SidebarHeaderWithSearch } from '../sidebar/components/SidebarHeaderWithSearch';
import type { FilesSidebarTab } from './atoms';
import { ContentSearchOptionsRow } from './ContentSearchOptionsRow';
import { ContentSearchResults } from './ContentSearchResults';
import { FILES_SIDEBAR_SEARCH_INPUT_CLASS, filesSidebarTabButtonClass } from './chrome';
import {
  FILE_TREE_KEY_SHORTCUTS,
  FILES_FETCH_LIMIT,
  PANE_FILE_TREE_READY_EVENT,
} from './constants';
import { FilesSidebarFooter } from './FilesSidebarFooter';
import { FileTree } from './FileTree';
import { InlineInput } from './FileTree/InlineInput';
import { ModifiedFilterContext } from './FileTree/modified-filter-context';
import { RefreshContext } from './FileTree/RefreshContext';
import type { TreeNodeDropData } from './FileTree/TreeNode';
import { useMultiSelect } from './FileTree/use-multi-select';
import { LoadingState } from './LoadingState';
import { ModifiedOnlyToggle } from './ModifiedOnlyToggle';
import { RootCreateContextMenu } from './RootCreateContextMenu';
import {
  triggerFileTreeRefresh,
  triggerFileTreeReveal,
  useFileTreeRefreshListeners,
} from './refresh-trigger';
import { useChatContextFile } from './use-chat-context-file';
import { useContentSearchTab } from './use-content-search-tab';
import { useExternalFileDrop } from './use-external-file-drop';
import { useSearchDebounce } from './use-search-debounce';
import { mutateWithLoadingToast, showMoveToast, showTrashToast } from './utils/batch-result-toasts';
import { useFileTreeNodes } from './utils/build-file-tree';
import {
  activateSearchTabAndFocus,
  openContentSearchMatchInEditor,
  shouldHandlePaneSearchActivation,
} from './utils/content-search-actions';
import { createCopyExternalFilesHandlers } from './utils/file-mutation-handlers';
import { getVisiblePaths } from './utils/get-visible-paths';
import { duplicateFileToDestination, pasteCopiedPath } from './utils/internal-copy-paste';
import { createMetaLookupFromDOM } from './utils/meta-lookup-from-dom';
import { scrollTreeNodeIntoView } from './utils/scroll-tree-node-into-view';

/**
 * Tree-container wrapper that owns the root `useDroppable` + `useDndContext` subscriptions so the
 * full PaneFileTree doesn't re-render on every dnd-kit state update. Its `children` are passed from
 * PaneFileTree (which doesn't subscribe to DndContext), so their element references stay stable and
 * React skips re-reconciling the tree subtree on drag updates.
 */
type PaneTreeDropRootProps = HTMLAttributes<HTMLDivElement> & {
  dropId: string;
  dropData: TreeNodeDropData;
  overClassName?: string;
  children: ReactNode;
};

const PaneTreeDropRoot = memo(
  forwardRef<HTMLDivElement, PaneTreeDropRootProps>(function PaneTreeDropRoot(
    { dropId, dropData, overClassName, className, children, ...rest },
    forwardedRef,
  ) {
    const { setNodeRef, isOver } = useDroppable({ id: dropId, data: dropData });
    const { active } = useDndContext();
    const refCallback = useComposedRefs(setNodeRef, forwardedRef);
    const showOver = !!active && isOver;
    return (
      <div ref={refCallback} className={cn(className, showOver && overClassName)} {...rest}>
        {children}
      </div>
    );
  }),
);
PaneTreeDropRoot.displayName = 'PaneTreeDropRoot';

type PaneFileTreeProps = {
  /** Absolute path of the project to display */
  projectPath: string;
  /** Chat ID for per-chat context file tracking */
  chatId?: string;
  /** Pane index (0-based) for editor tab association in split view */
  paneIndex?: number;
  /** Whether this pane is currently scoped to a worktree path */
  isWorktree?: boolean;
  /** Collapses the file tree in split view (header close control). */
  onClose?: () => void;
};

/** Imperative API exposed to parent via ref for shortcut integration. */
export type PaneFileTreeHandle = {
  /** Start inline creation of a file or folder at root level. */
  setRootCreating: (type: 'file' | 'folder') => void;
  /** Path of the currently selected node (for delete shortcut). */
  getSelectedNodePath: () => string | null;
  /** Whether an inline input (rename/create) is currently active. */
  getIsInlineActive: () => boolean;
  /** Focus the tree container. */
  focusTree: () => void;
  /** Delete the currently selected node. */
  deleteSelectedNode: () => void;
  /** Get all selected paths (multi-select). */
  getSelectedPaths: () => string[];
  /** Get all selected items with metadata (for batch DnD). */
  getSelectedItems: () => Array<{ path: string; name: string; type: 'file' | 'folder' }>;
  /** Batch delete selected paths (called from SplitViewContainer shortcuts). */
  batchDelete?: (paths: string[]) => void;
  /** Clear multi-selection (called after batch DnD in SplitViewContainer). */
  clearSelection?: () => void;
  /** Activate "Search" tab in this pane's file tree. */
  activateSearch?: () => void;
};

export const PaneFileTree = forwardRef<PaneFileTreeHandle, PaneFileTreeProps>(function PaneFileTree(
  { projectPath, chatId, paneIndex, isWorktree, onClose },
  ref,
) {
  const openFile = useSetAtom(openFileAtom);
  const { setContextFileFromPath } = useChatContextFile(chatId, 'PaneFileTree');
  const [activeTab, setActiveTab] = useState<FilesSidebarTab>('files');
  const [showModifiedOnly, setShowModifiedOnly] = useState(false);
  const {
    searchQuery: fileSearchQuery,
    debouncedQuery: fileDebouncedQuery,
    setSearchQuery: setFileSearchQuery,
  } = useSearchDebounce();
  const searchInputRef = useRef<HTMLInputElement>(null);
  const isSearching = activeTab === 'files' && fileDebouncedQuery.length > 0;
  const projectName = projectPath.split('/').pop() ?? 'project';

  // ---- Data fetching ----

  // staleTime ensures multiple PaneFileTree instances for the same project share
  // a single React Query subscription without redundant refetches.
  const { data: rawRootContents, isLoading: isLoadingRoot } = trpc.files.listDirectory.useQuery(
    { projectPath, relativePath: '' },
    { enabled: !!projectPath && !isSearching, refetchOnMount: 'always', staleTime: 5_000 },
  );
  const rootContents = Array.isArray(rawRootContents) ? rawRootContents : [];

  const { data: rawSearchResults, isLoading: isLoadingSearch } = trpc.files.search.useQuery(
    { projectPath, query: fileDebouncedQuery, limit: FILES_FETCH_LIMIT },
    { enabled: !!projectPath && isSearching, refetchOnMount: 'always', staleTime: 5_000 },
  );
  const searchResults = Array.isArray(rawSearchResults) ? rawSearchResults : [];

  const {
    contentSearchQuery,
    contentDebouncedQuery,
    setContentSearchQuery,
    contentSearchOptions,
    setContentSearchOptions,
    contentMatches,
    contentSearchInvalidRegex,
    isLoadingContentSearch,
    highlightContentMatch,
  } = useContentSearchTab({
    projectPath,
    canSearch: !!projectPath,
    isSearchTabActive: activeTab === 'search',
    staleTime: 5_000,
  });

  const isLoading =
    activeTab === 'search' ? isLoadingContentSearch : isSearching ? isLoadingSearch : isLoadingRoot;

  // ---- Refresh triggers ----

  const { refreshTrigger, pathToExpandAfterDrop, setPathToExpandAfterDrop } =
    useFileTreeRefreshListeners({ projectPath });

  // ---- Node conversion ----

  const { nodes, hasGitDiff } = useFileTreeNodes({
    rootContents,
    searchResults,
    isSearching,
    showModifiedOnly,
  });

  // ---- Mutations ----

  // Broadcast a forced refresh so every pane on this project (including this one, via its
  // own FILE_TREE_REFRESH_EVENT listener) re-fetches root + expanded subfolders. `force`
  // bypasses the listener's throttle so rapid successive mutations aren't dropped.
  const invalidateTree = useCallback(
    () => triggerFileTreeRefresh(projectPath, { force: true }),
    [projectPath],
  );

  const copyExternalFilesHandlers = useMemo(
    () => createCopyExternalFilesHandlers(invalidateTree),
    [invalidateTree],
  );

  const moveFileMutation = trpc.files.moveFile.useMutation({ onSuccess: invalidateTree });
  const createFileMutation = trpc.files.createFile.useMutation({ onSuccess: invalidateTree });
  const createFolderMutation = trpc.files.createFolder.useMutation({ onSuccess: invalidateTree });
  const deleteFileMutation = trpc.files.deleteFile.useMutation({ onSuccess: invalidateTree });
  const renameFileMutation = trpc.files.renameFile.useMutation({ onSuccess: invalidateTree });
  const duplicateFileMutation = trpc.files.duplicateFile.useMutation({ onSuccess: invalidateTree });
  const copyExternalFilesMutation =
    trpc.files.copyExternalFiles.useMutation(copyExternalFilesHandlers);

  // Batch delete with per-item error feedback (fix #8)
  const batchDeleteMutation = trpc.files.batchDeleteFiles.useMutation({
    onSuccess: (result) => {
      invalidateTree();
      showTrashToast(result.results);
    },
  });

  const moveFileMutate = moveFileMutation.mutate;
  const handleMoveFile = useCallback(
    (sourcePath: string, destinationFolder: string) => {
      moveFileMutate(
        { projectPath, sourcePath, destinationFolder },
        {
          onSuccess: () => {
            if (destinationFolder) {
              triggerFileTreeReveal(projectPath, destinationFolder);
            }
          },
        },
      );
    },
    [projectPath, moveFileMutate],
  );

  // Batch move mutation — consolidated feedback for multi-select drag
  const batchMoveMutation = trpc.files.batchMoveFiles.useMutation({
    onSuccess: (data, variables) => {
      invalidateTree();
      showMoveToast(variables.projectPath, data.results, invalidateTree);
    },
  });
  const batchMoveMutate = batchMoveMutation.mutate;
  const handleBatchMoveFiles = useCallback(
    (sourcePaths: string[], destinationFolder: string) => {
      batchMoveMutate(
        { projectPath, sourcePaths, destinationFolder },
        {
          onSuccess: () => {
            if (destinationFolder) {
              triggerFileTreeReveal(projectPath, destinationFolder);
            }
          },
        },
      );
    },
    [projectPath, batchMoveMutate],
  );

  const handleCreateFile = useCallback(
    (relativePath: string) => {
      createFileMutation.mutate({ projectPath, relativePath });
    },
    [projectPath, createFileMutation],
  );

  const handleCreateFolder = useCallback(
    (relativePath: string) => {
      createFolderMutation.mutate({ projectPath, relativePath });
    },
    [projectPath, createFolderMutation],
  );

  const handleDeleteFile = useCallback(
    (relativePath: string) => {
      const name = relativePath.split('/').pop() ?? relativePath;
      if (window.confirm(`Move "${name}" to Trash?`)) {
        deleteFileMutation.mutate({ projectPath, relativePath });
      }
    },
    [projectPath, deleteFileMutation],
  );

  const handleRenameFile = useCallback(
    (relativePath: string, newName: string) => {
      renameFileMutation.mutate({ projectPath, relativePath, newName });
    },
    [projectPath, renameFileMutation],
  );

  const handleDuplicateFile = useCallback(
    (relativePath: string, destinationFolder?: string) => {
      duplicateFileToDestination({
        mutate: duplicateFileMutation.mutate,
        projectPath,
        relativePath,
        destinationFolder,
      });
    },
    [projectPath, duplicateFileMutation],
  );

  // ---- Selection / rename ----

  const multiSelect = useMultiSelect();

  // Reset filter when projectPath changes (e.g., switching projects without unmount)
  const prevProjectPath = useRef(projectPath);
  useEffect(() => {
    if (projectPath !== prevProjectPath.current) {
      setShowModifiedOnly(false);
      multiSelect.clearSelection();
      prevProjectPath.current = projectPath;
    }
  }, [projectPath, multiSelect.clearSelection]);

  useEffect(() => {
    if (!hasGitDiff) {
      if (showModifiedOnly) {
        setShowModifiedOnly(false);
        multiSelect.clearSelection();
      }
    }
  }, [hasGitDiff, showModifiedOnly, multiSelect.clearSelection]);

  const handleBatchDelete = useCallback(
    (paths: string[]) => {
      const count = paths.length;
      if (window.confirm(`Move ${count} items to Trash?`)) {
        mutateWithLoadingToast({
          mutate: batchDeleteMutation.mutate,
          input: { projectPath, relativePaths: paths },
          loadingMessage: `Moving ${count} items to Trash...`,
          errorMessage: 'Batch delete failed',
        });
        multiSelect.clearSelection();
      }
    },
    [projectPath, batchDeleteMutation.mutate, multiSelect.clearSelection],
  );

  const [renamingPath, setRenamingPath] = useState<string | null>(null);
  const copiedPathRef = useRef<string | null>(null);
  const [hasCopiedItem, setHasCopiedItem] = useState(false);
  const [rootCreating, setRootCreating] = useState<'file' | 'folder' | null>(null);
  const treeContainerRef = useRef<HTMLDivElement>(null);
  const previousProjectPathRef = useRef(projectPath);

  // Clear copy buffer when pane project changes to prevent stale cross-project paste attempts.
  useEffect(() => {
    if (projectPath === previousProjectPathRef.current) return;
    copiedPathRef.current = null;
    setHasCopiedItem(false);
    previousProjectPathRef.current = projectPath;
  }, [projectPath]);

  // Make the tree scroll container a root drop target so dropping on empty
  // space moves items to project root (no need to scroll to the bottom).
  const rootDropData = useMemo<TreeNodeDropData>(
    () => ({ type: 'tree-root', folderPath: '', projectPath }),
    [projectPath],
  );
  const rootDropId = `pane-tree-root-${projectPath}`;

  const getDestinationFolderForPaste = useCallback(() => {
    const primary = multiSelect.getPrimary();
    if (!primary) return '';
    return primary.type === 'folder'
      ? primary.path
      : primary.path.includes('/')
        ? primary.path.slice(0, primary.path.lastIndexOf('/'))
        : '';
  }, [multiSelect]);

  const externalFileDrop = useExternalFileDrop({
    projectPath,
    treeContainerRef,
    enabled: !!projectPath && !isSearching,
    copyExternalFilesMutate: copyExternalFilesMutation.mutate,
    getDestinationFolder: getDestinationFolderForPaste,
  });

  const handlePaste = useCallback(
    (targetFolder: string) => {
      if (targetFolder) {
        setPathToExpandAfterDrop(targetFolder);
      }
      pasteCopiedPath({
        copiedPath: copiedPathRef.current,
        targetFolder,
        onDuplicate: handleDuplicateFile,
        clearCopiedPath: () => {
          copiedPathRef.current = null;
          setHasCopiedItem(false);
        },
      });
    },
    [handleDuplicateFile],
  );

  const handleInternalCopy = useCallback((path: string) => {
    copiedPathRef.current = path;
    setHasCopiedItem(true);
  }, []);

  const handlePasteEvent = useCallback(
    (e: React.ClipboardEvent) => {
      externalFileDrop.onPaste(e);
      if (!e.defaultPrevented && copiedPathRef.current) {
        handlePaste(getDestinationFolderForPaste());
        e.preventDefault();
      }
    },
    [externalFileDrop.onPaste, handlePaste, getDestinationFolderForPaste],
  );

  // Expose imperative API for shortcut integration from SplitViewContainer
  useImperativeHandle(
    ref,
    () => ({
      setRootCreating,
      getSelectedNodePath: () => multiSelect.getPrimary()?.path ?? null,
      getIsInlineActive: () => !!rootCreating || !!renamingPath,
      focusTree: () => treeContainerRef.current?.focus(),
      deleteSelectedNode: () => {
        const primary = multiSelect.getPrimary();
        if (primary?.path) handleDeleteFile(primary.path);
      },
      getSelectedPaths: () => Array.from(multiSelect.selection.paths),
      getSelectedItems: () => multiSelect.getSelectedItems(),
      batchDelete: (paths: string[]) => {
        batchDeleteMutation.mutate({ projectPath, relativePaths: paths });
        multiSelect.clearSelection();
      },
      clearSelection: multiSelect.clearSelection,
      activateSearch: () => {
        activateSearchTabAndFocus(setActiveTab, searchInputRef);
      },
    }),
    [multiSelect, rootCreating, renamingPath, handleDeleteFile, batchDeleteMutation, projectPath],
  );

  const handleFileClick = useCallback(
    (filePath: string) => {
      const fileName = filePath.split('/').pop() ?? filePath;
      openFile({
        path: filePath,
        name: fileName,
        projectPath,
        sourcePaneIndex: paneIndex,
        sourceChatId: chatId,
        isWorktreeContext: Boolean(isWorktree),
        intent: 'preview',
      });
      setContextFileFromPath(filePath);
    },
    [openFile, setContextFileFromPath, projectPath, paneIndex, chatId, isWorktree],
  );

  const handleSelectContentMatch = useCallback(
    (relativePath: string, lineNumber: number, startColumn: number, endColumn: number) => {
      openContentSearchMatchInEditor(
        projectPath,
        relativePath,
        lineNumber,
        startColumn,
        endColumn,
        handleFileClick,
      );
    },
    [handleFileClick, projectPath],
  );

  const handleSelect = useCallback(
    (path: string, name: string, type: 'file' | 'folder') => {
      multiSelect.selectOne(path, { name, type });
    },
    [multiSelect.selectOne],
  );

  const handleRenameConfirm = useCallback(
    (newName: string) => {
      if (!renamingPath) return;
      handleRenameFile(renamingPath, newName);
      setRenamingPath(null);
    },
    [renamingPath, handleRenameFile],
  );

  const handleRenameCancel = useCallback(() => setRenamingPath(null), []);

  /** Helper: look up node metadata from the DOM */
  const metaLookupFromDOM = useCallback(
    (p: string) => createMetaLookupFromDOM(treeContainerRef.current)(p),
    [],
  );

  /** Select a single path by looking up its metadata from the DOM */
  const selectByPath = useCallback(
    (path: string) => {
      multiSelect.selectOne(path, metaLookupFromDOM(path));
    },
    [multiSelect.selectOne, metaLookupFromDOM],
  );

  /** Extend selection range to a path (for Shift+Arrow) */
  const extendSelectionTo = useCallback(
    (toPath: string) => {
      const paths = getVisiblePaths(treeContainerRef.current);
      multiSelect.selectRange(toPath, paths, metaLookupFromDOM);
    },
    [multiSelect.selectRange, metaLookupFromDOM],
  );

  /** Handle modifier clicks (Cmd+Click, Shift+Click) */
  const handleModifiedClick = useCallback(
    (
      path: string,
      name: string,
      type: 'file' | 'folder',
      modifiers: { shift: boolean; meta: boolean },
    ) => {
      if (modifiers.shift) {
        extendSelectionTo(path);
      } else if (modifiers.meta) {
        multiSelect.toggleItem(path, { name, type });
      }
    },
    [extendSelectionTo, multiSelect.toggleItem],
  );

  /**
   * Keyboard handler for the tree container.
   * Attached via native addEventListener to bypass Radix ContextMenuTrigger's
   * asChild prop composition which can interfere with React onKeyDown.
   *
   * Handles: Enter/F2 (rename), Arrow navigation, Shift+Arrow (multi-select),
   * Cmd+A (select all), Escape (clear selection), Space (open/toggle).
   */
  const handleTreeKeyDown = useCallback(
    (e: KeyboardEvent) => {
      // Don't handle when inline input is active
      if (rootCreating || renamingPath) return;
      // Don't handle if target is an input (e.g. search bar)
      const tag = (e.target as HTMLElement).tagName;
      if (tag === 'INPUT' || tag === 'TEXTAREA') return;

      const isMeta = e.metaKey || e.ctrlKey;
      const isShift = e.shiftKey;
      const isAlt = e.altKey;
      const primary = multiSelect.getPrimary();

      // --- Enter / F2: Rename ---
      if ((e.key === 'Enter' || e.key === 'F2') && !isMeta && !isShift) {
        if (primary) {
          e.preventDefault();
          e.stopPropagation();
          setRenamingPath(primary.path);
        }
        return;
      }

      // --- Cmd+D: Duplicate ---
      if (isMeta && !isShift && e.key.toLowerCase() === 'd' && primary) {
        e.preventDefault();
        e.stopPropagation();
        handleDuplicateFile(primary.path);
        return;
      }

      // --- Cmd+C: Copy ---
      if (isMeta && !isShift && e.key.toLowerCase() === 'c' && primary) {
        e.preventDefault();
        e.stopPropagation();
        handleInternalCopy(primary.path);
        return;
      }

      // --- Cmd+A: Select all ---
      if (isMeta && !isShift && e.key.toLowerCase() === 'a') {
        e.preventDefault();
        e.stopPropagation();
        const paths = getVisiblePaths(treeContainerRef.current);
        multiSelect.selectAll(paths, metaLookupFromDOM);
        return;
      }

      // --- Escape: Clear selection ---
      if (e.key === 'Escape') {
        e.preventDefault();
        e.stopPropagation();
        multiSelect.clearSelection();
        return;
      }

      // --- Arrow key navigation (with optional Shift for multi-select) ---
      if (!isMeta && !isAlt) {
        const visiblePaths = getVisiblePaths(treeContainerRef.current);
        const currentIndex = primary ? visiblePaths.indexOf(primary.path) : -1;

        const container = treeContainerRef.current;

        switch (e.key) {
          case 'ArrowDown': {
            e.preventDefault();
            e.stopPropagation();
            const nextIndex = currentIndex + 1;
            if (nextIndex < visiblePaths.length) {
              const nextPath = visiblePaths[nextIndex];
              if (isShift) {
                extendSelectionTo(nextPath);
              } else {
                selectByPath(nextPath);
              }
              scrollTreeNodeIntoView(container, nextPath);
            } else if (visiblePaths.length > 0 && currentIndex === -1) {
              selectByPath(visiblePaths[0]);
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
              if (isShift) {
                extendSelectionTo(prevPath);
              } else {
                selectByPath(prevPath);
              }
              scrollTreeNodeIntoView(container, prevPath);
            } else if (visiblePaths.length > 0 && currentIndex === -1) {
              const lastPath = visiblePaths[visiblePaths.length - 1];
              selectByPath(lastPath);
              scrollTreeNodeIntoView(container, lastPath);
            }
            return;
          }
          case ' ': {
            if (isShift || !primary) return;
            e.preventDefault();
            e.stopPropagation();
            if (primary.type === 'file') {
              handleFileClick(primary.path);
            }
            // Folder expand/collapse is handled by TreeNode's own click
            return;
          }
        }
      }
    },
    [
      rootCreating,
      renamingPath,
      multiSelect,
      metaLookupFromDOM,
      selectByPath,
      extendSelectionTo,
      handleFileClick,
      handleDuplicateFile,
      handleInternalCopy,
    ],
  );

  // Attach keydown handler natively to bypass Radix ContextMenuTrigger asChild composition
  useEffect(() => {
    const el = treeContainerRef.current;
    if (!el) return;
    el.addEventListener('keydown', handleTreeKeyDown);
    return () => el.removeEventListener('keydown', handleTreeKeyDown);
  }, [handleTreeKeyDown]);

  useEffect(() => {
    const handleActivateSearch = (event: Event) => {
      const customEvent = event as CustomEvent<{ paneIndex?: number }>;
      if (!shouldHandlePaneSearchActivation(customEvent.detail, paneIndex)) return;
      activateSearchTabAndFocus(setActiveTab, searchInputRef);
    };
    window.addEventListener('pane-file-tree:activate-search', handleActivateSearch);
    return () => window.removeEventListener('pane-file-tree:activate-search', handleActivateSearch);
  }, [paneIndex]);

  // Signal that activate-search listener is registered (split panes only).
  useEffect(() => {
    if (paneIndex === undefined) return;
    window.dispatchEvent(
      new CustomEvent<{ paneIndex: number }>(PANE_FILE_TREE_READY_EVENT, {
        detail: { paneIndex },
      }),
    );
  }, [paneIndex]);

  const headerSearchQuery = activeTab === 'search' ? contentSearchQuery : fileSearchQuery;
  const headerPlaceholder = activeTab === 'search' ? 'Search inside files...' : 'Search files...';
  const handleHeaderSearchChange = (value: string) => {
    if (activeTab === 'search') {
      setContentSearchQuery(value);
      return;
    }
    setFileSearchQuery(value);
  };
  return (
    <div className="flex h-full min-h-0 min-w-0 flex-col overflow-hidden p-1.5">
      <div
        className={cn(
          'unified-sidebar-glass flex min-h-0 flex-1 select-none flex-col overflow-hidden rounded-xl',
          isWorktree && 'file-tree-worktree',
        )}
      >
        <SidebarHeaderWithSearch
          title="Files"
          searchPlaceholder={headerPlaceholder}
          searchQuery={headerSearchQuery}
          onSearchChange={handleHeaderSearchChange}
          searchInputRef={searchInputRef}
          onClose={onClose}
          closeTooltipLabel="Close files"
          closeShortcutId="toggle-files"
          showClearInInput
          searchInputClassName={FILES_SIDEBAR_SEARCH_INPUT_CLASS}
          className="pt-3! px-2 pb-0"
        />
        <div className="flex items-center gap-1.5 border-b border-border/25 px-3 pb-2">
          <Button
            variant="ghost"
            size="sm"
            onClick={() => setActiveTab('files')}
            aria-pressed={activeTab === 'files'}
            className={filesSidebarTabButtonClass(activeTab === 'files')}
          >
            Files
          </Button>
          <Button
            variant="ghost"
            size="sm"
            onClick={() => setActiveTab('search')}
            aria-pressed={activeTab === 'search'}
            className={filesSidebarTabButtonClass(activeTab === 'search')}
          >
            Search
          </Button>
          {activeTab === 'search' && (
            <ContentSearchOptionsRow
              options={contentSearchOptions}
              onChange={setContentSearchOptions}
            />
          )}
          {activeTab === 'files' && hasGitDiff && !isSearching && (
            <ModifiedOnlyToggle
              active={showModifiedOnly}
              onToggle={() => {
                multiSelect.clearSelection();
                setShowModifiedOnly((prev) => !prev);
              }}
            />
          )}
        </div>

        {activeTab === 'files' ? (
          <RootCreateContextMenu onCreate={setRootCreating}>
            <PaneTreeDropRoot
              ref={treeContainerRef}
              dropId={rootDropId}
              dropData={rootDropData}
              role="tree"
              aria-label={`${projectName} file tree`}
              aria-multiselectable="true"
              aria-keyshortcuts={FILE_TREE_KEY_SHORTCUTS}
              aria-busy={isLoading ? 'true' : undefined}
              tabIndex={0}
              data-drop-target="root"
              className={cn(
                'flex-1 overflow-y-auto overflow-x-hidden px-2 py-1.5 scrollbar-thin outline-hidden transition-colors',
                'focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-primary/40',
                externalFileDrop.isDragOver && 'bg-primary/5 ring-1 ring-inset ring-primary/30',
              )}
              overClassName="bg-primary/5 ring-1 ring-inset ring-primary/20"
              onDragOver={externalFileDrop.onDragOver}
              onDragLeave={externalFileDrop.onDragLeave}
              onDrop={externalFileDrop.onDrop}
              onPaste={handlePasteEvent}
            >
              {/* Announces drop acceptance to screen readers during external file drag-over */}
              <span className="sr-only" role="status" aria-live="polite">
                {externalFileDrop.isDragOver
                  ? `Drop files to copy into ${projectName} file tree`
                  : ''}
              </span>
              {rootCreating && (
                <div className="mb-0.5">
                  <InlineInput
                    type={rootCreating}
                    level={0}
                    onConfirm={(name) => {
                      if (rootCreating === 'file') handleCreateFile(name);
                      else handleCreateFolder(name);
                      setRootCreating(null);
                    }}
                    onCancel={() => setRootCreating(null)}
                  />
                </div>
              )}
              {isLoading ? (
                <LoadingState />
              ) : (
                <ModifiedFilterContext.Provider value={showModifiedOnly && !isSearching}>
                  <RefreshContext.Provider value={refreshTrigger}>
                    <FileTree
                      key={`${projectPath}-${isSearching ? 'search' : 'browse'}`}
                      nodes={nodes}
                      projectPath={projectPath}
                      paneIndex={paneIndex}
                      manageDnd={false}
                      onFileClick={handleFileClick}
                      searchQuery={fileDebouncedQuery}
                      onMoveFile={isSearching ? undefined : handleMoveFile}
                      onBatchMoveFiles={isSearching ? undefined : handleBatchMoveFiles}
                      onCreateFile={isSearching ? undefined : handleCreateFile}
                      onCreateFolder={isSearching ? undefined : handleCreateFolder}
                      onDeleteFile={isSearching ? undefined : handleDeleteFile}
                      onSelect={isSearching ? undefined : handleSelect}
                      renamingPath={isSearching ? undefined : renamingPath}
                      onRenameConfirm={isSearching ? undefined : handleRenameConfirm}
                      onRenameCancel={isSearching ? undefined : handleRenameCancel}
                      onStartRename={isSearching ? undefined : setRenamingPath}
                      onCopyItem={isSearching ? undefined : handleInternalCopy}
                      onPasteIntoFolder={isSearching ? undefined : handlePaste}
                      hasCopiedItem={isSearching ? undefined : hasCopiedItem}
                      selectionStore={isSearching ? undefined : multiSelect.selectionStore}
                      onModifiedClick={isSearching ? undefined : handleModifiedClick}
                      onBatchDelete={isSearching ? undefined : handleBatchDelete}
                      deselectDescendants={
                        isSearching ? undefined : multiSelect.deselectDescendants
                      }
                      pathToExpandAfterDrop={isSearching ? undefined : pathToExpandAfterDrop}
                    />
                  </RefreshContext.Provider>
                </ModifiedFilterContext.Provider>
              )}
            </PaneTreeDropRoot>
          </RootCreateContextMenu>
        ) : (
          <ContentSearchResults
            isLoading={isLoading}
            query={contentDebouncedQuery}
            invalidRegex={contentSearchInvalidRegex}
            matches={contentMatches}
            onSelectMatch={handleSelectContentMatch}
            renderLine={highlightContentMatch}
          />
        )}

        <FilesSidebarFooter
          projectName={projectName}
          projectPath={projectPath}
          worktreePath={isWorktree ? projectPath : undefined}
          selectedCount={multiSelect.count}
          compact
        />
      </div>
    </div>
  );
});
