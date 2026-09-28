import { beforeEach, describe, expect, it } from 'vitest';
import { makeLocalChat } from '../../trpc/routers/chats/test-factories';
import * as schema from '../schema';
import { freshDb, type TestDb } from '../test-utils/fresh-db';
import { forkChatWithSubChats } from './chats';
import {
  fillMissingComposerSettings,
  getChatComposerSettings,
  getPreference,
  listStoredComposerSettings,
  setPreference,
  updateChatComposerSettings,
} from './composer-settings';

let db: TestDb;
type RepoDb = Parameters<typeof getChatComposerSettings>[0];
const repoDb = () => db as unknown as RepoDb;

const seed = (id: string) => db.insert(schema.chats).values(makeLocalChat({ id })).run();

describe('composer settings repo', () => {
  beforeEach(() => {
    db = freshDb();
  });

  it('starts a chat with nothing set, and returns null for an unknown chat', () => {
    seed('c1');
    expect(getChatComposerSettings(repoDb(), 'c1')).toEqual({
      modelId: null,
      autoMode: null,
      codexFastMode: null,
    });
    expect(getChatComposerSettings(repoDb(), 'missing')).toBeNull();
  });

  it('writes only the patched fields and returns the confirmed row', () => {
    seed('c1');
    updateChatComposerSettings(repoDb(), 'c1', { modelId: 'opus-4.8', autoMode: false });
    expect(updateChatComposerSettings(repoDb(), 'c1', { codexFastMode: true })).toEqual({
      modelId: 'opus-4.8',
      autoMode: false,
      codexFastMode: true,
    });
  });

  it('import fills only unset values, so it never overwrites a choice made elsewhere', () => {
    seed('c1');
    seed('c2');
    updateChatComposerSettings(repoDb(), 'c1', { modelId: 'haiku' });

    const changed = fillMissingComposerSettings(repoDb(), [
      { chatId: 'c1', modelId: 'opus-4.8', autoMode: false },
      { chatId: 'c2', modelId: 'sonnet' },
      { chatId: 'gone', modelId: 'sonnet' },
    ]);

    expect(getChatComposerSettings(repoDb(), 'c1')).toMatchObject({
      modelId: 'haiku',
      autoMode: false,
    });
    expect(getChatComposerSettings(repoDb(), 'c2')?.modelId).toBe('sonnet');
    expect(changed.map((c) => c.chatId)).toEqual(['c1', 'c2']);
    // Re-running is a no-op.
    expect(fillMissingComposerSettings(repoDb(), [{ chatId: 'c2', modelId: 'opus-4.8' }])).toEqual(
      [],
    );
  });

  it('lists only chats with a stored value', () => {
    seed('c1');
    seed('c2');
    updateChatComposerSettings(repoDb(), 'c2', { autoMode: false });
    expect(listStoredComposerSettings(repoDb())).toEqual([
      { chatId: 'c2', modelId: null, autoMode: false, codexFastMode: null },
    ]);
  });

  it('a fork keeps the source chat composer settings', async () => {
    seed('c1');
    updateChatComposerSettings(repoDb(), 'c1', { modelId: 'opus-4.8', codexFastMode: true });
    const { chat } = await forkChatWithSubChats(repoDb(), 'c1');
    expect(getChatComposerSettings(repoDb(), chat.id)).toEqual({
      modelId: 'opus-4.8',
      autoMode: null,
      codexFastMode: true,
    });
  });

  it('round-trips JSON preferences and reports unset ones as undefined', () => {
    expect(getPreference(repoDb(), 'composer.thinkingEnabled')).toBeUndefined();
    setPreference(repoDb(), 'composer.thinkingEnabled', false);
    expect(getPreference(repoDb(), 'composer.thinkingEnabled')).toBe(false);
    setPreference(repoDb(), 'composer.thinkingEnabled', true);
    expect(getPreference(repoDb(), 'composer.thinkingEnabled')).toBe(true);
  });
});
