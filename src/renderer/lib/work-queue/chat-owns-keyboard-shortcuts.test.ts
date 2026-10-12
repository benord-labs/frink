// @vitest-environment happy-dom
import { createStore } from 'jotai';
import { afterEach, describe, expect, it } from 'vitest';
import { activeOverlayAtom } from '../atoms';
import {
  chatOwnsKeyboardShortcuts,
  focusedChatOwnsShortcuts,
  runChatShortcutAction,
} from './chat-owns-keyboard-shortcuts';

afterEach(() => {
  document.body.replaceChildren();
});

describe('chatOwnsKeyboardShortcuts', () => {
  it('returns true while chat is the visible destination', () => {
    expect(chatOwnsKeyboardShortcuts()).toBe(true);
  });

  it('returns false while Work Queue is the visible destination', () => {
    const workQueue = document.createElement('main');
    workQueue.dataset.agentsDestination = 'workqueue';
    document.body.append(workQueue);

    expect(chatOwnsKeyboardShortcuts()).toBe(false);
  });

  it('returns false while Settings covers the chat', () => {
    const settings = document.createElement('div');
    settings.dataset.agentsDestination = 'settings';
    document.body.append(settings);

    expect(chatOwnsKeyboardShortcuts()).toBe(false);
  });

  it('exits Work Queue before running a retained chat shortcut action', () => {
    const store = createStore();
    const observedDestinations: Array<string | null> = [];
    store.set(activeOverlayAtom, 'workqueue');

    expect(
      runChatShortcutAction(store, true, () => {
        observedDestinations.push(store.get(activeOverlayAtom));
      }),
    ).toBe(true);
    expect(observedDestinations).toEqual([null]);
    expect(store.get(activeOverlayAtom)).toBeNull();
  });

  it('keeps Work Queue and the chat action unchanged when no action target exists', () => {
    const store = createStore();
    let actionRuns = 0;
    store.set(activeOverlayAtom, 'workqueue');

    expect(runChatShortcutAction(store, false, () => actionRuns++)).toBe(false);
    expect(store.get(activeOverlayAtom)).toBe('workqueue');
    expect(actionRuns).toBe(0);
  });
});

describe('focusedChatOwnsShortcuts', () => {
  /** A split pane whose chat column reports the given visibility, as a compact side panel does. */
  const mountPane = (paneIndex: number, isChatVisible: boolean) => {
    const pane = document.createElement('div');
    pane.dataset.paneIndex = String(paneIndex);
    const chat = document.createElement('div');
    chat.dataset.paneChat = '';
    chat.checkVisibility = () => isChatVisible;
    pane.append(chat);
    document.body.append(pane);
  };

  it('is true for the single pane, which has no pane column to hide', () => {
    expect(focusedChatOwnsShortcuts(undefined)).toBe(true);
  });

  it('is true while the active split pane shows its chat', () => {
    mountPane(1, true);

    expect(focusedChatOwnsShortcuts(1)).toBe(true);
  });

  it('is false while a side panel hides the active split pane chat', () => {
    mountPane(0, true);
    mountPane(1, false);

    expect(focusedChatOwnsShortcuts(1)).toBe(false);
    expect(focusedChatOwnsShortcuts(0)).toBe(true);
  });
});
