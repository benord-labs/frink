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
const abortActiveExecutionsForChatMock = vi.fn();

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
  abortActiveExecutionsForChat: abortActiveExecutionsForChatMock,
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

    it('skips worktree teardown when the sub-chat lookup fails, since live runs cannot be proven stopped', async () => {
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

  /** sc-682: nothing may keep running after archive — sweep by chat id, write, then doom sends still
   * mid-admission and sweep again. */
  describe("stopping the chat's agents", () => {
    const load = async () => {
      const { archiveRouter } = await import('./archive');
      const registry = await import('../../../socket/streaming/execution-registry');
      return { caller: archiveRouter.createCaller({ getWindow: () => null }), registry };
    };
    const archived = (id: string) => makeLocalChat({ id, archivedAt: new Date() });
    const archiveC1 = (caller: Awaited<ReturnType<typeof load>>['caller']) =>
      caller.archive({ id: 'c1', deleteWorktree: false, killTerminals: false });

    it('sweeps, writes, then dooms sends mid-admission and sweeps again', async () => {
      const { caller, registry } = await load();
      const midAdmission = registry.openAdmission('c1');
      const order: string[] = [];
      getChatByIdLocalMock.mockResolvedValue(makeLocalChat({ id: 'c1' }));
      abortActiveExecutionsForChatMock.mockImplementation(() => order.push('sweep'));
      archiveChatLocalMock.mockImplementation(async () => {
        // A send holding the pre-archive row is only doomed once archived_at has landed.
        order.push(midAdmission.doomed ? 'write(doomed)' : 'write');
        return archived('c1');
      });

      await archiveC1(caller);

      expect(order).toEqual(['sweep', 'write', 'sweep']);
      expect(midAdmission.doomed).toBe(true);
    });

    it("still stops the chat's agents when the sub-chat lookup fails", async () => {
      const { listSubChatsByChat } = await import('../../../db/repos/sub-chats');
      vi.mocked(listSubChatsByChat).mockRejectedValue(new Error('database is locked'));
      getChatByIdLocalMock.mockResolvedValue(makeLocalChat({ id: 'c1' }));
      archiveChatLocalMock.mockResolvedValue(archived('c1'));
      const { caller } = await load();

      await archiveC1(caller);

      expect(abortActiveExecutionsForChatMock).toHaveBeenCalledWith('c1', 'chat archived');
    });

    it("still stops the chat's agents when the chat row read fails", async () => {
      getChatByIdLocalMock.mockRejectedValue(new Error('database is locked'));
      archiveChatLocalMock.mockResolvedValue(archived('c1'));
      const { caller } = await load();

      await archiveC1(caller);

      expect(abortActiveExecutionsForChatMock).toHaveBeenCalledWith('c1', 'chat archived');
    });

    it('neither dooms nor re-sweeps when there was no chat to archive', async () => {
      getChatByIdLocalMock.mockResolvedValue(null);
      archiveChatLocalMock.mockResolvedValue(null);
      const { caller, registry } = await load();
      const midAdmission = registry.openAdmission('c1');

      await archiveC1(caller);

      expect(midAdmission.doomed).toBe(false);
      expect(abortActiveExecutionsForChatMock).toHaveBeenCalledTimes(1);
    });

    it('does not doom sends when the archive write fails', async () => {
      getChatByIdLocalMock.mockResolvedValue(makeLocalChat({ id: 'c1' }));
      archiveChatLocalMock.mockRejectedValue(new Error('disk full'));
      const { caller, registry } = await load();
      const midAdmission = registry.openAdmission('c1');

      await expect(archiveC1(caller)).rejects.toThrow('disk full');

      // The chat is still active, so a send mid-admission must go through.
      expect(midAdmission.doomed).toBe(false);
    });

    it('makes a concurrent restore wait for the archive write', async () => {
      const order: string[] = [];
      let finishWrite: () => void = () => {};
      getChatByIdLocalMock.mockResolvedValue(makeLocalChat({ id: 'c1' }));
      archiveChatLocalMock.mockReturnValue(
        new Promise((resolve) => {
          finishWrite = () => {
            order.push('write');
            resolve(archived('c1'));
          };
        }),
      );
      unarchiveChatLocalMock.mockImplementation(async () => {
        order.push('unarchive');
        return makeLocalChat({ id: 'c1', archivedAt: null });
      });
      const { caller } = await load();

      const archiving = archiveC1(caller);
      await vi.waitFor(() => expect(archiveChatLocalMock).toHaveBeenCalled());
      const restoring = caller.restore({ id: 'c1' });
      await new Promise((resolve) => setTimeout(resolve, 0));
      expect(unarchiveChatLocalMock).not.toHaveBeenCalled();

      finishWrite();
      await Promise.all([archiving, restoring]);

      expect(order).toEqual(['write', 'unarchive']);
    });

    it('archiveOutcome waits for an in-flight archive before reporting it (renderer reload)', async () => {
      let finishWrite: () => void = () => {};
      let written = false;
      getChatByIdLocalMock.mockImplementation(async () =>
        makeLocalChat({ id: 'c1', archivedAt: written ? new Date() : null }),
      );
      archiveChatLocalMock.mockReturnValue(
        new Promise((resolve) => {
          finishWrite = () => {
            written = true;
            resolve(archived('c1'));
          };
        }),
      );
      const { caller } = await load();

      const archiving = archiveC1(caller);
      await vi.waitFor(() => expect(archiveChatLocalMock).toHaveBeenCalled());
      let outcome: unknown;
      const asking = caller.archiveOutcome({ id: 'c1' }).then((value) => {
        outcome = value;
      });
      await new Promise((resolve) => setTimeout(resolve, 0));
      // Reading now would see the pre-archive row and release the restored queue too early.
      expect(outcome).toBeUndefined();

      finishWrite();
      await Promise.all([archiving, asking]);
      expect(outcome).toEqual({ archived: true });
    });

    it('archiveOutcome reports a missing chat as null and an active one as not archived', async () => {
      const { caller } = await load();
      getChatByIdLocalMock.mockResolvedValueOnce(null);
      await expect(caller.archiveOutcome({ id: 'gone' })).resolves.toBeNull();
      getChatByIdLocalMock.mockResolvedValueOnce(makeLocalChat({ id: 'c1', archivedAt: null }));
      await expect(caller.archiveOutcome({ id: 'c1' })).resolves.toEqual({ archived: false });
    });

    it('makes a restore issued before the archive write wait for the whole archive', async () => {
      // A restore finishing during archive's pre-write awaits would be silently overwritten.
      const order: string[] = [];
      let finishFlowCancel: () => void = () => {};
      getChatByIdLocalMock.mockResolvedValue(makeLocalChat({ id: 'c1' }));
      cancelFlowRunsForChatMock.mockReturnValue(
        new Promise<void>((resolve) => {
          finishFlowCancel = resolve;
        }),
      );
      archiveChatLocalMock.mockImplementation(async () => {
        order.push('archive-write');
        return archived('c1');
      });
      unarchiveChatLocalMock.mockImplementation(async () => {
        order.push('unarchive');
        return makeLocalChat({ id: 'c1', archivedAt: null });
      });
      const { caller } = await load();

      const archiving = archiveC1(caller);
      await vi.waitFor(() => expect(cancelFlowRunsForChatMock).toHaveBeenCalled());
      const restoring = caller.restore({ id: 'c1' });
      await new Promise((resolve) => setTimeout(resolve, 0));
      expect(unarchiveChatLocalMock).not.toHaveBeenCalled();

      finishFlowCancel();
      await Promise.all([archiving, restoring]);

      expect(order).toEqual(['archive-write', 'unarchive']);
    });

    it('makes a restore wait for every overlapping archive of the same chat', async () => {
      let finishFirst: () => void = () => {};
      getChatByIdLocalMock.mockResolvedValue(makeLocalChat({ id: 'c1' }));
      cancelFlowRunsForChatMock
        .mockReturnValueOnce(
          new Promise<void>((resolve) => {
            finishFirst = resolve;
          }),
        )
        .mockResolvedValue(undefined);
      archiveChatLocalMock.mockResolvedValue(archived('c1'));
      unarchiveChatLocalMock.mockResolvedValue(makeLocalChat({ id: 'c1', archivedAt: null }));
      const { caller } = await load();

      const slow = archiveC1(caller);
      await vi.waitFor(() => expect(cancelFlowRunsForChatMock).toHaveBeenCalledTimes(1));
      // A second pane's archive of the same chat finishes first; the first is still pending.
      await archiveC1(caller);
      const restoring = caller.restore({ id: 'c1' });
      await new Promise((resolve) => setTimeout(resolve, 0));
      expect(unarchiveChatLocalMock).not.toHaveBeenCalled();

      finishFirst();
      await Promise.all([slow, restoring]);
      expect(unarchiveChatLocalMock).toHaveBeenCalledTimes(1);
    });

    it('archiveBatch sweeps every chat even when one sub-chat lookup fails, then dooms each', async () => {
      const { listSubChatsByChat } = await import('../../../db/repos/sub-chats');
      vi.mocked(listSubChatsByChat).mockImplementation(async (_db, chatId) => {
        if (chatId === 'c2') throw new Error('database is locked');
        return [];
      });
      archiveChatLocalMock.mockImplementation(async (_db: unknown, id: string) => archived(id));
      const { caller, registry } = await load();
      const midAdmission = registry.openAdmission('c2');

      await caller.archiveBatch({ chatIds: ['c1', 'c2'] });

      const swept = abortActiveExecutionsForChatMock.mock.calls.map(([id]) => id);
      // Pre-write sweep for both, then a post-write sweep for both archived chats.
      expect(swept.sort()).toEqual(['c1', 'c1', 'c2', 'c2']);
      expect(midAdmission.doomed).toBe(true);
    });

    it('archiveBatch dooms each chat as soon as its own write lands, not after the slowest', async () => {
      let finishSlow: () => void = () => {};
      archiveChatLocalMock.mockImplementation((_db: unknown, id: string) =>
        id === 'fast'
          ? Promise.resolve(archived(id))
          : new Promise((resolve) => {
              finishSlow = () => resolve(archived(id));
            }),
      );
      const { caller, registry } = await load();
      const fastSend = registry.openAdmission('fast');

      const batch = caller.archiveBatch({ chatIds: ['fast', 'slow'] });
      await vi.waitFor(() => expect(fastSend.doomed).toBe(true));

      finishSlow();
      await batch;
    });

    it('archiveBatch dooms only the chats that were archived', async () => {
      archiveChatLocalMock.mockResolvedValueOnce(archived('c1')).mockResolvedValueOnce(null);
      const { caller, registry } = await load();
      const archivedSend = registry.openAdmission('c1');
      const missingSend = registry.openAdmission('missing');

      await caller.archiveBatch({ chatIds: ['c1', 'missing'] });

      expect(archivedSend.doomed).toBe(true);
      expect(missingSend.doomed).toBe(false);
    });

    it('archiveBatch settles every write before rejecting, so restore waits for slow siblings', async () => {
      // One failed write must not release restore while a sibling's write is still landing.
      let finishSlow: () => void = () => {};
      archiveChatLocalMock.mockImplementation((_db: unknown, id: string) =>
        id === 'bad'
          ? Promise.reject(new Error('write failed'))
          : new Promise((resolve) => {
              finishSlow = () => resolve(archived(id));
            }),
      );
      unarchiveChatLocalMock.mockResolvedValue(makeLocalChat({ id: 'slow', archivedAt: null }));
      const { caller, registry } = await load();
      const slowSend = registry.openAdmission('slow');

      const batch = caller.archiveBatch({ chatIds: ['bad', 'slow'] });
      batch.catch(() => {});
      await vi.waitFor(() => expect(archiveChatLocalMock).toHaveBeenCalledTimes(2));
      const restoring = caller.restore({ id: 'slow' });
      await new Promise((resolve) => setTimeout(resolve, 0));
      expect(unarchiveChatLocalMock).not.toHaveBeenCalled();

      finishSlow();
      await expect(batch).rejects.toThrow('write failed');
      await restoring;
      expect(unarchiveChatLocalMock).toHaveBeenCalledTimes(1);
      // The sibling that did archive still had its late sends doomed and swept.
      expect(slowSend.doomed).toBe(true);
    });

    it('archiveBatch makes a concurrent restore of one of its chats wait', async () => {
      let finishWrites: () => void = () => {};
      const writesGate = new Promise<void>((resolve) => {
        finishWrites = resolve;
      });
      archiveChatLocalMock.mockImplementation(async (_db: unknown, id: string) => {
        await writesGate;
        return archived(id);
      });
      unarchiveChatLocalMock.mockResolvedValue(makeLocalChat({ id: 'c2', archivedAt: null }));
      const { caller } = await load();

      const archiving = caller.archiveBatch({ chatIds: ['c1', 'c2'] });
      const restoring = caller.restore({ id: 'c2' });
      await new Promise((resolve) => setTimeout(resolve, 0));
      expect(unarchiveChatLocalMock).not.toHaveBeenCalled();

      finishWrites();
      await Promise.all([archiving, restoring]);
      expect(unarchiveChatLocalMock).toHaveBeenCalledTimes(1);
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
