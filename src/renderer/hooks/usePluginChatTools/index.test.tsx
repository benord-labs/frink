// @vitest-environment happy-dom
import { getQueryKey } from '@trpc/react-query';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { act, cleanup, renderHook, waitFor } from '@testing-library/react';
import { observable } from '@trpc/server/observable';
import { type PropsWithChildren } from 'react';
import { toast } from 'sonner';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { trpc } from '../../lib/trpc';
import { usePluginChatTools } from './index';

// The real tRPC module creates its desktop client at import time.
vi.hoisted(() => {
  Object.assign(globalThis, {
    electronTRPC: { onMessage: () => () => undefined, sendMessage: () => undefined },
  });
});

type TestResponse =
  | Record<string, { ok: boolean; error?: string; at: number }>
  | { connected: []; awaitingAuth: [] }
  | null;

/** Real mutation hooks over a controlled transport: cancellation and the original request settle independently. */
function renderConsent() {
  const pending: ((ok: boolean) => void)[] = [];
  const cancelled: unknown[] = [];
  const requested: unknown[] = [];
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  });
  const client = trpc.createClient({
    links: [
      () =>
        ({ op }) =>
          observable((observer) => {
            const finish = (data: TestResponse) => {
              observer.next({ result: { data } });
              observer.complete();
            };
            if (op.path === 'plugins.vendorMcpStatus') {
              finish({ connected: [], awaitingAuth: [] });
            } else if (op.path === 'plugins.connectVendorMcp') {
              requested.push(op.input);
              pending.push((ok) =>
                finish({
                  plugin_context7_context7: {
                    ok,
                    error: ok ? undefined : 'Sign-in failed.',
                    at: 1,
                  },
                }),
              );
            } else if (op.path === 'plugins.connectAttemptEnded') {
              cancelled.push(op.input);
              finish(null);
            } else {
              throw new Error(`Unexpected test operation: ${op.path}`);
            }
          }),
    ],
  });
  const wrapper = ({ children }: PropsWithChildren) => (
    <trpc.Provider client={client} queryClient={queryClient}>
      <QueryClientProvider client={queryClient}>{children}</QueryClientProvider>
    </trpc.Provider>
  );
  return {
    queryClient,
    ...renderHook(() => usePluginChatTools('context7'), { wrapper }),
    pending,
    cancelled,
    requested,
  };
}

afterEach(cleanup);

describe('chat OAuth cancellation', () => {
  it('sends explicit reconnect through the existing mutation and keeps normal enable unchanged', async () => {
    const { result, pending, requested } = renderConsent();
    act(() => result.current.enable({ reconnect: true }));
    await waitFor(() => expect(requested).toEqual([{ pluginName: 'context7', reconnect: true }]));
    act(() => pending[0]!(true));
    await waitFor(() => expect(result.current.isEnabling).toBe(false));
    act(() => result.current.enable());
    await waitFor(() => expect(requested[1]).toEqual({ pluginName: 'context7' }));
    act(() => pending[1]!(true));
  });
  it('ends the main-process attempt and stays closed when its cancelled request settles', async () => {
    const { result, pending, cancelled } = renderConsent();
    const toastCount = toast.getHistory().length;
    act(() => result.current.enable());
    await waitFor(() => expect(result.current.consent.open).toBe(true));
    act(() => result.current.dismiss());
    await waitFor(() => expect(cancelled).toEqual([{ pluginId: 'context7' }]));
    expect(result.current.consent.open).toBe(false);
    // Retry cannot join the old request while cancellation is still settling.
    act(() => result.current.enable());
    expect(pending).toHaveLength(1);
    act(() => pending[0]!(false));
    await waitFor(() => expect(result.current.isEnabling).toBe(false));
    expect(result.current.consent.open).toBe(false);
    expect(toast.getHistory()).toHaveLength(toastCount);

    act(() => result.current.enable());
    await waitFor(() => expect(pending).toHaveLength(2));
    act(() => pending[1]!(false));
    await waitFor(() => expect(result.current.consent.error).toBe('Sign-in failed.'));
    expect(result.current.consent.open).toBe(true);
  });

  it('closing a settled error only dismisses it and does not tear down credentials', async () => {
    const { result, pending, cancelled } = renderConsent();
    act(() => result.current.enable());
    await waitFor(() => expect(pending).toHaveLength(1));
    act(() => pending[0]!(false));
    await waitFor(() => expect(result.current.consent.error).toBe('Sign-in failed.'));
    act(() => result.current.dismiss());
    expect(result.current.consent.open).toBe(false);
    expect(cancelled).toEqual([]);
  });
});

it('invalidates trigger setup after OAuth changes the connected credential', async () => {
  const { result, pending, queryClient } = renderConsent();
  const key = getQueryKey(
    trpc.triggerSetup.options,
    { integrationId: 'account', webhookId: 'endpoint' },
    'query',
  );
  queryClient.setQueryData(key, { options: [], selection: 'many' });
  act(() => result.current.enable());
  await waitFor(() => expect(pending).toHaveLength(1));
  act(() => pending[0]!(true));
  await waitFor(() => expect(queryClient.getQueryState(key)?.isInvalidated).toBe(true));
});
