/* eslint-disable max-lines, max-lines-per-function */
import { useAtom, useAtomValue, useSetAtom } from 'jotai';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';

// import { useSearchParams, useRouter } from "next/navigation" // Desktop doesn't use next/navigation
// Desktop: mock Next.js navigation hooks
const useSearchParams = () => ({
  get: getUrlParam,
});
const useRouter = () => ({
  push: (url: string) => {
    window.history.pushState({}, '', url);
  },
  replace: (url: string) => {
    window.history.replaceState({}, '', url);
  },
});

import { atom } from 'jotai';

// Local team atom (teams feature not used in Frink, kept for upstream compatibility)
const selectedTeamIdAtom = atom<string | null>(null);

import { focusChatInput } from '../../../lib/focus-chat-input';
import { useIsMobile } from '../../../lib/hooks/use-mobile';
import { api } from '../../../lib/mock-api';
import { trpc } from '../../../lib/trpc';
import { cn } from '../../../lib/utils';
import { getUrlParam } from '../../../lib/utils/url-params';
import { DiffPanel } from '../../diff-panel';
import { UnifiedSidebar } from '../../sidebar/unified';
import { TerminalSidebar, terminalSidebarOpenAtomFamily } from '../../terminal';

// Style objects - hoisted to module level for performance
const MIN_WIDTH_350_STYLE = { minWidth: '350px' } as const;

/**
 * Reindexes a pane-keyed map after a pane is removed.
 * Entries with index > removedIndex are shifted down by 1; the removed entry is dropped.
 */
function shiftPaneMap<T>(
  prev: Record<number, T>,
  removedIndex: number,
  newLength: number,
): Record<number, T> {
  const next: Record<number, T> = {};
  for (let i = 0; i < newLength; i++) {
    const src = i < removedIndex ? i : i + 1;
    if (prev[src] !== undefined) next[i] = prev[src];
  }
  return next;
}

import {
  agentsMobileViewModeAtom,
  agentsPreviewSidebarOpenAtom,
  agentsSidebarOpenAtom,
  chatModeAtom,
  lastSelectedModelIdAtom,
  lastSelectedWorkModeAtom,
  NEW_CHAT_PANE,
  newChatPaneChatModeMapAtom,
  newChatPaneModelMapAtom,
  newChatPaneProjectMapAtom,
  newChatPaneWorkModeMapAtom,
  pendingNewChatTextAtom,
  previousAgentChatIdAtom,
  selectedAgentChatIdAtom,
  selectedProjectAtom,
  splitViewActivePaneIndexAtom,
  splitViewChatIdsAtom,
  splitViewGridRatiosAtom,
  splitViewLayoutAtom,
  splitViewPaneZoomFactorsAtom,
  splitViewRatiosAtom,
} from '../atoms';
import { HtmlArtifactChatView } from '../HtmlArtifactChatView';
import { useSplitViewActions } from '../hooks/use-split-view';
import { NewChatForm } from '../main/new-chat-form';
import { AgentPreview } from './agent-preview';
import { resolveChatProjectSync } from './chat-project-sync';
import { EmptyPanePlaceholder } from './EmptyPanePlaceholder';
import { PendingChatPlaceholder } from './PendingChatPlaceholder';
import { shouldSkipSelectedProjectSync } from './project-sync-guard';
import {
  buildSplitPaneProjectInfo,
  resolvePaneProjectInfoForChat,
} from './split-pane-project-info';
import { SplitViewContainer } from './split-view-container';

import {
  type IdeWatcherPaneContext,
  useIdeConfigWatcher,
} from '../../../hooks/use-ide-config-watcher';
import {
  clearPaneContextAtom,
  closeFilesOutsideProjectAtom,
  closePaneTabsAtom,
  codeEditorActiveChatIdAtom,
  codeEditorHeightAtom,
  codeEditorLayoutAtom,
  codeEditorOpenAtom,
  codeEditorWidthAtom,
  editorActivePaneIndexAtom,
  editorIsSplitActiveAtom,
  filterTabsToActivePaneAtom,
  lastActiveTabPerPaneAtom,
  openFilesAtom,
  tagOpenFilesWithPaneContextAtom,
} from '../../code-editor';
import { filesSidebarOpenAtom, splitPaneFileTreesAtom } from '../../files-sidebar/atoms';
import { resolveEffectiveProjectPath } from '../../files-sidebar/utils/resolve-effective-project-path';

const useIsAdmin = () => false;

/** Project info returned by chats.get — carries the git fields needed for the project icon. */
type ChatProject = {
  id: string;
  name: string;
  path: string;
  gitRemoteUrl?: string | null;
  gitProvider?: 'github' | 'gitlab' | 'bitbucket' | null;
  gitOwner?: string | null;
  gitRepo?: string | null;
};

export function AgentsContent() {
  const [selectedChatId, setSelectedChatId] = useAtom(selectedAgentChatIdAtom);
  const [selectedTeamId] = useAtom(selectedTeamIdAtom);
  const [sidebarOpen, setSidebarOpen] = useAtom(agentsSidebarOpenAtom);
  const [, setPreviewSidebarOpen] = useAtom(agentsPreviewSidebarOpenAtom);
  const [mobileViewMode, setMobileViewMode] = useAtom(agentsMobileViewModeAtom);
  // Per-chat terminal sidebar state
  const terminalSidebarAtom = useMemo(
    () => terminalSidebarOpenAtomFamily(selectedChatId || ''),
    [selectedChatId],
  );
  const setTerminalSidebarOpen = useSetAtom(terminalSidebarAtom);
  const [selectedProject, setSelectedProject] = useAtom(selectedProjectAtom);
  const [paneProjectMap, setPaneProjectMap] = useAtom(newChatPaneProjectMapAtom);
  const [paneWorkModeMap, setPaneWorkModeMap] = useAtom(newChatPaneWorkModeMapAtom);
  const [paneChatModeMap, setPaneChatModeMap] = useAtom(newChatPaneChatModeMapAtom);
  const [paneModelMap, setPaneModelMap] = useAtom(newChatPaneModelMapAtom);
  const setGlobalWorkMode = useSetAtom(lastSelectedWorkModeAtom);
  const setGlobalChatMode = useSetAtom(chatModeAtom);
  const setGlobalModelId = useSetAtom(lastSelectedModelIdAtom);
  const closeFilesOutsideProject = useSetAtom(closeFilesOutsideProjectAtom);
  const filesSidebarOpen = useAtomValue(filesSidebarOpenAtom);

  // Split view: granular atoms so ratio drags / unrelated updates do not re-render all panes.
  const chatIds = useAtomValue(splitViewChatIdsAtom);
  const activePaneIndex = useAtomValue(splitViewActivePaneIndexAtom);
  const layout = useAtomValue(splitViewLayoutAtom);
  const ratios = useAtomValue(splitViewRatiosAtom);
  const gridRatios = useAtomValue(splitViewGridRatiosAtom);
  const paneZoomFactors = useAtomValue(splitViewPaneZoomFactorsAtom);
  const isSplitActive = chatIds.length >= 2;
  const pendingNewChatText = useAtomValue(pendingNewChatTextAtom);

  const {
    removeFromSplit,
    closeSplit,
    setRatios,
    setGridRatios,
    setActivePaneIndex,
    swapPanes,
    resetPaneZoomAt,
  } = useSplitViewActions();

  const splitToggleSidebar = useCallback(() => setSidebarOpen((prev) => !prev), [setSidebarOpen]);

  const codeEditorOpen = useAtomValue(codeEditorOpenAtom);
  const codeEditorLayout = useAtomValue(codeEditorLayoutAtom);
  const codeEditorWidth = useAtomValue(codeEditorWidthAtom);
  const codeEditorHeight = useAtomValue(codeEditorHeightAtom);
  const openFiles = useAtomValue(openFilesAtom);
  const isCodeEditorActive = codeEditorOpen && openFiles.length > 0;

  // Sync split view state to editor atoms
  const setEditorActivePaneIndex = useSetAtom(editorActivePaneIndexAtom);
  const setEditorIsSplitActive = useSetAtom(editorIsSplitActiveAtom);
  const setCodeEditorActiveChatId = useSetAtom(codeEditorActiveChatIdAtom);

  const setFilterTabsToActivePane = useSetAtom(filterTabsToActivePaneAtom);
  const setLastActiveTabPerPane = useSetAtom(lastActiveTabPerPaneAtom);
  const wasSplitActiveRef = useRef(isSplitActive);
  /** Set to `true` when transitioning split→single; consumed by the chat-sync effect */
  const justExitedSplitRef = useRef(false);
  /** Last project id synced into selectedProjectAtom (single-pane mode). */
  const lastSyncedProjectIdRef = useRef<string | null>(null);
  /** Forces one sync pass after split->single transitions. */
  const forceProjectResyncRef = useRef(false);

  const tagOpenFilesWithPaneContext = useSetAtom(tagOpenFilesWithPaneContextAtom);
  const clearPaneContext = useSetAtom(clearPaneContextAtom);
  const closePaneTabs = useSetAtom(closePaneTabsAtom);
  const setOpenFileTrees = useSetAtom(splitPaneFileTreesAtom);

  useEffect(() => {
    const wasSplit = wasSplitActiveRef.current;
    wasSplitActiveRef.current = isSplitActive;
    setEditorIsSplitActive(isSplitActive);

    // Cleanup pane-specific state when exiting split view
    if (wasSplit && !isSplitActive) {
      justExitedSplitRef.current = true;
      forceProjectResyncRef.current = true;
      lastSyncedProjectIdRef.current = null;
      setFilterTabsToActivePane(false);
      setLastActiveTabPerPane({});
      clearPaneContext(); // Remove stale sourcePaneIndex/sourceChatId from tabs

      // Safety net: clear the flag after a tick so it doesn't linger
      // if the consuming chat-sync effect doesn't re-run on this cycle.
      const timer = setTimeout(() => {
        justExitedSplitRef.current = false;
      }, 100);
      return () => clearTimeout(timer);
    }
  }, [
    isSplitActive,
    setEditorIsSplitActive,
    setFilterTabsToActivePane,
    setLastActiveTabPerPane,
    clearPaneContext,
  ]);

  useEffect(() => {
    setEditorActivePaneIndex(isSplitActive ? activePaneIndex : null);
    const chatId = isSplitActive ? (chatIds[activePaneIndex] ?? null) : selectedChatId;
    setCodeEditorActiveChatId(chatId != null ? chatId : !isSplitActive ? NEW_CHAT_PANE : null);
  }, [
    isSplitActive,
    activePaneIndex,
    chatIds,
    selectedChatId,
    setEditorActivePaneIndex,
    setCodeEditorActiveChatId,
  ]);

  const searchParams = useSearchParams();
  const router = useRouter();
  const isInitialized = useRef(false);
  const isFirstRenderRef = useRef(true); // Skip URL sync on first render to avoid race condition
  const newChatFormKeyRef = useRef(0);
  const isMobile = useIsMobile();
  const [isHydrated, setIsHydrated] = useState(false);
  const isAdmin = useIsAdmin();

  const { data: teams } = api.teams.getUserTeams.useQuery();
  const selectedTeam =
    // biome-ignore lint/style/useNamingConvention: DB field name
    (teams as Array<{ id: string; name?: string; image_url?: string }> | undefined)?.find(
      (t) => t.id === selectedTeamId,
    );

  // Fetch agent chats for keyboard navigation and mobile view
  const { data: agentChats } = api.agents.getAgentChats.useQuery(
    { teamId: selectedTeamId ?? '' },
    { enabled: !!selectedTeamId },
  );

  const { data: rawProjects } = trpc.projects.list.useQuery();
  // Guards: during tRPC client hydration on dev start (~1-2% of the time), data can
  // briefly be a non-undefined non-array value. See commit a6d57596.
  const projects = Array.isArray(rawProjects) ? rawProjects : undefined;

  // Create map for quick project lookup by id
  const projectsMap = useMemo(() => {
    if (!projects) return new Map();
    return new Map(projects.map((p) => [p.id, p]));
  }, [projects]);

  // O(1) lookup map for chat objects (avoids O(panes * chats) .find() in paneProjectInfo)
  type AgentChat = NonNullable<typeof agentChats>[number];
  const agentChatsById = useMemo(() => {
    if (!agentChats) return new Map<string, AgentChat>();
    return new Map(agentChats.map((c) => [c.id, c]));
  }, [agentChats]);

  // Resolve project info per split pane (stable — only changes when chatIds or project data change)
  // Unknown projects are excluded so the file tree button is hidden and no stale data is shown.
  const paneProjectInfo = useMemo(() => {
    return buildSplitPaneProjectInfo({
      isSplitActive,
      chatIds: chatIds,
      newChatPaneId: NEW_CHAT_PANE,
      agentChatsById,
      resolveLocalProject: (projectId) => {
        const project = projectsMap.get(projectId);
        if (!project) return undefined;
        return { path: project.path };
      },
    });
  }, [isSplitActive, chatIds, agentChatsById, projectsMap]);

  // Watch for IDE config directory changes (e.g. new agents in .cursor/agents/).
  // Called here (not per-pane ChatView) so a single listener handles all panes.
  const ideWatcherPaneCtx = useMemo<IdeWatcherPaneContext | undefined>(() => {
    if (!isSplitActive || chatIds.length <= 1) return undefined;
    const projectPaths = new Map<string, string>();
    for (const [chatId, info] of paneProjectInfo) {
      projectPaths.set(chatId, info.path);
    }
    return { chatIds: chatIds, projectPaths };
  }, [isSplitActive, chatIds, paneProjectInfo]);
  useIdeConfigWatcher(ideWatcherPaneCtx);

  // When split view activates (or pane assignments change), retroactively tag
  // existing editor tabs that were opened before split view with their pane context.
  useEffect(() => {
    if (!isSplitActive || paneProjectInfo.size === 0) return;
    const paneMap = chatIds
      .map((chatId, idx) => {
        if (!chatId) return null;
        const info = paneProjectInfo.get(chatId);
        if (!info) return null;
        return { projectPath: info.path, paneIndex: idx, chatId };
      })
      .filter((entry): entry is NonNullable<typeof entry> => entry !== null);
    if (paneMap.length > 0) {
      tagOpenFilesWithPaneContext(paneMap);
    }
  }, [isSplitActive, chatIds, paneProjectInfo, tagOpenFilesWithPaneContext]);

  // O(1) lookup map for chat names (avoids O(panes * chats) .find() in splitPanes)
  // Include the currently loaded single-chat data as a fallback so pane titles
  // stay stable when transitioning into split view before list cache catches up.
  const { data: chatData } = api.agents.getAgentChat.useQuery(
    { chatId: selectedChatId ?? '' },
    { enabled: !!selectedChatId },
  );
  const chatNameById = useMemo(() => {
    const map = new Map((agentChats ?? []).map((c) => [c.id, c.name ?? '']));
    if (chatData?.id && chatData.name) {
      map.set(chatData.id, chatData.name);
    }
    return map;
  }, [agentChats, chatData?.id, chatData?.name]);

  // Memoize split panes to avoid recreating the array on every render.
  // paneProjectInfo is a separate memo so agentChats/projectsMap don't re-trigger content creation.
  const splitPanes = useMemo(() => {
    if (!isSplitActive) return [];
    return chatIds.map((chatId, idx) => {
      const isNewChat = chatId === NEW_CHAT_PANE;
      const isRealChat = chatId !== null && !isNewChat;
      // Real chats get project info from their chat data only in split view (no global
      // fallback) to avoid race when two panes move at once — otherwise the second move
      // can set selectedProject and the other pane wrongly shows that project.
      const selectedProjectFallback = selectedProject?.path
        ? { path: selectedProject.path }
        : undefined;
      const rawPaneProject = isNewChat ? paneProjectMap[idx] : undefined;
      const newChatPaneProject = rawPaneProject?.path
        ? { path: rawPaneProject.path }
        : rawPaneProject === null
          ? undefined
          : rawPaneProject === undefined
            ? selectedProjectFallback
            : undefined;
      const info = resolvePaneProjectInfoForChat({
        isRealChat,
        isNewChat,
        chatId,
        splitPaneCount: chatIds.length,
        paneProjectInfo,
        selectedProjectFallback,
        newChatPaneProject,
      });
      let content: React.ReactNode;
      if (isRealChat) {
        content = (
          <HtmlArtifactChatView
            key={chatId}
            chatId={chatId}
            isSidebarOpen={sidebarOpen}
            onToggleSidebar={splitToggleSidebar}
            splitPaneIndex={idx}
            isPaneActive={idx === activePaneIndex}
            selectedTeamName={selectedTeam?.name}
            selectedTeamImageUrl={selectedTeam?.image_url}
          />
        );
      } else if (isNewChat) {
        // biome-ignore lint/suspicious/noArrayIndexKey: pane index is stable identity for new-chat panes
        content = <NewChatForm key={`new-chat-pane-${idx}`} splitPaneIndex={idx} />;
      } else {
        // null = unfilled empty placeholder. Show the pending message during chat creation.
        const firstNullIdx = chatIds.indexOf(null);
        if (pendingNewChatText && idx === firstNullIdx) {
          content = (
            // biome-ignore lint/suspicious/noArrayIndexKey: pane index is stable identity for pending panes
            <PendingChatPlaceholder key={`pending-pane-${idx}`} text={pendingNewChatText} />
          );
        } else {
          // biome-ignore lint/suspicious/noArrayIndexKey: pane index is stable identity for empty panes
          content = <EmptyPanePlaceholder key={`empty-pane-${idx}`} paneIndex={idx} />;
        }
      }

      const label = isRealChat
        ? chatNameById.get(chatId)?.slice(0, 30) || undefined
        : isNewChat
          ? 'New Chat'
          : undefined;

      return {
        id: isRealChat ? chatId : `empty-${idx}`,
        label,
        projectPath: info?.path,
        isWorktree: info?.isWorktree ?? false,
        content,
      };
    });
  }, [
    isSplitActive,
    chatIds,
    paneProjectInfo,
    paneProjectMap,
    chatNameById,
    activePaneIndex,
    sidebarOpen,
    splitToggleSidebar,
    selectedTeam?.name,
    selectedTeam?.image_url,
    selectedProject?.path,
    pendingNewChatText,
  ]);

  /** Wraps removeFromSplit to also close orphaned editor tabs for the closed pane
   *  and remap pane-index-dependent state so remaining panes track correctly. */
  const handleRemovePane = useCallback(
    (chatId: string | null, paneIndex: number) => {
      const newLength = chatIds.length - 1;

      // Per-pane project map: shift indices when staying in split, or sync to global and clear when exiting
      if (newLength >= 2) {
        setPaneProjectMap((prev) => shiftPaneMap(prev, paneIndex, newLength));
        setPaneWorkModeMap((prev) => shiftPaneMap(prev, paneIndex, newLength));
        setPaneChatModeMap((prev) => shiftPaneMap(prev, paneIndex, newLength));
        setPaneModelMap((prev) => shiftPaneMap(prev, paneIndex, newLength));
      } else if (newLength === 1) {
        const remainingIdx = paneIndex === 0 ? 1 : 0;
        const remainingProject = paneProjectMap[remainingIdx] ?? null;
        setSelectedProject(remainingProject);
        setPaneProjectMap({});
        const remainingWorkMode = paneWorkModeMap[remainingIdx];
        if (remainingWorkMode !== undefined) setGlobalWorkMode(remainingWorkMode);
        setPaneWorkModeMap({});
        const remainingChatMode = paneChatModeMap[remainingIdx];
        if (remainingChatMode !== undefined) setGlobalChatMode(remainingChatMode);
        setPaneChatModeMap({});
        const remainingModelId = paneModelMap[remainingIdx];
        if (remainingModelId !== undefined) setGlobalModelId(remainingModelId);
        setPaneModelMap({});
      }

      // Collect project paths of remaining panes (excluding the one being closed)
      const remainingProjectPaths = splitPanes
        .filter((_, i) => i !== paneIndex)
        .map((p) => p.projectPath)
        .filter((p): p is string => !!p);

      closePaneTabs({ closedPaneIndex: paneIndex, remainingProjectPaths });

      // Remap file-tree open indices: drop the removed index, shift higher ones down
      setOpenFileTrees((prev: Set<number>) => {
        const next = new Set<number>();
        for (const i of prev) {
          if (i < paneIndex) next.add(i);
          else if (i > paneIndex) next.add(i - 1);
        }
        return next;
      });

      // Shift lastActiveTabPerPane keys: drop removed index, shift higher ones down
      setLastActiveTabPerPane((prev: Record<number, string>) => {
        const next: Record<number, string> = {};
        for (const [key, value] of Object.entries(prev)) {
          const k = Number(key);
          if (k < paneIndex) next[k] = value;
          else if (k > paneIndex) next[k - 1] = value;
        }
        return next;
      });

      removeFromSplit(chatId, paneIndex);
    },
    [
      chatIds.length,
      paneProjectMap,
      paneChatModeMap,
      paneModelMap,
      paneWorkModeMap,
      splitPanes,
      closePaneTabs,
      removeFromSplit,
      setOpenFileTrees,
      setLastActiveTabPerPane,
      setPaneProjectMap,
      setPaneChatModeMap,
      setPaneModelMap,
      setPaneWorkModeMap,
      setSelectedProject,
      setGlobalChatMode,
      setGlobalModelId,
      setGlobalWorkMode,
    ],
  );

  const handleCloseSplit = useCallback(() => {
    setPaneProjectMap({});
    setPaneWorkModeMap({});
    setPaneChatModeMap({});
    setPaneModelMap({});
    closeSplit();
  }, [closeSplit, setPaneProjectMap, setPaneChatModeMap, setPaneModelMap, setPaneWorkModeMap]);

  // Listen for hotkey-triggered pane removal (Cmd+Shift+W dispatches this event)
  // Routes through handleRemovePane so editor tab cleanup is performed.
  const paneFocusRafRef = useRef<number>(0);
  useEffect(() => {
    const handler = () => {
      if (!isSplitActive) return;
      const chatId = chatIds[activePaneIndex];
      handleRemovePane(chatId && chatId !== NEW_CHAT_PANE ? chatId : null, activePaneIndex);

      // Focus the surviving pane's chat input after removal
      paneFocusRafRef.current = requestAnimationFrame(() => {
        focusChatInput();
      });
    };
    window.addEventListener('split:remove-active-pane', handler);
    return () => {
      window.removeEventListener('split:remove-active-pane', handler);
      cancelAnimationFrame(paneFocusRafRef.current);
    };
  }, [isSplitActive, chatIds, activePaneIndex, handleRemovePane]);

  // Track previous chat ID for navigation after archive
  const [_previousChatId, setPreviousChatId] = useAtom(previousAgentChatIdAtom);
  const prevSelectedChatIdRef = useRef<string | null>(null);

  // Update previousChatId when selectedChatId changes
  useEffect(() => {
    // Only update if we're switching from one chat to another
    if (prevSelectedChatIdRef.current && prevSelectedChatIdRef.current !== selectedChatId) {
      setPreviousChatId(prevSelectedChatIdRef.current);
    }
    prevSelectedChatIdRef.current = selectedChatId;
  }, [selectedChatId, setPreviousChatId]);

  // Sync selectedProjectAtom when chat changes (single-pane mode only).
  // In split view, each pane manages its own project context via PaneFileTree.
  useEffect(() => {
    if (isSplitActive) return; // Skip in split view — per-pane file trees handle this

    // Consume the "just exited split" flag to skip file cleanup on the first
    // render after transitioning split→single. Without this guard,
    // closeFilesOutsideProject would nuke tabs from the other project.
    const justExitedSplit = justExitedSplitRef.current;
    if (justExitedSplit) {
      justExitedSplitRef.current = false;
    }

    if (!chatData) return;

    const projectId = chatData.projectId ?? null;
    const forceProjectResync = forceProjectResyncRef.current;
    if (forceProjectResync) {
      forceProjectResyncRef.current = false;
    }

    // Skip if project hasn't changed (avoids cascading re-renders)
    if (
      shouldSkipSelectedProjectSync({
        lastSyncedProjectId: lastSyncedProjectIdRef.current,
        nextProjectId: projectId,
        forceResync: forceProjectResync,
      })
    ) {
      return;
    }

    // Resolve to a local project by id, falling back to the chat's own project.
    const chatProject = chatData.project as ChatProject | null | undefined;
    const decision = resolveChatProjectSync({
      projectId,
      projectsLoaded: projects !== undefined,
      resolvedProject: projectId ? projectsMap.get(projectId) : undefined,
      chatProject,
    });

    // Cold-start timing miss: the project list (which carries the icon's git metadata) hasn't
    // loaded yet. Defer WITHOUT committing the ref so this effect re-runs when projectsMap arrives.
    if (decision.kind === 'defer') return;

    lastSyncedProjectIdRef.current = projectId;

    if (decision.kind === 'clear') {
      setSelectedProject(null);
      if (!justExitedSplit) {
        closeFilesOutsideProject(null);
      }
      return;
    }

    setSelectedProject(decision.project);
    // Security: close files not belonging to this project
    // (skip on split→single transition to preserve multi-project tabs)
    if (!justExitedSplit) {
      const effectiveProjectPath = resolveEffectiveProjectPath({
        worktreePath:
          chatData && 'worktreePath' in chatData
            ? (chatData.worktreePath as string | undefined)
            : undefined,
        selectedProjectPath: decision.project.path,
      });
      closeFilesOutsideProject(effectiveProjectPath ?? null);
    }
  }, [
    chatData,
    projects,
    projectsMap,
    setSelectedProject,
    closeFilesOutsideProject,
    isSplitActive,
  ]);

  // Note: Archive mutations moved to AgentsSidebar to share undo stack with Cmd+Z

  useEffect(() => {
    setIsHydrated(true);
  }, []);

  // On mount: read URL → set atom
  useEffect(() => {
    if (isInitialized.current) return;
    isInitialized.current = true;

    const chatIdFromUrl = searchParams.get('chat');
    if (chatIdFromUrl) {
      setSelectedChatId(chatIdFromUrl);
    }
  }, [searchParams, setSelectedChatId]);

  // When atom changes: update URL and increment NewChatForm key when returning to new chat view
  useEffect(() => {
    // Skip the first render - let the URL read effect set the initial value first
    // This prevents a race condition where this effect would clear the chat param
    // before the atom has been updated from the URL
    if (isFirstRenderRef.current) {
      isFirstRenderRef.current = false;
      return;
    }

    const currentChatId = searchParams.get('chat');
    if (selectedChatId !== currentChatId) {
      const url = new URL(window.location.href);
      if (selectedChatId) {
        url.searchParams.set('chat', selectedChatId);
      } else {
        url.searchParams.delete('chat');
        // Increment key to force NewChatForm remount and trigger focus
        newChatFormKeyRef.current += 1;
      }
      router.replace(url.pathname + url.search);
    }
  }, [selectedChatId, searchParams, router]);

  // Auto-close sidebars on mobile devices
  useEffect(() => {
    if (isMobile && isHydrated) {
      setSidebarOpen(false);
      setPreviewSidebarOpen(false);
    }
  }, [isMobile, isHydrated, setSidebarOpen, setPreviewSidebarOpen]);

  // On mobile: when chat is selected, switch to chat mode
  useEffect(() => {
    if (isMobile && selectedChatId && mobileViewMode === 'chats') {
      setMobileViewMode('chat');
    }
  }, [isMobile, selectedChatId, mobileViewMode, setMobileViewMode]);

  // On mobile: when in terminal mode, sync with terminal sidebar close
  const terminalSidebarOpen = useAtomValue(terminalSidebarAtom);
  useEffect(() => {
    // If terminal sidebar closed while in terminal mode, go back to chat
    if (isMobile && mobileViewMode === 'terminal' && !terminalSidebarOpen) {
      setMobileViewMode('chat');
    }
  }, [isMobile, mobileViewMode, terminalSidebarOpen, setMobileViewMode]);

  // Note: Cmd+E archive hotkey is handled in AgentsSidebar to share undo stack

  // Check if chat has sandbox with port for preview
  const chatMeta = chatData?.meta as
    | {
        sandboxConfig?: { port?: number };
        isQuickSetup?: boolean;
        repository?: string;
      }
    | undefined;
  const isQuickSetup = chatMeta?.isQuickSetup === true;
  const canShowPreview = !!(chatData?.sandboxId && !isQuickSetup && chatMeta?.sandboxConfig?.port);

  // The diff and terminal views both read the worktree (desktop only).
  const worktreePath = resolveEffectiveProjectPath({
    worktreePath:
      chatData && 'worktreePath' in chatData
        ? (chatData.worktreePath as string | undefined)
        : undefined,
  });
  const canShowDiff = !!worktreePath;
  const canShowTerminal = !!worktreePath;

  // Code editor layout styles for desktop (must be before mobile early return)
  const isLeftLayout = isCodeEditorActive && codeEditorLayout === 'left';
  const isRightLayout = isCodeEditorActive && codeEditorLayout === 'right';
  const isTopLayout = isCodeEditorActive && codeEditorLayout === 'top';

  const chatContainerStyle = useMemo(() => {
    if (!isCodeEditorActive) return {};
    if (isLeftLayout) {
      return { marginLeft: `${codeEditorWidth}%` };
    }
    if (isRightLayout) {
      return { marginRight: `${codeEditorWidth}%` };
    }
    if (isTopLayout) {
      // Position below the editor and fill remaining parent space.
      return {
        position: 'absolute' as const,
        top: `${codeEditorHeight}%`,
        left: 0,
        right: 0,
        bottom: 0,
      };
    }
    return {};
  }, [
    isCodeEditorActive,
    isLeftLayout,
    isRightLayout,
    isTopLayout,
    codeEditorWidth,
    codeEditorHeight,
  ]);

  // Mobile layout - completely different structure
  if (isMobile) {
    return (
      <div className="flex h-full bg-background" data-agents-page data-mobile-view>
        {/* Mobile View Modes */}
        {mobileViewMode === 'chats' ? (
          // Chats List Mode (default) - uses UnifiedSidebar in fullscreen
          <UnifiedSidebar
            onToggleSidebar={() => {}}
            isMobileFullscreen={true}
            onChatSelect={() => setMobileViewMode('chat')}
          />
        ) : mobileViewMode === 'preview' &&
          selectedChatId &&
          canShowPreview &&
          typeof chatMeta?.sandboxConfig?.port === 'number' ? (
          // Preview Mode
          <AgentPreview
            chatId={selectedChatId}
            sandboxId={chatData?.sandboxId ?? ''}
            port={chatMeta.sandboxConfig.port}
            isMobile={true}
            onClose={() => setMobileViewMode('chat')}
          />
        ) : mobileViewMode === 'diff' && selectedChatId && worktreePath ? (
          // Diff Mode - fullscreen diff view
          <DiffPanel
            chatId={selectedChatId}
            worktreePath={worktreePath}
            onClose={() => setMobileViewMode('chat')}
            watchRepo
          />
        ) : mobileViewMode === 'terminal' && selectedChatId && canShowTerminal ? (
          // Terminal Mode - fullscreen terminal
          <TerminalSidebar
            chatId={selectedChatId}
            cwd={worktreePath ?? ''}
            workspaceId={selectedChatId}
            isMobileFullscreen={true}
            onClose={() => setMobileViewMode('chat')}
          />
        ) : (
          // Chat Mode - shows either ChatView or NewChatForm
          <div
            className="h-full w-full flex flex-col overflow-hidden select-text"
            data-mobile-chat-mode
          >
            {selectedChatId ? (
              <HtmlArtifactChatView
                key={selectedChatId}
                chatId={selectedChatId}
                isSidebarOpen={false}
                onToggleSidebar={() => {}}
                selectedTeamName={selectedTeam?.name}
                selectedTeamImageUrl={selectedTeam?.image_url}
                isMobileFullscreen={true}
                onBackToChats={() => {
                  setMobileViewMode('chats');
                  setSelectedChatId(null);
                }}
                onOpenPreview={canShowPreview ? () => setMobileViewMode('preview') : undefined}
                onOpenDiff={canShowDiff ? () => setMobileViewMode('diff') : undefined}
                onOpenTerminal={
                  canShowTerminal
                    ? () => {
                        setTerminalSidebarOpen(true);
                        setMobileViewMode('terminal');
                      }
                    : undefined
                }
              />
            ) : (
              // NewChatForm for creating new agent
              <div className="h-full flex flex-col relative overflow-hidden">
                <NewChatForm
                  isMobileFullscreen={true}
                  onBackToChats={() => setMobileViewMode('chats')}
                />
              </div>
            )}
          </div>
        )}
      </div>
    );
  }

  return (
    <>
      <div className="flex h-full">
        {/* Main content */}
        <div className="flex-1 min-h-0 min-w-0 overflow-hidden" style={MIN_WIDTH_350_STYLE}>
          <div className="relative flex h-full min-h-0 flex-col overflow-hidden">
            {isSplitActive ? (
              /* Split view: multiple ChatViews side-by-side */
              <div
                className={cn(
                  'flex flex-col transition-all duration-200 overflow-hidden min-h-0',
                  !isTopLayout && 'h-full',
                )}
                style={chatContainerStyle}
              >
                <SplitViewContainer
                  panes={splitPanes}
                  ratios={ratios}
                  onRatiosChange={setRatios}
                  gridRatios={gridRatios}
                  onGridRatiosChange={setGridRatios}
                  onRemovePane={handleRemovePane}
                  onCloseSplit={handleCloseSplit}
                  activePaneIndex={activePaneIndex}
                  onSetActivePane={setActivePaneIndex}
                  layout={layout}
                  initialFileTreeOpen={filesSidebarOpen}
                  onSwapPanes={swapPanes}
                  paneZoomFactors={paneZoomFactors}
                  onResetPaneZoomAt={resetPaneZoomAt}
                />
              </div>
            ) : selectedChatId ? (
              /* Single chat view */
              <div
                className={cn(
                  'flex flex-col transition-all duration-200 overflow-hidden min-h-0',
                  !isTopLayout && 'h-full',
                )}
                style={chatContainerStyle}
              >
                <HtmlArtifactChatView
                  key={selectedChatId}
                  chatId={selectedChatId}
                  isSidebarOpen={sidebarOpen}
                  onToggleSidebar={() => setSidebarOpen((prev) => !prev)}
                  selectedTeamName={selectedTeam?.name}
                  selectedTeamImageUrl={selectedTeam?.image_url}
                />
              </div>
            ) : (
              /* New chat form (default when no chat selected) */
              <div
                className={cn(
                  'flex flex-col transition-all duration-200 overflow-hidden min-h-0',
                  !isTopLayout && 'h-full',
                )}
                style={chatContainerStyle}
              >
                <NewChatForm key={`new-chat-${newChatFormKeyRef.current}`} />
              </div>
            )}
          </div>
        </div>
      </div>

      {/* Dev mode / Admin sandbox debugger */}
      {(process.env.NODE_ENV === 'development' || isAdmin) && chatData?.sandboxId && (
        <a
          href={`https://codesandbox.io/p/devbox/${chatData.sandboxId}`}
          target="_blank"
          rel="noopener noreferrer"
          className="fixed bottom-4 right-4 z-50 bg-zinc-900 text-zinc-300 px-3 py-1.5 rounded-md text-xs font-mono opacity-70 hover:opacity-100 hover:bg-zinc-800 transition-all cursor-pointer"
        >
          sandbox: {chatData.sandboxId}
        </a>
      )}
    </>
  );
}
