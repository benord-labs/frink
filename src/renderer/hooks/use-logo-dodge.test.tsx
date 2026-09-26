// @vitest-environment happy-dom
import { act, renderHook } from '@testing-library/react';
import { createStore, Provider } from 'jotai';
import type { ReactNode } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mascotCameoActiveAtom, mascotChaserActiveAtom } from './use-easter-eggs';
import { useLogoDodge } from './use-logo-dodge';

function renderDodge(store: ReturnType<typeof createStore>) {
  const wrapper = ({ children }: { children: ReactNode }) => (
    <Provider store={store}>{children}</Provider>
  );
  return renderHook(() => useLogoDodge({ current: null }), { wrapper });
}

function click(result: ReturnType<typeof renderDodge>['result'], times: number) {
  for (let i = 0; i < times; i++) {
    act(() => result.current.handlePointerDown());
  }
}

beforeEach(() => {
  vi.useFakeTimers();
});

afterEach(() => {
  vi.useRealTimers();
});

describe('useLogoDodge milestones', () => {
  it('shows the cameo on exactly the 15th click and not again on the 16th', () => {
    const store = createStore();
    const { result } = renderDodge(store);

    click(result, 14);
    expect(store.get(mascotCameoActiveAtom)).toBe(false);

    click(result, 1);
    expect(store.get(mascotCameoActiveAtom)).toBe(true);

    store.set(mascotCameoActiveAtom, false);
    click(result, 1);
    expect(store.get(mascotCameoActiveAtom)).toBe(false);
  });

  it('starts the chaser at 30 clicks, sends the logo home, and keeps the chaser until the click streak decays', () => {
    const store = createStore();
    const { result } = renderDodge(store);

    click(result, 30);
    expect(store.get(mascotChaserActiveAtom)).toBe(true);
    expect(result.current.offset).toEqual({ x: 0, y: 0 });

    act(() => vi.advanceTimersByTime(14999));
    expect(store.get(mascotChaserActiveAtom)).toBe(true);

    act(() => vi.advanceTimersByTime(1));
    expect(store.get(mascotChaserActiveAtom)).toBe(false);
    expect(result.current.phase).toBe('idle');

    click(result, 1);
    expect(result.current.phase).toBe('idle');
  });

  it('releases the chaser when the hook unmounts before the click streak decays', () => {
    const store = createStore();
    const { result, unmount } = renderDodge(store);

    click(result, 30);
    expect(store.get(mascotChaserActiveAtom)).toBe(true);

    unmount();
    expect(store.get(mascotChaserActiveAtom)).toBe(false);
  });

  it('dodges from the third click and idles again after 15 s without clicks', () => {
    const store = createStore();
    const { result } = renderDodge(store);

    click(result, 2);
    expect(result.current.phase).toBe('idle');

    click(result, 1);
    expect(result.current.phase).toBe('active');
    expect(result.current.offset).not.toEqual({ x: 0, y: 0 });

    act(() => vi.advanceTimersByTime(15000));
    expect(result.current.phase).toBe('idle');
    expect(result.current.offset).toEqual({ x: 0, y: 0 });
  });
});
