// @vitest-environment happy-dom
import { act, fireEvent, render, screen } from '@testing-library/react';
import { toast } from 'sonner';
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { hoisted, resetHarness, setupHarness } from './sidebar-test-harness';
import { UnifiedSidebar } from './UnifiedSidebar';

// oxlint-disable anti-slop/no-module-mocking -- vitest requires vi.mock per file; these all
// delegate to the shared sidebar-test-harness rather than defining new mock behaviour.
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

// Module scope so both suites share it, and so the props assertion exists exactly once.
function getOnChatDelete(): (chatId: string) => Promise<void> {
  render(<UnifiedSidebar />);
  // ArchivedChatsSection only mounts once the footer toggle flips showArchived.
  fireEvent.click(screen.getByTestId('toggle-archived'));
  // SAFETY: the harness captures whatever props ArchivedChatsSection was rendered with, so the
  // shape is unknown to the type system; the guard below rejects anything without onChatDelete.
  const props = hoisted.capturedArchivedChatsSectionProps as {
    onChatDelete?: (chatId: string) => Promise<void>;
  } | null;
  if (!props?.onChatDelete) {
    throw new Error('onChatDelete not found in ArchivedChatsSection props');
  }
  return props.onChatDelete;
}

describe('UnifiedSidebar delete archived chat', () => {
  it('refreshes listArchived so a deleted chat leaves the list and the footer badge', async () => {
    const onChatDelete = getOnChatDelete();

    await act(async () => {
      await onChatDelete('chat-1');
    });

    expect(hoisted.chatDeleteMutateAsyncMock).toHaveBeenCalledWith({ id: 'chat-1' });
    expect(hoisted.chatsListArchivedInvalidateMock).toHaveBeenCalled();
  });

  // Batch rows are keyed by batch_id and cached; without a refetch the deleted member lingers as a
  // task row whose tasks are gone, which renders grey with no status and reads as cancelled.
  it('refetches the batch views so a deleted batch member does not linger', async () => {
    const onChatDelete = getOnChatDelete();

    await act(async () => {
      await onChatDelete('chat-1');
    });

    expect(hoisted.chatsListByBatchInvalidateMock).toHaveBeenCalled();
    expect(hoisted.chatsListBatchGroupsInvalidateMock).toHaveBeenCalled();
  });

  it('leaves the archived list untouched when the delete fails', async () => {
    const toastErrorSpy = vi.spyOn(toast, 'error').mockImplementation(() => '');
    hoisted.chatDeleteMutateAsyncMock.mockRejectedValueOnce(new Error('boom'));
    const onChatDelete = getOnChatDelete();

    await act(async () => {
      await onChatDelete('chat-1');
    });

    expect(hoisted.chatsListArchivedInvalidateMock).not.toHaveBeenCalled();
    expect(hoisted.chatsListByBatchInvalidateMock).not.toHaveBeenCalled();
    expect(toastErrorSpy).toHaveBeenCalledWith('Failed to delete chat', expect.anything());
    toastErrorSpy.mockRestore();
  });

  // A live linked task must be surfaced before the chat is destroyed, not orphaned by it.
  it('defers to the task-aware dialog instead of deleting outright', async () => {
    hoisted.getActiveLinkedTasksForChatIdsWithFallbackMock.mockResolvedValueOnce({
      activeTasks: [{ taskId: 'task-1', chatId: 'chat-1' }],
      unresolvedTaskLinks: 0,
    });
    const onChatDelete = getOnChatDelete();

    await act(async () => {
      await onChatDelete('chat-1');
    });

    expect(hoisted.chatDeleteMutateAsyncMock).not.toHaveBeenCalled();
  });
});

// The archived-list refresh now runs inside the shared post-mutation sync, so its failure has to
// degrade the same way a counts-sync failure does rather than escaping as an unhandled rejection.
describe('UnifiedSidebar archived-list refresh failure', () => {
  it('warns and full-refreshes when the archived-list refresh fails', async () => {
    const toastWarningSpy = vi.spyOn(toast, 'warning').mockReturnValue('toast-id');
    hoisted.chatsListArchivedInvalidateMock.mockRejectedValueOnce(
      new Error('archived sync failed'),
    );
    const onChatDelete = getOnChatDelete();

    await act(async () => {
      await onChatDelete('chat-1');
    });

    expect(toastWarningSpy).toHaveBeenCalledWith(
      'Chat deleted; refreshing sidebar',
      expect.objectContaining({ description: expect.stringContaining('archived sync failed') }),
    );
    expect(hoisted.chatsListInvalidateMock).toHaveBeenCalled();
    // The recovery refresh must cover the archived list too, or the deleted row survives the
    // failure it was meant to recover from. First call is the rejected one, second is recovery.
    expect(hoisted.chatsListArchivedInvalidateMock).toHaveBeenCalledTimes(2);
    toastWarningSpy.mockRestore();
  });
});
