/**
 * Phase 1 local-first migration: this router writes directly to local SQLite. The
 * earlier `cloud mode-downgrade reassertion` test suite (four cases targeting the
 * cloud HTTP bug that silently downgraded mode → 'agent') has been removed — local
 * writes don't go through that buggy path, so the workaround and its tests no longer
 * apply. Worktree git logic still lives in the same router; that's covered indirectly
 * via the worktree-config router test and is best exercised end-to-end.
 */

import { beforeEach, describe, expect, it, vi } from 'vitest';
import { makeLocalChat, makeLocalSubChat } from './test-factories';

const createChatLocalMock = vi.fn();
const createSubChatLocalMock = vi.fn();
const findChatByWorktreeLocalMock = vi.fn();
const updateChatLocalMock = vi.fn();
const projectsSelectMock = vi.fn();
const autoNameSubChatMock = vi.fn();
const trackWorkspaceCreatedMock = vi.fn();
const getAiAccountTypeMock = vi.fn();

vi.mock('../../../db', () => ({
  getDatabase: () => ({
    select: () => ({
      from: () => ({
        where: () => ({
          limit: projectsSelectMock,
        }),
      }),
    }),
  }),
}));
vi.mock('../../../db/repos/chats', () => ({
  createChat: createChatLocalMock,
  findChatByWorktree: findChatByWorktreeLocalMock,
  updateChat: updateChatLocalMock,
}));
vi.mock('../../../db/repos/project-ai-accounts', () => ({
  getAiAccountType: getAiAccountTypeMock,
}));
vi.mock('../../../db/repos/sub-chats', () => ({
  createSubChat: createSubChatLocalMock,
}));
vi.mock('../../../db/schema', () => ({
  projects: { id: 'projects.id' },
}));
vi.mock('../../../analytics', () => ({ trackWorkspaceCreated: trackWorkspaceCreatedMock }));
vi.mock('../../../git', () => ({
  createWorktreeForChat: vi.fn(),
  detectBaseBranch: vi.fn(),
  getCurrentBranch: vi.fn(),
  getDefaultBranch: vi.fn(),
  sanitizeProjectName: vi.fn((name: string) => name),
}));
vi.mock('./helpers/name-generation-async', () => ({
  autoNameSubChat: autoNameSubChatMock,
  maybeNameBuildProjectFromMessage: vi.fn(),
}));

const baseInput = {
  projectId: '',
  projectPath: '',
  initialMessage: 'hello',
  useWorktree: false,
};

describe('createRouter (local-first)', () => {
  beforeEach(() => {
    vi.resetAllMocks();
    autoNameSubChatMock.mockResolvedValue(undefined);
    projectsSelectMock.mockResolvedValue([]);
  });

  it('persists chat + sub-chat with the user-requested mode (no reassertion needed)', async () => {
    createChatLocalMock.mockResolvedValue(makeLocalChat({ id: 'c1', mode: 'debug', name: 'Test' }));
    createSubChatLocalMock.mockResolvedValue(
      makeLocalSubChat({ id: 's1', chatId: 'c1', mode: 'debug', name: 'Test' }),
    );

    const { createRouter } = await import('./create');
    const caller = createRouter.createCaller({ getWindow: () => null });

    const result = await caller.create({ ...baseInput, mode: 'debug' });

    expect(createChatLocalMock).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ mode: 'debug' }),
    );
    expect(createSubChatLocalMock).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ mode: 'debug', chatId: 'c1' }),
    );
    expect(result.subChats[0].mode).toBe('debug');
    expect(result.subChats[0]).not.toHaveProperty('messagesRevision');
  });

  it('seeds the initial user message into the sub-chat messages JSON', async () => {
    createChatLocalMock.mockResolvedValue(makeLocalChat({ id: 'c1', name: 'Test' }));
    createSubChatLocalMock.mockResolvedValue(makeLocalSubChat({ id: 's1', chatId: 'c1' }));

    const { createRouter } = await import('./create');
    const caller = createRouter.createCaller({ getWindow: () => null });

    await caller.create({ ...baseInput, initialMessage: 'hello world', mode: 'agent' });

    const subChatCall = createSubChatLocalMock.mock.calls[0]?.[1];
    const seededMessages = JSON.parse(subChatCall.messages);
    expect(seededMessages).toHaveLength(1);
    expect(seededMessages[0].role).toBe('user');
    expect(seededMessages[0].parts[0]).toEqual({ type: 'text', text: 'hello world' });
  });

  it('rejects an unresolvable projectId as typed NOT_FOUND, not INTERNAL_SERVER_ERROR', async () => {
    projectsSelectMock.mockResolvedValue([]); // no rows

    const { createRouter } = await import('./create');
    const caller = createRouter.createCaller({ getWindow: () => null });

    // A deterministic, client-caused miss must surface as NOT_FOUND so callers can
    // distinguish it from a genuine server fault (only unknown exceptions stay 500).
    await expect(
      caller.create({ ...baseInput, projectId: 'unknown', useWorktree: false, mode: 'agent' }),
    ).rejects.toMatchObject({ code: 'NOT_FOUND' });
  });

  it('resolves a cloud-id miss via the projectPath fallback without throwing NOT_FOUND', async () => {
    // Documented primary path (create.ts:86-93): the renderer holds CLOUD project ids that
    // miss local SQLite; the authoritative projectPath must still resolve. NOT_FOUND fires
    // only when BOTH lookups miss, so this real-world shape must create the chat, not reject.
    projectsSelectMock
      .mockResolvedValueOnce([]) // byId miss (cloud id ≠ local id)
      .mockResolvedValueOnce([{ id: 'local-1', path: '/repo', name: 'Repo' }]); // byPath hit
    createChatLocalMock.mockResolvedValue(makeLocalChat({ id: 'c1', name: 'Test' }));
    createSubChatLocalMock.mockResolvedValue(makeLocalSubChat({ id: 's1', chatId: 'c1' }));

    const { createRouter } = await import('./create');
    const caller = createRouter.createCaller({ getWindow: () => null });

    const result = await caller.create({
      ...baseInput,
      projectId: 'cloud-id',
      projectPath: '/repo',
      useWorktree: false,
      mode: 'agent',
    });

    // Chat created against the path-resolved LOCAL id, not the caller's cloud id.
    expect(createChatLocalMock).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ projectId: 'local-1' }),
    );
    expect(result.id).toBe('c1');
  });

  it('propagates a worktree CONFLICT instead of collapsing it to INTERNAL_SERVER_ERROR', async () => {
    projectsSelectMock.mockResolvedValue([{ id: 'p1', path: '/repo', name: 'Repo' }]); // byId hit
    createChatLocalMock.mockResolvedValue(makeLocalChat({ id: 'c1', name: 'Test' }));
    createSubChatLocalMock.mockResolvedValue(makeLocalSubChat({ id: 's1', chatId: 'c1' }));
    // Existing worktree already owned by a DIFFERENT chat → router throws TRPCError CONFLICT
    // mid-flow, inside the worktree try/catch (create.ts:196-202).
    findChatByWorktreeLocalMock.mockResolvedValue({ id: 'other', name: 'Other chat' });

    const { createRouter } = await import('./create');
    const caller = createRouter.createCaller({ getWindow: () => null });

    // The typed error must survive BOTH the inner worktree catch and the outer catch,
    // proving typed-code propagation is general — not special-cased to NOT_FOUND.
    await expect(
      caller.create({
        ...baseInput,
        projectId: 'p1',
        useWorktree: false,
        existingWorktreePath: '/repo/wt',
        mode: 'agent',
      }),
    ).rejects.toMatchObject({ code: 'CONFLICT' });
  });

  it('maps an unexpected persistence failure to INTERNAL_SERVER_ERROR', async () => {
    // Negative guard for the fix: a genuinely unknown throw (not a typed data condition)
    // must REMAIN a server fault — normalizing 'project not found' must not over-broaden
    // the typed codes so that every failure looks recoverable.
    createChatLocalMock.mockRejectedValue(new Error('sqlite: disk I/O error'));

    const { createRouter } = await import('./create');
    const caller = createRouter.createCaller({ getWindow: () => null });

    await expect(caller.create({ ...baseInput, mode: 'agent' })).rejects.toMatchObject({
      code: 'INTERNAL_SERVER_ERROR',
    });
  });

  it('stamps the login picked in the new-chat composer on the chat', async () => {
    getAiAccountTypeMock.mockResolvedValue('codex');
    createChatLocalMock.mockResolvedValue(makeLocalChat({ id: 'c1', name: 'Test' }));
    createSubChatLocalMock.mockResolvedValue(makeLocalSubChat({ id: 's1', chatId: 'c1' }));

    const { createRouter } = await import('./create');
    const caller = createRouter.createCaller({ getWindow: () => null });
    await caller.create({ ...baseInput, mode: 'agent', accountId: 'acct-codex' });

    expect(getAiAccountTypeMock).toHaveBeenCalledWith(expect.anything(), 'acct-codex');
    expect(createChatLocalMock).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ accountId: 'acct-codex' }),
    );
  });

  it('rejects an unknown or non-AI account before creating the chat', async () => {
    getAiAccountTypeMock.mockResolvedValue(null);

    const { createRouter } = await import('./create');
    const caller = createRouter.createCaller({ getWindow: () => null });

    await expect(
      caller.create({ ...baseInput, mode: 'agent', accountId: 'github-pat' }),
    ).rejects.toMatchObject({ code: 'NOT_FOUND' });
    expect(createChatLocalMock).not.toHaveBeenCalled();
  });
});
