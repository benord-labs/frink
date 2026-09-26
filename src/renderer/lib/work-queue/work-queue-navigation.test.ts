// @vitest-environment happy-dom
import { createStore } from 'jotai';
import { describe, expect, it, vi } from 'vitest';
import { activeOverlayAtom, agentsSettingsDialogOpenAtom } from '../atoms';
import { claimWorkQueueTaskNavigationAtom, navigateFromWorkQueue } from './work-queue-navigation';

describe('claimWorkQueueTaskNavigationAtom', () => {
  it('atomically claims the live Work Queue destination', () => {
    const store = createStore();
    store.set(activeOverlayAtom, 'workqueue');

    expect(store.set(claimWorkQueueTaskNavigationAtom)).toBe(true);
    expect(store.get(activeOverlayAtom)).toBeNull();
  });

  it.each(['settings', 'flows'] as const)('preserves a newer %s destination', (destination) => {
    const store = createStore();
    store.set(activeOverlayAtom, destination);

    expect(store.set(claimWorkQueueTaskNavigationAtom)).toBe(false);
    expect(store.get(activeOverlayAtom)).toBe(destination);
  });

  it('does not consume Settings opened from Work Queue', () => {
    const store = createStore();
    store.set(activeOverlayAtom, 'workqueue');
    store.set(agentsSettingsDialogOpenAtom, true);

    expect(store.set(claimWorkQueueTaskNavigationAtom)).toBe(false);
    expect(store.get(activeOverlayAtom)).toBe('settings');
    store.set(agentsSettingsDialogOpenAtom, false);
    expect(store.get(activeOverlayAtom)).toBe('workqueue');
  });
});

describe('navigateFromWorkQueue', () => {
  it.each([
    { isMobile: false, isSplitActive: true, route: 'fill' },
    { isMobile: false, isSplitActive: false, route: 'select' },
    { isMobile: true, isSplitActive: true, route: 'select' },
  ] as const)(
    'routes through $route when mobile=$isMobile and split=$isSplitActive',
    ({ isMobile, isSplitActive, route }) => {
      const closeWorkQueue = vi.fn();
      const fillActivePane = vi.fn();
      const selectChat = vi.fn();
      navigateFromWorkQueue({
        chatId: 'chat-1',
        isMobile,
        isSplitActive,
        closeWorkQueue,
        fillActivePane,
        selectChat,
      });

      const selectedRoute = route === 'fill' ? fillActivePane : selectChat;
      const unusedRoute = route === 'fill' ? selectChat : fillActivePane;
      expect(selectedRoute).toHaveBeenCalledWith('chat-1');
      expect(unusedRoute).not.toHaveBeenCalled();
      expect(closeWorkQueue.mock.invocationCallOrder[0]).toBeLessThan(
        selectedRoute.mock.invocationCallOrder[0],
      );
    },
  );
});
