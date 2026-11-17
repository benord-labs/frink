import { createStore } from 'jotai';
import { describe, expect, it } from 'vitest';
import { chatContextFileAtomFamily, chatContextFileDismissedAtomFamily } from './chat-context-file';

const notes = { name: 'notes.md', path: '/repo/notes.md' };
const other = { name: 'other.ts', path: '/repo/other.ts' };

describe('chat context file', () => {
  it('keeps a removed file removed when the same file is written again', () => {
    const store = createStore();
    store.set(chatContextFileAtomFamily('same-path'), notes);
    store.set(chatContextFileDismissedAtomFamily('same-path'), true);

    // The editor re-points the chat at the file on screen on every cursor move.
    store.set(chatContextFileAtomFamily('same-path'), { ...notes });

    expect(store.get(chatContextFileDismissedAtomFamily('same-path'))).toBe(true);
    expect(store.get(chatContextFileAtomFamily('same-path'))).toEqual(notes);
  });

  it('attaches a different file again after an earlier one was removed', () => {
    const store = createStore();
    store.set(chatContextFileAtomFamily('new-path'), notes);
    store.set(chatContextFileDismissedAtomFamily('new-path'), true);

    store.set(chatContextFileAtomFamily('new-path'), other);

    expect(store.get(chatContextFileDismissedAtomFamily('new-path'))).toBe(false);
    expect(store.get(chatContextFileAtomFamily('new-path'))).toEqual(other);
  });

  it('keeps each chat to its own file and its own removal', () => {
    const store = createStore();
    store.set(chatContextFileAtomFamily('chat-a'), notes);
    store.set(chatContextFileDismissedAtomFamily('chat-a'), true);

    store.set(chatContextFileAtomFamily('chat-b'), other);

    expect(store.get(chatContextFileDismissedAtomFamily('chat-a'))).toBe(true);
    expect(store.get(chatContextFileAtomFamily('chat-a'))).toEqual(notes);
  });
});
