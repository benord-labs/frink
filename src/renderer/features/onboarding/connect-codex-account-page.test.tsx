// @vitest-environment happy-dom

import '@testing-library/jest-dom/vitest';
import { cleanup, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { createStore, Provider } from 'jotai';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { pendingAccountAuthAtom } from '../../lib/atoms';
import { ConnectCodexAccountPage } from './connect-codex-account-page';

type Detection =
  | { available: true; email?: string; displayName?: string; sourcePath: string }
  | { available: false; hint?: string };

const detectMock = vi.fn();

const listAccountsInvalidate = vi.fn();
const getResolvedAccountInvalidate = vi.fn();

const connect = vi.hoisted(() => ({ mutateAsync: vi.fn() }));

vi.mock('../../lib/trpc', () => ({
  trpc: {
    useUtils: () => ({
      claudeCode: {
        listAccounts: { invalidate: listAccountsInvalidate },
        getResolvedAccount: { invalidate: getResolvedAccountInvalidate },
      },
    }),
    claudeCode: {
      detectCodexAccount: {
        useQuery: () => detectMock(),
      },
      connectCodexPassthrough: {
        useMutation: () => ({ mutateAsync: connect.mutateAsync }),
      },
    },
  },
}));

vi.mock('sonner', () => ({
  toast: {
    success: vi.fn(),
    error: vi.fn(),
  },
}));

const detectionState = (data: Detection | undefined, isLoading = false) => ({
  data,
  isLoading,
  refetch: vi.fn(async () => ({ data })),
});

afterEach(() => {
  cleanup();
  detectMock.mockReset();
  connect.mutateAsync.mockReset();
  listAccountsInvalidate.mockReset();
  getResolvedAccountInvalidate.mockReset();
});

describe('ConnectCodexAccountPage', () => {
  it('connects the detected login: enables Connect once a label is present and clears pending + invalidates on success', async () => {
    const user = userEvent.setup();
    const store = createStore();
    store.set(pendingAccountAuthAtom, { accountLabel: '', mode: 'add', provider: 'codex' });

    detectMock.mockReturnValue(
      detectionState({
        available: true,
        email: 'me@openai.example',
        sourcePath: 'codex-passthrough://local',
      }),
    );
    connect.mutateAsync.mockResolvedValue(undefined);

    render(
      <Provider store={store}>
        <ConnectCodexAccountPage />
      </Provider>,
    );

    // The detected email becomes the default label, which enables the CTA.
    expect(screen.getByText('Connected to me@openai.example')).toBeInTheDocument();
    const connectButton = screen.getByRole('button', { name: 'Connect' });
    expect(connectButton).toBeEnabled();

    await user.click(connectButton);

    expect(connect.mutateAsync).toHaveBeenCalledWith({ accountLabel: 'me@openai.example' });
    expect(store.get(pendingAccountAuthAtom)).toBeNull();
    expect(listAccountsInvalidate).toHaveBeenCalled();
    expect(getResolvedAccountInvalidate).toHaveBeenCalled();
  });

  it('renders the no-login empty state with the codex login instruction + Check for Login refresh (no Connect)', () => {
    detectMock.mockReturnValue(
      detectionState({ available: false, hint: 'Looked in ~/.codex but found no session.' }),
    );

    render(
      <Provider store={createStore()}>
        <ConnectCodexAccountPage />
      </Provider>,
    );

    expect(screen.getByText('No OpenAI login detected')).toBeInTheDocument();
    expect(screen.getByText('codex login')).toBeInTheDocument();
    expect(screen.getByText('Looked in ~/.codex but found no session.')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /Check for Login/i })).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Connect' })).not.toBeInTheDocument();
  });

  it('surfaces the connect error in an alert with a Retry button when the mutation rejects', async () => {
    const user = userEvent.setup();

    detectMock.mockReturnValue(
      detectionState({
        available: true,
        email: 'me@openai.example',
        sourcePath: 'codex-passthrough://local',
      }),
    );
    connect.mutateAsync.mockRejectedValue(new Error('codex session expired'));

    render(
      <Provider store={createStore()}>
        <ConnectCodexAccountPage />
      </Provider>,
    );

    await user.click(screen.getByRole('button', { name: 'Connect' }));

    const alert = await screen.findByRole('alert');
    expect(alert).toHaveTextContent('codex session expired');
    expect(screen.getByRole('button', { name: 'Retry' })).toBeInTheDocument();
  });
});
