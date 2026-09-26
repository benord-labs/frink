import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { PluginNodeSchema } from '../../../db/repos/plugin-node-schemas';
import type { TestDb } from '../../../db/test-utils/fresh-db';
import type { McpToolCallResult } from '../../../mcp/tools-probe/call';
import type { PluginInstallation } from '../../../db/repos/plugin-installations';
import type { FrinkMcpCredentials, FrinkMcpServerConfig } from '../../../mcp/types';

type ServerFixture = Partial<
  Pick<FrinkMcpServerConfig, 'command' | 'url' | 'enabled' | 'managedBy'>
>;
type IntegrationRow = { id: string; provider: string; isActive: boolean };
type InstallationRow = Pick<PluginInstallation, 'isInstalled' | 'isEnabled'> | null;
type CredentialSlot = { current: FrinkMcpCredentials | null };
type DbSlot = { current: TestDb | null };

const state = vi.hoisted(() => {
  const integrations: IntegrationRow[] = [];
  const db: DbSlot = { current: null };
  const servers: Record<string, ServerFixture> = {};
  const callResult: McpToolCallResult = { ok: true, result: { content: [] } };
  const credentials: CredentialSlot = { current: null };
  return {
    integrations,
    db,
    servers,
    callResult,
    credentials,
    installationMock: vi.fn(async (): Promise<InstallationRow> => ({
      isInstalled: true,
      isEnabled: true,
    })),
  };
});

// The dispatcher reads live accounts; this seam controls them without a real ingress table.
// oxlint-disable-next-line anti-slop/no-module-mocking
vi.mock('../../../db/repos/webhook-ingress', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../../db/repos/webhook-ingress')>()),
  listLocalIntegrations: vi.fn(async () => state.integrations),
}));
vi.mock('../../../mcp', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../../mcp')>()),
  getGlobalMcpServers: vi.fn(async () => state.servers),
  getMcpCredentials: vi.fn(async () => state.credentials.current),
}));
vi.mock('../../../mcp/tools-probe/call', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../../mcp/tools-probe/call')>()),
  callMcpToolStdio: vi.fn(async () => state.callResult),
  callMcpTool: vi.fn(async () => state.callResult),
}));
// oxlint-disable-next-line anti-slop/no-module-mocking
vi.mock('../../../mcp/runtime/resolve-frink-servers', () => ({
  refreshNearExpiryOAuth: vi.fn(
    async (
      _name: string,
      _config: FrinkMcpServerConfig,
      credentials: FrinkMcpCredentials | undefined,
    ) => credentials,
  ),
}));
vi.mock('../../../sentry/init', () => ({
  captureMainMessage: vi.fn(),
  captureMainException: vi.fn(),
}));
// The schema-cache repo runs real drizzle; the mock only keeps getDatabase off the operator's agents.db.
// oxlint-disable-next-line anti-slop/no-module-mocking
vi.mock('../../../db', () => ({ getDatabase: () => testDb() }));
// oxlint-disable-next-line anti-slop/no-module-mocking
vi.mock('../../../db/repos/plugin-installations', () => ({
  getByPluginId: state.installationMock,
}));

import { listLocalIntegrations } from '../../../db/repos/webhook-ingress';
import { upsertPluginNodeSchema } from '../../../db/repos/plugin-node-schemas';
import { freshDb } from '../../../db/test-utils/fresh-db';
import { callMcpTool, callMcpToolStdio } from '../../../mcp/tools-probe/call';

/** The http calls the dispatcher made, as (url, tool, headers) — args are asserted separately. */
function httpCalls() {
  return vi
    .mocked(callMcpTool)
    .mock.calls.map(([url, tool, , headers]) => ({ url, tool, headers }));
}
import { dispatchPluginNode } from './index';

function testDb(): TestDb {
  const db = state.db.current;
  if (!db) throw new Error('no test database — resetSchemaCache() runs first');
  return db;
}

/** An empty schema cache: a plugin whose tool fields have never been probed. */
function resetSchemaCache(): void {
  state.db.current = freshDb();
}

/** The probed schema the preflight reads for one catalog action; a re-cache replaces it, like a re-probe. */
function cacheSchema(
  actionId: string,
  inputs: PluginNodeSchema['inputs'],
  unsupportedFields: string[] = [],
): void {
  upsertPluginNodeSchema(testDb(), {
    pluginId: actionId.split('.')[0],
    actionId,
    inputs,
    unsupportedFields,
  });
}

function httpArgs() {
  return vi.mocked(callMcpTool).mock.calls.map(([, , args]) => args);
}

function ctxFor(blockType: string, config: Record<string, unknown> = {}) {
  return {
    node: { id: 'n1', blockType, config },
    userId: 'user-1',
    triggerContext: undefined,
    previousOutput: undefined,
    loopContext: undefined,
  } as unknown as Parameters<typeof dispatchPluginNode>[0];
}

describe('dispatchPluginNode', () => {
  beforeEach(() => {
    state.integrations = [{ id: 'int-1', provider: 'shortcut', isActive: true }];
    state.servers = {
      plugin_shortcut_shortcut: { url: 'https://mcp.shortcut.com/mcp', managedBy: 'vendor_plugin' },
    };
    state.callResult = { ok: true, result: { content: [] } };
    state.credentials.current = { headers: { Authorization: 'Bearer shortcut-test-token' } };
    resetSchemaCache();
    cacheSchema('shortcut.search_stories', { query: { type: 'string' } });
    cacheSchema('posthog.list_feature_flags', { search: { type: 'string' } });
    vi.mocked(callMcpTool).mockClear();
    vi.mocked(callMcpToolStdio).mockClear();
    state.installationMock.mockReset();
    state.installationMock.mockResolvedValue({ isInstalled: true, isEnabled: true });
    vi.mocked(listLocalIntegrations).mockClear();
  });

  it('fails closed for a catalog plugin whose installation row is missing or turned off', async () => {
    state.servers.plugin_posthog_posthog = {
      url: 'https://mcp.posthog.com/mcp',
      managedBy: 'vendor_plugin',
    };
    state.installationMock.mockResolvedValue(null);
    expect(await dispatchPluginNode(ctxFor('posthog_list_feature_flags'))).toMatchObject({
      type: 'error',
      message: expect.stringContaining('not installed'),
    });
    state.installationMock.mockResolvedValue({ isInstalled: true, isEnabled: false });
    expect(await dispatchPluginNode(ctxFor('posthog_list_feature_flags'))).toMatchObject({
      type: 'error',
      message: expect.stringContaining('turned off'),
    });
    expect(httpCalls()).toEqual([]);
  });

  it('wraps preflighted Webflow inputs with catalog constants and isolates concurrent structured arguments', async () => {
    state.servers.plugin_webflow_webflow = {
      url: 'https://mcp.webflow.com/mcp',
      managedBy: 'vendor_plugin',
    };
    state.credentials.current = { headers: { Authorization: 'Bearer t' } };
    cacheSchema('webflow.list_items', {
      collection_id: { type: 'string', required: true },
      request: { type: 'json' },
    });
    const outcomes = await Promise.all([
      dispatchPluginNode(
        ctxFor('webflow_list_items', {
          collection_id: 'one',
          request: '{"limit":2,"filter":{"name":{"eq":"A"}}}',
        }),
      ),
      dispatchPluginNode(
        ctxFor('webflow_list_items', { collection_id: 'two', request: { limit: 3 } }),
      ),
    ]);
    expect(outcomes).toEqual([
      expect.objectContaining({
        type: 'completed',
        output: expect.objectContaining({ status: 'completed' }),
      }),
      expect.objectContaining({
        type: 'completed',
        output: expect.objectContaining({ status: 'completed' }),
      }),
    ]);
    const calls = vi.mocked(callMcpTool).mock.calls;
    expect(calls.map((call) => call[1])).toEqual(['data_cms_tool', 'data_cms_tool']);
    expect(calls.map((call) => call[2])).toEqual([
      {
        actions: [
          {
            label: 'list_collection_items',
            list_collection_items: {
              collection_id: 'one',
              request: { limit: 2, filter: { name: { eq: 'A' } } },
            },
          },
        ],
        context: expect.stringContaining('Frink reads authorized Webflow content'),
      },
      {
        actions: [
          {
            label: 'list_collection_items',
            list_collection_items: { collection_id: 'two', request: { limit: 3 } },
          },
        ],
        context: expect.stringContaining('Frink reads authorized Webflow content'),
      },
    ]);
  });

  it.each(['actions', 'context', 'label'])(
    'rejects user overrides of the Webflow wrapper field %s before any request',
    async (field) => {
      state.servers.plugin_webflow_webflow = {
        url: 'https://mcp.webflow.com/mcp',
        managedBy: 'vendor_plugin',
      };
      state.credentials.current = { headers: { Authorization: 'Bearer t' } };
      cacheSchema('webflow.get_site', { site_id: { type: 'string', required: true } });
      expect(
        await dispatchPluginNode(
          ctxFor('webflow_get_site', { site_id: 'site-1', [field]: 'override' }),
        ),
      ).toMatchObject({ type: 'error', message: expect.stringContaining('is not a field') });
      expect(vi.mocked(callMcpTool)).not.toHaveBeenCalled();
    },
  );

  it('runs a catalog http plugin node against its registered chat credential, no account needed', async () => {
    state.integrations = [];
    state.servers.plugin_posthog_posthog = {
      url: 'https://mcp.posthog.com/mcp',
      managedBy: 'vendor_plugin',
    };
    state.credentials.current = { headers: { Authorization: 'Bearer t' } };

    const result = await dispatchPluginNode(
      ctxFor('posthog_list_feature_flags', { search: 'beta' }),
    );

    expect(result).toMatchObject({ type: 'completed', output: { status: 'completed' } });
    expect(httpCalls()).toEqual([
      {
        url: 'https://mcp.posthog.com/mcp',
        tool: 'feature-flag-get-all',
        headers: { Authorization: 'Bearer t', 'x-posthog-mcp-mode': 'tools' },
      },
    ]);
    // An http row never asks for accounts: the credential is the plugin's own.
    expect(listLocalIntegrations).not.toHaveBeenCalled();
  });

  it('tells the user a catalog plugin is not connected or turned off, in those words', async () => {
    expect(await dispatchPluginNode(ctxFor('posthog_list_feature_flags'))).toMatchObject({
      type: 'error',
      message: expect.stringContaining('not connected'),
    });
    // A user-made server under the plugin's name is not the plugin's credential.
    state.servers.plugin_posthog_posthog = { url: 'https://example.test/mcp' };
    expect(await dispatchPluginNode(ctxFor('posthog_list_feature_flags'))).toMatchObject({
      type: 'error',
      message: expect.stringContaining('not connected'),
    });
    state.servers.plugin_posthog_posthog = {
      url: 'https://mcp.posthog.com/mcp',
      managedBy: 'vendor_plugin',
      enabled: false,
    };
    state.credentials.current = { headers: { Authorization: 'Bearer t' } };
    expect(await dispatchPluginNode(ctxFor('posthog_list_feature_flags'))).toMatchObject({
      type: 'error',
      message: expect.stringContaining('turned off'),
    });
    // Registered and on, but the credential was swept: still not connected, never a bare call.
    state.servers.plugin_posthog_posthog = {
      url: 'https://mcp.posthog.com/mcp',
      managedBy: 'vendor_plugin',
    };
    state.credentials.current = null;
    expect(await dispatchPluginNode(ctxFor('posthog_list_feature_flags'))).toMatchObject({
      type: 'error',
      message: expect.stringContaining('not connected'),
    });
    expect(httpCalls()).toEqual([]);
  });

  it('a removed plugin never gets a switch it lacks: the refusal says not installed, not turned off', async () => {
    state.installationMock.mockResolvedValue(null);
    state.servers.plugin_posthog_posthog = {
      url: 'https://mcp.posthog.com/mcp',
      managedBy: 'vendor_plugin',
    };
    state.credentials.current = { headers: { Authorization: 'Bearer t' } };

    const result = await dispatchPluginNode(ctxFor('posthog_list_feature_flags'));

    expect(result).toMatchObject({
      type: 'error',
      message: expect.stringContaining('not installed'),
    });
    expect(httpCalls()).toEqual([]);
  });

  it('an http row with a live account but no credential is still not connected: accounts are never consulted', async () => {
    state.integrations = [{ id: 'int-2', provider: 'posthog', isActive: true }];
    state.servers.plugin_posthog_posthog = {
      url: 'https://mcp.posthog.com/mcp',
      managedBy: 'vendor_plugin',
    };
    state.credentials.current = null;

    const result = await dispatchPluginNode(ctxFor('posthog_list_feature_flags'));

    expect(result).toMatchObject({
      type: 'error',
      message: expect.stringContaining('not connected'),
    });
    expect(listLocalIntegrations).not.toHaveBeenCalled();
    expect(httpCalls()).toEqual([]);
  });

  it('requires an installed Shortcut plugin before calling its tools', async () => {
    state.installationMock.mockResolvedValue(null);

    const result = await dispatchPluginNode(ctxFor('shortcut_search_stories', { query: 'bugs' }));

    expect(result).toMatchObject({
      type: 'error',
      message: expect.stringContaining('not installed'),
    });
    expect(httpArgs()).toEqual([]);
  });

  it('rejects a name outside the catalog', async () => {
    const result = await dispatchPluginNode(ctxFor('made_up_node'));
    expect(result).toMatchObject({ type: 'error', message: expect.stringContaining('Unknown') });
  });

  it('requires the managed Shortcut OAuth connection even if a webhook account exists', async () => {
    state.servers = {};
    const result = await dispatchPluginNode(ctxFor('shortcut_search_stories'));
    expect(result).toMatchObject({
      type: 'error',
      message: expect.stringContaining('not connected'),
    });
    expect(httpArgs()).toEqual([]);
  });

  it('calls the provider MCP tool once with templated config, connect-call-close', async () => {
    const result = await dispatchPluginNode(ctxFor('shortcut_search_stories', { query: 'bugs' }));
    expect(result).toMatchObject({
      type: 'completed',
      output: { status: 'completed', outputs: { text: '', result: { content: [] } } },
    });
    expect(callMcpTool).toHaveBeenCalledWith(
      'https://mcp.shortcut.com/mcp',
      'stories-search',
      { query: 'bugs' },
      { Authorization: 'Bearer shortcut-test-token' },
      'plugin_shortcut_shortcut', // registry key, for failure triage only
    );
    expect(callMcpToolStdio).not.toHaveBeenCalled();
  });

  it('fails closed on a key the cached schema lacks, naming it, before any call', async () => {
    const result = await dispatchPluginNode(
      ctxFor('shortcut_search_stories', { query: 'x', archived: true }),
    );
    expect(result).toMatchObject({ type: 'error', message: expect.stringContaining('"archived"') });
    expect(httpArgs()).toEqual([]);
  });

  it('fails an existing flow when a reconnect drops a field, and passes once it returns', async () => {
    cacheSchema('shortcut.search_stories', {});
    const config = { query: 'bugs' };
    expect(await dispatchPluginNode(ctxFor('shortcut_search_stories', config))).toMatchObject({
      type: 'error',
      message: expect.stringContaining('"query"'),
    });
    expect(httpArgs()).toEqual([]);
    cacheSchema('shortcut.search_stories', { query: { type: 'string' } });
    expect(await dispatchPluginNode(ctxFor('shortcut_search_stories', config))).toMatchObject({
      type: 'completed',
    });
  });

  it('fails a missing or blank required input, naming it', async () => {
    cacheSchema('shortcut.search_stories', { query: { type: 'string', required: true } });
    const missing = { type: 'error', message: expect.stringContaining('required input: "query"') };
    expect(await dispatchPluginNode(ctxFor('shortcut_search_stories', {}))).toMatchObject(missing);
    expect(
      await dispatchPluginNode(ctxFor('shortcut_search_stories', { query: '  ' })),
    ).toMatchObject(missing);
    expect(httpArgs()).toEqual([]);
  });

  it('coerces template-rendered text to the projected type and rejects what cannot coerce', async () => {
    cacheSchema('shortcut.search_stories', {
      query: { type: 'string' },
      limit: { type: 'number' },
      archived: { type: 'boolean' },
    });
    await dispatchPluginNode(
      ctxFor('shortcut_search_stories', { query: 'q', limit: '10', archived: 'false' }),
    );
    expect(httpArgs()).toEqual([{ query: 'q', limit: 10, archived: false }]);
    expect(
      await dispatchPluginNode(ctxFor('shortcut_search_stories', { limit: 'ten' })),
    ).toMatchObject({ type: 'error', message: expect.stringContaining('expected number') });
  });

  it('forwards a cache-known field the form cannot render, untouched', async () => {
    cacheSchema('shortcut.search_stories', { query: { type: 'string' } }, ['labels']);
    await dispatchPluginNode(ctxFor('shortcut_search_stories', { query: 'q', labels: ['a'] }));
    expect(httpArgs()).toEqual([{ query: 'q', labels: ['a'] }]);
  });

  it('fails closed when the connection is live but no schema has been cached', async () => {
    resetSchemaCache();
    expect(
      await dispatchPluginNode(ctxFor('shortcut_search_stories', { query: 'q' })),
    ).toMatchObject({ type: 'error', message: expect.stringContaining('Settings → Plugins') });
    expect(httpArgs()).toEqual([]);
  });

  it('sends a declared projectId argument — the script-node reserved key does not apply', async () => {
    cacheSchema('shortcut.search_stories', { projectId: { type: 'string' } });
    await dispatchPluginNode(ctxFor('shortcut_search_stories', { projectId: 'p-1' }));
    expect(httpArgs()).toEqual([{ projectId: 'p-1' }]);
  });

  it('treats a required field with a schema default as satisfied when unset, like the editor', async () => {
    cacheSchema('shortcut.search_stories', {
      query: { type: 'string' },
      page_size: { type: 'number', required: true, default: 25 },
    });
    await dispatchPluginNode(ctxFor('shortcut_search_stories', { query: 'q' }));
    expect(httpArgs()).toEqual([{ query: 'q' }]);
  });

  it('omits an unset optional field so the provider applies its own default', async () => {
    cacheSchema('shortcut.search_stories', {
      query: { type: 'string' },
      limit: { type: 'number', default: 10 },
    });
    await dispatchPluginNode(ctxFor('shortcut_search_stories', { query: 'q' }));
    expect(httpArgs()).toEqual([{ query: 'q' }]);
  });

  it('uses the OAuth grant independently of optional webhook accounts', async () => {
    state.integrations = [
      { id: 'int-1', provider: 'shortcut', isActive: true },
      { id: 'int-2', provider: 'shortcut', isActive: true },
    ];
    const result = await dispatchPluginNode(ctxFor('shortcut_search_stories'));
    expect(result).toMatchObject({ type: 'completed' });
    expect(listLocalIntegrations).not.toHaveBeenCalled();
  });

  it('routes Shortcut story creation through its managed MCP server', async () => {
    cacheSchema('shortcut.create_story', { name: { type: 'string', required: true } });
    const result = await dispatchPluginNode(ctxFor('shortcut_create_story', { name: 'x' }));
    expect(httpCalls()).toEqual([
      {
        url: 'https://mcp.shortcut.com/mcp',
        tool: 'stories-create',
        headers: { Authorization: 'Bearer shortcut-test-token' },
      },
    ]);
    expect(result).toMatchObject({ type: 'completed' });
  });
});
