import { beforeEach, describe, expect, it, vi } from 'vitest';

const {
  linkProjectToChatMock,
  unlinkProjectFromChatMock,
  getProjectByIdMock,
  broadcastToRendererMock,
} = vi.hoisted(() => ({
  linkProjectToChatMock: vi.fn(),
  unlinkProjectFromChatMock: vi.fn(),
  getProjectByIdMock: vi.fn(),
  broadcastToRendererMock: vi.fn(),
}));

vi.mock('../../../db', () => ({ getDatabase: () => ({}) }));
vi.mock('../../../db/repos/chat-linked-projects', () => ({
  linkProjectToChat: linkProjectToChatMock,
  unlinkProjectFromChat: unlinkProjectFromChatMock,
}));
vi.mock('../../../db/repos/projects', () => ({ getProjectById: getProjectByIdMock }));
vi.mock('../../../socket/client', () => ({ broadcastToRenderer: broadcastToRendererMock }));

import { linkedProjectsRouter } from './linked-projects';

const caller = () => linkedProjectsRouter.createCaller({ getWindow: () => null });
const ids = { chatId: 'c1', projectId: 'p2' };
const CHANGED = ['chats:linked-projects-changed', { chatId: 'c1' }];

beforeEach(() => {
  vi.resetAllMocks();
  // Only the project being linked has a name, so a lookup by any other id words no refusal.
  getProjectByIdMock.mockImplementation(async (_db: unknown, id: string) =>
    id === 'p2' ? { id: 'p2', name: 'Docs' } : null,
  );
});

describe('chats.linkProject', () => {
  it('links the project and tells every window once', async () => {
    linkProjectToChatMock.mockReturnValue({ ok: true });

    await expect(caller().linkProject(ids)).resolves.toEqual({ success: true });

    expect(linkProjectToChatMock).toHaveBeenCalledWith(expect.anything(), 'c1', 'p2');
    expect(broadcastToRendererMock.mock.calls).toEqual([CHANGED]);
  });

  it.each([
    ['chat-not-found', 'NOT_FOUND', 'Chat not found'],
    ['project-not-found', 'NOT_FOUND', 'This project is no longer in Frink.'],
    ['general-chat', 'BAD_REQUEST', 'Only chats in a project can link other projects.'],
    ['virtual-chat', 'BAD_REQUEST', "Chats in a virtual folder can't link projects."],
    ['main-project', 'BAD_REQUEST', "This is already the chat's project."],
    ['virtual-folder', 'BAD_REQUEST', 'Virtual folders have no files to link.'],
    [
      'root-folder',
      'BAD_REQUEST',
      "Docs is or contains your home folder, a whole drive or a protected folder like ~/.ssh, so it can't be linked.",
    ],
    ['folder-missing', 'BAD_REQUEST', "Can't find Docs's folder."],
    // The repo also refuses a folder overlapping the chat's worktree, so the message names both.
    [
      'overlaps-main',
      'BAD_REQUEST',
      "Docs is inside this chat's project or worktree, or contains one of them, so it can't be linked.",
    ],
  ])('refuses %s as %s "%s" and tells no window', async (reason, code, message) => {
    linkProjectToChatMock.mockReturnValue({ ok: false, reason });

    await expect(caller().linkProject(ids)).rejects.toMatchObject({ code, message });
    expect(broadcastToRendererMock).not.toHaveBeenCalled();
  });

  it.each([
    ['folder-missing', "Can't find this project's folder."],
    [
      'overlaps-main',
      "This project is inside this chat's project or worktree, or contains one of them, so it can't be linked.",
    ],
  ])(
    'still words %s when the project is removed before its name is read',
    async (reason, message) => {
      linkProjectToChatMock.mockReturnValue({ ok: false, reason });
      getProjectByIdMock.mockResolvedValue(null);

      await expect(caller().linkProject(ids)).rejects.toMatchObject({
        code: 'BAD_REQUEST',
        message,
      });
    },
  );
});

describe('chats.unlinkProject', () => {
  it('unlinks the project and tells every window once', async () => {
    unlinkProjectFromChatMock.mockReturnValue(true);

    await expect(caller().unlinkProject(ids)).resolves.toEqual({ success: true });

    expect(unlinkProjectFromChatMock).toHaveBeenCalledWith(expect.anything(), 'c1', 'p2');
    expect(broadcastToRendererMock.mock.calls).toEqual([CHANGED]);
  });

  it('does nothing and tells no window when the project was not linked', async () => {
    unlinkProjectFromChatMock.mockReturnValue(false);

    await expect(caller().unlinkProject(ids)).resolves.toEqual({ success: true });
    expect(broadcastToRendererMock).not.toHaveBeenCalled();
  });
});

it.each(['linkProject', 'unlinkProject'] as const)(
  '%s rejects an empty chat or project id before touching links',
  async (procedure) => {
    for (const input of [
      { ...ids, chatId: '' },
      { ...ids, projectId: '' },
    ]) {
      await expect(caller()[procedure](input)).rejects.toMatchObject({ code: 'BAD_REQUEST' });
    }
    expect(linkProjectToChatMock).not.toHaveBeenCalled();
    expect(unlinkProjectFromChatMock).not.toHaveBeenCalled();
  },
);
