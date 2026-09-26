/** Phase 1 local-first migration: fork is a deep-copy in local SQLite. */

import { beforeEach, describe, expect, it, vi } from 'vitest';
import { makeLocalChat, makeLocalSubChat } from './test-factories';

const forkChatWithSubChatsLocalMock = vi.fn();

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

describe('forkRouter (local-first)', () => {
  beforeEach(() => {
    vi.resetAllMocks();
  });

  it('returns the new chat and sub-chats from the local fork helper', async () => {
    forkChatWithSubChatsLocalMock.mockResolvedValue({
      chat: makeLocalChat({ id: 'new-chat', name: 'forked' }),
      subChats: [makeLocalSubChat({ id: 'new-sub', chatId: 'new-chat' })],
    });

    const { forkRouter } = await import('./fork');
    const caller = forkRouter.createCaller({ getWindow: () => null });

    const result = await caller.fork({ chatId: 'src-chat' });

    expect(forkChatWithSubChatsLocalMock).toHaveBeenCalledWith(expect.anything(), 'src-chat');
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
});
