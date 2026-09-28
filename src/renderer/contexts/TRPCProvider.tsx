import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { useState } from 'react';
import { perfMark } from '../lib/perf/marks';
import { trpc, trpcClient } from '../lib/trpc';
import { shareEqualDeep } from '../lib/query-keys/structural-sharing';

type TRPCProviderProps = {
  children: React.ReactNode;
};

// Global query client instance for use outside React components
let globalQueryClient: QueryClient | null = null;

export function getQueryClient(): QueryClient | null {
  return globalQueryClient;
}

export function TRPCProvider({ children }: TRPCProviderProps) {
  const [queryClient] = useState(() => {
    const client = new QueryClient({
      defaultOptions: {
        queries: {
          staleTime: 5000,
          refetchOnWindowFocus: false,
          networkMode: 'always',
          retry: false,
          // Date-aware, so an identical Date-bearing refetch keeps its reference (sc-2721).
          structuralSharing: shareEqualDeep,
        },
        mutations: {
          networkMode: 'always',
          retry: false,
        },
      },
    });
    if (import.meta.env.DEV) {
      client.getQueryCache().subscribe((event) => {
        if (event.type !== 'updated') return;
        if (event.action.type !== 'success' && event.action.type !== 'invalidate') return;
        const [path] = event.query.queryKey;
        perfMark(`query:${Array.isArray(path) ? path.join('.') : String(path)}`, {
          action: event.action.type,
          key: JSON.stringify(event.query.queryKey).slice(0, 160),
        });
      });
    }
    globalQueryClient = client;
    if (window.__FRINK_QA__) window.__frinkQaQueryClient = client;
    return client;
  });

  // Share the vanilla `trpcClient` with the React Provider so imperative callers
  // (`trpcClient.socket.sendStop.mutate(...)` etc.) and React hook queries use the
  // SAME ipcLink instance. Two separate clients each register their own
  // `electronTRPC.onMessage` listener and each maintain an independent request-id
  // counter starting at 1 — concurrent responses match by id on both listeners
  // and cross-pollinate the caches (e.g. a mutation returning `{success:true}`
  // poisons a query cache entry sharing the same id).
  return (
    <trpc.Provider client={trpcClient} queryClient={queryClient}>
      <QueryClientProvider client={queryClient}>{children}</QueryClientProvider>
    </trpc.Provider>
  );
}
