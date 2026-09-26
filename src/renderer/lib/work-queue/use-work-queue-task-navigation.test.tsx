// @vitest-environment happy-dom
import { renderHook } from '@testing-library/react';
import { createStore, Provider } from 'jotai';
import type { ReactNode } from 'react';
import { describe, expect, it, vi } from 'vitest';
import { activeOverlayAtom } from '../atoms';
import { useWorkQueueTaskNavigation } from './use-work-queue-task-navigation';

function wrapperFor(store: ReturnType<typeof createStore>) {
  return ({ children }: { children: ReactNode }) => <Provider store={store}>{children}</Provider>;
}

describe('useWorkQueueTaskNavigation', () => {
  it('checks mount and live ownership without consuming the destination', () => {
    const store = createStore();
    store.set(activeOverlayAtom, 'workqueue');
    const hook = renderHook(() => useWorkQueueTaskNavigation(vi.fn()), {
      wrapper: wrapperFor(store),
    });
    const ownsTaskNavigation = hook.result.current.ownsTaskNavigation;

    expect(ownsTaskNavigation()).toBe(true);
    expect(store.get(activeOverlayAtom)).toBe('workqueue');
    store.set(activeOverlayAtom, 'settings');
    expect(ownsTaskNavigation()).toBe(false);
    store.set(activeOverlayAtom, 'workqueue');
    hook.unmount();
    expect(ownsTaskNavigation()).toBe(false);
    expect(store.get(activeOverlayAtom)).toBe('workqueue');
  });
});
