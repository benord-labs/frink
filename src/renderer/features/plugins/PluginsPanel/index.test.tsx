// @vitest-environment happy-dom
import '@testing-library/jest-dom/vitest';
import { cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { PluginConnection } from '../../../../shared/integrations/plugins';
import { resolvePlugins } from '../../../../shared/integrations/plugins';
import { PluginsPanel } from './index';

// Only trpc is doubled. The directory and the plugin page render for real —
// mocking either would make the round-trip assertions below pass against an
// implementation that loses the state they exist to protect.
const { pluginsListUseQueryMock, connectVendorMcpMutateMock } = vi.hoisted(() => ({
  pluginsListUseQueryMock: vi.fn(),
  connectVendorMcpMutateMock: vi.fn(),
}));

vi.mock('../../../lib/trpc', () => ({
  trpc: {
    plugins: {
      list: { useQuery: pluginsListUseQueryMock },
      uninstall: { useMutation: () => ({ mutate: vi.fn(), isPending: false }) },
      setEnabled: { useMutation: () => ({ mutate: vi.fn(), isPending: false }) },
      disconnect: { useMutation: () => ({ mutate: vi.fn(), isPending: false }) },
      vendorMcpStatus: { useQuery: () => ({ data: { connected: [], awaitingAuth: [] } }) },
      connectVendorMcp: {
        useMutation: () => ({ mutate: connectVendorMcpMutateMock, isPending: false }),
      },
      connectAttemptEnded: { useMutation: () => ({ mutate: vi.fn(), isPending: false }) },
    },
    integrations: {
      connectWebhookOnly: { useMutation: () => ({ mutateAsync: vi.fn(), isPending: false }) },
      generateWebhookEndpoint: {
        useMutation: () => ({ mutateAsync: vi.fn(), isPending: false }),
      },
    },
    useUtils: () => ({
      plugins: { list: { invalidate: vi.fn() }, vendorMcpStatus: { invalidate: vi.fn() } },
      triggerSetup: { options: { invalidate: vi.fn() } },
      integrations: { invalidate: vi.fn() },
    }),
  },
}));

// The plugin page calls this hook; unmocked it would reach the trpc double
// above for a flows.create mutation that double does not carry.
// The trigger card has its own suite and tRPC surface; the page only needs it mounted.
// oxlint-disable-next-line anti-slop/no-module-mocking
vi.mock('../PluginDetail/PluginTriggers/TriggerCard', () => ({
  TriggerCard: () => null,
}));

vi.mock('../../../lib/plugins/use-plugin-flow-launch', () => ({
  usePluginFlowLaunch: () => vi.fn(),
}));

function mockCatalog(connections: ReadonlyArray<PluginConnection> = []) {
  pluginsListUseQueryMock.mockReturnValue({
    isLoading: false,
    isError: false,
    data: { plugins: resolvePlugins({ installations: [], connections }) },
  });
}

const onConnect = vi.fn();
const onSelectAccount = vi.fn();
const onDetailChange = vi.fn();

function renderPanel(props: { accountDialogProvider?: string | null } = {}) {
  return render(
    <PluginsPanel
      onDetailChange={onDetailChange}
      connectingProvider={null}
      accountDialogProvider={props.accountDialogProvider ?? null}
      onConnect={onConnect}
      onSelectAccount={onSelectAccount}
    />,
  );
}

function openShortcut() {
  fireEvent.click(screen.getByRole('button', { name: /^Shortcut/ }));
}

function goBack() {
  fireEvent.click(screen.getByRole('button', { name: 'Plugins' }));
}

beforeEach(() => {
  pluginsListUseQueryMock.mockReset();
  connectVendorMcpMutateMock.mockReset();
  onConnect.mockReset();
  onSelectAccount.mockReset();
  onDetailChange.mockReset();
  mockCatalog();
});

afterEach(cleanup);

describe('PluginsPanel', () => {
  it('opens a plugin in place rather than over the directory', () => {
    renderPanel();
    openShortcut();

    expect(screen.getByRole('heading', { level: 1, name: 'Shortcut' })).toBeInTheDocument();
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
  });

  it('tells the host when a plugin page opens and closes, so it can hide its own header', () => {
    renderPanel();
    expect(onDetailChange).toHaveBeenLastCalledWith(false);

    openShortcut();
    expect(onDetailChange).toHaveBeenLastCalledWith(true);

    goBack();
    expect(onDetailChange).toHaveBeenLastCalledWith(false);
  });

  it('keeps the search and filter a round trip costs nothing to lose', () => {
    renderPanel();

    fireEvent.change(screen.getByLabelText('Search plugins'), { target: { value: 'shortcut' } });
    openShortcut();
    goBack();

    // Unmounting the directory instead of hiding it resets both of these, which
    // is the whole reason it stays mounted.
    expect(screen.getByLabelText('Search plugins')).toHaveValue('shortcut');
    expect(screen.queryByRole('button', { name: /^Generic Webhook/ })).not.toBeInTheDocument();
  });

  it('takes the hidden directory out of the tab order, not just out of sight', () => {
    renderPanel();
    openShortcut();

    // `opacity-0`, `sr-only` and `aria-hidden` all leave every row, Connect
    // button and the search box reachable by Tab from behind the page; only
    // `display:none` removes them. Asserted as the class rather than a computed
    // style because no stylesheet is loaded under the test renderer.
    expect(screen.getByTestId('plugins-list').closest('.hidden')).not.toBeNull();
  });

  it('opens the page for a connected plugin instead of jumping to its account', () => {
    mockCatalog([{ id: 'c1', providerId: 'shortcut', accountName: 'Acme', isActive: true }]);
    renderPanel();
    openShortcut();

    // The old shortcut skipped capability disclosure entirely for exactly the
    // plugins a user is most likely to open.
    expect(screen.getByRole('heading', { level: 1, name: 'Shortcut' })).toBeInTheDocument();
    expect(onSelectAccount).not.toHaveBeenCalled();
  });

  it('hands focus back to the row that was opened', () => {
    renderPanel();
    openShortcut();
    goBack();

    // The page is not a dialog, so nothing restores focus for us — and the row
    // was display:none'd, so focus is on <body> by now.
    expect(document.activeElement).toBe(screen.getByRole('button', { name: /^Shortcut/ }));
  });

  it('leaves a page the account dialog no longer belongs to', () => {
    const { rerender } = renderPanel();
    openShortcut();

    // A Notion consent settling while the user reads Shortcut opens a Notion
    // account dialog; closing it must not drop them on Shortcut's page.
    rerender(
      <PluginsPanel
        onDetailChange={onDetailChange}
        connectingProvider={null}
        accountDialogProvider="notion"
        onConnect={onConnect}
        onSelectAccount={onSelectAccount}
      />,
    );

    expect(screen.queryByRole('heading', { level: 1, name: 'Shortcut' })).not.toBeInTheDocument();
  });

  it('stays on the page when the dialog belongs to the plugin being read', () => {
    renderPanel({ accountDialogProvider: 'shortcut' });
    openShortcut();

    expect(screen.getByRole('heading', { level: 1, name: 'Shortcut' })).toBeInTheDocument();
  });

  it('connects the plugin whose page is open', () => {
    renderPanel();
    openShortcut();

    // Scoped to the page: the directory stays mounted behind it and carries a
    // Connect for the same plugin.
    const page = within(screen.getByTestId('plugin-page'));
    fireEvent.click(page.getByRole('button', { name: 'Connect Shortcut' }));

    expect(connectVendorMcpMutateMock).toHaveBeenCalledWith({ pluginName: 'shortcut' });
    expect(onConnect).not.toHaveBeenCalled();
  });
});
