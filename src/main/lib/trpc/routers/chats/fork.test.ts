/** Phase 1 local-first migration: fork is a deep-copy in local SQLite. */

import { beforeEach, describe, expect, it, vi } from 'vitest';
import { makeLocalChat, makeLocalSubChat } from './test-factories';

const forkChatWithSubChatsLocalMock = vi.fn();
const getAiAccountTypeMock = vi.fn();

vi.mock('../../../db', () => ({
  getDatabase: () => ({
    select: () => ({
      from: () => ({ where: () => ({ limit: () => Promise.resolve([]) }) }),
    }),
  }),
}));
vi.mock('../../../db/repos/chats', () => ({
  forkChatWithSubChats: forkChatWithSubChatsLocalMock,
}));
vi.mock('../../../db/repos/project-ai-accounts', () => ({
  getAiAccountType: getAiAccountTypeMock,
}));

describe('forkRouter (local-first)', () => {
  beforeEach(() => {
    vi.resetAllMocks();
  });

  it('returns the new chat and sub-chats from the local fork helper', async () => {
    forkChatWithSubChatsLocalMock.mockResolvedValue({
      chat: makeLocalChat({ id: 'new-chat', name: 'forked' }),
      subChats: [makeLocalSubChat({ id: 'new-sub', chatId: 'new-chat' })],
    });
    getAiAccountTypeMock.mockResolvedValue('codex');

    const { forkRouter } = await import('./fork');
    const caller = forkRouter.createCaller({ getWindow: () => null });

    const result = await caller.fork({ chatId: 'src-chat', accountId: 'acct-codex' });

    expect(forkChatWithSubChatsLocalMock).toHaveBeenCalledWith(expect.anything(), 'src-chat', {
      id: 'acct-codex',
      type: 'codex',
    });
    expect(result.id).toBe('new-chat');
    expect(result.subChats).toHaveLength(1);
    expect(result.subChats[0].id).toBe('new-sub');
  });

  it('translates "not found" errors from the repo into NOT_FOUND tRPC errors', async () => {
    forkChatWithSubChatsLocalMock.mockRejectedValue(new Error('Source chat not found: x'));

    const { forkRouter } = await import('./fork');
    const caller = forkRouter.createCaller({ getWindow: () => null });

    await expect(caller.fork({ chatId: 'x' })).rejects.toMatchObject({
      code: 'NOT_FOUND',
    });
  });

  it('rejects an unknown or non-AI account before forking', async () => {
    getAiAccountTypeMock.mockResolvedValue(null);

    const { forkRouter } = await import('./fork');
    const caller = forkRouter.createCaller({ getWindow: () => null });

    await expect(caller.fork({ chatId: 'x', accountId: 'github-pat' })).rejects.toMatchObject({
      code: 'NOT_FOUND',
    });
    expect(forkChatWithSubChatsLocalMock).not.toHaveBeenCalled();
  });
});
