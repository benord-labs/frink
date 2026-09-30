// @vitest-environment happy-dom

import '@testing-library/jest-dom/vitest';
import { cleanup, render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { createStore, Provider } from 'jotai';
import { toast } from 'sonner';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { activeOverlayAtom, agentsSettingsDialogActiveTabAtom } from '../../../lib/atoms';
import { pendingChatRetryAtomFamily } from '../atoms';
import { AccountIndicator, ContinueAfterUsageLimit } from './account-indicator';

type ListAccount = {
  id: string;
  label: string;
  isDefault: boolean;
  isAuthenticated: boolean;
  connectedAt: null;
  isApiKey: boolean;
  type: 'claude-code' | 'codex';
};

const snap = vi.hoisted(() => {
  const defaultListAccounts: ListAccount[] = [
    {
      id: 'acc-1',
      label: 'Slice',
      isDefault: true,
      isAuthenticated: true,
      connectedAt: null,
      isApiKey: false,
      type: 'claude-code',
    },
    {
      id: 'acc-2',
      label: 'Backup',
      isDefault: false,
      isAuthenticated: true,
      connectedAt: null,
      isApiKey: false,
      type: 'claude-code',
    },
  ];
  return {
    setDefaultMutate: vi.fn(),
    setProjectAccountMutate: vi.fn(),
    setChatAccountMutate: vi.fn(),
    setChatAccountOpts: undefined as
      | { onSuccess: (data: unknown, vars: { chatId: string }) => void }
      | undefined,
    resolvedAccountInvalidate: vi.fn(),
    listAccountsData: [...defaultListAccounts] as ListAccount[],
    defaultListAccounts,
  };
});

const getResolvedAccountMock = vi.fn();

vi.mock('../../../lib/trpc', () => ({
  trpc: {
    useUtils: () => ({
      claudeCode: { getResolvedAccount: { invalidate: snap.resolvedAccountInvalidate } },
    }),
    chats: {
      setChatAccount: {
        useMutation: (opts: typeof snap.setChatAccountOpts) => {
          snap.setChatAccountOpts = opts;
          return { mutate: snap.setChatAccountMutate, isPending: false };
        },
      },
    },
    claudeCode: {
      getResolvedAccount: {
        useQuery: (...args: unknown[]) => getResolvedAccountMock(...args),
      },
      listAccounts: {
        useQuery: () => ({
          data: snap.listAccountsData,
          isLoading: false,
        }),
      },
      setDefault: { useMutation: () => ({ mutate: snap.setDefaultMutate, isPending: false }) },
      setProjectAccount: {
        useMutation: () => ({ mutate: snap.setProjectAccountMutate, isPending: false }),
      },
    },
  },
}));

vi.mock('../../../components/ui/tooltip', () => ({
  Tooltip: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
  TooltipTrigger: ({ children }: { children: React.ReactNode; asChild?: boolean }) => (
    <>{children}</>
  ),
  TooltipContent: ({ children }: { children: React.ReactNode }) => (
    <div data-testid="tooltip-content">{children}</div>
  ),
}));

vi.mock('sonner', () => ({
  toast: {
    success: vi.fn(),
    error: vi.fn(),
  },
}));

afterEach(() => {
  cleanup();
  getResolvedAccountMock.mockReset();
  snap.setDefaultMutate.mockReset();
  snap.setProjectAccountMutate.mockReset();
  snap.setChatAccountMutate.mockReset();
  snap.resolvedAccountInvalidate.mockReset();
  vi.mocked(toast.success).mockReset();
  snap.listAccountsData = [...snap.defaultListAccounts];
});

describe('AccountIndicator', () => {
  it('opens Settings → Accounts from the Manage accounts row', async () => {
    const user = userEvent.setup();
    const store = createStore();

    getResolvedAccountMock.mockReturnValue({
      data: {
        id: 'acc-1',
        label: 'Slice',
        type: 'claude-code' as const,
        isProjectOverride: false,
        isAuthenticated: true,
      },
      isLoading: false,
    });

    render(
      <Provider store={store}>
        <AccountIndicator chatId="chat-1" />
      </Provider>,
    );

    const trigger = screen.getByRole('button', { name: 'AI accounts menu, Slice, Claude Code' });
    await user.click(trigger);

    await user.click(screen.getByRole('menuitem', { name: /Manage accounts/i }));

    expect(store.get(agentsSettingsDialogActiveTabAtom)).toBe('models');
    expect(store.get(activeOverlayAtom)).toBe('settings');
  });

  describe('before a chat exists', () => {
    const codexRow: ListAccount = {
      id: 'acc-codex',
      label: 'CodexWork',
      isDefault: false,
      isAuthenticated: true,
      connectedAt: null,
      isApiKey: false,
      type: 'codex',
    };
    const signedOutRow: ListAccount = {
      ...codexRow,
      id: 'acc-out',
      label: 'NeedsLogin',
      isAuthenticated: false,
    };
    const defaultAccount = {
      id: 'acc-1',
      label: 'Slice',
      type: 'claude-code' as const,
      isProjectOverride: false,
      isAuthenticated: true,
    };

    function renderNewChat(
      resolved: Record<string, unknown> = defaultAccount,
      accounts = [...snap.defaultListAccounts, codexRow, signedOutRow],
    ) {
      snap.listAccountsData = accounts;
      getResolvedAccountMock.mockReturnValue({ data: resolved, isSuccess: true });
      render(
        <Provider store={createStore()}>
          <AccountIndicator projectId="proj-1" />
        </Provider>,
      );
    }

    const openMenu = () =>
      userEvent.setup().click(screen.getByRole('button', { name: /^AI accounts menu/ }));

    it('lists only signed-in logins, grouped under their provider', async () => {
      renderNewChat();
      await openMenu();

      const menu = screen.getByRole('menu');
      expect(within(menu).getByText('Claude Code')).toBeInTheDocument();
      expect(within(menu).getByText('OpenAI')).toBeInTheDocument();
      const rows = within(menu)
        .getAllByRole('menuitem')
        .map((el) => el.textContent);
      expect(rows).toEqual(['Backup', 'Slice', 'CodexWork', 'Manage accounts…']);
    });

    it('picks the login for this new chat only, never the project or workspace default', async () => {
      renderNewChat();
      await openMenu();
      await userEvent.setup().click(screen.getByRole('menuitem', { name: 'CodexWork' }));

      expect(
        screen.getByRole('button', { name: 'AI accounts menu, CodexWork, OpenAI' }),
      ).toBeInTheDocument();
      expect(screen.getByTestId('tooltip-content')).toHaveTextContent('Chosen for this chat');
      expect(snap.setProjectAccountMutate).not.toHaveBeenCalled();
      expect(snap.setDefaultMutate).not.toHaveBeenCalled();
    });

    it('starts on the project default and says where it comes from', () => {
      renderNewChat();

      expect(getResolvedAccountMock).toHaveBeenCalledWith(
        { projectId: 'proj-1' },
        expect.anything(),
      );
      const tooltip = screen.getByTestId('tooltip-content');
      expect(tooltip).toHaveTextContent('Workspace default for this project');
      expect(tooltip).toHaveTextContent('Your choice applies to this new chat only.');
    });

    it('names a project-specific default on the badge', () => {
      renderNewChat({ ...defaultAccount, isProjectOverride: true });

      expect(
        screen.getByRole('button', {
          name: 'AI accounts menu, Slice, Claude Code, project-specific default',
        }),
      ).toBeInTheDocument();
      expect(screen.getByTestId('tooltip-content')).toHaveTextContent('Project-specific account');
    });

    it('marks exactly one row active when two logins share a label', async () => {
      renderNewChat({ ...defaultAccount, id: 'c2', label: 'Shared', type: 'codex' }, [
        { ...snap.defaultListAccounts[0], id: 'c1', label: 'Shared' },
        { ...codexRow, id: 'c2', label: 'Shared' },
      ]);
      await openMenu();

      const [claudeRow, codexShared] = screen.getAllByRole('menuitem', { name: /Shared/ });
      expect(within(codexShared).getByLabelText('Active')).toBeInTheDocument();
      expect(within(claudeRow).queryByLabelText('Active')).toBeNull();
    });

    it('says so when no login is signed in', async () => {
      renderNewChat(defaultAccount, [signedOutRow]);
      await openMenu();

      expect(screen.getByText('No signed-in accounts.')).toBeInTheDocument();
    });
  });

  it('sets models tab when choosing Manage accounts while settings overlay is already open on another tab', async () => {
    const user = userEvent.setup();
    const store = createStore();
    store.set(activeOverlayAtom, 'settings');
    store.set(agentsSettingsDialogActiveTabAtom, 'keyboard');

    getResolvedAccountMock.mockReturnValue({
      data: {
        id: 'acc-1',
        label: 'Slice',
        type: 'claude-code' as const,
        isProjectOverride: false,
        isAuthenticated: true,
      },
      isLoading: false,
    });

    render(
      <Provider store={store}>
        <AccountIndicator chatId="chat-1" />
      </Provider>,
    );

    await user.click(screen.getByRole('button', { name: 'AI accounts menu, Slice, Claude Code' }));
    await user.click(screen.getByRole('menuitem', { name: /Manage accounts/i }));

    expect(store.get(agentsSettingsDialogActiveTabAtom)).toBe('models');
    expect(store.get(activeOverlayAtom)).toBe('settings');
  });

  it('renders account and provider inline on the trigger (label - provider)', () => {
    getResolvedAccountMock.mockReturnValue({
      data: {
        label: 'K-Claude',
        type: 'claude-code' as const,
        isProjectOverride: true,
        isAuthenticated: true,
      },
      isLoading: false,
    });

    render(
      <Provider store={createStore()}>
        <AccountIndicator chatId="chat-1" />
      </Provider>,
    );

    // A chat's own account is not a project default, even when it matches the project's.
    const trigger = screen.getByRole('button', { name: 'AI accounts menu, K-Claude, Claude Code' });
    expect(trigger).toHaveTextContent(/K-Claude\s*-\s*Claude Code/);
    expect(trigger.textContent).not.toMatch(/·\s*project/i);
  });

  it('sheds the provider, then the label and chevron, by the pane-header width while the name keeps both', () => {
    getResolvedAccountMock.mockReturnValue({
      data: { label: 'Personal', type: 'claude-code' as const, isAuthenticated: true },
      isLoading: false,
    });

    render(
      <Provider store={createStore()}>
        <AccountIndicator chatId="chat-1" />
      </Provider>,
    );

    const trigger = screen.getByRole('button', { name: 'AI accounts menu, Personal, Claude Code' });
    const [glyph, chevron] = trigger.querySelectorAll('svg');
    const label = trigger.firstElementChild?.nextElementSibling;
    if (!(label instanceof HTMLElement)) throw new Error('account label not rendered');
    expect(trigger).toHaveClass('max-w-[min(14rem,100%)]');
    // Same 24px ghost button as the pane icons beside it; a 24px square once only the glyph shows.
    expect(trigger).toHaveClass('h-6', 'bg-transparent', 'text-foreground');
    expect(trigger).toHaveClass('@max-[18.5rem]/pane-header:w-6');
    expect(glyph).not.toHaveClass('@max-[18.5rem]/pane-header:hidden');
    expect(label).toHaveClass('@max-[18.5rem]/pane-header:hidden');
    expect(chevron).toHaveClass('@max-[18.5rem]/pane-header:hidden');
    expect(within(label).getByText(/- Claude Code/)).toHaveClass('@max-[26rem]/pane-header:hidden');
  });

  it('applies warning styles when the resolved account is not authenticated', () => {
    getResolvedAccountMock.mockReturnValue({
      data: {
        label: 'Stale',
        type: 'claude-code' as const,
        isProjectOverride: false,
        isAuthenticated: false,
      },
      isLoading: false,
    });

    render(
      <Provider store={createStore()}>
        <AccountIndicator chatId="chat-1" />
      </Provider>,
    );

    const trigger = screen.getByRole('button', { name: 'AI accounts menu, Stale, Claude Code' });
    // AA text token + the persisting warning tint (asserted separately: the old /amber-500/
    // regex would pass vacuously off the bg class alone).
    expect(trigger.className).toMatch(/text-warning/);
    expect(trigger.className).toMatch(/status-warning/);
  });

  describe('in an existing chat', () => {
    const codexRow: ListAccount = {
      id: 'acc-codex',
      label: 'CodexWork',
      isDefault: false,
      isAuthenticated: true,
      connectedAt: null,
      isApiKey: false,
      type: 'codex',
    };

    async function openChatMenu() {
      snap.listAccountsData = [...snap.defaultListAccounts, codexRow];
      getResolvedAccountMock.mockReturnValue({
        data: { id: 'acc-1', label: 'Slice', type: 'claude-code' as const, isAuthenticated: true },
        isLoading: false,
      });
      render(
        <Provider store={createStore()}>
          <AccountIndicator chatId="chat-1" />
        </Provider>,
      );
      await userEvent
        .setup()
        .click(screen.getByRole('button', { name: /AI accounts menu, Slice/ }));
    }

    it('is read-only: the menu only manages accounts and nothing moves the chat', async () => {
      await openChatMenu();

      const rows = screen.getAllByRole('menuitem').map((el) => el.textContent);
      expect(rows).toEqual(['Manage accounts…']);
      expect(screen.getByText('This chat always uses Slice')).toBeInTheDocument();
      expect(screen.getByText(/Start a new chat to use a different account\./)).toBeInTheDocument();
      expect(snap.setChatAccountMutate).not.toHaveBeenCalled();
      expect(snap.setProjectAccountMutate).not.toHaveBeenCalled();
      expect(snap.setDefaultMutate).not.toHaveBeenCalled();
    });
  });

  describe('ContinueAfterUsageLimit', () => {
    const onRetry = vi.fn();

    function renderAfterError(
      errorCategory: string,
      accounts: ListAccount[],
      type: ListAccount['type'] = 'claude-code',
    ) {
      snap.listAccountsData = accounts;
      getResolvedAccountMock.mockReturnValue({
        data: { id: 'acc-1', label: 'Slice', type, isAuthenticated: true },
        isLoading: false,
      });
      const store = createStore();
      store.set(pendingChatRetryAtomFamily('sub-1'), {
        chatId: 'chat-1',
        subChatId: 'sub-1',
        projectId: 'proj-1',
        trigger: 'submit-message',
        errorCategory,
        errorText: "You've hit your limit",
        createdAt: 0,
      });
      render(
        <Provider store={store}>
          <ContinueAfterUsageLimit chatId="chat-1" subChatId="sub-1" onRetry={onRetry} />
        </Provider>,
      );
      return store;
    }

    const codexRow = (id: string, label: string): ListAccount => ({
      id,
      label,
      isDefault: false,
      isAuthenticated: true,
      connectedAt: null,
      isApiKey: false,
      type: 'codex',
    });

    it('re-stamps the chat onto another Claude login, then resends the failed turn', async () => {
      renderAfterError('RATE_LIMIT_SDK', [...snap.defaultListAccounts, codexRow('acc-x', 'Work')]);

      const buttons = screen.getAllByRole('button').map((b) => b.textContent);
      expect(buttons).toEqual(['Retry with Backup']);
      await userEvent.setup().click(screen.getByRole('button', { name: 'Retry with Backup' }));

      expect(snap.setChatAccountMutate).toHaveBeenCalledWith(
        { chatId: 'chat-1', accountId: 'acc-2' },
        { onSuccess: onRetry },
      );
      snap.setChatAccountOpts?.onSuccess(undefined, { chatId: 'chat-1' });
      expect(snap.resolvedAccountInvalidate).toHaveBeenCalledWith({ chatId: 'chat-1' });
    });

    it('offers Add account, opening Settings, when no other Claude login is signed in', async () => {
      const [active, backup] = snap.defaultListAccounts;
      const store = renderAfterError('RATE_LIMIT_SDK', [
        active,
        { ...backup, isAuthenticated: false },
        codexRow('acc-x', 'Work'),
      ]);

      expect(screen.queryByText(/Retry with/)).not.toBeInTheDocument();
      await userEvent.setup().click(screen.getByRole('button', { name: 'Add another AI account' }));

      expect(store.get(agentsSettingsDialogActiveTabAtom)).toBe('models');
    });

    it('offers nothing beside Retry in a Codex chat', () => {
      renderAfterError(
        'RATE_LIMIT_SDK',
        [...snap.defaultListAccounts, codexRow('acc-x', 'Work')],
        'codex',
      );

      expect(screen.queryByRole('button')).not.toBeInTheDocument();
    });

    it('stays hidden for errors other than a usage limit', () => {
      renderAfterError('NETWORK_ERROR', snap.defaultListAccounts);

      expect(screen.queryByRole('button')).not.toBeInTheDocument();
    });
  });
});
