/* eslint-disable max-lines, max-lines-per-function */
import { useAtom, useAtomValue, useSetAtom } from 'jotai';
import { useCallback, useEffect, useRef } from 'react';
import { SidebarMainPaneLayout } from '@/components/SidebarMainPaneLayout';
import { SidePanelDockHost } from '@/components/SidePanelDock';
import { ThemeEditorHost } from '@/components/ThemeEditor';
import { activeFileAtom, getNextCodeEditorLayout } from '@/lib/code-editor/state';
import { useThemeEditorYield } from '@/lib/themes/editor/use-theme-editor-dock';
import { ResizableSidebar } from '../../components/ui/resizable-sidebar';
import { TooltipProvider } from '../../components/ui/tooltip';
import { UpdateBanner } from '../../components/update-banner';
import { WindowsTitleBar } from '../../components/windows-title-bar';
import { useDesktopWindowState } from '../../lib/hooks/use-desktop-window-state';
import { useValidatedProject } from '../../hooks/use-validated-project';
import {
  activeOverlayAtom,
  agentsSettingsDialogActiveTabAtom,
  agentsSettingsDialogOpenAtom,
  agentsSidebarOpenAtom,
  agentsSidebarWidthAtom,
  customHotkeysAtom,
  exitTransientDestinationForNavigationAtom,
} from '../../lib/atoms';
import { flowEditorOpenAtom } from '../../lib/atoms/agent-navigation-atoms';
import {
  getActiveOverlayViewPolicy,
  resolveLayoutDestination,
} from '../../lib/atoms/active-overlay-view-policy';
import { useIsMobile } from '../../lib/hooks/use-mobile';
import { useUpdateChecker } from '../../lib/hooks/use-update-checker';
import { useWindowEvent } from '../../lib/hooks/use-window-event';
import { appStore } from '../../lib/jotai-store';
import { trpc, trpcClient } from '../../lib/trpc';
import { useWorkQueueDestination } from '../../lib/work-queue/use-work-queue-destination';
import { useAgentRequestMoveChat } from '../agents';
import {
  fileSearchDialogOpenAtom,
  newChatWorktreePathAtom,
  recentlyOpenedFilesAtom,
  selectedAgentChatIdAtom,
  showNewChatFormAtom,
  splitViewActivePaneIndexAtom,
  splitViewChatIdsAtom,
} from '../agents/atoms';
import { ChatNameUpdateBridge } from '../agents/components/chat-name-update-bridge';
import { QueueProcessor } from '../agents/components/queue-processor';
import { useSplitViewActions } from '../agents/hooks/use-split-view';
import { useTaskIpcHandler } from '../agents/hooks/use-task-ipc-handler';
import { useAgentsHotkeys } from '../agents/lib/agents-hotkeys-manager';
import { toggleSearchAtom } from '../agents/search';
import { useAgentSubChatStore } from '../agents/stores/sub-chat-store';
import {
  closeFilesOutsideProjectAtom,
  codeEditorLayoutAtom,
  codeEditorOpenAtom,
  openFileAtom,
  openFilesAtom,
} from '../code-editor';
import { FileSearchDialog } from '../file-viewer/components/file-search-dialog';
import { FilesSidebar } from '../files-sidebar';
import {
  filesSidebarOpenAtom,
  filesSidebarWidthAtom,
  splitPaneFileTreesAtom,
} from '../files-sidebar/atoms';
import { PANE_FILE_TREE_READY_EVENT } from '../files-sidebar/constants';
import {
  resolveActiveWorktreePath,
  resolveEffectiveProjectPath,
  resolveScopedChatWorktreePath,
} from '../files-sidebar/utils/resolve-effective-project-path';
import { SIDEPANE_MAX_WIDTH, SIDEPANE_MIN_WIDTH } from '../sidebar/constants';
import { UnifiedSidebar, type UnifiedSidebarHandle } from '../sidebar/unified';
import { AgentsDestinationPane } from './AgentsDestinationPane';
import { openActiveFileInEditor } from './open-active-file-in-editor';

const SIDEBAR_ANIMATION_DURATION = 0;
/** Max wait for pane file tree ready before activating search anyway (split-pane Cmd+Shift+F). */
const PANE_SEARCH_ACTIVATION_TIMEOUT_MS = 5000;
const SIDEBAR_CLOSE_SHORTCUT_ID = 'toggle-sidebar' as const;

export function AgentsLayout() {
  // No useHydrateAtoms - desktop doesn't need SSR, atomWithStorage handles persistence
  const isMobile = useIsMobile();

  useDesktopWindowState();

  // Check for updates on mount and periodically
  useUpdateChecker();

  const [sidebarOpen, setSidebarOpen] = useAtom(agentsSidebarOpenAtom);
  const [filesSidebarOpen, setFilesSidebarOpen] = useAtom(filesSidebarOpenAtom);
  const [fileSearchDialogOpen, setFileSearchDialogOpen] = useAtom(fileSearchDialogOpenAtom);
  const [activeOverlay, setActiveOverlay] = useAtom(activeOverlayAtom);
  // Flows splits into a dashboard and a full-width editor; the layout policy needs to know which.
  const isFlowEditorOpen = useAtomValue(flowEditorOpenAtom);
  const setSettingsOpen = useSetAtom(agentsSettingsDialogOpenAtom);
  const setSettingsActiveTab = useSetAtom(agentsSettingsDialogActiveTabAtom);
  // Listen for frink:open-settings events (from IDE config toast notifications).
  useWindowEvent('frink:open-settings', (event) => {
    if (event instanceof CustomEvent && event.detail?.tab) setSettingsActiveTab(event.detail.tab);
    setSettingsOpen(true);
  });
  const [selectedChatId, setSelectedChatId] = useAtom(selectedAgentChatIdAtom);
  // Validate selected project exists in DB (shared hook eliminates duplication)
  const { validatedProject, projects } = useValidatedProject();
  const { data: selectedChatData } = trpc.chats.get.useQuery(
    { id: selectedChatId ?? '' },
    { enabled: !!selectedChatId },
  );
  const newChatWorktreePath = useAtomValue(newChatWorktreePathAtom);
  const selectedChatWorktreePath = resolveActiveWorktreePath({
    rawWorktreePath: resolveScopedChatWorktreePath({
      activeChatId: selectedChatId,
      queriedChatId: selectedChatData?.id,
      queriedWorktreePath: selectedChatData?.worktreePath,
      fallbackWorktreePath: !selectedChatId ? newChatWorktreePath : undefined,
    }),
    selectedProjectPath: validatedProject?.path,
  });
  const fileSearchProjectPath = resolveEffectiveProjectPath({
    worktreePath: selectedChatWorktreePath,
    selectedProjectPath: validatedProject?.path,
  });
  const setShowNewChatForm = useSetAtom(showNewChatFormAtom);
  const [recentlyOpenedFiles, setRecentlyOpenedFiles] = useAtom(recentlyOpenedFilesAtom);
  const openFile = useSetAtom(openFileAtom);

  // Split view: granular atoms so layout-only updates (cycleLayout) do not re-render this tree.
  const chatIds = useAtomValue(splitViewChatIdsAtom);
  const activePaneIndex = useAtomValue(splitViewActivePaneIndexAtom);
  const isSplitActive = chatIds.length >= 2;
  const paneCount = chatIds.length;

  const {
    addEmptyPane,
    newChatAtPane,
    setActivePaneIndex,
    cycleLayout,
    growActivePane,
    shrinkActivePane,
    resetPaneSizes,
    resetPaneZoom,
    fillActivePane,
    zoomPaneIn,
    zoomPaneOut,
  } = useSplitViewActions();

  const setChatId = useAgentSubChatStore((state) => state.setChatId);

  // Track if this is the initial load - skip auto-open on first load to respect saved state
  const isInitialLoadRef = useRef(true);
  // Track the previous project to detect when project changes (not just sidebar state changes)
  const prevProjectRef = useRef<typeof validatedProject>(validatedProject);

  // Auto-open sidebar when project is selected (but never auto-close)
  // Skip on initial load to preserve user's saved sidebar preference
  useEffect(() => {
    if (!projects) return; // Don't change sidebar state while loading

    // On initial load, just mark as loaded and don't change sidebar state
    if (isInitialLoadRef.current) {
      isInitialLoadRef.current = false;
      prevProjectRef.current = validatedProject;
      return;
    }

    // Only auto-open when a NEW/DIFFERENT project is selected, not on every render
    // This prevents re-opening after user manually closes
    const projectChanged = prevProjectRef.current?.id !== validatedProject?.id;

    if (projectChanged && validatedProject && !sidebarOpen) {
      setSidebarOpen(true);
    }

    prevProjectRef.current = validatedProject;
  }, [validatedProject, projects, sidebarOpen, setSidebarOpen]);

  // Initialize sub-chats when chat is selected
  useEffect(() => {
    if (selectedChatId) {
      setChatId(selectedChatId);
    } else {
      setChatId(null);
    }
  }, [selectedChatId, setChatId]);

  // Chat search toggle
  const toggleChatSearch = useSetAtom(toggleSearchAtom);

  // Close all open editor files (for Cmd+Shift+E)
  const closeFilesOutsideProject = useSetAtom(closeFilesOutsideProjectAtom);
  const closeAllEditorFiles = useCallback(() => {
    closeFilesOutsideProject(null);
  }, [closeFilesOutsideProject]);

  // Cycle editor layout (top -> left -> right) for Cmd+Shift+V, only when editor is open
  const codeEditorOpen = useAtomValue(codeEditorOpenAtom);
  const openFiles = useAtomValue(openFilesAtom);
  const activeFile = useAtomValue(activeFileAtom);
  const setCodeEditorLayout = useSetAtom(codeEditorLayoutAtom);
  const toggleEditorLayout = useCallback(() => {
    if (!codeEditorOpen || openFiles.length === 0) return;
    setCodeEditorLayout((prev) => getNextCodeEditorLayout(prev));
  }, [codeEditorOpen, openFiles.length, setCodeEditorLayout]);

  // Custom hotkeys config
  const customHotkeysConfig = useAtomValue(customHotkeysAtom);

  // Split-pane file tree toggle for active pane (Cmd+Shift+F in split view)
  const setOpenFileTrees = useSetAtom(splitPaneFileTreesAtom);
  const pendingPaneSearchActivationCleanupRef = useRef<(() => void) | null>(null);
  // Sidebar ref for programmatic focus (Cmd+;)
  const sidebarRef = useRef<UnifiedSidebarHandle>(null);
  const focusSidebar = useCallback(() => {
    sidebarRef.current?.focus();
  }, []);
  const exitWorkQueueForNavigation = useSetAtom(exitTransientDestinationForNavigationAtom);

  const {
    closeOverlay: handleCloseOverlay,
    requestWorkQueueClose: handleWorkQueueRequestClose,
    navigateWorkQueueToChat: handleWorkQueueNavigateToChat,
    prepareForAgentsHotkey,
  } = useWorkQueueDestination({
    isMobile,
    isSplitActive,
    setActiveOverlay,
    exitWorkQueueForNavigation,
    fillActivePane,
    selectChat: setSelectedChatId,
    focusWorkQueueTrigger: () => sidebarRef.current?.focusWorkQueueTrigger(),
  });
  const handleSettingsClose = useCallback(() => setSettingsOpen(false), [setSettingsOpen]);

  const toggleActivePaneFileTree = useCallback(() => {
    setOpenFileTrees((prev: Set<number>) => {
      const next = new Set(prev);
      if (next.has(activePaneIndex)) next.delete(activePaneIndex);
      else next.add(activePaneIndex);
      return next;
    });
  }, [activePaneIndex, setOpenFileTrees]);

  const activateFilesSidebarSearch = useCallback(() => {
    setFilesSidebarOpen(true);
    requestAnimationFrame(() => {
      window.dispatchEvent(new CustomEvent('file-tree:activate-search'));
    });
  }, [setFilesSidebarOpen]);

  const activateActivePaneFileSearch = useCallback(() => {
    pendingPaneSearchActivationCleanupRef.current?.();
    pendingPaneSearchActivationCleanupRef.current = null;

    const pane = activePaneIndex;
    const fireActivate = () =>
      window.dispatchEvent(
        new CustomEvent('pane-file-tree:activate-search', { detail: { paneIndex: pane } }),
      );

    if (appStore.get(splitPaneFileTreesAtom).has(pane)) {
      queueMicrotask(fireActivate);
      return;
    }

    // Ready-event and timeout settle identically; clearing a fired timer is a no-op.
    const finish = () => {
      window.removeEventListener(PANE_FILE_TREE_READY_EVENT, onReady);
      window.clearTimeout(timeoutId);
      pendingPaneSearchActivationCleanupRef.current = null;
      fireActivate();
    };
    const onReady = (e: Event) => {
      if ((e as CustomEvent<{ paneIndex: number }>).detail?.paneIndex === pane) finish();
    };
    const timeoutId = window.setTimeout(finish, PANE_SEARCH_ACTIVATION_TIMEOUT_MS);

    window.addEventListener(PANE_FILE_TREE_READY_EVENT, onReady);
    pendingPaneSearchActivationCleanupRef.current = () => {
      window.removeEventListener(PANE_FILE_TREE_READY_EVENT, onReady);
      window.clearTimeout(timeoutId);
    };

    setOpenFileTrees((prev: Set<number>) => {
      const next = new Set(prev);
      next.add(pane);
      return next;
    });
  }, [activePaneIndex, setOpenFileTrees]);

  useEffect(() => {
    return () => {
      pendingPaneSearchActivationCleanupRef.current?.();
      pendingPaneSearchActivationCleanupRef.current = null;
    };
  }, []);

  const viewPolicy = getActiveOverlayViewPolicy({
    destination: resolveLayoutDestination(activeOverlay),
    isMobile,
    isSplitActive,
    sidebarOpen,
    filesSidebarOpen,
    isFlowEditorOpen,
  });
  const editorYield = useThemeEditorYield(viewPolicy.isUnifiedSidebarOpen, filesSidebarWidthAtom);

  // Initialize hotkeys manager
  useAgentsHotkeys({
    onBeforeAction: prepareForAgentsHotkey,
    setSelectedChatId,
    setShowNewChatForm,
    setSidebarOpen,
    setFilesSidebarOpen,
    setSettingsDialogOpen: setSettingsOpen,
    setSettingsActiveTab,
    setFileSearchDialogOpen,
    activateFilesSidebarSearch,
    activateActivePaneFileSearch,
    toggleChatSearch,
    canShowFilesSidebar: Boolean(validatedProject?.path),
    isFilesSidebarOpen: filesSidebarOpen,
    closeAllEditorFiles,
    toggleEditorLayout,
    customHotkeysConfig,
    addEmptyPane,
    newChatAtPane,
    activePaneIndex,
    setActivePaneIndex,
    isSplitActive,
    paneCount,
    toggleActivePaneFileTree,
    focusSidebar,
    cycleLayout,
    growPane: growActivePane,
    shrinkPane: shrinkActivePane,
    resetPaneSizes,
    resetPaneZoom,
    zoomIn: () => window.desktopApi?.zoomIn?.(),
    zoomOut: () => window.desktopApi?.zoomOut?.(),
    zoomPaneIn,
    zoomPaneOut,
    canToggleUnifiedSidebar: viewPolicy.canToggleUnifiedSidebar,
  });

  const handleCloseSidebar = useCallback(() => {
    setSidebarOpen(false);
  }, [setSidebarOpen]);

  const handleFileSearchSelectFile = useCallback(
    (absoluteFilePath: string) => {
      const fileName = absoluteFilePath.split('/').pop() ?? absoluteFilePath;
      openFile({
        path: absoluteFilePath,
        name: fileName,
        projectPath: fileSearchProjectPath,
        sourcePaneIndex: isSplitActive ? activePaneIndex : undefined,
        sourceChatId: selectedChatId ?? undefined,
        isWorktreeContext: Boolean(selectedChatWorktreePath),
        intent: 'preview',
      });
      setRecentlyOpenedFiles((prev) =>
        [absoluteFilePath, ...prev.filter((p) => p !== absoluteFilePath)].slice(0, 50),
      );
    },
    [
      activePaneIndex,
      isSplitActive,
      openFile,
      selectedChatId,
      selectedChatWorktreePath,
      setRecentlyOpenedFiles,
      fileSearchProjectPath,
    ],
  );

  useWindowEvent('file-viewer:open-in-editor', () => {
    void openActiveFileInEditor(
      activeFile,
      recentlyOpenedFiles,
      validatedProject?.path,
      trpcClient.external.openFileInEditor.mutate,
    );
  });

  // Destination-independent listeners must survive Work Queue, Flows, and Settings.
  useAgentRequestMoveChat();
  useTaskIpcHandler();

  return (
    <TooltipProvider delayDuration={300}>
      {/* Global queue processor - handles message queues for all sub-chats */}
      <ChatNameUpdateBridge />
      <QueueProcessor />
      <div className="flex flex-col w-full h-full relative overflow-hidden bg-background select-none">
        <WindowsTitleBar />
        <SidebarMainPaneLayout
          sidebar={
            <>
              <ResizableSidebar
                isOpen={viewPolicy.isUnifiedSidebarOpen}
                onClose={handleCloseSidebar}
                widthAtom={agentsSidebarWidthAtom}
                minWidth={SIDEPANE_MIN_WIDTH}
                maxWidth={SIDEPANE_MAX_WIDTH}
                side="left"
                closeShortcutId={SIDEBAR_CLOSE_SHORTCUT_ID}
                animationDuration={SIDEBAR_ANIMATION_DURATION}
                initialWidth={0}
                exitWidth={0}
                showResizeTooltip={true}
                className={`overflow-hidden bg-transparent ${editorYield.sidebar}`}
                preserveChildrenWhenClosed={!isMobile}
              >
                <UnifiedSidebar ref={sidebarRef} onToggleSidebar={handleCloseSidebar} />
              </ResizableSidebar>
              {viewPolicy.showFilesSidebar && (
                <div className={editorYield.files}>
                  <FilesSidebar
                    chatId={selectedChatId ?? undefined}
                    worktreePath={selectedChatWorktreePath}
                  />
                </div>
              )}
            </>
          }
          inset={viewPolicy.isMainPaneInset && editorYield.inset}
          dock={
            <>
              <SidePanelDockHost hidden={activeOverlay === 'workqueue'} />
              <ThemeEditorHost />
            </>
          }
        >
          <AgentsDestinationPane
            activeOverlay={activeOverlay}
            isMobile={isMobile}
            onCloseOverlay={handleCloseOverlay}
            onCloseSettings={handleSettingsClose}
            onRequestWorkQueueClose={handleWorkQueueRequestClose}
            onNavigateWorkQueueToChat={handleWorkQueueNavigateToChat}
            sidebar={{
              canToggle: viewPolicy.canToggleUnifiedSidebar,
              isOpen: viewPolicy.isUnifiedSidebarOpen,
              onOpen: () => setSidebarOpen(true),
            }}
          />
        </SidebarMainPaneLayout>

        <UpdateBanner />
        {fileSearchProjectPath && viewPolicy.showFileSearch && (
          <FileSearchDialog
            open={fileSearchDialogOpen}
            onOpenChange={setFileSearchDialogOpen}
            projectPath={fileSearchProjectPath}
            onSelectFile={handleFileSearchSelectFile}
            activePaneIndex={isSplitActive ? activePaneIndex : undefined}
          />
        )}
      </div>
    </TooltipProvider>
  );
}
