import { Server } from 'node:http';
import { connect as netConnect, createServer } from 'node:net';
import type { Query } from '@anthropic-ai/claude-agent-sdk';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { GLOBAL_MCP_PATH, updateClaudeConfigAtomic, updateMcpServerConfig } from '../../claude-config';
import { cancelAllPendingOAuth, handleMcpOAuthCallback, startMcpOAuth } from '../../mcp-auth';
import { __resetSessionsForTest, createSession, retainSession } from '../../socket/claude-session-registry';
import type { FrinkMcpCredentialsFile } from '../types';
import { hasStoredVendorPluginMcpCredential, vendorPluginMcpStatus } from './vendor-plugin-mcp-status';
import { FRINK_CLIENT_METADATA_URL } from './mcp-auth-provider';

const {
  listStagedVendorPluginMcpServersMock,
  getMcpCredentialsMock,
  getGlobalMcpServersMock,
  removeGlobalMcpServerMock,
  setGlobalMcpServerMock,
  toggleGlobalMcpEnabledMock,
  openExternalMock,
  captureMainMessageMock,
  credentialsFile,
} = vi.hoisted(() => {
  const credentialsFile: { servers: Record<string, unknown>; locked: boolean } = { servers: {}, locked: false };
  return {
    listStagedVendorPluginMcpServersMock: vi.fn(),
    captureMainMessageMock: vi.fn<(message: string, level?: string, tags?: Record<string, string>) => void>(),
    getMcpCredentialsMock: vi.fn(async (name: string) => credentialsFile.servers[name]),
    // The real config functions take the credentials mutex themselves (non-reentrant):
    // calling them while the credentials updater runs is a deadlock, so the doubles refuse it.
    removeGlobalMcpServerMock: vi.fn(async () => {
      if (credentialsFile.locked) throw new Error('removeGlobalMcpServer called inside the credentials lock');
    }),
    setGlobalMcpServerMock: vi.fn(async () => {
      if (credentialsFile.locked) throw new Error('setGlobalMcpServer called inside the credentials lock');
    }),
    toggleGlobalMcpEnabledMock: vi.fn(async () => {}),
    getGlobalMcpServersMock: vi.fn(async () => ({})),
    openExternalMock: vi.fn(async (_url: string) => {}),
    credentialsFile,
  };
});

// Boundary mocks: the real store is ~/.frink, the real flow opens the system browser, and Sentry is the alert channel under test.
// oxlint-disable-next-line anti-slop/no-module-mocking
vi.mock('electron', () => ({ shell: { openExternal: openExternalMock }, BrowserWindow: { getAllWindows: () => [] } }));
// oxlint-disable-next-line anti-slop/no-module-mocking
vi.mock('../../sentry/init', () => ({ captureMainMessage: captureMainMessageMock }));
// oxlint-disable-next-line anti-slop/no-module-mocking
vi.mock('../../claude/vendor-plugins/mcp-servers', () => ({
  listStagedVendorPluginMcpServers: listStagedVendorPluginMcpServersMock,
}));
/** Two fixtures over the real catalog: a row Frink registers itself for, and a pinned row whose
 * vendor pre-registered a public client on a fixed port (the other consent shape). */
// oxlint-disable-next-line anti-slop/no-module-mocking
vi.mock('../../../../shared/integrations/plugins', async (importOriginal) => {
  const original = await importOriginal<typeof import('../../../../shared/integrations/plugins')>();
  const contents = {
    mcpServers: [
      {
        id: 'notion',
        label: 'Notion test',
        ownership: 'provider_native',
        schemaSource: 'mcp_tools_list',
        transport: { type: 'http', url: 'https://mcp.notion.test/mcp', auth: { kind: 'frink_client' } },
        connectionBinding: { type: 'none' },
      },
    ],
    skills: [],
    nativeExtensions: [],
    triggers: [],
    actions: [],
  };
  const vendorClient = {
    kind: 'static_client',
    clientId: 'vendor-public-client',
    callbackPort: 3118,
  } as const;
  return {
    ...original,
    PLUGIN_DEFINITIONS: [
      ...original.PLUGIN_DEFINITIONS.map((definition) =>
        definition.id === 'clickup'
          ? {
              ...definition,
              contents: {
                ...definition.contents,
                mcpServers: definition.contents.mcpServers.map((server) =>
                  server.transport.type === 'http'
                    ? { ...server, transport: { ...server.transport, auth: vendorClient } }
                    : server,
                ),
              },
            }
          : definition,
      ),
      {
        id: 'notiontest',
        name: 'Notion test',
        description: 'Fixture',
        icon: 'notiontest',
        source: { kind: 'frink_builtin' },
        availability: 'available',
        contents,
        runtimeSupport: original.PLUGIN_DEFINITIONS[0]!.runtimeSupport,
      },
    ],
  };
});
// oxlint-disable-next-line anti-slop/no-module-mocking
vi.mock('../config', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../config')>()),
  getMcpCredentials: getMcpCredentialsMock,
  readMcpCredentials: async () => credentialsFile,
  getGlobalMcpServers: getGlobalMcpServersMock,
  removeGlobalMcpServer: removeGlobalMcpServerMock,
  setGlobalMcpServer: setGlobalMcpServerMock,
  toggleGlobalMcpEnabled: toggleGlobalMcpEnabledMock,
  updateMcpCredentialsAtomic: async (
    updater: (file: FrinkMcpCredentialsFile) => FrinkMcpCredentialsFile | Promise<FrinkMcpCredentialsFile>,
  ) => {
    credentialsFile.locked = true;
    try {
      const next = await updater(credentialsFile as FrinkMcpCredentialsFile);
      credentialsFile.servers = next.servers;
      return next;
    } finally {
      credentialsFile.locked = false;
    }
  },
}));

import {
  armVendorPluginMcpConsent,
  connectVendorPluginMcp,
  cancelVendorPluginMcpConsent,
  getVendorPluginMcpConsentOutcome,
  getVendorPluginMcpConsentUrl,
  listConnectableVendorPluginMcp,
  persistAccountCredential,
  removeVendorPluginMcpCredentials,
  resetVendorPluginMcpConsentForTests,
  setVendorPluginMcpDeliveryEnabled,
  startVendorPluginMcpConsent,
} from './vendor-plugin-oauth';

// The catalog's own ClickUp declaration is the client authority; a staged
// manifest is matched to it by exact url.
const CLICKUP_URL = 'https://mcp.clickup.com/mcp';
const CLICKUP_ORIGIN = 'https://mcp.clickup.com';
const clickupStaged = { pluginName: 'clickup', serverKey: 'clickup', url: CLICKUP_URL };
const NOTION_URL = 'https://mcp.notion.test/mcp';
const notionStaged = { pluginName: 'notiontest', serverKey: 'notion', url: NOTION_URL };

type AuthServerFixture = {
  /** MCP server origin (where protected-resource metadata lives). */
  origin: string;
  /** Authorization server origin; defaults to the MCP origin. */
  as?: string;
  scopes?: string[];
  /** Publish RFC 9728 protected-resource metadata (default true). */
  prm?: boolean;
  registration?: boolean;
  cimd?: boolean;
  /** Whether Frink's hosted client-metadata document answers 200 to HEAD. */
  cimdDocument?: boolean;
  authMethods?: string[];
  token?: Record<string, unknown>;
  register?: Record<string, unknown>;
};

type Recorded = { url: string; method: string; body: string };

/** A global-fetch router standing in for the vendor: the real MCP SDK runs against it; loopback traffic passes through. */
function mockAuthServer(fixture: AuthServerFixture) {
  const as = fixture.as ?? fixture.origin;
  const calls: Recorded[] = [];
  const realFetch = globalThis.fetch;
  const spy = vi.spyOn(globalThis, 'fetch').mockImplementation(async (input, init) => {
    const url = String(input instanceof Request ? input.url : input);
    const method = (init?.method ?? 'GET').toUpperCase();
    const body = typeof init?.body === 'string' ? init.body : init?.body ? String(init.body) : '';
    if (url.startsWith('http://127.0.0.1:') || url.startsWith('http://localhost:')) return realFetch(input, init);
    calls.push({ url, method, body });
    if (url === FRINK_CLIENT_METADATA_URL) {
      return new Response(null, { status: fixture.cimdDocument === false ? 404 : 200 });
    }
    if (url.startsWith(`${fixture.origin}/.well-known/oauth-protected-resource`)) {
      if (fixture.prm === false) return new Response('not found', { status: 404 });
      return Response.json({
        resource: fixture.origin,
        authorization_servers: [as],
        scopes_supported: fixture.scopes ?? ['chat:write'],
        bearer_methods_supported: ['header'],
      });
    }
    if (
      url.startsWith(`${as}/.well-known/oauth-authorization-server`) ||
      url.startsWith(`${as}/.well-known/openid-configuration`)
    ) {
      return Response.json({
        issuer: as,
        authorization_endpoint: `${as}/authorize`,
        token_endpoint: `${as}/token`,
        response_types_supported: ['code'],
        code_challenge_methods_supported: ['S256'],
        token_endpoint_auth_methods_supported: fixture.authMethods ?? ['none'],
        scopes_supported: fixture.scopes ?? ['chat:write'],
        ...(fixture.registration ? { registration_endpoint: `${as}/register` } : {}),
        ...(fixture.cimd ? { client_id_metadata_document_supported: true } : {}),
      });
    }
    if (url === `${as}/register`) {
      const requested = JSON.parse(body) as { redirect_uris: string[] };
      return Response.json(
        fixture.register ?? {
          client_id: 'dyn-client-1',
          redirect_uris: requested.redirect_uris,
          token_endpoint_auth_method: 'none',
        },
        { status: 201 },
      );
    }
    if (url === `${as}/token`) {
      return Response.json(
        fixture.token ?? { access_token: 'tok-1', token_type: 'bearer', refresh_token: 'r-1', expires_in: 3600 },
      );
    }
    return new Response('unexpected', { status: 500 });
  });
  return { calls, restore: () => spy.mockRestore(), tokenCalls: () => calls.filter((c) => c.url === `${as}/token`) };
}

const browser = { headers: { connection: 'close' }, redirect: 'manual' as const };
const NEXT_HOP = 'https://auth.frink.test/oauth/connect/clickup?connect_session_token=cst';

/** Arms the ClickUp consent the way a Connect chain does and reads back the state Frink minted for it. */
async function armClickup(nextHop?: string): Promise<{ authUrl: string; completed: Promise<void>; state: string }> {
  const armed = await armVendorPluginMcpConsent('clickup', { nextHop });
  if (!armed) throw new Error('expected a consent to arm');
  return { ...armed, state: new URL(armed.authUrl).searchParams.get('state') ?? '' };
}

/** Drives the loopback callback under an armed consent's state. */
function callbackFor(state: string, query = 'code=code-armed'): Promise<Response> {
  return fetch(`http://127.0.0.1:3118/callback?${query}&state=${state}`, browser);
}

/** Drives the loopback callback the way the browser would, using the state Frink minted. */
async function completeConsentInBrowser(code: string): Promise<{ authUrl: URL; callback: Response }> {
  await vi.waitFor(() => expect(openExternalMock).toHaveBeenCalled());
  const authUrl = new URL(openExternalMock.mock.calls[0]![0]);
  const state = authUrl.searchParams.get('state') ?? '';
  const redirect = new URL(authUrl.searchParams.get('redirect_uri') ?? '');
  const callback = await fetch(`http://127.0.0.1:${redirect.port}/callback?code=${code}&state=${state}`, browser);
  return { authUrl, callback };
}

afterEach(async () => {
  await resetVendorPluginMcpConsentForTests();
  vi.clearAllMocks();
  vi.restoreAllMocks();
  credentialsFile.servers = {};
  credentialsFile.locked = false;
  getGlobalMcpServersMock.mockResolvedValue({});
});

describe('listConnectableVendorPluginMcp', () => {
  it('resolves the auth from the catalog by exact url, never from the manifest', async () => {
    listStagedVendorPluginMcpServersMock.mockReturnValue([clickupStaged, notionStaged]);
    expect(await listConnectableVendorPluginMcp()).toEqual(expect.arrayContaining([
      expect.objectContaining({
        serverName: 'plugin_clickup_clickup',
        pluginName: 'clickup',
        url: CLICKUP_URL,
        auth: expect.objectContaining({ kind: 'static_client', callbackPort: 3118 }),
      }),
      expect.objectContaining({
        serverName: 'plugin_notiontest_notion',
        url: NOTION_URL,
        auth: { kind: 'frink_client' },
      }),
    ]));
  });

  it('yields nothing for a staged url the catalog does not declare (a trailing slash is a different server)', async () => {
    listStagedVendorPluginMcpServersMock.mockReturnValue([{ ...clickupStaged, url: `${CLICKUP_URL}/` }]);
    expect((await listConnectableVendorPluginMcp()).map((t) => t.pluginName)).not.toContain('clickup');
  });

  it('lists an available catalog row from its own declaration even when nothing is staged, never a pinned one', async () => {
    listStagedVendorPluginMcpServersMock.mockReturnValue([]);
    const targets = await listConnectableVendorPluginMcp();
    expect(targets).toContainEqual(
      expect.objectContaining({ serverName: 'plugin_notiontest_notion', pluginName: 'notiontest', auth: { kind: 'frink_client' } }),
    );
    expect(targets.map((t) => t.pluginName)).not.toContain('clickup');
  });
});

describe('Hugging Face official package connection', () => {
  const serverName = 'plugin_huggingface-skills_huggingface-skills';
  const staged = { pluginName: 'huggingface-skills', serverKey: 'huggingface-skills', url: 'https://huggingface.co/mcp?login' };
  it('maps the vendor package to the builtin identity and preserves the native server name', async () => {
    listStagedVendorPluginMcpServersMock.mockReturnValue([staged]);
    expect(await listConnectableVendorPluginMcp()).toContainEqual(expect.objectContaining({
      serverName, pluginName: 'huggingface', url: staged.url,
      auth: expect.objectContaining({ kind: 'frink_client', scope: expect.stringContaining('webhooks') }),
    }));
  });
  it('requires consent when a stored tools grant lacks webhook permission', async () => {
    listStagedVendorPluginMcpServersMock.mockReturnValue([staged]);
    credentialsFile.servers = { [serverName]: { oauth: { accessToken: 'existing', scope: 'read-mcp' } } };
    getGlobalMcpServersMock.mockResolvedValue({ [serverName]: { url: staged.url } });
    const connect = vi.fn(async (name: string) => ({ serverName: name }));
    await startVendorPluginMcpConsent('huggingface', connect);
    expect(connect).toHaveBeenCalledWith(serverName);
    expect((await vendorPluginMcpStatus()).awaitingAuth).toContainEqual(expect.objectContaining({ serverName }));
  });
  it('opens the browser with tools and webhook scopes, then stores the granted scope', async () => {
    listStagedVendorPluginMcpServersMock.mockReturnValue([staged]);
    credentialsFile.servers = { [serverName]: { oauth: { accessToken: 'existing', clientId: 'old-client', scope: 'read-mcp' } } };
    getGlobalMcpServersMock.mockResolvedValue({ [serverName]: { url: staged.url } });
    const vendor = mockAuthServer({ origin: 'https://huggingface.co', cimd: true, scopes: ['read-mcp'], token: { access_token: 'new', token_type: 'bearer' } });
    try {
      const pending = connectVendorPluginMcp(serverName);
      const { authUrl } = await completeConsentInBrowser('new-consent');
      expect(authUrl.searchParams.get('scope')?.split(' ')).toEqual(expect.arrayContaining(['read-mcp', 'webhooks']));
      await expect(pending).resolves.toMatchObject({ serverName });
      expect(credentialsFile.servers[serverName]).toMatchObject({ oauth: { scope: expect.stringContaining('webhooks') } });
    } finally { vendor.restore(); }
  });
});

describe('removeVendorPluginMcpCredentials', () => {
  it('sweeps the credential and canonical entry of a catalog-declared server', async () => {
    listStagedVendorPluginMcpServersMock.mockReturnValue([clickupStaged]);
    credentialsFile.servers = {
      plugin_clickup_clickup: { oauth: { accessToken: 't' } },
      plugin_other_x: { oauth: { accessToken: 'keep' } },
    };
    await expect(removeVendorPluginMcpCredentials('clickup')).resolves.toEqual(['plugin_clickup_clickup']);
    expect(Object.keys(credentialsFile.servers)).toEqual(['plugin_other_x']);
    expect(removeGlobalMcpServerMock).toHaveBeenCalledWith('plugin_clickup_clickup');
  });

  it('retires the in-flight sign-in page too, so the plugin page cannot offer a dead link', async () => {
    listStagedVendorPluginMcpServersMock.mockReturnValue([clickupStaged]);
    const vendor = mockAuthServer({ origin: CLICKUP_ORIGIN });
    try {
      const pending = connectVendorPluginMcp('plugin_clickup_clickup');
      pending.catch(() => {});
      await vi.waitFor(() => expect(getVendorPluginMcpConsentUrl('plugin_clickup_clickup')).toBeDefined());
      await removeVendorPluginMcpCredentials('clickup');
      expect(getVendorPluginMcpConsentUrl('plugin_clickup_clickup')).toBeUndefined();
    } finally {
      vendor.restore();
    }
  });

  it('cancels an in-flight consent by exact registration after its package is unstaged', async () => {
    listStagedVendorPluginMcpServersMock.mockReturnValue([clickupStaged]);
    const vendor = mockAuthServer({ origin: CLICKUP_ORIGIN });
    try {
      const pending = connectVendorPluginMcp('plugin_clickup_clickup');
      void pending.catch(() => {});
      await vi.waitFor(() => expect(getVendorPluginMcpConsentUrl('plugin_clickup_clickup')).toBeDefined());
      listStagedVendorPluginMcpServersMock.mockReturnValue([]);
      getGlobalMcpServersMock.mockResolvedValue({ plugin_clickup_clickup: { name: 'clickup (plugin)', managedBy: 'vendor_plugin' } });
      await cancelVendorPluginMcpConsent('clickup');
      await expect(pending).rejects.toThrow();
      expect(getVendorPluginMcpConsentUrl('plugin_clickup_clickup')).toBeUndefined();
      expect(setGlobalMcpServerMock).not.toHaveBeenCalled();
    } finally {
      vendor.restore();
    }
  });

  it('resolves the owned server from its exact registration when declarations are unstaged', async () => {
    listStagedVendorPluginMcpServersMock.mockReturnValue([]);
    getGlobalMcpServersMock.mockResolvedValue({
      plugin_clickup_clickup: { name: 'clickup (plugin)', managedBy: 'vendor_plugin' },
      other_server: { name: 'other', managedBy: 'user' },
    });
    credentialsFile.servers = { plugin_clickup_clickup: { oauth: { accessToken: 'live' } } };
    await expect(removeVendorPluginMcpCredentials('clickup')).resolves.toEqual(['plugin_clickup_clickup']);
    expect(credentialsFile.servers.plugin_clickup_clickup).toBeUndefined();
    expect(removeGlobalMcpServerMock).toHaveBeenCalledWith('plugin_clickup_clickup');
  });
});

it.each([{ staged: [] }, { staged: [clickupStaged] }])('cleans current and old exact registrations with staged targets $staged', async ({ staged }) => {
  listStagedVendorPluginMcpServersMock.mockReturnValue(staged);
  getGlobalMcpServersMock.mockResolvedValue({
    plugin_clickup_old: { name: 'clickup (plugin)', managedBy: 'vendor_plugin', url: 'https://old.clickup.test/mcp' },
    plugin_slack_other_x: { name: 'slack_other (plugin)', managedBy: 'vendor_plugin' },
    user_server: { name: 'clickup (plugin)', managedBy: 'user' },
  });
  credentialsFile.servers = {
    plugin_clickup_old: { oauth: { accessToken: 'old' } },
    plugin_slack_other_x: { oauth: { accessToken: 'keep' } },
    user_server: { oauth: { accessToken: 'keep' } },
  };
  await setVendorPluginMcpDeliveryEnabled('clickup', false);
  expect(toggleGlobalMcpEnabledMock).toHaveBeenCalledWith('plugin_clickup_old', false);
  expect(toggleGlobalMcpEnabledMock).not.toHaveBeenCalledWith('plugin_slack_other_x', false);
  expect(toggleGlobalMcpEnabledMock).not.toHaveBeenCalledWith('user_server', false);
  await expect(removeVendorPluginMcpCredentials('clickup')).resolves.toEqual(['plugin_clickup_old']);
  expect(Object.keys(credentialsFile.servers)).toEqual(['plugin_slack_other_x', 'user_server']);
});

it('retains the installation grant when a newly pinned package is not staged yet', async () => {
  listStagedVendorPluginMcpServersMock.mockReturnValue([]);
  getGlobalMcpServersMock.mockResolvedValue({
    plugin_slack_previous: { name: 'clickup (plugin)', managedBy: 'vendor_plugin' },
    plugin_slack_other_x: { name: 'slack_other (plugin)', managedBy: 'vendor_plugin' },
  });
  credentialsFile.servers = {
    plugin_slack_previous: { oauth: { accessToken: 'prior-grant', expiresAt: 1 } },
  };
  expect((await vendorPluginMcpStatus()).connected).toEqual([]);
  expect(await hasStoredVendorPluginMcpCredential('clickup')).toBe(true);
  expect(await hasStoredVendorPluginMcpCredential('slack_other')).toBe(false);
  expect(removeGlobalMcpServerMock).not.toHaveBeenCalled();
  credentialsFile.servers = {};
  expect(await hasStoredVendorPluginMcpCredential('clickup')).toBe(false);
});

describe('persistAccountCredential', () => {
  it("stores the account grant's token as a never-expiring consent on the plugin's OAuth-declared server and registers it", async () => {
    listStagedVendorPluginMcpServersMock.mockReturnValue([]);
    await persistAccountCredential('linear', 'lin_account_token');
    expect(credentialsFile.servers.plugin_linear_linear).toEqual({
      oauth: { accessToken: 'lin_account_token' },
      headers: { Authorization: 'Bearer lin_account_token' },
    });
    expect(setGlobalMcpServerMock).toHaveBeenCalledExactlyOnceWith(
      'plugin_linear_linear',
      expect.objectContaining({ url: 'https://mcp.linear.app/mcp', managedBy: 'vendor_plugin', enabled: true }),
    );
  });

  it('refuses a plugin with no OAuth-declared server, storing nothing', async () => {
    listStagedVendorPluginMcpServersMock.mockReturnValue([]);
    await expect(persistAccountCredential('clickup', 'tok')).rejects.toThrow('No OAuth plugin MCP server');
    expect(credentialsFile.servers).toEqual({});
    expect(setGlobalMcpServerMock).not.toHaveBeenCalled();
  });
});

describe('an MCP change retires idle Claude CLIs spawned on the old config', () => {
  it.each([
    ['connected', () => persistAccountCredential('linear', 'lin_account_token')],
    ['turned off', () => setVendorPluginMcpDeliveryEnabled('clickup', false)],
    ['removed', () => removeVendorPluginMcpCredentials('clickup')],
  ])('%s', async (_, change) => {
    __resetSessionsForTest();
    listStagedVendorPluginMcpServersMock.mockReturnValue([clickupStaged]);
    const close = vi.fn();
    const next = () => new Promise(() => {});
    retainSession(createSession('idle-sub', () => ({ close, next }) as unknown as Query));

    await change();

    expect(close).toHaveBeenCalledOnce();
  });

  it('a native server signed in over OAuth', async () => {
    __resetSessionsForTest();
    const close = vi.fn();
    const next = () => new Promise(() => {});
    retainSession(createSession('idle-sub', () => ({ close, next }) as unknown as Query));
    const url = 'https://mcp.native.test/mcp';
    await updateClaudeConfigAtomic((c) => updateMcpServerConfig(c, GLOBAL_MCP_PATH, 'native', { url }));
    const vendor = mockAuthServer({ origin: 'https://mcp.native.test' });
    try {
      const signIn = startMcpOAuth('native', GLOBAL_MCP_PATH);
      await vi.waitFor(() => expect(openExternalMock).toHaveBeenCalled());
      const state = new URL(openExternalMock.mock.calls[0]![0]).searchParams.get('state') ?? '';
      await handleMcpOAuthCallback('code-native', state);
      expect(await signIn).toEqual({ success: true });
      expect(close).toHaveBeenCalledOnce();
    } finally {
      vendor.restore();
    }
  });
});

describe('startMcpOAuth loopback (Settings → MCP)', () => {
  const url = 'https://mcp.settings.test/mcp';
  const refused = (port: number) =>
    new Promise<boolean>((resolve) => {
      const socket = netConnect(port, '127.0.0.1');
      socket.once('connect', () => {
        socket.destroy();
        resolve(false);
      });
      socket.once('error', () => resolve(true));
    });
  /** Start a flow and return the redirect_uri and state the browser was sent with. */
  const begin = async (serverName: string) => {
    openExternalMock.mockClear();
    await updateClaudeConfigAtomic((c) => updateMcpServerConfig(c, GLOBAL_MCP_PATH, serverName, { url }));
    const signIn = startMcpOAuth(serverName, GLOBAL_MCP_PATH);
    await vi.waitFor(() => expect(openExternalMock).toHaveBeenCalled());
    const authorize = new URL(openExternalMock.mock.calls[0]![0]);
    return {
      signIn,
      redirect: new URL(authorize.searchParams.get('redirect_uri') ?? ''),
      state: authorize.searchParams.get('state') ?? '',
    };
  };

  it('listens on the redirect_uri it sends, with no dev server, and completes from a real browser hit', async () => {
    const vendor = mockAuthServer({ origin: 'https://mcp.settings.test', registration: true });
    try {
      const { signIn, redirect, state } = await begin('settings-a');
      expect(redirect.protocol).toBe('http:');
      expect(redirect.hostname).toBe('127.0.0.1');
      expect(redirect.pathname).toBe('/callback');
      const port = Number(redirect.port);

      const page = await fetch(`${redirect.origin}/callback?code=code-a&state=${state}`, browser);
      expect(page.status).toBe(200);
      expect(await signIn).toEqual({ success: true });
      expect(await refused(port)).toBe(true);

      // One redirect_uri across registration, authorize and the token exchange.
      const registered = vendor.calls.find((c) => c.url.endsWith('/register'));
      expect(JSON.parse(registered!.body).redirect_uris).toEqual([redirect.href]);
      expect(new URLSearchParams(vendor.tokenCalls()[0]!.body).get('redirect_uri')).toBe(redirect.href);
    } finally {
      vendor.restore();
    }
  });

  it('settles a vendor denial at once instead of waiting out the timeout', async () => {
    const vendor = mockAuthServer({ origin: 'https://mcp.settings.test' });
    try {
      const { signIn, redirect, state } = await begin('settings-deny');
      await fetch(`${redirect.origin}/callback?error=access_denied&state=${state}`, browser);
      expect(await signIn).toEqual({ success: false, error: 'access_denied' });
      expect(vendor.tokenCalls()).toHaveLength(0);
      expect(await refused(Number(redirect.port))).toBe(true);
    } finally {
      vendor.restore();
    }
  });

  it('gives concurrent flows their own ports, and cancelAllPendingOAuth releases them', async () => {
    const vendor = mockAuthServer({ origin: 'https://mcp.settings.test' });
    try {
      const first = await begin('settings-b');
      const second = await begin('settings-c');
      expect(first.redirect.port).not.toBe(second.redirect.port);

      cancelAllPendingOAuth();
      expect(await first.signIn).toEqual({ success: false, error: 'Cancelled' });
      expect(await second.signIn).toEqual({ success: false, error: 'Cancelled' });
      expect(await refused(Number(first.redirect.port))).toBe(true);
      expect(await refused(Number(second.redirect.port))).toBe(true);
    } finally {
      vendor.restore();
    }
  });

  it('a callback that lands by the deep link first closes the loopback and exchanges exactly once', async () => {
    const vendor = mockAuthServer({ origin: 'https://mcp.settings.test' });
    try {
      const { signIn, redirect, state } = await begin('settings-deeplink');
      await handleMcpOAuthCallback('code-deeplink', state);
      expect(await signIn).toEqual({ success: true });
      expect(await refused(Number(redirect.port))).toBe(true);
      // A late duplicate delivery of the same state is not a second flow.
      await handleMcpOAuthCallback('code-deeplink', state);
      expect(vendor.tokenCalls()).toHaveLength(1);
    } finally {
      vendor.restore();
    }
  });

  it('a cancel that lands during discovery, before the flow is pending, never opens the browser', async () => {
    const vendor = mockAuthServer({ origin: 'https://mcp.settings.test' });
    const route = vi.mocked(globalThis.fetch).getMockImplementation()!;
    let release!: () => void;
    const discovery = new Promise<void>((resolve) => {
      release = resolve;
    });
    vi.mocked(globalThis.fetch).mockImplementation(async (input, init) => {
      await discovery;
      return route(input, init);
    });
    try {
      openExternalMock.mockClear();
      await updateClaudeConfigAtomic((c) => updateMcpServerConfig(c, GLOBAL_MCP_PATH, 'settings-quit', { url }));
      const signIn = startMcpOAuth('settings-quit', GLOBAL_MCP_PATH);
      await vi.waitFor(() => expect(globalThis.fetch).toHaveBeenCalled());
      cancelAllPendingOAuth();
      release();
      expect(await signIn).toEqual({ success: false, error: 'Cancelled' });
      expect(openExternalMock).not.toHaveBeenCalled();
    } finally {
      vendor.restore();
    }
  });

  it('fails fast without opening the browser or registering when the loopback cannot bind', async () => {
    const vendor = mockAuthServer({ origin: 'https://mcp.settings.test', registration: true });
    const listen = vi.spyOn(Server.prototype, 'listen').mockImplementationOnce(function (this: Server) {
      process.nextTick(() => this.emit('error', Object.assign(new Error('listen EACCES'), { code: 'EACCES' })));
      return this;
    });
    try {
      openExternalMock.mockClear();
      await updateClaudeConfigAtomic((c) => updateMcpServerConfig(c, GLOBAL_MCP_PATH, 'settings-nobind', { url }));
      expect(await startMcpOAuth('settings-nobind', GLOBAL_MCP_PATH)).toEqual({
        success: false,
        error: 'listen EACCES',
      });
      expect(openExternalMock).not.toHaveBeenCalled();
      expect(vendor.calls).toHaveLength(0);
    } finally {
      listen.mockRestore();
      vendor.restore();
    }
  });

  it('fails fast without opening the browser when discovery fails', async () => {
    openExternalMock.mockClear();
    const spy = vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response('down', { status: 500 }));
    try {
      await updateClaudeConfigAtomic((c) =>
        updateMcpServerConfig(c, GLOBAL_MCP_PATH, 'settings-down', { url }),
      );
      const result = await startMcpOAuth('settings-down', GLOBAL_MCP_PATH);
      expect(result.success).toBe(false);
      expect(openExternalMock).not.toHaveBeenCalled();
    } finally {
      spy.mockRestore();
    }
  });
});

describe('setVendorPluginMcpDeliveryEnabled', () => {
  it("mirrors the toggle onto exactly the plugin's own registered servers, keeping the credential", async () => {
    listStagedVendorPluginMcpServersMock.mockReturnValue([clickupStaged]);
    credentialsFile.servers = { plugin_clickup_clickup: { oauth: { accessToken: 'live' } } };
    await setVendorPluginMcpDeliveryEnabled('clickup', false);
    expect(toggleGlobalMcpEnabledMock).toHaveBeenCalledExactlyOnceWith('plugin_clickup_clickup', false);
    expect(removeGlobalMcpServerMock).not.toHaveBeenCalled();
    expect(credentialsFile.servers.plugin_clickup_clickup).toBeDefined();
    await setVendorPluginMcpDeliveryEnabled('clickup', true);
    expect(toggleGlobalMcpEnabledMock).toHaveBeenLastCalledWith('plugin_clickup_clickup', true);
  });
});

describe('startVendorPluginMcpConsent', () => {
  it.each([CLICKUP_URL, 'https://mcp.slack.com/v2/mcp'])('compares the complete registered resource URL before reusing %s', async (url) => {
    listStagedVendorPluginMcpServersMock.mockReturnValue([clickupStaged]);
    credentialsFile.servers = { plugin_clickup_clickup: { oauth: { accessToken: 'fresh' } } };
    getGlobalMcpServersMock.mockResolvedValue({ plugin_clickup_clickup: { url } });
    const connect = vi.fn(async (serverName: string) => ({ serverName }));
    await startVendorPluginMcpConsent('clickup', connect);
    expect(connect).toHaveBeenCalledTimes(url === CLICKUP_URL ? 0 : 1);
    expect(setGlobalMcpServerMock).toHaveBeenCalledTimes(url === CLICKUP_URL ? 1 : 0);
  });

  it('explicit reconnect bypasses expiry-only reuse and forwards the SDK retry option', async () => {
    listStagedVendorPluginMcpServersMock.mockReturnValue([clickupStaged]);
    credentialsFile.servers = { plugin_clickup_clickup: { oauth: { accessToken: 'fresh' } } };
    getGlobalMcpServersMock.mockResolvedValue({ plugin_clickup_clickup: { url: CLICKUP_URL } });
    const connect = vi.fn(async (serverName: string) => ({ serverName }));
    await startVendorPluginMcpConsent('clickup', connect, { reconnect: true });
    expect(connect).toHaveBeenCalledWith('plugin_clickup_clickup', { reconnect: true });
    expect(setGlobalMcpServerMock).not.toHaveBeenCalled();
  });
  it('skips servers holding a usable credential and runs the rest sequentially, recording outcomes', async () => {
    listStagedVendorPluginMcpServersMock.mockReturnValue([clickupStaged]);
    const connect = vi.fn(async (serverName: string) => ({ serverName }));
    credentialsFile.servers = { plugin_clickup_clickup: { oauth: { accessToken: 'fresh' } } };
    await expect(startVendorPluginMcpConsent('clickup', connect)).resolves.toEqual({
      plugin_clickup_clickup: expect.objectContaining({ ok: true }),
    });
    expect(connect).not.toHaveBeenCalled();
    credentialsFile.servers = {};
    await startVendorPluginMcpConsent('clickup', connect);
    expect(connect).toHaveBeenCalledWith('plugin_clickup_clickup');
    expect(getVendorPluginMcpConsentOutcome('plugin_clickup_clickup')).toMatchObject({ ok: true });
  });

  it('records a failed consent instead of throwing — the account connect that fired it already succeeded', async () => {
    listStagedVendorPluginMcpServersMock.mockReturnValue([clickupStaged]);
    const connect = vi.fn(async () => {
      throw new Error('Timed out waiting for the browser authorization.');
    });
    await expect(startVendorPluginMcpConsent('clickup', connect)).resolves.toEqual({
      plugin_clickup_clickup: expect.objectContaining({ ok: false, error: expect.stringMatching(/Timed out/) }),
    });
  });

  it("ignores other plugins' servers", async () => {
    listStagedVendorPluginMcpServersMock.mockReturnValue([clickupStaged]);
    const connect = vi.fn();
    await expect(startVendorPluginMcpConsent('canva', connect)).resolves.toEqual({});
    expect(connect).not.toHaveBeenCalled();
  });
});

describe('connectVendorPluginMcp — static vendor client', () => {
  it('runs the PKCE flow end to end on the registered port: scoped auth url → loopback callback → token → credential + registration', async () => {
    listStagedVendorPluginMcpServersMock.mockReturnValue([clickupStaged]);
    const target = (await listConnectableVendorPluginMcp())[0]!;
    const clientId = target.auth.kind === 'static_client' ? target.auth.clientId : '';
    const vendor = mockAuthServer({ origin: CLICKUP_ORIGIN, scopes: ['chat:write'], token: { access_token: 'xoxp-1', token_type: 'bearer', refresh_token: 'r-1', expires_in: 3600 } });
    try {
      const pending = connectVendorPluginMcp('plugin_clickup_clickup');
      const { authUrl, callback } = await completeConsentInBrowser('code-1');
      await expect(pending).resolves.toMatchObject({ serverName: 'plugin_clickup_clickup', expiresAt: expect.any(Number) });
      expect(callback.status).toBe(200);
      expect(await callback.text()).toContain('Connected. You can close this tab and go back to Frink.');

      expect(authUrl.origin + authUrl.pathname).toBe(`${CLICKUP_ORIGIN}/authorize`);
      expect(authUrl.searchParams.get('client_id')).toBe(clientId);
      expect(authUrl.searchParams.get('scope')).toBe('chat:write');
      expect(authUrl.searchParams.get('code_challenge_method')).toBe('S256');
      expect(authUrl.searchParams.get('resource')).toBe(CLICKUP_URL);
      // The vendor's own registration names localhost on the pinned port.
      expect(authUrl.searchParams.get('redirect_uri')).toBe('http://localhost:3118/callback');
      const tokenBody = vendor.tokenCalls()[0]?.body ?? '';
      expect(tokenBody).toContain('code=code-1');
      expect(tokenBody).toContain(`client_id=${encodeURIComponent(clientId)}`);
      expect(tokenBody).not.toContain('client_secret');
      // No registration for a vendor-registered client.
      expect(vendor.calls.some((c) => c.url.endsWith('/register'))).toBe(false);
      expect(credentialsFile.servers.plugin_clickup_clickup).toMatchObject({
        oauth: { accessToken: 'xoxp-1', refreshToken: 'r-1', clientId, expiresAt: expect.any(Number) },
        headers: { Authorization: 'Bearer xoxp-1' },
      });
      expect(setGlobalMcpServerMock).toHaveBeenCalledWith(
        'plugin_clickup_clickup',
        expect.objectContaining({ url: CLICKUP_URL, managedBy: 'vendor_plugin', enabled: true }),
      );
    } finally {
      vendor.restore();
    }
  });

  it('renews a stale-but-refreshable credential silently: no browser, listener closed, registration converged', async () => {
    listStagedVendorPluginMcpServersMock.mockReturnValue([clickupStaged]);
    credentialsFile.servers = {
      plugin_clickup_clickup: { oauth: { accessToken: 'old', refreshToken: 'r-old', clientId: 'vendor-public-client', expiresAt: Date.now() - 1 } },
    };
    getGlobalMcpServersMock.mockResolvedValue({ plugin_clickup_clickup: { url: CLICKUP_URL, managedBy: 'vendor_plugin' } });
    // The vendor rotates nothing: the stored refresh token must survive the renewal.
    const vendor = mockAuthServer({ origin: CLICKUP_ORIGIN, token: { access_token: 'xoxp-new', token_type: 'bearer', expires_in: 3600 } });
    try {
      await expect(connectVendorPluginMcp('plugin_clickup_clickup')).resolves.toMatchObject({ serverName: 'plugin_clickup_clickup' });
      expect(openExternalMock).not.toHaveBeenCalled();
      expect(vendor.tokenCalls()[0]?.body).toContain('grant_type=refresh_token');
      expect(credentialsFile.servers.plugin_clickup_clickup).toMatchObject({ oauth: { accessToken: 'xoxp-new', refreshToken: 'r-old' } });
      expect(setGlobalMcpServerMock).toHaveBeenCalled();
      // The registered port is free again: a second consent binds it immediately.
      const occupant = createServer();
      await new Promise<void>((resolve) => occupant.listen(3118, '127.0.0.1', resolve));
      await new Promise<void>((resolve) => occupant.close(() => resolve()));
    } finally {
      vendor.restore();
    }
  });

  it('never renews a stored credential the registry minted for another url — the consent starts over in the browser', async () => {
    listStagedVendorPluginMcpServersMock.mockReturnValue([clickupStaged]);
    credentialsFile.servers = {
      plugin_clickup_clickup: { oauth: { accessToken: 'old', refreshToken: 'r-old', clientId: 'c', expiresAt: Date.now() + 3600000 } },
    };
    getGlobalMcpServersMock.mockResolvedValue({ plugin_clickup_clickup: { url: 'https://mcp.slack.com/v2/mcp', managedBy: 'vendor_plugin' } });
    const vendor = mockAuthServer({ origin: CLICKUP_ORIGIN });
    try {
      const pending = connectVendorPluginMcp('plugin_clickup_clickup');
      await completeConsentInBrowser('code-fresh');
      await pending;
      expect(vendor.tokenCalls().map((c) => c.body).join()).not.toContain('grant_type=refresh_token');
    } finally {
      vendor.restore();
    }
  });

  it('never renews a stored credential minted for a different vendor client id', async () => {
    listStagedVendorPluginMcpServersMock.mockReturnValue([clickupStaged]);
    credentialsFile.servers = {
      plugin_clickup_clickup: { oauth: { accessToken: 'old', refreshToken: 'r-old', clientId: 'previous-vendor-app', expiresAt: Date.now() - 1 } },
    };
    getGlobalMcpServersMock.mockResolvedValue({ plugin_clickup_clickup: { url: CLICKUP_URL, managedBy: 'vendor_plugin' } });
    const vendor = mockAuthServer({ origin: CLICKUP_ORIGIN, token: { access_token: 'fresh', token_type: 'bearer' } });
    try {
      const pending = connectVendorPluginMcp('plugin_clickup_clickup');
      await completeConsentInBrowser('code-fresh-client');
      await pending;
      expect(vendor.tokenCalls().map((c) => c.body).join()).not.toContain('grant_type=refresh_token');
      // A fresh code grant never inherits the previous grant's refresh token.
      expect(credentialsFile.servers.plugin_clickup_clickup).toMatchObject({ oauth: { accessToken: 'fresh', refreshToken: undefined } });
    } finally {
      vendor.restore();
    }
  });

  it('fails cleanly, persisting nothing, when the token response omits token_type', async () => {
    listStagedVendorPluginMcpServersMock.mockReturnValue([clickupStaged]);
    const vendor = mockAuthServer({ origin: CLICKUP_ORIGIN, token: { access_token: 'no-type' } });
    try {
      const pending = connectVendorPluginMcp('plugin_clickup_clickup');
      pending.catch(() => {});
      await completeConsentInBrowser('code-x');
      await expect(pending).rejects.toThrow();
      expect(credentialsFile.servers.plugin_clickup_clickup).toBeUndefined();
      expect(setGlobalMcpServerMock).not.toHaveBeenCalled();
    } finally {
      vendor.restore();
    }
  });

  it('exposes the sign-in page it opened while the consent is in flight, and drops it once settled', async () => {
    listStagedVendorPluginMcpServersMock.mockReturnValue([clickupStaged]);
    const vendor = mockAuthServer({ origin: CLICKUP_ORIGIN });
    try {
      const pending = connectVendorPluginMcp('plugin_clickup_clickup');
      await vi.waitFor(() => expect(openExternalMock).toHaveBeenCalled());
      expect(getVendorPluginMcpConsentUrl('plugin_clickup_clickup')).toBe(openExternalMock.mock.calls[0]![0]);
      await completeConsentInBrowser('code-url');
      await expect(pending).resolves.toMatchObject({ serverName: 'plugin_clickup_clickup' });
      expect(getVendorPluginMcpConsentUrl('plugin_clickup_clickup')).toBeUndefined();
    } finally {
      vendor.restore();
    }
  });

  it('answers a malformed request target with 404 and keeps the armed listener serving', async () => {
    listStagedVendorPluginMcpServersMock.mockReturnValue([clickupStaged]);
    const vendor = mockAuthServer({ origin: CLICKUP_ORIGIN });
    try {
      const pending = connectVendorPluginMcp('plugin_clickup_clickup');
      await vi.waitFor(() => expect(openExternalMock).toHaveBeenCalled());
      // fetch() rejects an invalid request target client-side, so drive the raw bytes.
      const reply = await new Promise<string>((resolve, reject) => {
        const socket = netConnect(3118, '127.0.0.1', () => {
          socket.write('GET //% HTTP/1.1\r\nHost: 127.0.0.1\r\nConnection: close\r\n\r\n');
        });
        let data = '';
        socket.on('data', (chunk) => (data += String(chunk)));
        socket.on('end', () => resolve(data));
        socket.on('error', reject);
      });
      expect(reply).toMatch(/^HTTP\/1\.1 404/);
      const { callback } = await completeConsentInBrowser('code-mal');
      expect(callback.status).toBe(200);
      await expect(pending).resolves.toMatchObject({ serverName: 'plugin_clickup_clickup' });
    } finally {
      vendor.restore();
    }
  });

  it('discards a consent that completes after the plugin was uninstalled (no credential resurrection)', async () => {
    listStagedVendorPluginMcpServersMock.mockReturnValue([clickupStaged]);
    const vendor = mockAuthServer({ origin: CLICKUP_ORIGIN, token: { access_token: 'xoxp-late', token_type: 'bearer' } });
    try {
      const pending = connectVendorPluginMcp('plugin_clickup_clickup');
      pending.catch(() => {});
      await vi.waitFor(() => expect(openExternalMock).toHaveBeenCalled());
      listStagedVendorPluginMcpServersMock.mockReturnValue([]);
      await completeConsentInBrowser('code-2');
      await expect(pending).rejects.toThrow(/Disconnected during authorization/);
      expect(credentialsFile.servers.plugin_clickup_clickup).toBeUndefined();
      expect(setGlobalMcpServerMock).not.toHaveBeenCalled();
    } finally {
      vendor.restore();
    }
  });

  it('arms the tools consent for a Connect chain: the granted callback 302s into the next hop, the exchange finishes behind it', async () => {
    listStagedVendorPluginMcpServersMock.mockReturnValue([clickupStaged]);
    const vendor = mockAuthServer({ origin: CLICKUP_ORIGIN, token: { access_token: 'xoxp-armed', token_type: 'bearer', expires_in: 3600 } });
    try {
      const armed = await armClickup(NEXT_HOP);
      // The renderer opens the page; main never does.
      expect(openExternalMock).not.toHaveBeenCalled();
      expect(new URL(armed.authUrl).origin + new URL(armed.authUrl).pathname).toBe(`${CLICKUP_ORIGIN}/authorize`);
      expect(getVendorPluginMcpConsentUrl('plugin_clickup_clickup')).toBe(armed.authUrl);
      const callback = await callbackFor(armed.state);
      expect(callback.status).toBe(302);
      expect(callback.headers.get('location')).toBe(NEXT_HOP);
      await armed.completed;
      expect(getVendorPluginMcpConsentOutcome('plugin_clickup_clickup')).toMatchObject({ ok: true });
      expect(credentialsFile.servers.plugin_clickup_clickup).toMatchObject({ headers: { Authorization: 'Bearer xoxp-armed' } });
      // Converged: the next Connect has no tools leg to run.
      await expect(armVendorPluginMcpConsent('clickup')).resolves.toBeNull();
    } finally {
      vendor.restore();
    }
  });

  it('with no next hop the chain ends on the connected page', async () => {
    listStagedVendorPluginMcpServersMock.mockReturnValue([clickupStaged]);
    const vendor = mockAuthServer({ origin: CLICKUP_ORIGIN });
    try {
      const armed = await armClickup();
      const callback = await callbackFor(armed.state);
      expect(callback.status).toBe(200);
      expect(await callback.text()).toContain('Connected. You can close this tab and go back to Frink.');
      await armed.completed;
      expect(getVendorPluginMcpConsentOutcome('plugin_clickup_clickup')).toMatchObject({ ok: true });
    } finally {
      vendor.restore();
    }
  });

  it('a denial at the vendor ends on the cancelled page, never the next hop: recorded for the dialog, not captured', async () => {
    listStagedVendorPluginMcpServersMock.mockReturnValue([clickupStaged]);
    const vendor = mockAuthServer({ origin: CLICKUP_ORIGIN });
    try {
      const armed = await armClickup(NEXT_HOP);
      const callback = await callbackFor(armed.state, 'error=access_denied');
      expect(callback.status).toBe(200);
      expect(await callback.text()).toContain('Sign-in cancelled. You can close this tab and go back to Frink.');
      await armed.completed;
      expect(getVendorPluginMcpConsentOutcome('plugin_clickup_clickup')).toMatchObject({ ok: false, error: 'Sign-in cancelled.' });
      expect(captureMainMessageMock).not.toHaveBeenCalled();
      expect(credentialsFile.servers.plugin_clickup_clickup).toBeUndefined();
      expect(vendor.tokenCalls()).toEqual([]);
    } finally {
      vendor.restore();
    }
  });

  it('a callback carrying another consent\'s state gets the stale page and leaves the live consent waiting', async () => {
    listStagedVendorPluginMcpServersMock.mockReturnValue([clickupStaged]);
    const vendor = mockAuthServer({ origin: CLICKUP_ORIGIN });
    try {
      const armed = await armClickup(NEXT_HOP);
      const stale = await callbackFor('not-ours', 'code=code-stale');
      expect(stale.status).toBe(200);
      expect(await stale.text()).toContain('This sign-in link is out of date.');
      expect(getVendorPluginMcpConsentOutcome('plugin_clickup_clickup')).toBeUndefined();
      expect((await callbackFor(armed.state)).status).toBe(302);
      await armed.completed;
      expect(getVendorPluginMcpConsentOutcome('plugin_clickup_clickup')).toMatchObject({ ok: true });
    } finally {
      vendor.restore();
    }
  });

  it('serves no /start any more', async () => {
    listStagedVendorPluginMcpServersMock.mockReturnValue([clickupStaged]);
    const vendor = mockAuthServer({ origin: CLICKUP_ORIGIN });
    try {
      await armClickup(NEXT_HOP);
      expect((await fetch('http://127.0.0.1:3118/start', browser)).status).toBe(404);
    } finally {
      vendor.restore();
    }
  });

  it('a token exchange that fails behind the redirect is recorded and captured as redirected', async () => {
    listStagedVendorPluginMcpServersMock.mockReturnValue([clickupStaged]);
    const vendor = mockAuthServer({ origin: CLICKUP_ORIGIN, token: { access_token: 'no-type' } });
    try {
      const armed = await armClickup(NEXT_HOP);
      expect((await callbackFor(armed.state)).status).toBe(302);
      await armed.completed;
      expect(getVendorPluginMcpConsentOutcome('plugin_clickup_clickup')).toMatchObject({ ok: false });
      expect(captureMainMessageMock).toHaveBeenCalledWith(
        expect.stringMatching(/consent failed/),
        'error',
        { surface: 'vendor-plugin-mcp-consent', serverName: 'plugin_clickup_clickup', redirected: 'true' },
      );
      expect(credentialsFile.servers.plugin_clickup_clickup).toBeUndefined();
    } finally {
      vendor.restore();
    }
  });

  it('a Disconnect while discovery is still running stops the listener before any browser opens', async () => {
    listStagedVendorPluginMcpServersMock.mockReturnValue([clickupStaged]);
    let releaseDiscovery!: () => void;
    const gate = new Promise<void>((resolve) => {
      releaseDiscovery = resolve;
    });
    const vendor = mockAuthServer({ origin: CLICKUP_ORIGIN });
    const realImpl = vi.mocked(globalThis.fetch).getMockImplementation()!;
    vi.mocked(globalThis.fetch).mockImplementation(async (input, init) => {
      const response = await realImpl(input, init);
      if (String(input).includes('/.well-known/')) await gate;
      return response;
    });
    try {
      const pending = connectVendorPluginMcp('plugin_clickup_clickup');
      pending.catch(() => {});
      // Discovery has started, so the listener is already bound (bind precedes the SDK).
      await vi.waitFor(() => expect(vendor.calls.some((c) => c.url.includes('/.well-known/'))).toBe(true));
      await removeVendorPluginMcpCredentials('clickup');
      releaseDiscovery();
      await expect(pending).rejects.toThrow(/cancelled|Disconnected/);
      expect(openExternalMock).not.toHaveBeenCalled();
      expect(credentialsFile.servers.plugin_clickup_clickup).toBeUndefined();
    } finally {
      vendor.restore();
    }
  });

  it('a Disconnect in the same tick as Connect cancels before the listener even binds, and never opens a browser', async () => {
    listStagedVendorPluginMcpServersMock.mockReturnValue([clickupStaged]);
    const vendor = mockAuthServer({ origin: CLICKUP_ORIGIN });
    try {
      const pending = connectVendorPluginMcp('plugin_clickup_clickup');
      pending.catch(() => {});
      await removeVendorPluginMcpCredentials('clickup');
      await expect(pending).rejects.toThrow(/cancelled|Disconnected/);
      expect(openExternalMock).not.toHaveBeenCalled();
      // The pinned port is free again right away.
      const probe = createServer();
      await new Promise<void>((resolve, reject) => {
        probe.once('error', reject);
        probe.listen(3118, '127.0.0.1', () => probe.close(() => resolve()));
      });
    } finally {
      vendor.restore();
    }
  });

  it('a Disconnect during an in-flight consent cancels it silently, and a fresh arm works again', async () => {
    listStagedVendorPluginMcpServersMock.mockReturnValue([clickupStaged]);
    const vendor = mockAuthServer({ origin: CLICKUP_ORIGIN });
    try {
      const armed = await armClickup();
      await expect(removeVendorPluginMcpCredentials('clickup')).resolves.toEqual([]);
      await armed.completed;
      await expect(callbackFor(armed.state)).rejects.toThrow();
      expect(getVendorPluginMcpConsentOutcome('plugin_clickup_clickup')).toBeUndefined();
      expect(credentialsFile.servers.plugin_clickup_clickup).toBeUndefined();
      expect(setGlobalMcpServerMock).not.toHaveBeenCalled();
      await expect(armVendorPluginMcpConsent('clickup')).resolves.not.toBeNull();
    } finally {
      vendor.restore();
    }
  });

  it('cancellation cleanup fences tokens that arrive after the browser callback already completed', async () => {
    listStagedVendorPluginMcpServersMock.mockReturnValue([clickupStaged]);
    let releaseToken!: () => void;
    const gate = new Promise<void>((resolve) => {
      releaseToken = resolve;
    });
    const vendor = mockAuthServer({ origin: CLICKUP_ORIGIN });
    const realImpl = vi.mocked(globalThis.fetch).getMockImplementation()!;
    vi.mocked(globalThis.fetch).mockImplementation(async (input, init) => {
      const response = await realImpl(input, init);
      if (String(input) === `${CLICKUP_ORIGIN}/token`) await gate;
      return response;
    });
    try {
      const pending = connectVendorPluginMcp('plugin_clickup_clickup');
      void pending.catch(() => {});
      await completeConsentInBrowser('code-before-cancel');
      await vi.waitFor(() => expect(vendor.tokenCalls()).toHaveLength(1));
      await removeVendorPluginMcpCredentials('clickup');
      releaseToken();
      await expect(pending).rejects.toThrow(/Disconnected during authorization/);
      expect(credentialsFile.servers.plugin_clickup_clickup).toBeUndefined();
      expect(setGlobalMcpServerMock).not.toHaveBeenCalled();
    } finally {
      releaseToken();
      vendor.restore();
    }
  });

  it('a repeat Connect supersedes the waiting consent and rebinds the pinned port: the old tab goes stale, the new one completes', async () => {
    listStagedVendorPluginMcpServersMock.mockReturnValue([clickupStaged]);
    const vendor = mockAuthServer({ origin: CLICKUP_ORIGIN });
    try {
      const superseded = await armClickup(NEXT_HOP);
      const current = await armClickup(NEXT_HOP);
      expect(current.authUrl).not.toBe(superseded.authUrl);
      // The superseded consent settled as a cancel: no failure recorded, one listener bound.
      await superseded.completed;
      expect(getVendorPluginMcpConsentOutcome('plugin_clickup_clickup')).toBeUndefined();
      expect(await (await callbackFor(superseded.state)).text()).toContain('out of date');
      expect((await callbackFor(current.state)).status).toBe(302);
      await current.completed;
      expect(getVendorPluginMcpConsentOutcome('plugin_clickup_clickup')).toMatchObject({ ok: true });
    } finally {
      vendor.restore();
    }
  });

  it('Enable MCP during an armed consent joins it instead of binding a second listener', async () => {
    listStagedVendorPluginMcpServersMock.mockReturnValue([clickupStaged]);
    const vendor = mockAuthServer({ origin: CLICKUP_ORIGIN });
    try {
      const armed = await armClickup();
      const joined = connectVendorPluginMcp('plugin_clickup_clickup');
      expect((await callbackFor(armed.state)).status).toBe(200);
      await expect(joined).resolves.toMatchObject({ serverName: 'plugin_clickup_clickup' });
      expect(openExternalMock).not.toHaveBeenCalled();
    } finally {
      vendor.restore();
    }
  });

  it('the arm rejects when the flow throws before arming, so the caller never hangs and sees the cause', async () => {
    listStagedVendorPluginMcpServersMock.mockReturnValue([clickupStaged]);
    getMcpCredentialsMock.mockRejectedValueOnce(new Error('keychain locked'));
    await expect(armVendorPluginMcpConsent('clickup')).rejects.toThrow('keychain locked');
  });

  it('a busy pinned port rejects the arm before any discovery', async () => {
    listStagedVendorPluginMcpServersMock.mockReturnValue([clickupStaged]);
    const vendor = mockAuthServer({ origin: CLICKUP_ORIGIN });
    const occupant = createServer();
    await new Promise<void>((resolve) => occupant.listen(3118, '127.0.0.1', resolve));
    try {
      await expect(armVendorPluginMcpConsent('clickup', { nextHop: NEXT_HOP })).rejects.toThrow(/Port 3118 is in use/);
      expect(vendor.calls).toEqual([]);
    } finally {
      vendor.restore();
      await new Promise<void>((resolve) => occupant.close(() => resolve()));
    }
  });

  it('arms nothing when the plugin already holds a usable credential — the converged leg is skipped', async () => {
    listStagedVendorPluginMcpServersMock.mockReturnValue([clickupStaged]);
    credentialsFile.servers = { plugin_clickup_clickup: { oauth: { accessToken: 'fresh' } } };
    await expect(armVendorPluginMcpConsent('clickup')).resolves.toBeNull();
  });

  it('a retry re-registers when a prior completion persisted the credential but failed to register', async () => {
    listStagedVendorPluginMcpServersMock.mockReturnValue([clickupStaged]);
    credentialsFile.servers = { plugin_clickup_clickup: { oauth: { accessToken: 'kept' } } };
    await connectVendorPluginMcp('plugin_clickup_clickup');
    expect(setGlobalMcpServerMock).toHaveBeenCalledWith(
      'plugin_clickup_clickup',
      expect.objectContaining({ managedBy: 'vendor_plugin', enabled: true }),
    );
  });

  it('rejects an unstaged server name', async () => {
    listStagedVendorPluginMcpServersMock.mockReturnValue([]);
    await expect(connectVendorPluginMcp('plugin_clickup_clickup')).rejects.toThrow(/is staged/);
  });

  it('reports a busy registered port before any discovery and coalesces a concurrent start onto the same attempt', async () => {
    listStagedVendorPluginMcpServersMock.mockReturnValue([clickupStaged]);
    const vendor = mockAuthServer({ origin: CLICKUP_ORIGIN });
    const occupant = createServer();
    await new Promise<void>((resolve) => occupant.listen(3118, '127.0.0.1', resolve));
    try {
      const first = connectVendorPluginMcp('plugin_clickup_clickup');
      const second = connectVendorPluginMcp('plugin_clickup_clickup');
      await expect(first).rejects.toThrow(/Port 3118 is in use/);
      await expect(second).rejects.toThrow(/Port 3118 is in use/);
      expect(vendor.calls).toEqual([]);
    } finally {
      vendor.restore();
      await new Promise<void>((resolve) => occupant.close(() => resolve()));
    }
  });
});

describe('connectVendorPluginMcp — Frink as the client (catalog rows)', () => {
  it('starts a fresh SDK grant after a same-origin resource path changes, without old tokens or client metadata', async () => {
    listStagedVendorPluginMcpServersMock.mockReturnValue([notionStaged]);
    getGlobalMcpServersMock.mockResolvedValue({ plugin_notiontest_notion: { url: 'https://mcp.notion.test/sse' } });
    credentialsFile.servers = { plugin_notiontest_notion: { oauth: { accessToken: 'old-access', refreshToken: 'old-refresh', clientId: 'old-client', expiresAt: Date.now() + 3600000 } } };
    const vendor = mockAuthServer({ origin: 'https://mcp.notion.test', registration: true });
    try {
      const pending = startVendorPluginMcpConsent('notiontest');
      const { authUrl } = await completeConsentInBrowser('new-resource-code');
      await pending;
      expect(authUrl.searchParams.get('resource')).toBe('https://mcp.notion.test/mcp');
      expect(authUrl.searchParams.get('client_id')).toBe('dyn-client-1');
      expect(vendor.calls.some((call) => call.url.endsWith('/register'))).toBe(true);
      expect(vendor.tokenCalls().map((call) => call.body).join()).not.toMatch(/old-access|old-refresh|old-client|grant_type=refresh_token/);
      expect(credentialsFile.servers.plugin_notiontest_notion).toMatchObject({ oauth: { accessToken: 'tok-1', clientId: 'dyn-client-1' } });
    } finally {
      vendor.restore();
    }
  });

  it('explicit reconnect runs SDK renewal for the target even when the config and unexpired token appear usable', async () => {
    listStagedVendorPluginMcpServersMock.mockReturnValue([notionStaged]);
    getGlobalMcpServersMock.mockResolvedValue({ plugin_notiontest_notion: { url: 'https://mcp.notion.test/mcp' } });
    credentialsFile.servers = { plugin_notiontest_notion: { oauth: { accessToken: 'old-access', refreshToken: 'old-refresh', clientId: 'old-client', expiresAt: Date.now() + 3600000 } } };
    const vendor = mockAuthServer({ origin: 'https://mcp.notion.test', registration: true });
    try {
      await connectVendorPluginMcp('plugin_notiontest_notion', { reconnect: true });
      expect(openExternalMock).not.toHaveBeenCalled();
      expect(vendor.tokenCalls()[0]?.body).toContain('grant_type=refresh_token');
      expect(new URLSearchParams(vendor.tokenCalls()[0]?.body).get('resource')).toBe('https://mcp.notion.test/mcp');
      expect(credentialsFile.servers.plugin_notiontest_notion).toMatchObject({ oauth: { accessToken: 'tok-1' } });
    } finally {
      vendor.restore();
    }
  });

  it('lets the SDK recover a rejected refresh through browser consent without inheriting the rejected token', async () => {
    listStagedVendorPluginMcpServersMock.mockReturnValue([notionStaged]);
    getGlobalMcpServersMock.mockResolvedValue({ plugin_notiontest_notion: { url: NOTION_URL } });
    credentialsFile.servers = { plugin_notiontest_notion: { oauth: { accessToken: 'old-access', refreshToken: 'rejected-refresh', clientId: 'old-client', expiresAt: Date.now() + 3600000 } } };
    const vendor = mockAuthServer({ origin: 'https://mcp.notion.test', token: { access_token: 'new-access', token_type: 'bearer' } });
    const realImpl = vi.mocked(globalThis.fetch).getMockImplementation()!;
    vi.mocked(globalThis.fetch).mockImplementation(async (input, init) => {
      const response = await realImpl(input, init);
      if (String(input) === 'https://mcp.notion.test/token' && String(init?.body).includes('grant_type=refresh_token')) {
        return Response.json({ error: 'invalid_grant' }, { status: 400 });
      }
      return response;
    });
    try {
      const pending = connectVendorPluginMcp('plugin_notiontest_notion', { reconnect: true });
      await completeConsentInBrowser('replacement-code');
      await pending;
      expect(vendor.tokenCalls()).toHaveLength(2);
      expect(vendor.tokenCalls()[0]?.body).toContain('grant_type=refresh_token');
      expect(vendor.tokenCalls()[1]?.body).toContain('grant_type=authorization_code');
      expect(credentialsFile.servers.plugin_notiontest_notion).toMatchObject({ oauth: { accessToken: 'new-access', refreshToken: undefined } });
    } finally {
      vendor.restore();
    }
  });

  it('cancelling a reconnect preserves the completed grant and fences a late code exchange', async () => {
    listStagedVendorPluginMcpServersMock.mockReturnValue([notionStaged]);
    getGlobalMcpServersMock.mockResolvedValue({ plugin_notiontest_notion: { url: 'https://mcp.notion.test/mcp' } });
    const prior = { oauth: { accessToken: 'kept-access', clientId: 'kept-client', expiresAt: Date.now() + 3600000 } };
    credentialsFile.servers = { plugin_notiontest_notion: prior };
    let releaseToken = () => {};
    const gate = new Promise<void>((resolve) => { releaseToken = resolve; });
    const vendor = mockAuthServer({ origin: 'https://mcp.notion.test' });
    const realImpl = vi.mocked(globalThis.fetch).getMockImplementation()!;
    vi.mocked(globalThis.fetch).mockImplementation(async (input, init) => {
      const response = await realImpl(input, init);
      if (String(input) === 'https://mcp.notion.test/token') await gate;
      return response;
    });
    try {
      const pending = connectVendorPluginMcp('plugin_notiontest_notion', { reconnect: true });
      void pending.catch(() => {});
      await completeConsentInBrowser('cancelled-code');
      await vi.waitFor(() => expect(vendor.tokenCalls()).toHaveLength(1));
      await cancelVendorPluginMcpConsent('notiontest');
      releaseToken();
      await expect(pending).rejects.toThrow(/Disconnected during authorization/);
      expect(credentialsFile.servers.plugin_notiontest_notion).toEqual(prior);
      expect(setGlobalMcpServerMock).not.toHaveBeenCalled();
      expect(removeGlobalMcpServerMock).not.toHaveBeenCalled();
    } finally {
      releaseToken();
      vendor.restore();
    }
  });

  it('uses the hosted client-metadata document as its client id when the server advertises support', async () => {
    listStagedVendorPluginMcpServersMock.mockReturnValue([notionStaged]);
    const vendor = mockAuthServer({ origin: 'https://mcp.notion.test', cimd: true, registration: true, scopes: ['read'] });
    try {
      const pending = connectVendorPluginMcp('plugin_notiontest_notion');
      const { authUrl } = await completeConsentInBrowser('code-n');
      await expect(pending).resolves.toMatchObject({ serverName: 'plugin_notiontest_notion' });
      expect(authUrl.searchParams.get('client_id')).toBe(FRINK_CLIENT_METADATA_URL);
      // An ephemeral loopback literal, bound before the URL was minted.
      expect(authUrl.searchParams.get('redirect_uri')).toMatch(/^http:\/\/127\.0\.0\.1:\d+\/callback$/);
      expect(vendor.calls.some((c) => c.url.endsWith('/register'))).toBe(false);
      expect(credentialsFile.servers.plugin_notiontest_notion).toMatchObject({
        oauth: { clientId: FRINK_CLIENT_METADATA_URL, accessToken: 'tok-1' },
      });
    } finally {
      vendor.restore();
    }
  });

  it('registers itself dynamically as a public native client when the document is unreachable', async () => {
    listStagedVendorPluginMcpServersMock.mockReturnValue([notionStaged]);
    const vendor = mockAuthServer({ origin: 'https://mcp.notion.test', cimd: true, cimdDocument: false, registration: true });
    try {
      const pending = connectVendorPluginMcp('plugin_notiontest_notion');
      const { authUrl } = await completeConsentInBrowser('code-d');
      await expect(pending).resolves.toMatchObject({ serverName: 'plugin_notiontest_notion' });
      const register = vendor.calls.find((c) => c.url.endsWith('/register'));
      expect(register?.method).toBe('POST');
      const body = JSON.parse(register?.body ?? '{}') as Record<string, unknown>;
      expect(body).toMatchObject({
        client_name: 'Frink',
        token_endpoint_auth_method: 'none',
        application_type: 'native',
        redirect_uris: [authUrl.searchParams.get('redirect_uri')],
        grant_types: ['authorization_code', 'refresh_token'],
      });
      expect(authUrl.searchParams.get('client_id')).toBe('dyn-client-1');
      expect(vendor.tokenCalls()[0]?.body).toContain('client_id=dyn-client-1');
      expect(vendor.tokenCalls()[0]?.body).not.toContain('client_secret');
      expect(credentialsFile.servers.plugin_notiontest_notion).toMatchObject({ oauth: { clientId: 'dyn-client-1' } });
    } finally {
      vendor.restore();
    }
  });

  it('follows protected-resource metadata to an authorization server on another host', async () => {
    listStagedVendorPluginMcpServersMock.mockReturnValue([notionStaged]);
    const vendor = mockAuthServer({ origin: 'https://mcp.notion.test', as: 'https://auth.notion.test', registration: true });
    try {
      const pending = connectVendorPluginMcp('plugin_notiontest_notion');
      const { authUrl } = await completeConsentInBrowser('code-h');
      await expect(pending).resolves.toMatchObject({ serverName: 'plugin_notiontest_notion' });
      expect(authUrl.origin).toBe('https://auth.notion.test');
      expect(vendor.calls.find((c) => c.url.endsWith('/register'))?.url).toBe('https://auth.notion.test/register');
      expect(vendor.tokenCalls()[0]?.url).toBe('https://auth.notion.test/token');
    } finally {
      vendor.restore();
    }
  });

  it('completes public-client consent when registration returns an unused secret', async () => {
    listStagedVendorPluginMcpServersMock.mockReturnValue([notionStaged]);
    const vendor = mockAuthServer({
      origin: 'https://mcp.notion.test',
      registration: true,
      authMethods: ['client_secret_post', 'client_secret_basic', 'none'],
      register: {
        client_id: 'public-1',
        client_secret: 'unused-secret',
        token_endpoint_auth_method: 'none',
        redirect_uris: ['http://127.0.0.1/callback'],
      },
    });
    try {
      const pending = connectVendorPluginMcp('plugin_notiontest_notion');
      await completeConsentInBrowser('code-public');
      await expect(pending).resolves.toMatchObject({ serverName: 'plugin_notiontest_notion' });
      expect(vendor.tokenCalls()).toHaveLength(1);
      expect(new URLSearchParams(vendor.tokenCalls()[0]?.body).get('client_id')).toBe('public-1');
      expect(vendor.tokenCalls()[0]?.body).not.toContain('client_secret');
      expect(credentialsFile.servers.plugin_notiontest_notion).toMatchObject({
        oauth: { clientId: 'public-1', accessToken: 'tok-1' },
      });
      expect(JSON.stringify(credentialsFile.servers)).not.toContain('unused-secret');
    } finally {
      vendor.restore();
    }
  });

  it('refuses a registration that hands back a client secret without explicit public authentication, persisting nothing', async () => {
    listStagedVendorPluginMcpServersMock.mockReturnValue([notionStaged]);
    const vendor = mockAuthServer({
      origin: 'https://mcp.notion.test',
      registration: true,
      register: { client_id: 'conf-1', client_secret: 's3cret', redirect_uris: ['http://127.0.0.1/callback'] },
    });
    try {
      await expect(connectVendorPluginMcp('plugin_notiontest_notion')).rejects.toThrow(/client secrets/);
      expect(openExternalMock).not.toHaveBeenCalled();
      expect(credentialsFile.servers.plugin_notiontest_notion).toBeUndefined();
      expect(getVendorPluginMcpConsentOutcome('plugin_notiontest_notion')).toMatchObject({ ok: false });
    } finally {
      vendor.restore();
    }
  });

  it('passes the manifest scope override instead of everything the resource advertises', async () => {
    listStagedVendorPluginMcpServersMock.mockReturnValue([{ ...clickupStaged }]);
    // Slack's catalog declaration carries no scope override, so the PRM list wins there; the
    // override is exercised through the SDK option the provider threads: metadata scope.
    const vendor = mockAuthServer({ origin: CLICKUP_ORIGIN, scopes: ['a', 'b'] });
    try {
      const pending = connectVendorPluginMcp('plugin_clickup_clickup');
      const { authUrl } = await completeConsentInBrowser('code-s');
      await pending;
      expect(authUrl.searchParams.get('scope')).toBe('a b');
    } finally {
      vendor.restore();
    }
  });
});
