import { describe, expect, it } from 'vitest';
import type { KeyValue } from './computer-store';
import { readLastChat, saveLastChat } from './last-chat';

function memoryStore(values = new Map<string, string>()): KeyValue {
  return {
    get: async (key) => values.get(key) ?? null,
    set: async (key, value) => void values.set(key, value),
    remove: async (key) => void values.delete(key),
  };
}

describe('the last conversation on screen', () => {
  it('round-trips per computer and clears', async () => {
    const store = memoryStore();
    await saveLastChat(store, 'mac-1', { id: 'chat-1', subChatId: 'sub-1' });
    expect(await readLastChat(store, 'mac-1')).toEqual({ id: 'chat-1', subChatId: 'sub-1' });
    expect(await readLastChat(store, 'mac-2')).toBeNull();
    await saveLastChat(store, 'mac-1', null);
    expect(await readLastChat(store, 'mac-1')).toBeNull();
  });

  it('reads a damaged or unavailable value as nothing to reopen', async () => {
    const damaged = memoryStore(new Map([['frink.mobile.last-chat.v1.mac-1', '{"id":']]));
    expect(await readLastChat(damaged, 'mac-1')).toBeNull();
    const locked = { ...memoryStore(), get: () => Promise.reject(new Error('locked')) };
    expect(await readLastChat(locked, 'mac-1')).toBeNull();
  });
});
