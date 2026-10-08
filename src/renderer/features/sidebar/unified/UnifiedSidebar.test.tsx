// @vitest-environment happy-dom
/* eslint-disable max-lines -- large mock-heavy suite; split tracked separately */
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { toast } from 'sonner';
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { answerConfirm } from '../../../lib/test-utils/sidebar-confirm';
import {
  captureChatAction,
  expectScopedCountsRefetch,
  hoisted,
  resetHarness,
  setupHarness,
} from './sidebar-test-harness';
import { UnifiedSidebar } from './UnifiedSidebar';

// Every mock delegates to the shared harness so this suite can be split across files.
vi.mock('jotai', async (importOriginal) =>
  (await import('./sidebar-test-harness')).makeJotaiMock(
    await importOriginal<typeof import('jotai')>(),
  ),
);
vi.mock('../../../lib/trpc', async () => (await import('./sidebar-test-harness')).trpcMock);
vi.mock(
  '../../agents/stores/agent-chat-store',
  async () => (await import('./sidebar-test-harness')).agentChatStoreMock,
);
vi.mock(
  '../../agents/stores/sub-chat-store',
  async () => (await import('./sidebar-test-harness')).subChatStoreMock,
);
vi.mock(
  '../../../lib/utils/git-status',
  async () => (await import('./sidebar-test-harness')).gitStatusMock,
);
vi.mock(
  '../../agents/hooks/use-split-view',
  async () => (await import('./sidebar-test-harness')).splitViewMock,
);
vi.mock(
  './hooks/use-expansion-state',
  async () => (await import('./sidebar-test-harness')).expansionStateMock,
);
vi.mock(
  './hooks/use-grouped-projects',
  async () => (await import('./sidebar-test-harness')).groupedProjectsMock,
);
vi.mock(
  './hooks/use-sidebar-navigation',
  async () => (await import('./sidebar-test-harness')).sidebarNavigationMock,
);
vi.mock('./hooks/use-chat-dnd', async () => (await import('./sidebar-test-harness')).chatDndMock);
vi.mock(
  './hooks/use-task-aware-chat-actions',
  async () => (await import('./sidebar-test-harness')).taskAwareChatActionsMock,
);
vi.mock('./components', async () => (await import('./sidebar-test-harness')).componentsMock);

beforeAll(setupHarness);
afterEach(resetHarness);

describe('UnifiedSidebar pending plan approvals', () => {
  it('unions immediate atom state with persisted results for currently loaded chats', async () => {
    hoisted.state.livePendingPlanApprovals = new Map([['live-sub-chat', 'chat-live']]);
    hoisted.state.persistedPendingPlanApprovals = [
      { subChatId: 'persisted-sub-chat', chatId: 'chat-persisted' },
    ];
    hoisted.chatsListCountsForSidebarData = [{ projectId: null, count: 1 }];
    hoisted.chatsListByFolderFetchMock.mockResolvedValue({
      chats: [
        {
          id: 'chat-persisted',
          name: 'Persisted plan',
          projectId: null,
          updatedAt: new Date('2026-01-02'),
          branch: null,
          pinnedAt: null,
          worktreePath: null,
          taskId: null,
          batchId: null,
        },
      ],
      hasMore: false,
      nextCursor: null,
    });

    render(<UnifiedSidebar />);

    await waitFor(() => {
      expect(hoisted.getPendingPlanApprovalsUseQueryMock).toHaveBeenCalledWith(
        { chatIds: ['chat-persisted'] },
        expect.objectContaining({ refetchInterval: 5_000 }),
      );
    });

    const pendingPlans = hoisted.capturedGroupedProjectsParams?.pendingPlans;
    expect(pendingPlans).toBeInstanceOf(Set);
    expect([...(pendingPlans as Set<string>)]).toEqual(
      expect.arrayContaining(['chat-live', 'chat-persisted']),
    );
  });
});

describe('UnifiedSidebar folder count-drift self-heal', () => {
  it('re-arms the drift refetch when the folder count advances while the first fetch is in flight', async () => {
    // Disarm-race repro: the header count goes 1 -> 2 (a second chat syncs) WHILE the initial
    // listByFolder fetch is still pending, and that fetch ends up returning only the first chat.
    // The snapshot must be pinned to the count as it was when the fetch STARTED (1), never the
    // count at resolve (2) — pinning to the resolve count makes snapshot === count and permanently
    // disarms the drift effect, stranding the second chat until remount. With the fix the snapshot
    // stays behind the new count so the drift effect re-fires a second fetch and both chats load.
    type FolderChat = { id: string; projectId: string | null; updatedAt: Date };
    type FolderPage = { chats: FolderChat[]; hasMore: boolean; nextCursor: null };
    const chatA: FolderChat = { id: 'chat-a', projectId: null, updatedAt: new Date('2026-01-02') };
    const chatB: FolderChat = { id: 'chat-b', projectId: null, updatedAt: new Date('2026-01-03') };
    hoisted.chatsListCountsForSidebarData = [{ projectId: null, count: 1 }];

    let resolveFirst!: (page: FolderPage) => void;
    const firstFetch = new Promise<FolderPage>((resolve) => {
      resolveFirst = resolve;
    });
    hoisted.chatsListByFolderFetchMock.mockReturnValueOnce(firstFetch).mockResolvedValue({
      chats: [chatA, chatB],
      hasMore: false,
      nextCursor: null,
    });

    const { rerender } = render(<UnifiedSidebar />);

    // Second chat synced: the polled count advances to 2 while fetch #1 is still pending.
    hoisted.chatsListCountsForSidebarData = [{ projectId: null, count: 2 }];
    rerender(<UnifiedSidebar onChatSelect={() => {}} />);

    // Fetch #1 resolves with only the first (lagging) row.
    await act(async () => {
      resolveFirst({ chats: [chatA], hasMore: false, nextCursor: null });
      await firstFetch;
    });

    // Drift re-arms: a SECOND listByFolder fetch fires because the snapshot stayed behind the count
    // (count 2 !== snapshot 1). Before the fix this stayed at a single call (snapshot pinned to 2).
    await waitFor(() => {
      expect(hoisted.chatsListByFolderFetchMock).toHaveBeenCalledTimes(2);
    });

    // ...and it converges — rows now match the count, so no unbounded refetch loop.
    await act(async () => {
      await Promise.resolve();
    });
    expect(hoisted.chatsListByFolderFetchMock).toHaveBeenCalledTimes(2);
  });
});

describe('UnifiedSidebar task count freshness', () => {
  it('updates footer task badges from listCounts while Work Queue stays closed', () => {
    hoisted.state.taskCountsData = {
      pending: 1,
      planReady: 2,
      done: 0,
      running: 3,
      needsAttention: 0,
      failed: 0,
      interrupted: 0,
      total: 6,
    };
    hoisted.state.activeTasksData = { items: [{ id: 'task-1' }], hasMore: false, nextCursor: null };

    const { rerender } = render(<UnifiedSidebar />);
    expect(screen.getByTestId('sidebar-dialogs').textContent).toBe('closed');
    expect(screen.getByTestId('sidebar-nav-counts').textContent).toBe('1:2:3:0:0:none');

    hoisted.state.taskCountsData = {
      pending: 4,
      planReady: 0,
      done: 0,
      running: 1,
      needsAttention: 2,
      failed: 0,
      interrupted: 0,
      total: 5,
    };
    hoisted.state.activeTasksData = {
      items: [{ id: 'task-2' }, { id: 'task-3' }],
      hasMore: false,
      nextCursor: null,
    };
    // Pass a new onChatSelect reference to bypass React.memo's equality check
    rerender(<UnifiedSidebar onChatSelect={() => {}} />);

    expect(screen.getByTestId('sidebar-dialogs').textContent).toBe('closed');
    expect(screen.getByTestId('sidebar-nav-counts').textContent).toBe('4:0:1:2:0:none');
    expect(hoisted.listCountsUseQueryMock).toHaveBeenCalled();
    expect(hoisted.listPaginatedUseQueryMock).toHaveBeenCalled();
  });

  // Interrupted runs fold into the Needs Attention bucket, so they must contribute to the sidebar's
  // needs-attention count (position 4) — else a restart-interrupted flow lights no alert outside the
  // Work Queue.
  it('counts interrupted runs in the needs-attention indicator', () => {
    hoisted.state.taskCountsData = {
      pending: 0,
      planReady: 0,
      done: 0,
      running: 0,
      needsAttention: 1,
      failed: 0,
      interrupted: 2,
      total: 3,
    };
    render(<UnifiedSidebar />);
    // position 4 = needsAttentionTaskCount = needsAttention(1) + interrupted(2) = 3
    expect(screen.getByTestId('sidebar-nav-counts').textContent).toBe('0:0:0:3:0:none');
  });

  it('surfaces hasMore in footer when active-task page reports additional pages', async () => {
    hoisted.state.taskCountsData = {
      pending: 0,
      planReady: 1,
      done: 0,
      running: 1,
      needsAttention: 0,
      failed: 0,
      interrupted: 0,
      total: 2,
    };
    hoisted.state.activeTasksData = {
      items: [{ id: 'task-1' }],
      hasMore: true,
      nextCursor: null,
    };

    render(<UnifiedSidebar />);

    await waitFor(() => {
      expect(screen.getByTestId('sidebar-nav-counts').textContent).toBe('0:1:1:0:0:more');
    });
  });

  it('keeps hasMore true when pagination loop detects repeated cursor', async () => {
    hoisted.state.taskCountsData = {
      pending: 0,
      planReady: 1,
      done: 0,
      running: 1,
      needsAttention: 1,
      failed: 0,
      interrupted: 0,
      total: 2,
    };
    hoisted.state.activeTasksData = {
      items: [{ id: 'task-1' }],
      hasMore: true,
      nextCursor: { createdAt: '2026-03-09T09:00:00.000Z', id: 'cursor-1' },
    };
    hoisted.listPaginatedClientQueryMock.mockResolvedValueOnce({
      items: [{ id: 'task-2' }],
      hasMore: true,
      nextCursor: { createdAt: '2026-03-09T09:00:00.000Z', id: 'cursor-1' },
    });

    render(<UnifiedSidebar />);

    await waitFor(() => {
      expect(hoisted.listPaginatedClientQueryMock).toHaveBeenCalledTimes(1);
      expect(screen.getByTestId('sidebar-nav-counts').textContent).toBe('0:1:1:1:0:more');
    });
  });

  it('falls back to first-page hasMore when follow-up page fetch fails', async () => {
    hoisted.state.taskCountsData = {
      pending: 0,
      planReady: 1,
      done: 0,
      running: 1,
      needsAttention: 0,
      failed: 0,
      interrupted: 0,
      total: 2,
    };
    hoisted.state.activeTasksData = {
      items: [{ id: 'task-1' }],
      hasMore: false,
      nextCursor: { createdAt: '2026-03-09T09:00:00.000Z', id: 'cursor-1' },
    };
    hoisted.listPaginatedClientQueryMock.mockRejectedValueOnce(new Error('network-fail'));

    render(<UnifiedSidebar />);

    await waitFor(() => {
      expect(hoisted.listPaginatedClientQueryMock).toHaveBeenCalledTimes(1);
      expect(screen.getByTestId('sidebar-nav-counts').textContent).toBe('0:1:1:0:0:none');
    });
  });

  it('uses highest-priority task status per chat for sidebar row state', async () => {
    hoisted.state.taskCountsData = {
      pending: 1,
      planReady: 1,
      done: 0,
      running: 1,
      needsAttention: 1,
      failed: 1,
      interrupted: 0,
      total: 5,
    };
    hoisted.state.activeTasksData = {
      items: [
        { id: 'task-1', status: 'pending', linkedChatId: 'chat-priority' },
        { id: 'task-2', status: 'running', linkedChatId: 'chat-priority' },
        { id: 'task-3', status: 'plan_ready', linkedChatId: 'chat-priority' },
        { id: 'task-4', status: 'failed', linkedChatId: 'chat-priority' },
        { id: 'task-5', status: 'needs_attention', linkedChatId: 'chat-priority' },
      ],
      hasMore: false,
      nextCursor: null,
    };

    render(<UnifiedSidebar />);

    await waitFor(() => {
      const props = hoisted.capturedProjectsTreeProps as {
        chatTaskStatusByChatId?: Map<string, string>;
      } | null;
      expect(props).toBeTruthy();
      expect(props?.chatTaskStatusByChatId?.get('chat-priority')).toBe('needs_attention');
    });
  });
});

describe('UnifiedSidebar move-chat parity', () => {
  it('executes move flow for project-to-general transitions', async () => {
    render(<UnifiedSidebar />);
    expect(hoisted.capturedOnMoveChat).toBeTypeOf('function');
    const capturedOnMoveChat = hoisted.capturedOnMoveChat;
    if (!capturedOnMoveChat) {
      throw new Error('Expected hoisted.capturedOnMoveChat to be defined');
    }

    await capturedOnMoveChat('chat-1', null, 'project-source');

    expect(hoisted.setPendingMoveTargetMock).toHaveBeenCalledWith('chat-1', null, null);
    expect(hoisted.clearAllForChatMock).toHaveBeenCalledWith('chat-1');
    expect(hoisted.moveToProjectMutateAsyncMock).toHaveBeenCalledWith({
      chatId: 'chat-1',
      projectId: null,
      projectPath: null,
    });
    // sc-701: in-place patch path — counts sync via listCounts; broad chats.list +
    // listByBatch / listBatchGroups (BatchGroup) are invalidated for downstream consumers,
    // but listByFolder / listPinned (sidebar's own queries) are NOT invalidated (no remount).
    expect(hoisted.chatsListInvalidateMock).toHaveBeenCalledTimes(1);
    expect(hoisted.chatsListByFolderInvalidateMock).not.toHaveBeenCalled();
    expect(hoisted.chatsListPinnedInvalidateMock).not.toHaveBeenCalled();
    expect(hoisted.chatsListBatchGroupsInvalidateMock).toHaveBeenCalledTimes(1);
    expect(hoisted.chatsListCountsInvalidateMock).toHaveBeenCalledTimes(1);
    expect(hoisted.chatsListCountsFetchMock).toHaveBeenCalledTimes(1);
    expect(hoisted.chatsGetInvalidateMock).toHaveBeenCalledWith({ id: 'chat-1' });
    expect(hoisted.chatsGetSubChatMessagesInvalidateMock).toHaveBeenCalledTimes(1);
  });

  it('executes move flow for general-to-project transitions', async () => {
    render(<UnifiedSidebar />);
    expect(hoisted.capturedOnMoveChat).toBeTypeOf('function');
    const capturedOnMoveChat = hoisted.capturedOnMoveChat;
    if (!capturedOnMoveChat) {
      throw new Error('Expected hoisted.capturedOnMoveChat to be defined');
    }

    await capturedOnMoveChat('chat-2', 'project-2', 'project-source');

    expect(hoisted.setPendingMoveTargetMock).toHaveBeenCalledWith('chat-2', 'project-2', null);
    expect(hoisted.moveToProjectMutateAsyncMock).toHaveBeenCalledWith({
      chatId: 'chat-2',
      projectId: 'project-2',
      projectPath: null,
    });
  });

  it('resolves the destination project path and threads it to the mutation + pending target', async () => {
    // Core of the move-chat fix: the renderer must resolve the target project's path and pass it
    // as both the mutation `projectPath` AND the pending-move target's expected worktreePath —
    // otherwise the freshness gate (isDataFreshForChat) never passes and the view stays blank.
    hoisted.state.localProjectsData = [
      { id: 'project-2', name: 'Beta', path: '/proj/beta', gitRemoteUrl: null },
    ];
    render(<UnifiedSidebar />);
    const capturedOnMoveChat = hoisted.capturedOnMoveChat;
    if (!capturedOnMoveChat) throw new Error('Expected capturedOnMoveChat to be defined');

    await capturedOnMoveChat('chat-7', 'project-2', 'project-source');

    expect(hoisted.setPendingMoveTargetMock).toHaveBeenCalledWith(
      'chat-7',
      'project-2',
      '/proj/beta',
    );
    expect(hoisted.moveToProjectMutateAsyncMock).toHaveBeenCalledWith({
      chatId: 'chat-7',
      projectId: 'project-2',
      projectPath: '/proj/beta',
    });
  });

  it('uses in-place patch behaviour when split view is active', async () => {
    hoisted.state.splitViewState = {
      splitView: { chatIds: ['chat-1', 'chat-2'], activePaneIndex: 0 },
      isSplitActive: true,
    };
    render(<UnifiedSidebar />);
    expect(hoisted.capturedOnMoveChat).toBeTypeOf('function');
    const capturedOnMoveChat = hoisted.capturedOnMoveChat;
    if (!capturedOnMoveChat) {
      throw new Error('Expected hoisted.capturedOnMoveChat to be defined');
    }

    await capturedOnMoveChat('chat-2', 'project-2', 'project-source');

    // In-place patch path (mutation default returns projectId: null, which resolves to General):
    // chats.list + chats.listBatchGroups (BatchGroup) refreshed; sidebar's own
    // listByFolder / listPinned untouched.
    expect(hoisted.chatsListInvalidateMock).toHaveBeenCalledTimes(1);
    expect(hoisted.chatsListByFolderInvalidateMock).not.toHaveBeenCalled();
    expect(hoisted.chatsListPinnedInvalidateMock).not.toHaveBeenCalled();
    expect(hoisted.chatsListBatchGroupsInvalidateMock).toHaveBeenCalledTimes(1);
    expect(hoisted.chatsListCountsInvalidateMock).toHaveBeenCalledTimes(1);
    expect(hoisted.chatsListCountsFetchMock).toHaveBeenCalledTimes(1);
    expect(hoisted.chatsGetSubChatMessagesInvalidateMock).toHaveBeenCalledTimes(1);
  });

  it('falls back to full refresh when moveToProject returns null', async () => {
    hoisted.moveToProjectMutateAsyncMock.mockResolvedValueOnce(null);
    render(<UnifiedSidebar />);
    const capturedOnMoveChat = hoisted.capturedOnMoveChat;
    if (!capturedOnMoveChat) throw new Error('Expected capturedOnMoveChat to be defined');

    await capturedOnMoveChat('chat-null', 'project-x', 'project-source');

    // Failed move must clear the pending target, else the stricter (non-null) freshness gate
    // strands the Chat instance and the active view stays blank.
    expect(hoisted.clearPendingMoveTargetMock).toHaveBeenCalledWith('chat-null');
    // sc-701: null mutation result triggers refreshSidebarFolders() → broad invalidates.
    expect(hoisted.chatsListInvalidateMock).toHaveBeenCalledTimes(1);
    expect(hoisted.chatsListByFolderInvalidateMock).toHaveBeenCalledTimes(1);
    expect(hoisted.chatsListPinnedInvalidateMock).toHaveBeenCalledTimes(1);
    expect(hoisted.chatsListBatchGroupsInvalidateMock).toHaveBeenCalledTimes(1);
    expect(hoisted.chatsListCountsInvalidateMock).toHaveBeenCalledTimes(1);
    expect(hoisted.chatsListCountsFetchMock).not.toHaveBeenCalled();
  });

  it('falls back to full refresh when projectId resolves to an unknown (orphan) project', async () => {
    // No projects in transformedProjects; mutation returns a non-null projectId that does not
    // map to any folder key. Expected: full refresh fallback.
    hoisted.moveToProjectMutateAsyncMock.mockResolvedValueOnce({
      id: '00000000-0000-0000-0000-000000000099',
      name: 'Moved',
      projectId: 'orphan-project-xyz',
      createdAt: new Date('2026-01-01'),
      updatedAt: new Date('2026-01-02'),
      archivedAt: null,
      worktreePath: null,
      branch: null,
      baseBranch: null,
      prUrl: null,
      prNumber: null,
      taskId: null,
    });
    render(<UnifiedSidebar />);
    const capturedOnMoveChat = hoisted.capturedOnMoveChat;
    if (!capturedOnMoveChat) throw new Error('Expected capturedOnMoveChat to be defined');

    await capturedOnMoveChat('chat-orphan', 'orphan-project-xyz', 'project-source');

    // Orphan projectId also clears the pending target so the freshness gate doesn't strand the Chat.
    expect(hoisted.clearPendingMoveTargetMock).toHaveBeenCalledWith('chat-orphan');
    expect(hoisted.chatsListInvalidateMock).toHaveBeenCalledTimes(1);
    expect(hoisted.chatsListByFolderInvalidateMock).toHaveBeenCalledTimes(1);
    expect(hoisted.chatsListPinnedInvalidateMock).toHaveBeenCalledTimes(1);
    expect(hoisted.chatsListBatchGroupsInvalidateMock).toHaveBeenCalledTimes(1);
    // Orphan path skips the count-sync fetch (the listByFolder/list invalidate already wipes
    // pagination).
    expect(hoisted.chatsListCountsFetchMock).not.toHaveBeenCalled();
  });

  it('warns and full-refreshes when move succeeds but listCounts refetch fails', async () => {
    const toastWarningSpy = vi.spyOn(toast, 'warning').mockReturnValue('toast-id');
    hoisted.chatsListCountsFetchMock.mockRejectedValueOnce(new Error('counts sync failed'));
    render(<UnifiedSidebar />);
    const capturedOnMoveChat = hoisted.capturedOnMoveChat;
    if (!capturedOnMoveChat) throw new Error('Expected capturedOnMoveChat to be defined');

    await capturedOnMoveChat('chat-counts-fail', null, 'project-source');

    expect(toastWarningSpy).toHaveBeenCalledWith(
      'Chat moved; refreshing sidebar',
      expect.objectContaining({
        description: expect.stringContaining('counts sync failed'),
      }),
    );
    expect(hoisted.chatsListInvalidateMock).toHaveBeenCalled();
    toastWarningSpy.mockRestore();
  });

  it('supports rapid sequential moves for same chat (A->B->C)', async () => {
    render(<UnifiedSidebar />);
    expect(hoisted.capturedOnMoveChat).toBeTypeOf('function');
    const capturedOnMoveChat = hoisted.capturedOnMoveChat;
    if (!capturedOnMoveChat) {
      throw new Error('Expected hoisted.capturedOnMoveChat to be defined');
    }
    await capturedOnMoveChat('chat-9', 'project-b', 'project-source');
    await capturedOnMoveChat('chat-9', 'project-c', 'project-source');

    expect(hoisted.moveToProjectMutateAsyncMock).toHaveBeenNthCalledWith(1, {
      chatId: 'chat-9',
      projectId: 'project-b',
      projectPath: null,
    });
    expect(hoisted.moveToProjectMutateAsyncMock).toHaveBeenNthCalledWith(2, {
      chatId: 'chat-9',
      projectId: 'project-c',
      projectPath: null,
    });
  });

  it('re-pins the pending target when the mutation auto-restores a different worktreePath', async () => {
    // Worktree-history auto-restore: mutation returns a worktreePath that differs from the
    // placeholder (the project root the renderer sent). The renderer must re-pin so the
    // freshness gate matches the refetched row — otherwise the active view stays blank.
    hoisted.state.localProjectsData = [
      { id: 'project-a', name: 'Alpha', path: '/proj/a', gitRemoteUrl: null },
    ];
    hoisted.moveToProjectMutateAsyncMock.mockResolvedValueOnce({
      id: 'chat-restore',
      name: null,
      projectId: 'project-a',
      createdAt: new Date('2026-01-01'),
      updatedAt: new Date('2026-01-02'),
      archivedAt: null,
      worktreePath: '/wt/feat-x', // restored — NOT '/proj/a' (the placeholder)
      branch: 'feat-x',
      baseBranch: 'main',
      prUrl: null,
      prNumber: null,
      taskId: null,
    });

    render(<UnifiedSidebar />);
    const capturedOnMoveChat = hoisted.capturedOnMoveChat;
    if (!capturedOnMoveChat) throw new Error('Expected capturedOnMoveChat to be defined');

    await capturedOnMoveChat('chat-restore', 'project-a', 'project-source');

    // First call = pre-mutation placeholder (project root).
    expect(hoisted.setPendingMoveTargetMock).toHaveBeenNthCalledWith(
      1,
      'chat-restore',
      'project-a',
      '/proj/a',
    );
    // Second call = post-mutation re-pin with the restored worktree path.
    expect(hoisted.setPendingMoveTargetMock).toHaveBeenNthCalledWith(
      2,
      'chat-restore',
      'project-a',
      '/wt/feat-x',
    );
  });

  it('does NOT re-pin when the mutation returns the placeholder worktreePath (no restore)', async () => {
    // Normal move: mutation lands the chat at the project root the renderer already pinned.
    // No re-pin should fire — extra setPendingMoveTarget churn is wasted work.
    hoisted.state.localProjectsData = [
      { id: 'project-a', name: 'Alpha', path: '/proj/a', gitRemoteUrl: null },
    ];
    hoisted.moveToProjectMutateAsyncMock.mockResolvedValueOnce({
      id: 'chat-norm',
      name: null,
      projectId: 'project-a',
      createdAt: new Date('2026-01-01'),
      updatedAt: new Date('2026-01-02'),
      archivedAt: null,
      worktreePath: '/proj/a', // matches placeholder
      branch: null,
      baseBranch: null,
      prUrl: null,
      prNumber: null,
      taskId: null,
    });

    render(<UnifiedSidebar />);
    const capturedOnMoveChat = hoisted.capturedOnMoveChat;
    if (!capturedOnMoveChat) throw new Error('Expected capturedOnMoveChat to be defined');

    await capturedOnMoveChat('chat-norm', 'project-a', 'project-source');

    // Exactly one setPendingMoveTarget call (the pre-mutation placeholder).
    expect(hoisted.setPendingMoveTargetMock).toHaveBeenCalledTimes(1);
    expect(hoisted.setPendingMoveTargetMock).toHaveBeenCalledWith(
      'chat-norm',
      'project-a',
      '/proj/a',
    );
  });
});

describe('UnifiedSidebar handleDeleteBatch', () => {
  type SidebarBatchGroup = {
    batch_id: string;
    flow_name: string;
    run_count: number;
    completed_count: number;
    failed_count: number;
    running_count: number;
    first_run_at: string | null;
    last_activity_at: string | null;
  };

  function makeBatchSummary(overrides: Partial<SidebarBatchGroup> = {}): SidebarBatchGroup {
    return {
      batch_id: 'batch-uuid-001',
      flow_name: 'Test Flow',
      run_count: 5,
      completed_count: 5,
      failed_count: 0,
      running_count: 0,
      first_run_at: '2026-04-01T10:00:00.000Z',
      last_activity_at: '2026-04-08T12:00:00.000Z',
      ...overrides,
    };
  }

  function getOnDeleteBatch() {
    render(<UnifiedSidebar />);
    const props = hoisted.capturedProjectsTreeProps as {
      onDeleteBatch?: (batchId: string, summary: SidebarBatchGroup) => Promise<void>;
    } | null;
    if (!props?.onDeleteBatch) throw new Error('onDeleteBatch not found in ProjectsTree props');
    return props.onDeleteBatch;
  }

  it('passes onDeleteBatch to ProjectsTree', () => {
    render(<UnifiedSidebar />);
    const props = hoisted.capturedProjectsTreeProps as { onDeleteBatch?: unknown } | null;
    expect(typeof props?.onDeleteBatch).toBe('function');
  });

  it('names the running flow runs in its one confirm and deletes nothing on cancel', async () => {
    hoisted.chatsListByBatchFetchMock.mockResolvedValueOnce([{ id: 'chat-1' }]);
    const onDeleteBatch = getOnDeleteBatch();
    const asked = await answerConfirm(
      () => onDeleteBatch('batch-uuid-001', makeBatchSummary({ running_count: 2 })),
      'cancel',
    );
    expect(asked).toContain('2 running flow runs will be stopped');
    expect(hoisted.chatDeleteMutateAsyncMock).not.toHaveBeenCalled();
  });

  it('uses singular wording for one chat and one running run', async () => {
    hoisted.chatsListByBatchFetchMock.mockResolvedValueOnce([{ id: 'chat-1' }]);
    const onDeleteBatch = getOnDeleteBatch();
    const asked = await answerConfirm(
      () => onDeleteBatch('batch-uuid-001', makeBatchSummary({ running_count: 1 })),
      'cancel',
    );
    expect(asked).toContain('Delete all 1 chat from batch "Test Flow"?');
    expect(asked).toContain('1 running flow run will be stopped');
  });

  it('asks once for a batch with running runs, then deletes on confirm', async () => {
    hoisted.chatsListByBatchFetchMock.mockResolvedValueOnce([{ id: 'chat-1' }, { id: 'chat-2' }]);
    const onDeleteBatch = getOnDeleteBatch();
    await answerConfirm(
      () => onDeleteBatch('batch-uuid-001', makeBatchSummary({ running_count: 1 })),
      'confirm',
    );
    // A second prompt would still be open here, and the deletes would not have run.
    expect(screen.queryByRole('alertdialog')).toBeNull();
    expect(hoisted.chatsListByBatchFetchMock).toHaveBeenCalledWith({ batchId: 'batch-uuid-001' });
    expect(hoisted.chatDeleteMutateAsyncMock).toHaveBeenCalledTimes(2);
  });

  it('shows a toast and returns early when listByBatch fetch fails', async () => {
    hoisted.chatsListByBatchFetchMock.mockRejectedValueOnce(new Error('network error'));
    const onDeleteBatch = getOnDeleteBatch();
    await onDeleteBatch('batch-uuid-001', makeBatchSummary());
    // No confirmation dialog should appear — handler returned early
    expect(hoisted.chatDeleteMutateAsyncMock).not.toHaveBeenCalled();
  });

  it('returns early when batch has no chats (empty batch guard)', async () => {
    hoisted.chatsListByBatchFetchMock.mockResolvedValueOnce([]);
    const onDeleteBatch = getOnDeleteBatch();
    await onDeleteBatch('batch-uuid-001', makeBatchSummary());
    expect(hoisted.chatDeleteMutateAsyncMock).not.toHaveBeenCalled();
  });

  it('calls delete for each chat when user confirms non-task-linked batch', async () => {
    hoisted.chatsListByBatchFetchMock.mockResolvedValueOnce([{ id: 'chat-a' }, { id: 'chat-b' }]);
    const onDeleteBatch = getOnDeleteBatch();
    const asked = await answerConfirm(
      () => onDeleteBatch('batch-uuid-001', makeBatchSummary()),
      'confirm',
    );
    expect(asked).toContain('Delete all 2 chats from batch "Test Flow"?');
    expect(hoisted.chatDeleteMutateAsyncMock).toHaveBeenCalledTimes(2);
    expect(hoisted.chatDeleteMutateAsyncMock).toHaveBeenCalledWith({ id: 'chat-a' });
    expect(hoisted.chatDeleteMutateAsyncMock).toHaveBeenCalledWith({ id: 'chat-b' });
    expect(hoisted.chatsListByBatchInvalidateMock).toHaveBeenCalled();
    expect(hoisted.chatsListBatchGroupsInvalidateMock).toHaveBeenCalled();
    vi.unstubAllGlobals();
  });

  it('aborts deletion when user cancels the confirmation dialog', async () => {
    hoisted.chatsListByBatchFetchMock.mockResolvedValueOnce([{ id: 'chat-a' }]);
    const onDeleteBatch = getOnDeleteBatch();
    await answerConfirm(() => onDeleteBatch('batch-uuid-001', makeBatchSummary()), 'cancel');
    expect(hoisted.chatDeleteMutateAsyncMock).not.toHaveBeenCalled();
    vi.unstubAllGlobals();
  });

  it('invokes delete once per chat returned by listByBatch (no silent cap in handler)', async () => {
    const many = Array.from({ length: 101 }, (_, i) => ({ id: `chat-${i}` }));
    hoisted.chatsListByBatchFetchMock.mockResolvedValueOnce(many);
    const onDeleteBatch = getOnDeleteBatch();
    await answerConfirm(() => onDeleteBatch('batch-uuid-001', makeBatchSummary()), 'confirm');
    expect(hoisted.chatDeleteMutateAsyncMock).toHaveBeenCalledTimes(101);
    vi.unstubAllGlobals();
  });

  it('shows partial-failure toast when some chat deletes fail', async () => {
    const toastErrorSpy = vi.spyOn(toast, 'error').mockReturnValue('toast-id');
    hoisted.chatsListByBatchFetchMock.mockResolvedValueOnce([{ id: 'ok' }, { id: 'bad' }]);
    hoisted.chatDeleteMutateAsyncMock
      .mockResolvedValueOnce({})
      .mockRejectedValueOnce(new Error('not found'));
    const onDeleteBatch = getOnDeleteBatch();
    await answerConfirm(() => onDeleteBatch('batch-uuid-001', makeBatchSummary()), 'confirm');
    expect(toastErrorSpy).toHaveBeenCalledWith(
      expect.stringMatching(/Deleted 1 of 2 chats\. 1 failed — try again\./),
    );
    toastErrorSpy.mockRestore();
    vi.unstubAllGlobals();
  });

  it('shows warning toast when unresolved task links cannot be fully resolved (batch delete continues)', async () => {
    hoisted.chatsListByBatchFetchMock.mockResolvedValueOnce([{ id: 'chat-unresolved' }]);
    hoisted.getActiveLinkedTasksForChatIdsWithFallbackMock.mockImplementation(
      async (chatIds: string[]) => {
        if (chatIds.length === 1 && chatIds[0] === 'chat-unresolved') {
          return { activeTasks: [], unresolvedTaskLinks: 2 };
        }
        return { activeTasks: [], unresolvedTaskLinks: 0 };
      },
    );
    const toastWarnSpy = vi.spyOn(toast, 'warning').mockReturnValue('toast-id');
    const onDeleteBatch = getOnDeleteBatch();
    await answerConfirm(() => onDeleteBatch('batch-uuid-001', makeBatchSummary()), 'confirm');
    expect(toastWarnSpy).toHaveBeenCalledWith(
      'Some linked task details were unavailable',
      expect.objectContaining({
        description: 'Batch delete continues. Manage unresolved tasks from Work Queue.',
      }),
    );
    expect(hoisted.chatDeleteMutateAsyncMock).toHaveBeenCalledWith({ id: 'chat-unresolved' });
    toastWarnSpy.mockRestore();
    vi.unstubAllGlobals();
  });

  it('opens task-aware dialog instead of confirm+delete when batch has linked active tasks', async () => {
    hoisted.chatsListByBatchFetchMock.mockResolvedValueOnce([{ id: 'chat-x' }]);
    // Do not use mockResolvedValueOnce: other code paths may call the fallback before batch delete.
    hoisted.getActiveLinkedTasksForChatIdsWithFallbackMock.mockImplementation(
      async (chatIds: string[]) => {
        if (chatIds.length === 1 && chatIds[0] === 'chat-x') {
          return {
            activeTasks: [{ taskId: 'task-99', chatId: 'chat-x' }],
            unresolvedTaskLinks: 0,
          };
        }
        return { activeTasks: [], unresolvedTaskLinks: 0 };
      },
    );
    const onDeleteBatch = getOnDeleteBatch();
    await onDeleteBatch('batch-uuid-001', makeBatchSummary());
    expect(screen.queryByRole('alertdialog')).toBeNull();
    expect(hoisted.chatDeleteMutateAsyncMock).not.toHaveBeenCalled();
    await waitFor(() => {
      const dialogProps = hoisted.capturedSidebarDialogsProps as {
        taskAwareActionDialog?: { open: boolean };
      } | null;
      expect(dialogProps?.taskAwareActionDialog?.open).toBe(true);
    });
    const dialogProps = hoisted.capturedSidebarDialogsProps as {
      taskAwareActionDialog?: {
        open: boolean;
        mode: string;
        operation: string;
        chatIds: string[];
        taskIds: string[];
        totalChats: number;
      };
    } | null;
    expect(dialogProps?.taskAwareActionDialog?.mode).toBe('batch');
    expect(dialogProps?.taskAwareActionDialog?.operation).toBe('delete_batch');
    expect(dialogProps?.taskAwareActionDialog?.chatIds).toEqual(['chat-x']);
    expect(dialogProps?.taskAwareActionDialog?.taskIds).toEqual(['task-99']);
    expect(dialogProps?.taskAwareActionDialog?.totalChats).toBe(1);
    vi.unstubAllGlobals();
  });
});

describe('UnifiedSidebar handleChatFork', () => {
  function getOnChatFork() {
    return captureChatAction('onChatFork');
  }

  it('passes onChatFork to ProjectsTree', () => {
    expect(typeof getOnChatFork()).toBe('function');
  });

  it('calls fork mutation with chatId on success path', async () => {
    const onChatFork = getOnChatFork();
    await onChatFork('chat-to-fork');
    expect(hoisted.forkChatMutateAsyncMock).toHaveBeenCalledWith({ chatId: 'chat-to-fork' });
  });

  it('refetches list counts after successful fork without broad chat list invalidation', async () => {
    const onChatFork = getOnChatFork();
    await onChatFork('chat-to-fork');
    expect(hoisted.chatsListInvalidateMock).not.toHaveBeenCalled();
    expectScopedCountsRefetch();
  });

  it('shows error toast when fork mutation fails', async () => {
    const toastErrorSpy = vi.spyOn(toast, 'error').mockReturnValue('toast-id');
    hoisted.forkChatMutateAsyncMock.mockRejectedValueOnce(new Error('not found'));
    const onChatFork = getOnChatFork();
    await onChatFork('missing-chat');
    expect(toastErrorSpy).toHaveBeenCalledWith(
      'Failed to fork chat',
      expect.objectContaining({
        description: expect.stringContaining('not found'),
      }),
    );
    expect(hoisted.chatsListInvalidateMock).not.toHaveBeenCalled();
    toastErrorSpy.mockRestore();
  });

  it('shows error toast with fallback message when error has no message', async () => {
    const toastErrorSpy = vi.spyOn(toast, 'error').mockReturnValue('toast-id');
    hoisted.forkChatMutateAsyncMock.mockRejectedValueOnce({});
    const onChatFork = getOnChatFork();
    await onChatFork('bad-chat');
    expect(toastErrorSpy).toHaveBeenCalledWith(
      'Failed to fork chat',
      expect.objectContaining({
        description: 'Unable to fork this chat right now.',
      }),
    );
    toastErrorSpy.mockRestore();
  });

  it('completes full success flow: mutation → listCounts refetch (no early return)', async () => {
    hoisted.forkChatMutateAsyncMock.mockResolvedValueOnce({ id: 'new-fork-123' });
    const onChatFork = getOnChatFork();
    await onChatFork('chat-abc');
    expect(hoisted.forkChatMutateAsyncMock).toHaveBeenCalledTimes(1);
    expect(hoisted.chatsListInvalidateMock).not.toHaveBeenCalled();
    expect(hoisted.chatsListCountsInvalidateMock).toHaveBeenCalledTimes(1);
    expect(hoisted.chatsListCountsFetchMock).toHaveBeenCalledTimes(1);
  });

  it('does not route forked chat to active pane in split-view (uses setSelectedChatId directly)', async () => {
    // BUG: handleChatFork calls setSelectedChatId instead of fillActivePane in split-view.
    // handleChatSelect checks isSplitActive and calls fillActivePane, but handleChatFork bypasses it.
    // This test documents the current (broken) behavior so the fix can be validated.
    hoisted.state.splitViewState = {
      splitView: { chatIds: ['chat-pane-1', 'chat-pane-2'], activePaneIndex: 1 },
      isSplitActive: true,
    };
    hoisted.forkChatMutateAsyncMock.mockResolvedValueOnce({ id: 'forked-split' });

    const onChatFork = getOnChatFork();
    await onChatFork('chat-pane-1');

    expect(hoisted.forkChatMutateAsyncMock).toHaveBeenCalledWith({ chatId: 'chat-pane-1' });
    // fillActivePane should have been called but isn't — fork bypasses split-view routing
    expect(hoisted.fillActivePaneMock).not.toHaveBeenCalled();
  });

  it('does not guard against rapid double-fork (no in-flight check)', async () => {
    // Two rapid fork calls both go through — no mutex or loading guard.
    // This test documents the behavior so a future guard can be validated.
    let resolveFirst!: () => void;
    const firstDone = new Promise<{ id: string }>((res) => {
      resolveFirst = () => res({ id: 'fork-1' });
    });
    hoisted.forkChatMutateAsyncMock.mockReturnValueOnce(firstDone);
    hoisted.forkChatMutateAsyncMock.mockResolvedValueOnce({ id: 'fork-2' });

    const onChatFork = getOnChatFork();
    const first = onChatFork('chat-rapid');
    const second = onChatFork('chat-rapid');

    resolveFirst();
    await Promise.all([first, second]);

    // The mutation is called twice — this documents the existing behavior
    // so a future guard (e.g. loading state check) can be validated against this count
    expect(hoisted.forkChatMutateAsyncMock).toHaveBeenCalledTimes(2);
  });

  it('warns and full-refreshes sidebar when fork succeeds but listCounts refetch fails', async () => {
    const toastWarningSpy = vi.spyOn(toast, 'warning').mockReturnValue('toast-id');
    hoisted.forkChatMutateAsyncMock.mockResolvedValueOnce({ id: 'fork-ok' });
    hoisted.chatsListCountsFetchMock.mockRejectedValueOnce(new Error('counts refetch failed'));

    const onChatFork = getOnChatFork();
    await onChatFork('chat-cache-fail');

    expect(hoisted.forkChatMutateAsyncMock).toHaveBeenCalledTimes(1);
    expect(toastWarningSpy).toHaveBeenCalledWith(
      'Fork created; refreshing sidebar',
      expect.objectContaining({
        description: expect.stringContaining('counts refetch failed'),
      }),
    );
    expect(hoisted.chatsListInvalidateMock).toHaveBeenCalled();
    toastWarningSpy.mockRestore();
  });
});

describe('UnifiedSidebar pin chat', () => {
  function getOnChatPin() {
    return captureChatAction('onChatPin');
  }

  it('passes onChatPin to ProjectsTree', () => {
    expect(typeof getOnChatPin()).toBe('function');
  });

  it('calls togglePin mutation with the chat id', async () => {
    const onChatPin = getOnChatPin();
    await onChatPin('chat-pin-1');
    expect(hoisted.togglePinMutateAsyncMock).toHaveBeenCalledWith({ id: 'chat-pin-1' });
  });

  it('refetches list counts after pin without invalidating listByFolder', async () => {
    const onChatPin = getOnChatPin();
    await onChatPin('chat-pin-2');
    expectScopedCountsRefetch();
  });

  it('warns and full-refreshes when pin succeeds but listCounts refetch fails', async () => {
    const toastWarningSpy = vi.spyOn(toast, 'warning').mockReturnValue('toast-id');
    hoisted.chatsListCountsFetchMock.mockRejectedValueOnce(new Error('counts sync failed'));
    const onChatPin = getOnChatPin();
    await onChatPin('chat-pin-refetch-fail');
    expect(toastWarningSpy).toHaveBeenCalledWith(
      'Pin updated; refreshing sidebar',
      expect.objectContaining({
        description: expect.stringContaining('counts sync failed'),
      }),
    );
    expect(hoisted.chatsListInvalidateMock).toHaveBeenCalled();
    toastWarningSpy.mockRestore();
  });

  it('falls back to full refresh when togglePin returns null', async () => {
    hoisted.togglePinMutateAsyncMock.mockResolvedValueOnce(null);
    const onChatPin = getOnChatPin();
    await onChatPin('chat-pin-null');
    expect(hoisted.togglePinMutateAsyncMock).toHaveBeenCalledWith({ id: 'chat-pin-null' });
    expect(hoisted.chatsListInvalidateMock).toHaveBeenCalledTimes(1);
    expect(hoisted.chatsListByFolderInvalidateMock).toHaveBeenCalledTimes(1);
    expect(hoisted.chatsListPinnedInvalidateMock).toHaveBeenCalledTimes(1);
    expect(hoisted.chatsListBatchGroupsInvalidateMock).toHaveBeenCalledTimes(1);
    expect(hoisted.chatsListCountsInvalidateMock).toHaveBeenCalledTimes(1);
    expect(hoisted.chatsListCountsFetchMock).not.toHaveBeenCalled();
  });

  it('shows error toast when togglePin mutation fails', async () => {
    const toastErrorSpy = vi.spyOn(toast, 'error').mockReturnValue('toast-id');
    hoisted.togglePinMutateAsyncMock.mockRejectedValueOnce(new Error('network error'));
    const onChatPin = getOnChatPin();
    await onChatPin('chat-pin-fail');
    expect(toastErrorSpy).toHaveBeenCalled();
    expect(hoisted.chatsListByFolderInvalidateMock).not.toHaveBeenCalled();
    toastErrorSpy.mockRestore();
  });

  it('does not invoke second pin mutation while first is in flight (rapid double-tap guard)', async () => {
    let resolveFirst!: () => void;
    const pinRow = {
      id: 'chat-race',
      name: 'x',
      projectId: null,
      createdAt: new Date('2026-01-01'),
      updatedAt: new Date('2026-01-02'),
      archivedAt: null,
      pinnedAt: new Date('2026-01-03'),
      worktreePath: null,
      branch: null,
      baseBranch: null,
      prUrl: null,
      prNumber: null,
      taskId: null,
      batchId: null,
    };
    const firstDone = new Promise<typeof pinRow>((res) => {
      resolveFirst = () => res(pinRow);
    });
    hoisted.togglePinMutateAsyncMock.mockReturnValueOnce(firstDone);

    const onChatPin = getOnChatPin();
    const first = onChatPin('chat-race');
    const second = onChatPin('chat-race');

    resolveFirst();
    await Promise.all([first, second]);
    expect(hoisted.togglePinMutateAsyncMock).toHaveBeenCalledTimes(1);
  });

  it('does not start a second pin for a different chatId while the first is in flight', async () => {
    let resolveFirst!: () => void;
    const pinRow = {
      id: 'chat-a',
      name: 'x',
      projectId: null,
      createdAt: new Date('2026-01-01'),
      updatedAt: new Date('2026-01-02'),
      archivedAt: null,
      pinnedAt: new Date('2026-01-03'),
      worktreePath: null,
      branch: null,
      baseBranch: null,
      prUrl: null,
      prNumber: null,
      taskId: null,
      batchId: null,
    };
    const firstDone = new Promise<typeof pinRow>((res) => {
      resolveFirst = () => res(pinRow);
    });
    hoisted.togglePinMutateAsyncMock.mockReturnValueOnce(firstDone);

    const onChatPin = getOnChatPin();
    const first = onChatPin('chat-a');
    const second = onChatPin('chat-b');

    resolveFirst();
    await Promise.all([first, second]);

    expect(hoisted.togglePinMutateAsyncMock).toHaveBeenCalledTimes(1);
    expect(hoisted.togglePinMutateAsyncMock).toHaveBeenCalledWith({ id: 'chat-a' });
  });

  // fetchPinnedForFolder: on listPinned API failure, pinned rows for that folder are cleared
  // (see UnifiedSidebar) so the sidebar does not show stale pins. Covering the initial load
  // path requires a folder-descriptor harness with chatCount > 0; not run here.
});

describe('UnifiedSidebar delete all chats in folder (pinned preserved)', () => {
  const GENERAL_KEY = 'General Chats';

  function getOnDeleteAllChatsInFolder() {
    render(<UnifiedSidebar />);
    const props = hoisted.capturedProjectsTreeProps as {
      onDeleteAllChatsInFolder?: (folderKey: string) => Promise<void>;
    } | null;
    if (!props?.onDeleteAllChatsInFolder) {
      throw new Error('onDeleteAllChatsInFolder not found in ProjectsTree props');
    }
    return props.onDeleteAllChatsInFolder;
  }

  it('deletes only unpinned chats; omits ids returned by listPinned from deleteChat', async () => {
    hoisted.chatsListCountsForSidebarData = [{ projectId: null, count: 2 }];
    hoisted.chatsListByFolderFetchMock.mockResolvedValue({
      chats: [
        { id: 'unpinned-a', projectId: null, updatedAt: new Date(0) },
        { id: 'unpinned-b', projectId: null, updatedAt: new Date(0) },
      ],
      hasMore: false,
      nextCursor: null,
    });
    hoisted.listPinnedFetchMock.mockResolvedValue([
      { id: 'pinned-1', updatedAt: new Date(0) } as { id: string },
    ]);

    const onDelete = getOnDeleteAllChatsInFolder();
    await answerConfirm(() => onDelete(GENERAL_KEY), 'confirm');

    expect(hoisted.listPinnedFetchMock).toHaveBeenCalled();
    expect(hoisted.chatDeleteMutateAsyncMock).toHaveBeenCalledTimes(2);
    expect(hoisted.chatDeleteMutateAsyncMock).toHaveBeenCalledWith({ id: 'unpinned-a' });
    expect(hoisted.chatDeleteMutateAsyncMock).toHaveBeenCalledWith({ id: 'unpinned-b' });
    expect(hoisted.chatDeleteMutateAsyncMock).not.toHaveBeenCalledWith({ id: 'pinned-1' });
    vi.unstubAllGlobals();
  });

  it('info toast and no delete when every chat in the folder is pinned', async () => {
    const toastInfoSpy = vi.spyOn(toast, 'info').mockReturnValue('t-id');
    hoisted.chatsListCountsForSidebarData = [{ projectId: null, count: 1 }];
    hoisted.chatsListByFolderFetchMock.mockResolvedValue({
      chats: [],
      hasMore: false,
      nextCursor: null,
    });
    hoisted.listPinnedFetchMock.mockResolvedValue([
      { id: 'only-pinned', updatedAt: new Date(0) } as { id: string },
    ]);

    const onDelete = getOnDeleteAllChatsInFolder();
    await onDelete(GENERAL_KEY);

    expect(toastInfoSpy).toHaveBeenCalledWith(
      'No unpinned chats to delete in this folder. Pinned chats are kept.',
    );
    expect(hoisted.chatDeleteMutateAsyncMock).not.toHaveBeenCalled();
    toastInfoSpy.mockRestore();
    vi.unstubAllGlobals();
  });

  it('aborts and shows error when listPinned fetch rejects (no batch delete)', async () => {
    const toastErrorSpy = vi.spyOn(toast, 'error').mockReturnValue('e-id');
    hoisted.chatsListCountsForSidebarData = [{ projectId: null, count: 1 }];
    hoisted.chatsListByFolderFetchMock.mockResolvedValue({
      chats: [{ id: 'x', projectId: null, updatedAt: new Date(0) }],
      hasMore: false,
      nextCursor: null,
    });
    // Initial sidebar load also calls listPinned; reject only the second (delete-all) fetch.
    hoisted.listPinnedFetchMock
      .mockResolvedValueOnce([])
      .mockRejectedValueOnce(new Error('pinned fetch failed'));

    const onDelete = getOnDeleteAllChatsInFolder();
    await onDelete(GENERAL_KEY);

    expect(toastErrorSpy).toHaveBeenCalledWith('Could not load pinned chat list', {
      description: 'Could not load pinned chat list. Try again.',
    });
    expect(hoisted.chatDeleteMutateAsyncMock).not.toHaveBeenCalled();
    toastErrorSpy.mockRestore();
  });

  it('aborts and shows error when listByFolder fetch rejects during delete (no batch delete)', async () => {
    const toastErrorSpy = vi.spyOn(toast, 'error').mockReturnValue('e-id');
    hoisted.chatsListCountsForSidebarData = [{ projectId: null, count: 1 }];
    hoisted.listPinnedFetchMock.mockResolvedValue([]);
    // Mount: initial folder page fetch. Delete-all: first paginated listByFolder rejects.
    hoisted.chatsListByFolderFetchMock
      .mockResolvedValueOnce({ chats: [], hasMore: false, nextCursor: null })
      .mockRejectedValueOnce(new Error('listByFolder failed'));

    const onDelete = getOnDeleteAllChatsInFolder();
    await onDelete(GENERAL_KEY);

    expect(toastErrorSpy).toHaveBeenCalledWith('Failed to load chats for folder', {
      description: 'listByFolder failed',
    });
    expect(hoisted.chatDeleteMutateAsyncMock).not.toHaveBeenCalled();
    toastErrorSpy.mockRestore();
  });

  it('does not delete when the user cancels the post-fetch confirmation', async () => {
    hoisted.chatsListCountsForSidebarData = [{ projectId: null, count: 2 }];
    hoisted.chatsListByFolderFetchMock.mockResolvedValue({
      chats: [
        { id: 'a', projectId: null, updatedAt: new Date(0) },
        { id: 'b', projectId: null, updatedAt: new Date(0) },
      ],
      hasMore: false,
      nextCursor: null,
    });
    hoisted.listPinnedFetchMock.mockResolvedValue([]);

    const onDelete = getOnDeleteAllChatsInFolder();
    const asked = await answerConfirm(() => onDelete(GENERAL_KEY), 'cancel');

    expect(asked).toContain('Delete 2 unpinned chats in this folder?');
    expect(hoisted.chatDeleteMutateAsyncMock).not.toHaveBeenCalled();
    vi.unstubAllGlobals();
  });

  it('passes only unpinned chat ids to task preflight; pinned id is not in the task-gating set', async () => {
    hoisted.chatsListCountsForSidebarData = [{ projectId: null, count: 2 }];
    hoisted.chatsListByFolderFetchMock.mockResolvedValue({
      chats: [
        { id: 'unp-task', projectId: null, updatedAt: new Date(0) },
        { id: 'pinned-skip', projectId: null, updatedAt: new Date(0) },
      ],
      hasMore: false,
      nextCursor: null,
    });
    hoisted.listPinnedFetchMock.mockResolvedValue([
      { id: 'pinned-skip', updatedAt: new Date(0) } as { id: string },
    ]);

    const getActive = hoisted.getActiveLinkedTasksForChatIdsWithFallbackMock;
    getActive.mockImplementation(async (chatIds: string[]) => {
      expect(chatIds).toEqual(['unp-task']);
      expect(chatIds).not.toContain('pinned-skip');
      return {
        activeTasks: [{ taskId: 'task-folder', chatId: 'unp-task' }],
        unresolvedTaskLinks: 0,
      };
    });

    const onDelete = getOnDeleteAllChatsInFolder();
    await answerConfirm(() => onDelete(GENERAL_KEY), 'confirm');

    expect(getActive).toHaveBeenCalled();
    expect(hoisted.chatDeleteMutateAsyncMock).not.toHaveBeenCalled();
    vi.unstubAllGlobals();
  });
});

describe('UnifiedSidebar archive chat (sc-208)', () => {
  function getOnChatArchive() {
    return captureChatAction('onChatArchive');
  }

  // Archive stops the linked task in the main process, so the renderer never cancels from a snapshot.
  it('archives at once when the chat has a live linked task, without the task dialog', async () => {
    hoisted.getActiveLinkedTasksForChatIdsWithFallbackMock.mockResolvedValue({
      activeTasks: [{ taskId: 'task-taw', chatId: 'chat-taw' }],
      unresolvedTaskLinks: 0,
    });
    const onChatArchive = getOnChatArchive();
    await act(async () => {
      await onChatArchive('chat-taw');
    });

    expect(hoisted.archiveChatMutateAsyncMock).toHaveBeenCalledWith({ id: 'chat-taw' });
    const props = hoisted.capturedSidebarDialogsProps as {
      taskAwareActionDialog?: { open?: boolean };
    } | null;
    expect(props?.taskAwareActionDialog?.open).toBe(false);
    expect(hoisted.getActiveLinkedTasksForChatIdsWithFallbackMock).not.toHaveBeenCalled();
    expect(hoisted.cancelTasksBestEffortMock).not.toHaveBeenCalled();
  });

  // A refused archive leaves the chat live, so its pane must come back.
  it('reopens the cleared panes and reports the reason when archive refuses', async () => {
    const errorSpy = vi.spyOn(toast, 'error').mockReturnValue('toast-id');
    hoisted.archiveChatMutateAsyncMock.mockRejectedValueOnce(
      new Error("Could not stop this chat's task, so the chat was not archived."),
    );
    hoisted.state.splitViewState = {
      splitView: { chatIds: ['chat-other', 'chat-refused'], activePaneIndex: 1 },
      isSplitActive: true,
    };
    const onChatArchive = getOnChatArchive();
    await act(async () => {
      await onChatArchive('chat-refused');
    });

    expect(errorSpy).toHaveBeenCalledWith('Failed to archive chat', {
      description: "Could not stop this chat's task, so the chat was not archived.",
    });
    expect(screen.queryByTestId('archived-chats')).toBeNull();
    // The pane archive cleared eagerly comes back, since the chat is still live.
    expect(hoisted.restorePaneAtMock).toHaveBeenCalledWith(1, 'chat-refused');
    errorSpy.mockRestore();
  });

  it('switches to archived mode and clears the selection only if it was the archived chat', async () => {
    const onChatArchive = getOnChatArchive();
    expect(screen.getByTestId('projects-tree')).toBeTruthy();
    await act(async () => {
      await onChatArchive('chat-arch-selected');
    });

    expect(screen.getByTestId('archived-chats')).toBeTruthy();
    expect(screen.queryByTestId('projects-tree')).toBeNull();

    // Selection is set through a functional updater; jotai is mocked so no state is stored, but the
    // updater is pure, so calling it covers both branches directly.
    const updater = hoisted.setSelectedChatIdMock.mock.calls.at(-1)?.[0] as (
      current: string | null,
    ) => string | null;
    expect(updater('chat-arch-selected')).toBeNull();
    expect(updater('chat-other')).toBe('chat-other');
  });

  it('refetches batch caches + listArchived but skips full folder/pinned refetch', async () => {
    // Archive relocates (active → archived) like restore, not delete: chats.list + batch
    // caches + listArchived refresh; the sidebar's own listByFolder / listPinned are patched
    // locally and must NOT be invalidated. Counts sync targeted (invalidate + fetch).
    const onChatArchive = getOnChatArchive();
    await onChatArchive('chat-arch-1');

    expect(hoisted.chatsListInvalidateMock).toHaveBeenCalledTimes(1);
    expect(hoisted.chatsListByBatchInvalidateMock).toHaveBeenCalledTimes(1);
    expect(hoisted.chatsListBatchGroupsInvalidateMock).toHaveBeenCalledTimes(1);
    expect(hoisted.chatsListArchivedInvalidateMock).toHaveBeenCalledTimes(1);
    expect(hoisted.chatsListByFolderInvalidateMock).not.toHaveBeenCalled();
    expect(hoisted.chatsListPinnedInvalidateMock).not.toHaveBeenCalled();
    expect(hoisted.chatsListCountsInvalidateMock).toHaveBeenCalledTimes(1);
    expect(hoisted.chatsListCountsFetchMock).toHaveBeenCalledTimes(1);
  });

  it('warns and full-refreshes when archive succeeds but listCounts refetch fails', async () => {
    const toastWarningSpy = vi.spyOn(toast, 'warning').mockReturnValue('toast-id');
    hoisted.chatsListCountsFetchMock.mockRejectedValueOnce(new Error('archive counts failed'));
    const onChatArchive = getOnChatArchive();
    await onChatArchive('chat-arch-counts-fail');

    expect(toastWarningSpy).toHaveBeenCalledWith(
      'Chat archived; refreshing sidebar',
      expect.objectContaining({
        description: expect.stringContaining('archive counts failed'),
      }),
    );
    toastWarningSpy.mockRestore();
  });

  it('shows an error toast and fires no cache invalidation when the archive mutation fails', async () => {
    // Edge: the targeted invalidations run AFTER a successful mutation. A failed archive must
    // leave the sidebar caches untouched (no partial/leaked state) and surface an error toast.
    const toastErrorSpy = vi.spyOn(toast, 'error').mockReturnValue('toast-id');
    hoisted.archiveChatMutateAsyncMock.mockRejectedValueOnce(new Error('archive boom'));
    const onChatArchive = getOnChatArchive();
    await onChatArchive('chat-arch-fail');

    expect(toastErrorSpy).toHaveBeenCalledWith(
      'Failed to archive chat',
      expect.objectContaining({ description: expect.stringContaining('archive boom') }),
    );
    expect(hoisted.chatsListInvalidateMock).not.toHaveBeenCalled();
    expect(hoisted.chatsListByBatchInvalidateMock).not.toHaveBeenCalled();
    expect(hoisted.chatsListBatchGroupsInvalidateMock).not.toHaveBeenCalled();
    expect(hoisted.chatsListArchivedInvalidateMock).not.toHaveBeenCalled();
    expect(hoisted.chatsListCountsFetchMock).not.toHaveBeenCalled();
    toastErrorSpy.mockRestore();
  });

  it('clears the split-view pane holding the chat before the archive mutation', async () => {
    hoisted.state.splitViewState = {
      splitView: { chatIds: ['chat-arch-pane', 'chat-other'], activePaneIndex: 0 },
      isSplitActive: true,
    };
    const onChatArchive = getOnChatArchive();
    await onChatArchive('chat-arch-pane');

    // Pane index 0 holds the archived chat → clearPaneAt(0) runs (eager pane cleanup
    // before the mutation avoids a stale splitView snapshot).
    expect(hoisted.clearPaneAtMock).toHaveBeenCalledWith(0);
  });

  // Wiring for the chat view's "Complete & Archive" (TaskAcceptBar): it completes the task then
  // dispatches sidebar:archive-chat. The sidebar must archive directly — no active-task dialog,
  // since the task is already completed by the time the event fires.
  it('archives directly when a sidebar:archive-chat window event fires', async () => {
    render(<UnifiedSidebar />);

    await act(async () => {
      window.dispatchEvent(
        new CustomEvent('sidebar:archive-chat', { detail: { chatId: 'chat-evt-1' } }),
      );
    });

    await waitFor(() =>
      expect(hoisted.archiveChatMutateAsyncMock).toHaveBeenCalledWith(
        expect.objectContaining({ id: 'chat-evt-1' }),
      ),
    );
    // No task preflight: archiveSingleChat skips the active-task dialog the dropdown path uses.
    expect(hoisted.getActiveLinkedTasksForChatIdsWithFallbackMock).not.toHaveBeenCalled();
  });

  it('ignores a sidebar:archive-chat event with no chatId in its detail', async () => {
    render(<UnifiedSidebar />);

    await act(async () => {
      window.dispatchEvent(new CustomEvent('sidebar:archive-chat', { detail: {} }));
    });

    expect(hoisted.archiveChatMutateAsyncMock).not.toHaveBeenCalled();
  });

  // Leak guard: a stale listener on an unmounted sidebar could archive a chat after the user
  // navigated away, or double-archive in a multi-window/remount scenario.
  it('removes the sidebar:archive-chat listener on unmount', async () => {
    const { unmount } = render(<UnifiedSidebar />);
    unmount();

    await act(async () => {
      window.dispatchEvent(
        new CustomEvent('sidebar:archive-chat', { detail: { chatId: 'chat-after-unmount' } }),
      );
    });

    expect(hoisted.archiveChatMutateAsyncMock).not.toHaveBeenCalled();
  });
});

describe('UnifiedSidebar project delete (complete) includes pinned in wipe', () => {
  it('deleteCompletely: task preflight and deleteChat receive all project chat ids including pinned', async () => {
    hoisted.chatsListCountsForSidebarData = [{ projectId: 'cloud-p1', count: 2 }];
    hoisted.chatsListByFolderFetchMock.mockResolvedValue({
      chats: [
        { id: 'unp-1', projectId: 'cloud-p1', updatedAt: new Date(0) },
        { id: 'pin-1', projectId: 'cloud-p1', updatedAt: new Date(0) },
      ],
      hasMore: false,
      nextCursor: null,
    });
    hoisted.listPinnedFetchMock.mockResolvedValue([
      { id: 'pin-1', updatedAt: new Date(0) } as { id: string },
    ]);

    const getActive = hoisted.getActiveLinkedTasksForChatIdsWithFallbackMock;
    getActive.mockImplementation(async (chatIds: string[]) => {
      if (chatIds.length === 2 && chatIds.includes('unp-1') && chatIds.includes('pin-1')) {
        return { activeTasks: [], unresolvedTaskLinks: 0 };
      }
      return { activeTasks: [], unresolvedTaskLinks: 0 };
    });

    render(<UnifiedSidebar />);
    const props = hoisted.capturedProjectsTreeProps as {
      onProjectDelete?: (projectId: string) => Promise<void>;
    } | null;
    if (!props?.onProjectDelete) throw new Error('onProjectDelete not found in ProjectsTree props');

    const onProjectDelete = props.onProjectDelete;
    const asked = await answerConfirm(() => onProjectDelete('local-p1'), 'confirm');
    expect(asked).toContain('Delete this project?');

    const callWithAllChats = getActive.mock.calls.find(
      (args) => args[0].length === 2 && args[0].includes('unp-1') && args[0].includes('pin-1'),
    );
    expect(callWithAllChats).toBeDefined();
    expect(hoisted.chatDeleteMutateAsyncMock).toHaveBeenCalledWith({ id: 'unp-1' });
    expect(hoisted.chatDeleteMutateAsyncMock).toHaveBeenCalledWith({ id: 'pin-1' });
    expect(hoisted.projectsDeleteMutateAsyncMock).toHaveBeenCalledWith({ id: 'local-p1' });
    vi.unstubAllGlobals();
  });
});

describe('UnifiedSidebar rename chat (sc-701)', () => {
  async function triggerRename(chatId: string, newName: string) {
    render(<UnifiedSidebar />);
    const treeProps = hoisted.capturedProjectsTreeProps as {
      chatActions?: { onChatRename?: (chat: { id: string; name: string | null }) => void };
    } | null;
    if (!treeProps?.chatActions?.onChatRename) throw new Error('onChatRename not exposed');
    // Open the rename dialog by setting `chatToRename`. act() flushes the state update so the
    // SidebarDialogs mock re-renders with a fresh `onChatRenameConfirm` closure
    // (its useCallback deps include `chatToRename`).
    act(() => {
      treeProps.chatActions?.onChatRename?.({ id: chatId, name: 'old' });
    });
    const dialogsProps = hoisted.capturedSidebarDialogsProps as {
      chatToRename?: { id: string; name: string } | null;
      onChatRenameConfirm?: (newName: string) => Promise<void>;
    } | null;
    if (!dialogsProps?.onChatRenameConfirm) throw new Error('onChatRenameConfirm not exposed');
    expect(dialogsProps.chatToRename?.id).toBe(chatId);
    await dialogsProps.onChatRenameConfirm(newName);
  }

  it('does not broadly invalidate caches on successful rename (in-place patch path)', async () => {
    await triggerRename('00000000-0000-0000-0000-000000000077', 'new name');

    expect(hoisted.renameMutateAsyncMock).toHaveBeenCalledWith({
      id: '00000000-0000-0000-0000-000000000077',
      name: 'new name',
    });
    // Rename refreshes consumers the sidebar in-place patch doesn't cover: chats.list,
    // chats.get (active chat header), chats.listByBatch / listBatchGroups (BatchGroup rows).
    expect(hoisted.chatsListInvalidateMock).toHaveBeenCalledTimes(1);
    expect(hoisted.chatsGetInvalidateMock).toHaveBeenCalledWith({
      id: '00000000-0000-0000-0000-000000000077',
    });
    expect(hoisted.chatsListBatchGroupsInvalidateMock).toHaveBeenCalledTimes(1);
    // Sidebar's own queries are NOT invalidated (in-place patch covers them).
    expect(hoisted.chatsListByFolderInvalidateMock).not.toHaveBeenCalled();
    expect(hoisted.chatsListPinnedInvalidateMock).not.toHaveBeenCalled();
    // Rename does not change counts; no listCounts traffic expected.
    expect(hoisted.chatsListCountsInvalidateMock).not.toHaveBeenCalled();
    expect(hoisted.chatsListCountsFetchMock).not.toHaveBeenCalled();
  });

  it('updates the sub-chat store so an open chat header reflects the new name', async () => {
    hoisted.renameMutateAsyncMock.mockResolvedValueOnce({
      id: '00000000-0000-0000-0000-000000000077',
      name: 'fresh name',
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
    });
    await triggerRename('00000000-0000-0000-0000-000000000077', 'fresh name');

    expect(hoisted.updateSubChatNameMock).toHaveBeenCalledWith(
      '00000000-0000-0000-0000-000000000077',
      'fresh name',
    );
  });

  it('falls back to full refresh when rename mutation returns null', async () => {
    hoisted.renameMutateAsyncMock.mockResolvedValueOnce(null);
    await triggerRename('00000000-0000-0000-0000-000000000077', 'new name');

    expect(hoisted.chatsListInvalidateMock).toHaveBeenCalledTimes(1);
    expect(hoisted.chatsListByFolderInvalidateMock).toHaveBeenCalledTimes(1);
    expect(hoisted.chatsListPinnedInvalidateMock).toHaveBeenCalledTimes(1);
    expect(hoisted.chatsListBatchGroupsInvalidateMock).toHaveBeenCalledTimes(1);
    expect(hoisted.chatsListCountsInvalidateMock).toHaveBeenCalledTimes(1);
  });
});

describe('UnifiedSidebar archived mode (sc-198)', () => {
  // The search box stays mounted across the toggle, so the query has to reach the
  // archived list too — otherwise it reads as a control that silently does nothing.
  it('passes the search query into archived mode and keeps it across the toggle', () => {
    render(<UnifiedSidebar />);

    fireEvent.change(screen.getByTestId('sidebar-header'), { target: { value: 'foo' } });
    fireEvent.click(screen.getByTestId('toggle-archived'));

    expect(hoisted.capturedArchivedChatsSectionProps?.searchQuery).toBe('foo');
    expect((screen.getByTestId('sidebar-header') as HTMLInputElement).value).toBe('foo');
  });

  it('toggles archived mode when the toggle-archived hotkey event fires', () => {
    render(<UnifiedSidebar />);
    expect(screen.queryByTestId('archived-chats')).toBeNull();

    act(() => {
      window.dispatchEvent(new CustomEvent('sidebar:toggle-archived'));
    });
    expect(screen.getByTestId('archived-chats')).toBeTruthy();

    act(() => {
      window.dispatchEvent(new CustomEvent('sidebar:toggle-archived'));
    });
    expect(screen.queryByTestId('archived-chats')).toBeNull();
  });

  // Two events inside one React batch collapse to a single state update unless the
  // updater is functional -- a held key or a double-dispatch must not strand the flag.
  it('applies both toggles when two events land in the same tick', () => {
    render(<UnifiedSidebar />);

    act(() => {
      window.dispatchEvent(new CustomEvent('sidebar:toggle-archived'));
      window.dispatchEvent(new CustomEvent('sidebar:toggle-archived'));
    });
    expect(screen.queryByTestId('archived-chats')).toBeNull();

    act(() => {
      window.dispatchEvent(new CustomEvent('sidebar:toggle-archived'));
      window.dispatchEvent(new CustomEvent('sidebar:toggle-archived'));
      window.dispatchEvent(new CustomEvent('sidebar:toggle-archived'));
    });
    expect(screen.getByTestId('archived-chats')).toBeTruthy();
  });

  // tRPC hydration can briefly hand back a non-array (see the NOTE above the queries).
  // The archived list is filtered downstream, so an unguarded value throws rather than
  // rendering empty.
  it.each([
    ['a non-array object', { unexpected: true }],
    ['a string', 'not-an-array'],
    ['null', null],
    ['undefined', undefined],
  ])('survives listArchived returning %s during hydration', (_label, payload) => {
    hoisted.archivedChatsData = payload;

    expect(() => {
      render(<UnifiedSidebar />);
      fireEvent.click(screen.getByTestId('toggle-archived'));
    }).not.toThrow();

    expect(hoisted.capturedArchivedChatsSectionProps?.archivedChats).toEqual([]);
  });

  it('keeps the query when archived mode is toggled back off', () => {
    render(<UnifiedSidebar />);

    fireEvent.change(screen.getByTestId('sidebar-header'), { target: { value: 'foo' } });
    fireEvent.click(screen.getByTestId('toggle-archived'));
    fireEvent.click(screen.getByTestId('toggle-archived'));

    expect(screen.queryByTestId('archived-chats')).toBeNull();
    expect(hoisted.capturedProjectsTreeProps?.searchQuery).toBe('foo');
    expect((screen.getByTestId('sidebar-header') as HTMLInputElement).value).toBe('foo');
  });
});

describe('UnifiedSidebar restore chat (sc-701)', () => {
  function getOnChatRestore() {
    render(<UnifiedSidebar />);
    // ArchivedChatsSection is only rendered when showArchived = true. Click the SidebarFooter
    // toggle to flip state, then read the captured `onChatRestore` prop.
    fireEvent.click(screen.getByTestId('toggle-archived'));
    const props = hoisted.capturedArchivedChatsSectionProps as {
      onChatRestore?: (chatId: string) => Promise<void>;
    } | null;
    if (!props?.onChatRestore) {
      throw new Error('onChatRestore not found in ArchivedChatsSection props');
    }
    return props.onChatRestore;
  }

  function makeRestoredChat(id: string, projectId: string | null = null) {
    return {
      id,
      name: 'Restored',
      projectId,
      createdAt: new Date('2026-01-01'),
      updatedAt: new Date('2026-01-02'),
      archivedAt: null,
      pinnedAt: null,
      worktreePath: null,
      branch: null,
      baseBranch: null,
      prUrl: null,
      prNumber: null,
      taskId: null,
      batchId: null,
    };
  }

  // Split view derives the active chat from panes, not selectedAgentChatIdAtom, and archive already
  // emptied this chat's pane. Writing selection alone would leave the restored chat nowhere.
  it('reveals the restored chat in a pane when split view is active', async () => {
    hoisted.state.splitViewState = {
      splitView: { chatIds: ['chat-pane-a', null], activePaneIndex: 1 },
      isSplitActive: true,
    };
    const restoredId = '00000000-0000-0000-0000-0000000000b1';
    hoisted.restoreMutateAsyncMock.mockResolvedValueOnce(makeRestoredChat(restoredId));
    const onChatRestore = getOnChatRestore();
    await onChatRestore('chat-restore-split');

    expect(hoisted.fillActivePaneMock).toHaveBeenCalledWith(restoredId);
    expect(hoisted.setSelectedChatIdMock).not.toHaveBeenCalledWith(restoredId);
  });

  // The reveal sits below the orphan/resolved branch, so both paths must reach it. Reinstating an
  // early return in the orphan branch would silently strand orphan restores in split view again.
  it('reveals the restored chat in a pane on the orphan-project path too', async () => {
    hoisted.state.splitViewState = {
      splitView: { chatIds: ['chat-pane-a', null], activePaneIndex: 1 },
      isSplitActive: true,
    };
    const restoredId = '00000000-0000-0000-0000-0000000000b3';
    hoisted.restoreMutateAsyncMock.mockResolvedValueOnce(
      makeRestoredChat(restoredId, 'orphan-project-xyz'),
    );
    const onChatRestore = getOnChatRestore();
    await act(async () => {
      await onChatRestore('chat-orphan-split');
    });

    expect(hoisted.fillActivePaneMock).toHaveBeenCalledWith(restoredId);
    expect(hoisted.projectsListInvalidateMock).toHaveBeenCalled();
    // Archived mode must close on the orphan path as well, or the user is left staring at the
    // archive list while the chat they restored is showing behind it.
    expect(screen.queryByTestId('archived-chats')).toBeNull();
  });

  // A restore that never happened must not put anything in a pane — otherwise the user gets an
  // empty/stale pane for a chat that is still archived.
  it('writes no pane when the restore mutation rejects in split view', async () => {
    hoisted.state.splitViewState = {
      splitView: { chatIds: ['chat-pane-a', null], activePaneIndex: 1 },
      isSplitActive: true,
    };
    const toastErrorSpy = vi.spyOn(toast, 'error').mockReturnValue('toast-id');
    hoisted.restoreMutateAsyncMock.mockRejectedValueOnce(new Error('restore exploded'));
    const onChatRestore = getOnChatRestore();
    await onChatRestore('chat-restore-boom');

    expect(toastErrorSpy).toHaveBeenCalled();
    // Neither reveal sink may be written: a restore that failed must leave the panes and the
    // selection exactly as they were.
    expect(hoisted.fillActivePaneMock).not.toHaveBeenCalled();
    expect(hoisted.setSelectedChatIdMock).not.toHaveBeenCalled();
    toastErrorSpy.mockRestore();
  });

  it('writes no pane when the restore returns null in split view', async () => {
    hoisted.state.splitViewState = {
      splitView: { chatIds: ['chat-pane-a', null], activePaneIndex: 1 },
      isSplitActive: true,
    };
    const toastErrorSpy = vi.spyOn(toast, 'error').mockReturnValue('toast-id');
    const onChatRestore = getOnChatRestore();
    await onChatRestore('chat-restore-null');

    expect(hoisted.fillActivePaneMock).not.toHaveBeenCalled();
    expect(hoisted.setSelectedChatIdMock).not.toHaveBeenCalled();
    toastErrorSpy.mockRestore();
  });

  // Restoring two chats back to back fills the one empty pane, then displaces the active pane —
  // the same eviction clicking two chats already causes. Pane count must never grow.
  it('does not grow the split when two chats are restored back to back', async () => {
    hoisted.state.splitViewState = {
      splitView: { chatIds: ['chat-pane-a', null], activePaneIndex: 1 },
      isSplitActive: true,
    };
    const firstId = '00000000-0000-0000-0000-0000000000b4';
    const secondId = '00000000-0000-0000-0000-0000000000b5';
    hoisted.restoreMutateAsyncMock
      .mockResolvedValueOnce(makeRestoredChat(firstId))
      .mockResolvedValueOnce(makeRestoredChat(secondId));
    const onChatRestore = getOnChatRestore();
    await Promise.all([onChatRestore('chat-restore-1'), onChatRestore('chat-restore-2')]);

    expect(hoisted.fillActivePaneMock).toHaveBeenCalledTimes(2);
    expect(hoisted.fillActivePaneMock).toHaveBeenCalledWith(firstId);
    expect(hoisted.fillActivePaneMock).toHaveBeenCalledWith(secondId);
    // Reveal goes through fillActivePane only — nothing here may add a pane.
    expect(hoisted.state.splitViewState.splitView.chatIds).toHaveLength(2);
  });

  it('keeps the selection path when split view is inactive', async () => {
    const restoredId = '00000000-0000-0000-0000-0000000000b2';
    hoisted.restoreMutateAsyncMock.mockResolvedValueOnce(makeRestoredChat(restoredId));
    const onChatRestore = getOnChatRestore();
    await onChatRestore('chat-restore-single');

    expect(hoisted.setSelectedChatIdMock).toHaveBeenCalledWith(restoredId);
    expect(hoisted.fillActivePaneMock).not.toHaveBeenCalled();
  });

  it('shows toast and skips cache work when restore returns null', async () => {
    const toastErrorSpy = vi.spyOn(toast, 'error').mockReturnValue('toast-id');
    const onChatRestore = getOnChatRestore();
    await onChatRestore('chat-missing');

    expect(toastErrorSpy).toHaveBeenCalledWith(
      'Failed to restore chat',
      expect.objectContaining({
        description: expect.stringContaining('It may already be active.'),
      }),
    );
    expect(hoisted.chatsListInvalidateMock).not.toHaveBeenCalled();
    expect(hoisted.chatsListArchivedInvalidateMock).not.toHaveBeenCalled();
    expect(hoisted.chatsListCountsInvalidateMock).not.toHaveBeenCalled();
    toastErrorSpy.mockRestore();
  });

  it('uses in-place patch + listArchived invalidate on successful restore', async () => {
    hoisted.restoreMutateAsyncMock.mockResolvedValueOnce({
      id: '00000000-0000-0000-0000-0000000000aa',
      name: 'Restored',
      projectId: null,
      createdAt: new Date('2026-01-01'),
      updatedAt: new Date('2026-01-02'),
      archivedAt: null,
      pinnedAt: null,
      worktreePath: null,
      branch: null,
      baseBranch: null,
      prUrl: null,
      prNumber: null,
      taskId: null,
      batchId: null,
    });
    const onChatRestore = getOnChatRestore();
    await onChatRestore('chat-restore-ok');

    // chats.list + chats.listByBatch / listBatchGroups (BatchGroup) refreshed; sidebar's own
    // listByFolder / listPinned untouched.
    expect(hoisted.chatsListInvalidateMock).toHaveBeenCalledTimes(1);
    expect(hoisted.chatsListByFolderInvalidateMock).not.toHaveBeenCalled();
    expect(hoisted.chatsListPinnedInvalidateMock).not.toHaveBeenCalled();
    expect(hoisted.chatsListBatchGroupsInvalidateMock).toHaveBeenCalledTimes(1);
    expect(hoisted.chatsListArchivedInvalidateMock).toHaveBeenCalledTimes(1);
    expect(hoisted.chatsListCountsInvalidateMock).toHaveBeenCalledTimes(1);
    expect(hoisted.chatsListCountsFetchMock).toHaveBeenCalledTimes(1);
    // The folder key already resolved, so the project list is current — leave the fast path fast.
    expect(hoisted.projectsListInvalidateMock).not.toHaveBeenCalled();
  });

  it('falls back to full refresh when restored chat resolves to an unknown (orphan) project', async () => {
    hoisted.restoreMutateAsyncMock.mockResolvedValueOnce({
      id: '00000000-0000-0000-0000-0000000000ad',
      name: 'Restored',
      projectId: 'orphan-project-xyz',
      createdAt: new Date('2026-01-01'),
      updatedAt: new Date('2026-01-02'),
      archivedAt: null,
      pinnedAt: null,
      worktreePath: null,
      branch: null,
      baseBranch: null,
      prUrl: null,
      prNumber: null,
      taskId: null,
      batchId: null,
    });
    const onChatRestore = getOnChatRestore();
    await onChatRestore('chat-orphan-restore');

    expect(hoisted.chatsListInvalidateMock).toHaveBeenCalledTimes(1);
    expect(hoisted.chatsListByFolderInvalidateMock).toHaveBeenCalledTimes(1);
    expect(hoisted.chatsListPinnedInvalidateMock).toHaveBeenCalledTimes(1);
    expect(hoisted.chatsListBatchGroupsInvalidateMock).toHaveBeenCalledTimes(1);
    expect(hoisted.chatsListArchivedInvalidateMock).toHaveBeenCalledTimes(1);
    // Orphan path skips count-sync fetch (full refresh handles it).
    expect(hoisted.chatsListCountsFetchMock).not.toHaveBeenCalled();
    // The folder key resolves off the project list, so an unresolved project must refetch it —
    // otherwise nothing ever makes the restored row appear.
    expect(hoisted.projectsListInvalidateMock).toHaveBeenCalled();
  });

  it('warns and full-refreshes when restore succeeds but listCounts refetch fails', async () => {
    hoisted.restoreMutateAsyncMock.mockResolvedValueOnce({
      id: '00000000-0000-0000-0000-0000000000ab',
      name: 'Restored',
      projectId: null,
      createdAt: new Date('2026-01-01'),
      updatedAt: new Date('2026-01-02'),
      archivedAt: null,
      pinnedAt: null,
      worktreePath: null,
      branch: null,
      baseBranch: null,
      prUrl: null,
      prNumber: null,
      taskId: null,
      batchId: null,
    });
    const toastWarningSpy = vi.spyOn(toast, 'warning').mockReturnValue('toast-id');
    hoisted.chatsListCountsFetchMock.mockRejectedValueOnce(new Error('restore counts failed'));
    const onChatRestore = getOnChatRestore();
    await onChatRestore('chat-restore-counts-fail');

    expect(toastWarningSpy).toHaveBeenCalledWith(
      'Chat restored; refreshing sidebar',
      expect.objectContaining({
        description: expect.stringContaining('restore counts failed'),
      }),
    );
    expect(hoisted.chatsListInvalidateMock).toHaveBeenCalled();
    toastWarningSpy.mockRestore();
  });
});

/**
 * The row memos compare these by reference, so a handler re-created on an unrelated render
 * re-renders every row. Poll-shaped, because the 5s poll is what churned them the last two times.
 */
describe('UnifiedSidebar row-action identity', () => {
  const ROW_BOUND_PROPS = [
    'chatActions',
    'onProjectDelete',
    'onRenameProject',
    'onDeleteAllChatsInFolder',
    'onDeleteBatch',
    'onLoadMoreChats',
    'toggleCodebase',
    'dndHandlers',
  ] as const;

  it('keeps row-bound handler identities across a task-poll re-render', () => {
    const identities = () => ROW_BOUND_PROPS.map((k) => hoisted.capturedProjectsTreeProps?.[k]);
    render(<UnifiedSidebar />);
    const before = identities();
    hoisted.state.activeTasksData = { items: [], hasMore: false, nextCursor: null };
    fireEvent.change(screen.getByTestId('sidebar-header'), { target: { value: 'x' } });
    const after = identities();
    ROW_BOUND_PROPS.forEach((key, i) => expect(after[i], key).toBe(before[i]));
  });

  /**
   * Re-entrancy rests on togglePinInFlightRef alone now. A double-tap must toggle once, or the pin
   * lands and immediately un-pins.
   */
  it('ignores a second pin toggle while the first is in flight', async () => {
    let release: ((chat: null) => void) | undefined;
    const pending = new Promise<null>((resolve) => (release = resolve));
    hoisted.togglePinMutateAsyncMock.mockImplementationOnce(() => pending);
    const onChatPin = captureChatAction('onChatPin');
    const first = onChatPin('chat-double-tap');
    const second = onChatPin('chat-double-tap');
    release?.(null);
    await Promise.all([first, second]);

    expect(hoisted.togglePinMutateAsyncMock).toHaveBeenCalledTimes(1);
  });
});
