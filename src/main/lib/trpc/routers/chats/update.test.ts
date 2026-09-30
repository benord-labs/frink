/**
 * chats.rename keeps the invariant parent.name === oldest sub-chat name (the
 * reverse of renameSubChat): renaming a chat also retitles its oldest sub-chat
 * and broadcasts `chats:name-updated`, so an open chat's header/tabs update.
 */

import { beforeEach, describe, expect, it, vi } from 'vitest';
import { makeLocalChat, makeLocalSubChat } from './test-factories';

const updateChatLocalMock = vi.fn();
const moveChatToProjectLocalMock = vi.fn();
const getChatByIdMock = vi.fn();
const resolveTargetWorktreeMock = vi.fn();
const listSubChatsByChatMock = vi.fn();
const renameSubChatLocalMock = vi.fn();
const broadcastChatNameUpdatedMock = vi.fn();
const gitCacheInvalidateStatusMock = vi.fn();
const gitCacheInvalidateParsedDiffMock = vi.fn();
const setChatAiAccountMock = vi.fn();
const retireRetainedSessionMock = vi.fn();
const releaseWakeHoldMock = vi.fn();

vi.mock('../../../db', () => ({ getDatabase: () => ({}) }));
vi.mock('../../../db/repos/chats', async (importOriginal) => {
  // Keep the pure history helpers (parseWorktreeHistory etc.) real so the mutation's
  // `parseWorktreeHistory(chat.worktreeHistory)` returns a real `{}` for null input.
  const actual = await importOriginal<typeof import('../../../db/repos/chats')>();
  return {
    ...actual,
    updateChat: updateChatLocalMock,
    moveChatToProjectLocal: moveChatToProjectLocalMock,
    getChatById: getChatByIdMock,
  };
});
vi.mock('../../../git/resolve-target-worktree', () => ({
  resolveTargetWorktreeForMove: resolveTargetWorktreeMock,
}));
// Keep the real `pickOldestSubChat` (pure) — only the DB-touching fns are stubbed.
vi.mock('../../../db/repos/sub-chats', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../../db/repos/sub-chats')>()),
  listSubChatsByChat: listSubChatsByChatMock,
  renameSubChat: renameSubChatLocalMock,
}));
vi.mock('./helpers/name-generation-async', () => ({
  broadcastChatNameUpdated: broadcastChatNameUpdatedMock,
}));
vi.mock('../../../db/repos/project-ai-accounts', () => ({
  setChatAiAccount: setChatAiAccountMock,
}));
vi.mock('../../../socket/claude-session-registry', () => ({
  retireRetainedSession: retireRetainedSessionMock,
}));
vi.mock('../../../socket/claude-wake-hold', () => ({ releaseWakeHold: releaseWakeHoldMock }));
vi.mock('./map-chat-response', () => ({ mapLocalChatResponse: (c: unknown) => c }));
vi.mock('../../../git/cache', () => ({
  gitCache: {
    invalidateStatus: gitCacheInvalidateStatusMock,
    invalidateParsedDiff: gitCacheInvalidateParsedDiffMock,
  },
}));

describe('updateRouter.rename', () => {
  beforeEach(() => {
    vi.resetAllMocks();
  });

  it('renames the oldest sub-chat and broadcasts when the chat is renamed', async () => {
    updateChatLocalMock.mockResolvedValue(makeLocalChat({ id: 'c1', name: 'My title' }));
    listSubChatsByChatMock.mockResolvedValue([
      makeLocalSubChat({ id: 's2', chatId: 'c1', createdAt: new Date('2026-02-01') }),
      makeLocalSubChat({ id: 's1', chatId: 'c1', createdAt: new Date('2026-01-01') }),
    ]);

    const { updateRouter } = await import('./update');
    const caller = updateRouter.createCaller({ getWindow: () => null });
    const result = await caller.rename({ id: 'c1', name: 'My title' });

    expect(updateChatLocalMock).toHaveBeenCalledWith(expect.anything(), 'c1', { name: 'My title' });
    // Only the oldest sub-chat is retitled — sibling sub-chats keep their own names.
    expect(renameSubChatLocalMock).toHaveBeenCalledTimes(1);
    expect(renameSubChatLocalMock).toHaveBeenCalledWith(expect.anything(), 's1', 'My title');
    expect(broadcastChatNameUpdatedMock).toHaveBeenCalledWith('c1', 's1', 'My title');
    expect((result as { id: string } | null)?.id).toBe('c1');
  });

  it('renames only the chat when it has no sub-chats (no sub-chat write, no broadcast)', async () => {
    updateChatLocalMock.mockResolvedValue(makeLocalChat({ id: 'c1', name: 'Solo' }));
    listSubChatsByChatMock.mockResolvedValue([]);

    const { updateRouter } = await import('./update');
    const caller = updateRouter.createCaller({ getWindow: () => null });
    await caller.rename({ id: 'c1', name: 'Solo' });

    expect(updateChatLocalMock).toHaveBeenCalled();
    expect(renameSubChatLocalMock).not.toHaveBeenCalled();
    expect(broadcastChatNameUpdatedMock).not.toHaveBeenCalled();
  });

  it('returns null and skips sub-chat work when the chat row is missing', async () => {
    updateChatLocalMock.mockResolvedValue(null);

    const { updateRouter } = await import('./update');
    const caller = updateRouter.createCaller({ getWindow: () => null });
    const result = await caller.rename({ id: 'gone', name: 'X' });

    expect(result).toBeNull();
    expect(listSubChatsByChatMock).not.toHaveBeenCalled();
    expect(renameSubChatLocalMock).not.toHaveBeenCalled();
    expect(broadcastChatNameUpdatedMock).not.toHaveBeenCalled();
  });
});

/**
 * chats.moveToProject re-syncs worktreePath to the destination project root (or auto-restores
 * a previously-visited worktree from the chat's history). The resolver owns the decision;
 * the mutation just threads the resolved values into the helper and invalidates gitCache.
 */
describe('updateRouter.moveToProject', () => {
  beforeEach(() => {
    vi.resetAllMocks();
  });

  it('threads the source history into the resolver and writes the resolver result via the helper', async () => {
    getChatByIdMock.mockResolvedValue(
      makeLocalChat({
        id: 'c1',
        projectId: 'p1',
        worktreePath: '/proj/a',
        worktreeHistory: '{"p3":"/wt/old"}',
      }),
    );
    resolveTargetWorktreeMock.mockResolvedValue({
      worktreePath: '/proj/b',
      branch: null,
      baseBranch: null,
      stalePrunedProjectId: null,
    });
    moveChatToProjectLocalMock.mockResolvedValue({
      updated: makeLocalChat({ id: 'c1', projectId: 'p2', worktreePath: '/proj/b' }),
      previousWorktreePath: '/proj/a',
    });

    const { updateRouter } = await import('./update');
    const caller = updateRouter.createCaller({ getWindow: () => null });
    const result = await caller.moveToProject({
      chatId: 'c1',
      projectId: 'p2',
      projectPath: '/proj/b',
    });

    expect(resolveTargetWorktreeMock).toHaveBeenCalledWith({
      targetProjectId: 'p2',
      targetProjectPath: '/proj/b',
      explicitWorktreePath: null,
      history: { p3: '/wt/old' },
    });
    expect(moveChatToProjectLocalMock).toHaveBeenCalledWith(expect.anything(), 'c1', {
      projectId: 'p2',
      worktreePath: '/proj/b',
      branch: null,
      baseBranch: null,
      stalePrunedProjectId: null,
    });
    // Both paths invalidated — new path may carry stale cache from a prior visit.
    expect(gitCacheInvalidateStatusMock).toHaveBeenCalledWith('/proj/a');
    expect(gitCacheInvalidateStatusMock).toHaveBeenCalledWith('/proj/b');
    expect(gitCacheInvalidateParsedDiffMock).toHaveBeenCalledWith('/proj/a');
    expect(gitCacheInvalidateParsedDiffMock).toHaveBeenCalledWith('/proj/b');
    expect((result as { id: string } | null)?.id).toBe('c1');
  });

  it('auto-restores a historical worktree: passes branch through to the helper', async () => {
    // Resolver decided the destination already has a worktree in history that still exists.
    getChatByIdMock.mockResolvedValue(
      makeLocalChat({
        id: 'c1',
        projectId: 'p2',
        worktreePath: '/proj/b',
        worktreeHistory: '{"p1":"/wt/feat-x"}',
      }),
    );
    resolveTargetWorktreeMock.mockResolvedValue({
      worktreePath: '/wt/feat-x',
      branch: 'feat-x',
      baseBranch: 'main',
      stalePrunedProjectId: null,
    });
    moveChatToProjectLocalMock.mockResolvedValue({
      updated: makeLocalChat({
        id: 'c1',
        projectId: 'p1',
        worktreePath: '/wt/feat-x',
        branch: 'feat-x',
        baseBranch: 'main',
      }),
      previousWorktreePath: '/proj/b',
    });

    const { updateRouter } = await import('./update');
    const caller = updateRouter.createCaller({ getWindow: () => null });
    await caller.moveToProject({ chatId: 'c1', projectId: 'p1', projectPath: '/proj/a' });

    expect(moveChatToProjectLocalMock).toHaveBeenCalledWith(expect.anything(), 'c1', {
      projectId: 'p1',
      worktreePath: '/wt/feat-x',
      branch: 'feat-x',
      baseBranch: 'main',
      stalePrunedProjectId: null,
    });
  });

  it('forwards the resolver-flagged stalePrunedProjectId to the helper for transactional pruning', async () => {
    getChatByIdMock.mockResolvedValue(
      makeLocalChat({
        id: 'c1',
        projectId: 'p2',
        worktreePath: '/proj/b',
        worktreeHistory: '{"p1":"/wt/stale","p3":"/wt/keep"}',
      }),
    );
    // Resolver flagged `p1` as stale (its `/wt/stale` failed fs.existsSync).
    resolveTargetWorktreeMock.mockResolvedValue({
      worktreePath: '/proj/a',
      branch: null,
      baseBranch: null,
      stalePrunedProjectId: 'p1',
    });
    moveChatToProjectLocalMock.mockResolvedValue({
      updated: makeLocalChat({ id: 'c1', projectId: 'p1', worktreePath: '/proj/a' }),
      previousWorktreePath: '/proj/b',
    });

    const { updateRouter } = await import('./update');
    const caller = updateRouter.createCaller({ getWindow: () => null });
    await caller.moveToProject({ chatId: 'c1', projectId: 'p1', projectPath: '/proj/a' });

    expect(moveChatToProjectLocalMock).toHaveBeenCalledWith(
      expect.anything(),
      'c1',
      expect.objectContaining({ stalePrunedProjectId: 'p1' }),
    );
  });

  it('skips old-path gitCache invalidation when unchanged, still invalidates the (re-attached) new path', async () => {
    getChatByIdMock.mockResolvedValue(
      makeLocalChat({ id: 'c1', projectId: 'p2', worktreePath: '/proj/b' }),
    );
    resolveTargetWorktreeMock.mockResolvedValue({
      worktreePath: '/proj/b',
      branch: null,
      baseBranch: null,
      stalePrunedProjectId: null,
    });
    moveChatToProjectLocalMock.mockResolvedValue({
      updated: makeLocalChat({ id: 'c1', projectId: 'p2', worktreePath: '/proj/b' }),
      previousWorktreePath: '/proj/b',
    });

    const { updateRouter } = await import('./update');
    const caller = updateRouter.createCaller({ getWindow: () => null });
    await caller.moveToProject({ chatId: 'c1', projectId: 'p2', projectPath: '/proj/b' });

    // Old-path invalidation skipped (== new path); new-path always invalidated.
    expect(gitCacheInvalidateStatusMock).toHaveBeenCalledTimes(1);
    expect(gitCacheInvalidateStatusMock).toHaveBeenCalledWith('/proj/b');
    expect(gitCacheInvalidateParsedDiffMock).toHaveBeenCalledTimes(1);
    expect(gitCacheInvalidateParsedDiffMock).toHaveBeenCalledWith('/proj/b');
  });

  it('returns null without touching the resolver or helper when the chat is missing', async () => {
    getChatByIdMock.mockResolvedValue(null);

    const { updateRouter } = await import('./update');
    const caller = updateRouter.createCaller({ getWindow: () => null });
    const result = await caller.moveToProject({
      chatId: 'gone',
      projectId: 'p2',
      projectPath: '/x',
    });

    expect(result).toBeNull();
    expect(resolveTargetWorktreeMock).not.toHaveBeenCalled();
    expect(moveChatToProjectLocalMock).not.toHaveBeenCalled();
  });
});

describe('updateRouter.setChatAccount', () => {
  beforeEach(() => {
    vi.resetAllMocks();
  });

  const setChatAccount = async (accountId: string) => {
    const { updateRouter } = await import('./update');
    const caller = updateRouter.createCaller({ getWindow: () => null });
    return caller.setChatAccount({ chatId: 'c1', accountId });
  };

  it('retires every idle session and wake hold of the chat after a same-provider swap', async () => {
    setChatAiAccountMock.mockResolvedValue('ok');
    listSubChatsByChatMock.mockResolvedValue([
      makeLocalSubChat({ id: 's1', chatId: 'c1' }),
      makeLocalSubChat({ id: 's2', chatId: 'c1' }),
    ]);

    await expect(setChatAccount('claude-b')).resolves.toEqual({ success: true });

    expect(setChatAiAccountMock).toHaveBeenCalledWith(expect.anything(), 'c1', 'claude-b');
    expect(retireRetainedSessionMock.mock.calls.map(([id]) => id)).toEqual(['s1', 's2']);
    expect(releaseWakeHoldMock.mock.calls).toEqual([
      ['s1', 'credential-change'],
      ['s2', 'credential-change'],
    ]);
  });

  it('rejects another provider without retiring anything', async () => {
    setChatAiAccountMock.mockResolvedValue('other-provider');

    await expect(setChatAccount('codex')).rejects.toMatchObject({
      code: 'BAD_REQUEST',
      message: 'A chat stays on its provider',
    });
    expect(retireRetainedSessionMock).not.toHaveBeenCalled();
    expect(releaseWakeHoldMock).not.toHaveBeenCalled();
  });

  it('reports an unknown chat or account as NOT_FOUND', async () => {
    setChatAiAccountMock.mockResolvedValue('not-found');

    await expect(setChatAccount('missing')).rejects.toMatchObject({ code: 'NOT_FOUND' });
  });
});
