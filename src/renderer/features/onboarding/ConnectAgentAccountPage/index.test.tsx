// @vitest-environment happy-dom

import '@testing-library/jest-dom/vitest';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { cleanup, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { TRPCClientError } from '@trpc/client';
import { observable } from '@trpc/server/observable';
import { createStore, Provider } from 'jotai';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { z } from 'zod';
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
  | { available: false; reason: string; missing?: true };

const CONNECT_INPUT = z.object({ type: z.string(), accountLabel: z.string() });
const connect = vi.fn<(input: z.infer<typeof CONNECT_INPUT>) => void>();

/** A real trpc client answering detection with `detection` and recording each connect. */
function createTestClient(detection: Detection, connectError?: string) {
  return trpc.createClient({
    links: [
      () =>
        ({ op }) =>
          observable((observer) => {
            if (op.path === 'agentAccounts.detect') {
              observer.next({ result: { data: detection } });
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
  provider: 'codex' | 'opencode' | 'copilot',
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
          <ConnectAgentAccountPage provider={provider} />
        </Provider>
      </QueryClientProvider>
    </trpc.Provider>,
  );
  return store;
}

afterEach(() => {
  cleanup();
  connect.mockReset();
});

describe('ConnectAgentAccountPage', () => {
  it('connects the OpenAI login Codex keeps, named after its email', async () => {
    const store = renderPage('codex', { available: true, email: 'me@openai.example' });

    expect(await screen.findByText('Connected to me@openai.example')).toBeInTheDocument();
    await userEvent.click(screen.getByRole('button', { name: 'Connect' }));

    expect(connect).toHaveBeenCalledWith({ type: 'codex', accountLabel: 'me@openai.example' });
    expect(store.get(pendingAccountAuthAtom)).toBeNull();
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
});
