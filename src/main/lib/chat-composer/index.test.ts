import { beforeEach, describe, expect, it, vi } from 'vitest';
import * as schema from '../db/schema';
import { freshDb, type TestDb } from '../db/test-utils/fresh-db';
import { makeLocalChat } from '../trpc/routers/chats/test-factories';

const state = vi.hoisted(() => ({ db: null as unknown }));

vi.mock('electron', () => ({
  app: { getPath: () => '/tmp' },
  BrowserWindow: { getAllWindows: () => [] },
}));
vi.mock('electron-log', () => ({ default: { info: vi.fn(), warn: vi.fn(), error: vi.fn() } }));
vi.mock('../db', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../db')>()),
  getDatabase: () => {
    if (!state.db) throw new Error('database unavailable');
    return state.db;
  },
}));

import { setThinkingEnabled, storedExecutionSettings, updateComposerSettings } from '.';

// What the executor runs a settings-less send (the phone) with.
describe('storedExecutionSettings', () => {
  let db: TestDb;

  beforeEach(() => {
    db = freshDb();
    state.db = db;
    db.insert(schema.chats)
      .values(makeLocalChat({ id: 'c1' }))
      .run();
  });

  it('builds the chat’s stored model, Auto and Thinking as the desktop would send them', () => {
    updateComposerSettings('c1', { modelId: 'opus-4.8-max' });

    expect(storedExecutionSettings('c1', 'claude-code')).toMatchObject({
      model: 'claude-opus-4-8',
      effort: 'max',
      autoReviewTools: true,
    });

    setThinkingEnabled(false);
    expect(storedExecutionSettings('c1', 'claude-code')?.maxThinkingTokens).toBeUndefined();
  });

  it('resolves for the chat’s provider: Codex gets the raw id and its Fast choice', () => {
    updateComposerSettings('c1', { modelId: 'codex-gpt-5.6-sol-medium', codexFastMode: true });
    expect(storedExecutionSettings('c1', 'codex')).toMatchObject({
      model: 'codex-gpt-5.6-sol-medium',
      codexFastMode: true,
    });
  });

  it('leaves the CLI defaults in charge when there is no chat or the lookup fails', () => {
    expect(storedExecutionSettings(undefined, 'claude-code')).toBeUndefined();
    expect(storedExecutionSettings('missing', 'claude-code')).toBeUndefined();
    state.db = null;
    expect(storedExecutionSettings('c1', 'claude-code')).toBeUndefined();
  });
});
