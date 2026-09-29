import { beforeEach, describe, expect, it, vi } from 'vitest';

const mcpLifecycleMocks = vi.hoisted(() => ({
  install: vi.fn(),
  uninstall: vi.fn(),
  setEnabled: vi.fn(),
  grantUserToken: vi.fn(),
}));

const {
  listPluginInstallationsForUserMock,
  getGlobalMcpServersMock,
  readMcpCredentialsMock,
  listConnectableVendorPluginMcpMock,
  getVendorPluginMcpConsentOutcomeMock,
  getVendorPluginMcpConsentUrlMock,
} = vi.hoisted(() => ({
  listPluginInstallationsForUserMock: vi.fn(),
  getGlobalMcpServersMock: vi.fn(),
  readMcpCredentialsMock: vi.fn(async () => ({ servers: {} })),
  listConnectableVendorPluginMcpMock: vi.fn(),
  getVendorPluginMcpConsentOutcomeMock: vi.fn(),
  getVendorPluginMcpConsentUrlMock: vi.fn(),
}));

vi.mock('../../db/repos/plugin-installations', () => ({
  listInstallations: listPluginInstallationsForUserMock,
}));

// Same boundary for the chat-only lifecycle: its own suite covers the rows and the consent.
// oxlint-disable-next-line anti-slop/no-module-mocking
vi.mock('../../integrations/plugin-mcp-lifecycle', () => ({
  installMcpPlugin: mcpLifecycleMocks.install,
  uninstallMcpPlugin: mcpLifecycleMocks.uninstall,
  setMcpPluginEnabled: mcpLifecycleMocks.setEnabled,
  grantUserToken: mcpLifecycleMocks.grantUserToken,
}));

type Db = ReturnType<typeof dbModule.getDatabase>;

const unwindMock = vi.hoisted(() => vi.fn(async (_db: Db, _pluginId: string) => {}));
// The unwind's predicate has its own suite; here only its seams are asserted.
// oxlint-disable-next-line anti-slop/no-module-mocking
vi.mock('../../integrations/plugin-connect-unwind', () => ({
  unwindUnconnectedInstall: unwindMock,
  withGrantUnwind: async <T>(db: Db, pluginId: string, work: () => Promise<T>) => {
    try {
      return await work();
    } finally {
      await unwindMock(db, pluginId);
    }
  },
}));

// Seam at the mcp boundary so the real predicate (usableOrRefreshableOAuth) runs un-mocked against controlled credential shapes.
// oxlint-disable-next-line anti-slop/no-module-mocking
vi.mock('../../mcp/config', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../mcp/config')>()),
  getGlobalMcpServers: getGlobalMcpServersMock,
  readMcpCredentials: readMcpCredentialsMock,
}));

// Same boundary: consent opens a real browser and binds a loopback port; its own suite covers it.
// oxlint-disable-next-line anti-slop/no-module-mocking
vi.mock('../../mcp/runtime/vendor-plugin-oauth', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../mcp/runtime/vendor-plugin-oauth')>()),
  getVendorPluginMcpConsentOutcome: getVendorPluginMcpConsentOutcomeMock,
  getVendorPluginMcpConsentUrl: getVendorPluginMcpConsentUrlMock,
  listConnectableVendorPluginMcp: listConnectableVendorPluginMcpMock,
  startVendorPluginMcpConsent: vi.fn(),
  cancelVendorPluginMcpConsent: vi.fn(async () => {}),
}));

import * as dbModule from '../../db';
import { insertIntegration } from '../../db/repos/webhook-ingress';
import { integrations } from '../../db/schema/webhook-ingress';
import { freshDb } from '../../db/test-utils/fresh-db';
import { pluginsRouter } from './plugins';

// A real handle: these seams only assert that the router forwards what getDatabase() returned.
const db = freshDb();
const getDatabaseMock = vi.spyOn(dbModule, 'getDatabase');

const installedShortcut = {
  id: 'install-shortcut',
  userId: 'user-1',
  pluginId: 'shortcut',
  sourceKind: 'frink_builtin',
  sourceLocator: null,
  installedVersion: null,
  isInstalled: true,
  isEnabled: true,
  installedAt: new Date('2026-08-16T00:00:00.000Z'),
  uninstalledAt: null,
  updatedAt: new Date('2026-08-16T00:00:00.000Z'),
};

function createCaller() {
  return pluginsRouter.createCaller({ getWindow: () => null });
}

describe('pluginsRouter.list', () => {
  beforeEach(async () => {
    await db.delete(integrations);
    getDatabaseMock.mockReset();
    getDatabaseMock.mockReturnValue(db);
    listPluginInstallationsForUserMock.mockReset();
    listPluginInstallationsForUserMock.mockResolvedValue([]);
    for (const mock of Object.values(mcpLifecycleMocks)) mock.mockReset();
  });

  it('reports a plugin whose required account is missing as needing one', async () => {
    // generic_webhook has no MCP server or skill, so its account connection stays required
    // (see providerConnection in shared/integrations/selectors.ts).
    listPluginInstallationsForUserMock.mockResolvedValue([
      { ...installedShortcut, pluginId: 'generic_webhook' },
    ]);

    const result = await createCaller().list();
    const genericWebhook = result.plugins.find(
      (plugin) => plugin.definition.id === 'generic_webhook',
    );

    expect(genericWebhook).toMatchObject({
      installationState: 'enabled',
      connectionState: 'needs_connection',
      lifecycle: 'needs_connection',
    });
  });

  it('preserves multiple account identities under one explicit installation', async () => {
    const first = await insertIntegration(db, { provider: 'generic_webhook' });
    const second = await insertIntegration(db, { provider: 'generic_webhook' });
    listPluginInstallationsForUserMock.mockResolvedValue([
      { ...installedShortcut, pluginId: 'generic_webhook' },
    ]);

    const result = await createCaller().list();
    const genericWebhook = result.plugins.find(
      (plugin) => plugin.definition.id === 'generic_webhook',
    );

    expect(genericWebhook?.connections.map((connection) => connection.id)).toEqual([first, second]);
    expect(genericWebhook?.lifecycle).toBe('connected');
  });

  it('lists an account held on this machine while nobody is signed in', async () => {
    const id = await insertIntegration(db, { provider: 'sentry' });

    const result = await createCaller().list();
    const sentry = result.plugins.find((plugin) => plugin.definition.id === 'sentry');

    expect(sentry?.connections).toEqual([{ id, providerId: 'sentry', isActive: true }]);
  });

  it('resolves Generic Webhook as a trigger-only plugin', async () => {
    const result = await createCaller().list();
    const genericWebhook = result.plugins.find(
      (plugin) => plugin.definition.id === 'generic_webhook',
    );

    expect(genericWebhook?.definition.contents).toMatchObject({
      mcpServers: [],
      skills: [],
      actions: [],
    });
    expect(genericWebhook?.definition.contents.triggers).toHaveLength(1);
  });

  it('never returns credential or ownership fields', async () => {
    await insertIntegration(db, { provider: 'sentry' });

    const serialized = JSON.stringify(await createCaller().list());

    expect(serialized).not.toContain('apiTokenEncrypted');
    expect(serialized).not.toContain('user-1');
  });

  it('lists the locally installed plugins', async () => {
    listPluginInstallationsForUserMock.mockResolvedValue([installedShortcut]);

    const result = await createCaller().list();

    expect(
      result.plugins.find((plugin) => plugin.definition.id === 'shortcut')?.installation,
    ).toMatchObject({ isInstalled: true });
  });

  it('rejects an id no install lifecycle claims', async () => {
    // playwright: a real catalog id, but its local mcp server and coming_soon
    // status leave it outside every install lifecycle.
    await expect(createCaller().install({ pluginId: 'playwright' })).rejects.toMatchObject({
      code: 'BAD_REQUEST',
    });
    await expect(createCaller().uninstall({ pluginId: 'playwright' })).rejects.toMatchObject({
      code: 'BAD_REQUEST',
    });
    expect(mcpLifecycleMocks.install).not.toHaveBeenCalled();
  });
});

const TARGET = {
  serverName: 'plugin_notion_notion',
  pluginName: 'notion',
  url: 'https://mcp.notion.com/mcp',
  auth: { kind: 'static_client', clientId: 'c', callbackPort: 3118 },
};
const REF = { serverName: 'plugin_notion_notion', pluginName: 'notion' };

// Real predicate, un-mocked: a vendor that rotates short-lived tokens makes expired-but-refreshable ⇒ connected the live regression.
describe('plugins.vendorMcpStatus', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    listConnectableVendorPluginMcpMock.mockReturnValue([TARGET]);
    getGlobalMcpServersMock.mockResolvedValue({
      plugin_notion_notion: { name: 'notion (plugin)' },
    });
    getVendorPluginMcpConsentOutcomeMock.mockReturnValue(undefined);
    getVendorPluginMcpConsentUrlMock.mockReturnValue(undefined);
  });

  it('classifies a token server by its stored bearer, never by OAuth material', async () => {
    const github = {
      serverName: 'plugin_github_github',
      pluginName: 'github',
      url: 'https://api.githubcopilot.com/mcp/',
      auth: {
        kind: 'user_token',
        setupUrl: 'https://x.test',
        validation: { url: 'https://x.test/me' },
      },
    };
    listConnectableVendorPluginMcpMock.mockReturnValue([github]);
    getGlobalMcpServersMock.mockResolvedValue({
      plugin_github_github: { name: 'github (plugin)' },
    });
    readMcpCredentialsMock.mockResolvedValue({
      servers: { plugin_github_github: { headers: { Authorization: 'Bearer ghp_x' } } },
    });
    expect((await createCaller().vendorMcpStatus()).connected).toEqual([
      { serverName: 'plugin_github_github', pluginName: 'github' },
    ]);

    readMcpCredentialsMock.mockResolvedValue({ servers: {} });
    expect((await createCaller().vendorMcpStatus()).awaitingAuth).toEqual([
      { serverName: 'plugin_github_github', pluginName: 'github' },
    ]);
  });

  it('routes a pasted token to the grant for an installable plugin only', async () => {
    mcpLifecycleMocks.grantUserToken.mockResolvedValue(['plugin_github_github']);
    await expect(
      createCaller().connectUserToken({ pluginId: 'github', token: ' ghp_x ' }),
    ).resolves.toEqual(['plugin_github_github']);
    expect(mcpLifecycleMocks.grantUserToken).toHaveBeenCalledExactlyOnceWith(db, 'github', 'ghp_x');
    await expect(createCaller().connectUserToken({ pluginId: 'nope', token: 'x' })).rejects.toThrow(
      /Unknown plugin/,
    );
  });

  it('unwinds after a rejected token grant, so a failed paste leaves no install behind', async () => {
    mcpLifecycleMocks.grantUserToken.mockRejectedValue(new Error('Token rejected'));
    await expect(
      createCaller().connectUserToken({ pluginId: 'github', token: 'bad' }),
    ).rejects.toThrow('Token rejected');
    expect(unwindMock).toHaveBeenCalledExactlyOnceWith(db, 'github');
  });

  it('unwinds an abandoned connect attempt when the renderer reports it ended', async () => {
    await createCaller().connectAttemptEnded({ pluginId: 'notion' });
    expect(unwindMock).toHaveBeenCalledExactlyOnceWith(db, 'notion');
  });

  it('classifies an expired token with refresh material as connected', async () => {
    readMcpCredentialsMock.mockResolvedValue({
      servers: {
        plugin_notion_notion: {
          oauth: {
            accessToken: 'a',
            refreshToken: 'r',
            clientId: 'c',
            expiresAt: Date.now() - 60_000,
          },
        },
      },
    });

    const result = await createCaller().vendorMcpStatus();

    expect(result.connected).toEqual([REF]);
    expect(result.awaitingAuth).toEqual([]);
  });

  it('classifies an expired token without refresh material as awaiting, with the last consent error', async () => {
    readMcpCredentialsMock.mockResolvedValue({
      servers: {
        plugin_notion_notion: { oauth: { accessToken: 'a', expiresAt: Date.now() - 60_000 } },
      },
    });
    getVendorPluginMcpConsentOutcomeMock.mockReturnValue({ error: 'consent timed out' });

    const result = await createCaller().vendorMcpStatus();

    expect(result.connected).toEqual([]);
    expect(result.awaitingAuth).toEqual([{ ...REF, lastError: 'consent timed out' }]);
  });

  it('hands the page an in-flight consent opened to the awaiting row, so the plugin page can offer it to copy', async () => {
    getGlobalMcpServersMock.mockResolvedValue({});
    readMcpCredentialsMock.mockResolvedValue({ servers: {} });
    getVendorPluginMcpConsentOutcomeMock.mockReturnValue(undefined);
    getVendorPluginMcpConsentUrlMock.mockReturnValue('https://mcp.notion.com/authorize?state=s');

    const result = await createCaller().vendorMcpStatus();

    expect(result.awaitingAuth).toEqual([
      { ...REF, consentUrl: 'https://mcp.notion.com/authorize?state=s' },
    ]);
  });

  it('classifies a fresh token as connected', async () => {
    readMcpCredentialsMock.mockResolvedValue({
      servers: {
        plugin_notion_notion: { oauth: { accessToken: 'a', expiresAt: Date.now() + 10 * 60_000 } },
      },
    });

    const result = await createCaller().vendorMcpStatus();

    expect(result.connected).toEqual([REF]);
  });

  it('classifies a token the server granted no expiry for as connected', async () => {
    readMcpCredentialsMock.mockResolvedValue({
      servers: { plugin_notion_notion: { oauth: { accessToken: 'a' } } },
    });

    const result = await createCaller().vendorMcpStatus();

    expect(result.connected).toEqual([REF]);
  });

  it('classifies an absent credential as awaiting', async () => {
    readMcpCredentialsMock.mockResolvedValue({ servers: {} });

    const result = await createCaller().vendorMcpStatus();

    expect(result.connected).toEqual([]);
    expect(result.awaitingAuth).toEqual([REF]);
  });

  it('classifies an expired token with partial refresh material as awaiting', async () => {
    // refreshToken without clientId cannot be refreshed by delivery — connected
    // here would assert a capability the next session start cannot honor.
    readMcpCredentialsMock.mockResolvedValue({
      servers: {
        plugin_notion_notion: {
          oauth: { accessToken: 'a', refreshToken: 'r', expiresAt: Date.now() - 60_000 },
        },
      },
    });

    const result = await createCaller().vendorMcpStatus();

    expect(result.connected).toEqual([]);
    expect(result.awaitingAuth).toEqual([REF]);
  });

  it('classifies each target independently', async () => {
    const other = { ...TARGET, serverName: 'plugin_acme_acme', pluginName: 'acme' };
    listConnectableVendorPluginMcpMock.mockReturnValue([TARGET, other]);
    getGlobalMcpServersMock.mockResolvedValue({
      plugin_notion_notion: { name: 'notion (plugin)' },
      plugin_acme_acme: { name: 'acme (plugin)' },
    });
    readMcpCredentialsMock.mockResolvedValue({
      servers: { plugin_notion_notion: { oauth: { accessToken: 'a' } } },
    });

    const result = await createCaller().vendorMcpStatus();

    expect(result.connected).toEqual([REF]);
    expect(result.awaitingAuth).toEqual([{ serverName: 'plugin_acme_acme', pluginName: 'acme' }]);
  });

  it('classifies an unregistered server as awaiting even when a credential is stored', async () => {
    // The registry is the delivery authority: resolveFrinkMcpServers enumerates it,
    // so an unregistered server genuinely delivers no tools — awaiting is truthful.
    getGlobalMcpServersMock.mockResolvedValue({});
    readMcpCredentialsMock.mockResolvedValue({
      servers: { plugin_notion_notion: { oauth: { accessToken: 'a' } } },
    });

    const result = await createCaller().vendorMcpStatus();

    expect(result.awaitingAuth).toEqual([REF]);
    expect(result.connected).toEqual([]);
  });
});

describe('pluginsRouter — chat-only catalog plugins dispatch to the MCP lifecycle', () => {
  const installedNotion = { ...installedShortcut, id: 'install-notion', pluginId: 'notion' };

  beforeEach(() => {
    getDatabaseMock.mockReturnValue(db);
    for (const mock of Object.values(mcpLifecycleMocks)) mock.mockReset();
  });

  it('routes install, uninstall and setEnabled for a catalog id to the MCP lifecycle', async () => {
    mcpLifecycleMocks.install.mockResolvedValue({ installation: installedNotion, consent: {} });
    mcpLifecycleMocks.uninstall.mockResolvedValue({
      ...installedNotion,
      isInstalled: false,
      isEnabled: false,
    });
    mcpLifecycleMocks.setEnabled.mockResolvedValue({ ...installedNotion, isEnabled: false });
    await expect(createCaller().install({ pluginId: 'notion' })).resolves.toMatchObject({
      installation: { pluginId: 'notion' },
    });
    await expect(createCaller().uninstall({ pluginId: 'notion' })).resolves.toMatchObject({
      installation: { isInstalled: false },
    });
    await expect(
      createCaller().setEnabled({ pluginId: 'notion', enabled: false }),
    ).resolves.toMatchObject({ installation: { isEnabled: false } });
    expect(mcpLifecycleMocks.install).toHaveBeenCalledWith(db, 'notion');
    expect(mcpLifecycleMocks.uninstall).toHaveBeenCalledWith(db, 'notion');
    expect(mcpLifecycleMocks.setEnabled).toHaveBeenCalledWith(db, 'notion', false);
  });

  it('adds and toggles a chat-only plugin: its tools are minted on this machine', async () => {
    mcpLifecycleMocks.install.mockResolvedValue({ installation: installedNotion, consent: {} });
    mcpLifecycleMocks.setEnabled.mockResolvedValue({ ...installedNotion, isEnabled: false });

    await expect(createCaller().install({ pluginId: 'notion' })).resolves.toMatchObject({
      installation: { pluginId: 'notion', isInstalled: true },
    });
    await expect(
      createCaller().setEnabled({ pluginId: 'notion', enabled: false }),
    ).resolves.toMatchObject({ installation: { isEnabled: false } });
  });

  it('rejects an id no plugin claims before touching either lifecycle', async () => {
    await expect(createCaller().install({ pluginId: 'nope' })).rejects.toThrow(/Unknown plugin/);
    expect(mcpLifecycleMocks.install).not.toHaveBeenCalled();
  });

  it('connectVendorMcp installs a catalog plugin first and returns its consent map', async () => {
    mcpLifecycleMocks.install.mockResolvedValue({
      installation: installedNotion,
      consent: { plugin_notion_notion: { ok: true, at: 1 } },
    });
    // The procedure's output transform camel-cases keys; the renderer reads only `.ok` per entry.
    await expect(createCaller().connectVendorMcp({ pluginName: 'notion' })).resolves.toEqual({
      pluginNotionNotion: { ok: true, at: 1 },
    });
    // Whatever the consent returned, main judges the install by state afterwards.
    expect(unwindMock).toHaveBeenLastCalledWith(db, 'notion');
    expect(mcpLifecycleMocks.install).toHaveBeenCalledWith(db, 'notion', {
      reconnect: undefined,
    });
  });

  it('passes explicit reconnect through to the existing MCP lifecycle', async () => {
    mcpLifecycleMocks.install.mockResolvedValue({ installation: installedNotion, consent: {} });
    await createCaller().connectVendorMcp({ pluginName: 'notion', reconnect: true });
    expect(mcpLifecycleMocks.install).toHaveBeenCalledWith(db, 'notion', { reconnect: true });
  });

  it('connectVendorMcp is for chat-only plugins: a webhook-only plugin id is rejected before any lifecycle runs', async () => {
    unwindMock.mockClear();
    await expect(
      createCaller().connectVendorMcp({ pluginName: 'generic_webhook' }),
    ).rejects.toThrow(/Unknown plugin/);
    expect(mcpLifecycleMocks.install).not.toHaveBeenCalled();
    expect(unwindMock).not.toHaveBeenCalled();
  });
});
