// @vitest-environment happy-dom
import { act, renderHook } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { useWorkQueueOverviewPages } from '.';

const { queryPageMock, queryStates, useQueryMock } = vi.hoisted(() => {
  const makeState = () => ({
    data: {
      items: [] as unknown[],
      nextCursor: null as { createdAt: string; id: string } | null,
    },
    isLoading: false,
    refetch: vi.fn(async () => undefined),
  });
  return {
    queryPageMock: vi.fn(),
    queryStates: { attention: makeState(), inbox: makeState(), running: makeState() },
    useQueryMock: vi.fn(),
  };
});

vi.mock('../../../../lib/trpc', () => ({
  trpcClient: { tasks: { listPaginated: { query: queryPageMock } } },
  trpc: {
    tasks: { listPaginated: { useQuery: useQueryMock } },
  },
}));

const row = (id: string) => ({ id });
const cursor = (id: string) => ({ createdAt: '2026-08-13T00:00:00.000Z', id });

describe('useWorkQueueOverviewPages', () => {
  beforeEach(() => {
    useQueryMock.mockReset();
    queryPageMock.mockReset();
    for (const state of Object.values(queryStates)) {
      state.data = { items: [], nextCursor: null };
      state.isLoading = false;
      state.refetch.mockReset();
      state.refetch.mockResolvedValue(undefined);
    }
    useQueryMock.mockImplementation(
      (input: { workQueueSection: keyof typeof queryStates }) =>
        queryStates[input.workQueueSection],
    );
  });

  it('polls three independent server-filtered heads only while Overview is visible', () => {
    renderHook(() => useWorkQueueOverviewPages(true));
    for (const section of ['attention', 'running', 'inbox']) {
      expect(useQueryMock).toHaveBeenCalledWith(
        { workQueueSection: section, limit: 50, cursor: null, collapseByFlow: true },
        { enabled: true, refetchInterval: 5000, structuralSharing: true },
      );
    }

    useQueryMock.mockClear();
    renderHook(() => useWorkQueueOverviewPages(false));
    expect(useQueryMock).toHaveBeenCalledWith(expect.any(Object), {
      enabled: false,
      refetchInterval: false,
      structuralSharing: true,
    });
  });

  it('replaces polled heads and suppresses cross-lane stale duplicates', async () => {
    queryStates.attention.data = { items: [row('attention')], nextCursor: null };
    queryStates.running.data = {
      items: [row('attention'), row('running')],
      nextCursor: null,
    };
    queryStates.inbox.data = { items: [row('running'), row('inbox')], nextCursor: null };
    const { result, rerender } = renderHook(() => useWorkQueueOverviewPages(true));

    expect(result.current.attention.rows).toEqual([row('attention')]);
    expect(result.current.running.rows).toEqual([row('running')]);
    expect(result.current.inbox.rows).toEqual([row('inbox')]);
    queryStates.attention.data = { items: [row('new-attention')], nextCursor: null };
    await act(async () => rerender());
    expect(result.current.attention.rows).toEqual([row('new-attention')]);
  });

  it('loads only the requested lane tail and stops at its final cursor', async () => {
    queryStates.attention.data = { items: [row('attention')], nextCursor: cursor('page-2') };
    queryPageMock.mockResolvedValue({ items: [row('older')], nextCursor: null });
    const { result } = renderHook(() => useWorkQueueOverviewPages(true));

    await act(async () => result.current.attention.loadMore());

    expect(queryPageMock).toHaveBeenCalledOnce();
    expect(queryPageMock).toHaveBeenCalledWith({
      workQueueSection: 'attention',
      limit: 50,
      cursor: cursor('page-2'),
      collapseByFlow: true,
    });
    expect(result.current.attention.rows).toEqual([row('attention'), row('older')]);
    expect(result.current.attention.canLoadMore).toBe(false);
  });

  it('drops loaded tails when polling moves the head boundary', async () => {
    queryStates.running.data = { items: [row('running')], nextCursor: cursor('old-boundary') };
    queryPageMock.mockResolvedValue({ items: [row('older')], nextCursor: null });
    const { result, rerender } = renderHook(() => useWorkQueueOverviewPages(true));
    await act(async () => result.current.running.loadMore());
    expect(result.current.running.rows).toEqual([row('running'), row('older')]);

    queryStates.running.data = { items: [row('new-running')], nextCursor: cursor('new-boundary') };
    await act(async () => rerender());
    expect(result.current.running.rows).toEqual([row('new-running')]);

    queryStates.running.data = { items: [row('returning')], nextCursor: cursor('old-boundary') };
    await act(async () => rerender());
    expect(result.current.running.rows).toEqual([row('returning')]);
  });

  it('refetches all heads after a mutation', async () => {
    const { result } = renderHook(() => useWorkQueueOverviewPages(true));
    await act(async () => result.current.refresh());
    expect(queryStates.attention.refetch).toHaveBeenCalledOnce();
    expect(queryStates.running.refetch).toHaveBeenCalledOnce();
    expect(queryStates.inbox.refetch).toHaveBeenCalledOnce();
  });
});
