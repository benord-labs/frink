// @vitest-environment happy-dom
import '@testing-library/jest-dom/vitest';
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import type { Getter, Setter } from 'jotai';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { PluginConnection, PluginDefinition } from '../../../../shared/integrations/plugins';
import { PLUGIN_DEFINITIONS, resolvePlugins } from '../../../../shared/integrations/plugins';
import { PluginDetail } from './index';

type TokenInput = { pluginId: string; token: string };

const {
  pluginsListUseQueryMock,
  launchFlowMock,
  uninstallMutateMock,
  setEnabledMutateMock,
  vendorMcpStatusUseQueryMock,
  connectVendorMcpMutateMock,
  connectUserTokenMutateMock,
  connectWebhookOnlyMock,
  generateWebhookEndpointMock,
} = vi.hoisted(() => ({
  pluginsListUseQueryMock: vi.fn(),
  launchFlowMock: vi.fn(),
  uninstallMutateMock: vi.fn(),
  setEnabledMutateMock: vi.fn(),
  vendorMcpStatusUseQueryMock: vi.fn(),
  connectVendorMcpMutateMock: vi.fn(),
  connectUserTokenMutateMock: vi.fn<(input: TokenInput) => void>(),
  connectWebhookOnlyMock: vi.fn(async (_input: { provider: string; label: string }) => ({
    success: true as const,
    integration: { id: 'int-new', provider: 'posthog', accountIdentifier: 'PostHog' },
  })),
  generateWebhookEndpointMock: vi.fn(async (_input: { integrationId: string }) => ({
    success: true as const,
    endpoint: { lastError: null },
  })),
}));

vi.mock('../../../lib/trpc', () => ({
  trpc: {
    plugins: {
      list: { useQuery: pluginsListUseQueryMock },
      uninstall: { useMutation: () => ({ mutate: uninstallMutateMock, isPending: false }) },
      setEnabled: { useMutation: () => ({ mutate: setEnabledMutateMock, isPending: false }) },
      vendorMcpStatus: { useQuery: vendorMcpStatusUseQueryMock },
      connectAttemptEnded: { useMutation: () => ({ mutate: vi.fn(), isPending: false }) },
      connectUserToken: {
        useMutation: (handlers: { onSuccess?: () => void }) => ({
          mutate: (input: TokenInput) => {
            connectUserTokenMutateMock(input);
            handlers.onSuccess?.();
          },
          isPending: false,
          error: null,
        }),
      },
      connectVendorMcp: {
        useMutation: () => ({ mutate: connectVendorMcpMutateMock, isPending: false }),
      },
    },
    integrations: {
      connectWebhookOnly: {
        useMutation: () => ({ mutateAsync: connectWebhookOnlyMock, isPending: false }),
      },
      generateWebhookEndpoint: {
        useMutation: () => ({ mutateAsync: generateWebhookEndpointMock, isPending: false }),
      },
    },
    useUtils: () => ({
      plugins: { list: { invalidate: vi.fn() }, vendorMcpStatus: { invalidate: vi.fn() } },
      triggerSetup: { options: { invalidate: vi.fn() } },
      integrations: { invalidate: vi.fn() },
      customNodes: { list: { invalidate: vi.fn() } },
    }),
  },
}));

// The chat-only fixture below is not a catalog row; the lifecycle surfaces key on this predicate.
// oxlint-disable-next-line anti-slop/no-module-mocking
vi.mock('../../../../shared/integrations/installable-plugins', async (importOriginal) => {
  const original =
    await importOriginal<typeof import('../../../../shared/integrations/installable-plugins')>();
  return {
    ...original,
    isInstallablePluginId: (id: string) => id === 'wiki' || original.isInstallablePluginId(id),
  };
});

vi.mock('../../../lib/plugins/use-plugin-flow-launch', () => ({
  usePluginFlowLaunch: () => launchFlowMock,
}));

// oxlint-disable anti-slop/no-module-mocking -- vitest requires vi.mock per file; unmocked, the
// agents barrel crashes this suite at import time (tRPC, editor).
const { seededPrompts } = vi.hoisted(() => {
  const prompts: string[] = [];
  return { seededPrompts: prompts };
});
vi.mock('@/features/agents', async () => {
  const { atom } = await import('jotai');
  return {
    seedNewChatPromptAtom: atom(null, (_get: Getter, _set: Setter, prompt: string) => {
      seededPrompts.push(prompt);
    }),
  };
});

// The trigger card has its own suite; here it only needs to be findable on the page.
vi.mock('./PluginTriggers/TriggerCard', () => ({
  TriggerCard: ({ onRetrySetup }: { onRetrySetup?: () => void }) => (
    <div data-testid="trigger-card">
      {onRetrySetup ? <button onClick={onRetrySetup}>Try again</button> : null}
    </div>
  ),
}));

function listResult(connections: ReadonlyArray<PluginConnection> = []) {
  return { plugins: resolvePlugins({ installations: [], connections }) };
}

function mockQuery(state: { isLoading?: boolean; isError?: boolean; data?: unknown }) {
  pluginsListUseQueryMock.mockReturnValue({
    isLoading: false,
    isError: false,
    data: undefined,
    ...state,
  });
}

const onBack = vi.fn();
const onConnect = vi.fn();
const onSelectAccount = vi.fn();

function renderPage(props: Partial<Parameters<typeof PluginDetail>[0]> = {}) {
  return render(
    <PluginDetail
      pluginId="shortcut"
      isConnecting={false}
      onBack={onBack}
      onConnect={onConnect}
      onSelectAccount={onSelectAccount}
      {...props}
    />,
  );
}

const LIVE_SHORTCUT: ReadonlyArray<PluginConnection> = [
  { id: 'c1', providerId: 'shortcut', accountName: 'Acme', isActive: true },
];

beforeEach(() => {
  pluginsListUseQueryMock.mockReset();
  vendorMcpStatusUseQueryMock.mockReset();
  connectVendorMcpMutateMock.mockReset();
  vendorMcpStatusUseQueryMock.mockReturnValue({ data: { connected: [], awaitingAuth: [] } });
  launchFlowMock.mockReset();
  seededPrompts.length = 0;
  onBack.mockReset();
  onConnect.mockReset();
  onSelectAccount.mockReset();
  mockQuery({ data: listResult() });
});

afterEach(cleanup);

const INSTALLED_LINEAR = {
  id: 'install-linear',
  pluginId: 'linear',
  sourceKind: 'frink_builtin' as const,
  sourceLocator: null,
  installedVersion: null,
  isInstalled: true,
  isEnabled: true,
};

const LIVE_LINEAR: ReadonlyArray<PluginConnection> = [
  { id: 'linear-c1', providerId: 'linear', accountName: 'Acme Linear', isActive: true },
];

describe('PluginDetail', () => {
  it('shows package skills and carousel examples before an account is connected', () => {
    renderPage({ pluginId: 'clickup' });
    expect(screen.getByText('daily-standup')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Next slide' })).toBeInTheDocument();
    expect(connectVendorMcpMutateMock).not.toHaveBeenCalled();
  });

  it('shows all Neon skills without package discovery when account status is unavailable', () => {
    mockQuery({ data: listResult() });
    renderPage({ pluginId: 'neon' });
    expect(screen.getByText('Skills (7)')).toBeInTheDocument();
    expect(screen.getByText('neon-postgres')).toBeInTheDocument();
    expect(screen.queryByText('Loading package skills…')).not.toBeInTheDocument();
    expect(connectVendorMcpMutateMock).not.toHaveBeenCalled();
  });

  it('starts official ClickUp installation before a runtime MCP server exists', () => {
    mockQuery({ data: listResult() });
    vendorMcpStatusUseQueryMock.mockReturnValue({ data: { connected: [], awaitingAuth: [] } });
    renderPage({ pluginId: 'clickup' });
    const connect = screen.getByRole('button', { name: 'Connect ClickUp' });
    fireEvent.click(connect);
    fireEvent.click(connect);
    expect(connectVendorMcpMutateMock).toHaveBeenCalledExactlyOnceWith({ pluginName: 'clickup' });
    expect(onConnect).not.toHaveBeenCalled();
  });

  it('lists what the package contains before any account is connected', () => {
    renderPage();

    expect(screen.getByText('Tools (7)')).toBeInTheDocument();
    expect(screen.getByText('Create Shortcut story')).toBeInTheDocument();
    expect(screen.getByText(/Triggers \(\d+\)/)).toBeInTheDocument();
  });

  it('says what the plugin is for, not only what it contains', () => {
    renderPage();

    const shortcut = PLUGIN_DEFINITIONS.find((plugin) => plugin.id === 'shortcut');
    // The tagline names the domain; the paragraph explains the purpose. Both render.
    expect(screen.getByText(shortcut?.description ?? '')).toBeInTheDocument();
    expect(screen.getByText(shortcut?.longDescription ?? '')).toBeInTheDocument();
  });

  it('renders no paragraph for a package that ships none', () => {
    const [shortcut, ...rest] = resolvePlugins({
      installations: [],
      connections: [],
    });
    const stripped = {
      ...shortcut,
      definition: { ...shortcut.definition, longDescription: undefined },
    };
    mockQuery({ data: { plugins: [stripped, ...rest] } });
    renderPage();

    // An imported package without a paragraph gets silence, never a placeholder
    // sentence asserting something about itself.
    expect(screen.getByText(stripped.definition.description)).toBeInTheDocument();
    expect(screen.queryByText(/^Frink watches your Shortcut/)).not.toBeInTheDocument();
  });

  it('shows the webhook card on the page once an account can receive triggers', () => {
    // Trigger addresses live on accounts this machine holds, never on a hosted account.
    mockQuery({ data: listResult(LIVE_SHORTCUT) });
    renderPage();
    expect(screen.getByTestId('trigger-card')).toBeInTheDocument();
  });

  it('states the runtime contract exactly once, beside the trigger setup', () => {
    mockQuery({ data: listResult(LIVE_SHORTCUT) });
    renderPage();
    // Repeating it on the Triggers row printed the same sentence twice on one page.
    expect(screen.getAllByText('Frink must be open for triggers to run.')).toHaveLength(1);
  });

  it('keeps a coming-soon plugin inspectable and labels it truthfully', () => {
    renderPage({ pluginId: 'docusign' });

    expect(screen.getByText('Coming soon')).toBeInTheDocument();
    expect(screen.getByText('Works in')).toBeInTheDocument();
    for (const runtime of ['Claude Code', 'Codex']) {
      const row = screen.getByRole('row', { name: new RegExp(runtime) });
      expect(
        within(row)
          .getAllByRole('cell')
          .map((cell) => cell.textContent),
      ).toEqual(['No', 'No', 'No', 'No', 'No']);
    }
    expect(screen.queryByText(/can't be connected yet/)).not.toBeInTheDocument();
  });

  it('names every reachable runtime rather than omitting an unsupported one', () => {
    renderPage();

    expect(screen.getByText('Works in')).toBeInTheDocument();
    expect(screen.getByText('Claude Code')).toBeInTheDocument();
    expect(screen.getByText('Codex')).toBeInTheDocument();
    expect(screen.getByText('Information')).toBeInTheDocument();
  });

  it('badges a live required account Connected rather than inheriting the install axis', () => {
    // Generic Webhook declares no chat tools, so its account is the one grant and the
    // only real 'available' provider left whose account is still mandatory.
    mockQuery({
      data: listResult([
        { id: 'w1', providerId: 'generic_webhook', accountName: 'Acme', isActive: true },
      ]),
    });
    renderPage({ pluginId: 'generic_webhook' });

    expect(screen.getByText('Connected')).toBeInTheDocument();
    expect(screen.queryByText('Not installed')).not.toBeInTheDocument();
  });

  // A hosted account holds no trigger address; the offer stays up until this machine mints one.
  it('mints a trigger account on this machine before the address card can render', async () => {
    mockQuery({ data: listResult() });
    renderPage({ pluginId: 'linear' });

    expect(screen.queryByTestId('trigger-card')).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Set up events' }));
    await waitFor(() =>
      expect(generateWebhookEndpointMock).toHaveBeenCalledWith({ integrationId: 'int-new' }),
    );
    expect(connectWebhookOnlyMock).toHaveBeenCalledWith({ provider: 'linear', label: 'Linear' });
  });

  it('offers example prompts only once an account is live, and seeds the composer on click', async () => {
    mockQuery({ data: listResult(LIVE_SHORTCUT) });
    renderPage();

    fireEvent.click(screen.getByRole('button', { name: 'Show slide 3 of 5' }));
    fireEvent.click(
      screen.getByRole('button', {
        name: /Use this prompt in chat: What is assigned to me in Shortcut/,
      }),
    );
    await vi.dynamicImportSettled();
    expect(seededPrompts).toEqual([
      'What is assigned to me in Shortcut right now? Rank it by what to tackle first',
    ]);
  });

  it('drops a stale seed when the user leaves the page before the chunk loads', async () => {
    mockQuery({ data: listResult(LIVE_SHORTCUT) });
    const { unmount } = renderPage();

    fireEvent.click(screen.getByRole('button', { name: 'Show slide 3 of 5' }));
    fireEvent.click(
      screen.getByRole('button', {
        name: /Use this prompt in chat: What is assigned to me in Shortcut/,
      }),
    );
    unmount();
    await vi.dynamicImportSettled();
    expect(seededPrompts).toEqual([]);
  });

  it('seeds only the newest prompt when two are clicked before the chunk loads', async () => {
    mockQuery({ data: listResult(LIVE_SHORTCUT) });
    renderPage();

    fireEvent.click(screen.getByRole('button', { name: 'Show slide 3 of 5' }));
    fireEvent.click(
      screen.getByRole('button', {
        name: /Use this prompt in chat: What is assigned to me in Shortcut/,
      }),
    );
    fireEvent.click(screen.getByRole('button', { name: 'Show slide 4 of 5' }));
    fireEvent.click(screen.getByRole('button', { name: /Use this prompt in chat: Summarize/ }));
    await vi.dynamicImportSettled();
    expect(seededPrompts).toEqual([
      'Summarize the Shortcut stories that moved this week and what is still blocked',
    ]);
  });

  it('routes a prompt click to Connect while nothing is connected, seeding nothing', async () => {
    renderPage();

    fireEvent.click(screen.getByRole('button', { name: 'Show slide 3 of 5' }));
    fireEvent.click(
      screen.getByRole('button', {
        name: /Connect Shortcut to use this prompt in chat: What is assigned to me/,
      }),
    );
    await vi.dynamicImportSettled();
    expect(connectVendorMcpMutateMock).toHaveBeenCalledWith({ pluginName: 'shortcut' });
    expect(onConnect).not.toHaveBeenCalled();
    expect(seededPrompts).toEqual([]);
  });

  describe('header actions', () => {
    it("reaches the one live account's details through the actions menu, never a headline button", () => {
      mockQuery({ data: listResult(LIVE_SHORTCUT) });
      renderPage();

      expect(screen.queryByRole('button', { name: 'Manage account' })).not.toBeInTheDocument();
      fireEvent.pointerDown(screen.getByLabelText('More actions for Shortcut'));
      fireEvent.click(screen.getByRole('menuitem', { name: 'Account details' }));
      expect(onSelectAccount).toHaveBeenCalledWith('c1');
    });

    it('offers only Connect when there is no account yet', () => {
      renderPage();

      expect(screen.queryByRole('button', { name: 'Manage account' })).not.toBeInTheDocument();
      expect(screen.queryByRole('button', { name: 'Disconnect' })).not.toBeInTheDocument();
      expect(screen.getByRole('button', { name: 'Connect Shortcut' })).toBeInTheDocument();
    });

    it('keeps Connect reachable when a delivery error arrives with no listed account', () => {
      // The escape hatch recorded in docs/decisions/frink-integration-plugin.md
      // (2026-08-22). This page is where that hatch lives — the directory row
      // offers no connect at all.
      renderPage();

      expect(screen.getByRole('button', { name: 'Connect Shortcut' })).toBeInTheDocument();
    });

    it('does not offer Add on a connected webhook plugin', () => {
      mockQuery({
        data: listResult([{ id: 'w1', providerId: 'generic_webhook', isActive: true }]),
      });
      renderPage({ pluginId: 'generic_webhook' });

      expect(
        screen.queryByRole('button', { name: 'Add another Generic Webhook' }),
      ).not.toBeInTheDocument();
    });

    it('never offers a connect Frink would refuse to authorize', () => {
      renderPage({ pluginId: 'docusign' });
      expect(screen.queryByRole('button', { name: /Connect|Add/ })).not.toBeInTheDocument();
    });

    it('does not pick one of several accounts on the user’s behalf', () => {
      // Linear's chat tools are the grant that decides Connected; its account is optional
      // and purely informational here, so the tools grant must be live for this page too.
      vendorMcpStatusUseQueryMock.mockReturnValue({
        data: {
          connected: [{ serverName: 'plugin_linear_linear', pluginName: 'linear' }],
          awaitingAuth: [],
        },
      });
      mockQuery({
        data: listResult([
          { id: 'c1', providerId: 'linear', isActive: true },
          { id: 'c2', providerId: 'linear', isActive: true },
        ]),
      });
      renderPage({ pluginId: 'linear' });

      // Managing "the first of two" would strand the second, so a connected provider gets no header
      // button and the Accounts row disambiguates; Remove still sweeps either account.
      expect(screen.queryByRole('button', { name: 'Connect Linear' })).not.toBeInTheDocument();
      expect(
        screen.queryByRole('button', { name: 'Add another Linear account' }),
      ).not.toBeInTheDocument();
      fireEvent.pointerDown(screen.getByLabelText('More actions for Linear'));
      expect(screen.queryByRole('menuitem', { name: 'Account details' })).not.toBeInTheDocument();
      expect(screen.getByRole('menuitem', { name: 'Remove plugin' })).toBeInTheDocument();
    });

    it('spins only for its own plugin, never another provider’s connect', () => {
      renderPage({ isConnecting: false });
      expect(screen.getByRole('button', { name: 'Connect Shortcut' })).not.toBeDisabled();
    });
  });

  describe('the shell survives every failure', () => {
    it('keeps a way back while the catalogue loads', () => {
      mockQuery({ isLoading: true });
      renderPage();

      expect(screen.getByLabelText('Loading plugin capabilities')).toBeInTheDocument();
      expect(screen.getByRole('button', { name: 'Plugins' })).toBeInTheDocument();
    });

    it('keeps a way back when the catalogue cannot be read', () => {
      mockQuery({ isError: true });
      renderPage();

      expect(
        screen.getByText('Plugin capabilities are unavailable right now.'),
      ).toBeInTheDocument();
      // A dialog still had its close button; a page has only this.
      expect(screen.getByRole('button', { name: 'Plugins' })).toBeInTheDocument();
    });

    it('keeps a way back for a provider with no plugin package', () => {
      renderPage({ pluginId: 'not-a-plugin' });

      expect(screen.getByText('This provider has no plugin package.')).toBeInTheDocument();
      expect(screen.getByRole('button', { name: 'Plugins' })).toBeInTheDocument();
    });

    it('renders a usable catalogue through a failed refetch rather than discarding it', () => {
      // React Query keeps the previous data on a refetch failure. Checking
      // isError before data threw the whole page away for a transient blip.
      mockQuery({ isError: true, data: listResult(LIVE_SHORTCUT) });
      renderPage();

      expect(screen.getByText('Tools (7)')).toBeInTheDocument();
      expect(
        screen.queryByText('Plugin capabilities are unavailable right now.'),
      ).not.toBeInTheDocument();
    });
  });

  describe('Use in Flow', () => {
    it('launches a prefilled flow on the first active connection', () => {
      mockQuery({ data: listResult(LIVE_SHORTCUT) });
      renderPage();

      fireEvent.click(screen.getByRole('button', { name: 'Use in Flow' }));

      const shortcut = PLUGIN_DEFINITIONS.find((plugin) => plugin.id === 'shortcut');
      expect(launchFlowMock).toHaveBeenCalledWith({
        pluginName: 'Shortcut',
        trigger: shortcut?.contents.triggers[0],
        connectionId: 'c1',
      });
      expect(onConnect).not.toHaveBeenCalled();
    });

    it('mints the trigger address when no account is connected', async () => {
      renderPage();

      fireEvent.click(screen.getByRole('button', { name: 'Use in Flow' }));

      // The graph needs a real connection id; a flow drafted without one would be born broken, so
      // the button mints the address this machine can make instead of walking through chat consent.
      await waitFor(() =>
        expect(generateWebhookEndpointMock).toHaveBeenCalledWith({ integrationId: 'int-new' }),
      );
      expect(connectVendorMcpMutateMock).not.toHaveBeenCalled();
      expect(onConnect).not.toHaveBeenCalled();
      expect(launchFlowMock).not.toHaveBeenCalled();
    });

    it('offers no button for a turned-off plugin even with an active connection', () => {
      mockQuery({
        data: {
          plugins: resolvePlugins({
            installations: [{ ...INSTALLED_LINEAR, isEnabled: false }],
            connections: LIVE_LINEAR,
          }),
        },
      });
      renderPage({ pluginId: 'linear' });

      expect(screen.queryByRole('button', { name: 'Use in Flow' })).not.toBeInTheDocument();
      expect(launchFlowMock).not.toHaveBeenCalled();
    });

    it('offers no button on a coming-soon plugin it cannot connect', () => {
      renderPage({ pluginId: 'docusign' });
      expect(screen.queryByRole('button', { name: 'Use in Flow' })).not.toBeInTheDocument();
    });
  });

  describe('navigation', () => {
    it('goes back from the breadcrumb', () => {
      renderPage();
      fireEvent.click(screen.getByRole('button', { name: 'Plugins' }));
      expect(onBack).toHaveBeenCalledTimes(1);
    });

    it('takes focus on open so the keyboard does not restart at the app top', () => {
      renderPage();
      expect(document.activeElement).toBe(screen.getByRole('heading', { level: 1 }));
    });

    it('sends Escape back to the directory instead of closing Settings', () => {
      renderPage();

      const event = new KeyboardEvent('keydown', { key: 'Escape', cancelable: true });
      window.dispatchEvent(event);

      expect(onBack).toHaveBeenCalledTimes(1);
      // SettingsPage's own listener bails on defaultPrevented; without this the
      // whole Settings destination closes and the tab is lost too.
      expect(event.defaultPrevented).toBe(true);
    });

    it('leaves Escape alone while a field is being edited', () => {
      renderPage();
      const input = document.createElement('input');
      document.body.appendChild(input);
      input.focus();

      input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));

      expect(onBack).not.toHaveBeenCalled();
      input.remove();
    });
  });

  it('covers every builtin provider without throwing', () => {
    for (const plugin of PLUGIN_DEFINITIONS) {
      cleanup();
      expect(() => renderPage({ pluginId: plugin.id })).not.toThrow();
    }
  });
});

describe('PluginDisconnect menu (via PluginDetail header) [sc-2068]', () => {
  it('offers no destructive menu while the plugin is not installed', () => {
    mockQuery({ data: listResult() });
    renderPage({ pluginId: 'linear' });
    expect(screen.queryByLabelText('More actions for Linear')).not.toBeInTheDocument();
  });

  it('hides Manage for an installed, turned-on plugin with no account and no chat sign-in — only Connect', () => {
    mockQuery({
      data: {
        plugins: resolvePlugins({
          installations: [INSTALLED_LINEAR],
          connections: [],
        }),
      },
    });
    renderPage({ pluginId: 'linear' });

    expect(screen.getByRole('button', { name: 'Connect Linear' })).toBeInTheDocument();
    expect(screen.queryByLabelText('More actions for Linear')).not.toBeInTheDocument();
  });

  it.each(['huggingface', 'supabase'])(
    'gives a connected %s the shared lifecycle menu without Add',
    (pluginId) => {
      mockQuery({
        data: {
          plugins: resolvePlugins({
            installations: [{ ...INSTALLED_LINEAR, id: `install-${pluginId}`, pluginId }],
            connections: [{ id: 'webhook-account', providerId: pluginId, isActive: true }],
          }),
        },
      });
      renderPage({ pluginId });
      expect(screen.queryByRole('button', { name: /^Add/ })).not.toBeInTheDocument();
      fireEvent.pointerDown(screen.getByLabelText(/More actions for/));
      expect(screen.getByRole('menuitem', { name: 'Turn off plugin' })).toBeInTheDocument();
      expect(screen.getByRole('menuitem', { name: 'Remove plugin' })).toBeInTheDocument();
    },
  );

  it('turns an enabled plugin off through the reversible confirm dialog [sc-2068]', () => {
    mockQuery({
      data: {
        plugins: resolvePlugins({
          installations: [INSTALLED_LINEAR],
          connections: LIVE_LINEAR,
        }),
      },
    });
    renderPage({ pluginId: 'linear' });

    fireEvent.pointerDown(screen.getByLabelText('More actions for Linear'));
    fireEvent.click(screen.getByText('Turn off plugin'));

    expect(screen.getByText('Turn off Linear?')).toBeInTheDocument();
    expect(screen.getByText(/Flows using Linear stop starting/)).toBeInTheDocument();
    expect(screen.getByText(/Accounts stay connected/)).toBeInTheDocument();

    fireEvent.click(screen.getByText('Turn off', { selector: 'button' }));
    expect(setEnabledMutateMock).toHaveBeenCalledWith({ pluginId: 'linear', enabled: false });
  });

  it('while off, Turn on is the one headline switch and the menu offers only Remove [sc-2068]', () => {
    mockQuery({
      data: {
        plugins: resolvePlugins({
          installations: [{ ...INSTALLED_LINEAR, isEnabled: false }],
          connections: LIVE_LINEAR,
        }),
      },
    });
    renderPage({ pluginId: 'linear' });

    expect(screen.getByText('Turned off')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Turn on Linear' }));
    expect(setEnabledMutateMock).toHaveBeenCalledWith({ pluginId: 'linear', enabled: true });

    // The linked account stays reachable (disable retains the connection), under a neutral label.
    expect(screen.getByLabelText('More actions for Linear')).toHaveTextContent('Manage');
    fireEvent.pointerDown(screen.getByLabelText('More actions for Linear'));
    expect(screen.queryByText('Turn on plugin')).not.toBeInTheDocument();
    expect(screen.getByText('Remove plugin')).toBeInTheDocument();
  });

  it('removes an installed plugin through one honest confirm dialog', () => {
    mockQuery({
      data: {
        plugins: resolvePlugins({
          installations: [INSTALLED_LINEAR],
          connections: LIVE_LINEAR,
        }),
      },
    });
    renderPage({ pluginId: 'linear' });

    fireEvent.pointerDown(screen.getByLabelText('More actions for Linear'));
    fireEvent.click(screen.getByText('Remove plugin'));

    // The dialog names the account it will disconnect and states both honesty
    // clauses: session timing and the provider-side grant that outlives Frink's own sweep.
    expect(screen.getByText('Remove Linear?')).toBeInTheDocument();
    expect(screen.getByText(/Acme Linear gets disconnected first/)).toBeInTheDocument();
    expect(screen.getByText(/next time each chat starts a session/)).toBeInTheDocument();
    expect(screen.getByText(/Frink forgets its MCP authorization/)).toBeInTheDocument();

    fireEvent.click(screen.getByText('Remove'));
    expect(uninstallMutateMock).toHaveBeenCalledWith({ pluginId: 'linear' });
  });

  it('offers Remove but never Turn on for a leftover account from an older install with no installation row', () => {
    mockQuery({ data: listResult(LIVE_LINEAR) });
    renderPage({ pluginId: 'linear' });

    expect(screen.queryByRole('button', { name: 'Turn on Linear' })).not.toBeInTheDocument();

    fireEvent.pointerDown(screen.getByLabelText('More actions for Linear'));
    expect(screen.getByRole('menuitem', { name: 'Account details' })).toBeInTheDocument();
    expect(screen.queryByRole('menuitem', { name: 'Turn off plugin' })).not.toBeInTheDocument();
    expect(screen.getByRole('menuitem', { name: 'Remove plugin' })).toBeInTheDocument();

    fireEvent.click(screen.getByText('Remove plugin'));
    expect(screen.getByText('Remove Linear?')).toBeInTheDocument();
  });
});

const CHAT_ONLY_WIKI: PluginDefinition = {
  ...PLUGIN_DEFINITIONS[0]!,
  id: 'wiki',
  name: 'Wiki',
  description: 'Pages from your wiki',
  source: { kind: 'frink_builtin' },
  availability: 'available',
  contents: {
    mcpServers: [
      {
        id: 'wiki',
        label: 'Wiki',
        ownership: 'provider_native',
        schemaSource: 'mcp_tools_list',
        transport: {
          type: 'http',
          url: 'https://mcp.wiki.test/mcp',
          auth: { kind: 'frink_client' },
        },
        connectionBinding: { type: 'none' },
      },
    ],
    skills: [],
    nativeExtensions: [],
    triggers: [],
    actions: [],
  },
};

describe('Shortcut OAuth and optional events', () => {
  function renderShortcut(toolsConnected: boolean, connections: PluginConnection[] = []) {
    const server = { serverName: 'plugin_shortcut_shortcut', pluginName: 'shortcut' };
    vendorMcpStatusUseQueryMock.mockReturnValue({
      data: {
        connected: toolsConnected ? [server] : [],
        awaitingAuth: toolsConnected ? [] : [server],
      },
    });
    mockQuery({
      data: {
        plugins: resolvePlugins({
          installations: [{ ...INSTALLED_LINEAR, id: 'install-shortcut', pluginId: 'shortcut' }],
          connections,
        }),
      },
    });
    renderPage();
  }

  beforeEach(() => {
    connectWebhookOnlyMock.mockClear();
    generateWebhookEndpointMock.mockClear();
    uninstallMutateMock.mockClear();
  });

  it('runs one shared OAuth consent without creating a webhook account or asking for a token', () => {
    renderShortcut(false);
    expect(screen.getByText('Needs connection')).toBeInTheDocument();
    expect(screen.getByText('One sign-in in your browser.')).toBeInTheDocument();
    const connect = screen.getByRole('button', { name: 'Connect Shortcut' });
    fireEvent.click(connect);
    fireEvent.click(connect);

    expect(connectVendorMcpMutateMock).toHaveBeenCalledExactlyOnceWith({ pluginName: 'shortcut' });
    expect(onConnect).not.toHaveBeenCalled();
    expect(connectWebhookOnlyMock).not.toHaveBeenCalled();
    expect(generateWebhookEndpointMock).not.toHaveBeenCalled();
    expect(screen.queryByLabelText('Token')).not.toBeInTheDocument();
    // Shortcut's address is minted on this machine, so events are offered before any sign-in.
    expect(screen.getByRole('button', { name: 'Set up events' })).toBeInTheDocument();
  });

  it('shows the trigger card for an account this machine holds, with nobody signed in', () => {
    renderShortcut(false, [{ id: 'local-shortcut', providerId: 'shortcut', isActive: true }]);

    expect(screen.getByTestId('trigger-card')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Set up events' })).not.toBeInTheDocument();
    // The account on this machine is live; only the chat grant is still owed.
    expect(screen.getByText('Needs connection')).toBeInTheDocument();
  });

  it('finishes a half connection from Manage, never a Connect beside it', () => {
    renderShortcut(false, [{ id: 'local-shortcut', providerId: 'shortcut', isActive: true }]);

    expect(screen.queryByRole('button', { name: 'Connect Shortcut' })).not.toBeInTheDocument();
    expect(
      screen.getByText('One sign-in so chats can use Shortcut. Finish connecting in Manage.'),
    ).toBeInTheDocument();
    fireEvent.pointerDown(screen.getByLabelText('More actions for Shortcut'));
    const [first] = screen.getAllByRole('menuitem');
    expect(first).toHaveTextContent('Finish connecting');
    fireEvent.click(first!);
    expect(connectVendorMcpMutateMock).toHaveBeenCalledExactlyOnceWith({ pluginName: 'shortcut' });
  });

  it('is connected after OAuth and removes the installed plugin through the common lifecycle', () => {
    renderShortcut(true);
    expect(screen.getByText('Connected')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Connect Shortcut' })).not.toBeInTheDocument();
    fireEvent.pointerDown(screen.getByLabelText('More actions for Shortcut'));
    expect(screen.queryByRole('menuitem', { name: 'Account details' })).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole('menuitem', { name: 'Remove plugin' }));
    expect(screen.getByText(/Frink forgets its MCP authorization/)).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Remove' }));
    expect(uninstallMutateMock).toHaveBeenCalledExactlyOnceWith({ pluginId: 'shortcut' });
  });

  it('creates its optional webhook only when events are explicitly requested after OAuth', async () => {
    renderShortcut(true);
    expect(connectWebhookOnlyMock).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole('button', { name: 'Set up events' }));
    await waitFor(() =>
      expect(generateWebhookEndpointMock).toHaveBeenCalledWith({ integrationId: 'int-new' }),
    );
    expect(connectWebhookOnlyMock).toHaveBeenCalledExactlyOnceWith({
      provider: 'shortcut',
      label: 'Shortcut',
    });
    expect(connectVendorMcpMutateMock).not.toHaveBeenCalled();
    expect(onConnect).not.toHaveBeenCalled();
  });
});

describe('chat-only plugin page', () => {
  function renderWiki() {
    mockQuery({
      data: {
        plugins: resolvePlugins({
          definitions: [...PLUGIN_DEFINITIONS, CHAT_ONLY_WIKI],
          installations: [],
          connections: [],
        }),
      },
    });
    renderPage({ pluginId: 'wiki' });
  }

  it('offers one Connect that runs the chat grant, never an account flow', () => {
    vendorMcpStatusUseQueryMock.mockReturnValue({
      data: {
        connected: [],
        awaitingAuth: [{ serverName: 'plugin_wiki_wiki', pluginName: 'wiki' }],
      },
    });
    renderWiki();

    expect(screen.getByText('Needs connection')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Connect Wiki' }));
    expect(connectVendorMcpMutateMock).toHaveBeenCalledWith({ pluginName: 'wiki' });
    expect(onConnect).not.toHaveBeenCalled();
  });

  it('offers the lifecycle menu once installed: Remove sweeps the chat grant, Turn on needs no browser', () => {
    vendorMcpStatusUseQueryMock.mockReturnValue({
      data: {
        connected: [{ serverName: 'plugin_wiki_wiki', pluginName: 'wiki' }],
        awaitingAuth: [],
      },
    });
    mockQuery({
      data: {
        plugins: resolvePlugins({
          definitions: [...PLUGIN_DEFINITIONS, CHAT_ONLY_WIKI],
          installations: [{ ...INSTALLED_LINEAR, id: 'install-wiki', pluginId: 'wiki' }],
          connections: [],
        }),
      },
    });
    renderPage({ pluginId: 'wiki' });

    fireEvent.pointerDown(screen.getByLabelText('More actions for Wiki'));
    fireEvent.click(screen.getByText('Remove plugin'));
    expect(screen.getByText(/Frink forgets its MCP authorization/)).toBeInTheDocument();
    fireEvent.click(screen.getByText('Remove'));
    expect(uninstallMutateMock).toHaveBeenCalledWith({ pluginId: 'wiki' });
  });

  it('grants a token server through the paste dialog, never a browser consent', () => {
    const tokenWiki: PluginDefinition = {
      ...CHAT_ONLY_WIKI,
      contents: {
        ...CHAT_ONLY_WIKI.contents,
        mcpServers: [
          {
            ...CHAT_ONLY_WIKI.contents.mcpServers[0]!,
            transport: {
              type: 'http',
              url: 'https://mcp.wiki.test/mcp',
              auth: {
                kind: 'user_token',
                setupUrl: 'https://wiki.test/tokens',
                validation: { url: 'https://wiki.test/me' },
              },
            },
          },
        ],
      },
    };
    vendorMcpStatusUseQueryMock.mockReturnValue({
      data: {
        connected: [],
        awaitingAuth: [{ serverName: 'plugin_wiki_wiki', pluginName: 'wiki' }],
      },
    });
    mockQuery({
      data: {
        plugins: resolvePlugins({
          definitions: [...PLUGIN_DEFINITIONS, tokenWiki],
          installations: [],
          connections: [],
        }),
      },
    });
    renderPage({ pluginId: 'wiki' });

    fireEvent.click(screen.getByRole('button', { name: 'Connect Wiki' }));
    expect(connectVendorMcpMutateMock).not.toHaveBeenCalled();
    fireEvent.change(screen.getByLabelText('Token'), { target: { value: 'tok-1' } });
    fireEvent.click(screen.getByRole('button', { name: 'Connect' }));
    expect(connectUserTokenMutateMock).toHaveBeenCalledWith({ pluginId: 'wiki', token: 'tok-1' });
    // The token is the whole connect for a chat-only plugin: no account leg follows it.
    expect(onConnect).not.toHaveBeenCalled();
  });

  it('badges the chat grant as Connected, with no "MCP only" caveat', () => {
    vendorMcpStatusUseQueryMock.mockReturnValue({
      data: {
        connected: [{ serverName: 'plugin_wiki_wiki', pluginName: 'wiki' }],
        awaitingAuth: [],
      },
    });
    renderWiki();

    expect(screen.getByText('Connected')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Connect Wiki' })).not.toBeInTheDocument();
  });
});

describe('PluginPageHeader — one Connect until every grant is live', () => {
  const NO_ACCOUNT: ReadonlyArray<PluginConnection> = [];

  function tools(state: 'awaiting' | 'connected' | 'unknown', pluginName = 'linear') {
    const ref = { serverName: `plugin_${pluginName}_${pluginName}`, pluginName };
    vendorMcpStatusUseQueryMock.mockReturnValue({
      data:
        state === 'unknown'
          ? undefined
          : {
              connected: state === 'connected' ? [ref] : [],
              awaitingAuth: state === 'awaiting' ? [ref] : [],
            },
    });
  }

  function renderInstalled(
    connections: ReadonlyArray<PluginConnection>,
    installation = INSTALLED_LINEAR,
  ) {
    mockQuery({
      data: { plugins: resolvePlugins({ installations: [installation], connections }) },
    });
    renderPage({ pluginId: installation.pluginId });
  }

  const openManage = () => fireEvent.pointerDown(screen.getByLabelText('More actions for Linear'));

  // Linear's account grant supplies its tools credential (integration-credential-broker 2026-09-07):
  // one sign-in, and the account alone decides the badge.
  const ONE_SIGN_IN = 'One sign-in in your browser.';
  /** Linear's shipped prerequisite, now read with the description rather than beside Connect. */
  const PREREQUISITE = /admin of your Linear workspace/;

  // Notion: webhook_only with a catalog attachment, so its account grant is optional
  // (providerConnection, selectors.ts) — Connect is chat-MCP-only, no account required.
  it('offers Connect before Notion is installed', () => {
    mockQuery({ data: listResult(NO_ACCOUNT) });
    renderPage({ pluginId: 'notion' });
    expect(screen.getByText('Needs connection')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Connect Notion' }));
    // A chat-only plugin's Connect runs the vendor consent directly (use-plugin-chat-grant.ts),
    // never the account-connect callback — see the Shortcut OAuth block below for the same contract.
    expect(connectVendorMcpMutateMock).toHaveBeenCalledExactlyOnceWith({ pluginName: 'notion' });
    expect(onConnect).not.toHaveBeenCalled();
    expect(screen.queryByLabelText('More actions for Notion')).not.toBeInTheDocument();
  });

  it('keeps Notion manageable while turned off', () => {
    renderInstalled(NO_ACCOUNT, { ...INSTALLED_LINEAR, pluginId: 'notion', isEnabled: false });
    expect(screen.getByText('Turned off')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Turn on Notion' })).toBeInTheDocument();
    fireEvent.pointerDown(screen.getByLabelText('More actions for Notion'));
    expect(screen.getByRole('menuitem', { name: 'Remove plugin' })).toBeInTheDocument();
  });

  it('an installed Notion package is Connected and retains Turn off and Remove without an account', () => {
    // Only a live tools grant reads Connected without an account (resolvePluginStatus,
    // plugin-view-model.ts) — 'awaiting' still needs_connection, as the account-required cases assert.
    tools('connected', 'notion');
    renderInstalled(NO_ACCOUNT, { ...INSTALLED_LINEAR, pluginId: 'notion' });
    expect(screen.getByText('Connected')).toBeInTheDocument();
    expect(screen.queryByText('Ready to use')).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Connect Notion' })).not.toBeInTheDocument();
    fireEvent.pointerDown(screen.getByLabelText('More actions for Notion'));
    expect(screen.getByRole('menuitem', { name: 'Turn off plugin' })).toBeInTheDocument();
    expect(screen.getByRole('menuitem', { name: 'Remove plugin' })).toBeInTheDocument();
    fireEvent.click(screen.getByRole('menuitem', { name: 'Turn off plugin' }));
    expect(screen.getByRole('alertdialog')).toHaveTextContent('Turn off Notion?');
    fireEvent.click(screen.getByRole('button', { name: 'Turn off' }));
    expect(setEnabledMutateMock).toHaveBeenCalledWith({ pluginId: 'notion', enabled: false });
  });

  it('nothing connected: Needs connection, one Connect naming the one sign-in, and no Manage', () => {
    tools('awaiting');
    renderInstalled(NO_ACCOUNT);

    expect(screen.getByText('Needs connection')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Connect Linear' })).toBeInTheDocument();
    expect(screen.getByText(ONE_SIGN_IN)).toBeInTheDocument();
    expect(screen.queryByLabelText('More actions for Linear')).not.toBeInTheDocument();
  });

  it('both: Connected with no Connect beside it, and Manage holds Remove', () => {
    tools('connected');
    renderInstalled(LIVE_LINEAR);

    expect(screen.getByText('Connected')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /Connect/ })).not.toBeInTheDocument();
    openManage();
    expect(screen.getByRole('menuitem', { name: 'Remove plugin' })).toBeInTheDocument();
  });

  it("tools 'unknown' keeps the account's verdict: Connected, no Connect, no sub-line", () => {
    tools('unknown');
    renderInstalled(LIVE_LINEAR);

    expect(screen.getByText('Connected')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Connect Linear' })).not.toBeInTheDocument();
    // Not the broader /sign-in/: the Auth row itself now names Linear's own MCP
    // grant "Browser sign-in", which the old regex here would also catch.
    expect(screen.queryByText(ONE_SIGN_IN)).not.toBeInTheDocument();
  });

  it('states the vendor prerequisite in the body, as the description of Connect', () => {
    tools('awaiting');
    renderInstalled(NO_ACCOUNT);

    expect(screen.getByText(PREREQUISITE)).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Connect Linear' })).toHaveAccessibleDescription(
      PREREQUISITE,
    );
  });

  it('runs a multi-sentence prerequisite together as one paragraph', () => {
    tools('awaiting', 'cloudflare');
    renderInstalled(NO_ACCOUNT, { ...INSTALLED_LINEAR, pluginId: 'cloudflare' });

    expect(
      screen.getByText(/Super Administrator or Administrator role.*paid plans only/),
    ).toBeInTheDocument();
  });

  it('drops the prerequisite once its tools grant is live, and never shows it where nothing can connect', () => {
    // Linear's account is optional now, so the tools grant alone decides Connect — and with it gone,
    // the prerequisite that only ever described Connect.
    tools('connected');
    renderInstalled(NO_ACCOUNT);
    expect(screen.queryByText(PREREQUISITE)).not.toBeInTheDocument();

    cleanup();
    // Coming soon: no Connect, so no prerequisite either, whatever the manifest says.
    renderPage({ pluginId: 'docusign' });
    expect(screen.queryByText(PREREQUISITE)).not.toBeInTheDocument();
  });

  it('Connect runs the chain for a provider plugin — the account flow, never the chat-only consent', () => {
    // Linear itself is chat-only now (its account is optional); Generic Webhook declares no chat
    // tools at all, so it is the one 'available' provider left whose Connect must run the account flow.
    renderInstalled(NO_ACCOUNT, {
      ...INSTALLED_LINEAR,
      id: 'install-generic_webhook',
      pluginId: 'generic_webhook',
    });

    fireEvent.click(screen.getByRole('button', { name: 'Connect Generic Webhook' }));
    expect(onConnect).toHaveBeenCalledWith('generic_webhook');
    expect(connectVendorMcpMutateMock).not.toHaveBeenCalled();
  });

  it('a turned-off plugin offers no Connect even with a missing tools grant', () => {
    tools('awaiting');
    renderInstalled(LIVE_LINEAR, { ...INSTALLED_LINEAR, isEnabled: false });

    expect(screen.getByText('Turned off')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Connect Linear' })).not.toBeInTheDocument();
  });

  it('a mixed connected+awaiting payload reads as connected — live tools never read as missing', () => {
    vendorMcpStatusUseQueryMock.mockReturnValue({
      data: {
        connected: [{ serverName: 'plugin_linear_a', pluginName: 'linear' }],
        awaitingAuth: [{ serverName: 'plugin_linear_b', pluginName: 'linear' }],
      },
    });
    renderInstalled(LIVE_LINEAR);

    expect(screen.getByText('Connected')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Connect Linear' })).not.toBeInTheDocument();
  });

  it('offers no connection for a coming-soon plugin, even when an older install remains', () => {
    tools('awaiting', 'docusign');
    renderInstalled(NO_ACCOUNT, {
      ...INSTALLED_LINEAR,
      id: 'install-docusign',
      pluginId: 'docusign',
    });

    expect(screen.queryByRole('button', { name: /^Connect/ })).not.toBeInTheDocument();
    expect(screen.queryByLabelText('Token')).not.toBeInTheDocument();
    expect(onConnect).not.toHaveBeenCalled();
  });
});

describe('PostHog — a chat plugin whose trigger endpoint is minted from its page', () => {
  const INSTALLED_POSTHOG = { ...INSTALLED_LINEAR, id: 'install-posthog', pluginId: 'posthog' };
  const ref = { serverName: 'plugin_posthog_posthog', pluginName: 'posthog' };

  function renderPosthog(tools: 'awaiting' | 'connected', items: PluginConnection[] = []) {
    vendorMcpStatusUseQueryMock.mockReturnValue({
      data: {
        connected: tools === 'connected' ? [ref] : [],
        awaitingAuth: tools === 'awaiting' ? [ref] : [],
      },
    });
    mockQuery({
      data: {
        plugins: resolvePlugins({
          installations: [INSTALLED_POSTHOG],
          connections: items,
        }),
      },
    });
    renderPage({ pluginId: 'posthog' });
  }

  beforeEach(() => {
    connectWebhookOnlyMock.mockClear();
    generateWebhookEndpointMock.mockClear();
  });

  it('Connect is the one browser sign-in; no endpoint is offered until it lands', () => {
    renderPosthog('awaiting');

    expect(screen.getByText('Needs connection')).toBeInTheDocument();
    expect(screen.getByText('One sign-in in your browser.')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Set up automatically' })).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: 'Connect PostHog' }));
    expect(connectVendorMcpMutateMock).toHaveBeenCalledWith({ pluginName: 'posthog' });
    expect(onConnect).not.toHaveBeenCalled();
  });

  it('automatic setup and Use in Flow mint the account and its endpoint on this machine', async () => {
    renderPosthog('connected');

    expect(screen.getByText('Connected')).toBeInTheDocument();
    expect(
      screen.queryByRole('button', { name: /Connect PostHog|Add another PostHog/ }),
    ).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: 'Set up automatically' }));
    await waitFor(() =>
      expect(generateWebhookEndpointMock).toHaveBeenCalledWith({ integrationId: 'int-new' }),
    );
    expect(connectWebhookOnlyMock).toHaveBeenCalledExactlyOnceWith({
      provider: 'posthog',
      label: 'PostHog',
    });
    expect(connectVendorMcpMutateMock).not.toHaveBeenCalled();

    fireEvent.click(screen.getByRole('button', { name: 'Use in Flow' }));
    await waitFor(() => expect(connectWebhookOnlyMock).toHaveBeenCalledTimes(2));
    expect(launchFlowMock).not.toHaveBeenCalled();
    expect(onConnect).not.toHaveBeenCalled();
  });

  it('with the endpoint row live the card replaces the offer, and Use in Flow binds to that row', () => {
    renderPosthog('connected', [{ id: 'ph-1', providerId: 'posthog', isActive: true }]);

    expect(screen.getByTestId('trigger-card')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Set up automatically' })).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: 'Use in Flow' }));
    expect(launchFlowMock).toHaveBeenCalledWith(
      expect.objectContaining({ pluginName: 'PostHog', connectionId: 'ph-1' }),
    );
  });

  it.each(['posthog', 'webflow'])(
    'routes the existing %s trigger retry through consent even when tools are already connected',
    (pluginId) => {
      vendorMcpStatusUseQueryMock.mockReturnValue({
        data: {
          connected: [{ pluginName: pluginId, serverName: `plugin_${pluginId}_${pluginId}` }],
          awaitingAuth: [],
        },
      });
      mockQuery({
        data: {
          plugins: resolvePlugins({
            installations: [{ ...INSTALLED_POSTHOG, pluginId }],
            connections: [{ id: 'existing-account', providerId: pluginId, isActive: true }],
          }),
        },
      });
      renderPage({ pluginId });
      fireEvent.click(screen.getByRole('button', { name: 'Try again' }));
      expect(connectVendorMcpMutateMock).toHaveBeenCalledWith({
        pluginName: pluginId,
        reconnect: true,
      });
      expect(generateWebhookEndpointMock).not.toHaveBeenCalled();
      expect(connectWebhookOnlyMock).not.toHaveBeenCalled();
      expect(onConnect).not.toHaveBeenCalled();
    },
  );
});
