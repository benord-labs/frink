// @vitest-environment happy-dom
import { act, renderHook } from '@testing-library/react';
import { createStore, Provider } from 'jotai';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  lastSelectedModelIdAtom,
  NEW_CHAT_PANE,
  newChatPaneModelMapAtom,
  splitViewAtom,
  swapAllPaneStateAtom,
} from '../atoms';
import {
  getEffectiveModelIdForPane,
  useEffectiveModelForPane,
} from './use-effective-model-for-pane';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeSplitStore(chatIds: (string | null)[] = ['chat-a', 'chat-b']) {
  const store = createStore();
  store.set(splitViewAtom, {
    chatIds,
    ratios: Array(chatIds.length).fill(1 / chatIds.length),
    activePaneIndex: 0,
    layout: 'horizontal' as const,
  });
  return store;
}

function makeSingleStore() {
  return createStore();
}

function storeWrapper(store: ReturnType<typeof createStore>) {
  return function Wrapper({ children }: { children: React.ReactNode }) {
    return <Provider store={store}>{children}</Provider>;
  };
}

// ---------------------------------------------------------------------------
// getEffectiveModelIdForPane (imperative — must match createChatMutation seeding)
// ---------------------------------------------------------------------------

describe('getEffectiveModelIdForPane', () => {
  beforeEach(() => localStorage.clear());
  afterEach(() => localStorage.clear());

  it('returns global when paneIndex is null (single-pane / non-split fill)', () => {
    const store = makeSplitStore();
    store.set(lastSelectedModelIdAtom, 'opus');
    store.set(newChatPaneModelMapAtom, { 0: 'sonnet' });
    const g = store.get.bind(store);
    expect(getEffectiveModelIdForPane(g, null)).toBe('opus');
  });

  it('reads per-pane map when split active', () => {
    const store = makeSplitStore();
    store.set(lastSelectedModelIdAtom, 'sonnet');
    store.set(newChatPaneModelMapAtom, { 0: 'opus', 1: 'haiku' });
    const g = store.get.bind(store);
    expect(getEffectiveModelIdForPane(g, 0)).toBe('opus');
    expect(getEffectiveModelIdForPane(g, 1)).toBe('haiku');
  });

  it('ignores stale per-pane map when split is not active (chatIds length < 2)', () => {
    const store = createStore();
    store.set(splitViewAtom, {
      chatIds: [NEW_CHAT_PANE],
      ratios: [1],
      activePaneIndex: 0,
      layout: 'horizontal' as const,
    });
    store.set(lastSelectedModelIdAtom, 'opus');
    store.set(newChatPaneModelMapAtom, { 0: 'sonnet' });
    const g = store.get.bind(store);
    expect(getEffectiveModelIdForPane(g, 0)).toBe('opus');
  });

  it('uses map entry for high pane index in three-pane split', () => {
    const store = createStore();
    store.set(splitViewAtom, {
      chatIds: ['a', 'b', 'c'],
      ratios: [1 / 3, 1 / 3, 1 / 3],
      activePaneIndex: 0,
      layout: 'horizontal' as const,
    });
    store.set(lastSelectedModelIdAtom, 'sonnet');
    store.set(newChatPaneModelMapAtom, { 2: 'opus' });
    const g = store.get.bind(store);
    expect(getEffectiveModelIdForPane(g, 0)).toBe('sonnet');
    expect(getEffectiveModelIdForPane(g, 2)).toBe('opus');
  });
});

// ---------------------------------------------------------------------------
// useEffectiveModelForPane
// ---------------------------------------------------------------------------

describe('useEffectiveModelForPane — split isolation (regression: shared global atom)', () => {
  beforeEach(() => localStorage.clear());
  afterEach(() => localStorage.clear());

  it('changing model in pane 0 does not write pane 1 — pane 1 still uses global', () => {
    const store = makeSplitStore();
    store.set(lastSelectedModelIdAtom, 'sonnet');

    const { result: pane0 } = renderHook(() => useEffectiveModelForPane(0), {
      wrapper: storeWrapper(store),
    });
    const { result: pane1 } = renderHook(() => useEffectiveModelForPane(1), {
      wrapper: storeWrapper(store),
    });

    expect(pane0.current.lastSelectedModelId).toBe('sonnet');
    expect(pane1.current.lastSelectedModelId).toBe('sonnet');

    act(() => {
      pane0.current.setLastSelectedModelId('opus');
    });

    expect(pane0.current.lastSelectedModelId).toBe('opus');
    expect(pane1.current.lastSelectedModelId).toBe('sonnet');

    const map = store.get(newChatPaneModelMapAtom);
    expect(map[0]).toBe('opus');
    expect(1 in map).toBe(false);
    expect(store.get(lastSelectedModelIdAtom)).toBe('sonnet');
  });
});

describe('useEffectiveModelForPane — single-pane / inactive split', () => {
  beforeEach(() => localStorage.clear());
  afterEach(() => localStorage.clear());

  it('splitPaneIndex undefined reads and writes global atom only', () => {
    const store = makeSingleStore();
    store.set(lastSelectedModelIdAtom, 'sonnet');

    const { result } = renderHook(() => useEffectiveModelForPane(undefined), {
      wrapper: storeWrapper(store),
    });

    act(() => {
      result.current.setLastSelectedModelId('opus');
    });

    expect(store.get(lastSelectedModelIdAtom)).toBe('opus');
    expect(store.get(newChatPaneModelMapAtom)).toEqual({});
  });

  it('setLastSelectedModelId compares against latest global after external atom update (stable callback + refs)', () => {
    const store = makeSingleStore();
    store.set(lastSelectedModelIdAtom, 'sonnet');

    const { result } = renderHook(() => useEffectiveModelForPane(undefined), {
      wrapper: storeWrapper(store),
    });

    act(() => {
      store.set(lastSelectedModelIdAtom, 'opus');
    });

    act(() => {
      result.current.setLastSelectedModelId('sonnet');
    });

    expect(store.get(lastSelectedModelIdAtom)).toBe('sonnet');
  });

  it('ignores stale map when splitPaneIndex is 0 but only one chat column (not split)', () => {
    const store = createStore();
    store.set(splitViewAtom, {
      chatIds: [NEW_CHAT_PANE],
      ratios: [1],
      activePaneIndex: 0,
      layout: 'horizontal' as const,
    });
    store.set(lastSelectedModelIdAtom, 'opus');
    store.set(newChatPaneModelMapAtom, { 0: 'sonnet' });

    const { result } = renderHook(() => useEffectiveModelForPane(0), {
      wrapper: storeWrapper(store),
    });

    expect(result.current.lastSelectedModelId).toBe('opus');
  });

  it('reverts to global when split collapses to zero panes', () => {
    const store = makeSplitStore();
    store.set(lastSelectedModelIdAtom, 'sonnet');
    store.set(newChatPaneModelMapAtom, { 0: 'opus' });

    const { result } = renderHook(() => useEffectiveModelForPane(0), {
      wrapper: storeWrapper(store),
    });

    expect(result.current.lastSelectedModelId).toBe('opus');

    act(() => {
      store.set(splitViewAtom, {
        chatIds: [],
        ratios: [],
        activePaneIndex: 0,
        layout: 'horizontal' as const,
      });
    });

    expect(result.current.lastSelectedModelId).toBe('sonnet');
  });
});

// ---------------------------------------------------------------------------
// swapAllPaneStateAtom — model map
// ---------------------------------------------------------------------------

describe('swapAllPaneStateAtom — model map', () => {
  beforeEach(() => localStorage.clear());
  afterEach(() => localStorage.clear());

  it('transposes model entries between panes 0 and 1', () => {
    const store = createStore();
    store.set(splitViewAtom, {
      chatIds: ['chat-a', 'chat-b'],
      ratios: [0.5, 0.5],
      activePaneIndex: 0,
      layout: 'horizontal' as const,
    });
    store.set(newChatPaneModelMapAtom, { 0: 'opus', 1: 'sonnet' });

    store.set(swapAllPaneStateAtom, { from: 0, to: 1 });

    const map = store.get(newChatPaneModelMapAtom);
    expect(map[0]).toBe('sonnet');
    expect(map[1]).toBe('opus');
  });

  it('moves the only explicit entry to the target pane and clears the source', () => {
    const store = createStore();
    store.set(splitViewAtom, {
      chatIds: ['chat-a', 'chat-b'],
      ratios: [0.5, 0.5],
      activePaneIndex: 0,
      layout: 'horizontal' as const,
    });
    store.set(newChatPaneModelMapAtom, { 0: 'opus' });

    store.set(swapAllPaneStateAtom, { from: 0, to: 1 });

    const map = store.get(newChatPaneModelMapAtom);
    expect(0 in map).toBe(false);
    expect(map[1]).toBe('opus');
  });
});
