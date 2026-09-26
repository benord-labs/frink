/* eslint-disable max-lines, max-lines-per-function */
import {
  DndContext,
  type DragEndEvent,
  type DragOverEvent,
  DragOverlay,
  type DragStartEvent,
  PointerSensor,
  useSensor,
  useSensors,
} from '@dnd-kit/core';
import { atom, useAtom, useAtomValue, useSetAtom, useStore } from 'jotai';
import { Fragment, useCallback, useEffect, useRef, useState } from 'react';
import { type MoveResult, showMoveToast } from '@/features/files-sidebar/utils/batch-result-toasts';
import { getFileIconByExtension } from '@/lib/mentions/agents-file-mention-icons';
import { Folder, GripVertical } from 'lucide-react';
import { splitPaneFileTreesAtom } from '../../../../features/files-sidebar/atoms';
import {
  CrossProjectDropDialog,
  type CrossProjectDropInfo,
} from '../../../../features/files-sidebar/CrossProjectDropDialog';
import type {
  TreeNodeDragData,
  TreeNodeDropData,
} from '../../../../features/files-sidebar/FileTree/TreeNode';
import type { PaneFileTreeHandle } from '../../../../features/files-sidebar/PaneFileTree';
import {
  triggerFileTreeRefresh,
  triggerFileTreeReveal,
} from '../../../../features/files-sidebar/refresh-trigger';
import { useFileTreeHotkeys } from '../../../../features/files-sidebar/use-file-tree-hotkeys';
import { fileTreeDndMeasuring } from '../../../../features/files-sidebar/utils/file-tree-dnd-measuring';
import {
  collectMovableItems,
  deduplicateDescendants,
} from '../../../../features/files-sidebar/utils/move-guards';
import { permissionRequestChatIdAtom } from '../../../../hooks/usePermissionPrompts';
import { focusChatInput } from '../../../../lib/focus-chat-input';
import { getPaneColor } from '../../../../lib/pane-colors';
import { trpc } from '../../../../lib/trpc';
import { overlayGlass } from '@/lib/overlay-styles';
import { cn } from '../../../../lib/utils';
import { runChatShortcutAction } from '../../../../lib/work-queue/chat-owns-keyboard-shortcuts';
import { getDefaultGridRatios, getDefaultRatios } from '../../atoms';
import { GridDivider } from './GridDivider';
import {
  getGridArea,
  getGridDividerPlacements,
  getGridPanePlacement,
  getGridPaneResizeCorner,
  getGridStyle,
} from './grid-helpers';
import { CompactPaneDigitBadge } from './pane-number-badge';
import { SplitDivider } from './SplitDivider';
import { SplitPane } from './SplitPane';
import { SplitPaneBranchBarHeightProvider } from './SplitPaneBranchBarHeightSync';
import type { PaneReorderDragData, SplitViewContainerProps } from './types';

function refreshProjectTree(utils: ReturnType<typeof trpc.useUtils>, projectPath: string): void {
  utils.files.listDirectory.invalidate();
  utils.files.search.invalidate();
  triggerFileTreeRefresh(projectPath, { force: true });
}

/** Transient drag state kept in module-level atoms so that updates during a file drag do NOT
 * re-render SplitViewContainer (and cascade into every pane). Only DraggedItemCard reads them. */
const dndActiveItemAtom = atom<TreeNodeDragData | null>(null);
const dndOverProjectPathAtom = atom<string | null>(null);

/** Renders the floating preview of the dragged file/folder inside DragOverlay. Isolated so that
 * dragOver updates only re-render this tiny component, not the entire SplitViewContainer tree. */
function DraggedItemCard() {
  const dndActiveItem = useAtomValue(dndActiveItemAtom);
  const dndOverProjectPath = useAtomValue(dndOverProjectPathAtom);
  if (!dndActiveItem) return null;
  // biome-ignore lint/style/useNamingConvention: component type variable
  const Icon =
    dndActiveItem.nodeType === 'folder'
      ? Folder
      : getFileIconByExtension(dndActiveItem.nodeName, false);
  const isCrossProjectHover =
    !!dndOverProjectPath && dndOverProjectPath !== dndActiveItem.projectPath;
  const overProjectName = isCrossProjectHover ? dndOverProjectPath?.split('/').pop() : null;
  return (
    <div
      className={cn(
        'flex items-center gap-1.5 py-1 px-2 rounded-md border text-sm shadow-md text-foreground',
        overlayGlass,
      )}
    >
      <Icon className="h-4 w-4 shrink-0 text-muted-foreground" />
      <span className="truncate max-w-[180px]">{dndActiveItem.nodeName}</span>
      {dndActiveItem.batchItems && dndActiveItem.batchItems.length > 0 && (
        <span className="ml-0.5 inline-flex items-center justify-center size-5 rounded-full bg-primary text-primary-foreground text-[10px] font-medium">
          +{dndActiveItem.batchItems.length}
        </span>
      )}
      {overProjectName && (
        <span className="ml-1 text-xs text-muted-foreground">&rarr; {overProjectName}</span>
      )}
    </div>
  );
}

export function SplitViewContainer({
  panes,
  ratios,
  onRatiosChange,
  gridRatios: gridRatiosProp,
  onGridRatiosChange,
  onRemovePane,
  onCloseSplit,
  activePaneIndex,
  onSetActivePane,
  layout,
  initialFileTreeOpen = false,
  onSwapPanes,
  paneZoomFactors,
  onResetPaneZoomAt,
}: SplitViewContainerProps) {
  const jotaiStore = useStore();
  const gridRatios = gridRatiosProp ?? getDefaultGridRatios();
  const containerRef = useRef<HTMLDivElement>(null);
  const ratiosRef = useRef(ratios);
  ratiosRef.current = ratios;
  const gridRatiosRef = useRef(gridRatios);
  gridRatiosRef.current = gridRatios;

  // chatId of the pane with an active permission request (if any)
  const permissionChatId = useAtomValue(permissionRequestChatIdAtom);

  /** Whether a pane has an active permission request */
  const isPaneRequestingPermission = useCallback(
    (paneId: string) =>
      permissionChatId !== null && !paneId.startsWith('empty-') && paneId === permissionChatId,
    [permissionChatId],
  );

  // Track which panes have their file tree open (by pane index).
  // Shared via Jotai atom so each pane's chat-header file-tree toggle can flip it too.
  // Pane 0 inherits the single-pane file sidebar state so it persists across the transition.
  const [openFileTrees, setOpenFileTrees] = useAtom(splitPaneFileTreesAtom);

  // One-time: seed which panes have the file tree open from mount props. `didInit` ensures we do not
  // re-apply when `panes` is replaced/updated; omitting `panes` from deps keeps that contract explicit.
  const didInit = useRef(false);
  // biome-ignore lint/correctness/useExhaustiveDependencies: one-time init; `didInit` guards application; `panes` omitted so pane list updates do not reset open trees.
  useEffect(() => {
    if (didInit.current) return;
    didInit.current = true;
    setOpenFileTrees(
      new Set(
        initialFileTreeOpen
          ? panes.map((_, i) => i).filter((idx) => Boolean(panes[idx]?.projectPath))
          : [],
      ),
    );
  }, [initialFileTreeOpen, setOpenFileTrees]);

  // Reset atom when split view unmounts so stale state doesn't leak.
  useEffect(() => {
    return () => {
      setOpenFileTrees(new Set<number>());
    };
  }, [setOpenFileTrees]);

  const toggleFileTree = useCallback(
    (idx: number) => {
      setOpenFileTrees((prev: Set<number>) => {
        const next = new Set(prev);
        if (next.has(idx)) next.delete(idx);
        else next.add(idx);
        return next;
      });
    },
    [setOpenFileTrees],
  );

  // Refs to each pane's file tree for shortcut integration
  const paneFileTreeRefs = useRef<Map<number, PaneFileTreeHandle>>(new Map());

  // Pending creation action — set when a shortcut fires while the tree is still
  // mounting (i.e. auto-open just called). Consumed when the ref callback fires.
  const pendingCreation = useRef<'file' | 'folder' | null>(null);

  const setPaneFileTreeRef = useCallback((idx: number, handle: PaneFileTreeHandle | null) => {
    if (handle) {
      paneFileTreeRefs.current.set(idx, handle);
      // If there's a pending creation for this pane, apply it now
      if (pendingCreation.current) {
        handle.setRootCreating(pendingCreation.current);
        handle.focusTree();
        pendingCreation.current = null;
      }
    } else {
      paneFileTreeRefs.current.delete(idx);
    }
  }, []);

  // Active pane's file tree shortcut wiring
  const activePane = panes[activePaneIndex];
  const activeFileTreeOpen = openFileTrees.has(activePaneIndex);
  const openActiveFileTree = useCallback(
    () => toggleFileTree(activePaneIndex),
    [toggleFileTree, activePaneIndex],
  );

  // Stable ref that always points to the active pane's file tree handle
  // (avoids stale closure in the shortcut hook)
  const activeHandleRef = useRef<PaneFileTreeHandle | null>(null);
  activeHandleRef.current = paneFileTreeRefs.current.get(activePaneIndex) ?? null;

  // Dummy ref for focusTree — the hook expects a ref to an element, but we
  // delegate focus through the imperative handle instead
  const dummyTreeRef = useRef<HTMLElement>(null);

  // Stable callbacks that read from the active handle ref.
  // When the tree is not yet mounted (auto-open in progress), store a pending
  // creation that will be picked up by setPaneFileTreeRef once the tree mounts.
  const shortcutSetRootCreating = useCallback((type: 'file' | 'folder') => {
    if (activeHandleRef.current) {
      activeHandleRef.current.setRootCreating(type);
      activeHandleRef.current.focusTree();
    } else {
      pendingCreation.current = type;
    }
  }, []);

  const shortcutDeleteFile = useCallback((_path: string) => {
    activeHandleRef.current?.deleteSelectedNode();
  }, []);

  // Derive shortcut params from active pane's handle (read per render)
  const activeHandle = paneFileTreeRefs.current.get(activePaneIndex);
  const shortcutSelectedNodePath = activeHandle?.getSelectedNodePath() ?? null;
  const shortcutIsInlineActive = activeHandle?.getIsInlineActive() ?? false;

  const shortcutBatchDelete = useCallback((paths: string[]) => {
    const count = paths.length;
    if (window.confirm(`Move ${count} items to Trash?`)) {
      // Delegate to active pane's handle — it has the mutation and project context
      activeHandleRef.current?.batchDelete?.(paths);
    }
  }, []);

  const shortcutGetSelectedPaths = useCallback(
    () => activeHandleRef.current?.getSelectedPaths() ?? [],
    [],
  );

  useFileTreeHotkeys({
    projectPath: activePane?.projectPath,
    isOpen: activeFileTreeOpen,
    onOpen: openActiveFileTree,
    onSetRootCreating: shortcutSetRootCreating,
    onDeleteFile: shortcutDeleteFile,
    selectedNodePath: shortcutSelectedNodePath,
    isInlineActive: shortcutIsInlineActive,
    treeContainerRef: dummyTreeRef,
    onBatchDelete: shortcutBatchDelete,
    getSelectedPaths: shortcutGetSelectedPaths,
  });

  // ---- Shared DndContext for cross-project drag-and-drop ----
  const dndSensors = useSensors(
    useSensor(PointerSensor, { activationConstraint: { distance: 8 } }),
  );
  // dndActiveItem + dndOverProjectPath live in module-level atoms so that setting them during a
  // file drag does NOT re-render SplitViewContainer. Only the DraggedItemCard inside DragOverlay
  // reads these values. Without this, every dragOver rippled fresh sizeStyle/callbacks into all
  // LinearPanes and defeated memo, cascading into thousands of TreeNode re-renders.
  const setDndActiveItem = useSetAtom(dndActiveItemAtom);
  const setDndOverProjectPath = useSetAtom(dndOverProjectPathAtom);
  const [crossProjectDrop, setCrossProjectDrop] = useState<CrossProjectDropInfo | null>(null);

  // moveFile mutation for same-project moves within the shared DndContext
  const utils = trpc.useUtils();
  const moveFileMutation = trpc.files.moveFile.useMutation();
  const moveFileMutate = moveFileMutation.mutate;

  // Batch move mutation for multi-select same-project moves
  const batchMoveMutation = trpc.files.batchMoveFiles.useMutation();
  const batchMoveMutate = batchMoveMutation.mutate;

  const syncProjectTreesAfterMove = useCallback(
    (projectPath: string, destinationFolder: string, batchData?: { results: MoveResult[] }) => {
      refreshProjectTree(utils, projectPath);
      if (destinationFolder) {
        triggerFileTreeReveal(projectPath, destinationFolder);
      }
      if (batchData) {
        showMoveToast(projectPath, batchData.results, () => refreshProjectTree(utils, projectPath));
      }
    },
    [utils],
  );

  // Track pane-reorder drag state
  const [paneReorderActive, setPaneReorderActive] = useState<PaneReorderDragData | null>(null);
  // Track recently swapped panes for flash animation (indices cleared after animation)
  const [justSwapped, setJustSwapped] = useState<Set<number>>(new Set());
  const swapTimeoutRef = useRef<NodeJS.Timeout | null>(null);
  // Screen reader announcement for pane swaps
  const [swapAnnouncement, setSwapAnnouncement] = useState('');

  /** Trigger swap animation on affected panes */
  const triggerSwapAnimation = useCallback((a: number, b: number) => {
    setJustSwapped(new Set([a, b]));
    if (swapTimeoutRef.current) clearTimeout(swapTimeoutRef.current);
    swapTimeoutRef.current = setTimeout(() => setJustSwapped(new Set()), 350);
  }, []);

  // Cleanup swap animation timeout on unmount
  useEffect(() => {
    return () => {
      if (swapTimeoutRef.current) clearTimeout(swapTimeoutRef.current);
    };
  }, []);

  /** Swap panes with animation feedback (used by both DnD and arrow buttons) */
  const handleSwapPanes = useCallback(
    (from: number, to: number) => {
      if (!onSwapPanes || from === to) return;
      onSwapPanes(from, to);
      triggerSwapAnimation(from, to);
      setSwapAnnouncement(`Pane ${from + 1} swapped with pane ${to + 1}`);

      // Blur focus so input doesn't stay on the swapped-away pane.
      // Without this, a NewChatForm's auto-focused editor retains focus
      // at its new position and keystrokes go to the wrong pane.
      (document.activeElement as HTMLElement)?.blur?.();

      // Compute where the active pane lands after the swap, then
      // re-focus its editor once React has re-rendered.
      let newActiveIdx = activePaneIndex;
      if (activePaneIndex === from) newActiveIdx = to;
      else if (activePaneIndex === to) newActiveIdx = from;

      requestAnimationFrame(() => {
        const paneEl = containerRef.current?.querySelector(`[data-pane-index="${newActiveIdx}"]`);
        focusChatInput(paneEl);
      });
    },
    [onSwapPanes, triggerSwapAnimation, activePaneIndex],
  );

  const handleDndDragStart = useCallback(
    (event: DragStartEvent) => {
      const data = event.active.data.current;
      if ((data as PaneReorderDragData)?.type === 'pane-reorder') {
        setPaneReorderActive(data as PaneReorderDragData);
        return;
      }
      if ((data as TreeNodeDragData)?.type === 'tree-node') {
        setDndActiveItem(data as TreeNodeDragData);
      }
    },
    [setDndActiveItem],
  );

  const handleDndDragOver = useCallback(
    (event: DragOverEvent) => {
      const overData = event.over?.data.current as TreeNodeDropData | undefined;
      setDndOverProjectPath(overData?.projectPath ?? null);
    },
    [setDndOverProjectPath],
  );

  const handleDndDragEnd = useCallback(
    (event: DragEndEvent) => {
      // Handle pane-reorder drops
      const activeDragData = event.active.data.current;
      if ((activeDragData as PaneReorderDragData)?.type === 'pane-reorder') {
        setPaneReorderActive(null);
        const overData = event.over?.data.current as PaneReorderDragData | undefined;
        if (overData?.type === 'pane-reorder') {
          const fromIdx = (activeDragData as PaneReorderDragData).paneIndex;
          const toIdx = overData.paneIndex;
          if (fromIdx !== toIdx) handleSwapPanes(fromIdx, toIdx);
        }
        return;
      }

      setDndActiveItem(null);
      setDndOverProjectPath(null);

      const dragData = event.active.data.current as TreeNodeDragData | undefined;
      const dropData = event.over?.data.current as TreeNodeDropData | undefined;

      if (!dragData || !dropData) return;
      if (dropData.type !== 'tree-folder' && dropData.type !== 'tree-root') return;

      const isSameProject = dragData.projectPath === dropData.projectPath;

      if (isSameProject) {
        // Same-project move — handles both single and batch drag
        const destFolder = dropData.folderPath;
        const pane = panes.find((p) => p.projectPath === dragData.projectPath);
        if (!pane?.projectPath) return;
        const projectPath = pane.projectPath;

        // Collect, dedup, and filter to only movable items
        const movable = collectMovableItems(dragData, destFolder);

        if (movable.length > 0) {
          if (movable.length > 1) {
            // Use batch endpoint for consolidated feedback
            batchMoveMutate(
              {
                projectPath,
                sourcePaths: movable.map((m) => m.path),
                destinationFolder: destFolder,
              },
              {
                onSuccess: (data) => {
                  syncProjectTreesAfterMove(projectPath, destFolder, data);
                },
              },
            );
          } else {
            moveFileMutate(
              {
                projectPath,
                sourcePath: movable[0].path,
                destinationFolder: destFolder,
              },
              {
                onSuccess: () => {
                  syncProjectTreesAfterMove(projectPath, destFolder);
                },
              },
            );
          }
        }

        // Clear multi-selection on the source pane after batch moves
        if (movable.length > 0 && dragData.batchItems && dragData.batchItems.length > 0) {
          const srcPaneIdx =
            dragData.paneIndex ?? panes.findIndex((p) => p.projectPath === dragData.projectPath);
          if (srcPaneIdx >= 0) {
            paneFileTreeRefs.current.get(srcPaneIdx)?.clearSelection?.();
          }
        }
        return;
      }

      // Different project — show copy/move dialog
      // Build items list (primary + batch), dedup descendants
      const allItems = deduplicateDescendants([
        { path: dragData.nodePath, name: dragData.nodeName, type: dragData.nodeType },
        ...(dragData.batchItems ?? []),
      ]);

      setCrossProjectDrop({
        sourcePath: dragData.nodePath,
        sourceName: dragData.nodeName,
        sourceProjectPath: dragData.projectPath,
        destProjectPath: dropData.projectPath,
        destFolder: dropData.folderPath,
        items: allItems,
      });
    },
    [
      panes,
      moveFileMutate,
      batchMoveMutate,
      handleSwapPanes,
      syncProjectTreesAfterMove,
      setDndActiveItem,
      setDndOverProjectPath,
    ],
  );

  const handleDndDragCancel = useCallback(() => {
    setDndActiveItem(null);
    setDndOverProjectPath(null);
    setPaneReorderActive(null);
  }, [setDndActiveItem, setDndOverProjectPath]);

  const isLinear = layout === 'horizontal' || layout === 'vertical';
  const isVertical = layout === 'vertical';

  useEffect(() => {
    if (panes.length < 2) return;
    const handleKeyDown = (e: KeyboardEvent) => {
      if (!e.metaKey || !e.shiftKey || e.altKey || e.ctrlKey) return;

      const target = e.target as HTMLElement;
      if (target.tagName === 'INPUT' || target.tagName === 'TEXTAREA' || target.isContentEditable) {
        const hasContent =
          target.tagName === 'INPUT' || target.tagName === 'TEXTAREA'
            ? (target as HTMLInputElement | HTMLTextAreaElement).value.length > 0
            : (target.textContent?.trim().length ?? 0) > 0;
        if (hasContent) return;
      }

      if (target.closest('[role="dialog"], [role="alertdialog"], dialog')) {
        return;
      }

      // Vertical layout uses Up/Down, horizontal uses Left/Right
      const moveBack = isVertical ? e.code === 'ArrowUp' : e.code === 'ArrowLeft';
      const moveFwd = isVertical ? e.code === 'ArrowDown' : e.code === 'ArrowRight';

      if (moveBack && activePaneIndex > 0) {
        e.preventDefault();
        runChatShortcutAction(jotaiStore, true, () =>
          handleSwapPanes(activePaneIndex, activePaneIndex - 1),
        );
      } else if (moveFwd && activePaneIndex < panes.length - 1) {
        e.preventDefault();
        runChatShortcutAction(jotaiStore, true, () =>
          handleSwapPanes(activePaneIndex, activePaneIndex + 1),
        );
      }
    };
    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, [panes.length, activePaneIndex, handleSwapPanes, isVertical, jotaiStore]);

  // Ratios from state only; during drag SplitDivider updates CSS vars on container (no state) for smooth resize.
  const currentRatios = (() => {
    if (!isLinear) return getDefaultRatios(panes.length);
    if (ratios.length === panes.length) return ratios;
    return getDefaultRatios(panes.length);
  })();

  // When pane count changes in linear mode, reset ratios if they don't match.
  const lastSyncedPaneCount = useRef(panes.length);
  useEffect(() => {
    if (
      isLinear &&
      ratios.length !== panes.length &&
      panes.length >= 2 &&
      lastSyncedPaneCount.current !== panes.length
    ) {
      lastSyncedPaneCount.current = panes.length;
      onRatiosChange(getDefaultRatios(panes.length));
    }
  }, [panes.length, ratios.length, onRatiosChange, isLinear]);

  const closePaneAt = useCallback(
    (pane: { id: string }, idx: number) => {
      const chatId = pane.id.startsWith('empty-') ? null : pane.id;
      onRemovePane(chatId, idx);
    },
    [onRemovePane],
  );

  // Shared DnD wrapper (overlay + cross-project dialog) used by both grid and linear layouts
  const dndWrapper = (children: React.ReactNode) => (
    <DndContext
      sensors={dndSensors}
      onDragStart={handleDndDragStart}
      onDragOver={handleDndDragOver}
      onDragEnd={handleDndDragEnd}
      onDragCancel={handleDndDragCancel}
      measuring={fileTreeDndMeasuring}
      autoScroll={{
        enabled: true,
        threshold: { x: 0, y: 0.15 },
        acceleration: 10,
      }}
    >
      <SplitPaneBranchBarHeightProvider layout={layout} paneCount={panes.length}>
        {children}
      </SplitPaneBranchBarHeightProvider>
      {/* Visually-hidden live region for screen reader pane swap announcements */}
      <output className="sr-only" aria-live="polite">
        {swapAnnouncement}
      </output>
      <DragOverlay dropAnimation={null}>
        {paneReorderActive &&
          (() => {
            const idx = paneReorderActive.paneIndex;
            const paneColor = getPaneColor(idx);
            const paneLabel = panes[idx]?.label;
            return (
              <div
                className={cn(
                  'flex items-center gap-2.5 py-2 px-3.5 rounded-lg text-sm',
                  'border-2 shadow-2xl text-foreground',
                  overlayGlass,
                  paneColor.border,
                )}
                style={{ minWidth: 120 }}
              >
                <GripVertical className="size-3.5 text-muted-foreground shrink-0" />
                <CompactPaneDigitBadge
                  paneIndex={idx}
                  paneNumber={idx + 1}
                  className="h-5! min-w-[20px]! px-1.5! text-[11px]! font-bold!"
                />
                <span className="truncate max-w-[140px] font-medium">{paneLabel ?? 'Chat'}</span>
              </div>
            );
          })()}
        <DraggedItemCard />
      </DragOverlay>
      <CrossProjectDropDialog
        dropInfo={crossProjectDrop}
        onClose={() => {
          // Clear multi-selection on the source pane after cross-project dialog
          if (crossProjectDrop?.items && crossProjectDrop.items.length > 1) {
            const srcIdx = panes.findIndex(
              (p) => p.projectPath === crossProjectDrop.sourceProjectPath,
            );
            if (srcIdx >= 0) {
              paneFileTreeRefs.current.get(srcIdx)?.clearSelection?.();
            }
          }
          setCrossProjectDrop(null);
        }}
      />
    </DndContext>
  );

  // One persistent container + one pane list so linear ↔ grid does not unmount the whole subtree.
  const gridStyleMerged = getGridStyle(layout, panes.length, gridRatios);
  const gridContainerStyle: React.CSSProperties = !isLinear
    ? {
        ...gridStyleMerged,
        ['--grid-row-0' as string]: gridRatios.rows[0],
        ['--grid-row-1' as string]: gridRatios.rows[1],
        ['--grid-col-0' as string]: gridRatios.cols[0],
        ['--grid-col-1' as string]: gridRatios.cols[1],
      }
    : {};
  const linearContainerStyle: React.CSSProperties = {};
  if (isLinear) {
    for (let i = 0; i < panes.length; i++) {
      (linearContainerStyle as Record<string, number>)[`--pane-${i}`] = currentRatios[i] ?? 0;
    }
  }
  const dividerPlacements = getGridDividerPlacements(layout);
  const handleResetGridToEqual = () => {
    onGridRatiosChange?.(getDefaultGridRatios().rows, getDefaultGridRatios().cols);
  };

  return dndWrapper(
    <div
      ref={containerRef}
      className={cn(
        'h-full w-full',
        isLinear ? cn('relative', isVertical ? 'flex flex-col' : 'flex') : 'grid',
      )}
      style={isLinear ? linearContainerStyle : gridContainerStyle}
    >
      {panes.map((pane, i) => {
        const sizeStyle: React.CSSProperties = isVertical
          ? { flexGrow: `var(--pane-${i})`, flexShrink: 1, flexBasis: 0, minHeight: 0 }
          : { flexGrow: `var(--pane-${i})`, flexShrink: 1, flexBasis: 0, minWidth: 0 };
        const showFileTree = openFileTrees.has(i) && !!pane.projectPath;
        return (
          <Fragment key={pane.id}>
            {isLinear ? (
              <SplitPane
                variant="linear"
                pane={pane}
                index={i}
                isActive={i === activePaneIndex}
                isVertical={isVertical}
                sizeStyle={sizeStyle}
                onSetActive={() => onSetActivePane(i)}
                onClose={() => closePaneAt(pane, i)}
                showFileTree={showFileTree}
                onFileTreeRef={(handle) => setPaneFileTreeRef(i, handle)}
                onCloseFileTree={() => toggleFileTree(i)}
                totalPanes={panes.length}
                onSwapPanes={handleSwapPanes}
                isDragSource={paneReorderActive?.paneIndex === i}
                justSwapped={justSwapped.has(i)}
                isRequestingPermission={isPaneRequestingPermission(pane.id)}
                zoomFactor={paneZoomFactors?.[i] ?? 1}
                onResetPaneZoom={onResetPaneZoomAt ? () => onResetPaneZoomAt(i) : undefined}
              >
                {pane.content}
              </SplitPane>
            ) : (
              <SplitPane
                variant="grid"
                pane={pane}
                index={i}
                isActive={i === activePaneIndex}
                onSetActive={() => onSetActivePane(i)}
                onClose={() => closePaneAt(pane, i)}
                fileTreeOpen={openFileTrees.has(i)}
                layout={layout}
                gridArea={getGridArea(layout, i)}
                gridPlacement={getGridPanePlacement(layout, i)}
                resizeCorner={
                  layout === 'grid' && panes.length === 4
                    ? getGridPaneResizeCorner(layout, i)
                    : null
                }
                gridContainerRef={onGridRatiosChange ? containerRef : undefined}
                gridRatiosRef={onGridRatiosChange ? gridRatiosRef : undefined}
                onGridRatiosChange={onGridRatiosChange}
                onFileTreeRef={(handle) => setPaneFileTreeRef(i, handle)}
                onCloseFileTree={() => toggleFileTree(i)}
                totalPanes={panes.length}
                onSwapPanes={handleSwapPanes}
                isDragSource={paneReorderActive?.paneIndex === i}
                justSwapped={justSwapped.has(i)}
                isRequestingPermission={isPaneRequestingPermission(pane.id)}
                zoomFactor={paneZoomFactors?.[i] ?? 1}
                onResetPaneZoom={onResetPaneZoomAt ? () => onResetPaneZoomAt(i) : undefined}
              >
                {pane.content}
              </SplitPane>
            )}
            {isLinear && i < panes.length - 1 && (
              <SplitDivider
                index={i}
                isVertical={isVertical}
                containerRef={containerRef}
                ratiosRef={ratiosRef}
                onCommitRatios={onRatiosChange}
                onCloseSplit={onCloseSplit}
              />
            )}
          </Fragment>
        );
      })}
      {!isLinear && onGridRatiosChange && (
        <>
          <GridDivider
            orientation="vertical"
            containerRef={containerRef}
            gridRatiosRef={gridRatiosRef}
            onCommit={onGridRatiosChange}
            onResetToEqual={handleResetGridToEqual}
            placement={dividerPlacements.vertical}
          />
          <GridDivider
            orientation="horizontal"
            containerRef={containerRef}
            gridRatiosRef={gridRatiosRef}
            onCommit={onGridRatiosChange}
            onResetToEqual={handleResetGridToEqual}
            placement={dividerPlacements.horizontal}
          />
        </>
      )}
    </div>,
  );
}
