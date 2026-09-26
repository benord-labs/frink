// @vitest-environment happy-dom

import '@testing-library/jest-dom/vitest';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { getQueryKey } from '@trpc/react-query';
import { observable } from '@trpc/server/observable';
import { toast } from 'sonner';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { z } from 'zod';
import { trpc } from '../../../../lib/trpc';
import { PluginTokenDialog } from './index';

// `lib/trpc` wires its ipc client at import time, so the preload bridge must exist first.
vi.hoisted(() => {
  Object.assign(globalThis, {
    electronTRPC: { onMessage: () => () => undefined, sendMessage: () => undefined },
  });
});

const TOKEN_INPUT = z.object({ pluginId: z.string(), token: z.string() });
const connectUserToken = vi.fn<(input: z.infer<typeof TOKEN_INPUT>) => void>();

/** A real trpc client whose one procedure, the token grant, is answered in-process. */
function createTestClient() {
  return trpc.createClient({
    links: [
      () =>
        ({ op }) =>
          observable((observer) => {
            if (op.path !== 'plugins.connectUserToken') {
              throw new Error(`Unexpected test operation: ${op.path}`);
            }
            connectUserToken(TOKEN_INPUT.parse(op.input));
            observer.next({ result: { data: null } });
            observer.complete();
          }),
    ],
  });
}

const auth = {
  kind: 'user_token' as const,
  setupUrl: 'https://github.com/settings/tokens',
  validation: { url: 'https://api.github.com/user' },
};

function renderDialog(onConnected?: () => void) {
  const onOpenChange = vi.fn<(open: boolean) => void>();
  const queryClient = new QueryClient({ defaultOptions: { mutations: { retry: false } } });
  const invalidateQueries = vi.spyOn(queryClient, 'invalidateQueries');
  render(
    <trpc.Provider client={createTestClient()} queryClient={queryClient}>
      <QueryClientProvider client={queryClient}>
        <PluginTokenDialog
          pluginId="github"
          name="GitHub"
          auth={auth}
          open
          onOpenChange={onOpenChange}
          onConnected={onConnected}
        />
      </QueryClientProvider>
    </trpc.Provider>,
  );
  return { onOpenChange, invalidateQueries };
}

/** Pastes a token and submits; resolves once the mutation has settled (the invalidate is its last step). */
async function pasteAndConnect(
  token: string,
  invalidateQueries: ReturnType<typeof renderDialog>['invalidateQueries'],
) {
  fireEvent.change(screen.getByLabelText('Token'), { target: { value: token } });
  fireEvent.click(screen.getByRole('button', { name: 'Connect' }));
  await waitFor(() => expect(invalidateQueries).toHaveBeenCalledOnce());
}

describe('PluginTokenDialog', () => {
  beforeEach(() => {
    connectUserToken.mockReset();
  });

  afterEach(cleanup);

  it('hands a saved token straight on to the account leg, saying what comes next', async () => {
    const onConnected = vi.fn();
    const { onOpenChange, invalidateQueries } = renderDialog(onConnected);

    await pasteAndConnect('ghp_token', invalidateQueries);

    expect(connectUserToken).toHaveBeenCalledExactlyOnceWith({
      pluginId: 'github',
      token: 'ghp_token',
    });
    expect(onOpenChange).toHaveBeenCalledWith(false);
    expect(toast.getHistory()).toContainEqual(
      expect.objectContaining({
        type: 'success',
        title: 'Token saved. Next, sign in to GitHub in your browser so GitHub can notify Frink.',
      }),
    );
    expect(onConnected).toHaveBeenCalledOnce();
    // The page's badge reads vendorMcpStatus, so the saved token must reach it.
    expect(invalidateQueries.mock.calls[0]?.[0]?.queryKey).toEqual(
      getQueryKey(trpc.plugins.vendorMcpStatus),
    );
  });

  it('closes quietly when the token is the whole connect', async () => {
    const toastsBefore = toast.getHistory().length;
    const { onOpenChange, invalidateQueries } = renderDialog();

    await pasteAndConnect('tok', invalidateQueries);

    expect(onOpenChange).toHaveBeenCalledWith(false);
    expect(toast.getHistory()).toHaveLength(toastsBefore);
  });
});
