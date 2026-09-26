import { describe, expect, it, vi } from 'vitest';
import { createIdSelectionStore } from './id-selection-store';

const ORDER = ['a', 'b', 'c', 'd', 'e'];

describe('createIdSelectionStore', () => {
  it('toggles ids in and out', () => {
    const store = createIdSelectionStore();
    store.toggle('a');
    store.toggle('c');
    expect([...store.getSnapshot()]).toEqual(['a', 'c']);
    store.toggle('a');
    expect([...store.getSnapshot()]).toEqual(['c']);
  });

  it('selects a range from the anchor in either direction', () => {
    const store = createIdSelectionStore();
    store.toggle('b');
    store.selectRange('d', ORDER);
    expect([...store.getSnapshot()]).toEqual(['b', 'c', 'd']);
    store.selectRange('a', ORDER);
    expect([...store.getSnapshot()]).toEqual(['a', 'b']);
  });

  it('starts a range from the anchor left by clear', () => {
    const store = createIdSelectionStore();
    store.clear('c');
    expect(store.getSnapshot().size).toBe(0);
    store.selectRange('e', ORDER);
    expect([...store.getSnapshot()]).toEqual(['c', 'd', 'e']);
  });

  it('selects only the clicked id when there is no usable anchor', () => {
    const store = createIdSelectionStore();
    store.selectRange('d', ORDER);
    expect([...store.getSnapshot()]).toEqual(['d']);
    store.clear('gone');
    store.selectRange('b', ORDER);
    expect([...store.getSnapshot()]).toEqual(['b']);
  });

  it('deselects one id and ignores ids that are not selected', () => {
    const store = createIdSelectionStore();
    store.toggle('a');
    store.toggle('b');
    const before = store.getSnapshot();
    store.deselect('z');
    expect(store.getSnapshot()).toBe(before);
    store.deselect('a');
    expect([...store.getSnapshot()]).toEqual(['b']);
  });

  it('notifies subscribers on change but not on a no-op clear', () => {
    const store = createIdSelectionStore();
    const listener = vi.fn();
    const unsubscribe = store.subscribe(listener);
    store.clear();
    expect(listener).not.toHaveBeenCalled();
    store.toggle('a');
    expect(listener).toHaveBeenCalledTimes(1);
    unsubscribe();
    store.toggle('b');
    expect(listener).toHaveBeenCalledTimes(1);
  });
});
