/**
 * Phase 1 local-first migration: this router writes directly to local SQLite. The
 * earlier `cloud mode-downgrade reassertion` test suite (four cases targeting the
 * cloud HTTP bug that silently downgraded mode → 'agent') has been removed — local
 * writes don't go through that buggy path, so the workaround and its tests no longer
 * apply. Worktree git logic still lives in the same router; that's covered indirectly
 * via the worktree-config router test and is best exercised end-to-end.
 */

import { beforeEach, describe, expect, it, vi } from 'vitest';
import * as analytics from '../../../analytics';
import * as pastedFiles from '../../../claude/pasted-files';
import { makeLocalChat, makeLocalSubChat } from './test-factories';

const createChatLocalMock = vi.fn();
const createSubChatLocalMock = vi.fn();
const findChatByWorktreeLocalMock = vi.fn();
const updateChatLocalMock = vi.fn();
const projectsSelectMock = vi.fn();
const autoNameSubChatMock = vi.fn();
const trackMessageSentMock = vi.spyOn(analytics, 'trackMessageSent');
const getAiAccountTypeMock = vi.fn();
const getSubChatByIdMock = vi.fn();
const updateSubChatMessagesMock = vi.fn();

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
  getSubChatById: getSubChatByIdMock,
  updateSubChatMessages: updateSubChatMessagesMock,
}));

/** The row the real insert would return: the id and transcript it was given. */
async function insertedRow(_db: never, row: { id?: string; messages: string }) {
  return { ...makeLocalSubChat({ id: row.id, chatId: 'c1' }), messages: JSON.parse(row.messages) };
}
vi.mock('../../../db/schema', () => ({
  projects: { id: 'projects.id' },
}));
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

  it('counts the message a chat is created with as the one that starts it', async () => {
    createChatLocalMock.mockResolvedValue(makeLocalChat({ id: 'c1', name: 'Test' }));
    createSubChatLocalMock.mockResolvedValue(makeLocalSubChat({ id: 's1', chatId: 'c1' }));

    const { createRouter } = await import('./create');
    const caller = createRouter.createCaller({ getWindow: () => null });

    await caller.create({ ...baseInput, initialMessage: 'hello world', mode: 'plan' });

    expect(trackMessageSentMock).toHaveBeenCalledExactlyOnceWith({
      workspaceId: 's1',
      messageLength: 'hello world'.length,
      mode: 'plan',
      startsChat: true,
    });
  });

  it.each([
    { name: 'no message', taskTitle: undefined },
    { name: 'only a linked task title', taskTitle: 'Fix the login page' },
  ])('counts no message for a chat created with $name', async ({ taskTitle }) => {
    createChatLocalMock.mockResolvedValue(makeLocalChat({ id: 'c1', name: 'Test' }));
    createSubChatLocalMock.mockResolvedValue(makeLocalSubChat({ id: 's1', chatId: 'c1' }));

    const { createRouter } = await import('./create');
    const caller = createRouter.createCaller({ getWindow: () => null });

    await caller.create({ ...baseInput, initialMessage: undefined, taskTitle, mode: 'agent' });

    expect(trackMessageSentMock).not.toHaveBeenCalled();
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

  it('refuses a worktree another chat owns with CONFLICT, before saving anything', async () => {
    projectsSelectMock.mockResolvedValue([{ id: 'p1', path: '/repo', name: 'Repo' }]); // byId hit
    findChatByWorktreeLocalMock.mockResolvedValue({ id: 'other', name: 'Other chat' });

    const { createRouter } = await import('./create');
    const caller = createRouter.createCaller({ getWindow: () => null });

    // Typed, not collapsed to INTERNAL_SERVER_ERROR by the outer catch. Nothing is inserted, so
    // the composer's sub-chat id stays free for its retry.
    await expect(
      caller.create({
        ...baseInput,
        projectId: 'p1',
        useWorktree: false,
        existingWorktreePath: '/repo/wt',
        mode: 'agent',
      }),
    ).rejects.toMatchObject({ code: 'CONFLICT' });
    expect(createChatLocalMock).not.toHaveBeenCalled();
    expect(createSubChatLocalMock).not.toHaveBeenCalled();
  });

  it('fails the create before saving anything when the worktree owner lookup fails', async () => {
    projectsSelectMock.mockResolvedValue([{ id: 'p1', path: '/repo', name: 'Repo' }]);
    findChatByWorktreeLocalMock.mockRejectedValue(new Error('database is locked'));

    const { createRouter } = await import('./create');
    const caller = createRouter.createCaller({ getWindow: () => null });

    await expect(
      caller.create({ ...baseInput, projectId: 'p1', existingWorktreePath: '/repo/wt' }),
    ).rejects.toMatchObject({ code: 'INTERNAL_SERVER_ERROR' });
    expect(createChatLocalMock).not.toHaveBeenCalled();
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

  it('creates the first sub-chat under the id the composer minted for its pastes', async () => {
    createChatLocalMock.mockResolvedValue(makeLocalChat({ id: 'c1', name: 'Test' }));
    createSubChatLocalMock.mockResolvedValue(makeLocalSubChat({ id: 's1', chatId: 'c1' }));
    getSubChatByIdMock.mockResolvedValue(null);
    const subChatId = '0b9d3c2e-5f4a-4c1b-9e2d-7a6f8b1c3d4e';

    const { createRouter } = await import('./create');
    const caller = createRouter.createCaller({ getWindow: () => null });
    await caller.create({ ...baseInput, subChatId });

    expect(createSubChatLocalMock.mock.calls[0]?.[1]).toMatchObject({ id: subChatId });
  });

  it.each([
    ['unsafe in a path', '__new_chat_0__', null],
    ['already taken', '0b9d3c2e-5f4a-4c1b-9e2d-7a6f8b1c3d4e', makeLocalSubChat({ id: 'taken' })],
  ])(
    'mints a fresh sub-chat id when the composer id is %s',
    async (_label, subChatId, existing) => {
      createChatLocalMock.mockResolvedValue(makeLocalChat({ id: 'c1', name: 'Test' }));
      createSubChatLocalMock.mockResolvedValue(makeLocalSubChat({ id: 's1', chatId: 'c1' }));
      getSubChatByIdMock.mockResolvedValue(existing);

      const { createRouter } = await import('./create');
      const caller = createRouter.createCaller({ getWindow: () => null });
      await caller.create({ ...baseInput, subChatId });

      const id = createSubChatLocalMock.mock.calls[0]?.[1]?.id;
      expect(id).toMatch(/^[a-z0-9-]{10,64}$/i);
      expect(id).not.toBe(subChatId);
    },
  );

  it("moves the first message's attachments under a replaced composer id", async () => {
    createChatLocalMock.mockResolvedValue(makeLocalChat({ id: 'c1', name: 'Test' }));
    createSubChatLocalMock.mockImplementation(insertedRow);
    updateSubChatMessagesMock.mockImplementation(async (_db, id, transform) => ({
      ...makeLocalSubChat({ id, chatId: 'c1' }),
      messages: transform(JSON.parse(createSubChatLocalMock.mock.calls[0]?.[1].messages)),
    }));
    getSubChatByIdMock.mockResolvedValue(makeLocalSubChat({ id: 'taken' }));
    const rehome = vi
      .spyOn(pastedFiles, 'rehomePastedMentions')
      .mockImplementation(async (text, to) => text.replace(subChatId, to));
    const subChatId = '0b9d3c2e-5f4a-4c1b-9e2d-7a6f8b1c3d4e';
    const token = `@[pasted:4:report.pdf|/u/claude-sessions/${subChatId}/pasted/1a2b3c4d-report.pdf]`;

    const { createRouter } = await import('./create');
    const caller = createRouter.createCaller({ getWindow: () => null });
    await caller.create({
      ...baseInput,
      subChatId,
      initialMessageParts: [{ type: 'text', text: `${token} summarise it` }],
    });

    const created = createSubChatLocalMock.mock.calls[0]?.[1];
    const stored = await updateSubChatMessagesMock.mock.results[0]?.value;
    expect(rehome).toHaveBeenCalledWith(`${token} summarise it`, created.id);
    expect(stored.messages[0].parts[0].text).toContain(
      `/u/claude-sessions/${created.id}/pasted/1a2b3c4d-report.pdf`,
    );
    rehome.mockRestore();
  });

  // The rows are already saved when pastes move, so a failed move must not fail the create.
  it('still creates the chat when moving its pastes fails, keeping their old paths', async () => {
    createChatLocalMock.mockResolvedValue(makeLocalChat({ id: 'c1', name: 'Test' }));
    createSubChatLocalMock.mockImplementation(insertedRow);
    getSubChatByIdMock.mockResolvedValue(null);
    const rehome = vi
      .spyOn(pastedFiles, 'rehomePastedMentions')
      .mockRejectedValue(new Error('EACCES: permission denied, mkdir'));

    const { createRouter } = await import('./create');
    const caller = createRouter.createCaller({ getWindow: () => null });
    const result = await caller.create({
      ...baseInput,
      subChatId: '0b9d3c2e-5f4a-4c1b-9e2d-7a6f8b1c3d4e',
      initialMessageParts: [{ type: 'text', text: 'see the report' }],
    });

    expect(result.id).toBe('c1');
    expect(updateSubChatMessagesMock).not.toHaveBeenCalled();
    rehome.mockRestore();
  });

  describe('a composer id taken by the time of the insert', () => {
    const subChatId = '0b9d3c2e-5f4a-4c1b-9e2d-7a6f8b1c3d4e';
    const primaryKeyConflict = Object.assign(new Error('Failed query'), {
      cause: Object.assign(new Error('UNIQUE constraint failed: sub_chats.id'), { errcode: 1555 }),
    });

    beforeEach(() => {
      createChatLocalMock.mockResolvedValue(makeLocalChat({ id: 'c1', name: 'Test' }));
      getSubChatByIdMock.mockResolvedValue(null);
    });

    // Copying before the insert would leave this create's pastes in the racing chat's folder.
    it('retries once under a fresh id, copying pastes only into the id it got', async () => {
      createSubChatLocalMock
        .mockRejectedValueOnce(primaryKeyConflict)
        .mockImplementationOnce(insertedRow);
      const rehome = vi
        .spyOn(pastedFiles, 'rehomePastedMentions')
        .mockImplementation(async (text) => text);

      const { createRouter } = await import('./create');
      const caller = createRouter.createCaller({ getWindow: () => null });
      await caller.create({
        ...baseInput,
        subChatId,
        initialMessageParts: [{ type: 'text', text: 'see the report' }],
      });

      const retried = createSubChatLocalMock.mock.calls[1]?.[1]?.id;
      expect(createSubChatLocalMock).toHaveBeenCalledTimes(2);
      expect(retried).toMatch(/^[a-z0-9-]{10,64}$/i);
      expect(retried).not.toBe(subChatId);
      expect(rehome).toHaveBeenCalledExactlyOnceWith('see the report', retried);
      rehome.mockRestore();
    });

    it('does not retry any other insert failure', async () => {
      createSubChatLocalMock.mockRejectedValueOnce(new Error('disk I/O error'));

      const { createRouter } = await import('./create');
      const caller = createRouter.createCaller({ getWindow: () => null });

      await expect(caller.create({ ...baseInput, subChatId })).rejects.toMatchObject({
        code: 'INTERNAL_SERVER_ERROR',
      });
      expect(createSubChatLocalMock).toHaveBeenCalledTimes(1);
    });
  });
});
