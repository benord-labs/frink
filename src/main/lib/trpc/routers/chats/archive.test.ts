/**
 * Phase 1 local-first migration: archive flow now writes to local SQLite directly.
 * Worktree teardown is stubbed at the router/helper seam — what the router hands the helper and
 * what it does with the result is asserted here; the helper's own git and sibling-fork logic is
 * covered in teardown-worktree.test.ts.
 */

import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { Chat } from '../../../db/schema';
import { makeLocalChat } from './test-factories';

const archiveChatLocalMock = vi.fn();
const unarchiveChatLocalMock = vi.fn();
const getChatByIdLocalMock = vi.fn();
const updateChatLocalMock = vi.fn();
const trackWorkspaceArchivedMock = vi.fn();
const clearCodexSessionMock = vi.fn();
const killByWorkspaceIdMock = vi.fn();
const cancelFlowRunsForChatMock = vi.fn();
const tearDownChatWorktreeMock = vi.fn();

vi.mock('../../../db', () => ({ getDatabase: () => ({}) }));
vi.mock('../../../db/repos/chats', () => ({
  archiveChat: archiveChatLocalMock,
  unarchiveChat: unarchiveChatLocalMock,
  getChatById: getChatByIdLocalMock,
  updateChat: updateChatLocalMock,
}));
vi.mock('../../../db/repos/sub-chats', () => ({
  // Inline factory so vi.resetAllMocks() in beforeEach can't strip the implementation.
  listSubChatsByChat: vi.fn(() => Promise.resolve([])),
}));
vi.mock('../../../db/schema', () => ({ projects: {} }));
vi.mock('../../../analytics', () => ({ trackWorkspaceArchived: trackWorkspaceArchivedMock }));
vi.mock('../../../socket/executor', () => ({
  clearCodexSession: clearCodexSessionMock,
  abortActiveExecutionsForSubChats: vi.fn(),
}));
vi.mock('../../../terminal/manager', () => ({
  terminalManager: { killByWorkspaceId: killByWorkspaceIdMock },
}));
vi.mock('../../../git/cache', () => ({
  gitCache: { invalidateStatus: vi.fn(), invalidateParsedDiff: vi.fn() },
}));
// Stubbed at the router/helper seam: tearDownChatWorktree owns the sibling-fork check and the git
// calls, and is covered directly in teardown-worktree.test.ts. Mocking it keeps node:fs, drizzle and
// the git layer out of this suite while still letting us assert what the router hands it.
vi.mock('./teardown-worktree', () => ({ tearDownChatWorktree: tearDownChatWorktreeMock }));
vi.mock('../../../flows/engine', () => ({ cancelFlowRunsForChat: cancelFlowRunsForChatMock }));

describe('archiveRouter (local-first)', () => {
  beforeEach(() => {
    vi.resetAllMocks();
    // The router tracks running teardowns in module scope, so a fresh import per test stops a
    // still-pending entry from suppressing a later test's teardown.
    vi.resetModules();
    killByWorkspaceIdMock.mockResolvedValue({ killed: 0 });
  });

  it('archives a chat through the local repo and tracks analytics', async () => {
    const archived = makeLocalChat({ id: 'c1', archivedAt: new Date() });
    getChatByIdLocalMock.mockResolvedValue(makeLocalChat({ id: 'c1' }));
    archiveChatLocalMock.mockResolvedValue(archived);

    const { archiveRouter } = await import('./archive');
    const caller = archiveRouter.createCaller({ getWindow: () => null });

    const result = await caller.archive({ id: 'c1', deleteWorktree: false, killTerminals: false });

    expect(archiveChatLocalMock).toHaveBeenCalledWith(expect.anything(), 'c1');
    expect(trackWorkspaceArchivedMock).toHaveBeenCalledWith('c1');
    expect(clearCodexSessionMock).toHaveBeenCalledWith('c1');
    expect(cancelFlowRunsForChatMock).toHaveBeenCalledWith('c1');
    expect(result?.id).toBe('c1');
  });

  it('returns null and cancels no flows when the local repo has no chat to archive', async () => {
    getChatByIdLocalMock.mockResolvedValue(null);
    archiveChatLocalMock.mockResolvedValue(null);

    const { archiveRouter } = await import('./archive');
    const caller = archiveRouter.createCaller({ getWindow: () => null });

    const result = await caller.archive({
      id: 'unknown',
      deleteWorktree: false,
      killTerminals: false,
    });
    expect(result).toBeNull();
    expect(cancelFlowRunsForChatMock).not.toHaveBeenCalled();
  });

  it('restore unarchives via the local repo', async () => {
    unarchiveChatLocalMock.mockResolvedValue(makeLocalChat({ id: 'c1', archivedAt: null }));

    const { archiveRouter } = await import('./archive');
    const caller = archiveRouter.createCaller({ getWindow: () => null });

    const result = await caller.restore({ id: 'c1' });
    expect(unarchiveChatLocalMock).toHaveBeenCalledWith(expect.anything(), 'c1');
    expect(result?.id).toBe('c1');
  });

  it('restore returns null when the local repo has nothing to unarchive', async () => {
    unarchiveChatLocalMock.mockResolvedValue(null);

    const { archiveRouter } = await import('./archive');
    const caller = archiveRouter.createCaller({ getWindow: () => null });

    await expect(caller.restore({ id: 'gone' })).resolves.toBeNull();
  });

  it('archiveBatch short-circuits on empty input without touching the repo', async () => {
    const { archiveRouter } = await import('./archive');
    const caller = archiveRouter.createCaller({ getWindow: () => null });

    await expect(caller.archiveBatch({ chatIds: [] })).resolves.toEqual([]);
    expect(archiveChatLocalMock).not.toHaveBeenCalled();
    expect(cancelFlowRunsForChatMock).not.toHaveBeenCalled();
  });

  it('archiveBatch archives multiple chats and skips nulls in the response', async () => {
    archiveChatLocalMock
      .mockResolvedValueOnce(makeLocalChat({ id: 'c1', archivedAt: new Date() }))
      .mockResolvedValueOnce(null)
      .mockResolvedValueOnce(makeLocalChat({ id: 'c3', archivedAt: new Date() }));

    const { archiveRouter } = await import('./archive');
    const caller = archiveRouter.createCaller({ getWindow: () => null });

    const result = await caller.archiveBatch({ chatIds: ['c1', 'c2', 'c3'] });
    expect(result.map((c) => c.id)).toEqual(['c1', 'c3']);
    for (const id of ['c1', 'c2', 'c3']) {
      expect(cancelFlowRunsForChatMock).toHaveBeenCalledWith(id);
    }
  });

  /**
   * The only destructive path in this router: it removes a worktree and then nulls worktreePath so a
   * later restore can't point at a directory that is gone. It runs detached from the mutation, so a
   * regression here fails silently — these pin the seam between the router and the teardown helper.
   */
  describe('worktree teardown', () => {
    const worktreeChat = (overrides: Partial<Chat> = {}) =>
      makeLocalChat({
        id: 'c1',
        worktreePath: '/wt/c1',
        branch: 'feat/x',
        projectId: 'p1',
        ...overrides,
      });

    const archiveWithWorktree = async (chat: Chat) => {
      // The pre-read sees a live chat; the re-check inside teardown sees it archived.
      getChatByIdLocalMock
        .mockResolvedValueOnce(chat)
        .mockResolvedValue({ ...chat, archivedAt: new Date() });
      archiveChatLocalMock.mockResolvedValue(
        makeLocalChat({ id: chat.id, archivedAt: new Date() }),
      );
      // Must resolve: the teardown helper calls .catch() on this return value, and the mutation
      // never awaits the teardown promise — so a mock returning undefined raises a TypeError that
      // surfaces as an unhandled rejection, exiting the runner non-zero while every test passes.
      updateChatLocalMock.mockResolvedValue(chat);

      const { archiveRouter } = await import('./archive');
      const caller = archiveRouter.createCaller({ getWindow: () => null });
      return caller.archive({ id: chat.id, deleteWorktree: true, killTerminals: true });
    };

    /** Teardown is detached from the mutation; let it settle rather than assume an await depth. */
    const flushTeardown = async () => {
      await vi.waitFor(() => expect(tearDownChatWorktreeMock).toHaveBeenCalled());
      await new Promise((resolve) => setTimeout(resolve, 0));
    };

    it('tears down using the pre-archive row and nulls worktreePath once the worktree is gone', async () => {
      tearDownChatWorktreeMock.mockResolvedValue(true);

      await archiveWithWorktree(worktreeChat());

      // The ref must carry the worktree fields read BEFORE archived_at was flipped.
      expect(tearDownChatWorktreeMock).toHaveBeenCalledWith(expect.anything(), {
        id: 'c1',
        worktreePath: '/wt/c1',
        branch: 'feat/x',
        projectId: 'p1',
      });
      await vi.waitFor(() =>
        expect(updateChatLocalMock).toHaveBeenCalledWith(expect.anything(), 'c1', {
          worktreePath: null,
        }),
      );

      const { gitCache } = await import('../../../git/cache');
      expect(gitCache.invalidateStatus).toHaveBeenCalledWith('/wt/c1');
      expect(gitCache.invalidateParsedDiff).toHaveBeenCalledWith('/wt/c1');
      expect(killByWorkspaceIdMock).toHaveBeenCalledWith('c1');
    });

    it('keeps worktreePath when teardown declines, so a fork sharing the worktree survives', async () => {
      tearDownChatWorktreeMock.mockResolvedValue(false);

      await archiveWithWorktree(worktreeChat());
      await flushTeardown();

      expect(updateChatLocalMock).not.toHaveBeenCalled();
    });

    it('skips teardown for a chat that has a worktree path but no branch', async () => {
      await archiveWithWorktree(worktreeChat({ branch: null }));

      expect(tearDownChatWorktreeMock).not.toHaveBeenCalled();
    });

    it('does not remove the worktree of a chat that was restored while teardown was in flight', async () => {
      tearDownChatWorktreeMock.mockResolvedValue(true);
      unarchiveChatLocalMock.mockResolvedValue(worktreeChat());
      // Every read sees an active chat: the undo lands before teardown re-checks the row.
      getChatByIdLocalMock.mockResolvedValue(worktreeChat());
      archiveChatLocalMock.mockResolvedValue(makeLocalChat({ id: 'c1', archivedAt: new Date() }));
      updateChatLocalMock.mockResolvedValue(worktreeChat());

      const { archiveRouter } = await import('./archive');
      const caller = archiveRouter.createCaller({ getWindow: () => null });

      await caller.archive({ id: 'c1', deleteWorktree: true, killTerminals: false });
      await caller.restore({ id: 'c1' });
      await new Promise((resolve) => setTimeout(resolve, 0));

      // git worktree remove runs with --force and no dirty-work check, so removing the worktree of a
      // chat the user just restored destroys uncommitted work and strands the chat on a gone path.
      expect(tearDownChatWorktreeMock).not.toHaveBeenCalled();
      expect(updateChatLocalMock).not.toHaveBeenCalledWith(expect.anything(), 'c1', {
        worktreePath: null,
      });
    });

    it('aborts running executions before tearing the worktree down even if the sub-chat lookup fails', async () => {
      const { listSubChatsByChat } = await import('../../../db/repos/sub-chats');
      vi.mocked(listSubChatsByChat).mockRejectedValue(new Error('database is locked'));
      tearDownChatWorktreeMock.mockResolvedValue(true);

      await archiveWithWorktree(worktreeChat());
      await new Promise((resolve) => setTimeout(resolve, 0));

      // A failed lookup means we cannot know which executions are live, and aborting an empty list
      // is a no-op — so removing the worktree would yank it from under a still-streaming agent.
      expect(tearDownChatWorktreeMock).not.toHaveBeenCalled();
    });

    it('makes restore wait for a running teardown instead of unarchiving into it', async () => {
      let settleTeardown: (removed: boolean) => void = () => {};
      tearDownChatWorktreeMock.mockReturnValue(
        new Promise<boolean>((resolve) => {
          settleTeardown = resolve;
        }),
      );
      unarchiveChatLocalMock.mockResolvedValue(worktreeChat());

      await archiveWithWorktree(worktreeChat());

      const { archiveRouter } = await import('./archive');
      const caller = archiveRouter.createCaller({ getWindow: () => null });
      let settled = false;
      const restoring = caller.restore({ id: 'c1' }).then(() => {
        settled = true;
      });
      await new Promise((resolve) => setTimeout(resolve, 0));

      // Removal is already underway, so restore must not report success over the top of it.
      expect(settled).toBe(false);
      expect(unarchiveChatLocalMock).not.toHaveBeenCalled();

      settleTeardown(true);
      await restoring;
      expect(unarchiveChatLocalMock).toHaveBeenCalledWith(expect.anything(), 'c1');
    });

    it('does not tear the same worktree down twice when two panes archive the chat at once', async () => {
      tearDownChatWorktreeMock.mockResolvedValue(true);
      getChatByIdLocalMock.mockResolvedValue(worktreeChat({ archivedAt: new Date() }));
      archiveChatLocalMock.mockResolvedValue(makeLocalChat({ id: 'c1', archivedAt: new Date() }));
      updateChatLocalMock.mockResolvedValue(worktreeChat());

      const { archiveRouter } = await import('./archive');
      const caller = archiveRouter.createCaller({ getWindow: () => null });
      const archiveOnce = () =>
        caller.archive({ id: 'c1', deleteWorktree: true, killTerminals: false });

      await Promise.all([archiveOnce(), archiveOnce()]);
      await flushTeardown();

      expect(tearDownChatWorktreeMock).toHaveBeenCalledTimes(1);
    });
  });

  describe('archiveBatch edge cases', () => {
    it('archives a chat once when the same id appears twice in the batch', async () => {
      archiveChatLocalMock.mockResolvedValue(makeLocalChat({ id: 'c1', archivedAt: new Date() }));

      const { archiveRouter } = await import('./archive');
      const caller = archiveRouter.createCaller({ getWindow: () => null });

      // Multi-select UIs can hand the same id over twice; a duplicated row breaks list rendering
      // downstream and double-cancels the chat's flow runs.
      const result = await caller.archiveBatch({ chatIds: ['c1', 'c1'] });
      expect(result.map((c) => c.id)).toEqual(['c1']);
    });

    it('invalidates the git cache for batch-archived chats that own a worktree', async () => {
      archiveChatLocalMock.mockResolvedValue(
        makeLocalChat({ id: 'c1', worktreePath: '/wt/c1', archivedAt: new Date() }),
      );

      const { archiveRouter } = await import('./archive');
      const caller = archiveRouter.createCaller({ getWindow: () => null });
      await caller.archiveBatch({ chatIds: ['c1'] });

      // Single archive invalidates; batch archiving the same chat must not leave a stale status/diff
      // entry keyed on a worktree the sidebar no longer shows.
      const { gitCache } = await import('../../../git/cache');
      expect(gitCache.invalidateStatus).toHaveBeenCalledWith('/wt/c1');
    });
  });
});
