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
  onTaskAwareActionKeepRunning: () => Promise<void>;
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

  it('stops the linked tasks and kills terminals when bulk archive is confirmed with "Stop task"', async () => {
    hoisted.getActiveLinkedTasksForChatIdsWithFallbackMock.mockResolvedValue({
      activeTasks: [{ taskId: 'task-1', chatId: 'chat-a' }],
      unresolvedTaskLinks: 0,
    });
    render(<UnifiedSidebar />);
    await act(() => chipProps().onArchive(['chat-a', 'chat-b']));

    await act(() => dialogProps().onTaskAwareActionCancelAndContinue());

    await waitFor(() => expect(hoisted.archiveChatMutateAsyncMock).toHaveBeenCalledTimes(2));
    expect(hoisted.cancelTasksBestEffortMock).toHaveBeenCalledWith(['task-1']);
    expect(hoisted.archiveChatMutateAsyncMock).toHaveBeenCalledWith({
      id: 'chat-b',
      killTerminals: true,
    });
    expect(hoisted.chatDeleteMutateAsyncMock).not.toHaveBeenCalled();
  });

  // The task-aware dialog's batch branch deletes; a bulk archive routed through it must archive.
  it('archives, never deletes, when a live linked task sends bulk archive through the dialog', async () => {
    hoisted.getActiveLinkedTasksForChatIdsWithFallbackMock.mockResolvedValue({
      activeTasks: [{ taskId: 'task-1', chatId: 'chat-a' }],
      unresolvedTaskLinks: 0,
    });
    render(<UnifiedSidebar />);
    await act(() => chipProps().onArchive(['chat-a', 'chat-b']));

    expect(dialogProps().taskAwareActionDialog).toMatchObject({
      open: true,
      mode: 'batch',
      operation: 'archive_batch',
      chatIds: ['chat-a', 'chat-b'],
    });
    expect(hoisted.archiveChatMutateAsyncMock).not.toHaveBeenCalled();

    await act(() => dialogProps().onTaskAwareActionKeepRunning());

    await waitFor(() => expect(hoisted.archiveChatMutateAsyncMock).toHaveBeenCalledTimes(2));
    expect(hoisted.archiveChatMutateAsyncMock).toHaveBeenCalledWith({
      id: 'chat-a',
      killTerminals: false,
    });
    expect(hoisted.chatDeleteMutateAsyncMock).not.toHaveBeenCalled();
    expect(hoisted.cancelTasksBestEffortMock).not.toHaveBeenCalled();
  });
});
