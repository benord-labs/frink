// @vitest-environment happy-dom
import { createStore } from 'jotai';
import { describe, expect, it } from 'vitest';
import { compactingForSubChatAtomFamily, compactingSubChatsAtom } from './index';

/**
 * Per-subchat derived atom: only panes whose subChatId is in the set should
 * see true — avoids subscribing every pane to the full Set.
 */
describe('compactingForSubChatAtomFamily', () => {
  it('is true only for ids present in compactingSubChatsAtom', () => {
    const store = createStore();
    const a = 'sub-a';
    const b = 'sub-b';

    store.set(compactingSubChatsAtom, new Set([a]));

    expect(store.get(compactingForSubChatAtomFamily(a))).toBe(true);
    expect(store.get(compactingForSubChatAtomFamily(b))).toBe(false);
  });

  it('updates when the shared Set is replaced (add and remove)', () => {
    const store = createStore();
    const id = 'sub-toggle';

    store.set(compactingSubChatsAtom, new Set([id]));
    expect(store.get(compactingForSubChatAtomFamily(id))).toBe(true);

    store.set(compactingSubChatsAtom, new Set());
    expect(store.get(compactingForSubChatAtomFamily(id))).toBe(false);

    store.set(compactingSubChatsAtom, new Set([id]));
    expect(store.get(compactingForSubChatAtomFamily(id))).toBe(true);
  });

  it('does not treat unrelated subChatIds as compacting when another id is active', () => {
    const store = createStore();
    store.set(compactingSubChatsAtom, new Set(['other']));
    expect(store.get(compactingForSubChatAtomFamily('pane-1'))).toBe(false);
  });
});
