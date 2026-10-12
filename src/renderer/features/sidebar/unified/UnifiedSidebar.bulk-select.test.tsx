// @vitest-environment happy-dom
import { act, render, waitFor } from '@testing-library/react';
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { hoisted, resetHarness, setupHarness } from './sidebar-test-harness';
import { UnifiedSidebar } from './UnifiedSidebar';

// oxlint-disable anti-slop/no-module-mocking -- vitest requires vi.mock per file; these all
// delegate to the shared sidebar-test-harness rather than defining new mock behaviour.
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

type DialogProps = {
  taskAwareActionDialog: { open: boolean; mode: string; operation: string; chatIds: string[] };
  onTaskAwareActionCancelAndContinue: () => Promise<void>;
};

function chipProps() {
  const props = hoisted.capturedChatSelectionChipProps;
  if (!props) throw new Error('ChatSelectionChip was not rendered');
  return props;
}

function dialogProps() {
  // SAFETY: the SidebarDialogs double captures the props UnifiedSidebar rendered it with, which
  // include the task-aware dialog state and its callbacks.
  return hoisted.capturedSidebarDialogsProps as DialogProps;
}

describe('UnifiedSidebar multi-select bulk actions', () => {
  it('confirms, then deletes every selected chat', async () => {
    render(<UnifiedSidebar />);
    await act(() => chipProps().onDelete(['chat-a', 'chat-b']));
    expect(hoisted.chatDeleteMutateAsyncMock).not.toHaveBeenCalled();
    expect(chipProps().pendingDeleteCount).toBe(2);

    await act(() => chipProps().onConfirmDelete());

    expect(hoisted.chatDeleteMutateAsyncMock).toHaveBeenCalledWith({ id: 'chat-a' });
    expect(hoisted.chatDeleteMutateAsyncMock).toHaveBeenCalledWith({ id: 'chat-b' });
    expect(chipProps().pendingDeleteCount).toBe(0);
  });

  // Archive stops linked tasks in the main process, so bulk archive never cancels from a snapshot.
  it('archives every selected chat at once, even with a live linked task', async () => {
    hoisted.getActiveLinkedTasksForChatIdsWithFallbackMock.mockResolvedValue({
      activeTasks: [{ taskId: 'task-1', chatId: 'chat-a' }],
      unresolvedTaskLinks: 0,
    });
    render(<UnifiedSidebar />);
    await act(() => chipProps().onArchive(['chat-a', 'chat-b']));

    await waitFor(() => expect(hoisted.archiveChatMutateAsyncMock).toHaveBeenCalledTimes(2));
    expect(hoisted.archiveChatMutateAsyncMock).toHaveBeenCalledWith({ id: 'chat-a' });
    expect(hoisted.archiveChatMutateAsyncMock).toHaveBeenCalledWith({ id: 'chat-b' });
    expect(dialogProps().taskAwareActionDialog.open).toBe(false);
    expect(hoisted.getActiveLinkedTasksForChatIdsWithFallbackMock).not.toHaveBeenCalled();
    expect(hoisted.cancelTasksBestEffortMock).not.toHaveBeenCalled();
    expect(hoisted.chatDeleteMutateAsyncMock).not.toHaveBeenCalled();
  });
});
