// @vitest-environment happy-dom
import { act, renderHook } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { usePeriodicNow } from './use-periodic-now';

describe('usePeriodicNow', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2025-06-01T12:00:00.000Z'));
  });

  afterEach(() => {
    vi.runOnlyPendingTimers();
    vi.useRealTimers();
  });

  it('does not advance while inactive (no interval)', () => {
    const { result } = renderHook(() => usePeriodicNow(false));
    const frozen = result.current;
    act(() => {
      vi.advanceTimersByTime(60_000);
    });
    expect(result.current).toBe(frozen);
  });

  it('updates on each interval while active', () => {
    const { result } = renderHook(() => usePeriodicNow(true));
    const t0 = result.current;
    act(() => {
      vi.advanceTimersByTime(1000);
    });
    expect(result.current).toBe(t0 + 1000);
    act(() => {
      vi.advanceTimersByTime(1000);
    });
    expect(result.current).toBe(t0 + 2000);
  });

  it('stops advancing when isActive becomes false', () => {
    const { result, rerender } = renderHook(
      ({ active }: { active: boolean }) => usePeriodicNow(active),
      {
        initialProps: { active: true },
      },
    );
    act(() => {
      vi.advanceTimersByTime(1000);
    });
    const afterTick = result.current;
    rerender({ active: false });
    act(() => {
      vi.advanceTimersByTime(60_000);
    });
    expect(result.current).toBe(afterTick);
  });

  it('respects custom intervalMs', () => {
    const { result } = renderHook(() => usePeriodicNow(true, 250));
    const t0 = result.current;
    act(() => {
      vi.advanceTimersByTime(250);
    });
    expect(result.current).toBe(t0 + 250);
  });
});
