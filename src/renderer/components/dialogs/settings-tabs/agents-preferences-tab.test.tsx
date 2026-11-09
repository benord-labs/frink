// @vitest-environment happy-dom

import '@testing-library/jest-dom/vitest';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
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

/** `holdFirstRead` delays the first keep-awake read, which still answers with the value at request time. */
type TestServer = { failSave?: boolean; holdFirstRead?: Promise<void> };

/** A real trpc client answering in-process: the keep-awake pair, and null for the tab's other reads. */
function createTestClient(
  saved: { enabled: boolean },
  { failSave = false, holdFirstRead }: TestServer,
) {
  const save = vi.fn<(enabled: boolean) => void>();
  const heldRead = { answered: false };
  let held = holdFirstRead;
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
            } else if (op.path === 'power.keepAwakeWhileWorking' && held) {
              const stale = { ...saved };
              const answer = held;
              held = undefined;
              void answer.then(() => {
                heldRead.answered = true;
                observer.next({ result: { data: stale } });
                observer.complete();
              });
              return;
            } else {
              const data = op.path === 'power.keepAwakeWhileWorking' ? { ...saved } : null;
              observer.next({ result: { data } });
            }
            observer.complete();
          }),
    ],
  });
  return { client, save, heldRead };
}

function renderTab(saved: { enabled: boolean }, server: TestServer = {}) {
  const { client, save, heldRead } = createTestClient(saved, server);
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
  return {
    save,
    heldRead,
    keepAwake: () => screen.getByRole('switch', { name: /awake while agents are working/ }),
  };
}

function onPlatform(platform: string) {
  Object.defineProperty(window, 'desktopApi', { value: { platform }, configurable: true });
}

afterEach(() => {
  cleanup();
  Reflect.deleteProperty(window, 'desktopApi');
});

describe('AgentsPreferencesTab — keep awake copy', () => {
  it('names the Mac and its lid and low-battery limits on macOS', () => {
    onPlatform('darwin');
    renderTab({ enabled: true });

    expect(
      screen.getByRole('switch', { name: 'Keep this Mac awake while agents are working' }),
    ).toBeInTheDocument();
    expect(screen.getByText(/turns off when the battery is low/)).toBeInTheDocument();
  });

  it.each(['win32', 'linux'])('names the computer with no battery promise on %s', (platform) => {
    onPlatform(platform);
    renderTab({ enabled: true });

    expect(
      screen.getByRole('switch', { name: 'Keep this computer awake while agents are working' }),
    ).toBeInTheDocument();
    expect(screen.getByText(/Stops your computer from going to sleep/)).toBeInTheDocument();
    expect(screen.queryByText(/Mac|battery|lid/)).not.toBeInTheDocument();
  });
});

describe('AgentsPreferencesTab — chat formatting', () => {
  it('offers the reply and your-message switches at their defaults', () => {
    renderTab({ enabled: true });

    expect(screen.getByRole('switch', { name: 'Format replies' })).toBeChecked();
    expect(screen.getByRole('switch', { name: 'Format your messages' })).not.toBeChecked();
  });
});

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
    const { keepAwake } = renderTab({ enabled: true }, { failSave: true });
    await waitFor(() => expect(keepAwake()).toBeChecked());

    fireEvent.click(keepAwake());
    await waitFor(() => expect(error).toHaveBeenCalledWith('Could not save the setting'));
    await waitFor(() => expect(keepAwake()).toBeChecked());
  });

  it('keeps a switch change made while the saved value is still loading', async () => {
    // A read that lands after the optimistic update must not put the old value back.
    let releaseRead = () => {};
    const firstRead = new Promise<void>((resolve) => (releaseRead = resolve));
    const saved = { enabled: true };
    const { save, heldRead, keepAwake } = renderTab(saved, { holdFirstRead: firstRead });

    fireEvent.click(keepAwake());
    await waitFor(() => expect(save).toHaveBeenCalledWith(false));
    releaseRead();
    await waitFor(() => expect(heldRead.answered).toBe(true));
    await act(() => new Promise((resolve) => setTimeout(resolve, 20)));

    expect(saved.enabled).toBe(false);
    expect(keepAwake()).not.toBeChecked();
  });
});
