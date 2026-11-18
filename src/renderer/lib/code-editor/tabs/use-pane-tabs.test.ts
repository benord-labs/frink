// @vitest-environment happy-dom
import { act, renderHook } from '@testing-library/react';
import { createStore, Provider } from 'jotai';
import { createElement, type ReactNode } from 'react';
import { describe, expect, it } from 'vitest';
import {
  activeFilePathAtom,
  editorActivePaneIndexAtom,
  editorIsSplitActiveAtom,
  fileKey,
  filterTabsToActivePaneAtom,
  type OpenFile,
  openFileAtom,
  openFilesAtom,
} from '@/lib/code-editor/state';
import { usePaneTabs } from './use-pane-tabs';

const keyOf = (file: OpenFile) => fileKey(file.path, file.projectPath);
/** Pane 1's tabs: its own app.ts, then ros-service's settings.ts opened from its chat */
const own: OpenFile = {
  path: 'src/app.ts',
  name: 'app.ts',
  projectPath: '/qa',
  sourcePaneIndex: 0,
};
const browsed: OpenFile = {
  path: 'src/settings.ts',
  name: 'settings.ts',
  projectPath: '/ros-service',
  sourcePaneIndex: 0,
  isOtherProject: true,
};
const paneTwo: OpenFile = { path: 'b.ts', name: 'b.ts', projectPath: '/qa', sourcePaneIndex: 1 };

/** Split view on pane 1 (index 0), with `active` open in the editor */
function renderPaneTabs(files: OpenFile[], active: OpenFile, isFiltered = true) {
  const store = createStore();
  store.set(openFilesAtom, files);
  store.set(editorIsSplitActiveAtom, true);
  store.set(editorActivePaneIndexAtom, 0);
  store.set(filterTabsToActivePaneAtom, isFiltered);
  store.set(activeFilePathAtom, keyOf(active));
  const wrapper = ({ children }: { children: ReactNode }) =>
    createElement(Provider, { store }, children);
  const view = renderHook(() => usePaneTabs(), { wrapper });
  const focusPane = (index: number) => act(() => store.set(editorActivePaneIndexAtom, index));
  return { store, view, focusPane, active: () => store.get(activeFilePathAtom) };
}

describe('usePaneTabs with "Show active pane tabs only" on', () => {
  it("shows only the active pane's tabs", () => {
    const { view, focusPane } = renderPaneTabs([own, paneTwo, browsed], own);
    expect(view.result.current).toEqual([own, browsed]);

    focusPane(1);

    expect(view.result.current).toEqual([paneTwo]);
  });

  it("shows no tab for a pane with none, and the other project's tab the pane was on once it is back", () => {
    const { focusPane, active } = renderPaneTabs([own, browsed], browsed);

    focusPane(1);
    expect(active()).toBeNull();

    focusPane(0);
    expect(active()).toBe(keyOf(browsed));
  });

  it("goes back to each pane's own last tab", () => {
    const { focusPane, active } = renderPaneTabs([own, browsed, paneTwo], browsed);

    focusPane(1);
    expect(active()).toBe(keyOf(paneTwo));

    focusPane(0);
    expect(active()).toBe(keyOf(browsed));
  });

  it('shows a file opened from no pane in the active pane with no tabs', () => {
    const { store, focusPane, active } = renderPaneTabs([own], own);
    focusPane(1);

    act(() => store.set(openFileAtom, { path: '/home/me/.frink/mcp.json', name: 'mcp.json' }));

    expect(active()).toBe('/home/me/.frink/mcp.json');
  });
});

describe('usePaneTabs with every tab shown', () => {
  it('keeps the tab in the editor on a switch to a pane with no tabs', () => {
    const { view, focusPane, active } = renderPaneTabs([own, browsed], browsed, false);

    focusPane(1);

    expect(view.result.current).toEqual([own, browsed]);
    expect(active()).toBe(keyOf(browsed));
  });
});
