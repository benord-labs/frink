// @vitest-environment happy-dom

import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { act, renderHook, waitFor } from '@testing-library/react';
import { observable } from '@trpc/server/observable';
import type { ReactNode } from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { AGENT_DEFAULT_MODEL_ID } from '../../../shared/lib/models';
import { trpc } from '../trpc';
import { useProviderModels } from './use-provider-models';

// `lib/trpc` wires its ipc client at import time, so the preload bridge must exist first.
vi.hoisted(() => {
  Object.assign(globalThis, {
    electronTRPC: { onMessage: () => () => undefined, sendMessage: () => undefined },
  });
});

const GPT_5 = { id: 'gpt-5', name: 'GPT-5' };

/** A real trpc client that answers the agent model query with `listed`, read on every call. */
function createTestClient(listed: { current: { id: string; name: string }[] }) {
  return trpc.createClient({
    links: [
      () =>
        ({ op }) =>
          observable((observer) => {
            if (op.path !== 'agentAccounts.models') throw new Error(`Unexpected: ${op.path}`);
            observer.next({ result: { data: listed.current } });
            observer.complete();
          }),
    ],
  });
}

function renderModels(providerId: string, modelId: string, listed = { current: [GPT_5] }) {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const wrapper = ({ children }: { children: ReactNode }) => (
    <trpc.Provider client={createTestClient(listed)} queryClient={queryClient}>
      <QueryClientProvider client={queryClient}>{children}</QueryClientProvider>
    </trpc.Provider>
  );
  return renderHook(() => useProviderModels(providerId, modelId), { wrapper });
}

/** The preload bridge's turn-end events, which a test fires by hand. */
function fakeTurnEvents() {
  const stop = vi.fn();
  const events = {
    onSocketExecuteComplete: vi.fn((_listener: () => void) => stop),
    onSocketError: vi.fn((_listener: () => void) => stop),
  };
  Object.assign(window, { desktopApi: events });
  const fire = (name: keyof typeof events) => act(() => events[name].mock.calls[0][0]());
  return { events, fire, stop };
}

afterEach(() => {
  Object.assign(window, { desktopApi: undefined });
});

describe('useProviderModels', () => {
  it('asks GitHub Copilot for its own models and lists them in the picker', async () => {
    const { result } = renderModels('copilot', 'gpt-5');

    await waitFor(() => expect(result.current.selected.name).toBe('GPT-5'));
    expect(result.current.hint).toBeUndefined();
  });

  it("shows the agent's newly stored list after a turn completes or fails", async () => {
    const { fire, stop } = fakeTurnEvents();
    const listed = { current: [GPT_5] };
    const { result, unmount } = renderModels('copilot', 'gpt-5', listed);
    await waitFor(() => expect(result.current.items).toEqual([GPT_5]));

    listed.current = [GPT_5, { id: 'gpt-6', name: 'GPT-6' }];
    fire('onSocketExecuteComplete');
    await waitFor(() => expect(result.current.items).toHaveLength(2));

    listed.current = [{ id: 'gpt-6', name: 'GPT-6' }];
    fire('onSocketError');
    await waitFor(() =>
      expect(result.current.items.map((m) => m.id)).toEqual([AGENT_DEFAULT_MODEL_ID, 'gpt-6']),
    );

    unmount();
    expect(stop).toHaveBeenCalledTimes(2);
  });

  it('does not listen for turns on a Claude chat', () => {
    const { events } = fakeTurnEvents();
    renderModels('claude-code', 'opus');

    expect(events.onSocketExecuteComplete).not.toHaveBeenCalled();
    expect(events.onSocketError).not.toHaveBeenCalled();
  });
});
