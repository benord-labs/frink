// @vitest-environment happy-dom

import '@testing-library/jest-dom/vitest';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { TRPCClientError } from '@trpc/client';
import { observable } from '@trpc/server/observable';
import { toast } from 'sonner';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { z } from 'zod';
import { trpc } from '../../../lib/trpc';
import { AgentsPreferencesTab } from './agents-preferences-tab';

// `lib/trpc` wires its ipc client at import time, so the preload bridge must exist first.
vi.hoisted(() => {
  Object.assign(globalThis, {
    electronTRPC: { onMessage: () => () => undefined, sendMessage: () => undefined },
  });
});

const KEEP_AWAKE_INPUT = z.object({ enabled: z.boolean() });

/** A real trpc client answering in-process: the keep-awake pair, and null for the tab's other reads. */
function createTestClient(saved: { enabled: boolean }, failSave = false) {
  const save = vi.fn<(enabled: boolean) => void>();
  const client = trpc.createClient({
    links: [
      () =>
        ({ op }) =>
          observable((observer) => {
            if (op.path === 'power.setKeepAwakeWhileWorking') {
              const { enabled } = KEEP_AWAKE_INPUT.parse(op.input);
              save(enabled);
              if (failSave) {
                observer.error(TRPCClientError.from(new Error('Could not save the setting')));
                return;
              }
              saved.enabled = enabled;
              observer.next({ result: { data: { enabled } } });
            } else {
              const data = op.path === 'power.keepAwakeWhileWorking' ? { ...saved } : null;
              observer.next({ result: { data } });
            }
            observer.complete();
          }),
    ],
  });
  return { client, save };
}

function renderTab(saved: { enabled: boolean }, failSave = false) {
  const { client, save } = createTestClient(saved, failSave);
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  });
  render(
    <trpc.Provider client={client} queryClient={queryClient}>
      <QueryClientProvider client={queryClient}>
        <AgentsPreferencesTab />
      </QueryClientProvider>
    </trpc.Provider>,
  );
  return { save, keepAwake: () => screen.getByRole('switch', { name: /Keep this Mac awake/ }) };
}

afterEach(cleanup);

describe('AgentsPreferencesTab — keep awake', () => {
  it('shows the saved value and saves a switch-off', async () => {
    const { save, keepAwake } = renderTab({ enabled: true });
    await waitFor(() => expect(keepAwake()).toBeChecked());

    fireEvent.click(keepAwake());
    await waitFor(() => expect(save).toHaveBeenCalledWith(false));
    expect(keepAwake()).not.toBeChecked();
  });

  it('puts the saved value back and says so when saving fails', async () => {
    const error = vi.spyOn(toast, 'error').mockImplementation(() => 0);
    const { keepAwake } = renderTab({ enabled: true }, true);
    await waitFor(() => expect(keepAwake()).toBeChecked());

    fireEvent.click(keepAwake());
    await waitFor(() => expect(error).toHaveBeenCalledWith('Could not save the setting'));
    await waitFor(() => expect(keepAwake()).toBeChecked());
  });
});
