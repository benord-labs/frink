import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { FileTreeItemMeta } from '../types';
import {
  createSelectionStore,
  NOOP_SELECTION_STORE,
  type SelectionStore,
} from './use-multi-select';

const meta = (name: string, type: 'file' | 'folder' = 'file'): FileTreeItemMeta => ({ name, type });
/** metaLookup that derives a file meta from the path's basename */
const lookup = (p: string): FileTreeItemMeta => ({ name: p.split('/').pop() ?? p, type: 'file' });

describe('createSelectionStore', () => {
  let store: SelectionStore;
  beforeEach(() => {
    store = createSelectionStore();
  });

  describe('selectOne', () => {
    it('replaces the selection with a single path and sets it as primary', () => {
      store.selectOne('src/a.ts', meta('a.ts'));
      expect(store.isSelected('src/a.ts')).toBe(true);
      expect(store.getCount()).toBe(1);
      expect(store.getPrimary()).toEqual({ path: 'src/a.ts', name: 'a.ts', type: 'file' });
      const snap = store.getSnapshot();
      expect(snap.anchor).toBe('src/a.ts');
    });

    it('clears a previous selection', () => {
      store.selectOne('src/a.ts', meta('a.ts'));
      store.selectOne('src/b.ts', meta('b.ts'));
      expect(store.isSelected('src/a.ts')).toBe(false);
      expect(store.getCount()).toBe(1);
    });
  });

  describe('toggleItem', () => {
    it('adds then removes a path, and getPrimary returns null once the primary is removed', () => {
      store.toggleItem('src/a.ts', meta('a.ts'));
      expect(store.isSelected('src/a.ts')).toBe(true);
      expect(store.getCount()).toBe(1);

      // Removing the item also removes it from `items`, so the (now dangling) primary
      // resolves to null — this is what lets `paths.has` alone drive the highlight.
      store.toggleItem('src/a.ts', meta('a.ts'));
      expect(store.isSelected('src/a.ts')).toBe(false);
      expect(store.getCount()).toBe(0);
      expect(store.getPrimary()).toBeNull();
    });

    it('accumulates multiple paths', () => {
      store.toggleItem('src/a.ts', meta('a.ts'));
      store.toggleItem('src/b.ts', meta('b.ts'));
      expect(store.getCount()).toBe(2);
      expect(store.isSelected('src/a.ts')).toBe(true);
      expect(store.isSelected('src/b.ts')).toBe(true);
    });
  });

  describe('selectRange', () => {
    const visible = ['a', 'b', 'c', 'd', 'e'];

    it('selects a contiguous range from the anchor', () => {
      store.selectOne('b', meta('b'));
      store.selectRange('d', visible, lookup);
      expect(Array.from(store.getSnapshot().paths)).toEqual(['b', 'c', 'd']);
      expect(store.getSnapshot().anchor).toBe('b'); // anchor stays for continuous Shift+Arrow
    });

    it('selects the single target when there is no anchor', () => {
      store.selectRange('c', visible, lookup);
      expect(store.getCount()).toBe(1);
      expect(store.isSelected('c')).toBe(true);
    });

    it('is a no-op when the target is not in the visible list (selection unchanged)', () => {
      store.selectOne('b', meta('b'));
      const before = store.getSnapshot();
      store.selectRange('not-visible', visible, lookup);
      expect(store.getSnapshot()).toBe(before); // same reference — nothing committed
      expect(store.getCount()).toBe(1);
    });
  });

  describe('selectAll / clearSelection', () => {
    it('selects every visible path', () => {
      store.selectAll(['a', 'b', 'c'], lookup);
      expect(store.getCount()).toBe(3);
      expect(store.getSnapshot().anchor).toBe('a');
    });

    it('clears everything and resets the primary', () => {
      store.selectAll(['a', 'b'], lookup);
      store.clearSelection();
      expect(store.getCount()).toBe(0);
      expect(store.getPrimary()).toBeNull();
    });
  });

  describe('deselectDescendants', () => {
    it('removes descendants of a collapsed folder without touching prefix-collision siblings', () => {
      // `src/a` and `src/ab` share a textual prefix but are different folders.
      store.selectAll(['src/a/x.ts', 'src/ab/y.ts', 'keep.ts'], lookup);
      store.deselectDescendants('src/a');
      expect(store.isSelected('src/a/x.ts')).toBe(false); // real descendant removed
      expect(store.isSelected('src/ab/y.ts')).toBe(true); // prefix collision preserved
      expect(store.isSelected('keep.ts')).toBe(true);
    });

    it('resets the anchor to the folder when the anchor was a removed descendant', () => {
      store.selectOne('src/a/x.ts', meta('x.ts'));
      store.deselectDescendants('src/a');
      expect(store.getSnapshot().anchor).toBe('src/a');
    });

    it('is a no-op when nothing is a descendant', () => {
      store.selectAll(['other/x.ts'], lookup);
      const before = store.getSnapshot();
      store.deselectDescendants('src/a');
      expect(store.getSnapshot()).toBe(before);
    });
  });

  describe('getBatchDragItems', () => {
    it('returns undefined for a single-item selection (below the batch threshold)', () => {
      store.selectOne('a', meta('a'));
      expect(store.getBatchDragItems('a')).toBeUndefined();
    });

    it('returns undefined when the dragged path is not part of the selection', () => {
      store.selectAll(['a', 'b'], lookup);
      expect(store.getBatchDragItems('z')).toBeUndefined();
    });

    it('returns the other selected items (excluding the dragged one)', () => {
      store.selectAll(['a', 'b', 'c'], lookup);
      const items = store.getBatchDragItems('a');
      expect(items?.map((i) => i.path).sort()).toEqual(['b', 'c']);
      expect(items?.some((i) => i.path === 'a')).toBe(false);
    });
  });

  describe('subscribe / getSnapshot', () => {
    it('notifies listeners on mutation and stops after unsubscribe', () => {
      const listener = vi.fn();
      const unsubscribe = store.subscribe(listener);
      store.selectOne('a', meta('a'));
      expect(listener).toHaveBeenCalledTimes(1);
      unsubscribe();
      store.selectOne('b', meta('b'));
      expect(listener).toHaveBeenCalledTimes(1);
    });

    it('keeps a stable snapshot reference between mutations, and a fresh one after (useSyncExternalStore contract)', () => {
      const s1 = store.getSnapshot();
      expect(store.getSnapshot()).toBe(s1); // stable → no render loop
      store.selectOne('a', meta('a'));
      const s2 = store.getSnapshot();
      expect(s2).not.toBe(s1); // changed → triggers a render
      expect(store.getSnapshot()).toBe(s2);
    });
  });
});

describe('NOOP_SELECTION_STORE', () => {
  it('is inert for reads and mutations', () => {
    expect(NOOP_SELECTION_STORE.isSelected('anything')).toBe(false);
    expect(NOOP_SELECTION_STORE.getCount()).toBe(0);
    expect(NOOP_SELECTION_STORE.getPrimary()).toBeNull();
    expect(NOOP_SELECTION_STORE.getBatchDragItems('a')).toBeUndefined();
    // Mutations and subscribe must not throw.
    const unsub = NOOP_SELECTION_STORE.subscribe(() => {});
    expect(() => {
      NOOP_SELECTION_STORE.selectOne('a', meta('a'));
      NOOP_SELECTION_STORE.clearSelection();
      unsub();
    }).not.toThrow();
    expect(NOOP_SELECTION_STORE.getCount()).toBe(0);
  });
});
