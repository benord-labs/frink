// @vitest-environment happy-dom

import '@testing-library/jest-dom/vitest';
import { cleanup, render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { createStore, Provider } from 'jotai';
import { toast } from 'sonner';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { activeOverlayAtom, agentsSettingsDialogActiveTabAtom } from '../../../lib/atoms';
import { selectedAgentChatIdAtom, splitViewAtom } from '../atoms';
import { AccountIndicator } from './account-indicator';

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
    forkMutate: vi.fn(),
    listCountsInvalidate: vi.fn(),
    resolvedAccountInvalidate: vi.fn(),
    listAccountsData: [...defaultListAccounts] as ListAccount[],
    defaultListAccounts,
    setDefaultIsPending: false,
    setProjectAccountIsPending: false,
  };
});

const getResolvedAccountMock = vi.fn();

vi.mock('../../../lib/trpc', () => ({
  trpc: {
    useUtils: () => ({
      chats: { listCounts: { invalidate: snap.listCountsInvalidate } },
      claudeCode: {
        listAccounts: { invalidate: vi.fn() },
        getResolvedAccount: { invalidate: snap.resolvedAccountInvalidate },
        getProjectAccount: { invalidate: vi.fn() },
      },
    }),
    chats: {
      setChatAccount: {
        useMutation: (opts: typeof snap.setChatAccountOpts) => {
          snap.setChatAccountOpts = opts;
          return { mutate: snap.setChatAccountMutate, isPending: false };
        },
      },
      fork: { useMutation: () => ({ mutate: snap.forkMutate, isPending: false }) },
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
      setDefault: {
        useMutation: () => ({
          mutate: snap.setDefaultMutate,
          isPending: snap.setDefaultIsPending,
        }),
      },
      setProjectAccount: {
        useMutation: () => ({
          mutate: snap.setProjectAccountMutate,
          isPending: snap.setProjectAccountIsPending,
        }),
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
  snap.forkMutate.mockReset();
  snap.listCountsInvalidate.mockReset();
  snap.resolvedAccountInvalidate.mockReset();
  vi.mocked(toast.success).mockReset();
  snap.listAccountsData = [...snap.defaultListAccounts];
  snap.setDefaultIsPending = false;
  snap.setProjectAccountIsPending = false;
});

describe('AccountIndicator', () => {
  it('opens Settings → Accounts from the Add account row', async () => {
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

    await user.click(screen.getByRole('menuitem', { name: /Add account/i }));

    expect(store.get(agentsSettingsDialogActiveTabAtom)).toBe('models');
    expect(store.get(activeOverlayAtom)).toBe('settings');
  });

  it('calls setDefault when selecting another account without a project scope', async () => {
    const user = userEvent.setup();

    getResolvedAccountMock.mockReturnValue({
      data: {
        id: 'acc-1',
        label: 'Slice',
        type: 'claude-code' as const,
        isProjectOverride: false,
        isAuthenticated: true,
        projectId: null,
      },
      isLoading: false,
    });

    render(
      <Provider store={createStore()}>
        <AccountIndicator />
      </Provider>,
    );

    await user.click(screen.getByRole('button', { name: 'AI accounts menu, Slice, Claude Code' }));

    await user.click(screen.getByRole('menuitem', { name: /Backup/ }));

    expect(snap.setDefaultMutate).toHaveBeenCalledWith(
      { id: 'acc-2' },
      { onSuccess: expect.any(Function) },
    );
    expect(snap.setProjectAccountMutate).not.toHaveBeenCalled();
  });

  it('disables accounts that are not signed in on this machine', async () => {
    const user = userEvent.setup();
    snap.listAccountsData = [
      ...snap.defaultListAccounts,
      {
        id: 'acc-unauth',
        label: 'NeedsLogin',
        isDefault: false,
        isAuthenticated: false,
        connectedAt: null,
        isApiKey: false,
        type: 'claude-code',
      },
    ];

    getResolvedAccountMock.mockReturnValue({
      data: {
        id: 'acc-1',
        label: 'Slice',
        type: 'claude-code' as const,
        isProjectOverride: false,
        isAuthenticated: true,
        projectId: null,
      },
      isLoading: false,
    });

    render(
      <Provider store={createStore()}>
        <AccountIndicator />
      </Provider>,
    );

    await user.click(screen.getByRole('button', { name: 'AI accounts menu, Slice, Claude Code' }));

    const unauthItem = screen.getByRole('menuitem', {
      name: /NeedsLogin, Claude Code, not signed in on this machine/i,
    });
    expect(unauthItem).toHaveAttribute('aria-disabled', 'true');

    await user.click(screen.getByRole('menuitem', { name: /Backup/ }));
    expect(snap.setDefaultMutate).toHaveBeenCalledWith(
      { id: 'acc-2' },
      { onSuccess: expect.any(Function) },
    );
  });

  it('tooltip scope line says workspace default for project when not project override', () => {
    getResolvedAccountMock.mockReturnValue({
      data: {
        id: 'acc-1',
        label: 'Slice',
        type: 'claude-code' as const,
        isProjectOverride: false,
        isAuthenticated: true,
        projectId: 'proj-1',
      },
      isLoading: false,
    });

    render(
      <Provider store={createStore()}>
        <AccountIndicator projectId="proj-1" />
      </Provider>,
    );

    const tooltip = screen.getByTestId('tooltip-content');
    expect(tooltip).toHaveTextContent(/Workspace default for this project/);
    expect(tooltip).toHaveTextContent(/Choosing an account sets the AI account for this project/);
  });

  it('requests getResolvedAccount with projectId when new-chat header passes only projectId', () => {
    getResolvedAccountMock.mockReturnValue({
      data: {
        id: 'acc-1',
        label: 'Slice',
        type: 'claude-code' as const,
        isProjectOverride: false,
        isAuthenticated: true,
        projectId: 'proj-new',
      },
      isLoading: false,
    });

    render(
      <Provider store={createStore()}>
        <AccountIndicator projectId="proj-new" />
      </Provider>,
    );

    expect(getResolvedAccountMock).toHaveBeenCalled();
    const input = getResolvedAccountMock.mock.calls[0]?.[0] as Record<string, unknown> | undefined;
    expect(input).toEqual({ projectId: 'proj-new' });
  });

  it('calls setProjectAccount when selecting another account from projectId-only (new-chat) context', async () => {
    const user = userEvent.setup();

    getResolvedAccountMock.mockReturnValue({
      data: {
        id: 'acc-1',
        label: 'Slice',
        type: 'claude-code' as const,
        isProjectOverride: false,
        isAuthenticated: true,
        projectId: 'proj-new',
      },
      isLoading: false,
    });

    render(
      <Provider store={createStore()}>
        <AccountIndicator projectId="proj-new" />
      </Provider>,
    );

    await user.click(screen.getByRole('button', { name: 'AI accounts menu, Slice, Claude Code' }));

    await user.click(screen.getByRole('menuitem', { name: /Backup/ }));

    expect(snap.setProjectAccountMutate).toHaveBeenCalledWith(
      { projectId: 'proj-new', accountId: 'acc-2' },
      { onSuccess: expect.any(Function) },
    );
    expect(snap.setDefaultMutate).not.toHaveBeenCalled();
  });

  it('does not call account mutations when selecting the active row in a project-scoped chat', async () => {
    const user = userEvent.setup();

    getResolvedAccountMock.mockReturnValue({
      data: {
        id: 'acc-1',
        label: 'Slice',
        type: 'claude-code' as const,
        isProjectOverride: false,
        isAuthenticated: true,
        projectId: 'proj-1',
      },
      isLoading: false,
    });

    render(
      <Provider store={createStore()}>
        <AccountIndicator chatId="chat-1" />
      </Provider>,
    );

    await user.click(screen.getByRole('button', { name: 'AI accounts menu, Slice, Claude Code' }));

    await user.click(screen.getByRole('menuitem', { name: /^Slice/ }));

    expect(snap.setDefaultMutate).not.toHaveBeenCalled();
    expect(snap.setProjectAccountMutate).not.toHaveBeenCalled();
    expect(snap.setChatAccountMutate).not.toHaveBeenCalled();
  });

  it('calls setProjectAccount with the Codex row id when switching to a Codex account in project scope', async () => {
    const user = userEvent.setup();
    snap.listAccountsData = [
      ...snap.defaultListAccounts,
      {
        id: 'acc-codex',
        label: 'CodexWork',
        isDefault: false,
        isAuthenticated: true,
        connectedAt: null,
        isApiKey: false,
        type: 'codex' as const,
      },
    ];

    getResolvedAccountMock.mockReturnValue({
      data: {
        id: 'acc-1',
        label: 'Slice',
        type: 'claude-code' as const,
        isProjectOverride: false,
        isAuthenticated: true,
        projectId: 'proj-1',
      },
      isLoading: false,
    });

    render(
      <Provider store={createStore()}>
        <AccountIndicator projectId="proj-1" />
      </Provider>,
    );

    await user.click(screen.getByRole('button', { name: 'AI accounts menu, Slice, Claude Code' }));

    await user.click(screen.getByRole('menuitem', { name: /CodexWork/ }));

    expect(snap.setProjectAccountMutate).toHaveBeenCalledWith(
      { projectId: 'proj-1', accountId: 'acc-codex' },
      { onSuccess: expect.any(Function) },
    );
    expect(snap.setDefaultMutate).not.toHaveBeenCalled();

    // Regression-lock the at-switch tell: invoking the mutation's onSuccess fires
    // the "what changed" toast for a cross-tool (Claude → Codex) pick.
    const opts = snap.setProjectAccountMutate.mock.calls[0]?.[1] as
      | { onSuccess?: () => void }
      | undefined;
    opts?.onSuccess?.();
    expect(vi.mocked(toast.success)).toHaveBeenCalledWith(
      'Now running on OpenAI',
      expect.objectContaining({ description: expect.stringContaining('came with you') }),
    );
  });

  it('shows empty list copy when listAccounts is empty but resolved account exists', async () => {
    const user = userEvent.setup();
    snap.listAccountsData = [];

    getResolvedAccountMock.mockReturnValue({
      data: {
        label: 'Orphan',
        type: 'claude-code' as const,
        isProjectOverride: false,
        isAuthenticated: true,
        projectId: null,
      },
      isLoading: false,
    });

    render(
      <Provider store={createStore()}>
        <AccountIndicator chatId="chat-1" />
      </Provider>,
    );

    await user.click(screen.getByRole('button', { name: 'AI accounts menu, Orphan, Claude Code' }));

    expect(screen.getByText('No accounts configured.')).toBeInTheDocument();
    expect(screen.getByRole('menuitem', { name: /Add account/i })).toBeInTheDocument();
  });

  it('marks exactly one row active when two accounts share the same label', async () => {
    const user = userEvent.setup();
    snap.listAccountsData = [
      {
        id: 'c1',
        label: 'Shared',
        isDefault: true,
        isAuthenticated: true,
        connectedAt: null,
        isApiKey: false,
        type: 'claude-code' as const,
      },
      {
        id: 'c2',
        label: 'Shared',
        isDefault: false,
        isAuthenticated: true,
        connectedAt: null,
        isApiKey: false,
        type: 'codex' as const,
      },
    ];

    getResolvedAccountMock.mockReturnValue({
      data: {
        id: 'c2',
        label: 'Shared',
        type: 'codex' as const,
        isProjectOverride: false,
        isAuthenticated: true,
      },
      isLoading: false,
    });

    render(
      <Provider store={createStore()}>
        <AccountIndicator chatId="chat-1" />
      </Provider>,
    );

    await user.click(screen.getByRole('button', { name: 'AI accounts menu, Shared, OpenAI' }));

    const items = screen
      .getAllByRole('menuitem')
      .filter((el) => el.textContent?.includes('Shared'));
    expect(items).toHaveLength(2);

    const codexRow = items.find((el) => el.textContent?.includes('OpenAI'));
    const claudeRow = items.find((el) => el.textContent?.includes('Claude Code'));
    expect(codexRow).toBeTruthy();
    expect(claudeRow).toBeTruthy();
    if (codexRow == null || claudeRow == null) {
      throw new Error('expected both Shared rows');
    }

    expect(within(codexRow).getByLabelText('Active')).toBeInTheDocument();
    expect(within(claudeRow).queryByLabelText('Active')).toBeNull();
  });

  it('does not call setDefault when selecting the already-active account row', async () => {
    const user = userEvent.setup();

    getResolvedAccountMock.mockReturnValue({
      data: {
        id: 'acc-1',
        label: 'Slice',
        type: 'claude-code' as const,
        isProjectOverride: false,
        isAuthenticated: true,
        projectId: null,
      },
      isLoading: false,
    });

    render(
      <Provider store={createStore()}>
        <AccountIndicator chatId="chat-1" />
      </Provider>,
    );

    await user.click(screen.getByRole('button', { name: 'AI accounts menu, Slice, Claude Code' }));

    await user.click(screen.getByRole('menuitem', { name: /^Slice/ }));

    expect(snap.setDefaultMutate).not.toHaveBeenCalled();
    expect(snap.setProjectAccountMutate).not.toHaveBeenCalled();
  });

  it('disables account rows while setDefault is pending', async () => {
    const user = userEvent.setup();
    snap.setDefaultIsPending = true;

    getResolvedAccountMock.mockReturnValue({
      data: {
        id: 'acc-1',
        label: 'Slice',
        type: 'claude-code' as const,
        isProjectOverride: false,
        isAuthenticated: true,
        projectId: null,
      },
      isLoading: false,
    });

    render(
      <Provider store={createStore()}>
        <AccountIndicator />
      </Provider>,
    );

    await user.click(screen.getByRole('button', { name: 'AI accounts menu, Slice, Claude Code' }));

    const sliceItem = screen.getByRole('menuitem', { name: /^Slice/ });
    const backupItem = screen.getByRole('menuitem', { name: /Backup/ });
    expect(sliceItem).toHaveAttribute('aria-disabled', 'true');
    expect(backupItem).toHaveAttribute('aria-disabled', 'true');
    expect(screen.getByRole('menuitem', { name: /Add account/i })).not.toHaveAttribute(
      'aria-disabled',
      'true',
    );
  });

  it('disables account rows while setProjectAccount is pending', async () => {
    const user = userEvent.setup();
    snap.setProjectAccountIsPending = true;

    getResolvedAccountMock.mockReturnValue({
      data: {
        id: 'acc-1',
        label: 'Slice',
        type: 'claude-code' as const,
        isProjectOverride: false,
        isAuthenticated: true,
        projectId: 'proj-1',
      },
      isLoading: false,
    });

    render(
      <Provider store={createStore()}>
        <AccountIndicator projectId="proj-1" />
      </Provider>,
    );

    await user.click(screen.getByRole('button', { name: 'AI accounts menu, Slice, Claude Code' }));

    const sliceItem = screen.getByRole('menuitem', { name: /^Slice/ });
    const backupItem = screen.getByRole('menuitem', { name: /Backup/ });
    expect(sliceItem).toHaveAttribute('aria-disabled', 'true');
    expect(backupItem).toHaveAttribute('aria-disabled', 'true');
  });

  it('sets models tab when choosing Add account while settings overlay is already open on another tab', async () => {
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
    await user.click(screen.getByRole('menuitem', { name: /Add account/i }));

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

  it('shows project-scoped dropdown copy before a project chat exists', async () => {
    const user = userEvent.setup();

    getResolvedAccountMock.mockReturnValue({
      data: {
        label: 'ProjAcct',
        type: 'claude-code' as const,
        isProjectOverride: true,
        isAuthenticated: true,
        projectId: 'proj-1',
      },
      isLoading: false,
    });

    render(
      <Provider store={createStore()}>
        <AccountIndicator projectId="proj-1" />
      </Provider>,
    );

    await user.click(
      screen.getByRole('button', {
        name: 'AI accounts menu, ProjAcct, Claude Code, project-specific default',
      }),
    );

    expect(
      within(screen.getByRole('menu')).getByText(/sets the AI account for this project/i),
    ).toBeInTheDocument();
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

    async function openChatMenu(store = createStore()) {
      snap.listAccountsData = [...snap.defaultListAccounts, codexRow];
      getResolvedAccountMock.mockReturnValue({
        data: { id: 'acc-1', label: 'Slice', type: 'claude-code' as const, isAuthenticated: true },
        isLoading: false,
      });
      render(
        <Provider store={store}>
          <AccountIndicator chatId="chat-1" />
        </Provider>,
      );
      await userEvent
        .setup()
        .click(screen.getByRole('button', { name: /AI accounts menu, Slice/ }));
      return store;
    }

    it('lists same-provider logins, then other providers as Continue in rows', async () => {
      await openChatMenu();

      const rows = screen.getAllByRole('menuitem').map((el) => el.textContent);
      expect(rows).toEqual([
        'Backup · Claude Code',
        'Slice · Claude Code',
        'Continue in OpenAI (CodexWork)',
        'Add account…',
      ]);
      expect(screen.getByText('Claude Code logins for this chat')).toBeInTheDocument();
    });

    it('swaps a same-provider login in place, leaving project and default alone', async () => {
      await openChatMenu();

      await userEvent.setup().click(screen.getByRole('menuitem', { name: /Backup/ }));

      expect(snap.setChatAccountMutate).toHaveBeenCalledWith(
        { chatId: 'chat-1', accountId: 'acc-2' },
        { onSuccess: expect.any(Function) },
      );
      expect(snap.setProjectAccountMutate).not.toHaveBeenCalled();
      expect(snap.setDefaultMutate).not.toHaveBeenCalled();
      expect(snap.forkMutate).not.toHaveBeenCalled();

      const vars = { chatId: 'chat-1' };
      snap.setChatAccountOpts?.onSuccess(undefined, vars);
      snap.setChatAccountMutate.mock.calls[0]?.[1].onSuccess();
      expect(snap.resolvedAccountInvalidate).toHaveBeenCalledWith(vars);
      expect(vi.mocked(toast.success)).toHaveBeenCalledWith('This chat now uses Backup');
    });

    it('continues in another provider as a fork, opens it and tells what followed', async () => {
      const store = await openChatMenu();

      await userEvent.setup().click(screen.getByRole('menuitem', { name: /Continue in OpenAI/ }));

      expect(snap.forkMutate).toHaveBeenCalledWith(
        { chatId: 'chat-1', accountId: 'acc-codex' },
        { onSuccess: expect.any(Function) },
      );
      expect(snap.setChatAccountMutate).not.toHaveBeenCalled();
      const opts = snap.forkMutate.mock.calls[0]?.[1] as {
        onSuccess: (forked: { id: string; name: string | null }) => void;
      };
      opts.onSuccess({ id: 'chat-2', name: 'Refactor auth · OpenAI' });

      expect(snap.listCountsInvalidate).toHaveBeenCalled();
      expect(store.get(selectedAgentChatIdAtom)).toBe('chat-2');
      expect(vi.mocked(toast.success)).toHaveBeenCalledWith(
        'Now running on OpenAI',
        expect.objectContaining({ description: expect.stringContaining('came with you') }),
      );
    });

    it('puts the fork in the source chat pane in split view', async () => {
      const store = createStore();
      store.set(splitViewAtom, (prev) => ({
        ...prev,
        chatIds: ['other', 'chat-1'],
        activePaneIndex: 1,
      }));
      await openChatMenu(store);

      await userEvent.setup().click(screen.getByRole('menuitem', { name: /Continue in OpenAI/ }));
      const opts = snap.forkMutate.mock.calls[0]?.[1] as {
        onSuccess: (forked: { id: string; name: string | null }) => void;
      };
      opts.onSuccess({ id: 'chat-2', name: null });

      expect(store.get(splitViewAtom).chatIds).toEqual(['other', 'chat-2']);
    });
  });
});
