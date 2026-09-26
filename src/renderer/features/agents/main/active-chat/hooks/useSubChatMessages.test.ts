// @vitest-environment happy-dom
import { act, renderHook } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

let queryResult: { messages: unknown[]; hasMore: boolean } = {
  messages: [],
  hasMore: false,
};
let queryEnabled = true;
const queryFn = vi.fn();
const refetchFn = vi.fn();
let mockMessageIds: string[] = ['msg-1', 'msg-2', 'msg-3'];
/** Mirrors tRPC: background refetch can set isFetching without initial isLoading. */
let mockIsLoading = false;
let mockIsFetching = false;
let mockQueryError: unknown = null;
let mockHasQueryData = true;

vi.mock('../../../../../lib/trpc', () => ({
  trpc: {
    chats: {
      getSubChatMessages: {
        useQuery: (
          input: unknown,
          opts?: { enabled?: boolean; refetchOnWindowFocus?: boolean },
        ) => {
          queryEnabled = opts?.enabled ?? true;
          queryFn(input, opts);
          return {
            data: queryEnabled && mockHasQueryData ? queryResult : undefined,
            isLoading: mockIsLoading,
            isFetching: mockIsFetching,
            error: mockQueryError,
            refetch: refetchFn,
          };
        },
      },
    },
  },
  trpcClient: {
    chats: {
      getSubChatMessages: {
        query: vi.fn(),
      },
    },
  },
}));

vi.mock('../../../../../lib/jotai-store', () => ({
  appStore: {
    get: () => mockMessageIds,
  },
}));

vi.mock('jotai', async (importOriginal) => {
  const actual = await importOriginal<typeof import('jotai')>();
  return {
    ...actual,
    useSetAtom: () => vi.fn(),
  };
});

const { trpcClient } = await import('../../../../../lib/trpc');
const { useSubChatMessages, INITIAL_PAGE_SIZE } = await import('./useSubChatMessages');

const mockTrpcQuery = trpcClient.chats.getSubChatMessages.query as ReturnType<typeof vi.fn>;

beforeEach(() => {
  queryResult = { messages: [], hasMore: false };
  mockMessageIds = ['msg-1', 'msg-2', 'msg-3'];
  mockIsLoading = false;
  mockIsFetching = false;
  mockQueryError = null;
  mockHasQueryData = true;
  queryFn.mockClear();
  refetchFn.mockClear();
  mockTrpcQuery.mockReset();
});

describe('useSubChatMessages', () => {
  it('surfaces the initial query error', () => {
    mockHasQueryData = false;
    mockQueryError = new Error('database unavailable');
    const failed = renderHook(() => useSubChatMessages('sub-failed'));

    expect(failed.result.current.error).toEqual(mockQueryError);
  });

  describe('hasMore convergence', () => {
    it('initializes hasMore from the first query response', () => {
      queryResult = { messages: [{ id: 'msg-1' }], hasMore: true };
      const { result } = renderHook(() => useSubChatMessages('sub-1'));
      expect(result.current.hasMore).toBe(true);
    });

    it('updates hasMore to false after loadOlder returns hasMore=false', async () => {
      queryResult = { messages: [{ id: 'msg-1' }], hasMore: true };
      mockTrpcQuery.mockResolvedValueOnce({ messages: [{ id: 'older-1' }], hasMore: false });

      const { result } = renderHook(() => useSubChatMessages('sub-1'));
      expect(result.current.hasMore).toBe(true);

      await act(async () => {
        await result.current.loadOlder();
      });

      expect(result.current.hasMore).toBe(false);
    });

    it('does not call loadOlder when hasMore has converged to false', async () => {
      queryResult = { messages: [{ id: 'msg-1' }], hasMore: true };
      mockTrpcQuery.mockResolvedValueOnce({ messages: [{ id: 'older-1' }], hasMore: false });

      const { result } = renderHook(() => useSubChatMessages('sub-1'));

      await act(async () => {
        await result.current.loadOlder();
      });
      expect(mockTrpcQuery).toHaveBeenCalledTimes(1);
      expect(result.current.hasMore).toBe(false);

      // Second call should be a no-op
      await act(async () => {
        await result.current.loadOlder();
      });
      expect(mockTrpcQuery).toHaveBeenCalledTimes(1);
    });
  });

  describe('subChatId switch', () => {
    it('resets hasMore when subChatId changes', () => {
      queryResult = { messages: [{ id: 'msg-1' }], hasMore: true };
      const { result, rerender } = renderHook(({ id }) => useSubChatMessages(id), {
        initialProps: { id: 'sub-1' as string | null },
      });
      expect(result.current.hasMore).toBe(true);

      queryResult = { messages: [], hasMore: false };
      rerender({ id: 'sub-2' });
      expect(result.current.hasMore).toBe(false);
    });

    it('clears stale pagination gate when switching chats after a move', () => {
      queryResult = { messages: [{ id: 'msg-1' }], hasMore: true };
      const { result, rerender } = renderHook(({ id }) => useSubChatMessages(id), {
        initialProps: { id: 'sub-before-move' as string | null },
      });
      expect(result.current.hasMore).toBe(true);

      // Simulate moved chat/subchat where initial fetch has no older pages
      queryResult = { messages: [{ id: 'moved-1' }], hasMore: false };
      rerender({ id: 'sub-after-move' });

      expect(result.current.hasMore).toBe(false);
    });
  });

  describe('streaming gate', () => {
    it('does not call tRPC when isStreaming is true', async () => {
      queryResult = { messages: [{ id: 'msg-1' }], hasMore: true };

      const { result } = renderHook(() => useSubChatMessages('sub-1', { isStreaming: true }));

      await act(async () => {
        await result.current.loadOlder();
      });
      expect(mockTrpcQuery).not.toHaveBeenCalled();
    });
  });

  describe('in-flight dedupe', () => {
    it('does not fire a second request while one is in flight', async () => {
      queryResult = { messages: [{ id: 'msg-1' }], hasMore: true };

      let resolveFirst!: (v: { messages: unknown[]; hasMore: boolean }) => void;
      mockTrpcQuery.mockReturnValueOnce(
        new Promise((r) => {
          resolveFirst = r;
        }),
      );

      const { result } = renderHook(() => useSubChatMessages('sub-1'));

      // Start first load (will hang until resolved)
      let firstCall!: Promise<void>;
      await act(async () => {
        firstCall = result.current.loadOlder();
      });

      // Second call while first is in-flight should be a no-op
      await act(async () => {
        await result.current.loadOlder();
      });
      expect(mockTrpcQuery).toHaveBeenCalledTimes(1);

      // Resolve the first call
      resolveFirst({ messages: [{ id: 'older-1' }], hasMore: true });
      await firstCall;
    });
  });

  describe('query fetch state (EC1)', () => {
    it('exposes isFetching when refetching while not initial loading', () => {
      queryResult = { messages: [{ id: 'm1' }], hasMore: false };
      mockIsLoading = false;
      mockIsFetching = true;

      const { result, rerender } = renderHook(() => useSubChatMessages('sub-1'));

      expect(result.current.isLoading).toBe(false);
      expect(result.current.isFetching).toBe(true);

      mockIsFetching = false;
      rerender();

      expect(result.current.isFetching).toBe(false);
    });

    it('returns a new memoized result object when isFetching changes', () => {
      queryResult = { messages: [{ id: 'm1' }], hasMore: false };
      mockIsFetching = true;

      const { result, rerender } = renderHook(() => useSubChatMessages('sub-1'));
      const first = result.current;

      mockIsFetching = false;
      rerender();

      expect(result.current).not.toBe(first);
      expect(result.current.messages).toBe(first.messages);
    });
  });

  describe('refetchOnWindowFocus', () => {
    it('passes refetchOnWindowFocus: false to useQuery', () => {
      queryResult = { messages: [], hasMore: false };
      renderHook(() => useSubChatMessages('sub-1'));

      expect(queryFn).toHaveBeenCalledWith(
        expect.objectContaining({ subChatId: 'sub-1' }),
        expect.objectContaining({ refetchOnWindowFocus: false }),
      );
    });
  });

  describe('initial page size (over-fetch guard)', () => {
    it('requests exactly INITIAL_PAGE_SIZE messages on first load', () => {
      queryResult = { messages: [{ id: 'msg-1' }], hasMore: false };
      renderHook(() => useSubChatMessages('sub-1'));

      expect(queryFn).toHaveBeenCalledWith(
        { subChatId: 'sub-1', limit: INITIAL_PAGE_SIZE },
        expect.anything(),
      );
      expect(INITIAL_PAGE_SIZE).toBe(20);
    });

    it('exposes at most INITIAL_PAGE_SIZE messages from the initial query', () => {
      const msgs = Array.from({ length: INITIAL_PAGE_SIZE }, (_, i) => ({ id: `msg-${i}` }));
      queryResult = { messages: msgs, hasMore: true };

      const { result } = renderHook(() => useSubChatMessages('sub-1'));

      expect(result.current.messages).toHaveLength(INITIAL_PAGE_SIZE);
      expect(result.current.hasMore).toBe(true);
    });

    it('does not request without beforeMessageId on initial load (no over-fetch)', () => {
      queryResult = { messages: [{ id: 'msg-1' }], hasMore: false };
      renderHook(() => useSubChatMessages('sub-1'));

      const callArgs = queryFn.mock.calls[0][0] as Record<string, unknown>;
      expect(callArgs).not.toHaveProperty('beforeMessageId');
    });
  });

  describe('plan-part hydration', () => {
    it('keeps tool-frink-plan input payload intact from query results', () => {
      queryResult = {
        messages: [
          {
            id: 'assistant-1',
            role: 'assistant',
            parts: [
              {
                type: 'tool-frink-plan',
                toolCallId: 'frink-plan-1',
                input: {
                  summary: 'Persist plan after refresh',
                  planPath: '/tmp/persist.plan.md',
                  planText: '## Plan\nPersist final parts',
                  status: 'awaiting_approval',
                },
              },
            ],
          },
        ],
        hasMore: false,
      };

      const { result } = renderHook(() => useSubChatMessages('sub-1'));
      const part = (result.current.messages[0] as { parts?: Array<Record<string, unknown>> })
        ?.parts?.[0];

      expect(part).toEqual(
        expect.objectContaining({
          type: 'tool-frink-plan',
          toolCallId: 'frink-plan-1',
          input: expect.objectContaining({
            summary: 'Persist plan after refresh',
            planPath: '/tmp/persist.plan.md',
            planText: '## Plan\nPersist final parts',
            status: 'awaiting_approval',
          }),
        }),
      );
    });

    it('keeps post-approval plan status intact from query results', () => {
      queryResult = {
        messages: [
          {
            id: 'assistant-2',
            role: 'assistant',
            parts: [
              {
                type: 'tool-frink-plan',
                toolCallId: 'frink-plan-2',
                input: {
                  planId: 'plan-2',
                  summary: 'Approved plan should stay approved',
                  planPath: '/tmp/approved.plan.md',
                  status: 'approved',
                },
              },
            ],
          },
        ],
        hasMore: false,
      };

      const { result } = renderHook(() => useSubChatMessages('sub-1'));
      const part = (result.current.messages[0] as { parts?: Array<Record<string, unknown>> })
        ?.parts?.[0];

      expect(part).toEqual(
        expect.objectContaining({
          type: 'tool-frink-plan',
          toolCallId: 'frink-plan-2',
          input: expect.objectContaining({
            planId: 'plan-2',
            status: 'approved',
          }),
        }),
      );
    });
  });

  describe('loadOlder error handling', () => {
    it('sets loadOlderError when trpcClient.query rejects', async () => {
      queryResult = { messages: [{ id: 'msg-1' }], hasMore: true };
      mockTrpcQuery.mockRejectedValueOnce(new Error('Network failure'));

      const { result } = renderHook(() => useSubChatMessages('sub-1'));
      expect(result.current.loadOlderError).toBeNull();

      await act(async () => {
        await result.current.loadOlder();
      });

      expect(result.current.loadOlderError).toBeInstanceOf(Error);
      expect(result.current.loadOlderError?.message).toBe('Network failure');
      expect(result.current.isLoadingOlder).toBe(false);
    });

    it('clears loadOlderError on next successful loadOlder', async () => {
      queryResult = { messages: [{ id: 'msg-1' }], hasMore: true };
      mockTrpcQuery
        .mockRejectedValueOnce(new Error('fail'))
        .mockResolvedValueOnce({ messages: [{ id: 'older-1' }], hasMore: true });

      const { result } = renderHook(() => useSubChatMessages('sub-1'));

      await act(async () => {
        await result.current.loadOlder();
      });
      expect(result.current.loadOlderError).not.toBeNull();

      await act(async () => {
        await result.current.loadOlder();
      });
      expect(result.current.loadOlderError).toBeNull();
    });

    it('wraps non-Error rejection in Error', async () => {
      queryResult = { messages: [{ id: 'msg-1' }], hasMore: true };
      mockTrpcQuery.mockRejectedValueOnce('string error');

      const { result } = renderHook(() => useSubChatMessages('sub-1'));

      await act(async () => {
        await result.current.loadOlder();
      });

      expect(result.current.loadOlderError).toBeInstanceOf(Error);
      expect(result.current.loadOlderError?.message).toBe('string error');
    });
  });

  describe('move-churn and stale-to-fresh transitions', () => {
    it('uses the new subChatId and anchor after switching tabs during move churn', async () => {
      queryResult = { messages: [{ id: 'msg-1' }], hasMore: true };
      mockTrpcQuery.mockResolvedValueOnce({ messages: [{ id: 'older-1' }], hasMore: true });

      const { result, rerender } = renderHook(({ id }) => useSubChatMessages(id), {
        initialProps: { id: 'sub-old' as string | null },
      });

      mockMessageIds = ['new-first-id'];
      queryResult = { messages: [{ id: 'new-msg-1' }], hasMore: true };
      rerender({ id: 'sub-new' });

      await act(async () => {
        await result.current.loadOlder();
      });

      expect(mockTrpcQuery).toHaveBeenCalledWith({
        subChatId: 'sub-new',
        limit: 20,
        beforeMessageId: 'new-first-id',
      });
    });

    it('keeps active tab messages visible after stale->fresh refetch transition', () => {
      queryResult = { messages: [], hasMore: false };
      const { result, rerender } = renderHook(({ id }) => useSubChatMessages(id), {
        initialProps: { id: 'sub-1' as string | null },
      });
      expect(result.current.messages).toHaveLength(0);

      queryResult = { messages: [{ id: 'assistant-after-move' }], hasMore: false };
      rerender({ id: 'sub-1' });

      expect(result.current.messages).toEqual([{ id: 'assistant-after-move' }]);
    });

    it('resets pagination gate after move when server reports no older pages', async () => {
      queryResult = { messages: [{ id: 'msg-1' }], hasMore: true };
      mockTrpcQuery.mockResolvedValueOnce({ messages: [{ id: 'older-1' }], hasMore: false });
      const { result, rerender } = renderHook(({ id }) => useSubChatMessages(id), {
        initialProps: { id: 'sub-before-move' as string | null },
      });

      await act(async () => {
        await result.current.loadOlder();
      });
      expect(result.current.hasMore).toBe(false);

      queryResult = { messages: [{ id: 'moved-msg' }], hasMore: false };
      rerender({ id: 'sub-after-move' });
      await act(async () => {
        await result.current.loadOlder();
      });

      // No new pagination request should be sent because hasMore converged to false for moved chat.
      expect(mockTrpcQuery).toHaveBeenCalledTimes(1);
    });
  });

  describe('null subChatId', () => {
    it('returns empty state when subChatId is null', () => {
      queryResult = { messages: [], hasMore: false };
      const { result } = renderHook(() => useSubChatMessages(null));
      expect(result.current.messages).toEqual([]);
      expect(result.current.hasMore).toBe(false);
      expect(result.current.isLoading).toBe(false);
    });

    it('loadOlder is a no-op when subChatId is null', async () => {
      queryResult = { messages: [], hasMore: false };
      const { result } = renderHook(() => useSubChatMessages(null));

      await act(async () => {
        await result.current.loadOlder();
      });
      expect(mockTrpcQuery).not.toHaveBeenCalled();
    });

    it('loadOlder is a no-op when message ids are temporarily empty', async () => {
      queryResult = { messages: [{ id: 'msg-1' }], hasMore: true };
      mockMessageIds = [];

      const { result } = renderHook(() => useSubChatMessages('sub-1'));

      await act(async () => {
        await result.current.loadOlder();
      });

      // No cursor anchor (beforeMessageId) means no pagination fetch should run
      expect(mockTrpcQuery).not.toHaveBeenCalled();
    });
  });
});
