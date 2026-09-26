// @vitest-environment happy-dom
import { act, cleanup, renderHook } from '@testing-library/react';
import { createStore } from 'jotai';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  activeOverlayAtom,
  exitTransientDestinationForNavigationAtom,
} from '../atoms/agent-navigation-atoms';
import { EXIT_HOTKEY_ACTIONS, useWorkQueueDestination } from './use-work-queue-destination';

type Input = Parameters<typeof useWorkQueueDestination>[0];

function makeInput(overrides: Partial<Input> = {}): Input {
  return {
    isMobile: false,
    isSplitActive: false,
    setActiveOverlay: vi.fn(),
    exitWorkQueueForNavigation: vi.fn(() => true),
    fillActivePane: vi.fn(),
    selectChat: vi.fn(),
    focusWorkQueueTrigger: vi.fn(),
    ...overrides,
  };
}

beforeEach(() => {
  vi.stubGlobal(
    'requestAnimationFrame',
    vi.fn((callback: FrameRequestCallback) => {
      callback(0);
      return 1;
    }),
  );
});

afterEach(() => {
  cleanup();
  document.body.replaceChildren();
  vi.unstubAllGlobals();
});

describe('useWorkQueueDestination', () => {
  it('routes an async-held callback using the latest split state', () => {
    const initial = makeInput({ isMobile: false, isSplitActive: true });
    const latest = makeInput({ isMobile: false, isSplitActive: false });
    const { result, rerender } = renderHook((input: Input) => useWorkQueueDestination(input), {
      initialProps: initial,
    });
    const asyncHeldCallback = result.current.navigateWorkQueueToChat;
    rerender(latest);

    act(() => asyncHeldCallback('chat-1'));

    expect(latest.selectChat).toHaveBeenCalledWith('chat-1');
    expect(latest.fillActivePane).not.toHaveBeenCalled();
    expect(latest.setActiveOverlay).toHaveBeenCalledWith(null);
  });

  it('restores focus through the desktop sidebar trigger after a dismissal', () => {
    const input = makeInput({ isMobile: false });
    const { result } = renderHook(() => useWorkQueueDestination(input));

    act(() => result.current.requestWorkQueueClose());

    expect(input.setActiveOverlay).toHaveBeenCalledWith(null);
    expect(input.focusWorkQueueTrigger).toHaveBeenCalledOnce();
    expect(input.selectChat).not.toHaveBeenCalled();
    expect(input.fillActivePane).not.toHaveBeenCalled();
  });

  it('does not restore focus while navigating from the Work Queue to a task chat', () => {
    const input = makeInput({ isMobile: true });
    const { result } = renderHook(() => useWorkQueueDestination(input));

    act(() => result.current.navigateWorkQueueToChat('chat-1'));

    expect(input.setActiveOverlay).toHaveBeenCalledWith(null);
    expect(input.selectChat).toHaveBeenCalledWith('chat-1');
    expect(requestAnimationFrame).not.toHaveBeenCalled();
    expect(input.focusWorkQueueTrigger).not.toHaveBeenCalled();
  });

  it.each([
    'close-all-editor-files',
    'toggle-editor-layout',
    'open-branch-picker',
    'open-branch-delete-picker',
    'next-pane-group',
    'prev-pane-group',
  ])('exits before dispatching the %s hotkey to destination listeners', (actionId) => {
    const input = makeInput();
    const { result } = renderHook(() => useWorkQueueDestination(input));

    const preparation = result.current.prepareForAgentsHotkey(actionId);

    expect(input.exitWorkQueueForNavigation).toHaveBeenCalledOnce();
    expect(preparation).toBeInstanceOf(Promise);
  });

  // The sidebar toggle short-circuits ahead of the settle machinery, so it must neither wait on
  // a pending exit frame nor consume the destination transfer that frame is holding.
  it('runs the sidebar hotkey immediately while a deferred exit frame is pending', async () => {
    const frameCallbacks: FrameRequestCallback[] = [];
    vi.stubGlobal(
      'requestAnimationFrame',
      vi.fn((callback: FrameRequestCallback) => {
        frameCallbacks.push(callback);
        return frameCallbacks.length;
      }),
    );
    const input = makeInput();
    const { result } = renderHook(() => useWorkQueueDestination(input));

    const deferred = result.current.prepareForAgentsHotkey('open-branch-picker');
    expect(deferred).toBeInstanceOf(Promise);

    expect(result.current.prepareForAgentsHotkey('toggle-sidebar')).toBe(true);
    expect(input.exitWorkQueueForNavigation).toHaveBeenCalledOnce();

    act(() => frameCallbacks.shift()?.(0));
    await act(async () => {
      await deferred;
    });
  });

  it('dispatches each deferred action once while actions share a settle frame', async () => {
    const frameCallbacks: FrameRequestCallback[] = [];
    vi.stubGlobal(
      'requestAnimationFrame',
      vi.fn((callback: FrameRequestCallback) => {
        frameCallbacks.push(callback);
        return frameCallbacks.length;
      }),
    );
    const input = makeInput();
    const { result } = renderHook(() => useWorkQueueDestination(input));
    const dispatched: string[] = [];
    const dispatch = async (actionId: string) => {
      if (await result.current.prepareForAgentsHotkey(actionId)) dispatched.push(actionId);
    };

    const owner = dispatch('open-branch-picker');
    const borrower = dispatch('next-pane-group');
    const repeatedBorrower = dispatch('next-pane-group');
    await act(async () => repeatedBorrower);

    expect(input.exitWorkQueueForNavigation).toHaveBeenCalledOnce();
    expect(dispatched).toEqual([]);

    act(() => frameCallbacks.shift()?.(0));
    await act(async () => Promise.all([owner, borrower]));

    expect(dispatched).toEqual(['open-branch-picker', 'next-pane-group']);

    const freshBorrower = dispatch('next-pane-group');
    expect(input.exitWorkQueueForNavigation).toHaveBeenCalledTimes(2);
    act(() => frameCallbacks.shift()?.(0));
    await act(async () => freshBorrower);

    expect(dispatched).toEqual(['open-branch-picker', 'next-pane-group', 'next-pane-group']);
  });

  it('consumes a Work Queue return before the create-new-agent hotkey', () => {
    const input = makeInput();
    const { result } = renderHook(() => useWorkQueueDestination(input));

    result.current.prepareForAgentsHotkey('create-new-agent');

    expect(input.exitWorkQueueForNavigation).toHaveBeenCalledOnce();
  });

  it('keeps the current destination when the sidebar is toggled', () => {
    const input = makeInput();
    const { result } = renderHook(() => useWorkQueueDestination(input));

    expect(result.current.prepareForAgentsHotkey('toggle-sidebar')).toBe(true);
    expect(input.exitWorkQueueForNavigation).not.toHaveBeenCalled();
    expect(input.setActiveOverlay).not.toHaveBeenCalled();
  });
});

/**
 * The hotkey pre-action path shares one exit atom with the unified sidebar. Only the sidebar is
 * rendered beside the Flows dashboard, so these actions must act in place there rather than
 * dismissing the destination out from under the user.
 */
describe('useWorkQueueDestination hotkey exits, by destination', () => {
  const prepare = async (actionId: string, overlay: 'flows' | 'workqueue') => {
    const store = createStore();
    store.set(activeOverlayAtom, overlay);
    const input = makeInput({
      // Exactly how agents-layout wires it: no opt-in, so Flows is not dismissable.
      exitWorkQueueForNavigation: () => store.set(exitTransientDestinationForNavigationAtom),
    });
    const { result } = renderHook(() => useWorkQueueDestination(input));

    await act(async () => {
      await result.current.prepareForAgentsHotkey(actionId);
    });
    return store.get(activeOverlayAtom);
  };

  it.each([...EXIT_HOTKEY_ACTIONS])('leaves the Flows dashboard standing for %s', async (id) => {
    expect(await prepare(id, 'flows')).toBe('flows');
  });

  it.each([...EXIT_HOTKEY_ACTIONS])('still transfers away from Work Queue for %s', async (id) => {
    expect(await prepare(id, 'workqueue')).toBeNull();
  });
});
