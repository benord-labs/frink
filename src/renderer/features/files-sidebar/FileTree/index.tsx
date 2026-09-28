/* eslint-disable max-lines, max-lines-per-function */
import {
  DndContext,
  type DragEndEvent,
  DragOverlay,
  type DragStartEvent,
  PointerSensor,
  useDndContext,
  useDroppable,
  useSensor,
  useSensors,
} from '@dnd-kit/core';
import type { ReactElement, ReactNode } from 'react';
import { memo, useCallback, useMemo, useRef, useState } from 'react';
import { Files, Folder } from 'lucide-react';
import { overlayGlass } from '@/lib/overlay-styles';
import { cn } from '@/lib/utils';
import { getFileIconByExtension } from '../../agents/mentions/agents-file-mention';
import type { CreatingItem, FileTreeNode } from '../types';
import { fileTreeDndMeasuring } from '../utils/file-tree-dnd-measuring';
import { InlineInput } from './InlineInput';
import { SelectionActionsContext, SelectionStateContext } from './MultiSelectContext';
import { useModifiedFilter } from './modified-filter-context';
import { TreeNode, type TreeNodeDragData, type TreeNodeDropData } from './TreeNode';
import { NOOP_SELECTION_STORE, type SelectionStore } from './use-multi-select';

/**
 * Visual indicator that appears at the bottom of the tree during drag.
 * The actual root drop target is the tree container itself (registered
 * by the parent component or RootDropWrapper), so this is purely a visual hint.
 */
function RootDropHint() {
  const { active } = useDndContext();
  if (active?.data.current?.type !== 'tree-node') return null;

  return (
    <div className="mt-1 py-1.5 px-2 rounded-md text-xs text-center text-muted-foreground/40 border border-dashed border-border/30">
      Project root
    </div>
  );
}

/**
 * Wraps tree content with a root droppable when FileTree manages its own DndContext.
 * Dropping on empty space (not on a specific TreeNode) falls through to this target.
 */
function RootDropWrapper({ projectPath, children }: { projectPath: string; children: ReactNode }) {
  const { active } = useDndContext();
  const dropData = useMemo<TreeNodeDropData>(
    () => ({ type: 'tree-root', folderPath: '', projectPath }),
    [projectPath],
  );
  const { setNodeRef, isOver } = useDroppable({
    id: `tree-root-wrapper-${projectPath}`,
    data: dropData,
  });

  return (
    <div
      ref={setNodeRef}
      className={cn('min-h-full transition-colors', active && isOver && 'bg-primary/5')}
    >
      {children}
    </div>
  );
}

type Props = {
  /** Root-level nodes (fetched by parent) */
  nodes: FileTreeNode[];
  /** Project root path for lazy loading children */
  projectPath: string;
  /** Split-pane source index for drag metadata; undefined in standalone sidebar */
  paneIndex?: number;
  onFileClick: (path: string) => void;
  searchQuery?: string;
  /** Called when a file/folder is dragged to a new location */
  onMoveFile?: (sourcePath: string, destinationFolder: string) => void;
  /** Called when the user confirms creating a new file */
  onCreateFile?: (relativePath: string) => void;
  /** Called when the user confirms creating a new folder */
  onCreateFolder?: (relativePath: string) => void;
  /** Called when the user requests to delete a file/folder */
  onDeleteFile?: (relativePath: string) => void;
  /** Called when a node is clicked to select it */
  onSelect?: (path: string, name: string, type: 'file' | 'folder') => void;
  /** Path currently being renamed */
  renamingPath?: string | null;
  /** Called when rename is confirmed */
  onRenameConfirm?: (newName: string) => void;
  /** Called when rename is cancelled */
  onRenameCancel?: () => void;
  /** Called to initiate rename on a node (from context menu) */
  onStartRename?: (path: string) => void;
  /** Called to copy a node path into the internal file-tree clipboard */
  onCopyItem?: (path: string) => void;
  /** Called to paste into a specific destination folder */
  onPasteIntoFolder?: (targetFolder: string) => void;
  /** Whether internal file-tree clipboard currently has a copied item */
  hasCopiedItem?: boolean;
  /** Whether an inline input is currently active (exposed for keyboard hook) */
  isCreating?: boolean;
  /**
   * When `true` (default), FileTree renders its own DndContext + DragOverlay.
   * Set to `false` when a parent component provides a shared DndContext
   * (e.g. SplitViewContainer for cross-project DnD).
   */
  manageDnd?: boolean;
  /** Ref-stable selection store; nodes subscribe to only their own selected-bit */
  selectionStore?: SelectionStore;
  /** Called when a modifier click occurs (Cmd+Click, Shift+Click) */
  onModifiedClick?: (
    path: string,
    name: string,
    type: 'file' | 'folder',
    modifiers: { shift: boolean; meta: boolean },
  ) => void;
  /** Batch delete callback for multi-selection context menu */
  onBatchDelete?: (paths: string[]) => void;
  /** Remove descendants of a collapsed folder from selection */
  deselectDescendants?: (folderPath: string) => void;
  /**
   * Called after a batch DnD move completes (for clearing multi-selection).
   * Only used when `manageDnd` is true (standalone FilesSidebar).
   * In multi-pane mode (`manageDnd={false}`), the parent DndContext in
   * SplitViewContainer handles selection clearing via imperative refs.
   */
  onBatchDragComplete?: () => void;
  /** Batch move callback — replaces N individual onMoveFile calls with aggregated results */
  onBatchMoveFiles?: (sourcePaths: string[], destinationFolder: string) => void;
  /** When set, folder with this path should expand (e.g. after drop); parent clears after tick */
  pathToExpandAfterDrop?: string | null;
};

// Shared move-guard helpers — reused across FileTree and SplitViewContainer
import { collectMovableItems } from '../utils/move-guards';

/** Module-level: dnd-kit's useSensor memoizes on the options object, so an inline literal rebuilds
 * DndContext's internal context every render and re-renders every draggable past its memo (sc-2721). */
const POINTER_SENSOR_OPTIONS = { activationConstraint: { distance: 8 } };

export const FileTree = memo(function FileTree({
  nodes,
  projectPath,
  paneIndex,
  onFileClick,
  searchQuery,
  onMoveFile,
  onCreateFile,
  onCreateFolder,
  onDeleteFile,
  onSelect,
  renamingPath,
  onRenameConfirm,
  onRenameCancel,
  onStartRename,
  onCopyItem,
  onPasteIntoFolder,
  hasCopiedItem,
  manageDnd = true,
  selectionStore,
  onModifiedClick,
  onBatchDelete,
  deselectDescendants,
  onBatchDragComplete,
  onBatchMoveFiles,
  pathToExpandAfterDrop,
}: Props): ReactElement {
  const showModifiedOnly = useModifiedFilter();
  const [activeItem, setActiveItem] = useState<TreeNodeDragData | null>(null);
  const [creatingItem, setCreatingItem] = useState<CreatingItem | null>(null);
  const creatingItemRef = useRef<CreatingItem | null>(null);
  creatingItemRef.current = creatingItem;

  // 8px activation distance to avoid accidental drags on click
  const sensors = useSensors(useSensor(PointerSensor, POINTER_SENSOR_OPTIONS));

  const handleDragStart = useCallback((event: DragStartEvent) => {
    const data = event.active.data.current as TreeNodeDragData | undefined;
    if (data?.type === 'tree-node') {
      setActiveItem(data);
    }
  }, []);

  const handleDragEnd = useCallback(
    (event: DragEndEvent) => {
      setActiveItem(null);

      if (!onMoveFile) return;

      const dragData = event.active.data.current as TreeNodeDragData | undefined;
      const dropData = event.over?.data.current as TreeNodeDropData | undefined;

      if (!dragData || !dropData) return;

      // Only accept drops on tree-folder or tree-root targets
      if (dropData.type !== 'tree-folder' && dropData.type !== 'tree-root') return;

      const destFolder = dropData.folderPath;

      // Collect, dedup, and filter to only movable items
      const movable = collectMovableItems(dragData, destFolder);
      if (movable.length === 0) return;

      // Use batch endpoint for multiple items, single endpoint for one
      if (movable.length > 1 && onBatchMoveFiles) {
        onBatchMoveFiles(
          movable.map((m) => m.path),
          destFolder,
        );
      } else {
        for (const item of movable) {
          onMoveFile(item.path, destFolder);
        }
      }

      // Clear multi-selection after a batch drag-and-drop move
      if (dragData.batchItems && dragData.batchItems.length > 0) {
        onBatchDragComplete?.();
      }
    },
    [onMoveFile, onBatchMoveFiles, onBatchDragComplete],
  );

  const handleDragCancel = useCallback(() => {
    setActiveItem(null);
  }, []);

  // Called by TreeNode context menu when user clicks "New File..." or "New Folder..."
  const handleCreateItem = useCallback((parentFolder: string, type: 'file' | 'folder') => {
    setCreatingItem({ parentFolder, type });
  }, []);

  // Called when the user confirms the name in InlineInput
  const handleInlineConfirm = useCallback(
    (name: string) => {
      const item = creatingItemRef.current;
      if (!item) return;
      const relativePath = item.parentFolder ? `${item.parentFolder}/${name}` : name;
      if (item.type === 'file') {
        onCreateFile?.(relativePath);
      } else {
        onCreateFolder?.(relativePath);
      }
      setCreatingItem(null);
    },
    [onCreateFile, onCreateFolder],
  );

  const handleInlineCancel = useCallback(() => {
    setCreatingItem(null);
  }, []);

  // Get the icon for the drag overlay (only used when manageDnd = true)
  // biome-ignore lint/style/useNamingConvention: component type variable
  const ActiveIcon = activeItem
    ? activeItem.nodeType === 'folder'
      ? Folder
      : (getFileIconByExtension(activeItem.nodeName) ?? Files)
    : null;

  // Stable callbacks context — consumers here never re-render on selection changes.
  const selectionActions = useMemo(
    () => ({
      onModifiedClick,
      onBatchDelete,
      deselectDescendants,
    }),
    [onModifiedClick, onBatchDelete, deselectDescendants],
  );

  if (nodes.length === 0) {
    return (
      <div className="py-8 text-center text-sm text-muted-foreground/60">
        {showModifiedOnly
          ? 'No modified files'
          : searchQuery
            ? 'No files found'
            : 'No files in project'}
      </div>
    );
  }

  // Check if we're creating at root level (parentFolder = "")
  const isCreatingAtRoot = creatingItem && creatingItem.parentFolder === '';

  const treeContent = (
    <SelectionActionsContext.Provider value={selectionActions}>
      <SelectionStateContext.Provider value={selectionStore ?? NOOP_SELECTION_STORE}>
        <div className="space-y-0.5">
          {/* Inline input at root level (before other items) */}
          {isCreatingAtRoot && (
            <InlineInput
              type={creatingItem.type}
              level={0}
              onConfirm={handleInlineConfirm}
              onCancel={handleInlineCancel}
            />
          )}
          {nodes.map((node) => (
            <TreeNode
              key={node.id}
              node={node}
              level={0}
              projectPath={projectPath}
              paneIndex={paneIndex}
              onFileClick={onFileClick}
              searchQuery={searchQuery}
              onCreateItem={handleCreateItem}
              onDeleteItem={onDeleteFile}
              creatingItem={creatingItem}
              onInlineConfirm={handleInlineConfirm}
              onInlineCancel={handleInlineCancel}
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
          {/* Visual hint — actual root drop target is the parent scroll container */}
          <RootDropHint />
        </div>
      </SelectionStateContext.Provider>
    </SelectionActionsContext.Provider>
  );

  // When manageDnd is false, a parent DndContext handles drag events and overlay.
  if (!manageDnd) {
    return treeContent;
  }

  return (
    <DndContext
      sensors={sensors}
      onDragStart={handleDragStart}
      onDragEnd={handleDragEnd}
      onDragCancel={handleDragCancel}
      measuring={fileTreeDndMeasuring}
      autoScroll={{
        enabled: true,
        threshold: { x: 0, y: 0.15 },
        acceleration: 10,
      }}
    >
      <RootDropWrapper projectPath={projectPath}>{treeContent}</RootDropWrapper>

      {/* Drag overlay: floating preview of the dragged item */}
      <DragOverlay dropAnimation={null}>
        {activeItem && ActiveIcon && (
          <div
            className={cn(
              'flex items-center gap-1.5 py-1 px-2 rounded-md text-sm',
              'border shadow-md text-foreground',
              overlayGlass,
            )}
          >
            <ActiveIcon className="h-4 w-4 shrink-0 text-muted-foreground" />
            <span className="truncate max-w-[180px]">{activeItem.nodeName}</span>
            {activeItem.batchItems && activeItem.batchItems.length > 0 && (
              <span className="ml-0.5 inline-flex items-center justify-center size-5 rounded-full bg-primary text-primary-foreground text-[10px] font-medium">
                +{activeItem.batchItems.length}
              </span>
            )}
          </div>
        )}
      </DragOverlay>
    </DndContext>
  );
});
