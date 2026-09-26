// @vitest-environment happy-dom
import { act, renderHook } from '@testing-library/react';
import { createStore, Provider } from 'jotai';
import type { ReactNode } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { arcadeRunAtom, KONAMI_SEQUENCE, useKeySequence, useStartArcade } from './use-easter-eggs';

function withStore(store: ReturnType<typeof createStore>) {
  return ({ children }: { children: ReactNode }) => <Provider store={store}>{children}</Provider>;
}

function pressKeys(codes: readonly string[]) {
  for (const code of codes) window.dispatchEvent(new KeyboardEvent('keydown', { code }));
}

function pressModifier(key: string) {
  window.dispatchEvent(new KeyboardEvent('keydown', { key, code: `${key}Left` }));
}

beforeEach(() => {
  vi.useFakeTimers();
});

afterEach(() => {
  vi.useRealTimers();
});

describe('useStartArcade', () => {
  it('opens a fresh game run on every call', () => {
    const store = createStore();
    const { result } = renderHook(() => useStartArcade(), { wrapper: withStore(store) });

    act(() => result.current());
    const first = store.get(arcadeRunAtom);
    act(() => result.current());
    expect(first).not.toBeNull();
    expect(store.get(arcadeRunAtom)).not.toBe(first);
  });
});

describe('useKeySequence', () => {
  it('fires once the last keys equal the sequence, then starts over', () => {
    const onMatch = vi.fn();
    renderHook(() => useKeySequence(KONAMI_SEQUENCE, onMatch));

    pressKeys(['KeyX', ...KONAMI_SEQUENCE]);
    expect(onMatch).toHaveBeenCalledTimes(1);

    pressKeys(KONAMI_SEQUENCE.slice(1));
    expect(onMatch).toHaveBeenCalledTimes(1);
  });

  it('ignores modifier keys pressed mid-sequence', () => {
    const onMatch = vi.fn();
    renderHook(() => useKeySequence(['KeyA', 'KeyB'], onMatch));

    pressKeys(['KeyA']);
    pressModifier('Shift');
    pressKeys(['KeyB']);
    expect(onMatch).toHaveBeenCalledTimes(1);
  });

  it('forgets a partial match after the inter-key gap', () => {
    const onMatch = vi.fn();
    renderHook(() => useKeySequence(['KeyA', 'KeyB'], onMatch, { timeoutMs: 500 }));

    pressKeys(['KeyA']);
    act(() => vi.advanceTimersByTime(501));
    pressKeys(['KeyB']);
    expect(onMatch).not.toHaveBeenCalled();

    pressKeys(['KeyA', 'KeyB']);
    expect(onMatch).toHaveBeenCalledTimes(1);
  });

  it('drops the buffer and its pending reset on an ignored keystroke', () => {
    const onMatch = vi.fn();
    const shouldIgnore = (e: KeyboardEvent) => e.code === 'KeyZ';
    renderHook(() => useKeySequence(['KeyA', 'KeyB'], onMatch, { shouldIgnore, timeoutMs: 500 }));

    pressKeys(['KeyA', 'KeyZ', 'KeyB']);
    expect(onMatch).not.toHaveBeenCalled();

    // A sequence started right after the ignored key must not be wiped by the earlier timer.
    pressKeys(['KeyA']);
    act(() => vi.advanceTimersByTime(400));
    pressKeys(['KeyB']);
    expect(onMatch).toHaveBeenCalledTimes(1);
  });
});

describe('useLateNightCameo', () => {
  const at = (hour: number, minute: number, day = 24) => new Date(2026, 8, day, hour, minute);
  let useLateNightCameo: (show: () => boolean) => void = () => {};

  // A fresh module per test: the cameo remembers it was shown for the whole session.
  beforeEach(async () => {
    localStorage.clear();
    vi.resetModules();
    ({ useLateNightCameo } = await import('./use-easter-eggs'));
  });

  it('shows the first time Frink is open at 3am, and never again', () => {
    vi.setSystemTime(at(2, 59));
    const show = vi.fn(() => true);
    renderHook(() => useLateNightCameo(show));
    expect(show).not.toHaveBeenCalled();

    vi.setSystemTime(at(3, 10));
    window.dispatchEvent(new Event('focus'));
    window.dispatchEvent(new Event('focus'));
    expect(show).toHaveBeenCalledOnce();

    vi.setSystemTime(at(3, 5, 25));
    window.dispatchEvent(new Event('focus'));
    expect(show).toHaveBeenCalledOnce();
  });

  it('stays unclaimed when the cameo could not show', () => {
    vi.setSystemTime(at(3, 10));
    let free = false;
    const show = vi.fn(() => free);
    renderHook(() => useLateNightCameo(show));
    free = true;
    window.dispatchEvent(new Event('focus'));
    window.dispatchEvent(new Event('focus'));
    expect(show).toHaveBeenCalledTimes(2);
  });

  it('shows only once when localStorage can be read but not written', () => {
    vi.setSystemTime(at(3, 20));
    vi.spyOn(localStorage, 'setItem').mockImplementation(() => {
      throw new Error('quota exceeded');
    });
    const show = vi.fn(() => true);
    renderHook(() => useLateNightCameo(show));
    window.dispatchEvent(new Event('focus'));
    expect(show).toHaveBeenCalledOnce();
    vi.restoreAllMocks();
  });

  it('shows only once when localStorage is unavailable', () => {
    vi.setSystemTime(at(3, 20));
    vi.spyOn(localStorage, 'getItem').mockImplementation(() => {
      throw new Error('storage disabled');
    });
    vi.spyOn(localStorage, 'setItem').mockImplementation(() => {
      throw new Error('storage disabled');
    });
    const show = vi.fn(() => true);
    renderHook(() => useLateNightCameo(show));
    window.dispatchEvent(new Event('focus'));
    expect(show).toHaveBeenCalledOnce();
    vi.restoreAllMocks();
  });
});
