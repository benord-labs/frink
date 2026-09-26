// @vitest-environment happy-dom
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { act, renderHook, waitFor } from '@testing-library/react';
import type { ReactNode } from 'react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { useFlowBaseSnapshot } from '.';

type FlowResult = {
  id: string;
  name: string;
  graph: { nodes: unknown[]; edges: unknown[] };
  version_number: number;
};

type Deferred<T> = {
  promise: Promise<T>;
  resolve: (value: T) => void;
};

function deferred<T>(): Deferred<T> {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((next) => {
    resolve = next;
  });
  return { promise, resolve };
}

const state = vi.hoisted(() => ({
  query: vi.fn(),
}));

vi.mock('@trpc/react-query', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@trpc/react-query')>()),
  getQueryKey: vi.fn((_procedure, input: { id: string }) => ['flows', 'get', input.id]),
}));

vi.mock('../../lib/trpc', () => ({
  trpc: { flows: { get: {} } },
  trpcClient: { flows: { get: { query: state.query } } },
}));

describe('useFlowBaseSnapshot', () => {
  let queryClient: QueryClient;

  beforeEach(() => {
    vi.clearAllMocks();
    queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    vi.spyOn(queryClient, 'fetchQuery');
  });

  function wrapper({ children }: { children: ReactNode }) {
    return <QueryClientProvider client={queryClient}>{children}</QueryClientProvider>;
  }

  it('uses the shared query cache and clears Flow A while Flow B loads', async () => {
    const flowA = deferred<FlowResult>();
    const flowB = deferred<FlowResult>();
    state.query.mockImplementation(({ id }: { id: string }) =>
      id === 'flow-a' ? flowA.promise : flowB.promise,
    );
    const { result, rerender } = renderHook(({ flowId }) => useFlowBaseSnapshot(flowId, true), {
      initialProps: { flowId: 'flow-a' },
      wrapper,
    });
    await waitFor(() => expect(queryClient.fetchQuery).toHaveBeenCalledOnce());
    await act(async () => {
      flowA.resolve({
        id: 'flow-a',
        name: 'Flow A',
        graph: { nodes: [], edges: [] },
        version_number: 1,
      });
      await flowA.promise;
    });
    await waitFor(() => expect(result.current?.id).toBe('flow-a'));

    rerender({ flowId: 'flow-b' });
    await waitFor(() => expect(queryClient.fetchQuery).toHaveBeenCalledTimes(2));
    expect(result.current).toBeUndefined();

    await act(async () => {
      flowB.resolve({
        id: 'flow-b',
        name: 'Flow B',
        graph: { nodes: [], edges: [] },
        version_number: 2,
      });
      await flowB.promise;
    });
    await waitFor(() => expect(result.current?.id).toBe('flow-b'));

    expect(queryClient.fetchQuery).toHaveBeenCalledTimes(2);
    expect(vi.mocked(queryClient.fetchQuery).mock.calls[1]?.[0]).toEqual(
      expect.objectContaining({ queryKey: ['flows', 'get', 'flow-b'], staleTime: 30_000 }),
    );
  });

  it('retains the matching snapshot after terminal output disables the fetch', async () => {
    state.query.mockResolvedValue({
      id: 'flow-a',
      name: 'Flow A',
      graph: { nodes: [], edges: [] },
      version_number: 3,
    });
    const { result, rerender } = renderHook(
      ({ enabled }) => useFlowBaseSnapshot('flow-a', enabled),
      { initialProps: { enabled: true }, wrapper },
    );
    await waitFor(() => expect(result.current?.id).toBe('flow-a'));

    rerender({ enabled: false });

    expect(result.current).toEqual(
      expect.objectContaining({ id: 'flow-a', name: 'Flow A', versionNumber: 3 }),
    );
    expect(queryClient.fetchQuery).toHaveBeenCalledOnce();
  });
});
