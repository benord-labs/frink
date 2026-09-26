// @vitest-environment happy-dom

import { act, render, screen } from '@testing-library/react';
import type { Atom } from 'jotai';
import type { ComponentProps } from 'react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { agentsSettingsDialogActiveTabAtom } from '@/lib/atoms';
import { AgentsMcpTab } from './index';
import type { McpSection } from './McpSection';

type OnConfigure = ComponentProps<typeof McpSection>['onConfigure'];

type CapturedCallbacks = {
  onConfigure: OnConfigure | null;
  onStartOAuth: (() => Promise<void>) | null;
  onOpenPluginPage: (() => void) | null;
};

// ─── Hoisted spies (must be created before vi.mock factories run) ─────────────
const oauthSpies = vi.hoisted(() => {
  const capturedCallbacks: CapturedCallbacks = {
    onConfigure: null,
    onStartOAuth: null,
    onOpenPluginPage: null,
  };
  return {
    capturedCallbacks,
    mutateAsync: vi.fn(),
    setData: vi.fn(),
    invalidate: vi.fn().mockResolvedValue(undefined),
    toastSuccess: vi.fn(),
    toastError: vi.fn(),
    /** One setter spy per atom, so a test can read back which atom the tab wrote. */
    atomSetters: new Map<Atom<unknown>, ReturnType<typeof vi.fn>>(),
  };
});

// IPC bridge spy — captures the callback registered by useEffect
let capturedIpcHandler: ((data: { serverName: string; success: boolean }) => void) | null = null;
const mockOnMcpAuthCompleted = vi.fn(
  (cb: (data: { serverName: string; success: boolean }) => void) => {
    capturedIpcHandler = cb;
    return () => {
      capturedIpcHandler = null;
    };
  },
);

const aggregatedQueryMock = vi.fn();
const localServersQueryMock = vi.fn();
const homePathQueryMock = vi.fn();
vi.mock('jotai', async (importOriginal) => {
  const actual = await importOriginal<typeof import('jotai')>();
  return {
    ...actual,
    useSetAtom: (atom: Atom<unknown>) => {
      const existing = oauthSpies.atomSetters.get(atom);
      if (existing) return existing;
      const setter = vi.fn();
      oauthSpies.atomSetters.set(atom, setter);
      return setter;
    },
  };
});

vi.mock('@/features/code-editor', () => ({
  openFileAtom: Symbol('openFileAtom'),
  codeEditorMaximizedAtom: Symbol('codeEditorMaximizedAtom'),
}));

vi.mock('sonner', () => ({
  toast: {
    success: (...args: unknown[]) => oauthSpies.toastSuccess(...args),
    error: (...args: unknown[]) => oauthSpies.toastError(...args),
  },
}));

vi.mock('@/lib/trpc', () => ({
  trpc: {
    mcp: {
      getAggregatedMcpInfo: { useQuery: (...args: unknown[]) => aggregatedQueryMock(...args) },
      listGlobalServers: { useQuery: (...args: unknown[]) => localServersQueryMock(...args) },
    },
    claude: {
      startMcpOAuth: {
        useMutation: () => ({ mutateAsync: oauthSpies.mutateAsync, isPending: false }),
      },
    },
    external: {
      getHomePath: { useQuery: (...args: unknown[]) => homePathQueryMock(...args) },
    },
  },
}));

vi.mock('@/hooks/use-mcp-handlers', () => ({
  useMcpHandlers: () => ({
    handleAddMcp: vi.fn(),
    handleSaveCredentials: vi.fn(),
    handleDelete: vi.fn(),
    handleReconnect: vi.fn(),
    handleToggleEnabled: vi.fn(),
    handleRefresh: vi.fn(),
    utils: {
      mcp: {
        getCredentials: { fetch: vi.fn().mockResolvedValue(null) },
        getAggregatedMcpInfo: {
          setData: oauthSpies.setData,
          invalidate: oauthSpies.invalidate,
        },
      },
    },
  }),
}));

vi.mock('./McpSection', () => ({
  McpSection: ({
    mcps,
    onConfigure,
    onOpenPluginPage,
  }: {
    mcps: unknown[];
    onConfigure?: OnConfigure;
    onOpenPluginPage?: () => void;
  }) => {
    oauthSpies.capturedCallbacks.onConfigure = onConfigure ?? null;
    oauthSpies.capturedCallbacks.onOpenPluginPage = onOpenPluginPage ?? null;
    return <div data-testid="mcp-section">{mcps.length}</div>;
  },
}));
vi.mock('./Header', () => ({
  Header: () => <div data-testid="header" />,
}));
vi.mock('./AddMcpDialog', () => ({
  AddMcpDialog: () => null,
}));
vi.mock('./ConfigureMcpDialog', () => ({
  ConfigureMcpDialog: ({ onStartOAuth }: { onStartOAuth?: () => Promise<void> }) => {
    oauthSpies.capturedCallbacks.onStartOAuth = onStartOAuth ?? null;
    return null;
  },
}));

describe('AgentsMcpTab progressive rendering', () => {
  beforeEach(() => {
    aggregatedQueryMock.mockReset();
    localServersQueryMock.mockReset();
    homePathQueryMock.mockReset();

    homePathQueryMock.mockReturnValue({ data: '/Users/test' });
  });

  it('renders local Frink MCP section while aggregated status is still loading', () => {
    aggregatedQueryMock.mockReturnValue({
      data: undefined,
      isLoading: true,
      isError: false,
      refetch: vi.fn(),
    });
    localServersQueryMock.mockReturnValue({
      data: {
        github: {
          name: 'github',
          type: 'custom',
          authType: 'none',
          command: 'npx',
          enabled: true,
        },
      },
    });

    render(<AgentsMcpTab />);

    expect(screen.queryByText('Loading MCP servers...')).toBeNull();
    expect(screen.getByTestId('mcp-section').textContent).toContain('1');
  });

  it("hands a plugin row over to the settings tab that owns the plugin's connection", () => {
    aggregatedQueryMock.mockReturnValue({
      data: [
        {
          name: 'plugin_posthog_posthog',
          status: 'connected',
          hasCredentials: true,
          config: { managedBy: 'vendor_plugin', url: 'https://mcp.posthog.com/mcp' },
          tools: [],
        },
      ],
      isLoading: false,
      isError: false,
      refetch: vi.fn(),
    });
    localServersQueryMock.mockReturnValue({ data: undefined });

    render(<AgentsMcpTab />);
    act(() => {
      oauthSpies.capturedCallbacks.onOpenPluginPage?.();
    });

    expect(oauthSpies.atomSetters.get(agentsSettingsDialogActiveTabAtom)).toHaveBeenCalledWith(
      'integrations',
    );
  });

  it('shows stale-data warning when frink query errors but local fallback is visible', () => {
    aggregatedQueryMock.mockReturnValue({
      data: undefined,
      isLoading: false,
      isError: true,
      refetch: vi.fn(),
    });
    localServersQueryMock.mockReturnValue({
      data: {
        github: {
          name: 'github',
          type: 'custom',
          authType: 'none',
          command: 'npx',
          enabled: true,
        },
      },
    });

    render(<AgentsMcpTab />);

    expect(
      screen.queryByText('Showing the last known servers. Checking them again failed.'),
    ).not.toBeNull();
  });

  it('shows empty state when the aggregated query fails without fallback data', () => {
    aggregatedQueryMock.mockReturnValue({
      data: undefined,
      isLoading: false,
      isError: true,
      refetch: vi.fn(),
    });
    localServersQueryMock.mockReturnValue({ data: undefined });

    render(<AgentsMcpTab />);

    expect(screen.queryByText('Could not check your servers.')).toBeNull();
    expect(screen.queryAllByText('No servers yet').length).toBeGreaterThan(0);
  });

  it('shows empty state when no MCPs and no import candidates exist', () => {
    aggregatedQueryMock.mockReturnValue({
      data: [],
      isLoading: false,
      isError: false,
      refetch: vi.fn(),
    });
    localServersQueryMock.mockReturnValue({ data: undefined });

    render(<AgentsMcpTab />);

    expect(screen.queryAllByText('No servers yet').length).toBeGreaterThan(0);
    expect(screen.getByText(/Servers give your agents extra tools/)).not.toBeNull();
    expect(screen.getByText('Servers you add yourself show up here.')).not.toBeNull();
  });
});

// ─── OAuth flow (handleStartOAuth) ────────────────────────────────────────────

const OAUTH_MCP = {
  name: 'cloudflare-api',
  status: 'needs-auth',
  hasCredentials: false,
  config: { authType: 'oauth', url: 'https://mcp.cloudflare.com/mcp' },
  tools: [],
};

function setupOAuthScenario() {
  aggregatedQueryMock.mockReturnValue({
    data: [OAUTH_MCP],
    isLoading: false,
    isError: false,
    refetch: vi.fn(),
  });
  localServersQueryMock.mockReturnValue({ data: undefined });
}

/** Open the configure dialog for the test MCP then return the captured onStartOAuth. */
async function openConfigureDialog(): Promise<() => Promise<void>> {
  render(<AgentsMcpTab />);

  // Trigger handleConfigure — this sets configureDialog.serverName and causes
  // ConfigureMcpDialog to receive a real onStartOAuth instead of a no-op.
  await act(async () => {
    oauthSpies.capturedCallbacks.onConfigure?.('cloudflare-api', {
      authType: 'oauth',
      url: 'https://mcp.cloudflare.com/mcp',
    });
  });

  const onStartOAuth = oauthSpies.capturedCallbacks.onStartOAuth;
  if (!onStartOAuth) throw new Error('onStartOAuth not captured — ConfigureMcpDialog not rendered');
  return onStartOAuth;
}

describe('AgentsMcpTab OAuth flow', () => {
  beforeEach(() => {
    aggregatedQueryMock.mockReset();
    localServersQueryMock.mockReset();
    homePathQueryMock.mockReset();
    oauthSpies.mutateAsync.mockReset();
    oauthSpies.setData.mockReset();
    oauthSpies.invalidate.mockReset();
    oauthSpies.toastSuccess.mockReset();
    oauthSpies.toastError.mockReset();
    oauthSpies.capturedCallbacks.onConfigure = null;
    oauthSpies.capturedCallbacks.onStartOAuth = null;

    homePathQueryMock.mockReturnValue({ data: '/Users/test' });
    setupOAuthScenario();
  });

  it('calls the OAuth mutation with the server name and the global config path', async () => {
    oauthSpies.mutateAsync.mockResolvedValue({ success: true });
    const onStartOAuth = await openConfigureDialog();

    await act(async () => {
      await onStartOAuth();
    });

    expect(oauthSpies.mutateAsync).toHaveBeenCalledWith({
      serverName: 'cloudflare-api',
      projectPath: '__global__',
    });
  });

  it('on success: applies optimistic cache update setting status to connected', async () => {
    oauthSpies.mutateAsync.mockResolvedValue({ success: true });
    const onStartOAuth = await openConfigureDialog();

    await act(async () => {
      await onStartOAuth();
    });

    expect(oauthSpies.setData).toHaveBeenCalledWith(
      undefined, // cache key — always undefined for getAggregatedMcpInfo
      expect.any(Function),
    );

    // Verify the updater function only modifies the matching MCP
    const updater = oauthSpies.setData.mock.calls[0][1] as (
      current: (typeof OAUTH_MCP)[],
    ) => (typeof OAUTH_MCP)[];
    const updated = updater([OAUTH_MCP, { ...OAUTH_MCP, name: 'other-mcp' }]);
    expect(updated[0]).toMatchObject({
      name: 'cloudflare-api',
      status: 'connected',
      hasCredentials: true,
    });
    expect(updated[1]).toMatchObject({ name: 'other-mcp', status: 'needs-auth' }); // unchanged
  });

  it('on success: triggers background cache invalidation', async () => {
    oauthSpies.mutateAsync.mockResolvedValue({ success: true });
    const onStartOAuth = await openConfigureDialog();

    await act(async () => {
      await onStartOAuth();
    });

    expect(oauthSpies.invalidate).toHaveBeenCalled();
  });

  it('on failure (result.success = false): shows error toast and skips cache update', async () => {
    oauthSpies.mutateAsync.mockResolvedValue({ success: false, error: 'OAuth timeout' });
    const onStartOAuth = await openConfigureDialog();

    await act(async () => {
      await onStartOAuth();
    });

    expect(oauthSpies.toastError).toHaveBeenCalledWith('OAuth timeout');
    expect(oauthSpies.setData).not.toHaveBeenCalled();
  });

  it('on thrown error: shows error toast and skips cache update', async () => {
    oauthSpies.mutateAsync.mockRejectedValue(new Error('Network error'));
    const onStartOAuth = await openConfigureDialog();

    await act(async () => {
      await onStartOAuth();
    });

    expect(oauthSpies.toastError).toHaveBeenCalledWith('Network error');
    expect(oauthSpies.setData).not.toHaveBeenCalled();
  });
});

// ─── IPC subscription (onMcpAuthCompleted) ────────────────────────────────────

describe('AgentsMcpTab IPC subscription', () => {
  beforeEach(() => {
    aggregatedQueryMock.mockReset();
    localServersQueryMock.mockReset();
    homePathQueryMock.mockReset();
    oauthSpies.setData.mockReset();
    oauthSpies.invalidate.mockReset();
    capturedIpcHandler = null;
    mockOnMcpAuthCompleted.mockClear();

    homePathQueryMock.mockReturnValue({ data: '/Users/test' });
    aggregatedQueryMock.mockReturnValue({
      data: [OAUTH_MCP],
      isLoading: false,
      isError: false,
      refetch: vi.fn(),
    });
    localServersQueryMock.mockReturnValue({ data: undefined });

    // Expose the IPC bridge mock on window so the useEffect can subscribe
    Object.defineProperty(window, 'desktopApi', {
      value: { onMcpAuthCompleted: mockOnMcpAuthCompleted },
      writable: true,
      configurable: true,
    });
  });

  it('registers a listener on mount via window.desktopApi.onMcpAuthCompleted', () => {
    render(<AgentsMcpTab />);
    expect(mockOnMcpAuthCompleted).toHaveBeenCalledTimes(1);
  });

  it('applies optimistic cache update when IPC fires with success: true', async () => {
    render(<AgentsMcpTab />);

    await act(async () => {
      capturedIpcHandler?.({ serverName: 'cloudflare-api', success: true });
    });

    expect(oauthSpies.setData).toHaveBeenCalledWith(undefined, expect.any(Function));

    const updater = oauthSpies.setData.mock.calls[0][1] as (
      current: (typeof OAUTH_MCP)[],
    ) => (typeof OAUTH_MCP)[];
    const updated = updater([OAUTH_MCP]);
    expect(updated[0]).toMatchObject({
      name: 'cloudflare-api',
      status: 'connected',
      hasCredentials: true,
    });
  });

  it('triggers background cache invalidation when IPC fires with success: true', async () => {
    render(<AgentsMcpTab />);

    await act(async () => {
      capturedIpcHandler?.({ serverName: 'cloudflare-api', success: true });
    });

    expect(oauthSpies.invalidate).toHaveBeenCalled();
  });

  it('ignores IPC events with success: false', async () => {
    render(<AgentsMcpTab />);

    await act(async () => {
      capturedIpcHandler?.({ serverName: 'cloudflare-api', success: false });
    });

    expect(oauthSpies.setData).not.toHaveBeenCalled();
    expect(oauthSpies.invalidate).not.toHaveBeenCalled();
  });

  it('ignores IPC events for a different server name', async () => {
    render(<AgentsMcpTab />);

    await act(async () => {
      capturedIpcHandler?.({ serverName: 'some-other-mcp', success: true });
    });

    // setData is called but the updater should not mutate the cloudflare-api entry
    if (oauthSpies.setData.mock.calls.length > 0) {
      const updater = oauthSpies.setData.mock.calls[0][1] as (
        current: (typeof OAUTH_MCP)[],
      ) => (typeof OAUTH_MCP)[];
      const updated = updater([OAUTH_MCP]);
      expect(updated[0]).toMatchObject({ name: 'cloudflare-api', status: 'needs-auth' });
    }
  });
});
