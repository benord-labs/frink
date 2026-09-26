// @vitest-environment happy-dom
import { createStore } from 'jotai';
import { describe, expect, it } from 'vitest';
import { newChatWorktreePathAtom } from './index';

/**
 * Edge case #1 (MEDIUM): newChatWorktreePathAtom is a global singleton.
 * In split view, two new-chat panes share the same atom. Selecting a worktree
 * in pane A silently changes pane B's perceived worktree path.
 *
 * Compare with newChatPaneProjectMapAtom, which is keyed per pane index.
 * newChatWorktreePathAtom lacks pane-scoped isolation.
 */
describe('newChatWorktreePathAtom — split-view isolation', () => {
  it('is a single atom shared across all consumers (no per-pane scoping)', () => {
    const store = createStore();

    // Simulates "pane A" writing a worktree path
    store.set(newChatWorktreePathAtom, '/worktrees/repo/pane-a-worktree');

    // "pane B" reading the atom sees pane A's value — unintended cross-talk.
    const paneB = store.get(newChatWorktreePathAtom);
    expect(paneB).toBe('/worktrees/repo/pane-a-worktree');
  });

  it('last writer wins when both panes set different paths', () => {
    const store = createStore();

    store.set(newChatWorktreePathAtom, '/worktrees/repo/pane-a');
    store.set(newChatWorktreePathAtom, '/worktrees/repo/pane-b');

    // Pane A would now see pane B's value — data corruption in split view.
    expect(store.get(newChatWorktreePathAtom)).toBe('/worktrees/repo/pane-b');
  });

  it('resetting from one pane clears the other pane selection', () => {
    const store = createStore();

    // Pane A selects a worktree
    store.set(newChatWorktreePathAtom, '/worktrees/repo/important-worktree');

    // Pane B changes project, which triggers setSelectedWorktreePath(null)
    store.set(newChatWorktreePathAtom, null);

    // Pane A's selection is now gone
    expect(store.get(newChatWorktreePathAtom)).toBeNull();
  });
});
