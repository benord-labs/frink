// @vitest-environment happy-dom
import '@testing-library/jest-dom/vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { getDefaultStore } from 'jotai';
import { toast } from 'sonner';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { hiddenModelsAtom } from '../../../../lib/atoms';
import { AgentsModelsTab } from './index';

const accountsListSpy = vi.fn();

const listAccountsQuery = vi.hoisted(() => ({
  data: undefined as
    // `type` is widened with 'codex' to mirror the AIAccountType TEXT column: the
    // listAccounts tRPC union hasn't been widened yet, so a codex row arrives as a
    // raw string the tab narrows via `(a.type as string) === 'codex'`.
    | Array<{
        id: string;
        type: 'claude-code' | 'codex' | 'opencode' | 'copilot';
        isAuthenticated: boolean;
      }>
    | undefined,
  isSuccess: false,
  isFetched: false,
  isError: false,
  refetch: vi.fn(async () => []),
}));

type AgentModelsResult = {
  data?: Array<{ id: string; name: string; familyId?: string }>;
  isPending: boolean;
};
/** Each agent's model list query; an agent missing here is still loading. */
const agentModels = vi.hoisted(() => new Map<string, AgentModelsResult>());

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
    agentAccounts: {
      models: {
        useQuery: ({ type }: { type: string }) => agentModels.get(type) ?? { isPending: true },
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

describe('AgentsModelsTab installed agents', () => {
  const OPENCODE = [
    { id: 'opencode/big-pickle', name: 'Big Pickle' },
    { id: 'opencode/gpt-5-nano', name: 'GPT-5 Nano' },
    { id: 'opencode/gpt-4.1-nano', name: 'GPT-4.1 Nano' },
  ];
  const gpt = { name: 'GPT-X', familyId: 'gpt-x' };
  const COPILOT = [
    { ...gpt, id: 'gpt-x/low' },
    { ...gpt, id: 'gpt-x/medium' },
    { ...gpt, id: 'gpt-x/high' },
    { id: 'auto', name: 'Auto' },
  ];
  const START_CHAT = 'Start a chat with OpenCode to see its models here.';
  const store = getDefaultStore();

  function signedIn(...types: Array<'claude-code' | 'opencode' | 'copilot'>) {
    listAccountsQuery.data = types.map((type) => ({ id: type, type, isAuthenticated: true }));
    listAccountsQuery.isSuccess = true;
    listAccountsQuery.isFetched = true;
    listAccountsQuery.isError = false;
  }

  beforeEach(() => {
    Object.defineProperty(window, 'desktopApi', {
      value: { platform: 'darwin' },
      configurable: true,
    });
    store.set(hiddenModelsAtom, []);
    agentModels.clear();
  });

  it('lists a connected OpenCode with a switch per model, stored under its own key', async () => {
    signedIn('claude-code', 'opencode');
    agentModels.set('opencode', { data: OPENCODE, isPending: false });
    render(<AgentsModelsTab />);

    expect(screen.getByText('OpenCode')).toBeInTheDocument();
    expect(screen.getByRole('switch', { name: 'Show GPT-5 Nano' })).toBeChecked();
    // After Claude's rows, with older versions of a line not folded away.
    expect(screen.getAllByRole('switch').at(-1)).toHaveAccessibleName('Show GPT-4.1 Nano');
    await userEvent.setup().click(screen.getByRole('switch', { name: 'Show Big Pickle' }));
    expect(store.get(hiddenModelsAtom)).toEqual(['opencode:opencode/big-pickle']);
    expect(screen.getByRole('switch', { name: 'Show Big Pickle' })).not.toBeChecked();
  });

  it('gives GitHub Copilot one switch per model, not one per effort', async () => {
    signedIn('copilot');
    agentModels.set('copilot', { data: COPILOT, isPending: false });
    render(<AgentsModelsTab />);

    expect(screen.getAllByRole('switch').map((s) => s.getAttribute('aria-label'))).toEqual([
      'Show GPT-X',
      'Show Auto',
    ]);
    await userEvent.setup().click(screen.getByRole('switch', { name: 'Show GPT-X' }));
    expect(store.get(hiddenModelsAtom)).toEqual(['copilot:gpt-x']);
  });

  it('keeps the last GitHub Copilot model on', async () => {
    const info = vi.spyOn(toast, 'info').mockImplementation(() => 0);
    signedIn('copilot');
    agentModels.set('copilot', { data: [{ id: 'auto', name: 'Auto' }], isPending: false });
    render(<AgentsModelsTab />);

    await userEvent.setup().click(screen.getByRole('switch', { name: 'Show Auto' }));
    expect(info).toHaveBeenCalledWith('Keep at least one GitHub Copilot model on.');
    expect(store.get(hiddenModelsAtom)).toEqual([]);
  });

  it.each([
    ['empty', { data: [], isPending: false }],
    ['failed to load', { isPending: false }],
  ])('asks for a first chat when the list is %s, never an error', (_, result) => {
    signedIn('opencode');
    agentModels.set('opencode', result);
    render(<AgentsModelsTab />);

    expect(screen.getByText(START_CHAT)).toBeInTheDocument();
    expect(screen.queryByRole('alert')).not.toBeInTheDocument();
  });

  it('shows only the header while the list loads', () => {
    signedIn('opencode');
    render(<AgentsModelsTab />);

    expect(screen.getByText('OpenCode')).toBeInTheDocument();
    expect(screen.queryByText(START_CHAT)).not.toBeInTheDocument();
    expect(screen.queryByRole('switch')).not.toBeInTheDocument();
  });

  it('shows no agent group before accounts load, when they fail, or when not connected', () => {
    agentModels.set('opencode', { data: OPENCODE, isPending: false });
    signedIn('opencode');
    listAccountsQuery.isSuccess = false;
    listAccountsQuery.isFetched = false;
    const { rerender } = render(<AgentsModelsTab />);
    expect(screen.queryByText('OpenCode')).not.toBeInTheDocument();

    listAccountsQuery.isFetched = true;
    listAccountsQuery.isError = true;
    rerender(<AgentsModelsTab />);
    expect(screen.queryByText('OpenCode')).not.toBeInTheDocument();
    expect(
      screen.getByText(
        'Could not load accounts. Claude and OpenAI models are shown until this works.',
      ),
    ).toBeInTheDocument();

    signedIn('claude-code');
    listAccountsQuery.data?.push({ id: 'oc', type: 'opencode', isAuthenticated: false });
    rerender(<AgentsModelsTab />);
    expect(screen.queryByText('OpenCode')).not.toBeInTheDocument();
    expect(screen.getByText('Haiku 5.5')).toBeInTheDocument();
  });
});
