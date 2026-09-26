// @vitest-environment happy-dom
/**
 * useCanvasFitView — edge case tests for the shared fit-view hook.
 *
 * Mocks @xyflow/react hooks to control paneWidth, nodesInitialized,
 * and fitView; verifies gating conditions, reset triggers, and
 * skipNodesInitialized bypass.
 */

import { cleanup, renderHook } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// ── Controllable mocks ──────────────────────────────────────────────────────

const mockFitView = vi.fn();
let mockPaneWidth = 0;
let mockNodesInitialized = false;

vi.mock('@xyflow/react', () => ({
  useReactFlow: () => ({ fitView: mockFitView }),
  useNodesInitialized: () => mockNodesInitialized,
  useStore: <T,>(selector: (s: { width: number }) => T) => selector({ width: mockPaneWidth }),
}));

import { useCanvasFitView } from './useCanvasFitView';

// ── Helpers ─────────────────────────────────────────────────────────────────

beforeEach(() => {
  mockFitView.mockClear();
  mockPaneWidth = 0;
  mockNodesInitialized = false;
});

afterEach(cleanup);

function flush() {
  // rAF is used inside the hook; flush it synchronously in happy-dom.
  vi.runAllTimers();
}

// ── EC-1: skipNodesInitialized bypasses nodesInitialized check ──────────────

describe('useCanvasFitView — skipNodesInitialized', () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it('EC-1: fires fitView when skipNodesInitialized=true even if nodesInitialized is false', () => {
    mockPaneWidth = 1000;
    mockNodesInitialized = false;

    renderHook(() =>
      useCanvasFitView(5, {
        padding: 0.15,
        resetKey: 'topo-a',
        skipNodesInitialized: true,
      }),
    );

    flush();
    expect(mockFitView).toHaveBeenCalledOnce();
    expect(mockFitView).toHaveBeenCalledWith({ padding: 0.15, duration: 200 });
  });

  it('EC-2: does NOT fire fitView when skipNodesInitialized=false and nodesInitialized is false', () => {
    mockPaneWidth = 1000;
    mockNodesInitialized = false;

    renderHook(() =>
      useCanvasFitView(5, {
        padding: 0.15,
        resetKey: 'topo-a',
        skipNodesInitialized: false,
      }),
    );

    flush();
    expect(mockFitView).not.toHaveBeenCalled();
  });
});

// ── EC-3 / EC-4: isVisible gating + hidden→visible reset ───────────────────

describe('useCanvasFitView — visibility gating', () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it('EC-3: does NOT fire fitView when isVisible=false', () => {
    mockPaneWidth = 1000;
    mockNodesInitialized = true;

    renderHook(() =>
      useCanvasFitView(5, {
        padding: 0.15,
        resetKey: 'topo-a',
        isVisible: false,
      }),
    );

    flush();
    expect(mockFitView).not.toHaveBeenCalled();
  });

  it('EC-4: fires fitView after isVisible transitions false → true', () => {
    mockPaneWidth = 1000;
    mockNodesInitialized = true;

    const { rerender } = renderHook(
      ({ isVisible }) =>
        useCanvasFitView(5, {
          padding: 0.15,
          resetKey: 'topo-a',
          isVisible,
        }),
      { initialProps: { isVisible: false } },
    );

    flush();
    expect(mockFitView).not.toHaveBeenCalled();

    rerender({ isVisible: true });
    flush();
    expect(mockFitView).toHaveBeenCalledOnce();
  });
});

// ── EC-5 / EC-6: resetKey and double-fire guard ─────────────────────────────

describe('useCanvasFitView — reset and dedup', () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it('EC-5: changing resetKey fires fitView again after it already fired once', () => {
    mockPaneWidth = 1000;
    mockNodesInitialized = true;

    const { rerender } = renderHook(
      ({ resetKey }) => useCanvasFitView(5, { padding: 0.15, resetKey }),
      { initialProps: { resetKey: 'topo-a' } },
    );

    flush();
    expect(mockFitView).toHaveBeenCalledOnce();

    rerender({ resetKey: 'topo-b' });
    flush();
    expect(mockFitView).toHaveBeenCalledTimes(2);
  });

  it('EC-6: does NOT double-fire fitView when deps re-run with same resetKey', () => {
    mockPaneWidth = 1000;
    mockNodesInitialized = true;

    const { rerender } = renderHook(
      ({ nodeCount }) => useCanvasFitView(nodeCount, { padding: 0.15, resetKey: 'topo-a' }),
      { initialProps: { nodeCount: 5 } },
    );

    flush();
    expect(mockFitView).toHaveBeenCalledOnce();

    // Rerender with different nodeCount but same resetKey — should NOT refit.
    rerender({ nodeCount: 6 });
    flush();
    expect(mockFitView).toHaveBeenCalledOnce();
  });
});

// ── EC-7: paneWidth=0 guard ─────────────────────────────────────────────────

describe('useCanvasFitView — paneWidth guard', () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it('EC-7: does NOT fire fitView when paneWidth is 0', () => {
    mockPaneWidth = 0;
    mockNodesInitialized = true;

    renderHook(() => useCanvasFitView(5, { padding: 0.15, resetKey: 'topo-a' }));

    flush();
    expect(mockFitView).not.toHaveBeenCalled();
  });
});
