/** Phase 1 local-first migration: chat reads come from local SQLite. */

import { beforeEach, describe, expect, it, vi } from 'vitest';
import { makeLocalChat } from './test-factories';

const getChatByIdLocalMock = vi.fn();
const listSubChatsByChatLocalMock = vi.fn();

// Mutable project row(s) the mocked `db.select()...limit()` resolves to (per-test).
const dbState = vi.hoisted(() => ({ projectRows: [] as unknown[] }));

vi.mock('../../../db', () => ({
  getDatabase: () => ({
    select: () => ({
      from: () => ({ where: () => ({ limit: () => Promise.resolve(dbState.projectRows) }) }),
    }),
  }),
}));
vi.mock('../../../db/repos/chats', () => ({ getChatById: getChatByIdLocalMock }));
vi.mock('../../../db/repos/sub-chats', () => ({ listSubChatsByChat: listSubChatsByChatLocalMock }));

const gitProjectRow = {
  id: 'p-1',
  name: 'Frink',
  path: '/repos/frink',
  gitRemoteUrl: 'https://github.com/acme/frink',
  gitProvider: 'github',
  gitOwner: 'acme',
  gitRepo: 'frink',
  description: null,
  isCrossMachine: false,
};

async function callGet(id: string) {
  const { getRouter } = await import('./get');
  const caller = getRouter.createCaller({ getWindow: () => null });
  return caller.get({ id });
}

describe('chats.get (local-first) project projection', () => {
  beforeEach(() => {
    vi.resetAllMocks();
    dbState.projectRows = [];
    listSubChatsByChatLocalMock.mockResolvedValue([]);
  });

  it('returns null when the chat is missing', async () => {
    getChatByIdLocalMock.mockResolvedValue(null);
    expect(await callGet('unknown')).toBeNull();
  });

  // EC1: a git-backed project must carry the four git fields so the renderer can render the avatar.
  it('carries the git metadata for a git-backed project', async () => {
    getChatByIdLocalMock.mockResolvedValue(makeLocalChat({ id: 'c1', projectId: 'p-1' }));
    dbState.projectRows = [gitProjectRow];

    const result = await callGet('c1');

    expect(result?.project).toEqual({
      id: 'p-1',
      name: 'Frink',
      path: '/repos/frink',
      gitRemoteUrl: 'https://github.com/acme/frink',
      gitProvider: 'github',
      gitOwner: 'acme',
      gitRepo: 'frink',
    });
  });

  // EC2: a non-git project returns null git fields (folder icon, no broken avatar fetch).
  it('returns null git fields for a non-git project', async () => {
    getChatByIdLocalMock.mockResolvedValue(makeLocalChat({ id: 'c1', projectId: 'p-2' }));
    dbState.projectRows = [
      {
        id: 'p-2',
        name: 'plain',
        path: '/tmp/plain',
        gitRemoteUrl: null,
        gitProvider: null,
        gitOwner: null,
        gitRepo: null,
      },
    ];

    const result = await callGet('c1');

    expect(result?.project).toEqual({
      id: 'p-2',
      name: 'plain',
      path: '/tmp/plain',
      gitRemoteUrl: null,
      gitProvider: null,
      gitOwner: null,
      gitRepo: null,
    });
  });

  // EC3: a general chat (no projectId) returns project: null.
  it('returns null project for a general chat', async () => {
    getChatByIdLocalMock.mockResolvedValue(makeLocalChat({ id: 'c1', projectId: null }));

    const result = await callGet('c1');

    expect(result?.project).toBeNull();
  });
});
