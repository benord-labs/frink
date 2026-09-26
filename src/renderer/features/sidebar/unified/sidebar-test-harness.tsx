// @vitest-environment happy-dom
// biome-ignore-all lint/style/useNamingConvention: mirrors the mocked modules' exported names (components, MAX_PANES) and their prop shapes; biome exempts `*.test.tsx` for the same reason.
/* eslint-disable project-structure/folder-structure, project-structure/independent-modules -- shared test-only mock harness; structural walls exempt `*.{test,spec}.tsx` by intent, but this file cannot use that suffix without vitest collecting it as a suite. */
/**
 * Shared mock harness for the UnifiedSidebar suites: every `vi.mock` in them delegates here, so the
 * suite can span files without duplicating the mock wiring. IMPORTANT: never statically import app
 * code — the jotai mock factory imports this module, so a static import of anything reaching
 * `jotai` (e.g. `./UnifiedSidebar`) re-enters that in-flight factory. App modules load lazily in
 * `setupHarness()`, which runs in `beforeAll`. */
import { cleanup, render } from '@testing-library/react';
import { expect, vi } from 'vitest';
import type { ChatSelectionChipProps } from './components/ChatSelection';
import { makeSidebarComponentsMock } from './sidebar-components-test-harness';

type ActiveTaskStub = {
  id: string;
  status?: string | null;
  linkedChatId?: string | null;
};
/** Always empty in these suites; named so the mock hands back a contract rather than a dictionary. */
type LocalProjectStub = { id: string; name: string; path: string; gitRemoteUrl?: string | null };
type CursorStub = { createdAt: string; id: string } | null;
type ActiveTasksPageStub = {
  items: ActiveTaskStub[];
  hasMore: boolean;
  nextCursor: CursorStub;
};

const state = {
  taskCountsData: {
    pending: 0,
    running: 0,
    planReady: 0,
    done: 0,
    needsAttention: 0,
    failed: 0,
    interrupted: 0,
    total: 0,
  },
  activeTasksData: {
    items: [] as ActiveTaskStub[],
    hasMore: false,
    nextCursor: null as CursorStub,
  } as ActiveTasksPageStub,
  splitViewState: {
    splitView: { chatIds: [null], activePaneIndex: 0 },
    isSplitActive: false,
  } as {
    splitView: { chatIds: Array<string | null>; activePaneIndex: number };
    isSplitActive: boolean;
  },
  splitViewQuickActionsChrome: {
    layout: 'horizontal',
    hasNonDefaultPaneSizes: false,
    hasNonDefaultPaneZoom: false,
  },
  /** Stable identity, not an inline `[]`: this feeds handlePinChat → chatActions, so a fresh array
   *  per render would churn the row-action props and mask whether the code itself is stable. */
  localProjectsData: new Array<LocalProjectStub>(),
  persistedPendingPlanApprovals: [] as Array<{ subChatId: string; chatId: string }>,
  livePendingPlanApprovals: new Map<string, string>(),
};

/** Chat-row shape the chat mutations resolve with; per-mutation fixtures differ only by identity. */
const CHAT_BASE = {
  projectId: null,
  createdAt: new Date('2026-01-01'),
  updatedAt: new Date('2026-01-02'),
  archivedAt: null,
  worktreePath: null,
  branch: null,
  baseBranch: null,
  prUrl: null,
  prNumber: null,
  taskId: null,
};
const MOVED_CHAT = { ...CHAT_BASE, id: '00000000-0000-0000-0000-000000000099', name: 'Moved' };
const RENAMED_CHAT = { ...CHAT_BASE, id: '00000000-0000-0000-0000-000000000077', name: 'Renamed' };
const PINNED_CHAT = {
  ...CHAT_BASE,
  id: '00000000-0000-0000-0000-000000000001',
  name: 'Pinned',
  pinnedAt: new Date('2026-01-03'),
  batchId: null,
};

/** Mutable mock state shared by the mock factories, the reset block and the test bodies. */
type MoveChatHandler = (chatId: string, target: string | null, source: string | null) => void;

export const hoisted = {
  state,
  listCountsUseQueryMock: vi.fn(() => ({ data: state.taskCountsData })),
  listPaginatedUseQueryMock: vi.fn(() => ({ data: state.activeTasksData })),
  chatsListInvalidateMock: vi.fn(async () => undefined),
  chatsListCountsInvalidateMock: vi.fn(async () => undefined),
  chatsListCountsFetchMock: vi.fn(
    async () => [] as Array<{ projectId: string | null; count: number }>,
  ),
  chatsListByFolderInvalidateMock: vi.fn(async () => undefined),
  chatsListBatchGroupsInvalidateMock: vi.fn(async () => undefined),
  chatsListByBatchInvalidateMock: vi.fn(async () => undefined),
  chatsListPinnedInvalidateMock: vi.fn(async () => undefined),
  chatsGetInvalidateMock: vi.fn(async () => undefined),
  chatsGetSubChatMessagesInvalidateMock: vi.fn(async () => undefined),
  moveToProjectMutateAsyncMock: vi.fn(
    async (): Promise<Record<string, unknown> | null> => MOVED_CHAT,
  ),
  renameMutateAsyncMock: vi.fn(async (): Promise<Record<string, unknown> | null> => RENAMED_CHAT),
  restoreMutateAsyncMock: vi.fn(async (): Promise<Record<string, unknown> | null> => null),
  chatsListArchivedInvalidateMock: vi.fn(async () => undefined),
  setPendingMoveTargetMock: vi.fn(),
  clearPendingMoveTargetMock: vi.fn(),
  clearAllForChatMock: vi.fn(),
  updateSubChatNameMock: vi.fn(),
  // SAFETY: starts empty; the useChatDnd double stores the onMoveChat it was given.
  capturedOnMoveChat: null as null | MoveChatHandler,
  capturedProjectsTreeProps: null as null | Record<string, unknown>,
  capturedSidebarDialogsProps: null as null | Record<string, unknown>,
  // SAFETY: starts empty; the ChatSelectionChip double assigns the props it was rendered with.
  capturedChatSelectionChipProps: null as null | ChatSelectionChipProps,
  capturedArchivedChatsSectionProps: null as null | Record<string, unknown>,
  /** listArchived payload; `unknown` so a test can reproduce the tRPC hydration glitch. */
  archivedChatsData: [] as unknown,
  getActiveLinkedTasksForChatIdsWithFallbackMock: vi.fn(
    async (
      _chatIds: string[],
    ): Promise<{
      activeTasks: Array<{ taskId: string; chatId: string }>;
      unresolvedTaskLinks: number;
    }> => ({
      activeTasks: [],
      unresolvedTaskLinks: 0,
    }),
  ),
  listPaginatedClientQueryMock: vi.fn<(input?: unknown) => Promise<ActiveTasksPageStub>>(
    async () => ({
      items: [],
      hasMore: false,
      nextCursor: null,
    }),
  ),
  chatsListByBatchFetchMock: vi.fn(async (_input?: unknown) => [] as Array<{ id: string }>),
  chatDeleteMutateAsyncMock: vi.fn(async (_input: { id: string }) => ({})),
  archiveChatMutateAsyncMock: vi.fn(async () => ({})),
  projectsDeleteMutateAsyncMock: vi.fn(async () => ({})),
  forkChatMutateAsyncMock: vi.fn(async () => ({ id: 'forked-chat-id' })),
  togglePinMutateAsyncMock: vi.fn(async (): Promise<Record<string, unknown> | null> => ({})),
  listPinnedFetchMock: vi.fn(async () => [] as Array<{ id: string }>),
  /** Default: empty page; override per test for delete-all-in-folder. */
  chatsListByFolderFetchMock: vi.fn(
    async (_input?: unknown) =>
      ({ chats: [], hasMore: false, nextCursor: null }) as {
        chats: Array<{ id: string; projectId: string | null } & Record<string, unknown>>;
        hasMore: boolean;
        nextCursor: null;
      },
  ),
  /** Drives trpc.chats.listCounts useQuery in UnifiedSidebar (folder descriptors, general count). */
  chatsListCountsForSidebarData: [] as Array<{ projectId: string | null; count: number }>,
  chatsListCountsForSidebarQueryMock: vi.fn(() => ({
    data: hoisted.chatsListCountsForSidebarData,
  })),
  getPendingPlanApprovalsUseQueryMock: vi.fn(() => ({
    data: hoisted.state.persistedPendingPlanApprovals,
  })),
  fillActivePaneMock: vi.fn(),
  openChatInNewPaneMock: vi.fn(),
  toggleCodebaseMock: vi.fn(),
  dragStartMock: vi.fn(),
  dragOverMock: vi.fn(),
  dragEndMock: vi.fn(),
  dragCancelMock: vi.fn(),
  clearPaneAtMock: vi.fn(),
  restorePaneAtMock: vi.fn(),
  setSelectedChatIdMock: vi.fn(),
  projectsListInvalidateMock: vi.fn(),
  abortTaskChatStreamsBestEffortMock: vi.fn(async (_chatIds: string[]) => {}),
  cancelTasksBestEffortMock: vi.fn(async (_taskIds: string[]) => ({ failed: 0 })),
  capturedGroupedProjectsParams: null as null | Record<string, unknown>,
};

/** Real atom identities, resolved in `setupHarness` so the jotai mock can match on them. */
export const atomRefs = {
  splitViewChatIdsAtom: null as unknown,
  splitViewActivePaneIndexAtom: null as unknown,
  splitViewQuickActionsChromeAtom: null as unknown,
  pendingPlanApprovalsAtom: null as unknown,
};

export const makeJotaiMock = (actual: typeof import('jotai')) => ({
  ...actual,
  useAtom: () => [null, hoisted.setSelectedChatIdMock],
  useAtomValue: (a: unknown) => {
    if (a === atomRefs.splitViewChatIdsAtom) {
      return hoisted.state.splitViewState.splitView.chatIds;
    }
    if (a === atomRefs.splitViewActivePaneIndexAtom) {
      return hoisted.state.splitViewState.splitView.activePaneIndex;
    }
    if (a === atomRefs.splitViewQuickActionsChromeAtom) {
      return hoisted.state.splitViewQuickActionsChrome;
    }
    if (a === atomRefs.pendingPlanApprovalsAtom) {
      return hoisted.state.livePendingPlanApprovals;
    }
    return new Map();
  },
  useSetAtom: () => vi.fn(),
});

export const trpcMock = {
  trpc: {
    useUtils: () => ({
      chats: {
        list: { invalidate: hoisted.chatsListInvalidateMock },
        listCounts: {
          invalidate: hoisted.chatsListCountsInvalidateMock,
          fetch: hoisted.chatsListCountsFetchMock,
        },
        listByFolder: {
          invalidate: hoisted.chatsListByFolderInvalidateMock,
          fetch: (input?: unknown) => hoisted.chatsListByFolderFetchMock(input),
        },
        listBatchGroups: { invalidate: hoisted.chatsListBatchGroupsInvalidateMock },
        listByBatch: {
          invalidate: hoisted.chatsListByBatchInvalidateMock,
          fetch: (input?: unknown) => hoisted.chatsListByBatchFetchMock(input),
        },
        listPinned: {
          invalidate: hoisted.chatsListPinnedInvalidateMock,
          fetch: () => hoisted.listPinnedFetchMock(),
        },
        get: { invalidate: hoisted.chatsGetInvalidateMock },
        getSubChatMessages: { invalidate: hoisted.chatsGetSubChatMessagesInvalidateMock },
        listArchived: { invalidate: hoisted.chatsListArchivedInvalidateMock },
      },
      tasks: { listPaginated: { invalidate: vi.fn() }, listCounts: { invalidate: vi.fn() } },
      projects: {
        list: { invalidate: hoisted.projectsListInvalidateMock, setData: vi.fn() },
      },
      claudeCode: {
        getResolvedAccount: { invalidate: vi.fn(), fetch: vi.fn(async () => null) },
      },
    }),
    changes: {
      getStatus: { useQuery: () => ({ data: null }) },
    },
    projects: {
      list: { useQuery: () => ({ data: hoisted.state.localProjectsData }) },
      delete: { useMutation: () => ({ mutateAsync: hoisted.projectsDeleteMutateAsyncMock }) },
      rename: { useMutation: () => ({ mutateAsync: vi.fn(async () => ({})) }) },
      createFolder: { useMutation: () => ({ mutateAsync: vi.fn(async () => ({})) }) },
    },
    chats: {
      listCounts: { useQuery: hoisted.chatsListCountsForSidebarQueryMock },
      listActiveChats: { useQuery: () => ({ data: [] }) },
      getPendingPlanApprovals: { useQuery: hoisted.getPendingPlanApprovalsUseQueryMock },
      listArchived: { useQuery: () => ({ data: hoisted.archivedChatsData }) },
      listByFolder: { useQuery: () => ({ data: { chats: [], hasMore: false, nextCursor: null } }) },
      listBatchGroups: { useQuery: () => ({ data: [] }) },
      archive: { useMutation: () => ({ mutateAsync: hoisted.archiveChatMutateAsyncMock }) },
      restore: { useMutation: () => ({ mutateAsync: hoisted.restoreMutateAsyncMock }) },
      delete: { useMutation: () => ({ mutateAsync: hoisted.chatDeleteMutateAsyncMock }) },
      rename: { useMutation: () => ({ mutateAsync: hoisted.renameMutateAsyncMock }) },
      moveToProject: { useMutation: () => ({ mutateAsync: hoisted.moveToProjectMutateAsyncMock }) },
      fork: { useMutation: () => ({ mutateAsync: hoisted.forkChatMutateAsyncMock }) },
      togglePin: {
        useMutation: () => ({ isPending: false, mutateAsync: hoisted.togglePinMutateAsyncMock }),
      },
    },
    tasks: {
      listCounts: { useQuery: hoisted.listCountsUseQueryMock },
      listPaginated: { useQuery: hoisted.listPaginatedUseQueryMock },
    },
  },
  trpcClient: {
    tasks: { listPaginated: { query: hoisted.listPaginatedClientQueryMock } },
  },
};

export const agentChatStoreMock = {
  agentChatStore: {
    setPendingMoveTarget: hoisted.setPendingMoveTargetMock,
    clearAllForChat: hoisted.clearAllForChatMock,
    clearPendingMoveTarget: hoisted.clearPendingMoveTargetMock,
  },
  // Trivial normalizer; the re-pin compares the pending-target path to `updated.worktreePath`.
  normalizeWorktreePath: (p: string | null | undefined) => p ?? null,
};

export const subChatStoreMock = {
  useAgentSubChatStore: { getState: () => ({ updateSubChatName: hoisted.updateSubChatNameMock }) },
};

export const gitStatusMock = { hasModifiedFiles: () => false };
export const groupedProjectsMock = {
  useGroupedProjects: (params: Record<string, unknown>) => {
    hoisted.capturedGroupedProjectsParams = params;
    return [];
  },
};
export const sidebarNavigationMock = { useSidebarNavigation: () => ({ focusedItemId: null }) };

export const splitViewMock = {
  MAX_PANES: 4,
  canOpenChatInNewPane: () => true,
  useSplitViewActions: () => ({
    addEmptyPane: vi.fn(),
    addNewChatPane: vi.fn(),
    openChatInNewPane: hoisted.openChatInNewPaneMock,
    clearPaneAt: hoisted.clearPaneAtMock,
    restorePaneAt: hoisted.restorePaneAtMock,
    newChatAtPane: vi.fn(),
    fillActivePane: hoisted.fillActivePaneMock,
    cycleLayout: vi.fn(),
    resetPaneSizes: vi.fn(),
    resetPaneZoom: vi.fn(),
  }),
};

export const expansionStateMock = {
  useExpansionState: () => ({
    isCodebaseExpanded: () => true,
    toggleCodebase: hoisted.toggleCodebaseMock,
    collapseAll: vi.fn(),
  }),
};

export const chatDndMock = {
  useChatDnd: (params: {
    onMoveChat: (chatId: string, targetProjectId: string | null) => void;
  }) => {
    hoisted.capturedOnMoveChat = params.onMoveChat;
    return {
      activeChat: null,
      overProjectId: null,
      handleDragStart: hoisted.dragStartMock,
      handleDragOver: hoisted.dragOverMock,
      handleDragEnd: hoisted.dragEndMock,
      handleDragCancel: hoisted.dragCancelMock,
    };
  },
};

export const taskAwareChatActionsMock = {
  useTaskAwareChatActions: () => ({
    getActiveLinkedTasksForChatIds: () => ({ activeTasks: [], unresolvedTaskLinks: 0 }),
    getActiveLinkedTasksForChatIdsWithFallback:
      hoisted.getActiveLinkedTasksForChatIdsWithFallbackMock,
    abortTaskChatStreamsBestEffort: hoisted.abortTaskChatStreamsBestEffortMock,
    cancelTasksBestEffort: hoisted.cancelTasksBestEffortMock,
  }),
};

export const componentsMock = makeSidebarComponentsMock(hoisted);

let SidebarUnderTest: typeof import('./UnifiedSidebar').UnifiedSidebar | null = null;

/** `beforeAll` body: resolves the real atom identities and the component, after mocks settle. */
export async function setupHarness() {
  const atoms = await import('../../agents/atoms');
  atomRefs.splitViewChatIdsAtom = atoms.splitViewChatIdsAtom;
  atomRefs.splitViewActivePaneIndexAtom = atoms.splitViewActivePaneIndexAtom;
  atomRefs.splitViewQuickActionsChromeAtom = atoms.splitViewQuickActionsChromeAtom;
  atomRefs.pendingPlanApprovalsAtom = atoms.pendingPlanApprovalsAtom;
  SidebarUnderTest = (await import('./UnifiedSidebar')).UnifiedSidebar;
}

/** `afterEach` body: unmounts and returns every mock to its default. */
export function resetHarness() {
  cleanup();
  hoisted.listCountsUseQueryMock.mockClear();
  hoisted.listPaginatedUseQueryMock.mockClear();
  hoisted.listPaginatedClientQueryMock.mockClear();
  hoisted.chatsListInvalidateMock.mockClear();
  hoisted.chatsListCountsInvalidateMock.mockClear();
  hoisted.chatsListCountsFetchMock.mockClear();
  hoisted.chatsListCountsFetchMock.mockResolvedValue([]);
  hoisted.chatsListByFolderInvalidateMock.mockClear();
  hoisted.chatsListBatchGroupsInvalidateMock.mockClear();
  hoisted.chatsListByBatchInvalidateMock.mockClear();
  hoisted.clearPaneAtMock.mockClear();
  hoisted.restorePaneAtMock.mockClear();
  hoisted.chatsListPinnedInvalidateMock.mockClear();
  hoisted.chatsGetInvalidateMock.mockClear();
  hoisted.chatsGetSubChatMessagesInvalidateMock.mockClear();
  hoisted.moveToProjectMutateAsyncMock.mockReset();
  hoisted.moveToProjectMutateAsyncMock.mockResolvedValue(MOVED_CHAT);
  hoisted.renameMutateAsyncMock.mockReset();
  hoisted.renameMutateAsyncMock.mockResolvedValue(RENAMED_CHAT);
  hoisted.restoreMutateAsyncMock.mockReset();
  hoisted.restoreMutateAsyncMock.mockResolvedValue(null);
  hoisted.chatsListArchivedInvalidateMock.mockClear();
  hoisted.setPendingMoveTargetMock.mockClear();
  hoisted.clearPendingMoveTargetMock.mockClear();
  hoisted.clearAllForChatMock.mockClear();
  hoisted.updateSubChatNameMock.mockClear();
  hoisted.capturedOnMoveChat = null;
  hoisted.capturedProjectsTreeProps = null;
  hoisted.capturedSidebarDialogsProps = null;
  hoisted.capturedChatSelectionChipProps = null;
  hoisted.capturedArchivedChatsSectionProps = null;
  hoisted.archivedChatsData = [];
  hoisted.getActiveLinkedTasksForChatIdsWithFallbackMock.mockReset();
  hoisted.getActiveLinkedTasksForChatIdsWithFallbackMock.mockResolvedValue({
    activeTasks: [],
    unresolvedTaskLinks: 0,
  });
  hoisted.chatsListByBatchFetchMock.mockReset();
  hoisted.chatsListByBatchFetchMock.mockResolvedValue([]);
  hoisted.chatDeleteMutateAsyncMock.mockReset();
  hoisted.chatDeleteMutateAsyncMock.mockResolvedValue({});
  hoisted.archiveChatMutateAsyncMock.mockReset();
  hoisted.archiveChatMutateAsyncMock.mockResolvedValue({});
  hoisted.projectsDeleteMutateAsyncMock.mockReset();
  hoisted.projectsDeleteMutateAsyncMock.mockResolvedValue({});
  hoisted.forkChatMutateAsyncMock.mockReset();
  hoisted.forkChatMutateAsyncMock.mockResolvedValue({ id: 'forked-chat-id' });
  hoisted.togglePinMutateAsyncMock.mockReset();
  hoisted.togglePinMutateAsyncMock.mockResolvedValue(PINNED_CHAT);
  hoisted.listPinnedFetchMock.mockReset();
  hoisted.listPinnedFetchMock.mockResolvedValue([]);
  hoisted.chatsListByFolderFetchMock.mockReset();
  hoisted.chatsListByFolderFetchMock.mockResolvedValue({
    chats: [],
    hasMore: false,
    nextCursor: null,
  });
  hoisted.chatsListCountsForSidebarData = [];
  hoisted.chatsListCountsForSidebarQueryMock.mockClear();
  hoisted.getPendingPlanApprovalsUseQueryMock.mockClear();
  hoisted.fillActivePaneMock.mockReset();
  hoisted.openChatInNewPaneMock.mockClear();
  hoisted.toggleCodebaseMock.mockClear();
  hoisted.dragStartMock.mockClear();
  hoisted.dragOverMock.mockClear();
  hoisted.dragEndMock.mockClear();
  hoisted.dragCancelMock.mockClear();
  hoisted.setSelectedChatIdMock.mockClear();
  hoisted.projectsListInvalidateMock.mockClear();
  // mockReset, not mockClear: mockClear leaves an unconsumed mockResolvedValueOnce queued, which
  // would leak into the next test. The resolved value must then be restored, because UnifiedSidebar
  // destructures cancelTasksBestEffort's result and a bare reset resolves undefined.
  hoisted.abortTaskChatStreamsBestEffortMock.mockReset();
  hoisted.cancelTasksBestEffortMock.mockReset();
  hoisted.cancelTasksBestEffortMock.mockResolvedValue({ failed: 0 });
  hoisted.state.localProjectsData = [];
  hoisted.state.persistedPendingPlanApprovals = [];
  hoisted.state.livePendingPlanApprovals = new Map();
  hoisted.capturedGroupedProjectsParams = null;
  hoisted.state.splitViewState = {
    splitView: { chatIds: [null], activePaneIndex: 0 },
    isSplitActive: false,
  };
}

/** Asserts a chat mutation refetched the sidebar counts without broadly invalidating the chat lists. */
export function expectScopedCountsRefetch() {
  expect(hoisted.chatsListByFolderInvalidateMock).not.toHaveBeenCalled();
  expect(hoisted.chatsListPinnedInvalidateMock).not.toHaveBeenCalled();
  expect(hoisted.chatsListBatchGroupsInvalidateMock).not.toHaveBeenCalled();
  expect(hoisted.chatsListCountsInvalidateMock).toHaveBeenCalledTimes(1);
  expect(hoisted.chatsListCountsFetchMock).toHaveBeenCalledTimes(1);
}

/** Render the sidebar and return a chat-row callback captured off ProjectsTree's bundled `chatActions`. */
export function captureChatAction(
  key: 'onChatFork' | 'onChatPin' | 'onChatArchive' | 'onChatDelete',
): (chatId: string) => Promise<void> {
  if (!SidebarUnderTest) throw new Error('setupHarness() must run in beforeAll');
  render(<SidebarUnderTest />);
  const props = hoisted.capturedProjectsTreeProps as {
    chatActions?: Record<string, ((chatId: string) => Promise<void>) | undefined>;
  } | null;
  const fn = props?.chatActions?.[key];
  if (!fn) throw new Error(`${key} not found in ProjectsTree chatActions`);
  return fn;
}
