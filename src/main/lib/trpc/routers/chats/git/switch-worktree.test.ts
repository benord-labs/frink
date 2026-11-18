import { beforeEach, expect, it, vi } from 'vitest';
import { makeLocalChat } from '../test-factories';

const mocks = vi.hoisted(() => ({
  getChatById: vi.fn(),
  findChatByWorktree: vi.fn(),
  updateChat: vi.fn(),
  dropLinksOverlapping: vi.fn(),
  broadcastLinkedProjectsChanged: vi.fn(),
}));

vi.mock('../../../../db', () => ({ getDatabase: () => ({}) }));
vi.mock('../../../../db/repos/chats', () => ({
  getChatById: mocks.getChatById,
  findChatByWorktree: mocks.findChatByWorktree,
  updateChat: mocks.updateChat,
}));
vi.mock('../../../../db/repos/chat-linked-projects', () => ({
  dropLinksOverlapping: mocks.dropLinksOverlapping,
}));
vi.mock('../../../../git/cache', () => ({
  gitCache: { invalidateStatus: () => undefined, invalidateParsedDiff: () => undefined },
}));
// The worktree has no branch checked out, so no git runs.
vi.mock('../../../../git/worktree', () => ({
  getCurrentBranch: async () => null,
  getDefaultBranch: async () => 'main',
  detectBaseBranch: async () => null,
}));
vi.mock('../helpers/linked-projects-changed', () => ({
  broadcastLinkedProjectsChanged: mocks.broadcastLinkedProjectsChanged,
}));

import { switchWorktreeRouter } from './switch-worktree';

const caller = () => switchWorktreeRouter.createCaller({ getWindow: () => null });

beforeEach(() => {
  vi.resetAllMocks();
  mocks.getChatById.mockResolvedValue(makeLocalChat({ id: 'c1', worktreePath: '/wt/old' }));
  mocks.findChatByWorktree.mockResolvedValue(null);
  mocks.updateChat.mockResolvedValue(makeLocalChat({ id: 'c1', worktreePath: '/wt/new' }));
});

// A switch into, or around, a linked project's folder drops that link, which every window showing
// the chat must hear about; a switch that drops none tells no window.
it.each([true, false])(
  'tells every window when the switch drops a linked project (dropped: %s)',
  async (dropped) => {
    mocks.dropLinksOverlapping.mockReturnValue(dropped);

    await expect(
      caller().switchWorktree({ chatId: 'c1', worktreePath: '/wt/new' }),
    ).resolves.toMatchObject({ success: true, worktreePath: '/wt/new' });

    expect(mocks.dropLinksOverlapping).toHaveBeenCalledWith(expect.anything(), 'c1', ['/wt/new']);
    expect(mocks.broadcastLinkedProjectsChanged.mock.calls).toEqual(dropped ? [['c1']] : []);
  },
);
