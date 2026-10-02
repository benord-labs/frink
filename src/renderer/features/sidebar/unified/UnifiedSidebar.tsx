/* eslint-disable max-lines, max-lines-per-function */
/** Unified chat sidebar with navigation, project tree, drag-and-drop, and footer controls. */

import * as Sentry from '@sentry/electron/renderer';
import { useAtom, useAtomValue, useSetAtom } from 'jotai';
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
import { toast } from 'sonner';
import type { SidebarBatchGroup } from '../../../../shared/types/flows/sidebar-batch-group';
import { useSettingsNavigation } from '../../../hooks/useSettingsNavigation';
import { activeOverlayAtom } from '../../../lib/atoms';
import {
  exitDestinationForSidebarNavigationAtom,
  flowsDashboardActiveAtom,
} from '../../../lib/atoms/agent-navigation-atoms';
import { cleanupChatScopedState } from '../../../lib/atoms/atom-family-factory';
import {
  useArchiveWindowEvents,
  useTaskAwareArchive,
} from '../../../lib/hooks/sidebar-chat-archive/use-chat-archive-actions';
import { usePendingPlanIds } from '../../../lib/hooks/use-sidebar-pending-plan-ids';
import { useWindowEvent } from '../../../lib/hooks/use-window-event';
import { createIdSelectionStore } from '../../../lib/tree-navigation';
import { trpc, trpcClient } from '../../../lib/trpc';
import { hasModifiedFiles } from '../../../lib/utils/git-status';
import { useWorkQueueExitAction } from '../../../lib/work-queue/use-work-queue-exit-action';
import {
  agentsUnseenChangesAtom,
  loadingSubChatsAtom,
  NEW_CHAT_PANE,
  pendingPlanApprovalsAtom,
  pendingUserQuestionsAtom,
  selectedAgentChatIdAtom,
  selectedProjectAtom,
  showNewChatFormAtom,
  splitViewActivePaneIndexAtom,
  splitViewChatIdsAtom,
} from '../../agents/atoms';
import {
  canOpenChatInNewPane,
  MAX_PANES,
  useSplitViewActions,
} from '../../agents/hooks/use-split-view';
import { filesSidebarOpenAtom } from '../../files-sidebar/atoms';
import { InsetGlassSidebarShell } from '../inset-glass-sidebar-shell';
import {
  ArchivedChatsSection,
  ChatSelectionChip,
  ChatSelectionContext,
  ProjectsTree,
  SidebarDialogs,
  SidebarFooter,
  SidebarHeader,
  SidebarNav,
} from './components';
import { PAGINATION, SIDEBAR_TRACKED_TASK_STATUSES, STRINGS, TIMING } from './constants';
import {
  toastPartialFailure,
  useBulkChatActions,
} from '../../../lib/hooks/sidebar-bulk-chats/use-bulk-chat-actions';
import { useChatDnd } from './hooks/use-chat-dnd';
import { useDeleteConfirm } from './hooks/use-delete-confirm';
import { useExpansionState } from './hooks/use-expansion-state';
import { useGroupedProjects } from './hooks/use-grouped-projects';
import {
  applyChatMoveToSidebarMaps,
  applyChatRenameToSidebarMaps,
  applyChatRestoreToSidebarMaps,
  applyForkInsertToSidebarMaps,
  applyPinToggleToSidebarMaps,
  computeFolderSnapshot,
  forkMutationResultToSidebarItem,
  invalidateBatchViews,
  refetchListCountsAndSyncFolderSnapshots,
  removeChatIdsFromSidebarMaps,
  resolveSidebarFolderKeyForProjectId,
  SIDEBAR_GENERAL_COUNT_KEY,
} from './hooks/use-sidebar-chat-cache';
import { useSidebarNavigation } from './hooks/use-sidebar-navigation';
import { useTaskAwareChatActions } from './hooks/use-task-aware-chat-actions';
/** Handle exposed by UnifiedSidebar for programmatic focus */
import { sidebarChatActivityBumpAtom } from './sidebar-chat-activity';
import type { FolderDescriptor, TaskAwareActionDialogState, UnifiedSidebarProps } from './types';
import type { FolderCursor, SidebarChatListItem, SidebarPolledTask } from './utils';
import {
  buildChatReasonMap,
  buildSidebarActivityMaps,
  buildPendingQuestionChatIds,
  bumpChatUpdatedAtInFolderMap,
  extractErrorMessage,
  mergeChatsById,
  normalizeCursor,
  sameSidebarTasks,
} from './utils';
import { unifiedSidebarPropsAreEqual } from './utils/chat-equality';
import { createFolderLoadMoreSyncGuard } from './utils/folder-load-more-sync-guard';

export type UnifiedSidebarHandle = {
  /** Focus the tree container for keyboard navigation */
  focus: () => void;
  /** Restore focus to the Work Queue destination trigger after dismissal. */
  focusWorkQueueTrigger: () => void;
};

const GENERAL_FOLDER_KEY = STRINGS.GENERAL_CHATS;
const SIDEBAR_CHAT_LOAD_TOAST_ID = 'sidebar-chat-load-error';
const CHAT_LOAD_TOAST_COOLDOWN_MS = 5000;
const SIDEBAR_TASK_STATUS_QUERY_LIMIT = 200;
const SIDEBAR_ACTIVE_TASK_MAX_PAGES = 3;
const SIDEBAR_ACTIVE_TASK_MAX_ITEMS = 600;
/** `listPinned.fetch` failed; used so delete flows can show a specific toast (not generic project/folder). */
const CHAT_PIN_LIST_LOAD_ERROR = 'CHAT_PIN_LIST_LOAD_ERROR';
/** Stable identity for the pre-load render, so the archived section and footer badge don't churn. */
const NO_ARCHIVED_CHATS: Array<{ id: string; name: string | null }> = [];

function isChatPinListLoadError(err: unknown): boolean {
  return err instanceof Error && (err as { code?: string }).code === CHAT_PIN_LIST_LOAD_ERROR;
}
const UnifiedSidebarInner = forwardRef<UnifiedSidebarHandle, UnifiedSidebarProps>(
  function UnifiedSidebar({ onToggleSidebar, isMobileFullscreen = false, onChatSelect }, ref) {
    const [searchQuery, setSearchQuery] = useState('');
    const searchInputRef = useRef<HTMLInputElement>(null);
    const treeContainerRef = useRef<HTMLDivElement>(null);
    const { askDelete, confirmDialog } = useDeleteConfirm();
    const [chatSelection] = useState(createIdSelectionStore);
    const workQueueTriggerRef = useRef<HTMLButtonElement>(null);
    const flowsTriggerRef = useRef<HTMLButtonElement>(null);
    const lastChatLoadToastAtRef = useRef(0);
    const [folderChatsByKey, setFolderChatsByKey] = useState<Record<string, SidebarChatListItem[]>>(
      {},
    );
    const [pinnedChatsByKey, setPinnedChatsByKey] = useState<Record<string, SidebarChatListItem[]>>(
      {},
    );
    const [folderHasMoreByKey, setFolderHasMoreByKey] = useState<Record<string, boolean>>({});
    const [folderCursorByKey, setFolderCursorByKey] = useState<Record<string, FolderCursor | null>>(
      {},
    );
    const [folderCountSnapshotByKey, setFolderCountSnapshotByKey] = useState<
      Record<string, number>
    >({});
    const [folderLoadingByKey, setFolderLoadingByKey] = useState<Record<string, boolean>>({});
    const folderHasMoreByKeyRef = useRef<Record<string, boolean>>({});
    const folderCursorByKeyRef = useRef<Record<string, FolderCursor | null>>({});
    const folderLoadingByKeyRef = useRef<Record<string, boolean>>({});
    const folderLoadMoreSyncGuardRef = useRef(createFolderLoadMoreSyncGuard());
    const [taskAwareActionDialog, setTaskAwareActionDialog] = useState<TaskAwareActionDialogState>({
      open: false,
      mode: 'single',
      operation: 'archive',
      chatIds: [],
      taskIds: [],
      totalChats: 0,
    });
    const [activeTasks, setActiveTasks] = useState<SidebarPolledTask[]>([]);
    const [activeTasksHasMore, setActiveTasksHasMore] = useState(false);
    const taskAwareActionDialogRef = useRef(taskAwareActionDialog);
    taskAwareActionDialogRef.current = taskAwareActionDialog;

    const resetFolderPaginationState = useCallback(() => {
      folderLoadMoreSyncGuardRef.current = createFolderLoadMoreSyncGuard();
      setFolderChatsByKey({});
      setPinnedChatsByKey({});
      setFolderHasMoreByKey({});
      setFolderCursorByKey({});
      setFolderCountSnapshotByKey({});
      setFolderLoadingByKey({});
    }, []);

    const activityBump = useAtomValue(sidebarChatActivityBumpAtom);
    useEffect(() => {
      if (!activityBump) return;
      const bumpDate = new Date(activityBump.at);
      setFolderChatsByKey((prev) =>
        bumpChatUpdatedAtInFolderMap(prev, activityBump.chatId, bumpDate),
      );
      setPinnedChatsByKey((prev) =>
        bumpChatUpdatedAtInFolderMap(prev, activityBump.chatId, bumpDate),
      );
    }, [activityBump]);

    // Async chat-name generation: patch in-memory sidebar maps when the main
    // process broadcasts a new title. The tRPC cache invalidation handled by
    // ChatNameUpdateBridge covers consumers like the chat header, but the
    // sidebar's folder/pinned state is local React state, so it needs a
    // direct patch.
    useEffect(() => {
      const desktopApi = window.desktopApi;
      if (!desktopApi?.on) return;
      return desktopApi.on('chats:name-updated', (data) => {
        if (
          !data ||
          typeof data !== 'object' ||
          typeof (data as { chatId?: unknown }).chatId !== 'string' ||
          typeof (data as { subChatId?: unknown }).subChatId !== 'string' ||
          typeof (data as { name?: unknown }).name !== 'string'
        ) {
          return;
        }
        const { chatId, subChatId, name } = data as {
          chatId: string;
          subChatId: string;
          name: string;
        };
        applyChatRenameToSidebarMaps(setFolderChatsByKey, setPinnedChatsByKey, chatId, name);
        void import('../../agents/stores/sub-chat-store').then(({ useAgentSubChatStore }) => {
          useAgentSubChatStore.getState().updateSubChatName(subChatId, name);
        });
      });
    }, []);

    useImperativeHandle(ref, () => ({
      focus: () => {
        treeContainerRef.current?.focus();
      },
      focusWorkQueueTrigger: () => {
        workQueueTriggerRef.current?.focus();
      },
    }));

    // Atoms
    const [selectedChatId, setSelectedChatId] = useAtom(selectedAgentChatIdAtom);
    const setShowNewChatForm = useSetAtom(showNewChatFormAtom);
    const { openSettings, openSettingsTab } = useSettingsNavigation();
    const [activeOverlay, setActiveOverlay] = useAtom(activeOverlayAtom);
    // Only the Flows dashboard renders beside the sidebar; the editor is a full-width takeover.
    const isFlowsActive = useAtomValue(flowsDashboardActiveAtom);
    const exitForNavigation = useSetAtom(exitDestinationForSidebarNavigationAtom);
    const wrapWorkQueueExitAction = useWorkQueueExitAction(exitForNavigation);
    const unseenChanges = useAtomValue(agentsUnseenChangesAtom);
    const loadingSubChats = useAtomValue(loadingSubChatsAtom);
    const livePlanApprovals = useAtomValue(pendingPlanApprovalsAtom);
    const pendingQuestions = useAtomValue(pendingUserQuestionsAtom);
    const [isFilesSidebarOpen, setIsFilesSidebarOpen] = useAtom(filesSidebarOpenAtom);
    const selectedProject = useAtomValue(selectedProjectAtom);
    const chatIds = useAtomValue(splitViewChatIdsAtom);
    const splitViewChatIdsRef = useRef(chatIds);
    splitViewChatIdsRef.current = chatIds;
    const activePaneIndex = useAtomValue(splitViewActivePaneIndexAtom);
    const {
      addEmptyPane,
      addNewChatPane,
      openChatInNewPane,
      clearPaneAt,
      restorePaneAt,
      newChatAtPane,
      fillActivePane,
      cycleLayout,
      resetPaneSizes,
      resetPaneZoom,
    } = useSplitViewActions();

    const isSplitActive = chatIds.length >= 2;
    const canOpenInNewPane = canOpenChatInNewPane(chatIds);
    const chatPaneMap = useMemo(() => {
      const map = new Map<string, number>();
      for (let i = 0; i < chatIds.length; i++) {
        const id = chatIds[i];
        if (id !== null && id !== NEW_CHAT_PANE) {
          map.set(id, i + 1);
        }
      }
      return map;
    }, [chatIds]);

    // Show files button when a project is selected AND not in split view.
    const showFilesButton = Boolean(selectedProject?.path) && !isSplitActive;
    const worktreePathForStatus =
      showFilesButton && selectedProject?.path ? selectedProject.path : '';

    // ========== Data Fetching ==========
    // NOTE: Destructuring defaults (= []) only guard against `undefined`.
    // During tRPC client hydration on dev start (~1-2% of the time), `data` can
    // briefly be a non-undefined non-array value. Use Array.isArray to be safe.
    const { data: gitStatus } = trpc.changes.getStatus.useQuery(
      { worktreePath: worktreePathForStatus },
      { enabled: !!worktreePathForStatus },
    );
    const hasModified = hasModifiedFiles(gitStatus);
    const { data: rawLocalProjects } = trpc.projects.list.useQuery(undefined);
    const { data: rawChatCounts } = trpc.chats.listCounts.useQuery(undefined, {
      refetchInterval: TIMING.CHAT_POLL_INTERVAL_MS,
      structuralSharing: true,
    });
    const chatCountByProject = useMemo(() => {
      const map = new Map<string, number>();
      const counts = Array.isArray(rawChatCounts) ? rawChatCounts : [];
      for (const item of counts) {
        const key = item.projectId ?? SIDEBAR_GENERAL_COUNT_KEY;
        map.set(key, item.count);
      }
      return map;
    }, [rawChatCounts]);
    const chatCountByProjectRef = useRef(chatCountByProject);
    chatCountByProjectRef.current = chatCountByProject;

    /**
     * Batch group summaries — conditionally polled only when batches exist.
     * Returns [] initially; once fetched, polls on the standard interval only when
     * the last result was non-empty (avoids unnecessary queries for users without batches).
     */
    const { data: rawBatchGroups } = trpc.chats.listBatchGroups.useQuery(undefined, {
      refetchInterval: (query) => {
        const data = query.state.data;
        const hasBatches = Array.isArray(data) && data.length > 0;
        return hasBatches ? TIMING.CHAT_POLL_INTERVAL_MS : false;
      },
      structuralSharing: true,
    });
    const batchGroupsMap = useMemo(() => {
      const map = new Map<string, SidebarBatchGroup>();
      if (!Array.isArray(rawBatchGroups)) return map;
      for (const group of rawBatchGroups) {
        map.set(group.batch_id, group);
      }
      return map;
    }, [rawBatchGroups]);
    const chats = useMemo(
      () =>
        mergeChatsById([
          ...Object.values(folderChatsByKey).flat(),
          ...Object.values(pinnedChatsByKey).flat(),
        ]),
      [folderChatsByKey, pinnedChatsByKey],
    );
    const pendingPlanIds = usePendingPlanIds(chats, livePlanApprovals, TIMING);
    const { data: rawArchivedChats } = trpc.chats.listArchived.useQuery(undefined);
    const archivedChats = Array.isArray(rawArchivedChats) ? rawArchivedChats : NO_ARCHIVED_CHATS;
    // Collapse per-flow so the sidebar work-queue badge numbers match the Work Queue's own counts.
    const { data: taskCounts } = trpc.tasks.listCounts.useQuery(
      { collapseByFlow: true },
      {
        refetchInterval: TIMING.CHAT_POLL_INTERVAL_MS,
        structuralSharing: true,
      },
    );
    const { data: rawActiveTasksPage } = trpc.tasks.listPaginated.useQuery(
      {
        statuses: [...SIDEBAR_TRACKED_TASK_STATUSES],
        limit: SIDEBAR_TASK_STATUS_QUERY_LIMIT,
        cursor: null,
      },
      {
        refetchInterval: TIMING.CHAT_POLL_INTERVAL_MS,
        structuralSharing: true,
      },
    );
    // Active chats with folder + batch (listActiveChats); its live-flow flag keeps the 'Run' badge on a
    // flow chat through taskless windows, and folder dots count chats whose rows are not loaded.
    const { data: activeChats } = trpc.chats.listActiveChats.useQuery(undefined, {
      refetchInterval: TIMING.CHAT_POLL_INTERVAL_MS,
      structuralSharing: true,
    });
    useEffect(() => {
      let isCancelled = false;

      const loadAllActiveTaskPages = async () => {
        try {
          // SAFETY: tasks.listPaginated selects the full task row; SidebarPolledTask names the
          // subset the sidebar reads, all of it optional, so a missing column narrows to undefined.
          const firstItems = Array.isArray(rawActiveTasksPage?.items)
            ? (rawActiveTasksPage.items as SidebarPolledTask[])
            : [];
          const byId = new Map(firstItems.map((task) => [task.id, task]));

          let cursor = rawActiveTasksPage?.nextCursor ?? null;
          const seenCursors = new Set<string>();
          let pagesLoaded = 1;
          let truncatedByLimit = false;
          let hasMore = Boolean(rawActiveTasksPage?.hasMore || cursor);
          while (cursor) {
            const cursorKey = `${cursor.createdAt}:${cursor.id}`;
            if (seenCursors.has(cursorKey)) {
              hasMore = true;
              break;
            }
            seenCursors.add(cursorKey);
            if (
              pagesLoaded >= SIDEBAR_ACTIVE_TASK_MAX_PAGES ||
              byId.size >= SIDEBAR_ACTIVE_TASK_MAX_ITEMS
            ) {
              truncatedByLimit = true;
              hasMore = true;
              break;
            }

            const nextPage = await trpcClient.tasks.listPaginated.query({
              statuses: [...SIDEBAR_TRACKED_TASK_STATUSES],
              limit: SIDEBAR_TASK_STATUS_QUERY_LIMIT,
              cursor,
            });
            // SAFETY: same procedure as the first page above, so the same row shape.
            const nextItems = Array.isArray(nextPage?.items)
              ? (nextPage.items as SidebarPolledTask[])
              : [];
            for (const task of nextItems) {
              if (byId.size >= SIDEBAR_ACTIVE_TASK_MAX_ITEMS) {
                truncatedByLimit = true;
                hasMore = true;
                break;
              }
              byId.set(task.id, task);
            }
            pagesLoaded += 1;
            if (!nextPage?.hasMore || !nextPage.nextCursor) {
              hasMore = false;
              break;
            }
            if (truncatedByLimit) break;
            cursor = nextPage.nextCursor;
            hasMore = true;
          }

          if (isCancelled) return;
          const nextTasks = Array.from(byId.values());
          setActiveTasks((prev) => (sameSidebarTasks(prev, nextTasks) ? prev : nextTasks));
          setActiveTasksHasMore(hasMore || truncatedByLimit);
        } catch (error) {
          if (isCancelled) return;
          // The walk degrades to page 1 in silence, so a persistent failure would just look like
          // stale task badges. Capture it; the truncation is otherwise invisible.
          Sentry.captureException(error, {
            tags: { source: 'UnifiedSidebar', area: 'sidebar-task-pagination' },
          });
          // SAFETY: same procedure as the first page above, so the same row shape.
          const fallbackTasks = Array.isArray(rawActiveTasksPage?.items)
            ? (rawActiveTasksPage.items as SidebarPolledTask[])
            : [];
          setActiveTasks((prev) => (sameSidebarTasks(prev, fallbackTasks) ? prev : fallbackTasks));
          setActiveTasksHasMore(Boolean(rawActiveTasksPage?.hasMore));
        }
      };

      void loadAllActiveTaskPages();
      return () => {
        isCancelled = true;
      };
    }, [rawActiveTasksPage]);
    const utils = trpc.useUtils();
    /** tRPC `utils.*` procedure objects are new references most renders — callbacks that list them in deps churn and defeat CodebaseItem memo. */
    const utilsRef = useRef(utils);
    utilsRef.current = utils;

    // ========== Derived Data ==========
    const loadingChatIds = useMemo(() => new Set([...loadingSubChats.values()]), [loadingSubChats]);
    const pendingQuestionIds = useMemo(
      () => buildPendingQuestionChatIds(pendingQuestions),
      [pendingQuestions],
    );

    // Keep state counts separate so the footer represents urgency clearly: inbox = new/pending work,
    // pendingReview = tasks needing review, running = low-salience activity. needsAttention folds
    // interrupted (restart-recovered) runs so they light the same attention dot as awaiting-input.
    const inboxTaskCount = taskCounts?.pending ?? 0;
    const pendingReviewCount = (taskCounts?.planReady ?? 0) + (taskCounts?.done ?? 0);
    const runningTaskCount = taskCounts?.running ?? 0;
    const needsAttentionTaskCount =
      (taskCounts?.needsAttention ?? 0) + (taskCounts?.interrupted ?? 0);
    const failedTaskCount = taskCounts?.failed ?? 0;

    // Live flow runs keep their chats `running`, never a premature "Done" (buildChatTaskStatusMap).
    const [chatTaskStatusByChatId, activeChatsByFolder] = useMemo(
      () => buildSidebarActivityMaps(activeTasks, activeChats ?? []),
      [activeTasks, activeChats],
    );
    // The park reason of the task that wins each chat's pill, for its tooltip (buildChatReasonMap).
    const chatReasonByChatId = useMemo(() => buildChatReasonMap(activeTasks), [activeTasks]);

    const transformedProjects = useMemo(
      () => (Array.isArray(rawLocalProjects) ? rawLocalProjects : []),
      [rawLocalProjects],
    );

    const folderDescriptors = useMemo(() => {
      const byKey = new Map<string, FolderDescriptor>();
      for (const project of transformedProjects) {
        const key = project.gitRemoteUrl ?? project.gitRepo ?? project.name;
        const existing = byKey.get(key);
        if (existing) {
          if (existing.projectIds && !existing.projectIds.includes(project.id)) {
            existing.projectIds.push(project.id);
          }
        } else {
          byKey.set(key, { key, projectIds: [project.id] });
        }
      }

      const descriptors = Array.from(byKey.values());
      if ((chatCountByProject.get(SIDEBAR_GENERAL_COUNT_KEY) ?? 0) > 0) {
        descriptors.push({ key: GENERAL_FOLDER_KEY, projectIds: null });
      }
      return descriptors;
    }, [transformedProjects, chatCountByProject]);

    const folderDescriptorMap = useMemo(() => {
      return new Map(folderDescriptors.map((folder) => [folder.key, folder]));
    }, [folderDescriptors]);
    const folderDescriptorMapRef = useRef(folderDescriptorMap);
    folderDescriptorMapRef.current = folderDescriptorMap;

    const chatCountByFolderKey = useMemo(() => {
      const counts: Record<string, number> = {};
      for (const folder of folderDescriptors) {
        if (folder.projectIds === null) {
          counts[folder.key] = chatCountByProject.get(SIDEBAR_GENERAL_COUNT_KEY) ?? 0;
          continue;
        }
        counts[folder.key] = folder.projectIds.reduce(
          (sum, projectId) => sum + (chatCountByProject.get(projectId) ?? 0),
          0,
        );
      }
      return counts;
    }, [folderDescriptors, chatCountByProject]);
    const chatCountByFolderKeyRef = useRef(chatCountByFolderKey);
    chatCountByFolderKeyRef.current = chatCountByFolderKey;
    folderHasMoreByKeyRef.current = folderHasMoreByKey;
    folderCursorByKeyRef.current = folderCursorByKey;
    folderLoadingByKeyRef.current = folderLoadingByKey;

    // Transform chats
    const transformedChats = useMemo(() => {
      return chats.map((c) => ({
        id: c.id,
        name: c.name,
        branch: c.branch,
        updatedAt: c.updatedAt,
        pinnedAt: c.pinnedAt ?? null,
        projectId: c.projectId,
        worktreePath: c.worktreePath ?? null,
        taskId: c.taskId ?? null,
        batchId: c.batchId ?? null,
      }));
    }, [chats]);

    // Group projects by codebase
    const groupedCodebases = useGroupedProjects({
      projects: transformedProjects,
      chats: transformedChats,
      unseenChanges,
      loadingChats: loadingChatIds,
      pendingPlans: pendingPlanIds,
      pendingQuestions: pendingQuestionIds,
    });

    // Filter by search
    const filteredCodebases = useMemo(() => {
      if (!searchQuery.trim()) return groupedCodebases;
      const query = searchQuery.toLowerCase();
      return groupedCodebases
        .map((codebase) => ({
          ...codebase,
          chats: codebase.chats.filter(
            (chat) =>
              chat.name?.toLowerCase().includes(query) ||
              chat.branch?.toLowerCase().includes(query),
          ),
        }))
        .filter(
          (codebase) =>
            codebase.displayName.toLowerCase().includes(query) || codebase.chats.length > 0,
        );
    }, [groupedCodebases, searchQuery]);

    // ========== Expansion State ==========
    const { isCodebaseExpanded, toggleCodebase, collapseAll } = useExpansionState();

    // Listen for collapse-all event from hotkey action
    useWindowEvent('sidebar:collapse-all', () => collapseAll());

    // ========== Chat Mutations ==========
    const archiveChat = trpc.chats.archive.useMutation();
    const restoreChat = trpc.chats.restore.useMutation();
    const deleteChat = trpc.chats.delete.useMutation();
    const renameChat = trpc.chats.rename.useMutation();
    const renameProject = trpc.projects.rename.useMutation();
    const moveChat = trpc.chats.moveToProject.useMutation();
    const forkChat = trpc.chats.fork.useMutation();
    const togglePinChat = trpc.chats.togglePin.useMutation();
    /** Prevents overlapping pin toggles when `mutateAsync` is in flight (same-tick double-tap). */
    const togglePinInFlightRef = useRef(false);
    const deleteProject = trpc.projects.delete.useMutation();
    const createFolder = trpc.projects.createFolder.useMutation();

    /** tRPC mutation return objects are often new references each render; refs keep downstream useCallbacks stable. */
    const archiveChatMutRef = useRef(archiveChat);
    archiveChatMutRef.current = archiveChat;
    const restoreChatMutRef = useRef(restoreChat);
    restoreChatMutRef.current = restoreChat;
    const deleteChatMutRef = useRef(deleteChat);
    deleteChatMutRef.current = deleteChat;
    const moveChatMutRef = useRef(moveChat);
    moveChatMutRef.current = moveChat;
    const forkChatMutRef = useRef(forkChat);
    forkChatMutRef.current = forkChat;
    const deleteProjectMutRef = useRef(deleteProject);
    deleteProjectMutRef.current = deleteProject;
    const togglePinMutRef = useRef(togglePinChat);
    togglePinMutRef.current = togglePinChat;

    /**
     * Stable identity: avoids invalidating handleLoadMoreChats → CodebaseItem memo when folder pagination records change.
     * Intentional `[]` deps: only reads stable refs (`folderCursorByKeyRef`, `utilsRef`, `chatCountByFolderKeyRef`) and uses
     * state setters — re-creating each render would churn memo dependents; document here so exhaustive-deps stays quiet.
     */
    // eslint-disable-next-line react-hooks/exhaustive-deps -- refs + setters only; see comment above
    const fetchFolderPage = useCallback(async (folder: FolderDescriptor, reset: boolean) => {
      const folderKey = folder.key;
      setFolderLoadingByKey((prev) => ({ ...prev, [folderKey]: true }));
      try {
        const cursor = reset
          ? null
          : normalizeCursor(folderCursorByKeyRef.current[folderKey] ?? null);
        // Capture the count BEFORE the await: if a chat syncs and listCounts advances while this
        // fetch is in flight, the snapshot must stay behind the new count so the drift effect
        // re-fires — pinning it to the post-await count would equalize snapshot===count and
        // permanently disarm the self-heal (the synced row would stay missing until remount).
        const countAtFetchStart = chatCountByFolderKeyRef.current[folderKey];
        const result = await utilsRef.current.chats.listByFolder.fetch({
          projectIds: folder.projectIds,
          limit: PAGINATION.FOLDER_CHAT_PAGE_SIZE,
          cursor,
        });

        setFolderChatsByKey((prev) => {
          const existing = reset ? [] : (prev[folderKey] ?? []);
          return {
            ...prev,
            [folderKey]: mergeChatsById([...existing, ...result.chats]),
          };
        });
        setFolderHasMoreByKey((prev) => ({ ...prev, [folderKey]: result.hasMore }));
        setFolderCursorByKey((prev) => ({
          ...prev,
          [folderKey]: normalizeCursor((result.nextCursor as FolderCursor | null) ?? null),
        }));
        if (reset) {
          const snapshot = computeFolderSnapshot(
            countAtFetchStart,
            chatCountByFolderKeyRef.current[folderKey],
          );
          setFolderCountSnapshotByKey((prev) => ({ ...prev, [folderKey]: snapshot }));
        }
      } finally {
        setFolderLoadingByKey((prev) => ({ ...prev, [folderKey]: false }));
      }
    }, []);

    const fetchPinnedForFolder = useCallback(async (folder: FolderDescriptor) => {
      try {
        const result = await utilsRef.current.chats.listPinned.fetch({
          projectIds: folder.projectIds,
        });
        setPinnedChatsByKey((prev) => ({ ...prev, [folder.key]: result }));
      } catch (err) {
        // Display-only: avoid stale PINNED rows. Bulk delete / project delete use
        // `fetchAllChatsForFolder` which surfaces listPinned errors via CHAT_PIN_LIST_LOAD_ERROR.
        // biome-ignore lint/suspicious/noConsole: no renderer processLogger; log for support/debug.
        console.warn('[sidebar] listPinned failed for folder', folder.key, err);
        setPinnedChatsByKey((prev) => ({ ...prev, [folder.key]: [] }));
      }
    }, []);

    const showChatLoadErrorToast = useCallback((fallback: string, error: unknown) => {
      const now = Date.now();
      if (now - lastChatLoadToastAtRef.current < CHAT_LOAD_TOAST_COOLDOWN_MS) {
        return;
      }
      lastChatLoadToastAtRef.current = now;

      const detail = extractErrorMessage(error);
      toast.error(fallback, {
        id: SIDEBAR_CHAT_LOAD_TOAST_ID,
        description: detail && detail !== fallback ? detail : undefined,
      });
    }, []);

    // Load initial page for each folder with chats.
    useEffect(() => {
      const pending = folderDescriptors.filter((folder) => {
        const totalCount = chatCountByFolderKey[folder.key] ?? 0;
        if (totalCount === 0) return false;
        if (folderLoadingByKey[folder.key]) return false;
        return !(folder.key in folderChatsByKey);
      });

      if (pending.length === 0) return;

      void Promise.all(
        pending.map(async (folder) => {
          try {
            await Promise.all([fetchFolderPage(folder, true), fetchPinnedForFolder(folder)]);
          } catch (error) {
            showChatLoadErrorToast(`Failed to load chats for ${folder.key}`, error);
          }
        }),
      );
    }, [
      chatCountByFolderKey,
      fetchFolderPage,
      fetchPinnedForFolder,
      folderChatsByKey,
      folderDescriptors,
      folderLoadingByKey,
      showChatLoadErrorToast,
    ]);

    // Detect server count drift for already-loaded folders and refresh page 1.
    useEffect(() => {
      const driftedFolders = folderDescriptors.filter((folder) => {
        if (!(folder.key in folderChatsByKey)) return false;
        if (folderLoadingByKey[folder.key]) return false;
        const currentCount = chatCountByFolderKey[folder.key] ?? 0;
        const snapshotCount = folderCountSnapshotByKey[folder.key] ?? 0;
        return currentCount !== snapshotCount;
      });

      if (driftedFolders.length === 0) return;

      void Promise.all(
        driftedFolders.map(async (folder) => {
          try {
            await Promise.all([fetchFolderPage(folder, true), fetchPinnedForFolder(folder)]);
          } catch (error) {
            showChatLoadErrorToast(`Failed to refresh chats for ${folder.key}`, error);
          }
        }),
      );
    }, [
      chatCountByFolderKey,
      fetchFolderPage,
      fetchPinnedForFolder,
      folderChatsByKey,
      folderCountSnapshotByKey,
      folderDescriptors,
      folderLoadingByKey,
      showChatLoadErrorToast,
    ]);

    const handleLoadMoreChats = useCallback(
      async (folderKey: string) => {
        const folder = folderDescriptorMapRef.current.get(folderKey);
        if (!folder) return;
        if (!folderHasMoreByKeyRef.current[folderKey]) return;
        if (folderLoadingByKeyRef.current[folderKey]) return;
        const guard = folderLoadMoreSyncGuardRef.current;
        if (!guard.tryEnter(folderKey)) return;
        try {
          await fetchFolderPage(folder, false);
        } catch (error) {
          showChatLoadErrorToast('Failed to load older chats', error);
        } finally {
          guard.exit(folderKey);
        }
      },
      [fetchFolderPage, showChatLoadErrorToast],
    );

    const invalidateProjectLists = useCallback(async () => {
      const u = utilsRef.current;
      await u.projects.list.invalidate();
    }, []);

    // A gitless build's display name is set asynchronously by the chat auto-namer (main process);
    // refresh the project lists when it lands so the placeholder flips to the friendly title.
    useEffect(() => {
      const desktopApi = window.desktopApi;
      if (!desktopApi?.on) return;
      return desktopApi.on('projects:name-updated', (data) => {
        if (
          !data ||
          typeof data !== 'object' ||
          typeof (data as { projectId?: unknown }).projectId !== 'string'
        ) {
          return;
        }
        void invalidateProjectLists();
      });
    }, [invalidateProjectLists]);

    const invalidateChatsCaches = useCallback(async () => {
      const u = utilsRef.current;
      await Promise.all([
        u.chats.list.invalidate(),
        u.chats.listCounts.invalidate(),
        u.chats.listByFolder.invalidate(),
        u.chats.listPinned.invalidate(),
        u.chats.listBatchGroups.invalidate(),
        u.chats.listByBatch.invalidate(),
        u.chats.listArchived.invalidate(),
      ]);
    }, []);

    const refreshSidebarFolders = useCallback(async () => {
      resetFolderPaginationState();
      await invalidateChatsCaches();
    }, [invalidateChatsCaches, resetFolderPaginationState]);

    /** After a chat mutation, refresh the archived list + listCounts snapshots; on failure refresh folders (server already updated). */
    const syncSidebarCountsOrFullRefresh = useCallback(
      async (warningTitle: string) => {
        try {
          await utilsRef.current.chats.listArchived.invalidate();
          await refetchListCountsAndSyncFolderSnapshots(
            utilsRef.current,
            folderDescriptors,
            setFolderCountSnapshotByKey,
            SIDEBAR_GENERAL_COUNT_KEY,
          );
        } catch (refetchErr) {
          toast.warning(`${warningTitle}; refreshing sidebar`, {
            description:
              extractErrorMessage(refetchErr) ?? 'Could not sync chat counts. Reloading folders.',
          });
          await refreshSidebarFolders();
        }
      },
      [folderDescriptors, refreshSidebarFolders],
    );

    // ========== Drag-and-Drop ==========
    const handleMoveChat = useCallback(
      async (chatId: string, targetProjectId: string | null) => {
        const { agentChatStore, normalizeWorktreePath } =
          await import('../../agents/stores/agent-chat-store');

        // Destination workspace = the project root (null for General Chats). The mutation
        // re-syncs the chat's worktreePath to this; the pending target's expected worktreePath
        // MUST equal it or isDataFreshForChat never passes and the active view stays blank.
        const targetProjectPath = targetProjectId
          ? (transformedProjects.find((p) => p.id === targetProjectId)?.path ?? null)
          : null;

        // 1. Set pending move target BEFORE mutation
        // This prevents Chat creation with stale data during async refetch
        agentChatStore.setPendingMoveTarget(chatId, targetProjectId, targetProjectPath);

        // 2. Clear cached Chat instances
        agentChatStore.clearAllForChat(chatId);

        try {
          // 3. Perform the move mutation (updates DB)
          const updated = await moveChatMutRef.current.mutateAsync({
            chatId,
            projectId: targetProjectId,
            projectPath: targetProjectPath,
          });

          // 3a. Re-pin the pending target if the mutation auto-restored a worktree.
          // The pre-mutation set uses `targetProjectPath` as a best-effort placeholder; if
          // the resolver picked a different worktree from history, the freshness gate
          // (`isDataFreshForChat`) would otherwise reject the refetched row. No tRPC refetch
          // has fired yet (invalidations come next), so this re-pin is race-free.
          if (
            updated &&
            normalizeWorktreePath(updated.worktreePath) !== normalizeWorktreePath(targetProjectPath)
          ) {
            agentChatStore.setPendingMoveTarget(chatId, targetProjectId, updated.worktreePath);
          }

          // 4. Invalidate caches - triggers async refetch
          const u = utilsRef.current;
          const accountInvalidations: Promise<unknown>[] = [
            u.claudeCode.getResolvedAccount.invalidate({ chatId }),
          ];
          if (targetProjectId) {
            accountInvalidations.push(
              u.claudeCode.getResolvedAccount.invalidate({ projectId: targetProjectId }),
            );
          }

          if (!updated) {
            // Mutation reported no row affected; fall back to full refresh so the sidebar reflects
            // server state regardless of the local cache. Clear the pending target first, else the
            // stricter (non-null) freshness gate leaves the Chat permanently withheld (black screen).
            agentChatStore.clearPendingMoveTarget(chatId);
            await Promise.all([
              refreshSidebarFolders(),
              u.chats.get.invalidate({ id: chatId }),
              ...accountInvalidations,
            ]);
            await u.chats.getSubChatMessages.invalidate();
            return;
          }

          const toKey = resolveSidebarFolderKeyForProjectId(
            updated.projectId,
            transformedProjects,
            STRINGS.GENERAL_CHATS,
          );
          if (toKey === null) {
            // Orphan projectId (project not yet known to the sidebar) — fall back to full refresh.
            // Clear the pending target so the freshness gate doesn't strand the Chat (black screen).
            agentChatStore.clearPendingMoveTarget(chatId);
            await Promise.all([
              refreshSidebarFolders(),
              u.chats.get.invalidate({ id: chatId }),
              ...accountInvalidations,
            ]);
            await u.chats.getSubChatMessages.invalidate();
            return;
          }

          applyChatMoveToSidebarMaps(
            setFolderChatsByKey,
            setPinnedChatsByKey,
            chatId,
            toKey,
            updated.projectId,
            updated.worktreePath,
          );
          // Refresh consumers that the sidebar in-place patch does not cover.
          await Promise.all([
            u.chats.list.invalidate(),
            u.chats.get.invalidate({ id: chatId }),
            invalidateBatchViews(u),
            syncSidebarCountsOrFullRefresh('Chat moved'),
            ...accountInvalidations,
          ]);
          await u.chats.getSubChatMessages.invalidate();

          // Note: clearPendingMoveTarget is called from getOrCreateChat once data is fresh
        } catch (error) {
          // Clear pending state on error to prevent stale state
          agentChatStore.clearPendingMoveTarget(chatId);
          throw error;
        }
      },
      [refreshSidebarFolders, syncSidebarCountsOrFullRefresh, transformedProjects],
    );

    // ========== Dialog State ==========
    const [chatToRename, setChatToRename] = useState<{ id: string; name: string } | null>(null);
    // Project rename: the project sibling of chatToRename — same shared RenameDialog, different entity.
    const [projectToRename, setProjectToRename] = useState<{ id: string; name: string } | null>(
      null,
    );
    const [isNewFolderDialogOpen, setIsNewFolderDialogOpen] = useState(false);
    const [showArchived, setShowArchived] = useState(false);

    // Archive-mode toggle from the `toggle-archived` hotkey; the footer button flips the same state.
    useWindowEvent('sidebar:toggle-archived', () => setShowArchived((shown) => !shown));

    const emptyLabels: string[] = useMemo(() => [], []);
    const paneLabels = useMemo(() => {
      if (!isSplitActive) return emptyLabels;
      const chatMap = new Map(chats.map((c) => [c.id, c.name ?? STRINGS.UNTITLED_CHAT]));
      return chatIds.map((id) => {
        if (id === null) return 'Empty';
        if (id === NEW_CHAT_PANE) return STRINGS.NEW_CHAT;
        return chatMap.get(id) ?? STRINGS.UNTITLED_CHAT;
      });
    }, [isSplitActive, chatIds, chats, emptyLabels]);

    const handleNewChat = useCallback(() => {
      setSelectedChatId(null);
      setShowNewChatForm(true);
      if (isMobileFullscreen && onChatSelect) onChatSelect();
    }, [setSelectedChatId, setShowNewChatForm, isMobileFullscreen, onChatSelect]);

    const handleReplacePaneAt = useCallback(
      (index: number) => {
        newChatAtPane(index);
        if (isMobileFullscreen && onChatSelect) onChatSelect();
      },
      [newChatAtPane, isMobileFullscreen, onChatSelect],
    );

    const handleNewFolder = useCallback(
      async (name: string) => {
        await createFolder.mutateAsync({ name });
        await invalidateProjectLists();
      },
      [createFolder, invalidateProjectLists],
    );

    const handleChatSelect = useCallback(
      (chatId: string) => {
        if (isSplitActive) {
          // In split mode: route click to the active pane (or fill empty pane)
          fillActivePane(chatId);
        } else {
          setSelectedChatId(chatId);
        }
        if (isMobileFullscreen && onChatSelect) onChatSelect();
      },
      [setSelectedChatId, isMobileFullscreen, onChatSelect, isSplitActive, fillActivePane],
    );

    // In split view, selectedAgentChatIdAtom is stale (handleChatSelect uses fillActivePane
    // instead of setSelectedChatId). Derive the effective active chat from the split state.
    const effectiveSelectedChatId = isSplitActive
      ? (chatIds[activePaneIndex] ?? null)
      : selectedChatId;

    const handleFlows = useCallback(() => {
      setActiveOverlay('flows');
    }, [setActiveOverlay]);

    const handleWorkQueue = useCallback(() => {
      setActiveOverlay('workqueue');
    }, [setActiveOverlay]);

    /** Plugins is a Settings tab, not a destination of its own. */
    const handlePlugins = useCallback(() => openSettingsTab('integrations'), [openSettingsTab]);

    const handleToggleFilesSidebar = useCallback(
      () => setIsFilesSidebarOpen((isOpen) => !isOpen),
      [setIsFilesSidebarOpen],
    );

    const handleChatRename = useCallback((chat: { id: string; name: string | null }) => {
      setChatToRename({ id: chat.id, name: chat.name ?? STRINGS.UNTITLED_CHAT });
    }, []);

    const handleChatRenameConfirm = useCallback(
      async (newName: string) => {
        if (!chatToRename) return;
        const updated = await renameChat.mutateAsync({ id: chatToRename.id, name: newName });
        if (!updated) {
          // Mutation reported no row affected (auth/ownership mismatch); fall back to full refresh
          // so the sidebar reflects the server state regardless of the local cache.
          await refreshSidebarFolders();
          setChatToRename(null);
          return;
        }
        applyChatRenameToSidebarMaps(setFolderChatsByKey, setPinnedChatsByKey, updated.id, newName);
        // Also update the sub-chat store so active chat view updates
        const { useAgentSubChatStore } = await import('../../agents/stores/sub-chat-store');
        useAgentSubChatStore.getState().updateSubChatName(updated.id, newName);
        // Refresh name readers the sidebar doesn't drive (chats.get feeds the active chat title).
        const u = utilsRef.current;
        await Promise.all([
          u.chats.list.invalidate(),
          u.chats.get.invalidate({ id: updated.id }),
          invalidateBatchViews(u),
        ]);
        setChatToRename(null);
      },
      [chatToRename, refreshSidebarFolders, renameChat],
    );

    // Project rename — sibling of handleChatRename/Confirm above, but renames the PROJECT (not a
    // chat): name/path are decoupled so this changes only the display name; the folder is untouched.
    const handleProjectRename = useCallback((projectId: string, currentName: string) => {
      setProjectToRename({ id: projectId, name: currentName });
    }, []);

    const handleProjectRenameConfirm = useCallback(
      async (newName: string) => {
        if (!projectToRename) return;
        await renameProject.mutateAsync({ id: projectToRename.id, name: newName });
        await invalidateProjectLists();
        setProjectToRename(null);
      },
      [projectToRename, renameProject, invalidateProjectLists],
    );

    const handlePinChat = useCallback(
      async (chatId: string) => {
        if (togglePinInFlightRef.current) {
          return;
        }
        togglePinInFlightRef.current = true;
        try {
          const updated = await togglePinMutRef.current.mutateAsync({ id: chatId });
          if (!updated) {
            await refreshSidebarFolders();
            return;
          }
          const mappedKey = resolveSidebarFolderKeyForProjectId(
            updated.projectId,
            transformedProjects,
            STRINGS.GENERAL_CHATS,
          );
          if (mappedKey === null && updated.projectId != null) {
            await refreshSidebarFolders();
            return;
          }
          applyPinToggleToSidebarMaps(
            setFolderChatsByKey,
            setPinnedChatsByKey,
            updated,
            transformedProjects,
            STRINGS.GENERAL_CHATS,
          );
          await syncSidebarCountsOrFullRefresh('Pin updated');
        } catch (error) {
          toast.error(extractErrorMessage(error) ?? 'Failed to update pin');
        } finally {
          togglePinInFlightRef.current = false;
        }
      },
      [refreshSidebarFolders, syncSidebarCountsOrFullRefresh, transformedProjects],
    );

    const clearPanesForChat = useCallback(
      (chatId: string) => {
        if (!isSplitActive) return [];
        const cleared = splitViewChatIdsRef.current.flatMap((id, index) =>
          id === chatId ? [index] : [],
        );
        cleared.forEach((index) => clearPaneAt(index));
        return cleared;
      },
      [isSplitActive, clearPaneAt],
    );
    /** Stable inputs for useTaskAwareChatActions — inline .map() + inline invalidate forced new callbacks every render and defeated CodebaseItem memo. */
    const taskAwareActiveTasks = useMemo(
      () =>
        activeTasks.map((task) => ({
          id: task.id,
          linkedChatId: task.linkedChatId,
          status: task.status,
        })),
      [activeTasks],
    );
    const taskAwareChats = useMemo(
      () => transformedChats.map((chat) => ({ id: chat.id, taskId: chat.taskId })),
      [transformedChats],
    );
    const invalidateSidebarTrackedTasks = useCallback(async () => {
      const u = utilsRef.current;
      await Promise.all([u.tasks.listPaginated.invalidate(), u.tasks.listCounts.invalidate()]);
    }, []);

    const {
      getActiveLinkedTasksForChatIdsWithFallback,
      abortTaskChatStreamsBestEffort,
      cancelTasksBestEffort,
    } = useTaskAwareChatActions({
      activeTasks: taskAwareActiveTasks,
      chats: taskAwareChats,
      invalidateTasks: invalidateSidebarTrackedTasks,
    });

    /** Optimistically remove deleted chats from already-loaded folder + pinned maps. */
    const removeChatsFromLoadedFolders = useCallback(
      (chatIds: Iterable<string>) => {
        const ids = [...chatIds];
        removeChatIdsFromSidebarMaps(setFolderChatsByKey, setPinnedChatsByKey, ids);
      },
      // setState dispatchers are stable for the component lifetime.
      [],
    );

    const archiveSingleChat = useCallback(
      async (chatId: string, options?: { killTerminals?: boolean }) => {
        // Clear panes eagerly before async mutation to avoid stale splitView snapshot
        clearPanesForChat(chatId);
        await archiveChatMutRef.current.mutateAsync({
          id: chatId,
          ...(options?.killTerminals !== undefined ? { killTerminals: options.killTerminals } : {}),
        });
        removeChatsFromLoadedFolders([chatId]);
        // The local map patch above covers folder + pinned; batch views drop the chat on refetch.
        const u = utilsRef.current;
        await Promise.all([
          u.chats.list.invalidate(),
          invalidateBatchViews(u),
          syncSidebarCountsOrFullRefresh('Chat archived'),
        ]);
        setShowArchived(true);
        setSelectedChatId((current) => (current === chatId ? null : current));
        // Last: dropping per-chat atom state while a pane is still mounted on this id
        // would let its next render re-create the entry we just removed.
        cleanupChatScopedState(chatId);
      },
      [
        clearPanesForChat,
        removeChatsFromLoadedFolders,
        syncSidebarCountsOrFullRefresh,
        setSelectedChatId,
      ],
    );

    /**
     * Warns when a chat's task links can't be resolved, and hands off to the task-aware
     * confirm dialog when live tasks would be affected. Returns true when the dialog has
     * taken over, meaning the caller must not proceed with the destructive action.
     */
    const deferToTaskAwareDialog = useCallback(
      async (chatId: string, operation: 'archive' | 'delete'): Promise<boolean> => {
        const { activeTasks, unresolvedTaskLinks } =
          await getActiveLinkedTasksForChatIdsWithFallback([chatId]);
        const verb = operation === 'archive' ? 'Archiving' : 'Deleting';
        if (unresolvedTaskLinks > 0) {
          toast.warning('Linked task details unavailable', {
            description: `${verb} chat only. Open Work Queue to manage task state manually.`,
          });
        }
        if (activeTasks.length === 0) return false;
        setTaskAwareActionDialog({
          open: true,
          mode: 'single',
          operation,
          chatIds: [chatId],
          taskIds: activeTasks.map((task) => task.taskId),
          totalChats: 1,
        });
        return true;
      },
      [getActiveLinkedTasksForChatIdsWithFallback],
    );

    const handleChatArchive = useTaskAwareArchive(deferToTaskAwareDialog, archiveSingleChat);

    const deleteSingleChat = useCallback(
      async (chatId: string, checkActiveTasks = false) => {
        if (checkActiveTasks && (await deferToTaskAwareDialog(chatId, 'delete'))) return;
        const clearedPanes = clearPanesForChat(chatId);
        try {
          await deleteChatMutRef.current.mutateAsync({ id: chatId });
          removeChatsFromLoadedFolders([chatId]);
          // A stale batch row outlives its tasks and reads as a grey "cancelled" row.
          await Promise.all([
            invalidateBatchViews(utilsRef.current),
            syncSidebarCountsOrFullRefresh('Chat deleted'),
          ]);
          setSelectedChatId((current) => (current === chatId ? null : current));
          cleanupChatScopedState(chatId);
        } catch (error) {
          for (const paneIndex of clearedPanes) restorePaneAt(paneIndex, chatId);
          toast.error('Failed to delete chat', {
            description: extractErrorMessage(error) ?? 'Unable to delete this chat right now.',
          });
        }
      },
      [
        clearPanesForChat,
        deferToTaskAwareDialog,
        removeChatsFromLoadedFolders,
        restorePaneAt,
        setSelectedChatId,
        syncSidebarCountsOrFullRefresh,
      ],
    );

    const handleChatFork = useCallback(
      async (chatId: string) => {
        try {
          const forked = await forkChatMutRef.current.mutateAsync({ chatId });
          const row = forkMutationResultToSidebarItem(forked);
          const folderKey = resolveSidebarFolderKeyForProjectId(
            row.projectId,
            transformedProjects,
            STRINGS.GENERAL_CHATS,
          );
          if (folderKey === null && row.projectId != null) {
            await refreshSidebarFolders();
            setSelectedChatId(forked.id);
            return;
          }
          applyForkInsertToSidebarMaps(setFolderChatsByKey, folderKey, row);
          await syncSidebarCountsOrFullRefresh('Fork created');
          setSelectedChatId(forked.id);
        } catch (error) {
          toast.error('Failed to fork chat', {
            description: extractErrorMessage(error) ?? 'Unable to fork this chat right now.',
          });
        }
      },
      [
        refreshSidebarFolders,
        setSelectedChatId,
        syncSidebarCountsOrFullRefresh,
        transformedProjects,
      ],
    );

    const handleChatDelete = useCallback(
      async (chatId: string, chatName?: string | null) => {
        if (await askDelete.chat(chatName, treeContainerRef)) await deleteSingleChat(chatId, true);
      },
      [askDelete, deleteSingleChat],
    );
    // Chat-row action callbacks bundled into one prop so they thread through ProjectsTree as a single
    // value (not eight). Memoized on the stable handlers + capacity flag so ProjectsTree's memo holds.
    const chatActions = useMemo(
      () => ({
        onChatSelect: wrapWorkQueueExitAction(handleChatSelect),
        onChatRename: handleChatRename,
        onChatArchive: handleChatArchive,
        onChatFork: wrapWorkQueueExitAction(handleChatFork),
        onChatDelete: handleChatDelete,
        onChatPin: handlePinChat,
        onChatOpenInNewPane: wrapWorkQueueExitAction(openChatInNewPane),
        canOpenInNewPane,
      }),
      [
        handleChatSelect,
        handleChatRename,
        handleChatArchive,
        handleChatFork,
        handleChatDelete,
        handlePinChat,
        openChatInNewPane,
        canOpenInNewPane,
        wrapWorkQueueExitAction,
      ],
    );

    const handleChatRestore = useCallback(
      async (chatId: string) => {
        try {
          const restoredChat = await restoreChatMutRef.current.mutateAsync({ id: chatId });
          if (!restoredChat) {
            toast.error('Failed to restore chat', {
              description: 'Chat could not be restored. It may already be active.',
            });
            return;
          }
          const folderKey = resolveSidebarFolderKeyForProjectId(
            restoredChat.projectId,
            transformedProjects,
            STRINGS.GENERAL_CHATS,
          );
          if (folderKey === null) {
            // Orphan projectId — the folder key resolves off the project list, so that list must
            // refetch too, else the row has nothing to resolve against and never appears.
            await Promise.all([refreshSidebarFolders(), invalidateProjectLists()]);
          } else {
            applyChatRestoreToSidebarMaps(
              setFolderChatsByKey,
              setPinnedChatsByKey,
              folderKey,
              restoredChat,
            );
            const u = utilsRef.current;
            await Promise.all([
              u.chats.list.invalidate(),
              invalidateBatchViews(u),
              syncSidebarCountsOrFullRefresh('Chat restored'),
            ]);
          }
          setShowArchived(false);
          // Reveal the restored chat. Split view ignores selectedAgentChatIdAtom (see
          // effectiveSelectedChatId), so it needs a pane write instead — and the pane count must
          // come from the ref, since this handler awaits before it branches. Archive left the
          // chat's old pane empty and active, so fillActivePane returns it to that same pane.
          if (splitViewChatIdsRef.current.length >= 2) fillActivePane(restoredChat.id);
          else setSelectedChatId(restoredChat.id);
        } catch (error) {
          toast.error('Failed to restore chat', {
            description: extractErrorMessage(error) ?? 'Unable to restore this chat right now.',
          });
        }
      },
      [
        fillActivePane,
        invalidateProjectLists,
        refreshSidebarFolders,
        setSelectedChatId,
        syncSidebarCountsOrFullRefresh,
        transformedProjects,
      ],
    );

    useArchiveWindowEvents({
      // A split pane on the new-chat form holds a sentinel, not a chat.
      focusedChatId: effectiveSelectedChatId === NEW_CHAT_PANE ? null : effectiveSelectedChatId,
      isChatCovered: activeOverlay !== null,
      loadingChatIds,
      activeChats,
      deferToTaskAwareDialog,
      archiveSingleChat,
      restoreChat: handleChatRestore,
    });

    const bulk = useBulkChatActions({
      selection: chatSelection,
      utilsRef,
      invalidateBatchViews,
      loadedChats: chats,
      clearPanesForChat,
      restorePaneAt,
      removeChatsFromLoadedFolders,
      syncSidebarCountsOrFullRefresh,
      setSelectedChatId,
      setShowArchived,
      deleteMutRef: deleteChatMutRef,
      archiveMutRef: archiveChatMutRef,
      moveOne: handleMoveChat,
      getActiveLinkedTasks: getActiveLinkedTasksForChatIdsWithFallback,
      openTaskAwareDialog: setTaskAwareActionDialog,
    });
    const { deleteChatsBatch } = bulk;
    const {
      activeChat,
      overProjectId,
      handleDragStart,
      handleDragOver,
      handleDragEnd,
      handleDragCancel,
    } = useChatDnd({ onMoveChat: bulk.moveChats });
    const dndHandlers = useMemo(
      () => ({ handleDragStart, handleDragOver, handleDragEnd, handleDragCancel }),
      [handleDragStart, handleDragOver, handleDragEnd, handleDragCancel],
    );
    const { focusedItemId } = useSidebarNavigation(treeContainerRef, {
      onSelectChat: wrapWorkQueueExitAction(handleChatSelect),
      onToggleCodebase: toggleCodebase,
      isCodebaseExpanded,
      isDragging: !!activeChat,
      selectedChatId: effectiveSelectedChatId,
      onSelectionKey: (action) => {
        const ids = [...chatSelection.getSnapshot()];
        if (ids.length === 0) return false;
        if (action === 'clear') chatSelection.clear();
        else void bulk.requestDelete(ids);
        return true;
      },
    });

    const fetchAllChatsForFolder = useCallback(async (projectIds: string[] | null) => {
      const allChats: Array<{ id: string; projectId: string | null }> = [];
      let cursor: FolderCursor | null = null;
      let hasMore = true;

      while (hasMore) {
        const requestCursor = normalizeCursor(cursor);
        const page = await utilsRef.current.chats.listByFolder.fetch({
          projectIds,
          limit: PAGINATION.CHAT_FETCH_PAGE_SIZE,
          cursor: requestCursor,
        });
        allChats.push(...page.chats.map((chat) => ({ id: chat.id, projectId: chat.projectId })));
        hasMore = page.hasMore;
        cursor = normalizeCursor((page.nextCursor as FolderCursor | null) ?? null);
        if (page.chats.length === 0) break;
      }

      let pinned: Awaited<ReturnType<typeof utilsRef.current.chats.listPinned.fetch>>;
      try {
        pinned = await utilsRef.current.chats.listPinned.fetch({ projectIds });
      } catch (cause) {
        const e = new Error('Could not load pinned chat list. Try again.');
        (e as Error & { code: string; cause: unknown }).code = CHAT_PIN_LIST_LOAD_ERROR;
        (e as Error & { cause: unknown }).cause = cause;
        throw e;
      }
      const pinnedIds = new Set(pinned.map((c) => c.id));
      for (const chat of pinned) {
        if (!allChats.some((c) => c.id === chat.id)) {
          allChats.push({ id: chat.id, projectId: chat.projectId });
        }
      }

      return { allChats, pinnedIds };
    }, []);

    const handleProjectDelete = useCallback(
      async (projectId: string) => {
        const chatCount = chatCountByProjectRef.current.get(projectId) ?? 0;

        if (!(await askDelete.project(chatCount))) return;
        try {
          // Delete chats then the project; refuse while a linked task is still running.
          const { allChats: projectChats } = await fetchAllChatsForFolder([projectId]);
          const { activeTasks: linkedActiveTasks } =
            await getActiveLinkedTasksForChatIdsWithFallback(projectChats.map((chat) => chat.id));
          if (linkedActiveTasks.length > 0) {
            toast.error('Project has active task-linked chats', {
              description:
                'Cancel or finish linked tasks from Work Queue before deleting this project.',
            });
            return;
          }
          // Optimistic removal: we're committed to deleting now (guards passed), and the
          // backend delete + chat-batch + folder refresh below can take a moment. Drop the row
          // from every project-list cache immediately so the sidebar feels instant. The finally
          // block's invalidate re-fetches the truth — restoring the row if the delete throws.
          const u = utilsRef.current;
          const dropDeleted = <T extends { id: string }>(rows: T[] | undefined): T[] | undefined =>
            Array.isArray(rows) ? rows.filter((p) => p.id !== projectId) : rows;
          u.projects.list.setData(undefined, dropDeleted);

          await deleteChatsBatch(projectChats, { clearPanesBefore: true });
          await deleteProjectMutRef.current.mutateAsync({ id: projectId });
        } catch (err) {
          const message = err instanceof Error ? err.message : 'Failed to delete project';
          if (isChatPinListLoadError(err)) {
            toast.error('Could not load pinned chat list', { description: message });
            return;
          }
          toast.error('Failed to delete project', { description: message });
          return;
        } finally {
          // Full reset (not targeted) is required here: deleting a project removes a whole
          // folder plus N chats at once, so that folder's pagination snapshot is invalid and
          // refreshSidebarFolders resets it. The optimistic project-list removal above keeps
          // the UI instant; this re-fetches the truth.
          await invalidateProjectLists();
          await refreshSidebarFolders();
        }
      },
      [
        askDelete,
        deleteChatsBatch,
        fetchAllChatsForFolder,
        invalidateProjectLists,
        refreshSidebarFolders,
        getActiveLinkedTasksForChatIdsWithFallback,
      ],
    );

    const handleDeleteAllChatsInFolder = useCallback(
      async (folderKey: string) => {
        const projectIds = folderDescriptorMapRef.current.get(folderKey)?.projectIds;
        const chatCount = chatCountByFolderKeyRef.current[folderKey] ?? 0;

        if (chatCount === 0) {
          return;
        }

        let allChats: Array<{ id: string; projectId: string | null }>;
        let pinnedIds: ReadonlySet<string>;
        try {
          ({ allChats, pinnedIds } = await fetchAllChatsForFolder(projectIds ?? null));
        } catch (err) {
          const detail = err instanceof Error ? err.message : 'Failed to load chats';
          if (isChatPinListLoadError(err)) {
            toast.error('Could not load pinned chat list', { description: detail });
            return;
          }
          toast.error('Failed to load chats for folder', { description: detail });
          return;
        }

        const chatsToDelete = allChats.filter((c) => !pinnedIds.has(c.id));

        if (chatsToDelete.length === 0) {
          toast.info('No unpinned chats to delete in this folder. Pinned chats are kept.');
          return;
        }

        if (!(await askDelete.folderChats(chatsToDelete.length))) return;

        const chatIds = chatsToDelete.map((chat) => chat.id);
        const { activeTasks: linkedActiveTasks, unresolvedTaskLinks } =
          await getActiveLinkedTasksForChatIdsWithFallback(chatIds);

        if (unresolvedTaskLinks > 0) {
          toast.warning('Some linked task details were unavailable', {
            description: 'Batch delete continues. Manage unresolved tasks from Work Queue.',
          });
        }

        if (linkedActiveTasks.length > 0) {
          setTaskAwareActionDialog({
            open: true,
            mode: 'batch',
            operation: 'delete_batch',
            chatIds,
            taskIds: linkedActiveTasks.map((task) => task.taskId),
            totalChats: chatsToDelete.length,
          });
          return;
        }

        try {
          await deleteChatsBatch(chatsToDelete, {
            clearPanesBefore: true,
            onPartialFailure: toastPartialFailure('Deleted'),
          });
        } catch (err) {
          const detail = err instanceof Error ? err.message : 'Failed to delete chats';
          toast.error('Failed to delete chats in folder', { description: detail });
        }
      },
      [
        askDelete,
        deleteChatsBatch,
        fetchAllChatsForFolder,
        getActiveLinkedTasksForChatIdsWithFallback,
      ],
    );

    const handleDeleteBatch = useCallback(
      async (batchId: string, summary: SidebarBatchGroup) => {
        // Fetch all chats in the batch (fresh data for destructive action)
        let batchChats: Awaited<ReturnType<typeof utilsRef.current.chats.listByBatch.fetch>>;
        try {
          batchChats = await utilsRef.current.chats.listByBatch.fetch({ batchId });
        } catch (err) {
          const detail = err instanceof Error ? err.message : 'Failed to load chats';
          toast.error('Failed to load batch chats', { description: detail });
          return;
        }

        // Guard: empty batch
        if (!batchChats.length) {
          toast.info('No chats in this batch');
          return;
        }

        const chatIds = batchChats.map((c) => c.id);
        const { activeTasks: linkedActiveTasks, unresolvedTaskLinks } =
          await getActiveLinkedTasksForChatIdsWithFallback(chatIds);

        if (unresolvedTaskLinks > 0) {
          toast.warning('Some linked task details were unavailable', {
            description: 'Batch delete continues. Manage unresolved tasks from Work Queue.',
          });
        }

        if (linkedActiveTasks.length > 0) {
          setTaskAwareActionDialog({
            open: true,
            mode: 'batch',
            operation: 'delete_batch',
            chatIds,
            taskIds: linkedActiveTasks.map((task) => task.taskId),
            totalChats: batchChats.length,
          });
          return;
        }

        if (!(await askDelete.batch(batchChats.length, summary))) return;

        try {
          await deleteChatsBatch(
            batchChats.map((c) => ({ id: c.id })),
            {
              clearPanesBefore: true,
              onPartialFailure: toastPartialFailure('Deleted'),
            },
          );
        } catch (err) {
          const detail = err instanceof Error ? err.message : 'Failed to delete chats';
          toast.error('Failed to delete batch chats', { description: detail });
        }
      },
      [askDelete, deleteChatsBatch, getActiveLinkedTasksForChatIdsWithFallback],
    );

    const closeTaskAwareActionDialog = useCallback(() => {
      setTaskAwareActionDialog((current) => ({ ...current, open: false }));
    }, []);

    const executeTaskAwareAction = useCallback(
      async (cancelLinkedTasks: boolean) => {
        const currentDialog = taskAwareActionDialogRef.current;
        if (!currentDialog.open) return;

        closeTaskAwareActionDialog();

        const isDeleteOp =
          currentDialog.operation === 'delete' || currentDialog.operation === 'delete_batch';
        const shouldCancelTasks = isDeleteOp || cancelLinkedTasks;
        const keepsTasksRunning = currentDialog.taskIds.length > 0 && !shouldCancelTasks;

        if (shouldCancelTasks && currentDialog.taskIds.length > 0) {
          await abortTaskChatStreamsBestEffort(currentDialog.chatIds);
          const { failed } = await cancelTasksBestEffort(currentDialog.taskIds);
          if (failed > 0) {
            toast.warning('Some task cancellations failed', {
              description: `${failed} task${failed === 1 ? '' : 's'} could not be cancelled.`,
            });
          }
        }

        if (currentDialog.mode === 'single') {
          const chatId = currentDialog.chatIds[0];
          if (!chatId) return;

          if (currentDialog.operation === 'archive') {
            try {
              await archiveSingleChat(chatId, { killTerminals: !keepsTasksRunning });
            } catch (error) {
              toast.error('Failed to archive chat', {
                description: extractErrorMessage(error) ?? 'Unable to archive this chat right now.',
              });
            }
            return;
          }

          await deleteSingleChat(chatId);
          return;
        }

        if (currentDialog.operation === 'archive_batch') {
          await bulk.archiveChatsBatch(currentDialog.chatIds, !keepsTasksRunning);
          return;
        }
        const batchChats = currentDialog.chatIds.map((id) => ({ id }));
        await deleteChatsBatch(batchChats, {
          clearPanesBefore: true,
          onPartialFailure: toastPartialFailure('Deleted'),
        });
      },
      [
        closeTaskAwareActionDialog,
        abortTaskChatStreamsBestEffort,
        cancelTasksBestEffort,
        archiveSingleChat,
        deleteSingleChat,
        deleteChatsBatch,
        bulk.archiveChatsBatch,
      ],
    );

    // ========== Render ==========
    return (
      <InsetGlassSidebarShell
        edge="left"
        isMobileFullscreen={isMobileFullscreen}
        outerProps={{ 'data-unified-sidebar': '' }}
      >
        {/* Header - pt-8 for macOS traffic lights */}
        <SidebarHeader
          searchQuery={searchQuery}
          onSearchChange={setSearchQuery}
          searchInputRef={searchInputRef}
          showArchived={showArchived}
          onToggleSidebar={onToggleSidebar}
        />
        {/* Top nav — actions + flag-gated destinations as one borderless vertical list */}
        <SidebarNav
          onNewChat={wrapWorkQueueExitAction(handleNewChat)}
          onViewChats={exitForNavigation}
          onNewFolder={() => setIsNewFolderDialogOpen(true)}
          onAddSplitPane={wrapWorkQueueExitAction(addEmptyPane)}
          onAddNewChatPane={wrapWorkQueueExitAction(addNewChatPane)}
          onReplacePaneAt={wrapWorkQueueExitAction(handleReplacePaneAt)}
          paneChatIds={chatIds}
          paneLabels={paneLabels}
          activePaneIndex={activePaneIndex}
          isSplitActive={isSplitActive}
          canAddSplitPane={chatIds.length < MAX_PANES && !chatIds.includes(null)}
          hasEmptyPane={chatIds.includes(null)}
          onCycleLayout={wrapWorkQueueExitAction(cycleLayout)}
          onResetPaneSizes={wrapWorkQueueExitAction(resetPaneSizes)}
          onResetPaneZoom={wrapWorkQueueExitAction(resetPaneZoom)}
          onFlows={handleFlows}
          onPlugins={handlePlugins}
          onShowWorkQueue={handleWorkQueue}
          workQueueTriggerRef={workQueueTriggerRef}
          flowsTriggerRef={flowsTriggerRef}
          isWorkQueueActive={activeOverlay === 'workqueue'}
          isFlowsActive={isFlowsActive}
          inboxTaskCount={inboxTaskCount}
          pendingReviewCount={pendingReviewCount}
          runningTaskCount={runningTaskCount}
          needsAttentionTaskCount={needsAttentionTaskCount}
          failedTaskCount={failedTaskCount}
          activeTasksHasMore={activeTasksHasMore}
        />

        {/* Separator between the nav destinations (Flows / Work Queue) and the projects tree. */}
        <hr className="mx-3 mb-1 border-t border-border/60" />

        <ChatSelectionContext.Provider value={chatSelection}>
          {/* Scrollable tree container — receives focus from Cmd+; for keyboard nav */}
          <div
            ref={treeContainerRef}
            tabIndex={0}
            role="tree"
            aria-label="Sidebar navigation"
            aria-activedescendant={focusedItemId ? `sidebar-item-${focusedItemId}` : undefined}
            className="flex-1 overflow-y-auto outline-hidden"
          >
            {showArchived ? (
              <ArchivedChatsSection
                archivedChats={archivedChats}
                searchQuery={searchQuery}
                selectedChatId={selectedChatId}
                onChatSelect={wrapWorkQueueExitAction(handleChatSelect)}
                onChatRestore={wrapWorkQueueExitAction(handleChatRestore)}
                onChatDelete={(chatId) => deleteSingleChat(chatId, true)}
              />
            ) : (
              <ProjectsTree
                filteredCodebases={filteredCodebases}
                searchQuery={searchQuery}
                isSearchActive={searchQuery.trim().length > 0}
                isCodebaseExpanded={isCodebaseExpanded}
                toggleCodebase={toggleCodebase}
                selectedChatId={selectedChatId}
                chatActions={chatActions}
                onProjectDelete={handleProjectDelete}
                onRenameProject={handleProjectRename}
                onDeleteAllChatsInFolder={handleDeleteAllChatsInFolder}
                onDeleteBatch={handleDeleteBatch}
                chatPaneMap={chatPaneMap}
                activeDropTargetId={overProjectId}
                activeChat={activeChat}
                dndHandlers={dndHandlers}
                folderChatCountByKey={chatCountByFolderKey}
                folderHasMoreByKey={folderHasMoreByKey}
                folderLoadingByKey={folderLoadingByKey}
                onLoadMoreChats={handleLoadMoreChats}
                chatTaskStatusByChatId={chatTaskStatusByChatId}
                chatReasonByChatId={chatReasonByChatId}
                batchGroups={batchGroupsMap}
                pendingQuestionIds={pendingQuestionIds}
                activeChatsByFolder={activeChatsByFolder}
              />
            )}
          </div>

          <ChatSelectionChip
            onArchive={bulk.requestArchive}
            onDelete={bulk.requestDelete}
            pendingDeleteCount={bulk.pendingDeleteCount}
            onConfirmDelete={bulk.confirmDelete}
            onCancelDelete={bulk.cancelDelete}
          />
        </ChatSelectionContext.Provider>
        <SidebarFooter
          onSettings={openSettings}
          showArchived={showArchived}
          onToggleArchived={() => setShowArchived(!showArchived)}
          archivedChatsCount={archivedChats.length}
          showFilesButton={showFilesButton}
          isFilesSidebarOpen={isFilesSidebarOpen}
          onToggleFilesSidebar={wrapWorkQueueExitAction(handleToggleFilesSidebar)}
          hasModifiedFiles={hasModified}
        />

        {/* Dialogs */}
        <SidebarDialogs
          chatToRename={chatToRename}
          onChatRenameClose={() => setChatToRename(null)}
          onChatRenameConfirm={handleChatRenameConfirm}
          projectToRename={projectToRename}
          onProjectRenameClose={() => setProjectToRename(null)}
          onProjectRenameConfirm={handleProjectRenameConfirm}
          isNewFolderDialogOpen={isNewFolderDialogOpen}
          onNewFolderClose={() => setIsNewFolderDialogOpen(false)}
          onNewFolderConfirm={handleNewFolder}
          taskAwareActionDialog={taskAwareActionDialog}
          onTaskAwareActionKeepRunning={() => executeTaskAwareAction(false)}
          onTaskAwareActionCancelAndContinue={() => executeTaskAwareAction(true)}
          onTaskAwareActionClose={closeTaskAwareActionDialog}
        />
        {confirmDialog}
      </InsetGlassSidebarShell>
    );
  },
);

UnifiedSidebarInner.displayName = 'UnifiedSidebar';

export const UnifiedSidebar = memo(UnifiedSidebarInner, unifiedSidebarPropsAreEqual);
