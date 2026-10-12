// @vitest-environment happy-dom
import { act, render, waitFor } from '@testing-library/react';
import { createRef } from 'react';
import { toast } from 'sonner';
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { hoisted, overlayStub, resetHarness, setupHarness } from './sidebar-test-harness';
import { UnifiedSidebar, type UnifiedSidebarHandle } from './UnifiedSidebar';

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

type ToastAction = { action: { label: string; onClick: () => void } };

const focusPane = (chatId: string) => {
  hoisted.state.splitViewState = {
    splitView: { chatIds: ['chat-other', chatId], activePaneIndex: 1 },
    isSplitActive: true,
  };
};

/** Mounts the sidebar and returns the archive shortcut as the layout invokes it: via the handle. */
function renderSidebar(): (times?: number) => Promise<void> {
  const handle = createRef<UnifiedSidebarHandle>();
  render(<UnifiedSidebar ref={handle} />);
  return (times = 1) =>
    act(async () => {
      for (let i = 0; i < times; i++) handle.current?.archiveFocusedChat();
    });
}

// The layout runs the archive shortcut through the sidebar's handle. It follows the row action's
// rules, so the server stops the chat's replies, flow runs and terminals.
describe('UnifiedSidebar archive-focused-chat hotkey', () => {
  it('archives the active pane chat (not the stale selection) at once and offers Restore', async () => {
    const successSpy = vi.spyOn(toast, 'success').mockReturnValue('toast-id');
    const warningSpy = vi.spyOn(toast, 'warning').mockReturnValue('toast-id');
    focusPane('chat-focused');
    const pressArchiveHotkey = renderSidebar();

    await pressArchiveHotkey();

    await waitFor(() =>
      // No killTerminals override: the server default kills the chat's terminals.
      expect(hoisted.archiveChatMutateAsyncMock).toHaveBeenCalledWith({ id: 'chat-focused' }),
    );
    await waitFor(() => expect(successSpy).toHaveBeenCalled());
    expect(warningSpy).not.toHaveBeenCalled();
    expect(successSpy.mock.calls[0]?.[0]).toBe('Chat archived');
    // SAFETY: the hotkey path always hands sonner a `{ label, onClick }` action object.
    const { action } = successSpy.mock.calls[0]?.[1] as ToastAction;
    expect(action.label).toBe('Restore');

    await act(async () => action.onClick());
    expect(hoisted.restoreMutateAsyncMock).toHaveBeenCalledWith({ id: 'chat-focused' });
    successSpy.mockRestore();
    warningSpy.mockRestore();
  });

  it('does nothing when no chat is focused', async () => {
    const pressArchiveHotkey = renderSidebar();

    await pressArchiveHotkey();

    expect(hoisted.getActiveLinkedTasksForChatIdsWithFallbackMock).not.toHaveBeenCalled();
    expect(hoisted.archiveChatMutateAsyncMock).not.toHaveBeenCalled();
  });

  // Archive stops the linked task in the main process, so the shortcut never cancels from a snapshot.
  it('archives at once when the chat has an active linked task, without the task dialog', async () => {
    vi.spyOn(toast, 'success').mockReturnValue('toast-id');
    focusPane('chat-task');
    hoisted.getActiveLinkedTasksForChatIdsWithFallbackMock.mockResolvedValue({
      activeTasks: [{ taskId: 'task-1', chatId: 'chat-task' }],
      unresolvedTaskLinks: 0,
    });
    const pressArchiveHotkey = renderSidebar();

    await pressArchiveHotkey();

    await waitFor(() =>
      expect(hoisted.archiveChatMutateAsyncMock).toHaveBeenCalledWith({ id: 'chat-task' }),
    );
    expect(hoisted.capturedSidebarDialogsProps?.taskAwareActionDialog).toMatchObject({
      open: false,
    });
    expect(hoisted.getActiveLinkedTasksForChatIdsWithFallbackMock).not.toHaveBeenCalled();
    expect(hoisted.cancelTasksBestEffortMock).not.toHaveBeenCalled();
  });

  // A split pane can hold the new-chat placeholder. Its sentinel id is not a chat, so
  // archiving it would clear the new-chat pane and fire a doomed mutation.
  it('ignores a split pane showing the new-chat form', async () => {
    focusPane('__new__');
    const pressArchiveHotkey = renderSidebar();

    await pressArchiveHotkey();

    expect(hoisted.getActiveLinkedTasksForChatIdsWithFallbackMock).not.toHaveBeenCalled();
    expect(hoisted.archiveChatMutateAsyncMock).not.toHaveBeenCalled();
    expect(hoisted.clearPaneAtMock).not.toHaveBeenCalled();
  });

  // Work Queue, Flows and Settings cover the chat while the sidebar keeps its selection, so
  // the hotkey there would archive a chat the user cannot see.
  it.each<'workqueue' | 'flows' | 'settings'>(['workqueue', 'flows', 'settings'])(
    'does nothing while the %s overlay hides the chat',
    async (overlay) => {
      overlayStub.value = overlay;
      focusPane('chat-hidden');
      const pressArchiveHotkey = renderSidebar();

      await pressArchiveHotkey();

      expect(hoisted.archiveChatMutateAsyncMock).not.toHaveBeenCalled();
    },
  );

  // Holding the hotkey auto-repeats keydown. Every repeat lands before the first archive
  // settles, because the task preflight is async.
  it('archives once when the hotkey repeats before the first archive settles', async () => {
    const successSpy = vi.spyOn(toast, 'success').mockReturnValue('toast-id');
    focusPane('chat-repeat');
    const pressArchiveHotkey = renderSidebar();

    await pressArchiveHotkey(3);

    await waitFor(() => expect(hoisted.archiveChatMutateAsyncMock).toHaveBeenCalledTimes(1));
    expect(successSpy).toHaveBeenCalledTimes(1);
    successSpy.mockRestore();
  });

  // The chat is archived once the mutation lands; a refresh that fails afterwards is not a failed
  // archive, and must not skip the success path.
  it('still reports success when the list refresh after the archive fails', async () => {
    const successSpy = vi.spyOn(toast, 'success').mockReturnValue('toast-id');
    const errorSpy = vi.spyOn(toast, 'error').mockReturnValue('toast-id');
    focusPane('chat-refresh');
    hoisted.chatsListInvalidateMock.mockRejectedValueOnce(new Error('refresh boom'));
    const pressArchiveHotkey = renderSidebar();

    await pressArchiveHotkey();

    await waitFor(() => expect(successSpy).toHaveBeenCalled());
    expect(errorSpy).not.toHaveBeenCalled();
    successSpy.mockRestore();
    errorSpy.mockRestore();
  });

  it('reports a failed archive without a success toast', async () => {
    const successSpy = vi.spyOn(toast, 'success').mockReturnValue('toast-id');
    const errorSpy = vi.spyOn(toast, 'error').mockReturnValue('toast-id');
    focusPane('chat-fail');
    hoisted.archiveChatMutateAsyncMock.mockRejectedValueOnce(new Error('archive boom'));
    const pressArchiveHotkey = renderSidebar();

    await pressArchiveHotkey();

    await waitFor(() =>
      expect(errorSpy).toHaveBeenCalledWith(
        'Failed to archive chat',
        expect.objectContaining({ description: expect.stringContaining('archive boom') }),
      ),
    );
    expect(successSpy).not.toHaveBeenCalled();
    successSpy.mockRestore();
    errorSpy.mockRestore();
  });
});
