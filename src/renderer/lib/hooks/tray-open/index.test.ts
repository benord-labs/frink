// @vitest-environment happy-dom
import { renderHook } from '@testing-library/react';
import { getDefaultStore } from 'jotai';
import { describe, expect, it, vi } from 'vitest';
import type { TrayTarget } from '../../../../shared/types/tray';
import { activeOverlayAtom } from '../../atoms';
import { routeTrayTarget, useTrayOpen } from '.';

function setup(overrides: { isMobile?: boolean; isSplitActive?: boolean } = {}) {
  const route = {
    isMobile: false,
    isSplitActive: false,
    fillActivePane: vi.fn(),
    selectChat: vi.fn(),
    ...overrides,
  };
  const destinations = { leaveOverlays: vi.fn(), openWorkQueue: vi.fn() };
  return { route, destinations };
}

describe('routeTrayTarget', () => {
  it('leaves any overlay and selects the chat in a single view', () => {
    const { route, destinations } = setup();

    routeTrayTarget({ chatId: 'a', subChatId: 'a1' }, route, destinations);

    expect(destinations.leaveOverlays).toHaveBeenCalled();
    expect(route.selectChat).toHaveBeenCalledWith('a');
    expect(route.fillActivePane).not.toHaveBeenCalled();
  });

  it('shows the chat in the active pane when split view is on', () => {
    const { route, destinations } = setup({ isSplitActive: true });

    routeTrayTarget({ chatId: 'a' }, route, destinations);

    expect(route.fillActivePane).toHaveBeenCalledWith('a');
    expect(route.selectChat).not.toHaveBeenCalled();
  });

  it('selects the chat on a narrow window even when panes are open', () => {
    const { route, destinations } = setup({ isSplitActive: true, isMobile: true });

    routeTrayTarget({ chatId: 'a' }, route, destinations);

    expect(route.selectChat).toHaveBeenCalledWith('a');
  });

  it('opens the Work Queue for waits that are not one chat', () => {
    const { route, destinations } = setup();

    routeTrayTarget({ view: 'workqueue' }, route, destinations);

    expect(destinations.openWorkQueue).toHaveBeenCalled();
    expect(destinations.leaveOverlays).not.toHaveBeenCalled();
    expect(route.selectChat).not.toHaveBeenCalled();
  });
});

describe('useTrayOpen', () => {
  it('follows menu bar clicks sent from the main process until unmounted', () => {
    let deliver: ((target: TrayTarget) => void) | undefined;
    const unsubscribe = vi.fn();
    Object.defineProperty(window, 'desktopApi', {
      configurable: true,
      value: {
        onTrayOpen: (callback: (target: TrayTarget) => void) => {
          deliver = callback;
          return unsubscribe;
        },
      },
    });
    const { route } = setup();
    const { unmount } = renderHook(() => useTrayOpen(route));

    deliver?.({ chatId: 'a' });
    deliver?.({ view: 'workqueue' });
    unmount();

    expect(route.selectChat).toHaveBeenCalledWith('a');
    expect(getDefaultStore().get(activeOverlayAtom)).toBe('workqueue');
    expect(unsubscribe).toHaveBeenCalled();
  });

  it('opens the Work Queue once when a reopened window carries it in its URL', () => {
    getDefaultStore().set(activeOverlayAtom, null);
    window.history.replaceState(null, '', '/?view=workqueue');
    const { route } = setup();

    renderHook(() => useTrayOpen(route));

    expect(getDefaultStore().get(activeOverlayAtom)).toBe('workqueue');
    expect(window.location.search).toBe('');
  });
});
