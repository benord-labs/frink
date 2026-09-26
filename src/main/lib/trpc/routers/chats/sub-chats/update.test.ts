/**
 * renameSubChat propagation: the first (oldest) sub-chat's title is the parent
 * chat's title, so renaming it must also rename the parent and broadcast
 * `chats:name-updated` (the single channel the sidebar/header listen on).
 * Renaming a non-first sub-chat touches only that sub-chat — no parent write,
 * no broadcast (a broadcast would relabel the parent in the sidebar).
 */

import { beforeEach, describe, expect, it, vi } from 'vitest';
import { makeLocalSubChat } from '../test-factories';

const getSubChatByIdLocalMock = vi.fn();
const listSubChatsByChatMock = vi.fn();
const renameSubChatLocalMock = vi.fn();
const seedUserMessageIfEmptyLocalMock = vi.fn();
const updateChatLocalMock = vi.fn();
const updateSubChatModeLocalMock = vi.fn();
const broadcastChatNameUpdatedMock = vi.fn();
const sendSubChatModeChangeMock = vi.fn();

vi.mock('../../../../db', () => ({ getDatabase: () => ({}) }));
// Keep the real `pickOldestSubChat` (pure) — only the DB-touching fns are stubbed.
vi.mock('../../../../db/repos/sub-chats', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../../../db/repos/sub-chats')>()),
  getSubChatById: getSubChatByIdLocalMock,
  listSubChatsByChat: listSubChatsByChatMock,
  renameSubChat: renameSubChatLocalMock,
  seedUserMessageIfEmpty: seedUserMessageIfEmptyLocalMock,
  updateSubChatMode: updateSubChatModeLocalMock,
}));
vi.mock('../../../../db/repos/chats', () => ({ updateChat: updateChatLocalMock }));
vi.mock('../../../../socket/client', () => ({
  sendSubChatModeChange: sendSubChatModeChangeMock,
}));
vi.mock('../helpers/name-generation-async', () => ({
  broadcastChatNameUpdated: broadcastChatNameUpdatedMock,
}));

const hydrated = (overrides: Parameters<typeof makeLocalSubChat>[0]) => ({
  ...makeLocalSubChat(overrides),
  messages: [],
});

describe('subChatUpdateRouter.seedUserMessageIfEmpty', () => {
  beforeEach(() => {
    vi.resetAllMocks();
  });

  it('accepts only the narrow user-text payload and returns the seed outcome', async () => {
    const subChat = hydrated({ id: 's1', chatId: 'c1' });
    seedUserMessageIfEmptyLocalMock.mockResolvedValue({ seeded: true, subChat });
    const { subChatUpdateRouter } = await import('./update');
    const caller = subChatUpdateRouter.createCaller({ getWindow: () => null });
    const message = {
      id: 'msg-task-1',
      role: 'user' as const,
      parts: [{ type: 'text' as const, text: 'Prompt' }],
    };

    const result = await caller.seedUserMessageIfEmpty({ id: 's1', message });

    expect(seedUserMessageIfEmptyLocalMock).toHaveBeenCalledWith(expect.anything(), 's1', message);
    expect(result).toMatchObject({ seeded: true, subChat: { id: 's1', messages: '[]' } });
  });

  it.each([
    ['assistant role', { id: 'm', role: 'assistant', parts: [{ type: 'text', text: 'x' }] }],
    [
      'extra metadata',
      { id: 'm', role: 'user', parts: [{ type: 'text', text: 'x' }], metadata: {} },
    ],
    ['blank text', { id: 'm', role: 'user', parts: [{ type: 'text', text: ' ' }] }],
  ])('rejects %s before reaching the repository', async (_name, message) => {
    const { subChatUpdateRouter } = await import('./update');
    const caller = subChatUpdateRouter.createCaller({ getWindow: () => null });

    await expect(
      caller.seedUserMessageIfEmpty({ id: 's1', message: message as never }),
    ).rejects.toThrow();
    expect(seedUserMessageIfEmptyLocalMock).not.toHaveBeenCalled();
  });
});

describe('subChatUpdateRouter.updateSubChatMode', () => {
  beforeEach(() => {
    vi.resetAllMocks();
  });

  it('broadcasts the CONFIRMED row mode after the write, not the requested one', async () => {
    // A concurrent writer can land between this route's write and its re-read; the echo must
    // announce the row's actual value or the renderer mirrors (and intent-clearing) desync.
    getSubChatByIdLocalMock.mockResolvedValue(
      hydrated({ id: 's1', chatId: 'c1', name: 'x', mode: 'agent' }),
    );

    const { subChatUpdateRouter } = await import('./update');
    const caller = subChatUpdateRouter.createCaller({ getWindow: () => null });
    await caller.updateSubChatMode({ id: 's1', mode: 'plan' });

    expect(updateSubChatModeLocalMock).toHaveBeenCalledWith(expect.anything(), 's1', 'plan');
    expect(sendSubChatModeChangeMock).toHaveBeenCalledWith({
      chatId: 'c1',
      subChatId: 's1',
      mode: 'agent',
    });
  });

  it('does not broadcast when the sub-chat row is missing', async () => {
    getSubChatByIdLocalMock.mockResolvedValue(null);

    const { subChatUpdateRouter } = await import('./update');
    const caller = subChatUpdateRouter.createCaller({ getWindow: () => null });
    const result = await caller.updateSubChatMode({ id: 'ghost', mode: 'agent' });

    expect(result).toBeNull();
    expect(sendSubChatModeChangeMock).not.toHaveBeenCalled();
  });

  it('serializes same-sub-chat writes through confirmed read and broadcast', async () => {
    const events: string[] = [];
    let releaseFirstWrite: (() => void) | undefined;
    const firstWritePending = new Promise<void>((resolve) => {
      releaseFirstWrite = resolve;
    });
    updateSubChatModeLocalMock.mockImplementation(async (_db, _id, mode: string) => {
      events.push(`write:${mode}`);
      if (mode === 'plan') await firstWritePending;
    });
    getSubChatByIdLocalMock
      .mockImplementationOnce(async () => {
        events.push('read:plan');
        return hydrated({ id: 's1', chatId: 'c1', mode: 'plan' });
      })
      .mockImplementationOnce(async () => {
        events.push('read:agent');
        return hydrated({ id: 's1', chatId: 'c1', mode: 'agent' });
      });
    sendSubChatModeChangeMock.mockImplementation(({ mode }: { mode: string }) => {
      events.push(`broadcast:${mode}`);
    });

    const { subChatUpdateRouter } = await import('./update');
    const caller = subChatUpdateRouter.createCaller({ getWindow: () => null });
    const first = caller.updateSubChatMode({ id: 's1', mode: 'plan' });
    await vi.waitFor(() => expect(events).toEqual(['write:plan']));
    const second = caller.updateSubChatMode({ id: 's1', mode: 'agent' });
    await Promise.resolve();
    expect(events).toEqual(['write:plan']);

    releaseFirstWrite?.();
    await Promise.all([first, second]);

    expect(events).toEqual([
      'write:plan',
      'read:plan',
      'broadcast:plan',
      'write:agent',
      'read:agent',
      'broadcast:agent',
    ]);
  });
});

describe('subChatUpdateRouter.renameSubChat', () => {
  beforeEach(() => {
    vi.resetAllMocks();
  });

  it('renames the parent and broadcasts when the renamed sub-chat is the oldest', async () => {
    getSubChatByIdLocalMock.mockResolvedValue(hydrated({ id: 's1', chatId: 'c1', name: 'New' }));
    listSubChatsByChatMock.mockResolvedValue([
      makeLocalSubChat({ id: 's1', chatId: 'c1', createdAt: new Date('2026-01-01') }),
      makeLocalSubChat({ id: 's2', chatId: 'c1', createdAt: new Date('2026-02-01') }),
    ]);

    const { subChatUpdateRouter } = await import('./update');
    const caller = subChatUpdateRouter.createCaller({ getWindow: () => null });
    const result = await caller.renameSubChat({ id: 's1', name: 'My title' });

    expect(renameSubChatLocalMock).toHaveBeenCalledWith(expect.anything(), 's1', 'My title');
    expect(updateChatLocalMock).toHaveBeenCalledWith(expect.anything(), 'c1', { name: 'My title' });
    expect(broadcastChatNameUpdatedMock).toHaveBeenCalledWith('c1', 's1', 'My title');
    expect(result?.id).toBe('s1');
  });

  it('renames only the sub-chat (no parent write, no broadcast) when it is not the oldest', async () => {
    getSubChatByIdLocalMock.mockResolvedValue(hydrated({ id: 's2', chatId: 'c1', name: 'New' }));
    listSubChatsByChatMock.mockResolvedValue([
      makeLocalSubChat({ id: 's1', chatId: 'c1', createdAt: new Date('2026-01-01') }),
      makeLocalSubChat({ id: 's2', chatId: 'c1', createdAt: new Date('2026-02-01') }),
    ]);

    const { subChatUpdateRouter } = await import('./update');
    const caller = subChatUpdateRouter.createCaller({ getWindow: () => null });
    await caller.renameSubChat({ id: 's2', name: 'Second tab' });

    expect(renameSubChatLocalMock).toHaveBeenCalledWith(expect.anything(), 's2', 'Second tab');
    expect(updateChatLocalMock).not.toHaveBeenCalled();
    expect(broadcastChatNameUpdatedMock).not.toHaveBeenCalled();
  });

  it('returns null and skips parent rename when the sub-chat is missing', async () => {
    getSubChatByIdLocalMock.mockResolvedValue(null);

    const { subChatUpdateRouter } = await import('./update');
    const caller = subChatUpdateRouter.createCaller({ getWindow: () => null });
    const result = await caller.renameSubChat({ id: 'gone', name: 'X' });

    expect(result).toBeNull();
    expect(listSubChatsByChatMock).not.toHaveBeenCalled();
    expect(updateChatLocalMock).not.toHaveBeenCalled();
    expect(broadcastChatNameUpdatedMock).not.toHaveBeenCalled();
  });
});
