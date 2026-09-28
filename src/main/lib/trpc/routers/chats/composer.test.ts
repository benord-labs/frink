import { beforeEach, describe, expect, it, vi } from 'vitest';
import * as schema from '../../../db/schema';
import { freshDb, type TestDb } from '../../../db/test-utils/fresh-db';
import { makeLocalChat } from './test-factories';

const state = vi.hoisted(() => ({ db: null as unknown, send: vi.fn() }));

vi.mock('electron', () => ({
  app: { getPath: () => '/tmp' },
  BrowserWindow: {
    getAllWindows: () => [
      { isDestroyed: () => false, webContents: { isCrashed: () => false, send: state.send } },
    ],
  },
}));
vi.mock('electron-log', () => ({ default: { info: vi.fn(), warn: vi.fn(), error: vi.fn() } }));
vi.mock('../../../db', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../../db')>()),
  getDatabase: () => state.db,
}));

import { composerRouter } from './composer';

const caller = () => composerRouter.createCaller({ getWindow: () => null });
const broadcasts = (channel: string) =>
  state.send.mock.calls.filter(([c]) => c === channel).map(([, payload]) => payload);

describe('composer settings routes', () => {
  let db: TestDb;

  beforeEach(() => {
    db = freshDb();
    state.db = db;
    state.send.mockReset();
    db.insert(schema.chats)
      .values(makeLocalChat({ id: 'c1' }))
      .run();
  });

  it('reads defaults for a chat nobody configured', async () => {
    await expect(caller().getComposerSettings({ chatId: 'c1' })).resolves.toEqual({
      modelId: 'sonnet',
      autoMode: true,
      codexFastMode: false,
      thinkingEnabled: true,
    });
  });

  it('writes a patch and echoes the confirmed values to every window', async () => {
    const out = await caller().updateComposerSettings({
      chatId: 'c1',
      patch: { modelId: 'opus-4.8', autoMode: false },
    });

    expect(out).toMatchObject({ modelId: 'opus-4.8', autoMode: false, codexFastMode: false });
    expect(broadcasts('composer:changed')).toEqual([
      {
        kind: 'chat',
        chatId: 'c1',
        settings: { modelId: 'opus-4.8', autoMode: false, codexFastMode: false },
      },
    ]);
  });

  it('rejects an unknown chat instead of silently succeeding', async () => {
    await expect(
      caller().updateComposerSettings({ chatId: 'missing', patch: { autoMode: false } }),
    ).rejects.toMatchObject({ code: 'NOT_FOUND' });
    expect(state.send).not.toHaveBeenCalled();
  });

  it('keeps Thinking app-wide and announces it', async () => {
    await caller().setThinkingEnabled({ enabled: false });
    expect(broadcasts('composer:changed')).toEqual([{ kind: 'thinking', thinkingEnabled: false }]);
    await expect(caller().getComposerSettings({ chatId: 'c1' })).resolves.toMatchObject({
      thinkingEnabled: false,
    });
  });

  it('imports a window’s old choices once, without overriding the phone', async () => {
    await caller().updateComposerSettings({ chatId: 'c1', patch: { modelId: 'haiku' } });
    state.send.mockReset();

    await caller().importComposerSettings({
      entries: [{ chatId: 'c1', modelId: 'opus-4.8', codexFastMode: true }],
      thinkingEnabled: false,
    });
    await caller().importComposerSettings({ entries: [], thinkingEnabled: true });

    await expect(caller().getComposerSettings({ chatId: 'c1' })).resolves.toEqual({
      modelId: 'haiku',
      autoMode: true,
      codexFastMode: true,
      thinkingEnabled: false,
    });
    expect(broadcasts('composer:changed').filter((c) => c.kind === 'chat')).toHaveLength(1);
  });

  it('lists every configured chat for window hydration', async () => {
    db.insert(schema.chats)
      .values(makeLocalChat({ id: 'c2' }))
      .run();
    await caller().updateComposerSettings({ chatId: 'c2', patch: { codexFastMode: true } });

    await expect(caller().listComposerSettings()).resolves.toEqual({
      chats: [{ chatId: 'c2', modelId: 'sonnet', autoMode: true, codexFastMode: true }],
      thinkingEnabled: true,
    });
  });
});
