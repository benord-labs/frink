// @vitest-environment happy-dom
import { act, renderHook } from '@testing-library/react';
import { createStore, Provider } from 'jotai';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { splitViewAtom } from '../atoms';
import { useFocusInputOnEnter } from './use-focus-input-on-enter';

function makeSplitStore(activePaneIndex = 0) {
  const store = createStore();
  store.set(splitViewAtom, {
    chatIds: ['chat-a', 'chat-b'],
    ratios: [0.5, 0.5],
    activePaneIndex,
    layout: 'horizontal' as const,
  });
  return store;
}

function storeWrapper(store: ReturnType<typeof createStore>) {
  return function Wrapper({ children }: { children: React.ReactNode }) {
    return <Provider store={store}>{children}</Provider>;
  };
}

function fireEnter(target: EventTarget = document.body) {
  const event = new KeyboardEvent('keydown', {
    key: 'Enter',
    bubbles: true,
    cancelable: true,
  });
  target.dispatchEvent(event);
  return event;
}

function makeFocusSpy() {
  const focus = vi.fn();
  const ref = { current: { focus } };
  return { ref, focus };
}

describe('useFocusInputOnEnter', () => {
  beforeEach(() => {
    document.body.innerHTML = '';
  });

  afterEach(() => {
    document.body.innerHTML = '';
  });

  describe('bug 1 — pane-aware focus', () => {
    it('focuses input when splitPaneIndex matches activePaneIndex', () => {
      const store = makeSplitStore(1);
      const { ref, focus } = makeFocusSpy();

      renderHook(() => useFocusInputOnEnter(ref, 1), {
        wrapper: storeWrapper(store),
      });

      fireEnter();
      expect(focus).toHaveBeenCalledOnce();
    });

    it('does NOT focus input when splitPaneIndex does not match activePaneIndex', () => {
      const store = makeSplitStore(1);
      const { ref, focus } = makeFocusSpy();

      renderHook(() => useFocusInputOnEnter(ref, 0), {
        wrapper: storeWrapper(store),
      });

      fireEnter();
      expect(focus).not.toHaveBeenCalled();
    });

    it('only the active pane responds when both panes have listeners', () => {
      const store = makeSplitStore(1);
      const pane0 = makeFocusSpy();
      const pane1 = makeFocusSpy();

      renderHook(() => useFocusInputOnEnter(pane0.ref, 0), {
        wrapper: storeWrapper(store),
      });
      renderHook(() => useFocusInputOnEnter(pane1.ref, 1), {
        wrapper: storeWrapper(store),
      });

      fireEnter();
      expect(pane0.focus).not.toHaveBeenCalled();
      expect(pane1.focus).toHaveBeenCalledOnce();
    });

    it('re-routes focus when activePaneIndex changes', () => {
      const store = makeSplitStore(0);
      const pane0 = makeFocusSpy();
      const pane1 = makeFocusSpy();

      renderHook(() => useFocusInputOnEnter(pane0.ref, 0), {
        wrapper: storeWrapper(store),
      });
      renderHook(() => useFocusInputOnEnter(pane1.ref, 1), {
        wrapper: storeWrapper(store),
      });

      fireEnter();
      expect(pane0.focus).toHaveBeenCalledOnce();
      expect(pane1.focus).not.toHaveBeenCalled();

      pane0.focus.mockClear();

      act(() => {
        store.set(splitViewAtom, {
          chatIds: ['chat-a', 'chat-b'],
          ratios: [0.5, 0.5],
          activePaneIndex: 1,
          layout: 'horizontal' as const,
        });
      });

      fireEnter();
      expect(pane0.focus).not.toHaveBeenCalled();
      expect(pane1.focus).toHaveBeenCalledOnce();
    });
  });

  it('ignores Enter while its pane chat is hidden behind a side panel', () => {
    const store = makeSplitStore(0);
    const { ref, focus } = makeFocusSpy();
    const pane = document.createElement('section');
    pane.dataset.paneIndex = '0';
    const chat = document.createElement('div');
    chat.dataset.paneChat = '';
    let chatVisible = false;
    chat.checkVisibility = () => chatVisible;
    pane.append(chat);
    document.body.append(pane);

    renderHook(() => useFocusInputOnEnter(ref, 0), { wrapper: storeWrapper(store) });

    expect(fireEnter().defaultPrevented).toBe(false);
    expect(focus).not.toHaveBeenCalled();
    chatVisible = true;
    fireEnter();
    expect(focus).toHaveBeenCalledOnce();
  });

  describe('bug 2 — code editor exclusion', () => {
    it('does NOT focus input when Enter is pressed inside code editor panel', () => {
      const store = createStore();
      const { ref, focus } = makeFocusSpy();

      const panel = document.createElement('div');
      panel.setAttribute('data-code-editor-panel', 'true');
      const innerEl = document.createElement('div');
      panel.appendChild(innerEl);
      document.body.appendChild(panel);

      renderHook(() => useFocusInputOnEnter(ref), {
        wrapper: storeWrapper(store),
      });

      fireEnter(innerEl);
      expect(focus).not.toHaveBeenCalled();
    });

    it('focuses input when code editor panel exists but Enter target is outside it', () => {
      const store = createStore();
      const { ref, focus } = makeFocusSpy();

      const panel = document.createElement('div');
      panel.setAttribute('data-code-editor-panel', 'true');
      document.body.appendChild(panel);

      const outsideEl = document.createElement('div');
      document.body.appendChild(outsideEl);

      renderHook(() => useFocusInputOnEnter(ref), {
        wrapper: storeWrapper(store),
      });

      fireEnter(outsideEl);
      expect(focus).toHaveBeenCalledOnce();
    });
  });

  describe('single-pane mode — regression guard', () => {
    it('focuses input when splitPaneIndex is undefined (single-pane mode)', () => {
      const store = createStore();
      const { ref, focus } = makeFocusSpy();

      renderHook(() => useFocusInputOnEnter(ref), {
        wrapper: storeWrapper(store),
      });

      fireEnter();
      expect(focus).toHaveBeenCalledOnce();
    });

    it('focuses input when splitPaneIndex is undefined even with split view atom set', () => {
      const store = makeSplitStore(1);
      const { ref, focus } = makeFocusSpy();

      renderHook(() => useFocusInputOnEnter(ref), {
        wrapper: storeWrapper(store),
      });

      fireEnter();
      expect(focus).toHaveBeenCalledOnce();
    });
  });

  describe('destination ownership', () => {
    it('does not prevent Enter or focus retained chat while Work Queue is visible', () => {
      const store = createStore();
      const { ref, focus } = makeFocusSpy();
      const workQueueButton = document.createElement('button');
      workQueueButton.dataset.agentsDestination = 'workqueue';
      document.body.append(workQueueButton);

      renderHook(() => useFocusInputOnEnter(ref), {
        wrapper: storeWrapper(store),
      });

      const event = fireEnter(workQueueButton);

      expect(event.defaultPrevented).toBe(false);
      expect(focus).not.toHaveBeenCalled();
    });

    it('prevents Enter and focuses the editor while chat is visible', () => {
      const store = createStore();
      const { ref, focus } = makeFocusSpy();

      renderHook(() => useFocusInputOnEnter(ref), {
        wrapper: storeWrapper(store),
      });

      const event = fireEnter();

      expect(event.defaultPrevented).toBe(true);
      expect(focus).toHaveBeenCalledOnce();
    });
  });
});
