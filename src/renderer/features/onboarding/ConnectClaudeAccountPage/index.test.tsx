// @vitest-environment happy-dom

import '@testing-library/jest-dom/vitest';
import { focusManager, QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { act, cleanup, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { TRPCClientError } from '@trpc/client';
import { observable, type Observer } from '@trpc/server/observable';
import { createStore, Provider } from 'jotai';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { z } from 'zod';
import { pendingAccountAuthAtom } from '../../../lib/atoms';
import { trpc } from '../../../lib/trpc';
import { ConnectClaudeAccountPage } from '..';

// `lib/trpc` wires its ipc client at import time, so the preload bridge must exist first.
vi.hoisted(() => {
  Object.assign(globalThis, {
    electronTRPC: { onMessage: () => () => undefined, sendMessage: () => undefined },
  });
});

type Detection = {
  available: boolean;
  email?: string;
  displayName?: string;
  sourcePath?: string;
  hint?: string;
};

const NO_LOGIN: Detection = {
  available: false,
  hint: "Frink didn't find a Claude login on this Mac.",
};
const LOGIN: Detection = {
  available: true,
  email: 'me@claude.example',
  sourcePath: 'darwin-keychain://Claude%20Code-credentials',
};

const CLAUDE = { type: 'claude-code' };

let detections: (Detection | Promise<Detection>)[] = [];
let finishSignIn: ((finished: boolean) => void) | undefined;
const INPUT = z.record(z.string(), z.unknown()).optional();
const calls = vi.fn<(path: string, input: z.infer<typeof INPUT>) => void>();

/** A real trpc client: detection answers in turn, and each sign-in waits for `finishSignIn`. */
function createTestClient() {
  return trpc.createClient({
    links: [
      () =>
        ({ op }) =>
          observable((observer: Observer<unknown, unknown>) => {
            calls(op.path, INPUT.parse(op.input));
            const reply = <T,>(data: T) => {
              observer.next({ result: { data } });
              observer.complete();
            };
            if (op.path === 'claudeCode.detectClaudeAccount') {
              void Promise.resolve(detections.length > 1 ? detections.shift() : detections[0]).then(
                reply,
              );
            } else if (op.path === 'agentAccounts.signIn') {
              finishSignIn = (finished) =>
                finished
                  ? reply(undefined)
                  : observer.error(TRPCClientError.from(new Error('Raw failure text')));
            } else if (op.path === 'agentAccounts.cancelSignIn') {
              reply(undefined);
            } else if (op.path === 'claudeCode.connectClaudePassthrough') {
              reply({ accountId: 'a' });
            } else {
              throw new Error(`Unexpected test operation: ${op.path}`);
            }
          }),
    ],
  });
}

function renderPage(...answers: (Detection | Promise<Detection>)[]) {
  detections = answers;
  const store = createStore();
  store.set(pendingAccountAuthAtom, { accountLabel: '', mode: 'add', provider: 'claude-code' });
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const view = render(
    <trpc.Provider client={createTestClient()} queryClient={queryClient}>
      <QueryClientProvider client={queryClient}>
        <Provider store={store}>
          <ConnectClaudeAccountPage />
        </Provider>
      </QueryClientProvider>
    </trpc.Provider>,
  );
  return { store, ...view };
}

const callsTo = (path: string) => calls.mock.calls.filter(([called]) => called === path);

async function startSignIn() {
  await userEvent.click(await screen.findByRole('button', { name: 'Sign in with Claude' }));
  return screen.findByText(/Finish signing in in your browser/);
}

afterEach(() => {
  cleanup();
  calls.mockReset();
  finishSignIn = undefined;
});

describe('ConnectClaudeAccountPage', () => {
  it('offers Sign in with Claude instead of Terminal steps when there is no login', async () => {
    renderPage(NO_LOGIN);

    expect(await screen.findByText('Sign in to Claude')).toBeInTheDocument();
    expect(screen.getByText(NO_LOGIN.hint ?? '')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Sign in with Claude' })).toBeInTheDocument();
    expect(screen.queryByText(/Terminal|claude auth login/)).not.toBeInTheDocument();
  });

  it('keeps a login it finds, with Connect and no sign-in', async () => {
    renderPage(LOGIN);

    expect(await screen.findByText('Connected to me@claude.example')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Connect' })).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Sign in with Claude' })).not.toBeInTheDocument();
  });

  it('waits on the browser, then connects the new login under its email', async () => {
    const { store } = renderPage(NO_LOGIN, LOGIN);

    const waiting = await startSignIn();
    expect(waiting.closest('[aria-live="polite"]')).not.toBeNull();
    expect(screen.getByText('Frink never sees your password.')).toBeInTheDocument();
    expect(callsTo('agentAccounts.signIn')).toEqual([['agentAccounts.signIn', CLAUDE]]);

    act(() => finishSignIn?.(true));

    await waitFor(() => expect(store.get(pendingAccountAuthAtom)).toBeNull());
    expect(callsTo('claudeCode.connectClaudePassthrough')).toEqual([
      [
        'claudeCode.connectClaudePassthrough',
        {
          accountLabel: LOGIN.email,
          sourcePath: LOGIN.sourcePath,
          expectedEmail: LOGIN.email,
          reauth: false,
        },
      ],
    ]);
  });

  it('keeps waiting while it checks the new login, then connects it under the typed label', async () => {
    let landed: (detection: Detection) => void = () => undefined;
    renderPage(
      NO_LOGIN,
      new Promise<Detection>((resolve) => {
        landed = resolve;
      }),
    );
    await startSignIn();
    await userEvent.type(screen.getByPlaceholderText('Work, Personal, etc.'), 'Work');

    act(() => finishSignIn?.(true));

    await waitFor(() => expect(callsTo('claudeCode.detectClaudeAccount')).toHaveLength(2));
    expect(screen.getByText(/Finish signing in in your browser/)).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Sign in with Claude' })).not.toBeInTheDocument();

    act(() => landed(LOGIN));

    await waitFor(() =>
      expect(callsTo('claudeCode.connectClaudePassthrough')).toEqual([
        [
          'claudeCode.connectClaudePassthrough',
          expect.objectContaining({ accountLabel: 'Work', sourcePath: LOGIN.sourcePath }),
        ],
      ]),
    );
  });

  it('says it did not finish when the sign-in ended but no login turned up', async () => {
    renderPage(NO_LOGIN);
    await startSignIn();

    act(() => finishSignIn?.(true));

    expect(await screen.findByText("Sign-in didn't finish. Try again.")).toBeInTheDocument();
    expect(callsTo('claudeCode.connectClaudePassthrough')).toEqual([]);
  });

  it('says to sign in again when the finished sign-in left no login Frink can use', async () => {
    renderPage(NO_LOGIN, { available: true, displayName: 'Claude Code' });
    await startSignIn();

    act(() => finishSignIn?.(true));

    expect(await screen.findByRole('alert')).toHaveTextContent(
      "Frink can't find your Claude login. Go back and sign in again.",
    );
    expect(callsTo('claudeCode.connectClaudePassthrough')).toEqual([]);
  });

  it('does not check the keychain on window focus while signing in', async () => {
    renderPage(NO_LOGIN);
    await startSignIn();
    const checks = callsTo('claudeCode.detectClaudeAccount').length;

    await act(async () => {
      focusManager.setFocused(false);
      focusManager.setFocused(true);
    });

    expect(callsTo('claudeCode.detectClaudeAccount')).toHaveLength(checks);
    focusManager.setFocused(undefined);
  });

  it('says plainly when the sign-in did not finish, and connects nothing', async () => {
    renderPage(NO_LOGIN);
    await startSignIn();

    act(() => finishSignIn?.(false));

    expect(await screen.findByText("Sign-in didn't finish. Try again.")).toBeInTheDocument();
    expect(screen.queryByText('Raw failure text')).not.toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Sign in with Claude' })).toBeInTheDocument();
    expect(callsTo('claudeCode.connectClaudePassthrough')).toEqual([]);
  });

  it.each(['Cancel', 'leaving the page'])(
    'connects nothing after %s while the new login is checked',
    async (how) => {
      let landed: (detection: Detection) => void = () => undefined;
      const { unmount } = renderPage(
        NO_LOGIN,
        new Promise<Detection>((resolve) => {
          landed = resolve;
        }),
      );
      await startSignIn();
      act(() => finishSignIn?.(true));
      await waitFor(() => expect(callsTo('claudeCode.detectClaudeAccount')).toHaveLength(2));

      if (how === 'Cancel') await userEvent.click(screen.getByRole('button', { name: 'Cancel' }));
      else unmount();
      await act(async () => landed(LOGIN));

      expect(callsTo('claudeCode.connectClaudePassthrough')).toEqual([]);
    },
  );

  it('connects nothing from a cancelled check when the person signs in again before it ends', async () => {
    let firstLanded: (detection: Detection) => void = () => undefined;
    renderPage(
      NO_LOGIN,
      new Promise<Detection>((resolve) => {
        firstLanded = resolve;
      }),
      NO_LOGIN,
    );
    await startSignIn();
    act(() => finishSignIn?.(true));
    await waitFor(() => expect(callsTo('claudeCode.detectClaudeAccount')).toHaveLength(2));
    await userEvent.click(screen.getByRole('button', { name: 'Cancel' }));
    await startSignIn();

    await act(async () => firstLanded(LOGIN));

    expect(callsTo('claudeCode.connectClaudePassthrough')).toEqual([]);
    expect(screen.getByText(/Finish signing in in your browser/)).toBeInTheDocument();
  });

  it('stops the sign-in on Cancel and when the page closes', async () => {
    const { unmount } = renderPage(NO_LOGIN);
    await startSignIn();

    await userEvent.click(screen.getByRole('button', { name: 'Cancel' }));

    expect(await screen.findByRole('button', { name: 'Sign in with Claude' })).toBeInTheDocument();
    expect(screen.queryByText("Sign-in didn't finish. Try again.")).not.toBeInTheDocument();
    await waitFor(() => expect(callsTo('agentAccounts.cancelSignIn')).toHaveLength(1));

    await startSignIn();
    unmount();
    await waitFor(() => expect(callsTo('agentAccounts.cancelSignIn')).toHaveLength(2));
  });
});
