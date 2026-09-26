// @vitest-environment happy-dom
import { renderHook } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const { aggregatedPrefetchMock, claudePrefetchMock, mockUtils, isDesktopAppMock } = vi.hoisted(
  () => {
    const aggregatedPrefetchMock = vi.fn(() => Promise.resolve());
    const claudePrefetchMock = vi.fn(() => Promise.resolve());
    // Stable singleton matches real `trpc.useUtils()` semantics — identity must
    // not change between renders, otherwise the prefetch effect would re-run.
    return {
      aggregatedPrefetchMock,
      claudePrefetchMock,
      isDesktopAppMock: vi.fn(() => true),
      mockUtils: {
        mcp: { getAggregatedMcpInfo: { prefetch: aggregatedPrefetchMock } },
        claude: { getAllMcpConfig: { prefetch: claudePrefetchMock } },
      },
    };
  },
);

vi.mock('@/lib/trpc', () => ({
  trpc: {
    useUtils: () => mockUtils,
  },
}));

vi.mock('../lib/utils/platform', () => ({
  isDesktopApp: isDesktopAppMock,
}));

import { useMcpBackgroundPrefetch } from './use-mcp-background-prefetch';

describe('useMcpBackgroundPrefetch', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    aggregatedPrefetchMock.mockClear();
    claudePrefetchMock.mockClear();
    isDesktopAppMock.mockReset();
    isDesktopAppMock.mockReturnValue(true);
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('does not prefetch synchronously on mount', () => {
    renderHook(() => useMcpBackgroundPrefetch());
    expect(aggregatedPrefetchMock).not.toHaveBeenCalled();
    expect(claudePrefetchMock).not.toHaveBeenCalled();
  });

  it('prefetches both MCP queries after the delay', () => {
    renderHook(() => useMcpBackgroundPrefetch());
    vi.advanceTimersByTime(2000);
    expect(aggregatedPrefetchMock).toHaveBeenCalledTimes(1);
    expect(claudePrefetchMock).toHaveBeenCalledTimes(1);
  });

  it('cancels the prefetch when unmounted before the delay elapses', () => {
    const { unmount } = renderHook(() => useMcpBackgroundPrefetch());
    unmount();
    vi.advanceTimersByTime(5000);
    expect(aggregatedPrefetchMock).not.toHaveBeenCalled();
    expect(claudePrefetchMock).not.toHaveBeenCalled();
  });

  // Regression guard: if the effect's deps array were ever changed to
  // something that re-renders unstably, we'd reset the timer on every render
  // and either spam prefetches or never fire one.
  it('does not restart the timer across re-renders with stable utils', () => {
    const { rerender } = renderHook(() => useMcpBackgroundPrefetch());
    vi.advanceTimersByTime(1000);
    rerender();
    rerender();
    rerender();
    vi.advanceTimersByTime(1000);
    expect(aggregatedPrefetchMock).toHaveBeenCalledTimes(1);
    expect(claudePrefetchMock).toHaveBeenCalledTimes(1);
  });

  // If the first prefetch promise rejects (e.g. main process error), the
  // second must still be issued — both calls are fire-and-forget.
  it('still fires the second prefetch when the first one rejects', () => {
    aggregatedPrefetchMock.mockImplementationOnce(() =>
      Promise.reject(new Error('main process unavailable')),
    );
    renderHook(() => useMcpBackgroundPrefetch());
    vi.advanceTimersByTime(2000);
    expect(aggregatedPrefetchMock).toHaveBeenCalledTimes(1);
    expect(claudePrefetchMock).toHaveBeenCalledTimes(1);
  });

  // The prefetch reaches into Electron-only IPC; matches the defensive
  // pattern of sibling hooks in `GlobalEventListeners`.
  it('does not fire prefetch when not running inside the desktop app', () => {
    isDesktopAppMock.mockReturnValue(false);
    renderHook(() => useMcpBackgroundPrefetch());
    vi.advanceTimersByTime(5000);
    expect(aggregatedPrefetchMock).not.toHaveBeenCalled();
    expect(claudePrefetchMock).not.toHaveBeenCalled();
  });
});
