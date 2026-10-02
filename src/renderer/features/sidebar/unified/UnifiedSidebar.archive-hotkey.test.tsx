// @vitest-environment happy-dom
import { act, render, waitFor } from '@testing-library/react';
import { toast } from 'sonner';
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { hoisted, resetHarness, setupHarness } from './sidebar-test-harness';
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

type ToastAction = { action: { label: string; onClick: () => void } };

const focusPane = (chatId: string) => {
  hoisted.state.splitViewState = {
    splitView: { chatIds: ['chat-other', chatId], activePaneIndex: 1 },
    isSplitActive: true,
  };
};

const pressArchiveHotkey = () =>
  act(async () => {
    window.dispatchEvent(new CustomEvent('sidebar:archive-focused-chat'));
  });

// sc-3840: Cmd+W (archive-agent) dispatches sidebar:archive-focused-chat. Archive aborts live
// turns/flow runs and restore can't revive them, so the hotkey must never stop running work silently.
describe('UnifiedSidebar archive-focused-chat hotkey (sc-3840)', () => {
  it('archives the active pane chat (not the stale selection), keeps terminals, offers Restore', async () => {
    const successSpy = vi.spyOn(toast, 'success').mockReturnValue('toast-id');
    focusPane('chat-focused');
    render(<UnifiedSidebar />);

    await pressArchiveHotkey();

    await waitFor(() =>
      expect(hoisted.archiveChatMutateAsyncMock).toHaveBeenCalledWith({
        id: 'chat-focused',
        killTerminals: false,
      }),
    );
    await waitFor(() => expect(successSpy).toHaveBeenCalled());
    const [title, options] = successSpy.mock.calls[0] as [string, ToastAction];
    expect(title).toBe('Chat archived');
    expect(options.action.label).toBe('Restore');

    await act(async () => options.action.onClick());
    expect(hoisted.restoreMutateAsyncMock).toHaveBeenCalledWith({ id: 'chat-focused' });
    successSpy.mockRestore();
  });

  it('does nothing when no chat is focused', async () => {
    render(<UnifiedSidebar />);

    await pressArchiveHotkey();

    expect(hoisted.getActiveLinkedTasksForChatIdsWithFallbackMock).not.toHaveBeenCalled();
    expect(hoisted.archiveChatMutateAsyncMock).not.toHaveBeenCalled();
  });

  it('asks before archiving a streaming chat, and archives only on "Archive anyway"', async () => {
    const warningSpy = vi.spyOn(toast, 'warning').mockReturnValue('toast-id');
    focusPane('chat-busy');
    hoisted.state.loadingSubChats = new Map([['sub-1', 'chat-busy']]);
    render(<UnifiedSidebar />);

    await pressArchiveHotkey();

    expect(warningSpy).toHaveBeenCalledWith('This chat is still running', expect.anything());
    expect(hoisted.archiveChatMutateAsyncMock).not.toHaveBeenCalled();

    const [, options] = warningSpy.mock.calls[0] as [string, ToastAction];
    expect(options.action.label).toBe('Archive anyway');
    await act(async () => options.action.onClick());
    await waitFor(() =>
      expect(hoisted.archiveChatMutateAsyncMock).toHaveBeenCalledWith(
        expect.objectContaining({ id: 'chat-busy' }),
      ),
    );
    warningSpy.mockRestore();
  });

  it('treats a live flow run as busy', async () => {
    const warningSpy = vi.spyOn(toast, 'warning').mockReturnValue('toast-id');
    focusPane('chat-flow');
    hoisted.state.activeChatsData = [{ chatId: 'chat-flow', hasLiveFlowRun: true }];
    render(<UnifiedSidebar />);

    await pressArchiveHotkey();

    expect(warningSpy).toHaveBeenCalledWith('This chat is still running', expect.anything());
    expect(hoisted.archiveChatMutateAsyncMock).not.toHaveBeenCalled();
    warningSpy.mockRestore();
  });

  it('defers to the task-aware dialog when the chat has an active linked task', async () => {
    focusPane('chat-task');
    hoisted.getActiveLinkedTasksForChatIdsWithFallbackMock.mockResolvedValueOnce({
      activeTasks: [{ taskId: 'task-1', chatId: 'chat-task' }],
      unresolvedTaskLinks: 0,
    });
    render(<UnifiedSidebar />);

    await pressArchiveHotkey();

    await waitFor(() =>
      expect(hoisted.getActiveLinkedTasksForChatIdsWithFallbackMock).toHaveBeenCalledWith([
        'chat-task',
      ]),
    );
    expect(hoisted.archiveChatMutateAsyncMock).not.toHaveBeenCalled();
  });

  // A split pane can hold the new-chat placeholder. Its sentinel id is not a chat, so
  // archiving it would clear the new-chat pane and fire a doomed mutation.
  it('ignores a split pane showing the new-chat form', async () => {
    focusPane('__new__');
    render(<UnifiedSidebar />);

    await pressArchiveHotkey();

    expect(hoisted.getActiveLinkedTasksForChatIdsWithFallbackMock).not.toHaveBeenCalled();
    expect(hoisted.archiveChatMutateAsyncMock).not.toHaveBeenCalled();
    expect(hoisted.clearPaneAtMock).not.toHaveBeenCalled();
  });

  // Work Queue, Flows and Settings cover the chat while the sidebar keeps its selection, so
  // Cmd+W there would archive a chat the user cannot see.
  it.each(['workqueue', 'flows', 'settings'] as const)(
    'does nothing while the %s overlay hides the chat',
    async (overlay) => {
      hoisted.state.activeOverlay = overlay;
      focusPane('chat-hidden');
      render(<UnifiedSidebar />);

      await pressArchiveHotkey();

      expect(hoisted.archiveChatMutateAsyncMock).not.toHaveBeenCalled();
    },
  );

  // Holding Cmd+W auto-repeats keydown. Every repeat lands before the first archive settles,
  // because the task preflight is async.
  it('archives once when Cmd+W repeats before the first archive settles', async () => {
    const successSpy = vi.spyOn(toast, 'success').mockReturnValue('toast-id');
    focusPane('chat-repeat');
    render(<UnifiedSidebar />);

    await act(async () => {
      for (let i = 0; i < 3; i++) {
        window.dispatchEvent(new CustomEvent('sidebar:archive-focused-chat'));
      }
    });

    await waitFor(() => expect(hoisted.archiveChatMutateAsyncMock).toHaveBeenCalledTimes(1));
    expect(successSpy).toHaveBeenCalledTimes(1);
    successSpy.mockRestore();
  });

  it('collapses repeated busy warnings for the same chat into one toast', async () => {
    const warningSpy = vi.spyOn(toast, 'warning').mockReturnValue('toast-id');
    focusPane('chat-busy');
    hoisted.state.loadingSubChats = new Map([['sub-1', 'chat-busy']]);
    render(<UnifiedSidebar />);

    await pressArchiveHotkey();
    await pressArchiveHotkey();

    const ids = warningSpy.mock.calls.map(([, opts]) => (opts as { id?: string }).id);
    expect(ids[0]).toBeDefined();
    expect(new Set(ids).size).toBe(1);
    warningSpy.mockRestore();
  });

  it('treats a held background turn as busy', async () => {
    const warningSpy = vi.spyOn(toast, 'warning').mockReturnValue('toast-id');
    focusPane('chat-held');
    hoisted.state.heldChatIds = new Set(['chat-held']);
    render(<UnifiedSidebar />);

    await pressArchiveHotkey();

    expect(warningSpy).toHaveBeenCalledWith('This chat is still running', expect.anything());
    expect(hoisted.archiveChatMutateAsyncMock).not.toHaveBeenCalled();
    warningSpy.mockRestore();
  });

  // The busy check must be per-chat: another chat streaming or running a flow must not block it.
  it('archives an idle chat while other chats are busy', async () => {
    const warningSpy = vi.spyOn(toast, 'warning').mockReturnValue('toast-id');
    focusPane('chat-idle');
    hoisted.state.loadingSubChats = new Map([['sub-x', 'chat-other']]);
    hoisted.state.heldChatIds = new Set(['chat-other']);
    hoisted.state.activeChatsData = [
      { chatId: 'chat-other', hasLiveFlowRun: true },
      { chatId: 'chat-idle', hasLiveFlowRun: false },
    ];
    render(<UnifiedSidebar />);

    await pressArchiveHotkey();

    await waitFor(() =>
      expect(hoisted.archiveChatMutateAsyncMock).toHaveBeenCalledWith(
        expect.objectContaining({ id: 'chat-idle' }),
      ),
    );
    expect(warningSpy).not.toHaveBeenCalled();
    warningSpy.mockRestore();
  });

  it('reports a failed archive without a success toast, and a retry can go through', async () => {
    const successSpy = vi.spyOn(toast, 'success').mockReturnValue('toast-id');
    const errorSpy = vi.spyOn(toast, 'error').mockReturnValue('toast-id');
    focusPane('chat-fail');
    hoisted.archiveChatMutateAsyncMock.mockRejectedValueOnce(new Error('archive boom'));
    render(<UnifiedSidebar />);

    await pressArchiveHotkey();

    await waitFor(() =>
      expect(errorSpy).toHaveBeenCalledWith(
        'Failed to archive chat',
        expect.objectContaining({ description: expect.stringContaining('archive boom') }),
      ),
    );
    expect(successSpy).not.toHaveBeenCalled();

    // The in-flight guard must release on failure, or the chat could never be archived by hotkey again.
    await pressArchiveHotkey();
    await waitFor(() => expect(hoisted.archiveChatMutateAsyncMock).toHaveBeenCalledTimes(2));
    successSpy.mockRestore();
    errorSpy.mockRestore();
  });
});
