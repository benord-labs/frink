// @vitest-environment happy-dom
import { act, fireEvent, screen, waitFor, within } from '@testing-library/react';
import { toast } from 'sonner';
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { answerConfirm } from './sidebar-confirm-test-harness';
import { captureChatAction, hoisted, resetHarness, setupHarness } from './sidebar-test-harness';

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
    return captureChatAction('onChatDelete') as (
      chatId: string,
      chatName?: string | null,
    ) => Promise<void>;
  }

  it('asks for confirmation naming the chat and deletes nothing until it is accepted', async () => {
    const onChatDelete = getOnChatDelete();
    let pending: Promise<void> = Promise.resolve();
    act(() => {
      pending = onChatDelete('chat-named', 'Refactor auth');
    });
    const dialog = await screen.findByRole('alertdialog');

    expect(dialog.textContent).toContain('Delete "Refactor auth" permanently?');
    expect(hoisted.chatDeleteMutateAsyncMock).not.toHaveBeenCalled();

    fireEvent.click(within(dialog).getByRole('button', { name: 'Delete' }));
    await act(async () => {
      await pending;
    });
    expect(hoisted.chatDeleteMutateAsyncMock).toHaveBeenCalledWith({ id: 'chat-named' });
  });

  it.each(['cancel', 'escape'] as const)(
    'does not delete when the confirm is dismissed (%s)',
    async (answer) => {
      const onChatDelete = getOnChatDelete();
      await answerConfirm(() => onChatDelete('chat-kept', 'Keep me'), answer);
      expect(hoisted.chatDeleteMutateAsyncMock).not.toHaveBeenCalled();
      expect(hoisted.chatsListCountsFetchMock).not.toHaveBeenCalled();
    },
  );

  it('falls back to the untitled label when the chat has no name yet', async () => {
    const onChatDelete = getOnChatDelete();
    const asked = await answerConfirm(() => onChatDelete('chat-untitled', null), 'cancel');
    expect(asked).toMatch(/Delete ".+" permanently\?/);
    expect(asked).not.toContain('""');
  });

  it('deletes only the chat last asked about when a second request replaces the first', async () => {
    const onChatDelete = getOnChatDelete();
    let first: Promise<void> = Promise.resolve();
    act(() => {
      first = onChatDelete('chat-first', 'First chat');
    });
    await screen.findByRole('alertdialog');

    const asked = await answerConfirm(() => onChatDelete('chat-second', 'Second chat'), 'confirm');
    await act(async () => {
      await first;
    });

    expect(asked).toContain('Delete "Second chat" permanently?');
    expect(hoisted.chatDeleteMutateAsyncMock).toHaveBeenCalledTimes(1);
    expect(hoisted.chatDeleteMutateAsyncMock).toHaveBeenCalledWith({ id: 'chat-second' });
  });

  it('hands off to the task-aware dialog after the confirm when the chat has live tasks', async () => {
    hoisted.getActiveLinkedTasksForChatIdsWithFallbackMock.mockImplementation(
      async (chatIds: string[]) =>
        chatIds.includes('chat-busy')
          ? { activeTasks: [{ taskId: 'task-7', chatId: 'chat-busy' }], unresolvedTaskLinks: 0 }
          : { activeTasks: [], unresolvedTaskLinks: 0 },
    );
    const onChatDelete = getOnChatDelete();
    await answerConfirm(() => onChatDelete('chat-busy', 'Busy chat'), 'confirm');

    expect(hoisted.chatDeleteMutateAsyncMock).not.toHaveBeenCalled();
    await waitFor(() => {
      const dialogProps = hoisted.capturedSidebarDialogsProps as {
        taskAwareActionDialog?: {
          open: boolean;
          mode: string;
          operation: string;
          chatIds: string[];
        };
      } | null;
      expect(dialogProps?.taskAwareActionDialog).toMatchObject({
        open: true,
        mode: 'single',
        operation: 'delete',
        chatIds: ['chat-busy'],
      });
    });
  });

  it('does not ask about live tasks when the confirm is cancelled', async () => {
    const onChatDelete = getOnChatDelete();
    hoisted.getActiveLinkedTasksForChatIdsWithFallbackMock.mockClear();
    await answerConfirm(() => onChatDelete('chat-busy', 'Busy chat'), 'cancel');

    expect(hoisted.getActiveLinkedTasksForChatIdsWithFallbackMock).not.toHaveBeenCalled();
  });

  it('refetches list counts and batch views after delete, without broad chat list invalidation', async () => {
    const onChatDelete = getOnChatDelete();
    await answerConfirm(() => onChatDelete('chat-del-1'), 'confirm');
    expect(hoisted.chatDeleteMutateAsyncMock).toHaveBeenCalledWith({ id: 'chat-del-1' });
    expect(hoisted.chatsListInvalidateMock).not.toHaveBeenCalled();
    expect(hoisted.chatsListByFolderInvalidateMock).not.toHaveBeenCalled();
    expect(hoisted.chatsListPinnedInvalidateMock).not.toHaveBeenCalled();
    expect(hoisted.chatsListBatchGroupsInvalidateMock).toHaveBeenCalledTimes(1);
    expect(hoisted.chatsListCountsInvalidateMock).toHaveBeenCalledTimes(1);
    expect(hoisted.chatsListCountsFetchMock).toHaveBeenCalledTimes(1);
  });

  it('warns and full-refreshes when delete succeeds but listCounts refetch fails', async () => {
    const toastWarningSpy = vi.spyOn(toast, 'warning').mockReturnValue('toast-id');
    hoisted.chatsListCountsFetchMock.mockRejectedValueOnce(new Error('counts sync failed'));
    const onChatDelete = getOnChatDelete();
    await answerConfirm(() => onChatDelete('chat-del-refetch-fail'), 'confirm');
    expect(toastWarningSpy).toHaveBeenCalledWith(
      'Chat deleted; refreshing sidebar',
      expect.objectContaining({
        description: expect.stringContaining('counts sync failed'),
      }),
    );
    expect(hoisted.chatsListInvalidateMock).toHaveBeenCalled();
    toastWarningSpy.mockRestore();
  });
});
