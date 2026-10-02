// @vitest-environment happy-dom
import '@testing-library/jest-dom/vitest';
import { act, render, renderHook, waitFor } from '@testing-library/react';
import { createStore, Provider, useAtomValue, useSetAtom } from 'jotai';
import { useEffect, useRef } from 'react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

beforeEach(() => {
  window.localStorage.clear();
});

import {
  getDefaultLayout,
  getDefaultRatios,
  NEW_CHAT_PANE,
  type SplitLayout,
  type SplitViewState,
  selectedAgentChatIdAtom,
  splitViewAtom,
} from '../atoms';
import { canOpenChatInNewPane, useSplitViewActions } from './use-split-view-actions';

// ---------------------------------------------------------------------------
// Harnesses
// ---------------------------------------------------------------------------

/** Calls addEmptyPane once the selected chat is set, reports resulting chatIds. */
function AddEmptyPaneHarness({
  initialChatId,
  onDone,
}: {
  initialChatId: string | null;
  onDone: (chatIds: (string | null)[]) => void;
}) {
  const { addEmptyPane } = useSplitViewActions();
  const split = useAtomValue(splitViewAtom);
  const selectedChatId = useAtomValue(selectedAgentChatIdAtom);
  const setSelectedChatId = useSetAtom(selectedAgentChatIdAtom);
  const called = useRef(false);

  useEffect(() => {
    setSelectedChatId(initialChatId);
  }, [setSelectedChatId, initialChatId]);

  // Wait until the atom has propagated (selectedChatId === initialChatId) so
  // addEmptyPane's closure captures the correct value, not a stale null.
  useEffect(() => {
    if (!called.current && split.chatIds.length === 0 && selectedChatId === initialChatId) {
      called.current = true;
      addEmptyPane();
    }
  }, [split.chatIds.length, addEmptyPane, selectedChatId, initialChatId]);

  useEffect(() => {
    if (split.chatIds.length === 2) {
      onDone(split.chatIds);
    }
  }, [split.chatIds, onDone]);

  return null;
}

/** Calls addNewChatPane once, reports resulting chatIds. */
function AddNewChatPaneHarness({
  initialChatId,
  onDone,
}: {
  initialChatId: string | null;
  onDone: (chatIds: (string | null)[]) => void;
}) {
  const { addNewChatPane } = useSplitViewActions();
  const split = useAtomValue(splitViewAtom);
  const selectedChatId = useAtomValue(selectedAgentChatIdAtom);
  const setSelectedChatId = useSetAtom(selectedAgentChatIdAtom);
  const called = useRef(false);

  useEffect(() => {
    setSelectedChatId(initialChatId);
  }, [setSelectedChatId, initialChatId]);

  useEffect(() => {
    if (!called.current && split.chatIds.length === 0 && selectedChatId === initialChatId) {
      called.current = true;
      addNewChatPane();
    }
  }, [split.chatIds.length, addNewChatPane, selectedChatId, initialChatId]);

  useEffect(() => {
    if (split.chatIds.length === 2) {
      onDone(split.chatIds);
    }
  }, [split.chatIds, onDone]);

  return null;
}

/** Sets an existing split before calling addEmptyPane; reports resulting chatIds. */
function AddPaneToExistingSplitHarness({
  onDone,
}: {
  onDone: (chatIds: (string | null)[]) => void;
}) {
  const { addEmptyPane } = useSplitViewActions();
  const split = useAtomValue(splitViewAtom);
  const setSplit = useSetAtom(splitViewAtom);
  const setSelectedChatId = useSetAtom(selectedAgentChatIdAtom);

  useEffect(() => {
    setSelectedChatId('chat-a');
    setSplit({
      chatIds: ['chat-a', 'chat-b'],
      ratios: getDefaultRatios(2),
      activePaneIndex: 0,
      layout: getDefaultLayout(2),
    });
  }, [setSplit, setSelectedChatId]);

  useEffect(() => {
    if (split.chatIds.length === 2) {
      addEmptyPane();
    }
  }, [split.chatIds.length, addEmptyPane]);

  useEffect(() => {
    if (split.chatIds.length === 3) {
      onDone(split.chatIds);
    }
  }, [split.chatIds, onDone]);

  return null;
}

/** Seeds an arbitrary split state, adds a pane, reports the resulting layout. */
function AddPaneLayoutHarness({
  seed,
  onDone,
}: {
  seed: SplitViewState;
  onDone: (layout: SplitLayout) => void;
}) {
  const { addEmptyPane } = useSplitViewActions();
  const split = useAtomValue(splitViewAtom);
  const setSplit = useSetAtom(splitViewAtom);
  const setSelectedChatId = useSetAtom(selectedAgentChatIdAtom);
  const seeded = useRef(false);
  const targetCount = seed.chatIds.length + 1;

  useEffect(() => {
    setSelectedChatId(seed.chatIds[0]);
    setSplit(seed);
  }, [setSplit, setSelectedChatId, seed]);

  useEffect(() => {
    if (!seeded.current && split.chatIds.length === seed.chatIds.length) {
      seeded.current = true;
      addEmptyPane();
    }
  }, [split.chatIds.length, addEmptyPane, seed.chatIds.length]);

  useEffect(() => {
    if (split.chatIds.length === targetCount) {
      onDone(split.layout);
    }
  }, [split.chatIds.length, split.layout, targetCount, onDone]);

  return null;
}

function seedSplit(chatIds: (string | null)[], layout: SplitLayout): SplitViewState {
  return {
    chatIds,
    ratios: getDefaultRatios(chatIds.length),
    activePaneIndex: 0,
    layout,
  };
}

/** Seeds a split, adds a pane, then removes it — reports the layout after each step.
 *  Guards the add/remove symmetry: a layout preserved on add must survive the inverse remove. */
function AddThenRemoveHarness({
  seed,
  onDone,
}: {
  seed: SplitViewState;
  onDone: (layouts: { afterAdd: SplitLayout; afterRemove: SplitLayout }) => void;
}) {
  const { addEmptyPane, removeFromSplit } = useSplitViewActions();
  const split = useAtomValue(splitViewAtom);
  const setSplit = useSetAtom(splitViewAtom);
  const setSelectedChatId = useSetAtom(selectedAgentChatIdAtom);
  const phase = useRef<'seed' | 'added' | 'removed'>('seed');
  const afterAdd = useRef<SplitLayout | null>(null);
  const baseCount = seed.chatIds.length;

  useEffect(() => {
    setSelectedChatId(seed.chatIds[0]);
    setSplit(seed);
  }, [setSplit, setSelectedChatId, seed]);

  useEffect(() => {
    if (phase.current === 'seed' && split.chatIds.length === baseCount) {
      phase.current = 'added';
      addEmptyPane();
    }
  }, [split.chatIds.length, addEmptyPane, baseCount]);

  useEffect(() => {
    if (phase.current === 'added' && split.chatIds.length === baseCount + 1) {
      afterAdd.current = split.layout;
      phase.current = 'removed';
      removeFromSplit(null, baseCount); // remove the just-added last pane
    }
  }, [split.chatIds.length, split.layout, removeFromSplit, baseCount]);

  useEffect(() => {
    if (phase.current === 'removed' && split.chatIds.length === baseCount && afterAdd.current) {
      onDone({ afterAdd: afterAdd.current, afterRemove: split.layout });
    }
  }, [split.chatIds.length, split.layout, onDone, baseCount]);

  return null;
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('addPane — first split (single-pane → split)', () => {
  it('addEmptyPane with a real selectedChatId puts chat at Pane 0, null at Pane 1', async () => {
    const onDone = vi.fn();
    render(
      <Provider store={createStore()}>
        <AddEmptyPaneHarness initialChatId="chat-a" onDone={onDone} />
      </Provider>,
    );
    await waitFor(() => expect(onDone).toHaveBeenCalled());
    expect(onDone.mock.calls[0][0]).toEqual(['chat-a', null]);
  });

  it('addEmptyPane with null selectedChatId puts null at both panes (chat creation in flight)', async () => {
    const onDone = vi.fn();
    render(
      <Provider store={createStore()}>
        <AddEmptyPaneHarness initialChatId={null} onDone={onDone} />
      </Provider>,
    );
    await waitFor(() => expect(onDone).toHaveBeenCalled());
    // Both panes must be null — Pane 0 shows PendingChatPlaceholder, Pane 1 is the new empty pane.
    // Pane 1 must NOT be NEW_CHAT_PANE, which would cause onSuccess to route the original chat
    // to Pane 1 instead of Pane 0.
    expect(onDone.mock.calls[0][0]).toEqual([null, null]);
  });

  it('addNewChatPane with a real selectedChatId puts chat at Pane 0, NEW_CHAT_PANE at Pane 1', async () => {
    const onDone = vi.fn();
    render(
      <Provider store={createStore()}>
        <AddNewChatPaneHarness initialChatId="chat-a" onDone={onDone} />
      </Provider>,
    );
    await waitFor(() => expect(onDone).toHaveBeenCalled());
    expect(onDone.mock.calls[0][0]).toEqual(['chat-a', NEW_CHAT_PANE]);
  });

  // Regression: addNewChatPane with null selectedChatId (chat creation in flight) previously
  // produced [null, NEW_CHAT_PANE], causing onSuccess to route the original chat to Pane 1
  // (Priority 1 on NEW_CHAT_PANE) instead of Pane 0.
  it('addNewChatPane with null selectedChatId puts null at both panes (chat creation in flight)', async () => {
    const onDone = vi.fn();
    render(
      <Provider store={createStore()}>
        <AddNewChatPaneHarness initialChatId={null} onDone={onDone} />
      </Provider>,
    );
    await waitFor(() => expect(onDone).toHaveBeenCalled());
    expect(onDone.mock.calls[0][0]).toEqual([null, null]);
  });
});

describe('addPane — existing split (2+ panes)', () => {
  it('addEmptyPane appends null to an existing split', async () => {
    const onDone = vi.fn();
    render(
      <Provider store={createStore()}>
        <AddPaneToExistingSplitHarness onDone={onDone} />
      </Provider>,
    );
    await waitFor(() => expect(onDone).toHaveBeenCalled());
    expect(onDone.mock.calls[0][0]).toEqual(['chat-a', 'chat-b', null]);
  });
});

describe('addPane — preserves layout when still valid for new pane count', () => {
  it.each<[string, (string | null)[], SplitLayout, SplitLayout]>([
    // [name, seedChatIds, seedLayout, expectedLayoutAfterAdd]
    ['2 horizontal → 3 stays horizontal', ['chat-a', 'chat-b'], 'horizontal', 'horizontal'],
    ['2 vertical → 3 stays vertical', ['chat-a', 'chat-b'], 'vertical', 'vertical'],
    [
      '3 horizontal → 4 stays horizontal',
      ['chat-a', 'chat-b', 'chat-c'],
      'horizontal',
      'horizontal',
    ],
    ['3 vertical → 4 stays vertical', ['chat-a', 'chat-b', 'chat-c'], 'vertical', 'vertical'],
    // Tile layouts have no 4-pane equivalent → fall back to the 4-pane default (grid).
    [
      '3 three-bottom → 4 falls back to grid',
      ['chat-a', 'chat-b', 'chat-c'],
      'three-bottom',
      'grid',
    ],
    ['3 three-right → 4 falls back to grid', ['chat-a', 'chat-b', 'chat-c'], 'three-right', 'grid'],
  ])('%s', async (_name, chatIds, seedLayout, expected) => {
    const onDone = vi.fn();
    render(
      <Provider store={createStore()}>
        <AddPaneLayoutHarness seed={seedSplit(chatIds, seedLayout)} onDone={onDone} />
      </Provider>,
    );
    await waitFor(() => expect(onDone).toHaveBeenCalled());
    expect(onDone.mock.calls[0][0]).toBe(expected);
  });
});

describe('addPane — add/remove symmetry (preserved layout survives the inverse remove)', () => {
  it('3 horizontal → add → 4 horizontal → remove → 3 horizontal (no reset either direction)', async () => {
    const onDone = vi.fn();
    render(
      <Provider store={createStore()}>
        <AddThenRemoveHarness
          seed={seedSplit(['chat-a', 'chat-b', 'chat-c'], 'horizontal')}
          onDone={onDone}
        />
      </Provider>,
    );
    await waitFor(() => expect(onDone).toHaveBeenCalled());
    expect(onDone.mock.calls[0][0]).toEqual({ afterAdd: 'horizontal', afterRemove: 'horizontal' });
  });
});

// ---------------------------------------------------------------------------
// openChatInNewPane — open an EXISTING chat in a pane (vs addPane's empty/new-chat panes)
// ---------------------------------------------------------------------------

type Store = ReturnType<typeof createStore>;

/**
 * Seeds the selected chat (and optional split), calls `openChatInNewPane` for each target in order
 * (one target for the common case; several to exercise the rapid-sequential cap), then reports the
 * resulting state read straight from the store. Reading the store synchronously after the write means
 * the no-op cases (true MAX, self-dup) are observable too — there's no state change to wait on.
 */
function OpenInNewPaneHarness({
  store,
  selected,
  seed,
  target,
  targets,
  onDone,
}: {
  store: Store;
  selected: string | null;
  seed?: SplitViewState;
  target?: string;
  targets?: string[];
  onDone: (state: SplitViewState) => void;
}) {
  const { openChatInNewPane } = useSplitViewActions();
  const split = useAtomValue(splitViewAtom);
  const selectedChatId = useAtomValue(selectedAgentChatIdAtom);
  const setSplit = useSetAtom(splitViewAtom);
  const setSelectedChatId = useSetAtom(selectedAgentChatIdAtom);
  const phase = useRef<'seed' | 'acted'>('seed');

  useEffect(() => {
    setSelectedChatId(selected);
    if (seed) setSplit(seed);
  }, [setSelectedChatId, setSplit, selected, seed]);

  useEffect(() => {
    const seedReady = seed
      ? split.chatIds.length === seed.chatIds.length
      : split.chatIds.length === 0;
    if (phase.current === 'seed' && seedReady && selectedChatId === selected) {
      phase.current = 'acted';
      const list = targets ?? (target !== undefined ? [target] : []);
      for (const t of list) openChatInNewPane(t);
      // jotai writes are synchronous, so the store already reflects the result here.
      onDone(store.get(splitViewAtom));
    }
  }, [
    split.chatIds.length,
    selectedChatId,
    selected,
    seed,
    target,
    targets,
    openChatInNewPane,
    store,
    onDone,
  ]);

  return null;
}

function renderOpenInNewPane(args: {
  selected: string | null;
  seed?: SplitViewState;
  target?: string;
  targets?: string[];
}): Promise<SplitViewState> {
  return new Promise((resolve) => {
    const store = createStore();
    const onDone = vi.fn((state: SplitViewState) => resolve(state));
    render(
      <Provider store={store}>
        <OpenInNewPaneHarness store={store} onDone={onDone} {...args} />
      </Provider>,
    );
    void waitFor(() => expect(onDone).toHaveBeenCalled());
  });
}

describe('openChatInNewPane', () => {
  it('starts a 2-pane split from the current chat when none exists, focusing the new pane', async () => {
    const state = await renderOpenInNewPane({ selected: 'chat-a', target: 'chat-b' });
    expect(state.chatIds).toEqual(['chat-a', 'chat-b']);
    expect(state.activePaneIndex).toBe(1);
  });

  it('seeds Pane 0 with null when no chat is selected yet, target at Pane 1', async () => {
    const state = await renderOpenInNewPane({ selected: null, target: 'chat-b' });
    expect(state.chatIds).toEqual([null, 'chat-b']);
    expect(state.activePaneIndex).toBe(1);
  });

  it('focuses the existing pane instead of duplicating an already-open chat', async () => {
    const state = await renderOpenInNewPane({
      selected: 'chat-a',
      seed: seedSplit(['chat-a', 'chat-b'], 'horizontal'),
      target: 'chat-b',
    });
    expect(state.chatIds).toEqual(['chat-a', 'chat-b']);
    expect(state.activePaneIndex).toBe(1);
  });

  it('is a true no-op when the chat is already in the active pane', async () => {
    // seedSplit sets activePaneIndex 0, so chat-a (index 0) is already active → nothing changes.
    const state = await renderOpenInNewPane({
      selected: 'chat-a',
      seed: seedSplit(['chat-a', 'chat-b'], 'horizontal'),
      target: 'chat-a',
    });
    expect(state.chatIds).toEqual(['chat-a', 'chat-b']);
    expect(state.activePaneIndex).toBe(0);
  });

  it('fills a waiting empty placeholder rather than growing the split', async () => {
    const state = await renderOpenInNewPane({
      selected: 'chat-a',
      seed: seedSplit(['chat-a', null], 'horizontal'),
      target: 'chat-b',
    });
    expect(state.chatIds).toEqual(['chat-a', 'chat-b']);
    expect(state.activePaneIndex).toBe(1);
  });

  it('appends a new pane when there is room and no placeholder', async () => {
    const state = await renderOpenInNewPane({
      selected: 'chat-a',
      seed: seedSplit(['chat-a', 'chat-b'], 'horizontal'),
      target: 'chat-c',
    });
    expect(state.chatIds).toEqual(['chat-a', 'chat-b', 'chat-c']);
    expect(state.activePaneIndex).toBe(2);
    // ratios + per-pane zoom must stay in lock-step with chatIds — a desync breaks pane rendering.
    expect(state.ratios).toHaveLength(3);
    expect(state.paneZoomFactors).toHaveLength(3);
  });

  it('fills a placeholder even at MAX_PANES (valid — does not exceed the cap)', async () => {
    const state = await renderOpenInNewPane({
      selected: 'chat-a',
      seed: seedSplit(['chat-a', 'chat-b', 'chat-c', null], 'grid'),
      target: 'chat-d',
    });
    expect(state.chatIds).toEqual(['chat-a', 'chat-b', 'chat-c', 'chat-d']);
    expect(state.activePaneIndex).toBe(3);
  });

  it('is a no-op at true MAX_PANES (4 full panes, no placeholder)', async () => {
    const state = await renderOpenInNewPane({
      selected: 'chat-a',
      seed: seedSplit(['chat-a', 'chat-b', 'chat-c', 'chat-d'], 'grid'),
      target: 'chat-e',
    });
    expect(state.chatIds).toEqual(['chat-a', 'chat-b', 'chat-c', 'chat-d']);
  });

  it('does not duplicate the chat when opening the currently-selected chat from single view', async () => {
    // Single view of chat-a; "Open in New Pane" on chat-a must NOT split into [chat-a, chat-a].
    // chatIds is empty in single view, so the indexOf dedup can't catch the implicit pane-0 chat.
    const state = await renderOpenInNewPane({ selected: 'chat-a', target: 'chat-a' });
    expect(state.chatIds).toEqual([]);
  });
});

describe('openChatInNewPane — caps at MAX across rapid sequential opens', () => {
  it('stops at 4 panes; the 5th open is a no-op (no overflow past MAX_PANES)', async () => {
    const state = await renderOpenInNewPane({
      selected: 'chat-a',
      targets: ['chat-b', 'chat-c', 'chat-d', 'chat-e'],
    });
    expect(state.chatIds).toEqual(['chat-a', 'chat-b', 'chat-c', 'chat-d']);
    expect(state.chatIds).not.toContain('chat-e');
  });
});

describe('canOpenChatInNewPane (capability gate — single source of truth)', () => {
  it.each<[string, (string | null)[], boolean]>([
    ['empty / no split', [], true],
    ['room to grow', ['chat-a', 'chat-b'], true],
    ['MAX with an empty placeholder is still fillable', ['chat-a', 'chat-b', 'chat-c', null], true],
    [
      'MAX with a new-chat placeholder is still fillable',
      ['chat-a', 'chat-b', 'chat-c', NEW_CHAT_PANE],
      true,
    ],
    ['MAX and full', ['chat-a', 'chat-b', 'chat-c', 'chat-d'], false],
  ])('%s → %s', (_name, chatIds, expected) => {
    expect(canOpenChatInNewPane(chatIds)).toBe(expected);
  });
});

describe('fillActivePane', () => {
  function renderFill(seed: SplitViewState) {
    const store = createStore();
    store.set(splitViewAtom, seed);
    const { result } = renderHook(() => useSplitViewActions(), {
      wrapper: ({ children }) => <Provider store={store}>{children}</Provider>,
    });
    return { store, fill: (id: string) => act(() => result.current.fillActivePane(id)) };
  }

  it.each<[string, string | null]>([
    ['new-chat', NEW_CHAT_PANE],
    ['empty', null],
  ])('replaces the active chat pane even while another pane is a %s placeholder', (_n, cell) => {
    const { store, fill } = renderFill({
      ...seedSplit(['chat-a', 'chat-b', cell], 'horizontal'),
      activePaneIndex: 1,
    });
    fill('chat-x');
    expect(store.get(splitViewAtom).chatIds).toEqual(['chat-a', 'chat-x', cell]);
    expect(store.get(splitViewAtom).activePaneIndex).toBe(1);
  });

  it('fills the active placeholder pane', () => {
    const { store, fill } = renderFill({
      ...seedSplit(['chat-a', NEW_CHAT_PANE], 'horizontal'),
      activePaneIndex: 1,
    });
    fill('chat-x');
    expect(store.get(splitViewAtom).chatIds).toEqual(['chat-a', 'chat-x']);
  });

  it('focuses a chat already open in another pane instead of duplicating it', () => {
    const { store, fill } = renderFill(seedSplit(['chat-a', 'chat-b', null], 'horizontal'));
    fill('chat-b');
    expect(store.get(splitViewAtom).chatIds).toEqual(['chat-a', 'chat-b', null]);
    expect(store.get(splitViewAtom).activePaneIndex).toBe(1);
  });
});

describe('restorePaneAt', () => {
  it('restores an empty pane without replacing a newer selection', () => {
    const store = createStore();
    store.set(splitViewAtom, seedSplit([null, 'chat-b'], 'horizontal'));
    const { result } = renderHook(() => useSplitViewActions(), {
      wrapper: ({ children }) => <Provider store={store}>{children}</Provider>,
    });

    act(() => result.current.restorePaneAt(0, 'chat-original'));
    expect(store.get(splitViewAtom).chatIds).toEqual(['chat-original', 'chat-b']);

    store.set(splitViewAtom, seedSplit(['chat-new', 'chat-b'], 'horizontal'));
    act(() => result.current.restorePaneAt(0, 'chat-original'));
    expect(store.get(splitViewAtom).chatIds).toEqual(['chat-new', 'chat-b']);
  });
});
