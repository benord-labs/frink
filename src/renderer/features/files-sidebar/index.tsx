/* eslint-disable max-lines, max-lines-per-function */

import { Button } from '@benord-labs/frink-primitives';
import { useAtom, useAtomValue, useSetAtom } from 'jotai';
import type { ReactElement } from 'react';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { ResizableSidebar } from '@/components/ui/resizable-sidebar';
import { openFileAtom } from '@/lib/code-editor/state';
import { trpc } from '@/lib/trpc';
import { cn } from '@/lib/utils';
import { recentlyOpenedFilesAtom, selectedProjectAtom } from '../agents/atoms';
import { SidebarHeaderWithSearch } from '../sidebar/components/SidebarHeaderWithSearch';
import {
  type FilesSidebarTab,
  filesSidebarActiveTabAtom,
  filesSidebarOpenAtom,
  filesSidebarWidthAtom,
} from './atoms';
import { ContentSearchOptionsRow } from './ContentSearchOptionsRow';
import { ContentSearchResults } from './ContentSearchResults';
import { FILES_SIDEBAR_SEARCH_INPUT_CLASS, filesSidebarTabButtonClass } from './chrome';
import {
  FILE_TREE_KEY_SHORTCUTS,
  FILES_FETCH_LIMIT,
  SIDEBAR_MAX_WIDTH,
  SIDEBAR_MIN_WIDTH,
} from './constants';
import { FilesSidebarFooter } from './FilesSidebarFooter';
import { FileTree } from './FileTree';
import { InlineInput } from './FileTree/InlineInput';
import { ModifiedFilterContext } from './FileTree/modified-filter-context';
import { RefreshContext } from './FileTree/RefreshContext';
import { useMultiSelect } from './FileTree/use-multi-select';
import { LoadingState } from './LoadingState';
import { ModifiedOnlyToggle } from './ModifiedOnlyToggle';
import { RootCreateContextMenu } from './RootCreateContextMenu';
import {
  invalidateFileTreeQueries,
  triggerFileTreeReveal,
  useFileTreeRefreshListeners,
} from './refresh-trigger';
import { useChatContextFile } from './use-chat-context-file';
import { useContentSearchTab } from './use-content-search-tab';
import { useExternalFileDrop } from './use-external-file-drop';
import { useFileTreeHotkeys } from './use-file-tree-hotkeys';
import { useFileTreeNavigation } from './use-file-tree-navigation';
import { useSearchDebounce } from './use-search-debounce';
import { mutateWithLoadingToast, showMoveToast, showTrashToast } from './utils/batch-result-toasts';
import { useFileTreeNodes } from './utils/build-file-tree';
import {
  activateSearchTabAndFocus,
  openContentSearchMatchInEditor,
} from './utils/content-search-actions';
import { createCopyExternalFilesHandlers } from './utils/file-mutation-handlers';
import { getVisiblePaths } from './utils/get-visible-paths';
import { duplicateFileToDestination, pasteCopiedPath } from './utils/internal-copy-paste';
import { createMetaLookupFromDOM } from './utils/meta-lookup-from-dom';
import {
  resolveActiveWorktreePath,
  resolveEffectiveProjectPath,
  resolveScopedChatWorktreePath,
} from './utils/resolve-effective-project-path';

type Props = {
  /** Callback to insert file mention into chat input */
  onFileSelect?: (filePath: string) => void;
  /** Chat ID for per-chat context file tracking */
  chatId?: string;
  /** Current chat worktree path (when chat is running in a worktree). */
  worktreePath?: string;
};

export function FilesSidebar({ onFileSelect, chatId, worktreePath }: Props): ReactElement | null {
  const [isOpen, setIsOpen] = useAtom(filesSidebarOpenAtom);
  const [activeTab, setActiveTab] = useAtom(filesSidebarActiveTabAtom);
  const selectedProject = useAtomValue(selectedProjectAtom);
  const openFile = useSetAtom(openFileAtom);
  const setRecentlyOpenedFiles = useSetAtom(recentlyOpenedFilesAtom);
  const { setContextFileFromPath } = useChatContextFile(chatId, 'FilesSidebar');
  const { data: fileTreeChatData } = trpc.chats.get.useQuery(
    { id: chatId ?? '' },
    { enabled: !!chatId },
  );

  const rawWorktreePath = resolveScopedChatWorktreePath({
    activeChatId: chatId,
    queriedChatId: fileTreeChatData?.id,
    queriedWorktreePath: fileTreeChatData?.worktreePath,
    fallbackWorktreePath: worktreePath,
  });
  const activeWorktreePath = resolveActiveWorktreePath({
    rawWorktreePath,
    selectedProjectPath: selectedProject?.path,
  });
  const effectiveProjectPath = resolveEffectiveProjectPath({
    worktreePath: activeWorktreePath,
    selectedProjectPath: selectedProject?.path,
  });
  // Single derived gate for all queries, effects, and rendering that need a local project path.
  const canAccessFiles = isOpen && !!effectiveProjectPath;

  // Files tree name search
  const {
    searchQuery: fileSearchQuery,
    debouncedQuery: fileDebouncedQuery,
    setSearchQuery: setFileSearchQuery,
  } = useSearchDebounce();
  const isSearching = activeTab === 'files' && fileDebouncedQuery.length > 0;
  const [showModifiedOnly, setShowModifiedOnly] = useState(false);

  const searchInputRef = useRef<HTMLInputElement>(null);

  const utils = trpc.useUtils();

  // Lazy loading: Fetch only root level contents (no search query)
  const { data: rawRootContents, isLoading: isLoadingRoot } = trpc.files.listDirectory.useQuery(
    {
      projectPath: effectiveProjectPath || '',
      relativePath: '',
    },
    {
      enabled: canAccessFiles && !isSearching,
      refetchOnMount: 'always',
    },
  );

  const { refreshTrigger, setRefreshTrigger, pathToExpandAfterDrop, setPathToExpandAfterDrop } =
    useFileTreeRefreshListeners({ projectPath: effectiveProjectPath });

  const rootContents = Array.isArray(rawRootContents) ? rawRootContents : [];

  // Search mode: Fetch filtered results (when searching)
  const { data: rawSearchResults, isLoading: isLoadingSearch } = trpc.files.search.useQuery(
    {
      projectPath: effectiveProjectPath || '',
      query: fileDebouncedQuery,
      limit: FILES_FETCH_LIMIT,
    },
    {
      enabled: canAccessFiles && isSearching,
      refetchOnMount: 'always',
    },
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
    projectPath: effectiveProjectPath || '',
    canSearch: canAccessFiles,
    isSearchTabActive: activeTab === 'search',
  });

  const isLoading =
    activeTab === 'search' ? isLoadingContentSearch : isSearching ? isLoadingSearch : isLoadingRoot;

  const { nodes, hasGitDiff } = useFileTreeNodes({
    rootContents,
    searchResults,
    isSearching,
    showModifiedOnly,
  });

  // Invalidate list + search and bump refresh (shared helper); used by all mutations below
  const invalidateTree = useCallback(
    () => invalidateFileTreeQueries(utils, setRefreshTrigger),
    [utils],
  );

  const copyExternalFilesHandlers = useMemo(
    () => createCopyExternalFilesHandlers(invalidateTree),
    [invalidateTree],
  );

  // Move file/folder mutation (drag-and-drop)
  const moveFileMutation = trpc.files.moveFile.useMutation({
    onSuccess: invalidateTree,
  });

  const moveFileMutate = moveFileMutation.mutate;
  const handleMoveFile = useCallback(
    (sourcePath: string, destinationFolder: string) => {
      if (!effectiveProjectPath) return;
      moveFileMutate(
        {
          projectPath: effectiveProjectPath,
          sourcePath,
          destinationFolder,
        },
        {
          onSuccess: () => {
            if (destinationFolder) {
              triggerFileTreeReveal(effectiveProjectPath, destinationFolder);
            }
          },
        },
      );
    },
    [effectiveProjectPath, moveFileMutate],
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
      if (!effectiveProjectPath) return;
      batchMoveMutate(
        {
          projectPath: effectiveProjectPath,
          sourcePaths,
          destinationFolder,
        },
        {
          onSuccess: () => {
            if (destinationFolder) {
              triggerFileTreeReveal(effectiveProjectPath, destinationFolder);
            }
          },
        },
      );
    },
    [effectiveProjectPath, batchMoveMutate],
  );

  const createFileMutation = trpc.files.createFile.useMutation({ onSuccess: invalidateTree });
  const createFolderMutation = trpc.files.createFolder.useMutation({ onSuccess: invalidateTree });
  const deleteFileMutation = trpc.files.deleteFile.useMutation({ onSuccess: invalidateTree });
  const renameFileMutation = trpc.files.renameFile.useMutation({ onSuccess: invalidateTree });
  const duplicateFileMutation = trpc.files.duplicateFile.useMutation({ onSuccess: invalidateTree });
  const copyExternalFilesMutation =
    trpc.files.copyExternalFiles.useMutation(copyExternalFilesHandlers);

  const handleCreateFile = useCallback(
    (relativePath: string) => {
      if (!effectiveProjectPath) return;
      createFileMutation.mutate({ projectPath: effectiveProjectPath, relativePath });
    },
    [effectiveProjectPath, createFileMutation],
  );

  const handleCreateFolder = useCallback(
    (relativePath: string) => {
      if (!effectiveProjectPath) return;
      createFolderMutation.mutate({ projectPath: effectiveProjectPath, relativePath });
    },
    [effectiveProjectPath, createFolderMutation],
  );

  const handleDeleteFile = useCallback(
    (relativePath: string) => {
      if (!effectiveProjectPath) return;
      const name = relativePath.split('/').pop() ?? relativePath;
      if (window.confirm(`Move "${name}" to Trash?`)) {
        deleteFileMutation.mutate({ projectPath: effectiveProjectPath, relativePath });
      }
    },
    [effectiveProjectPath, deleteFileMutation],
  );

  const handleRenameFile = useCallback(
    (relativePath: string, newName: string) => {
      if (!effectiveProjectPath) return;
      renameFileMutation.mutate({ projectPath: effectiveProjectPath, relativePath, newName });
    },
    [effectiveProjectPath, renameFileMutation],
  );

  const handleDuplicateFile = useCallback(
    (relativePath: string, destinationFolder?: string) => {
      if (!effectiveProjectPath) return;
      duplicateFileToDestination({
        mutate: duplicateFileMutation.mutate,
        projectPath: effectiveProjectPath,
        relativePath,
        destinationFolder,
      });
    },
    [effectiveProjectPath, duplicateFileMutation],
  );

  // --- Selection / rename / copy state ---
  const multiSelect = useMultiSelect();
  const copiedPathRef = useRef<string | null>(null);
  const [hasCopiedItem, setHasCopiedItem] = useState(false);

  // Clear selection and filter when the active project changes
  const projectPathRef = useRef(effectiveProjectPath);
  useEffect(() => {
    if (effectiveProjectPath !== projectPathRef.current) {
      multiSelect.clearSelection();
      copiedPathRef.current = null;
      setHasCopiedItem(false);
      setShowModifiedOnly(false);
      projectPathRef.current = effectiveProjectPath;
    }
  }, [effectiveProjectPath, multiSelect.clearSelection]);

  useEffect(() => {
    if (!hasGitDiff) {
      if (showModifiedOnly) {
        setShowModifiedOnly(false);
        multiSelect.clearSelection();
      }
    }
  }, [hasGitDiff, showModifiedOnly, multiSelect.clearSelection]);

  const [renamingPath, setRenamingPath] = useState<string | null>(null);

  const treeContainerRef = useRef<HTMLDivElement>(null);

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
    projectPath: effectiveProjectPath ?? '',
    treeContainerRef,
    enabled: canAccessFiles && !isSearching,
    copyExternalFilesMutate: copyExternalFilesMutation.mutate,
    getDestinationFolder: getDestinationFolderForPaste,
  });

  // State for creating at root via empty-space context menu
  const [rootCreating, setRootCreating] = useState<'file' | 'folder' | null>(null);

  const handleRootCreateConfirm = useCallback(
    (type: 'file' | 'folder', relativePath: string) => {
      if (type === 'file') {
        handleCreateFile(relativePath);
      } else {
        handleCreateFolder(relativePath);
      }
      setRootCreating(null);
    },
    [handleCreateFile, handleCreateFolder],
  );

  const handleClose = useCallback(() => {
    setIsOpen(false);
    multiSelect.clearSelection();
    setRenamingPath(null);
  }, [setIsOpen, multiSelect.clearSelection]);

  const handleFileClick = useCallback(
    (filePath: string) => {
      const fileName = filePath.split('/').pop() ?? filePath;
      openFile({
        path: filePath,
        name: fileName,
        projectPath: effectiveProjectPath,
        sourceChatId: chatId,
        isWorktreeContext: Boolean(activeWorktreePath),
        intent: 'preview',
      });
      setRecentlyOpenedFiles((prev) =>
        [filePath, ...prev.filter((p) => p !== filePath)].slice(0, 50),
      );
      setContextFileFromPath(filePath);
      if (onFileSelect) {
        onFileSelect(filePath);
      }
    },
    [
      chatId,
      onFileSelect,
      openFile,
      setContextFileFromPath,
      effectiveProjectPath,
      activeWorktreePath,
      setRecentlyOpenedFiles,
    ],
  );

  // Selection handler
  const handleSelect = useCallback(
    (path: string, name: string, type: 'file' | 'folder') => {
      multiSelect.selectOne(path, { name, type });
    },
    [multiSelect.selectOne],
  );

  /** Helper: look up node metadata from the DOM */
  const metaLookupFromDOM = useCallback(
    (path: string) => createMetaLookupFromDOM(treeContainerRef.current)(path),
    [],
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
        const paths = getVisiblePaths(treeContainerRef.current);
        multiSelect.selectRange(path, paths, metaLookupFromDOM);
      } else if (modifiers.meta) {
        multiSelect.toggleItem(path, { name, type });
      }
    },
    [multiSelect.selectRange, multiSelect.toggleItem, metaLookupFromDOM],
  );

  // Rename handlers
  const handleRenameConfirm = useCallback(
    (newName: string) => {
      if (!renamingPath) return;
      handleRenameFile(renamingPath, newName);
      setRenamingPath(null);
    },
    [renamingPath, handleRenameFile],
  );

  const handleRenameCancel = useCallback(() => {
    setRenamingPath(null);
  }, []);

  // Select-by-path (for arrow keys) — finds node info from DOM
  const handleSelectByPath = useCallback(
    (path: string) => {
      multiSelect.selectOne(path, metaLookupFromDOM(path));
    },
    [multiSelect.selectOne, metaLookupFromDOM],
  );

  const toggleNodeExpansion = useCallback((path: string) => {
    const el = treeContainerRef.current?.querySelector(
      `[data-tree-path="${CSS.escape(path)}"]`,
    ) as HTMLButtonElement | null;
    if (el) el.click();
  }, []);

  const handleIsExpanded = useCallback((path: string): boolean => {
    const el = treeContainerRef.current?.querySelector(`[data-tree-path="${CSS.escape(path)}"]`);
    if (!el) return false;
    // The chevron rotates 90deg when expanded
    const chevron = el.querySelector('.lucide-chevron-right');
    return chevron?.classList.contains('rotate-90') ?? false;
  }, []);

  // Paste = duplicate the copied file (creates a "copy" variant, like VS Code)
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

  // Single paste handler: try external (clipboard file URIs) first, then internal (copied path).
  // Cmd+V is no longer handled in keydown so the paste event can fire.
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

  // Lazily compute visible paths from the DOM (called inside keyboard handler)
  const getVisiblePathsCallback = useCallback(() => getVisiblePaths(treeContainerRef.current), []);

  // Focus the tree when requested by the toggle-files shortcut (Cmd+Shift+F opening)
  useEffect(() => {
    const handleFocusTree = () => {
      treeContainerRef.current?.focus();
    };
    window.addEventListener('file-tree:focus', handleFocusTree);
    return () => window.removeEventListener('file-tree:focus', handleFocusTree);
  }, []);

  // Switch to "Search" tab + focus search input when requested by shortcut
  useEffect(() => {
    const handleActivateSearch = () => {
      activateSearchTabAndFocus(setActiveTab, searchInputRef);
    };
    window.addEventListener('file-tree:activate-search', handleActivateSearch);
    return () => window.removeEventListener('file-tree:activate-search', handleActivateSearch);
  }, [setActiveTab]);

  // Derive a single selectedNode for backwards compat with hooks
  const selectedNode = multiSelect.getPrimary();

  // Whether any inline input is active
  const isInlineActive = !!rootCreating || !!renamingPath;

  // Batch delete handler
  const batchDeleteMutation = trpc.files.batchDeleteFiles.useMutation({
    onSuccess: (result) => {
      invalidateTree();
      showTrashToast(result.results);
    },
  });
  const handleBatchDelete = useCallback(
    (paths: string[]) => {
      if (!effectiveProjectPath) return;
      const count = paths.length;
      if (window.confirm(`Move ${count} items to Trash?`)) {
        mutateWithLoadingToast({
          mutate: batchDeleteMutation.mutate,
          input: { projectPath: effectiveProjectPath, relativePaths: paths },
          loadingMessage: `Moving ${count} items to Trash...`,
          errorMessage: 'Batch delete failed',
        });
        multiSelect.clearSelection();
      }
    },
    [effectiveProjectPath, batchDeleteMutation.mutate, multiSelect.clearSelection],
  );

  const getSelectedPaths = useCallback(
    () => Array.from(multiSelect.selection.paths),
    [multiSelect.selection.paths],
  );

  // --- Global file shortcuts (auto-open sidebar if closed, then perform action) ---
  const openSidebar = useCallback(() => setIsOpen(true), [setIsOpen]);
  useFileTreeHotkeys({
    projectPath: canAccessFiles ? effectiveProjectPath : undefined,
    isOpen,
    onOpen: openSidebar,
    onSetRootCreating: setRootCreating,
    onDeleteFile: handleDeleteFile,
    selectedNodePath: selectedNode?.path ?? null,
    isInlineActive,
    treeContainerRef,
    onBatchDelete: handleBatchDelete,
    getSelectedPaths,
  });

  // Extend selection for Shift+Arrow
  const handleExtendSelection = useCallback(
    (toPath: string) => {
      const paths = getVisiblePaths(treeContainerRef.current);
      multiSelect.selectRange(toPath, paths, metaLookupFromDOM);
    },
    [multiSelect.selectRange, metaLookupFromDOM],
  );

  // Select all visible paths
  const handleSelectAll = useCallback(() => {
    const paths = getVisiblePaths(treeContainerRef.current);
    multiSelect.selectAll(paths, metaLookupFromDOM);
  }, [multiSelect.selectAll, metaLookupFromDOM]);

  // Keyboard hook (focus-dependent shortcuts: rename, duplicate, copy, paste, arrows)
  useFileTreeNavigation(treeContainerRef, {
    selectedNode,
    getVisiblePaths: getVisiblePathsCallback,
    isInlineActive,
    onSelectByPath: handleSelectByPath,
    onClearSelection: multiSelect.clearSelection,
    onStartRename: useCallback((path: string) => setRenamingPath(path), []),
    onDuplicate: handleDuplicateFile,
    onCopy: handleInternalCopy,
    onExpand: toggleNodeExpansion,
    onCollapse: toggleNodeExpansion,
    isExpanded: handleIsExpanded,
    onOpenFile: handleFileClick,
    onExtendSelection: handleExtendSelection,
    onSelectAll: handleSelectAll,
  });

  // Don't render if no project is selected. Returning null while keeping the open atom
  // preserves the user's file tree preference.
  if (!selectedProject || !effectiveProjectPath) {
    return null;
  }

  const headerSearchQuery = activeTab === 'search' ? contentSearchQuery : fileSearchQuery;
  const headerSearchPlaceholder =
    activeTab === 'search' ? 'Search inside files...' : 'Search files...';
  const handleHeaderSearchChange = (query: string) => {
    if (activeTab === 'search') {
      setContentSearchQuery(query);
      return;
    }
    setFileSearchQuery(query);
  };
  const handleSelectContentMatch = (
    relativePath: string,
    lineNumber: number,
    startColumn: number,
    endColumn: number,
  ) => {
    if (!effectiveProjectPath) return;
    openContentSearchMatchInEditor(
      effectiveProjectPath,
      relativePath,
      lineNumber,
      startColumn,
      endColumn,
      handleFileClick,
    );
  };

  const renderTabButton = (tab: FilesSidebarTab, label: string) => (
    <Button
      variant="ghost"
      size="sm"
      key={tab}
      onClick={() => setActiveTab(tab)}
      className={filesSidebarTabButtonClass(activeTab === tab)}
      aria-pressed={activeTab === tab}
    >
      {label}
    </Button>
  );

  return (
    <ResizableSidebar
      isOpen={isOpen}
      onClose={handleClose}
      widthAtom={filesSidebarWidthAtom}
      side="left"
      minWidth={SIDEBAR_MIN_WIDTH}
      maxWidth={SIDEBAR_MAX_WIDTH}
      animationDuration={0}
      initialWidth={0}
      exitWidth={0}
      showResizeTooltip={true}
      className="bg-transparent"
    >
      <div className="mx-1 flex h-full min-h-0 flex-col py-2">
        <div
          className={cn(
            'unified-sidebar-glass flex min-h-0 flex-1 select-none flex-col overflow-hidden rounded-xl',
            activeWorktreePath && 'file-tree-worktree',
          )}
        >
          <SidebarHeaderWithSearch
            title="Files"
            searchPlaceholder={headerSearchPlaceholder}
            searchQuery={headerSearchQuery}
            onSearchChange={handleHeaderSearchChange}
            searchInputRef={searchInputRef}
            onClose={handleClose}
            closeTooltipLabel="Close files"
            closeShortcutId="toggle-files"
            showClearInInput
            searchInputClassName={FILES_SIDEBAR_SEARCH_INPUT_CLASS}
          />
          <div className="flex items-center gap-1.5 border-b border-border/25 px-3 pb-2">
            {renderTabButton('files', 'Files')}
            {renderTabButton('search', 'Search')}
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
              {/* role="tree" + tabIndex makes the container focusable for keyboard shortcuts */}
              <div
                ref={treeContainerRef}
                role="tree"
                aria-label={`${selectedProject.name} file tree`}
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
                onDragOver={externalFileDrop.onDragOver}
                onDragLeave={externalFileDrop.onDragLeave}
                onDrop={externalFileDrop.onDrop}
                onPaste={handlePasteEvent}
              >
                {/* Announces drop acceptance to screen readers during external file drag-over */}
                <span className="sr-only" role="status" aria-live="polite">
                  {externalFileDrop.isDragOver
                    ? `Drop files to copy into ${selectedProject.name} file tree`
                    : ''}
                </span>
                {/* Inline input for root-level creation (from empty-space context menu) */}
                {rootCreating && (
                  <div className="mb-0.5">
                    <InlineInput
                      type={rootCreating}
                      level={0}
                      onConfirm={(name) => handleRootCreateConfirm(rootCreating, name)}
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
                        key={`${effectiveProjectPath}-${isSearching ? 'search' : 'browse'}`}
                        nodes={nodes}
                        projectPath={effectiveProjectPath}
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
                        onBatchDragComplete={multiSelect.clearSelection}
                        pathToExpandAfterDrop={isSearching ? undefined : pathToExpandAfterDrop}
                      />
                    </RefreshContext.Provider>
                  </ModifiedFilterContext.Provider>
                )}
              </div>
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
            projectName={selectedProject.name}
            projectPath={effectiveProjectPath}
            worktreePath={activeWorktreePath}
            selectedCount={multiSelect.count}
          />
        </div>
      </div>
    </ResizableSidebar>
  );
}
