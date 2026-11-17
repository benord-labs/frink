import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { render } from '@testing-library/react';
import { type Operation, TRPCClientError } from '@trpc/client';
import { observable } from '@trpc/server/observable';
import type { ReactElement, ReactNode } from 'react';
import { trpc } from '@/lib/trpc';

export function newTestQueryClient(): QueryClient {
  return new QueryClient({ defaultOptions: { queries: { retry: false } } });
}

// A real tRPC client answered in-process, so tests exercise real queries without module mocks.
// Test files must set `globalThis.electronTRPC` in `vi.hoisted`: `lib/trpc` wires IPC on import.
/** `answer` resolves one tRPC operation the way the main-process router would. */
export function renderWithTrpc<TResult>(
  ui: ReactElement,
  answer: (op: Operation) => Promise<TResult>,
  queryClient = newTestQueryClient(),
) {
  const client = trpc.createClient({
    links: [
      () =>
        ({ op }) =>
          observable((observer) => {
            answer(op).then(
              (data) => {
                observer.next({ result: { data } });
                observer.complete();
              },
              (err) => observer.error(TRPCClientError.from(err)),
            );
          }),
    ],
  });
  // A wrapper, so `rerender` keeps the providers around the new element.
  return render(ui, {
    wrapper: ({ children }: { children: ReactNode }) => (
      <trpc.Provider client={client} queryClient={queryClient}>
        <QueryClientProvider client={queryClient}>{children}</QueryClientProvider>
      </trpc.Provider>
    ),
  });
}
