/** Phase 1 local-first migration: sub-chat reads come from local SQLite. */

import { beforeEach, describe, expect, it, vi } from 'vitest';
import { makeLocalChat, makeLocalSubChat } from '../test-factories';

const getSubChatByIdLocalMock = vi.fn();
const getChatByIdLocalMock = vi.fn();

// Mutable project row(s) the mocked `db.select()...limit()` resolves to (per-test).
const dbState = vi.hoisted(() => ({ projectRows: [] as unknown[] }));

vi.mock('../../../../db', () => ({
  getDatabase: () => ({
    select: () => ({
      from: () => ({ where: () => ({ limit: () => Promise.resolve(dbState.projectRows) }) }),
    }),
  }),
}));
vi.mock('../../../../db/repos/sub-chats', () => ({
  getSubChatById: getSubChatByIdLocalMock,
}));
vi.mock('../../../../db/repos/chats', () => ({
  getChatById: getChatByIdLocalMock,
}));

describe('subChatGetRouter (local-first)', () => {
  beforeEach(() => {
    vi.resetAllMocks();
    dbState.projectRows = [];
  });

  it('getSubChatMessages returns empty when sub-chat is missing', async () => {
    getSubChatByIdLocalMock.mockResolvedValue(null);
    const { subChatGetRouter } = await import('./get');
    const caller = subChatGetRouter.createCaller({ getWindow: () => null });
    const result = await caller.getSubChatMessages({ subChatId: 'unknown', limit: 20 });
    expect(result).toEqual({
      messages: [],
      hasMore: false,
      sessionId: null,
    });
  });

  it('getSubChatMessages returns hydrated messages + sessionId', async () => {
    getSubChatByIdLocalMock.mockResolvedValue({
      ...makeLocalSubChat({ id: 's1', sessionId: 'sess-1' }),
      messages: [{ id: 'm1', role: 'user', parts: [] }],
    });
    const { subChatGetRouter } = await import('./get');
    const caller = subChatGetRouter.createCaller({ getWindow: () => null });
    const result = await caller.getSubChatMessages({ subChatId: 's1', limit: 20 });
    expect(result.sessionId).toBe('sess-1');
    expect(result.messages).toHaveLength(1);
  });

  it('getSubChat returns sub-chat + parent chat', async () => {
    getSubChatByIdLocalMock.mockResolvedValue({
      ...makeLocalSubChat({ id: 's1', chatId: 'c1' }),
      messages: [{ id: 'm1' }],
    });
    getChatByIdLocalMock.mockResolvedValue(makeLocalChat({ id: 'c1', name: 'Parent' }));

    const { subChatGetRouter } = await import('./get');
    const caller = subChatGetRouter.createCaller({ getWindow: () => null });
    const result = await caller.getSubChat({ id: 's1' });

    expect(result?.id).toBe('s1');
    expect(result?.messages).toBe(JSON.stringify([{ id: 'm1' }]));
    expect(result).not.toHaveProperty('messagesRevision');
    expect(result?.chat?.id).toBe('c1');
  });

  it('getSubChat returns null when sub-chat is missing', async () => {
    getSubChatByIdLocalMock.mockResolvedValue(null);
    const { subChatGetRouter } = await import('./get');
    const caller = subChatGetRouter.createCaller({ getWindow: () => null });
    expect(await caller.getSubChat({ id: 'unknown' })).toBeNull();
  });

  // The chat's project must carry git metadata so the chat icon renders the project avatar.
  it('getSubChat carries the project git metadata', async () => {
    getSubChatByIdLocalMock.mockResolvedValue({
      ...makeLocalSubChat({ id: 's1', chatId: 'c1' }),
      messages: [{ id: 'm1' }],
    });
    getChatByIdLocalMock.mockResolvedValue(makeLocalChat({ id: 'c1', projectId: 'p-1' }));
    dbState.projectRows = [
      {
        id: 'p-1',
        name: 'Frink',
        path: '/repos/frink',
        gitRemoteUrl: 'https://github.com/acme/frink',
        gitProvider: 'github',
        gitOwner: 'acme',
        gitRepo: 'frink',
      },
    ];

    const { subChatGetRouter } = await import('./get');
    const caller = subChatGetRouter.createCaller({ getWindow: () => null });
    const result = await caller.getSubChat({ id: 's1' });

    expect(result?.chat?.project).toEqual({
      id: 'p-1',
      name: 'Frink',
      path: '/repos/frink',
      gitRemoteUrl: 'https://github.com/acme/frink',
      gitProvider: 'github',
      gitOwner: 'acme',
      gitRepo: 'frink',
    });
  });
});
