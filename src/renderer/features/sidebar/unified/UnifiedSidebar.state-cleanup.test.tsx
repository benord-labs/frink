// @vitest-environment happy-dom
import { fireEvent, render, screen } from '@testing-library/react';
import { toast } from 'sonner';
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { createRuntimeAtomFamily } from '../../../lib/atoms/atom-family-factory';
import { appStore } from '../../../lib/jotai-store';
import { createQueueItem } from '../../agents/lib/queue-utils';
import { useMessageQueueStore } from '../../agents/stores/message-queue-store';
import { captureChatAction, hoisted, resetHarness, setupHarness } from './sidebar-test-harness';
import { UnifiedSidebar } from './UnifiedSidebar';

// Every mock delegates to the shared harness, which UnifiedSidebar.test.tsx also drives.
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

describe('UnifiedSidebar delete chat (single)', () => {
  function getOnChatDelete() {
    return captureChatAction('onChatDelete');
  }

  it('drops the deleted chat’s per-chat atom state', async () => {
    const family = createRuntimeAtomFamily<string>('default');
    appStore.set(family('chat-del-state'), 'selection');
    appStore.set(family('chat-kept'), 'other-selection');

    const onChatDelete = getOnChatDelete();
    await onChatDelete('chat-del-state');

    expect(appStore.get(family('chat-del-state'))).toBe('default');
    expect(appStore.get(family('chat-kept'))).toBe('other-selection');
  });

  it('in split view, clears only the deleted chat’s pane and state', async () => {
    // Split view takes a different path: clearPanesForChat early-returns when split is
    // off, so this is the only configuration where pane teardown actually runs. The
    // surviving pane's chat must keep both its pane slot and its per-chat state.
    hoisted.state.splitViewState = {
      splitView: { chatIds: ['chat-pane-a', 'chat-pane-b'], activePaneIndex: 0 },
      isSplitActive: true,
    };
    const family = createRuntimeAtomFamily<string>('default');
    appStore.set(family('chat-pane-a'), 'a-selection');
    appStore.set(family('chat-pane-b'), 'b-selection');

    const onChatDelete = getOnChatDelete();
    await onChatDelete('chat-pane-a');

    expect(hoisted.clearPaneAtMock).toHaveBeenCalledTimes(1);
    expect(hoisted.clearPaneAtMock).toHaveBeenCalledWith(0);
    expect(appStore.get(family('chat-pane-a'))).toBe('default');
    expect(appStore.get(family('chat-pane-b'))).toBe('b-selection');
  });

  it('reports a failed delete after eagerly clearing the chat pane', async () => {
    const toastErrorSpy = vi.spyOn(toast, 'error').mockReturnValue('toast-id');
    hoisted.state.splitViewState = {
      splitView: { chatIds: ['chat-delete-fails', 'chat-survives'], activePaneIndex: 0 },
      isSplitActive: true,
    };
    hoisted.chatDeleteMutateAsyncMock.mockRejectedValueOnce(new Error('still stopping'));

    const onChatDelete = getOnChatDelete();
    await onChatDelete('chat-delete-fails');

    expect(toastErrorSpy).toHaveBeenCalledWith('Failed to delete chat', {
      description: 'still stopping',
    });
    expect(hoisted.clearPaneAtMock).toHaveBeenCalledWith(0);
    expect(hoisted.restorePaneAtMock).toHaveBeenCalledWith(0, 'chat-delete-fails');
    expect(hoisted.chatsListCountsFetchMock).not.toHaveBeenCalled();
    toastErrorSpy.mockRestore();
  });
});

describe('UnifiedSidebar archive chat (sc-208)', () => {
  function getOnChatArchive() {
    return captureChatAction('onChatArchive');
  }

  it('drops the archived chat’s per-chat atom state', async () => {
    const family = createRuntimeAtomFamily<string>('default');
    appStore.set(family('chat-arch-state'), 'selection');
    appStore.set(family('chat-kept'), 'other-selection');

    const onChatArchive = getOnChatArchive();
    await onChatArchive('chat-arch-state');

    expect(appStore.get(family('chat-arch-state'))).toBe('default');
    expect(appStore.get(family('chat-kept'))).toBe('other-selection');
  });

  it('keeps per-chat state when the archive mutation fails', async () => {
    const family = createRuntimeAtomFamily<string>('default');
    appStore.set(family('chat-arch-keep'), 'selection');
    hoisted.archiveChatMutateAsyncMock.mockRejectedValueOnce(new Error('archive boom'));

    const onChatArchive = getOnChatArchive();
    await onChatArchive('chat-arch-keep');

    expect(appStore.get(family('chat-arch-keep'))).toBe('selection');
  });

  // sc-682: main aborts the chat's run inside this mutation, so a queued follow-up would otherwise
  // be sent into the chat being archived before the mutation resolves.
  it("holds the chat's queue during the archive, then drops what was queued", async () => {
    hoisted.getSubChatIdsForChatMock.mockImplementation((chatId: string) =>
      chatId === 'chat-arch-queue' ? ['sub-arch-queue'] : [],
    );
    useMessageQueueStore.setState({
      queues: { 'sub-arch-queue': [createQueueItem('q1', 'follow-up')] },
      heldChatIds: {},
    });
    let heldDuringMutation = false;
    hoisted.archiveChatMutateAsyncMock.mockImplementationOnce(async () => {
      heldDuringMutation = useMessageQueueStore.getState().isChatHeld('chat-arch-queue');
      return {};
    });

    await getOnChatArchive()('chat-arch-queue');

    expect(heldDuringMutation).toBe(true);
    expect(useMessageQueueStore.getState().queues['sub-arch-queue']).toBeUndefined();
    expect(useMessageQueueStore.getState().isChatHeld('chat-arch-queue')).toBe(false);
  });

  it('keeps the queue and lifts the hold when the archive fails', async () => {
    hoisted.getSubChatIdsForChatMock.mockReturnValue(['sub-arch-fail']);
    useMessageQueueStore.setState({
      queues: { 'sub-arch-fail': [createQueueItem('q1', 'keep me')] },
      heldChatIds: {},
    });
    hoisted.archiveChatMutateAsyncMock.mockRejectedValueOnce(new Error('archive boom'));

    await getOnChatArchive()('chat-arch-fail');

    expect(useMessageQueueStore.getState().queues['sub-arch-fail']?.map((i) => i.id)).toEqual([
      'q1',
    ]);
    expect(useMessageQueueStore.getState().isChatHeld('chat-arch-fail')).toBe(false);
  });
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

  it('drops per-chat state only for chats whose delete succeeded', async () => {
    vi.stubGlobal('confirm', () => true);
    hoisted.state.splitViewState = {
      splitView: { chatIds: ['unpinned-a', 'unpinned-b'], activePaneIndex: 0 },
      isSplitActive: true,
    };
    const family = createRuntimeAtomFamily<string>('default');
    appStore.set(family('unpinned-a'), 'a-state');
    appStore.set(family('unpinned-b'), 'b-state');

    hoisted.chatsListCountsForSidebarData = [{ projectId: null, count: 2 }];
    hoisted.chatsListByFolderFetchMock.mockResolvedValue({
      chats: [
        { id: 'unpinned-a', projectId: null },
        { id: 'unpinned-b', projectId: null },
      ],
      hasMore: false,
      nextCursor: null,
    });
    hoisted.listPinnedFetchMock.mockResolvedValue([]);
    // Deletes are issued in folder order, so the second call is 'unpinned-b'. Only it
    // fails, so only its per-chat state must survive.
    hoisted.chatDeleteMutateAsyncMock
      .mockResolvedValueOnce({})
      .mockRejectedValueOnce(new Error('delete boom'));

    const onDelete = getOnDeleteAllChatsInFolder();
    await onDelete(GENERAL_KEY);

    // Pin the assumed order, so a change in folder ordering fails here rather than
    // silently inverting which chat this test believes failed.
    expect(hoisted.chatDeleteMutateAsyncMock.mock.calls.map(([arg]) => arg)).toEqual([
      { id: 'unpinned-a' },
      { id: 'unpinned-b' },
    ]);
    expect(appStore.get(family('unpinned-a'))).toBe('default');
    expect(appStore.get(family('unpinned-b'))).toBe('b-state');
    expect(hoisted.clearPaneAtMock.mock.calls.map(([index]) => index)).toEqual([0, 1]);
    expect(hoisted.restorePaneAtMock).toHaveBeenCalledTimes(1);
    expect(hoisted.restorePaneAtMock).toHaveBeenCalledWith(1, 'unpinned-b');
    vi.unstubAllGlobals();
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
});
