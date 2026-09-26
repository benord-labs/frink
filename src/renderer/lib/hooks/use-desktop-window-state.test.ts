// @vitest-environment happy-dom
import { renderHook } from '@testing-library/react';
import { createStore, Provider } from 'jotai';
import { createElement, type ReactNode } from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { isDesktopAtom, isFullscreenAtom } from '../atoms';
import { useDesktopWindowState } from './use-desktop-window-state';

const platform = vi.hoisted(() => ({ isDesktop: true }));

vi.mock('../utils/platform', () => ({ isDesktopApp: () => platform.isDesktop }));

type DesktopApi = {
  windowIsFullscreen?: () => Promise<boolean>;
  onFullscreenChange?: (cb: (value: boolean) => void) => () => void;
};

function mount(desktopApi?: DesktopApi) {
  const store = createStore();
  vi.stubGlobal('desktopApi', undefined);
  Object.defineProperty(window, 'desktopApi', { value: desktopApi, configurable: true });
  const wrapper = ({ children }: { children: ReactNode }) =>
    createElement(Provider, { store }, children);
  const result = renderHook(() => useDesktopWindowState(), { wrapper });
  return { store, ...result };
}

afterEach(() => {
  platform.isDesktop = true;
  vi.unstubAllGlobals();
});

describe('useDesktopWindowState', () => {
  it('marks the app as desktop on mount', () => {
    const { store } = mount({});

    expect(store.get(isDesktopAtom)).toBe(true);
  });

  it('reports a non-desktop host without touching fullscreen state', () => {
    platform.isDesktop = false;
    const { store } = mount({});

    expect(store.get(isDesktopAtom)).toBe(false);
    expect(store.get(isFullscreenAtom)).toBeNull();
  });

  it('mirrors the initial native fullscreen state', async () => {
    const { store } = mount({
      windowIsFullscreen: () => Promise.resolve(true),
      onFullscreenChange: () => () => {},
    });
    await vi.waitFor(() => expect(store.get(isFullscreenAtom)).toBe(true));
  });

  /**
   * Production subscribes to native events; dev polls instead because HMR breaks IPC event
   * subscriptions. Both paths must release their resource on unmount.
   */
  it('unsubscribes from fullscreen events on unmount in production', () => {
    vi.stubEnv('DEV', false);
    const unsubscribe = vi.fn();
    const { unmount } = mount({
      windowIsFullscreen: () => Promise.resolve(false),
      onFullscreenChange: () => unsubscribe,
    });

    unmount();
    expect(unsubscribe).toHaveBeenCalledTimes(1);
    vi.unstubAllEnvs();
  });

  it('polls instead of subscribing in dev, and stops polling on unmount', async () => {
    vi.stubEnv('DEV', true);
    vi.useFakeTimers();
    const onFullscreenChange = vi.fn();
    const windowIsFullscreen = vi.fn(() => Promise.resolve(false));
    const { unmount } = mount({ windowIsFullscreen, onFullscreenChange });

    await vi.advanceTimersByTimeAsync(2500);
    const polledCalls = windowIsFullscreen.mock.calls.length;
    expect(polledCalls).toBeGreaterThan(1);
    expect(onFullscreenChange).not.toHaveBeenCalled();

    unmount();
    await vi.advanceTimersByTimeAsync(5000);
    expect(windowIsFullscreen.mock.calls.length).toBe(polledCalls);

    vi.useRealTimers();
    vi.unstubAllEnvs();
  });

  /** Preload can expose a partial API; a missing probe must not throw at startup. */
  it('tolerates a desktop bridge without a fullscreen probe', () => {
    expect(() => mount({})).not.toThrow();
    expect(() => mount(undefined)).not.toThrow();
  });
});
