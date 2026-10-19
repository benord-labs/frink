// @vitest-environment happy-dom
import { createStore } from 'jotai';
import { beforeEach, describe, expect, it } from 'vitest';
import { paneHistoryAtom } from '@/lib/atoms/pane-history';
import {
  getDefaultRatios,
  NEW_CHAT_PANE,
  type SplitViewState,
  splitViewAtom,
  swapAllPaneStateAtom,
} from '../atoms';
import { showChatInPaneAtom } from './use-split-view-actions';

function split(chatIds: (string | null)[], activePaneIndex = 0): SplitViewState {
  return {
    chatIds,
    ratios: getDefaultRatios(chatIds.length),
    activePaneIndex,
    layout: chatIds.length === 4 ? 'grid' : 'horizontal',
  };
}

function seedStore(chatIds: (string | null)[], activePaneIndex = 0) {
  const store = createStore();
  store.set(splitViewAtom, split(chatIds, activePaneIndex));
  return {
    store,
    show: (chatId: string, paneIndex?: number) =>
      store.set(showChatInPaneAtom, { chatId, paneIndex }),
    back: (chatId: string, paneIndex: number) =>
      store.set(showChatInPaneAtom, { chatId, paneIndex, goingBack: true }),
    chatIds: () => store.get(splitViewAtom).chatIds,
    history: () => store.get(paneHistoryAtom),
  };
}

beforeEach(() => {
  window.localStorage.clear();
});

describe('showChatInPaneAtom', () => {
  it('replaces the active pane and remembers the chat it replaced', () => {
    const pane = seedStore(['a', 'b', 'c', 'd'], 1);
    pane.show('x');
    expect(pane.chatIds()).toEqual(['a', 'x', 'c', 'd']);
    expect(pane.history()).toEqual({ x: ['b'] });
  });

  it('steps Back through several peeks to the chat the pane was watching', () => {
    const pane = seedStore(['a', 'watched'], 1);
    pane.show('peek-1');
    pane.show('peek-2');
    expect(pane.history()).toEqual({ 'peek-2': ['watched', 'peek-1'] });

    pane.back('peek-1', 1);
    expect(pane.history()).toEqual({ 'peek-1': ['watched'] });
    pane.back('watched', 1);
    expect(pane.chatIds()).toEqual(['a', 'watched']);
    expect(pane.history()).toEqual({});
  });

  it('going back to an older chat drops the newer ones it skipped', () => {
    const pane = seedStore(['a', 'watched'], 1);
    pane.show('peek-1');
    pane.show('peek-2');
    pane.back('watched', 1);
    expect(pane.chatIds()).toEqual(['a', 'watched']);
    expect(pane.history()).toEqual({});
  });

  it('shows the chat in the given pane and makes that pane active', () => {
    const pane = seedStore(['a', 'b', 'c'], 0);
    pane.show('x', 2);
    expect(pane.chatIds()).toEqual(['a', 'b', 'x']);
    expect(pane.store.get(splitViewAtom).activePaneIndex).toBe(2);
  });

  it.each([
    ['an empty', null],
    ['a new-chat', NEW_CHAT_PANE],
  ])('remembers nothing when filling %s pane', (_name, cell) => {
    const pane = seedStore(['a', cell], 1);
    pane.show('x');
    expect(pane.chatIds()).toEqual(['a', 'x']);
    expect(pane.history()).toEqual({});
  });

  it('focuses a chat already open in another pane without touching history', () => {
    const pane = seedStore(['a', 'b'], 0);
    pane.show('b');
    expect(pane.chatIds()).toEqual(['a', 'b']);
    expect(pane.store.get(splitViewAtom).activePaneIndex).toBe(1);
    expect(pane.history()).toEqual({});
  });

  it('never lists the shown chat in its own history, and keeps the latest five', () => {
    const pane = seedStore(['a', 'start'], 1);
    pane.show('x');
    pane.show('start');
    expect(pane.history()).toEqual({ start: ['x'] });

    for (const id of ['c1', 'c2', 'c3', 'c4', 'c5']) pane.show(id);
    expect(pane.history()).toEqual({ c5: ['start', 'c1', 'c2', 'c3', 'c4'] });
  });

  it('ignores a pane index outside the split', () => {
    const pane = seedStore(['a', 'b'], 0);
    pane.show('x', 5);
    expect(pane.chatIds()).toEqual(['a', 'b']);
    expect(pane.history()).toEqual({});
  });
});

describe('pane history pruning', () => {
  it('keeps history with its chat when panes are swapped', () => {
    const pane = seedStore(['a', 'b'], 1);
    pane.show('x');
    pane.store.set(swapAllPaneStateAtom, { from: 0, to: 1 });
    expect(pane.chatIds()).toEqual(['x', 'a']);
    expect(pane.history()).toEqual({ x: ['b'] });
  });

  it('keeps the same history object on writes that drop nothing, like pane resizes', () => {
    const pane = seedStore(['a', 'b'], 1);
    pane.show('x');
    const before = pane.history();
    pane.store.set(splitViewAtom, { ...pane.store.get(splitViewAtom), ratios: [0.3, 0.7] });
    expect(pane.history()).toBe(before);
  });

  it.each<[string, (string | null)[]]>([
    ['its pane is removed', ['a', 'c']],
    ['its pane is cleared, as archiving does', ['a', null]],
    ['the split closes', []],
  ])('forgets a chat’s history once %s, so reopening it shows no Back', (_name, after) => {
    const pane = seedStore(['a', 'b'], 1);
    pane.show('x');
    pane.store.set(splitViewAtom, split(after));
    expect(pane.history()).toEqual({});

    pane.store.set(splitViewAtom, split(['a', 'x']));
    expect(pane.history()).toEqual({});
  });
});
