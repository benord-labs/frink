// @vitest-environment happy-dom
import '@testing-library/jest-dom/vitest';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { AccountsList } from './index';

vi.mock('jotai', async (importOriginal) => {
  const actual = await importOriginal<typeof import('jotai')>();
  return {
    ...actual,
    useSetAtom: () => vi.fn(),
  };
});

vi.mock('sonner', () => ({
  toast: Object.assign(vi.fn(), {
    success: vi.fn(),
    error: vi.fn(),
  }),
}));

vi.mock('../../../../../lib/trpc', () => ({
  trpc: {
    useUtils: () => ({
      claudeCode: {
        getResolvedAccount: { invalidate: vi.fn() },
      },
    }),
    claudeCode: {
      addAccount: { useMutation: () => ({ mutate: vi.fn(), isPending: false }) },
      setDefault: { useMutation: () => ({ mutate: vi.fn(), isPending: false }) },
      deleteAccount: { useMutation: () => ({ mutate: vi.fn(), isPending: false }) },
      disconnectClaudePassthrough: {
        useMutation: () => ({ mutate: vi.fn(), isPending: false }),
      },
      renameAccount: { useMutation: () => ({ mutate: vi.fn(), isPending: false }) },
    },
  },
}));

function renderList(props: Partial<Parameters<typeof AccountsList>[0]> = {}) {
  render(
    <AccountsList
      onAuthenticate={vi.fn()}
      accounts={[]}
      refetchAccounts={vi.fn(async () => ({ data: [] }))}
      {...props}
    />,
  );
}

afterEach(cleanup);

describe('AccountsList', () => {
  it('offers every way to add an account when none is connected', async () => {
    renderList();
    expect(screen.getByText('No accounts yet. Add one to start chatting.')).toBeInTheDocument();
    await userEvent.click(screen.getByRole('button', { name: 'Add an account' }));
    expect(screen.getByRole('menuitem', { name: 'Sign in with Claude' })).toBeInTheDocument();
    expect(screen.getByRole('menuitem', { name: 'Add a Claude API key' })).toBeInTheDocument();
    expect(screen.getByRole('menuitem', { name: 'Sign in with OpenAI' })).toBeInTheDocument();
  });

  it('leaves out sign-ins this computer already has, then goes straight to the key form', () => {
    renderList({ hasClaudePassthrough: true, hasCodexPassthrough: true });
    expect(screen.queryByRole('button', { name: 'Sign in with Claude' })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Sign in with OpenAI' })).not.toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: 'Add an account' }));
    expect(screen.getByLabelText('API key')).toBeInTheDocument();
    expect(screen.getByLabelText('Account name')).toHaveAttribute('placeholder', 'Claude API key');

    fireEvent.click(screen.getByRole('button', { name: 'Cancel' }));
    expect(screen.getByRole('button', { name: 'Add an account' })).toBeInTheDocument();
  });

  it('keeps the error banner with Retry on the accounts card', () => {
    renderList({ accountsListFailed: true });
    expect(screen.getByRole('button', { name: 'Retry' })).toBeInTheDocument();
  });
});
