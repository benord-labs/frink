// @vitest-environment happy-dom
import { act, renderHook } from '@testing-library/react';
import { createStore, Provider } from 'jotai';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  lastSelectedWorkModeAtom,
  newChatPaneWorkModeMapAtom,
  splitViewAtom,
  swapAllPaneStateAtom,
} from '../atoms';
import { useEffectiveWorkModeForPane } from './use-effective-work-mode-for-pane';

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
  // Default splitViewAtom has chatIds: [] — no split active
  return createStore();
}

function storeWrapper(store: ReturnType<typeof createStore>) {
  return function Wrapper({ children }: { children: React.ReactNode }) {
    return <Provider store={store}>{children}</Provider>;
  };
}

// ---------------------------------------------------------------------------
// useEffectiveWorkModeForPane
// ---------------------------------------------------------------------------

describe('useEffectiveWorkModeForPane — split view isolation', () => {
  beforeEach(() => localStorage.clear());
  afterEach(() => localStorage.clear());

  it('pane A toggle does not affect pane B — core isolation bug fix', () => {
    const store = makeSplitStore();

    const { result: pane0 } = renderHook(() => useEffectiveWorkModeForPane(0), {
      wrapper: storeWrapper(store),
    });

    // Both panes start on the global default ('local')
    expect(pane0.current.workMode).toBe('local');

    // Pane 0 explicitly switches to 'worktree'
    act(() => {
      pane0.current.setWorkMode('worktree');
    });

    // Pane 0 now shows 'worktree'
    expect(pane0.current.workMode).toBe('worktree');

    // Pane 1 has NO explicit per-pane entry — must not have been written
    const map = store.get(newChatPaneWorkModeMapAtom);
    expect(1 in map).toBe(false);

    // Global preference is unchanged — pane 1 still inherits 'local'
    expect(store.get(lastSelectedWorkModeAtom)).toBe('local');
  });

  it('falls back to global work mode when no per-pane entry exists', () => {
    const store = makeSplitStore();
    store.set(lastSelectedWorkModeAtom, 'local');

    const { result } = renderHook(() => useEffectiveWorkModeForPane(0), {
      wrapper: storeWrapper(store),
    });

    // Per-pane map is empty — should read global 'local'
    expect(result.current.workMode).toBe('local');
  });

  it('explicit per-pane entry overrides global work mode', () => {
    const store = makeSplitStore();
    store.set(lastSelectedWorkModeAtom, 'worktree');
    store.set(newChatPaneWorkModeMapAtom, { 0: 'local' });

    const { result } = renderHook(() => useEffectiveWorkModeForPane(0), {
      wrapper: storeWrapper(store),
    });

    expect(result.current.workMode).toBe('local');
  });

  it('write in split view goes to per-pane map, NOT to global atom', () => {
    const store = makeSplitStore();
    store.set(lastSelectedWorkModeAtom, 'worktree');

    const { result } = renderHook(() => useEffectiveWorkModeForPane(0), {
      wrapper: storeWrapper(store),
    });

    act(() => {
      result.current.setWorkMode('local');
    });

    expect(store.get(newChatPaneWorkModeMapAtom)[0]).toBe('local');
    expect(store.get(lastSelectedWorkModeAtom)).toBe('worktree'); // unchanged
  });

  it('two panes can independently hold different work modes', () => {
    const store = makeSplitStore();

    const { result: pane0 } = renderHook(() => useEffectiveWorkModeForPane(0), {
      wrapper: storeWrapper(store),
    });
    const { result: pane1 } = renderHook(() => useEffectiveWorkModeForPane(1), {
      wrapper: storeWrapper(store),
    });

    act(() => {
      pane0.current.setWorkMode('local');
      pane1.current.setWorkMode('worktree');
    });

    expect(pane0.current.workMode).toBe('local');
    expect(pane1.current.workMode).toBe('worktree');
  });
});

describe('useEffectiveWorkModeForPane — single-pane mode', () => {
  beforeEach(() => localStorage.clear());
  afterEach(() => localStorage.clear());

  it('reads from global atom when splitPaneIndex is undefined', () => {
    const store = makeSingleStore();
    store.set(lastSelectedWorkModeAtom, 'local');

    const { result } = renderHook(() => useEffectiveWorkModeForPane(undefined), {
      wrapper: storeWrapper(store),
    });

    expect(result.current.workMode).toBe('local');
  });

  it('write updates global atom, not per-pane map', () => {
    const store = makeSingleStore();

    const { result } = renderHook(() => useEffectiveWorkModeForPane(undefined), {
      wrapper: storeWrapper(store),
    });

    act(() => {
      result.current.setWorkMode('local');
    });

    expect(store.get(lastSelectedWorkModeAtom)).toBe('local');
    expect(store.get(newChatPaneWorkModeMapAtom)).toEqual({});
  });

  it('reads from global even when splitPaneIndex is 0 but chatIds < 2', () => {
    // Single new-chat pane in non-split layout (chatIds: [sentinel])
    const store = createStore();
    store.set(splitViewAtom, {
      chatIds: ['NEW_CHAT_PANE'],
      ratios: [1],
      activePaneIndex: 0,
      layout: 'horizontal' as const,
    });
    store.set(lastSelectedWorkModeAtom, 'local');
    store.set(newChatPaneWorkModeMapAtom, { 0: 'worktree' }); // stale entry should be ignored

    const { result } = renderHook(() => useEffectiveWorkModeForPane(0), {
      wrapper: storeWrapper(store),
    });

    // isSplitActive = false (chatIds.length < 2) → falls back to global
    expect(result.current.workMode).toBe('local');
  });
});

describe('useEffectiveWorkModeForPane — split collapse', () => {
  beforeEach(() => localStorage.clear());
  afterEach(() => localStorage.clear());

  it('reverts to global reads when split collapses from 2 panes to none', () => {
    const store = makeSplitStore();
    // Pane 0 had explicit 'local', global is 'worktree'
    store.set(newChatPaneWorkModeMapAtom, { 0: 'local' });
    store.set(lastSelectedWorkModeAtom, 'worktree');

    const { result } = renderHook(() => useEffectiveWorkModeForPane(0), {
      wrapper: storeWrapper(store),
    });

    expect(result.current.workMode).toBe('local'); // per-pane entry active

    // Collapse split view
    act(() => {
      store.set(splitViewAtom, {
        chatIds: [],
        ratios: [],
        activePaneIndex: 0,
        layout: 'horizontal' as const,
      });
    });

    // isSplitActive = false now → reads global 'worktree'
    expect(result.current.workMode).toBe('worktree');
  });
});

// ---------------------------------------------------------------------------
// swapAllPaneStateAtom — work mode entries
// ---------------------------------------------------------------------------

describe('swapAllPaneStateAtom — work mode swap', () => {
  beforeEach(() => localStorage.clear());
  afterEach(() => localStorage.clear());

  it('transposes work mode entries between panes 0 and 1', () => {
    const store = createStore();
    store.set(splitViewAtom, {
      chatIds: ['chat-a', 'chat-b'],
      ratios: [0.5, 0.5],
      activePaneIndex: 0,
      layout: 'horizontal' as const,
    });
    store.set(newChatPaneWorkModeMapAtom, { 0: 'local', 1: 'worktree' });

    store.set(swapAllPaneStateAtom, { from: 0, to: 1 });

    const map = store.get(newChatPaneWorkModeMapAtom);
    expect(map[0]).toBe('worktree');
    expect(map[1]).toBe('local');
  });

  it('moves the only explicit entry to the target pane and clears the source', () => {
    const store = createStore();
    store.set(splitViewAtom, {
      chatIds: ['chat-a', 'chat-b'],
      ratios: [0.5, 0.5],
      activePaneIndex: 0,
      layout: 'horizontal' as const,
    });
    // Only pane 0 has an explicit entry; pane 1 is on global fallback
    store.set(newChatPaneWorkModeMapAtom, { 0: 'local' });

    store.set(swapAllPaneStateAtom, { from: 0, to: 1 });

    const map = store.get(newChatPaneWorkModeMapAtom);
    // Pane 0 entry removed (it moved to pane 1)
    expect(0 in map).toBe(false);
    // Pane 1 now holds the explicit 'local' entry
    expect(map[1]).toBe('local');
  });
});
