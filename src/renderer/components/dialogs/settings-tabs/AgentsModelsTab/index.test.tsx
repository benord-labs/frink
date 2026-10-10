// @vitest-environment happy-dom
import '@testing-library/jest-dom/vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { AgentsModelsTab } from './index';

const accountsListSpy = vi.fn();

const listAccountsQuery = vi.hoisted(() => ({
  data: undefined as
    // `type` is widened with 'codex' to mirror the AIAccountType TEXT column: the
    // listAccounts tRPC union hasn't been widened yet, so a codex row arrives as a
    // raw string the tab narrows via `(a.type as string) === 'codex'`.
    | Array<{
        id: string;
        type: 'claude-code' | 'codex';
        isAuthenticated: boolean;
      }>
    | undefined,
  isSuccess: false,
  isFetched: false,
  isError: false,
  refetch: vi.fn(async () => []),
}));

vi.mock('jotai', async (importOriginal) => {
  const actual = await importOriginal<typeof import('jotai')>();
  return {
    ...actual,
    useSetAtom: () => vi.fn(),
  };
});

vi.mock('../../../../hooks/use-is-narrow-screen', () => ({
  useIsNarrowScreen: () => false,
}));

vi.mock('../../../../lib/trpc', () => ({
  trpc: {
    claudeCode: {
      listAccounts: {
        useQuery: () => ({
          data: listAccountsQuery.data,
          isSuccess: listAccountsQuery.isSuccess,
          isFetched: listAccountsQuery.isFetched,
          isError: listAccountsQuery.isError,
          refetch: listAccountsQuery.refetch,
        }),
      },
    },
  },
}));

vi.mock('./AccountsList', () => ({
  AccountsList: (props: unknown) => {
    accountsListSpy(props);
    return <div data-testid="accounts-list" />;
  },
}));

describe('AgentsModelsTab', () => {
  beforeEach(() => {
    listAccountsQuery.data = undefined;
    listAccountsQuery.isSuccess = false;
    listAccountsQuery.isFetched = false;
    listAccountsQuery.isError = false;
    listAccountsQuery.refetch.mockClear();
  });

  it('renders heading and the AI accounts section', () => {
    listAccountsQuery.data = [{ id: 'a2', type: 'claude-code', isAuthenticated: true }];
    listAccountsQuery.isSuccess = true;
    listAccountsQuery.isFetched = true;
    accountsListSpy.mockClear();
    render(<AgentsModelsTab />);

    expect(screen.getByText('AI providers')).toBeInTheDocument();
    expect(screen.queryByText('GitHub Accounts')).not.toBeInTheDocument();
    expect(accountsListSpy).toHaveBeenCalled();
  });

  it('shows Claude and Codex model families when both providers have an authenticated account', () => {
    listAccountsQuery.data = [
      { id: 'a3', type: 'codex', isAuthenticated: true },
      { id: 'a2', type: 'claude-code', isAuthenticated: true },
    ];
    listAccountsQuery.isSuccess = true;
    listAccountsQuery.isFetched = true;
    render(<AgentsModelsTab />);

    expect(screen.getByText('Haiku 5.5')).toBeInTheDocument();
    expect(screen.getByText('GPT-5.5')).toBeInTheDocument();
  });

  it('hides Codex model families when only Claude is authenticated', () => {
    listAccountsQuery.data = [{ id: 'a2', type: 'claude-code', isAuthenticated: true }];
    listAccountsQuery.isSuccess = true;
    listAccountsQuery.isFetched = true;
    render(<AgentsModelsTab />);

    expect(screen.getByText('Haiku 5.5')).toBeInTheDocument();
    expect(screen.queryByText('GPT-5.5')).not.toBeInTheDocument();
  });

  it('shows Codex model families and gates out Claude when only Codex is authenticated', () => {
    // A codex row arrives as a raw string the tab narrows via `(a.type as string) === 'codex'`.
    listAccountsQuery.data = [{ id: 'a3', type: 'codex', isAuthenticated: true }];
    listAccountsQuery.isSuccess = true;
    listAccountsQuery.isFetched = true;
    render(<AgentsModelsTab />);

    expect(screen.getByText('GPT-5.5')).toBeInTheDocument();
    expect(screen.queryByText('Haiku 5.5')).not.toBeInTheDocument(); // Claude gated out
  });

  it('keeps Codex models hidden when a codex account exists but is not authenticated', () => {
    listAccountsQuery.data = [{ id: 'a3', type: 'codex', isAuthenticated: false }];
    listAccountsQuery.isSuccess = true;
    listAccountsQuery.isFetched = true;
    render(<AgentsModelsTab />);

    // Unauthenticated codex row → no codex catalog + the all-providers-off empty state.
    expect(screen.queryByText('GPT-5.5')).not.toBeInTheDocument();
    expect(screen.getByText('Add an account above to choose its models.')).toBeInTheDocument();
  });

  it('shows full model catalog while listAccounts is loading, then gates after success', () => {
    listAccountsQuery.data = undefined;
    listAccountsQuery.isSuccess = false;
    listAccountsQuery.isFetched = false;
    const { rerender } = render(<AgentsModelsTab />);

    expect(screen.getByText('GPT-5.5')).toBeInTheDocument();
    expect(screen.getByText('Haiku 5.5')).toBeInTheDocument();
    expect(
      screen.queryByText('Add an account above to choose its models.'),
    ).not.toBeInTheDocument();

    listAccountsQuery.data = [{ id: 'a2', type: 'claude-code', isAuthenticated: true }];
    listAccountsQuery.isSuccess = true;
    listAccountsQuery.isFetched = true;
    rerender(<AgentsModelsTab />);

    expect(screen.getByText('Haiku 5.5')).toBeInTheDocument();
    expect(screen.queryByText('GPT-5.5')).not.toBeInTheDocument();
  });

  it('shows empty state when loaded with no authenticated accounts', () => {
    listAccountsQuery.data = [
      { id: 'a3', type: 'codex', isAuthenticated: false },
      { id: 'a2', type: 'claude-code', isAuthenticated: false },
    ];
    listAccountsQuery.isSuccess = true;
    listAccountsQuery.isFetched = true;
    render(<AgentsModelsTab />);

    expect(screen.getByText('Add an account above to choose its models.')).toBeInTheDocument();
    expect(screen.queryByText('Haiku 5.5')).not.toBeInTheDocument();
    expect(screen.queryByText('GPT-5.5')).not.toBeInTheDocument();
  });

  it('shows empty state when listAccounts succeeds with zero AI account rows', () => {
    listAccountsQuery.data = [];
    listAccountsQuery.isSuccess = true;
    listAccountsQuery.isFetched = true;
    render(<AgentsModelsTab />);

    expect(screen.getByText('Add an account above to choose its models.')).toBeInTheDocument();
    expect(screen.queryByText('Haiku 5.5')).not.toBeInTheDocument();
    expect(screen.queryByText('GPT-5.5')).not.toBeInTheDocument();
  });

  it('does not apply auth gate until listAccounts succeeds (avoids gating on stale or error state)', () => {
    listAccountsQuery.data = [{ id: 'a2', type: 'claude-code', isAuthenticated: true }];
    listAccountsQuery.isSuccess = false;
    listAccountsQuery.isFetched = false;
    listAccountsQuery.isError = false;
    render(<AgentsModelsTab />);

    expect(screen.getByText('Haiku 5.5')).toBeInTheDocument();
    expect(screen.getByText('GPT-5.5')).toBeInTheDocument();
    expect(
      screen.queryByText('Add an account above to choose its models.'),
    ).not.toBeInTheDocument();
  });

  it('shows accounts load error banner with retry while keeping full model catalog', async () => {
    const user = userEvent.setup();
    accountsListSpy.mockClear();
    listAccountsQuery.data = undefined;
    listAccountsQuery.isSuccess = false;
    listAccountsQuery.isFetched = true;
    listAccountsQuery.isError = true;
    render(<AgentsModelsTab />);

    expect(accountsListSpy).toHaveBeenCalledWith(
      expect.objectContaining({ accountsListFailed: true }),
    );
    expect(screen.getAllByRole('alert').length).toBeGreaterThanOrEqual(1);
    expect(screen.getByText(/Could not load accounts/i, { exact: false })).toBeInTheDocument();
    const retryButtons = screen.getAllByRole('button', { name: 'Retry' });
    expect(retryButtons.length).toBeGreaterThanOrEqual(1);
    expect(screen.getByText('Haiku 5.5')).toBeInTheDocument();
    expect(screen.getByText('GPT-5.5')).toBeInTheDocument();

    const firstRetry = retryButtons[0];
    expect(firstRetry).toBeDefined();
    await user.click(firstRetry);
    expect(listAccountsQuery.refetch).toHaveBeenCalled();
  });
});

describe('AgentsModelsTab models card', () => {
  it('folds older models behind a toggle and keeps the last model of a provider on', async () => {
    const user = userEvent.setup();
    listAccountsQuery.data = [{ id: 'a2', type: 'claude-code', isAuthenticated: true }];
    listAccountsQuery.isSuccess = true;
    listAccountsQuery.isFetched = true;
    render(<AgentsModelsTab />);

    expect(screen.queryByText('Opus 4.8')).not.toBeInTheDocument();
    const showOlder = screen.getByRole('button', { name: /Show \d+ older models/ });
    expect(showOlder).toHaveAttribute('aria-expanded', 'false');
    await user.click(showOlder);
    expect(screen.getByText('Opus 4.8')).toBeInTheDocument();
  });
});
