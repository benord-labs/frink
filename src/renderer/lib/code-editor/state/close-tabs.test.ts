import { createStore } from 'jotai';
import { describe, expect, it } from 'vitest';
import {
  codeEditorOpenAtom,
  fileKey,
  openFileAtom,
  openFilesAtom,
  updateFileContentAtom,
} from './atoms';
import {
  closePaneTabsAtom,
  pendingCloseKeysAtom,
  requestCloseAllFilesAtom,
  requestCloseFilesAtom,
} from './close-tabs';

const clean = fileKey('src/clean.ts', '/repo');
const dirty = fileKey('src/dirty.ts', '/repo');

/** Two pinned tabs in /repo opened from pane 1; dirty.ts has an unsaved edit. */
function storeWithTabs() {
  const store = createStore();
  for (const name of ['clean.ts', 'dirty.ts']) {
    store.set(openFileAtom, {
      path: `src/${name}`,
      name,
      projectPath: '/repo',
      sourcePaneIndex: 1,
      intent: 'pinned',
    });
  }
  store.set(updateFileContentAtom, { key: dirty, content: 'edited' });
  return store;
}

const openKeys = (store: ReturnType<typeof createStore>) =>
  store.get(openFilesAtom).map((f) => fileKey(f.path, f.projectPath));

describe('requestCloseFilesAtom (Cmd+W and the tab close button)', () => {
  it('closes a saved tab with no prompt', () => {
    const store = storeWithTabs();

    store.set(requestCloseFilesAtom, [clean]);

    expect(openKeys(store)).toEqual([dirty]);
    expect(store.get(pendingCloseKeysAtom)).toBeNull();
  });

  it('keeps an unsaved tab and its edits open while it asks', () => {
    const store = storeWithTabs();

    store.set(requestCloseFilesAtom, [dirty]);

    expect(openKeys(store)).toEqual([clean, dirty]);
    expect(store.get(openFilesAtom)[1]?.content).toBe('edited');
    expect(store.get(pendingCloseKeysAtom)).toEqual([dirty]);
  });

  it('ignores another close while it is asking', () => {
    const store = storeWithTabs();
    store.set(requestCloseFilesAtom, [dirty]);

    store.set(requestCloseFilesAtom, [clean]);

    expect(openKeys(store)).toEqual([clean, dirty]);
    expect(store.get(pendingCloseKeysAtom)).toEqual([dirty]);
  });
});

describe('requestCloseAllFilesAtom', () => {
  it('closes saved tabs, then opens the editor to ask about the unsaved ones', () => {
    const store = storeWithTabs();
    store.set(codeEditorOpenAtom, false);

    store.set(requestCloseAllFilesAtom);

    expect(openKeys(store)).toEqual([dirty]);
    expect(store.get(pendingCloseKeysAtom)).toEqual([dirty]);
    expect(store.get(codeEditorOpenAtom)).toBe(true);
  });
});

describe('closePaneTabsAtom', () => {
  it("keeps an unsaved tab from the closed pane, as another project's tab", () => {
    const store = storeWithTabs();

    store.set(closePaneTabsAtom, { closedPaneIndex: 1, remainingProjectPaths: ['/other'] });

    const files = store.get(openFilesAtom);
    expect(openKeys(store)).toEqual([dirty]);
    expect(files[0]).toMatchObject({ content: 'edited', isOtherProject: true });
    expect(files[0]?.sourcePaneIndex).toBeUndefined();
  });

  it("moves the next pane's tabs down a pane even when the closed pane had none", () => {
    const store = storeWithTabs();

    store.set(closePaneTabsAtom, { closedPaneIndex: 0, remainingProjectPaths: ['/repo'] });

    expect(store.get(openFilesAtom).map((f) => f.sourcePaneIndex)).toEqual([0, 0]);
  });
});
