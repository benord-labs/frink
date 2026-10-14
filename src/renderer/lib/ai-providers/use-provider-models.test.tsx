// @vitest-environment happy-dom

import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { renderHook, waitFor } from '@testing-library/react';
import { observable } from '@trpc/server/observable';
import type { ReactNode } from 'react';
import { describe, expect, it, vi } from 'vitest';
import { trpc } from '../trpc';
import { useProviderModels } from './use-provider-models';

// `lib/trpc` wires its ipc client at import time, so the preload bridge must exist first.
vi.hoisted(() => {
  Object.assign(globalThis, {
    electronTRPC: { onMessage: () => () => undefined, sendMessage: () => undefined },
  });
});

/** A real trpc client that answers the agent model query with one model. */
function createTestClient() {
  return trpc.createClient({
    links: [
      () =>
        ({ op }) =>
          observable((observer) => {
            if (op.path !== 'agentAccounts.models') throw new Error(`Unexpected: ${op.path}`);
            observer.next({ result: { data: [{ id: 'gpt-5', name: 'GPT-5' }] } });
            observer.complete();
          }),
    ],
  });
}

describe('useProviderModels', () => {
  it('asks GitHub Copilot for its own models and lists them in the picker', async () => {
    const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    const wrapper = ({ children }: { children: ReactNode }) => (
      <trpc.Provider client={createTestClient()} queryClient={queryClient}>
        <QueryClientProvider client={queryClient}>{children}</QueryClientProvider>
      </trpc.Provider>
    );
    const { result } = renderHook(() => useProviderModels('copilot', 'gpt-5'), { wrapper });

    await waitFor(() => expect(result.current.selected.name).toBe('GPT-5'));
    expect(result.current.hint).toBeUndefined();
  });
});
