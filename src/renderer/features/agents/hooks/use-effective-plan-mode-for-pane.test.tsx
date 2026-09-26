// @vitest-environment happy-dom
import { act, renderHook } from '@testing-library/react';
import { createStore, Provider } from 'jotai';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  chatModeAtom,
  NEW_CHAT_PANE,
  newChatPaneChatModeMapAtom,
  splitViewAtom,
  swapAllPaneStateAtom,
} from '../atoms';
import {
  getEffectiveChatModeForPane,
  resolveEffectiveChatMode,
  useEffectiveChatModeForPane,
} from './use-effective-plan-mode-for-pane';

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
// useEffectiveChatModeForPane
// ---------------------------------------------------------------------------

describe('useEffectiveChatModeForPane — split view isolation', () => {
  beforeEach(() => localStorage.clear());
  afterEach(() => localStorage.clear());

  it('pane A toggle does not affect pane B — core isolation bug fix', () => {
    const store = makeSplitStore();

    const { result: pane0 } = renderHook(
      () => useEffectiveChatModeForPane(0, { hasProject: true }),
      {
        wrapper: storeWrapper(store),
      },
    );

    expect(pane0.current.chatMode).toBe('agent');

    act(() => {
      pane0.current.setChatMode('plan');
    });

    expect(pane0.current.chatMode).toBe('plan');

    const map = store.get(newChatPaneChatModeMapAtom);
    expect(1 in map).toBe(false);

    expect(store.get(chatModeAtom)).toBe('agent');
  });

  it('falls back to global chat mode when no per-pane entry exists', () => {
    const store = makeSplitStore();
    store.set(chatModeAtom, 'plan');

    const { result } = renderHook(() => useEffectiveChatModeForPane(0, { hasProject: true }), {
      wrapper: storeWrapper(store),
    });

    expect(result.current.chatMode).toBe('plan');
  });

  it('explicit per-pane entry overrides global chat mode', () => {
    const store = makeSplitStore();
    store.set(chatModeAtom, 'agent');
    store.set(newChatPaneChatModeMapAtom, { 0: 'plan' });

    const { result } = renderHook(() => useEffectiveChatModeForPane(0, { hasProject: true }), {
      wrapper: storeWrapper(store),
    });

    expect(result.current.chatMode).toBe('plan');
  });

  it('write in split view goes to per-pane map, NOT to global atom', () => {
    const store = makeSplitStore();
    store.set(chatModeAtom, 'agent');

    const { result } = renderHook(() => useEffectiveChatModeForPane(0, { hasProject: true }), {
      wrapper: storeWrapper(store),
    });

    act(() => {
      result.current.setChatMode('plan');
    });

    expect(store.get(newChatPaneChatModeMapAtom)[0]).toBe('plan');
    expect(store.get(chatModeAtom)).toBe('agent');
  });

  it('two panes can independently hold different chat modes', () => {
    const store = makeSplitStore();

    const { result: pane0 } = renderHook(
      () => useEffectiveChatModeForPane(0, { hasProject: true }),
      {
        wrapper: storeWrapper(store),
      },
    );
    const { result: pane1 } = renderHook(
      () => useEffectiveChatModeForPane(1, { hasProject: true }),
      {
        wrapper: storeWrapper(store),
      },
    );

    act(() => {
      pane0.current.setChatMode('plan');
      pane1.current.setChatMode('debug');
    });

    expect(pane0.current.chatMode).toBe('plan');
    expect(pane1.current.chatMode).toBe('debug');
  });

  it('three-pane split: each index can hold a distinct chat mode', () => {
    const store = createStore();
    store.set(splitViewAtom, {
      chatIds: ['chat-a', 'chat-b', 'chat-c'],
      ratios: [1 / 3, 1 / 3, 1 / 3],
      activePaneIndex: 0,
      layout: 'horizontal' as const,
    });
    store.set(chatModeAtom, 'agent');

    const { result: p0 } = renderHook(() => useEffectiveChatModeForPane(0, { hasProject: true }), {
      wrapper: storeWrapper(store),
    });
    const { result: p1 } = renderHook(() => useEffectiveChatModeForPane(1, { hasProject: true }), {
      wrapper: storeWrapper(store),
    });
    const { result: p2 } = renderHook(() => useEffectiveChatModeForPane(2, { hasProject: true }), {
      wrapper: storeWrapper(store),
    });

    act(() => {
      p0.current.setChatMode('plan');
      p1.current.setChatMode('agent');
      p2.current.setChatMode('debug');
    });

    expect(p0.current.chatMode).toBe('plan');
    expect(p1.current.chatMode).toBe('agent');
    expect(p2.current.chatMode).toBe('debug');
    expect(store.get(newChatPaneChatModeMapAtom)).toEqual({ 0: 'plan', 1: 'agent', 2: 'debug' });
    expect(store.get(chatModeAtom)).toBe('agent');
  });

  it('recomputes when per-pane map is updated externally after mount (subscription + useMemo)', () => {
    const store = makeSplitStore();
    store.set(chatModeAtom, 'agent');

    const { result } = renderHook(() => useEffectiveChatModeForPane(0, { hasProject: true }), {
      wrapper: storeWrapper(store),
    });

    expect(result.current.chatMode).toBe('agent');
    const g = store.get.bind(store);
    expect(getEffectiveChatModeForPane(g, 0)).toBe('agent');

    act(() => {
      store.set(newChatPaneChatModeMapAtom, { 0: 'plan' });
    });

    expect(result.current.chatMode).toBe('plan');
    expect(getEffectiveChatModeForPane(g, 0)).toBe('plan');
  });

  it('recomputes when global chat mode is updated externally in split with no map entry', () => {
    const store = makeSplitStore();
    store.set(chatModeAtom, 'agent');

    const { result } = renderHook(() => useEffectiveChatModeForPane(0, { hasProject: true }), {
      wrapper: storeWrapper(store),
    });

    expect(result.current.chatMode).toBe('agent');

    act(() => {
      store.set(chatModeAtom, 'plan');
    });

    expect(result.current.chatMode).toBe('plan');
    expect(getEffectiveChatModeForPane(store.get.bind(store), 0)).toBe('plan');
  });
});

describe('useEffectiveChatModeForPane — single-pane mode', () => {
  beforeEach(() => localStorage.clear());
  afterEach(() => localStorage.clear());

  it('reads from global atom when splitPaneIndex is undefined', () => {
    const store = makeSingleStore();
    store.set(chatModeAtom, 'plan');

    const { result } = renderHook(
      () => useEffectiveChatModeForPane(undefined, { hasProject: true }),
      {
        wrapper: storeWrapper(store),
      },
    );

    expect(result.current.chatMode).toBe('plan');
  });

  it('write updates global atom, not per-pane map', () => {
    const store = makeSingleStore();

    const { result } = renderHook(
      () => useEffectiveChatModeForPane(undefined, { hasProject: true }),
      {
        wrapper: storeWrapper(store),
      },
    );

    act(() => {
      result.current.setChatMode('plan');
    });

    expect(store.get(chatModeAtom)).toBe('plan');
    expect(store.get(newChatPaneChatModeMapAtom)).toEqual({});
  });

  it('reads from global even when splitPaneIndex is 0 but chatIds < 2', () => {
    const store = createStore();
    store.set(splitViewAtom, {
      chatIds: [NEW_CHAT_PANE],
      ratios: [1],
      activePaneIndex: 0,
      layout: 'horizontal' as const,
    });
    store.set(chatModeAtom, 'plan');
    store.set(newChatPaneChatModeMapAtom, { 0: 'agent' });

    const { result } = renderHook(() => useEffectiveChatModeForPane(0, { hasProject: true }), {
      wrapper: storeWrapper(store),
    });

    expect(result.current.chatMode).toBe('plan');
  });
});

describe('useEffectiveChatModeForPane — split collapse', () => {
  beforeEach(() => localStorage.clear());
  afterEach(() => localStorage.clear());

  it('reverts to global reads when split collapses from 2 panes to none', () => {
    const store = makeSplitStore();
    store.set(newChatPaneChatModeMapAtom, { 0: 'plan' });
    store.set(chatModeAtom, 'agent');

    const { result } = renderHook(() => useEffectiveChatModeForPane(0, { hasProject: true }), {
      wrapper: storeWrapper(store),
    });

    expect(result.current.chatMode).toBe('plan');

    act(() => {
      store.set(splitViewAtom, {
        chatIds: [],
        ratios: [],
        activePaneIndex: 0,
        layout: 'horizontal' as const,
      });
    });

    expect(result.current.chatMode).toBe('agent');
  });
});

// ---------------------------------------------------------------------------
// resolveEffectiveChatMode
// ---------------------------------------------------------------------------

describe('resolveEffectiveChatMode', () => {
  it('matches getEffectiveChatModeForPane split/single rules (shared read path)', () => {
    expect(resolveEffectiveChatMode(null, true, 'plan', {})).toBe('plan');
    expect(resolveEffectiveChatMode(0, false, 'plan', { 0: 'agent' })).toBe('plan');
    expect(resolveEffectiveChatMode(0, true, 'agent', { 0: 'plan' })).toBe('plan');
    expect(resolveEffectiveChatMode(1, true, 'plan', { 0: 'agent' })).toBe('plan');
  });
});

// ---------------------------------------------------------------------------
// getEffectiveChatModeForPane
// ---------------------------------------------------------------------------

describe('getEffectiveChatModeForPane', () => {
  beforeEach(() => localStorage.clear());
  afterEach(() => localStorage.clear());

  it('matches hook read path for filled pane index', () => {
    const store = makeSplitStore();
    store.set(chatModeAtom, 'agent');
    store.set(newChatPaneChatModeMapAtom, { 0: 'plan' });

    const g = store.get.bind(store);
    expect(getEffectiveChatModeForPane(g, 0)).toBe('plan');
    expect(getEffectiveChatModeForPane(g, 1)).toBe('agent');
  });

  it('returns global when paneIndex is null', () => {
    const store = makeSplitStore();
    store.set(chatModeAtom, 'plan');
    const g = store.get.bind(store);
    expect(getEffectiveChatModeForPane(g, null)).toBe('plan');
  });

  it('ignores stale per-pane map when split is not active (imperative get contract)', () => {
    const store = createStore();
    store.set(splitViewAtom, {
      chatIds: [NEW_CHAT_PANE],
      ratios: [1],
      activePaneIndex: 0,
      layout: 'horizontal' as const,
    });
    store.set(chatModeAtom, 'plan');
    store.set(newChatPaneChatModeMapAtom, { 0: 'agent' });

    const g = store.get.bind(store);
    expect(getEffectiveChatModeForPane(g, 0)).toBe('plan');
  });

  it('getEffectiveChatModeForPane uses map entry for pane index 2 in three-pane split', () => {
    const store = createStore();
    store.set(splitViewAtom, {
      chatIds: ['a', 'b', 'c'],
      ratios: [1 / 3, 1 / 3, 1 / 3],
      activePaneIndex: 0,
      layout: 'horizontal' as const,
    });
    store.set(chatModeAtom, 'agent');
    store.set(newChatPaneChatModeMapAtom, { 2: 'debug' });

    const g = store.get.bind(store);
    expect(getEffectiveChatModeForPane(g, 0)).toBe('agent');
    expect(getEffectiveChatModeForPane(g, 1)).toBe('agent');
    expect(getEffectiveChatModeForPane(g, 2)).toBe('debug');
  });
});

// ---------------------------------------------------------------------------
// swapAllPaneStateAtom — chat mode entries
// ---------------------------------------------------------------------------

describe('swapAllPaneStateAtom — chat mode swap', () => {
  beforeEach(() => localStorage.clear());
  afterEach(() => localStorage.clear());

  it('transposes chat mode entries between panes 0 and 1', () => {
    const store = createStore();
    store.set(splitViewAtom, {
      chatIds: ['chat-a', 'chat-b'],
      ratios: [0.5, 0.5],
      activePaneIndex: 0,
      layout: 'horizontal' as const,
    });
    store.set(newChatPaneChatModeMapAtom, { 0: 'plan', 1: 'agent' });

    store.set(swapAllPaneStateAtom, { from: 0, to: 1 });

    const map = store.get(newChatPaneChatModeMapAtom);
    expect(map[0]).toBe('agent');
    expect(map[1]).toBe('plan');
  });

  it('moves the only explicit entry to the target pane and clears the source', () => {
    const store = createStore();
    store.set(splitViewAtom, {
      chatIds: ['chat-a', 'chat-b'],
      ratios: [0.5, 0.5],
      activePaneIndex: 0,
      layout: 'horizontal' as const,
    });
    store.set(newChatPaneChatModeMapAtom, { 0: 'debug' });

    store.set(swapAllPaneStateAtom, { from: 0, to: 1 });

    const map = store.get(newChatPaneChatModeMapAtom);
    expect(0 in map).toBe(false);
    expect(map[1]).toBe('debug');
  });
});

// ---------------------------------------------------------------------------
// cycleChatMode — debug in cycle only when hasProject (new-chat passes selectedProject)
// ---------------------------------------------------------------------------

describe('cycleChatMode — debug mode in cycle', () => {
  beforeEach(() => localStorage.clear());
  afterEach(() => localStorage.clear());

  it('cycles agent → plan → debug → agent in single-pane mode', () => {
    const store = makeSingleStore();

    const { result } = renderHook(
      () => useEffectiveChatModeForPane(undefined, { hasProject: true }),
      {
        wrapper: storeWrapper(store),
      },
    );

    expect(result.current.chatMode).toBe('agent');

    act(() => result.current.cycleChatMode());
    expect(result.current.chatMode).toBe('plan');

    act(() => result.current.cycleChatMode());
    expect(result.current.chatMode).toBe('debug');

    act(() => result.current.cycleChatMode());
    expect(result.current.chatMode).toBe('agent');
  });

  it('cycles agent → plan → debug → agent in split view per-pane', () => {
    const store = makeSplitStore();

    const { result } = renderHook(() => useEffectiveChatModeForPane(0, { hasProject: true }), {
      wrapper: storeWrapper(store),
    });

    expect(result.current.chatMode).toBe('agent');

    act(() => result.current.cycleChatMode());
    expect(result.current.chatMode).toBe('plan');

    act(() => result.current.cycleChatMode());
    expect(result.current.chatMode).toBe('debug');

    act(() => result.current.cycleChatMode());
    expect(result.current.chatMode).toBe('agent');

    // Verify cycle wrote to per-pane map, not global
    expect(store.get(chatModeAtom)).toBe('agent');
  });

  it('skips debug in cycle when hasProject is false (general / new-chat without project)', () => {
    const store = makeSingleStore();
    store.set(chatModeAtom, 'plan');

    const { result } = renderHook(
      () => useEffectiveChatModeForPane(undefined, { hasProject: false }),
      {
        wrapper: storeWrapper(store),
      },
    );

    act(() => result.current.cycleChatMode());
    expect(result.current.chatMode).toBe('agent');
  });
});
