import { createStore } from 'jotai';
import { describe, expect, it } from 'vitest';
import { cleanupChatScopedState } from '../atoms/atom-family-factory';
import {
  addChatTreeProjectAtom,
  chatTreeProjectIdsAtomFamily,
  removeChatTreeProjectAtom,
} from './tree-projects';

/** A store holding `ids` for `chatId`, with a count of the writes that reached subscribers. */
function storeWith(chatId: string, ids: string[]) {
  const store = createStore();
  ids.forEach((projectId) => store.set(addChatTreeProjectAtom, { chatId, projectId }));
  const writes = { count: 0 };
  store.sub(chatTreeProjectIdsAtomFamily(chatId), () => writes.count++);
  return { store, writes, ids: () => store.get(chatTreeProjectIdsAtomFamily(chatId)) };
}

describe('chat tree projects', () => {
  it('adds in order and adds a project already in the list only once', () => {
    const { store, writes, ids } = storeWith('add', ['api', 'web']);

    store.set(addChatTreeProjectAtom, { chatId: 'add', projectId: 'api' });

    expect(ids()).toEqual(['api', 'web']);
    expect(writes.count).toBe(0);
  });

  it('removes a project, and removing one not in the list writes nothing', () => {
    const { store, writes, ids } = storeWith('remove', ['api', 'web']);

    store.set(removeChatTreeProjectAtom, { chatId: 'remove', projectId: 'docs' });
    expect(writes.count).toBe(0);

    store.set(removeChatTreeProjectAtom, { chatId: 'remove', projectId: 'api' });
    expect(ids()).toEqual(['web']);
  });

  it('keeps each chat to its own list', () => {
    const { store } = storeWith('chat-a', ['api']);

    store.set(addChatTreeProjectAtom, { chatId: 'chat-b', projectId: 'web' });

    expect(store.get(chatTreeProjectIdsAtomFamily('chat-a'))).toEqual(['api']);
    expect(store.get(chatTreeProjectIdsAtomFamily('chat-b'))).toEqual(['web']);
  });

  it('forgets the list when the chat is archived or deleted', () => {
    const { ids } = storeWith('archived', ['api']);

    cleanupChatScopedState('archived');

    expect(ids()).toEqual([]);
  });
});
