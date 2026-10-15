// @vitest-environment happy-dom

import '@testing-library/jest-dom/vitest';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { cleanup, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { TRPCClientError } from '@trpc/client';
import { observable } from '@trpc/server/observable';
import { createStore, Provider } from 'jotai';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { z } from 'zod';
import { TooltipProvider } from '../../../components/ui/tooltip';
import { pendingAccountAuthAtom } from '../../../lib/atoms';
import { trpc } from '../../../lib/trpc';
import { ConnectAgentAccountPage } from './index';

// `lib/trpc` wires its ipc client at import time, so the preload bridge must exist first.
vi.hoisted(() => {
  Object.assign(globalThis, {
    electronTRPC: { onMessage: () => () => undefined, sendMessage: () => undefined },
  });
});

type Detection =
  | { available: true; version?: string; email?: string; displayName?: string }
  | { available: false; reason: string; missing?: true; signedOut?: true };

const CONNECT_INPUT = z.object({ type: z.string(), accountLabel: z.string() });
const connect = vi.fn<(input: z.infer<typeof CONNECT_INPUT>) => void>();
const detect = vi.fn();
const signIn = vi.fn();
const SIGNED_OUT =
  "Cursor isn't signed in. Choose Sign in to Cursor, finish in your browser, then try again.";

/** A real trpc client answering detection with `detection` and recording each connect and sign-in. */
function createTestClient(detection: Detection, connectError?: string) {
  return trpc.createClient({
    links: [
      () =>
        ({ op }) =>
          observable((observer) => {
            if (op.path === 'agentAccounts.detect') {
              detect();
              observer.next({ result: { data: detection } });
            } else if (op.path === 'agentAccounts.signIn') {
              // A sign-in still waiting on the browser has no answer yet.
              if (signIn(op.input) === 'wait') return;
              if (connectError) {
                observer.error(TRPCClientError.from(new Error(connectError)));
                return;
              }
              observer.next({ result: { data: undefined } });
            } else if (op.path === 'agentAccounts.connect') {
              connect(CONNECT_INPUT.parse(op.input));
              if (connectError) {
                observer.error(TRPCClientError.from(new Error(connectError)));
                return;
              }
              observer.next({ result: { data: { accountId: 'a', status: 'created' } } });
            } else {
              throw new Error(`Unexpected test operation: ${op.path}`);
            }
            observer.complete();
          }),
    ],
  });
}

function renderPage(
  provider: 'codex' | 'opencode' | 'copilot' | 'cursor',
  detection: Detection,
  connectError?: string,
) {
  const store = createStore();
  store.set(pendingAccountAuthAtom, { accountLabel: '', mode: 'add', provider });
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  render(
    <trpc.Provider client={createTestClient(detection, connectError)} queryClient={queryClient}>
      <QueryClientProvider client={queryClient}>
        <Provider store={store}>
          <TooltipProvider>
            <ConnectAgentAccountPage provider={provider} />
          </TooltipProvider>
        </Provider>
      </QueryClientProvider>
    </trpc.Provider>,
  );
  return store;
}

afterEach(() => {
  cleanup();
  connect.mockReset();
  detect.mockReset();
  signIn.mockReset();
});

describe('ConnectAgentAccountPage', () => {
  it('connects the OpenAI login Codex keeps, named after its email', async () => {
    const store = renderPage('codex', { available: true, email: 'me@openai.example' });

    expect(await screen.findByText('Connected to me@openai.example')).toBeInTheDocument();
    await userEvent.click(screen.getByRole('button', { name: 'Connect' }));

    expect(connect).toHaveBeenCalledWith({ type: 'codex', accountLabel: 'me@openai.example' });
    expect(store.get(pendingAccountAuthAtom)).toBeNull();
  });

  it.each([
    ['codex', 'Connect OpenAI Account'],
    ['opencode', 'Connect OpenCode AccountPreview'],
    ['copilot', 'Connect GitHub Copilot AccountPreview'],
    ['cursor', 'Connect Cursor AccountPreview'],
  ] as const)('titles the %s page, tagged Preview only for an installed agent', (type, title) => {
    renderPage(type, { available: true });
    expect(screen.getByRole('heading', { level: 1 }).textContent).toBe(title);
  });

  it('shows the codex login steps and the reason when OpenAI has no login here', async () => {
    renderPage('codex', { available: false, reason: 'Looked in ~/.codex but found no session.' });

    expect(await screen.findByText('No OpenAI login detected')).toBeInTheDocument();
    expect(screen.getByText('codex login')).toBeInTheDocument();
    expect(screen.getByText('Looked in ~/.codex but found no session.')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Connect' })).not.toBeInTheDocument();
  });

  it.each([
    ['opencode', 'OpenCode', 'opencode auth login', /Free OpenCode models work right away/],
    ['copilot', 'GitHub Copilot', 'copilot login', /GitHub Copilot needs you signed in/],
  ] as const)(
    'connects an installed %s and shows its own sign-in command',
    async (type, name, signIn, note) => {
      renderPage(type, { available: true, version: '1.19.2' });

      expect(await screen.findByText(`${name} 1.19.2 found.`)).toBeInTheDocument();
      expect(screen.getByText(signIn)).toBeInTheDocument();
      expect(screen.getByText(note)).toBeInTheDocument();
      await userEvent.click(screen.getByRole('button', { name: 'Connect' }));
      expect(connect).toHaveBeenCalledWith({ type, accountLabel: name });
    },
  );

  it('says OpenCode is not installed and shows the command that installs it', async () => {
    renderPage('opencode', {
      available: false,
      reason: "Frink can't find OpenCode.",
      missing: true,
    });

    expect(await screen.findByText("OpenCode isn't installed.")).toBeInTheDocument();
    expect(screen.getByText('npm install -g opencode-ai@1.19').tagName).toBe('CODE');
    expect(screen.queryByText("Frink can't find OpenCode.")).not.toBeInTheDocument();
    expect(screen.getByRole('button', { name: /Check again/ })).toBeInTheDocument();
  });

  it.each([
    [
      "Frink couldn't tell which version of OpenCode you have, so it didn't start it.",
      ["Frink couldn't tell which version of OpenCode you have, so it didn't start it."],
    ],
    [
      "Frink has checked OpenCode 1.19. You have 1.20.0, which Frink hasn't checked yet.",
      ['Frink has checked OpenCode 1.19.', "You have 1.20.0, which Frink hasn't checked yet."],
    ],
  ])('explains why OpenCode cannot be connected: %s', async (reason, lines) => {
    renderPage('opencode', { available: false, reason });

    const panel = (await screen.findByText(lines[0] ?? '')).closest('.rounded-lg');
    const shown = Array.from(panel?.querySelectorAll('p') ?? [], (line) => line.textContent);
    expect(shown).toEqual(lines);
    expect(screen.getByRole('button', { name: /Check again/ })).toBeInTheDocument();
    expect(screen.queryByText(/login/i)).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Connect' })).not.toBeInTheDocument();
  });

  it('shows a failed connect in an alert with Retry', async () => {
    renderPage('opencode', { available: true, version: '1.19.2' }, 'OpenCode went away');

    await userEvent.click(await screen.findByRole('button', { name: 'Connect' }));

    expect(await screen.findByRole('alert')).toHaveTextContent('OpenCode went away');
    expect(screen.getByRole('button', { name: 'Retry' })).toBeInTheDocument();
  });

  it('offers Sign in to Cursor while Cursor is signed out, then checks again once it finishes', async () => {
    renderPage('cursor', { available: false, reason: SIGNED_OUT, signedOut: true });

    expect(await screen.findByText("Cursor isn't signed in.")).toBeInTheDocument();
    await userEvent.click(screen.getByRole('button', { name: 'Sign in to Cursor' }));

    expect(signIn).toHaveBeenCalledWith({ type: 'cursor' });
    await waitFor(() => expect(detect).toHaveBeenCalledTimes(2));
    expect(screen.queryByText(/Terminal/)).not.toBeInTheDocument();
  });

  it('opens the sign-in page again when clicked while it waits on the browser', async () => {
    signIn.mockReturnValue('wait');
    renderPage('cursor', { available: false, reason: SIGNED_OUT, signedOut: true });

    await userEvent.click(await screen.findByRole('button', { name: 'Sign in to Cursor' }));
    await userEvent.click(await screen.findByRole('button', { name: 'Continue in your browser' }));

    expect(signIn).toHaveBeenCalledTimes(2);
  });

  it("says why Cursor's sign-in did not finish", async () => {
    const failed = "Cursor's sign-in didn't finish. Try again.";
    renderPage('cursor', { available: false, reason: SIGNED_OUT, signedOut: true }, failed);

    await userEvent.click(await screen.findByRole('button', { name: 'Sign in to Cursor' }));

    expect(await screen.findByRole('alert')).toHaveTextContent(failed);
  });

  it.each([
    [
      'Cursor needs a paid plan to work in Frink. Upgrade to Cursor Pro or higher, then try again.',
      'Cursor needs a paid plan to work in Frink.',
    ],
    [
      "Frink can't find Cursor's SDK on this computer.",
      "Frink can't find Cursor's SDK on this computer.",
    ],
  ])('shows why Cursor cannot connect, with no Sign in: %s', async (reason, title) => {
    renderPage('cursor', { available: false, reason });

    expect(await screen.findByText(title)).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Sign in to Cursor' })).not.toBeInTheDocument();
    expect(screen.queryByText(/Terminal/)).not.toBeInTheDocument();
  });

  it('connects a signed-in Cursor, with no Terminal step', async () => {
    renderPage('cursor', { available: true });

    expect(await screen.findByText('Cursor login found')).toBeInTheDocument();
    expect(
      screen.getByText('Uses your own Cursor sign-in. No token is stored in Frink.'),
    ).toBeInTheDocument();
    expect(screen.queryByText(/Terminal/)).not.toBeInTheDocument();
    await userEvent.click(screen.getByRole('button', { name: 'Connect' }));
    expect(connect).toHaveBeenCalledWith({ type: 'cursor', accountLabel: 'Cursor' });
  });
});
