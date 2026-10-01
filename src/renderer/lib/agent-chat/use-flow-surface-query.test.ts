// @vitest-environment happy-dom
import { renderHook } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// vi.mock is hoisted above the module body, so the mock's captures must be too.
const h = vi.hoisted(() => ({
  captureException: vi.fn(),
  queryResult: {} as { data?: unknown; error?: unknown; refetch?: () => void },
  lastQueryArgs: [] as unknown[],
}));

vi.mock('@sentry/electron/renderer', () => ({ captureException: h.captureException }));
vi.mock('@/lib/trpc', () => ({
  trpc: {
    tasks: {
      getDrivingTaskForSubChat: {
        useQuery: (...args: unknown[]) => {
          h.lastQueryArgs = args;
          return h.queryResult;
        },
      },
    },
  },
}));

import { useFlowSurfaceQuery } from './use-flow-surface-query';

describe('useFlowSurfaceQuery', () => {
  beforeEach(() => {
    h.captureException.mockReset();
    h.queryResult = {};
    h.lastQueryArgs = [];
  });
  afterEach(() => vi.clearAllMocks());

  it('captures a failed read — the surface has no state to derive from and silently un-flows', () => {
    // react-query swallows the error and refetchOnWindowFocus is off, so without this the chat drops
    // to the free composer mid-run with nothing reported anywhere.
    const error = new Error('driving task read failed');
    h.queryResult = { error };

    renderHook(() => useFlowSurfaceQuery('sub-1', 'pinned-1'));

    expect(h.captureException).toHaveBeenCalledWith(
      error,
      expect.objectContaining({
        tags: { source: 'useFlowSurfaceQuery', area: 'flow-run-chat-surface' },
        extra: { subChatId: 'sub-1', fallbackTaskId: 'pinned-1' },
      }),
    );
  });

  it('does not capture on a healthy read', () => {
    h.queryResult = { data: { run: { id: 'run-1', batchId: null }, task: null } };

    renderHook(() => useFlowSurfaceQuery('sub-1', null));

    expect(h.captureException).not.toHaveBeenCalled();
  });

  it('reports a sustained outage ONCE, not once per poll tick', () => {
    // The real shape: react-query mints a FRESH Error object on every failed fetch, so each 3.5s
    // tick hands the effect a new identity. Deduping on identity (or asserting against one reused
    // error object) would look fine here and flood Sentry in production.
    const { rerender } = renderHook(() => useFlowSurfaceQuery('sub-1', null));
    for (let tick = 0; tick < 4; tick++) {
      h.queryResult = { error: new Error('driving task read failed') };
      rerender();
    }

    expect(h.captureException).toHaveBeenCalledTimes(1);
  });

  it('reports a DIFFERENT failure after the first', () => {
    const { rerender } = renderHook(() => useFlowSurfaceQuery('sub-1', null));
    h.queryResult = { error: new Error('database is locked') };
    rerender();
    h.queryResult = { error: new Error('IPC channel closed') };
    rerender();

    expect(h.captureException).toHaveBeenCalledTimes(2);
  });

  it('re-arms after a recovery — a later failure is news again', () => {
    const { rerender } = renderHook(() => useFlowSurfaceQuery('sub-1', null));
    h.queryResult = { error: new Error('transient') };
    rerender();
    h.queryResult = { data: { run: null, task: null } };
    rerender();
    h.queryResult = { error: new Error('transient') };
    rerender();

    expect(h.captureException).toHaveBeenCalledTimes(2);
  });

  it('passes the sub-chat and pinned fallback through, and gates on subChatId', () => {
    renderHook(() => useFlowSurfaceQuery('', 'pinned-1'));

    // A swap of these two would still render but resolve the wrong task.
    expect(h.lastQueryArgs[0]).toEqual({ subChatId: '', fallbackTaskId: 'pinned-1' });
    expect((h.lastQueryArgs[1] as { enabled: boolean }).enabled).toBe(false);
  });

  // A resume runs in the main process, so the poll interval alone makes the strip take up to a full
  // tick to return — a stale composer while the agent is already streaming. The engine announces
  // every in-place resume, so the surface refetches on that rather than waiting.
  describe('refetch on the engine’s resume announcement', () => {
    let listener: ((e: { eventType: string; flowRunId?: string }) => void) | undefined;
    const unsubscribe = vi.fn();

    beforeEach(() => {
      listener = undefined;
      unsubscribe.mockReset();
      (window as unknown as { desktopApi?: unknown }).desktopApi = {
        onSocketFlowExecutionEvent: (
          cb: (e: { eventType: string; flowRunId?: string }) => void,
        ) => {
          listener = cb;
          return unsubscribe;
        },
      };
    });
    afterEach(() => {
      (window as unknown as { desktopApi?: unknown }).desktopApi = undefined;
    });

    it('refetches on run_started from any run, since this sub-chat may not know its run yet', () => {
      const refetch = vi.fn();
      h.queryResult = { refetch };
      renderHook(() => useFlowSurfaceQuery('sub-1', null));

      listener?.({ eventType: 'run_started', flowRunId: 'run-other' });
      expect(refetch).toHaveBeenCalledTimes(1);
    });

    it('refetches on node_started only for its own run', () => {
      const refetch = vi.fn();
      h.queryResult = { refetch, data: { run: { id: 'run-1' } } };
      renderHook(() => useFlowSurfaceQuery('sub-1', null));

      listener?.({ eventType: 'node_started', flowRunId: 'run-other' });
      expect(refetch).not.toHaveBeenCalled();
      listener?.({ eventType: 'node_started', flowRunId: 'run-1' });
      expect(refetch).toHaveBeenCalledTimes(1);
    });

    // The query is disabled without a sub-chat, but the listener is a separate subscription — left
    // ungated it would refetch a disabled query and issue a read for `subChatId: ''`.
    it('does not listen at all while the query is disabled', () => {
      const refetch = vi.fn();
      h.queryResult = { refetch };
      renderHook(() => useFlowSurfaceQuery('', null));

      listener?.({ eventType: 'run_started' });
      expect(refetch).not.toHaveBeenCalled();
    });

    it('ignores unrelated events, and unsubscribes on unmount', () => {
      const refetch = vi.fn();
      h.queryResult = { refetch };
      const { unmount } = renderHook(() => useFlowSurfaceQuery('sub-1', null));

      listener?.({ eventType: 'run_completed' });
      expect(refetch).not.toHaveBeenCalled();

      unmount();
      expect(unsubscribe).toHaveBeenCalled();
    });
  });

  // The readout's MODE changes within a node (an auto-approved plan node flips to agent when its
  // plan card lands) and that flip rides its own channel, so the run/node listener above never sees
  // it. Same reasoning, second subscription: announcement first, interval as the safety net.
  describe('refetch on a sub-chat mode change', () => {
    let listener: ((e: { subChatId: string }) => void) | undefined;
    const unsubscribe = vi.fn();

    beforeEach(() => {
      listener = undefined;
      unsubscribe.mockReset();
      (window as unknown as { desktopApi?: unknown }).desktopApi = {
        onSubChatModeChanged: (cb: (e: { subChatId: string }) => void) => {
          listener = cb;
          return unsubscribe;
        },
      };
    });
    afterEach(() => {
      (window as unknown as { desktopApi?: unknown }).desktopApi = undefined;
    });

    it('refetches when THIS sub-chat changes mode', () => {
      const refetch = vi.fn();
      h.queryResult = { refetch };
      renderHook(() => useFlowSurfaceQuery('sub-1', null));

      listener?.({ subChatId: 'sub-1' });
      expect(refetch).toHaveBeenCalledTimes(1);
    });

    // The channel is chat-wide, so a sibling tab's flip must not refetch this surface.
    it('ignores another sub-chat’s mode change, and unsubscribes on unmount', () => {
      const refetch = vi.fn();
      h.queryResult = { refetch };
      const { unmount } = renderHook(() => useFlowSurfaceQuery('sub-1', null));

      listener?.({ subChatId: 'sub-2' });
      expect(refetch).not.toHaveBeenCalled();

      unmount();
      expect(unsubscribe).toHaveBeenCalled();
    });
  });
});
