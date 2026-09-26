import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { TestDb } from '../../db/test-utils/fresh-db';
import type { McpToolListResult } from '../../mcp/tools-probe';
import type { FrinkMcpCredentials, FrinkMcpServerConfig } from '../../mcp/types';

type ServerFixture = Partial<
  Pick<FrinkMcpServerConfig, 'command' | 'url' | 'enabled' | 'managedBy'>
>;
type HttpProbe = { url: string; headers?: Record<string, string> };
type CredentialSlot = { current: FrinkMcpCredentials | null };
type DescriptorSlot = { current: McpToolListResult };
type GateSlot = { current: Promise<void> | null };
type DbSlot = { current: TestDb | null };

const state = vi.hoisted(() => {
  const servers: Record<string, ServerFixture> = {};
  const credentials: CredentialSlot = { current: null };
  const descriptors: DescriptorSlot = { current: { ok: true, tools: [] } };
  const httpCalls: HttpProbe[] = [];
  const db: DbSlot = { current: null };
  /** When set, the next http probe waits on it — simulates a slow provider. */
  const gate: GateSlot = { current: null };
  return {
    servers,
    credentials,
    descriptors,
    httpCalls,
    db,
    gate,
    captureMock: vi.fn(),
  };
});

// The probe opens the app database and live MCP transports; both are replaced per case.
// oxlint-disable-next-line anti-slop/no-module-mocking
vi.mock('../../db', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../db')>()),
  getDatabase: () => testDb(),
}));
// The registry and credential files under ~/.frink are replaced by per-case fixtures.
// oxlint-disable-next-line anti-slop/no-module-mocking
vi.mock('../../mcp', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../mcp')>()),
  getGlobalMcpServers: vi.fn(async () => state.servers),
  readMcpConfigSync: () => ({
    version: 2,
    servers: state.servers,
    deletedImports: {},
  }),
  getMcpCredentials: vi.fn(async () => state.credentials.current),
}));
// The live tools/list probe is replaced by the per-case descriptor fixture.
// oxlint-disable-next-line anti-slop/no-module-mocking
vi.mock('../../mcp/tools-probe', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../mcp/tools-probe')>()),
  fetchMcpToolDescriptorsStdio: vi.fn(async () => state.descriptors.current),
  fetchMcpToolDescriptors: vi.fn(async (url: string, headers?: Record<string, string>) => {
    state.httpCalls.push({ url, headers });
    const result = state.descriptors.current;
    const gate = state.gate.current;
    state.gate.current = null;
    if (gate) await gate;
    return result;
  }),
}));
// The refresh path needs a live token endpoint; here the stored credential passes through unchanged.
// oxlint-disable-next-line anti-slop/no-module-mocking
vi.mock('../../mcp/runtime/resolve-frink-servers', () => ({
  refreshNearExpiryOAuth: vi.fn(
    async (
      _name: string,
      _config: FrinkMcpServerConfig,
      credentials: FrinkMcpCredentials | undefined,
    ) => credentials,
  ),
}));
// Sentry is observed, never reached.
// oxlint-disable-next-line anti-slop/no-module-mocking
vi.mock('../../sentry/init', () => ({
  captureMainMessage: state.captureMock,
  captureMainException: vi.fn(),
}));

import { listPluginNodeSchemas } from '../../db/repos/plugin-node-schemas';
import { freshDb } from '../../db/test-utils/fresh-db';
import { fetchMcpToolDescriptors } from '../../mcp/tools-probe';
import { listPluginNodes } from './index';
import {
  probeSchemasBestEffort,
  refreshPluginNodeSchemas,
  refreshMissingPluginNodeSchemas,
} from './schema-cache';

function testDb(): TestDb {
  if (!state.db.current) throw new Error('test database not seeded');
  return state.db.current;
}

describe('plugin node schema cache', () => {
  beforeEach(() => {
    state.db.current = freshDb();
    for (const key of Object.keys(state.servers)) delete state.servers[key];
    state.credentials.current = null;
    state.descriptors.current = { ok: true, tools: [] };
    state.httpCalls.length = 0;
    state.gate.current = null;
    state.captureMock.mockReset();
  });

  it('caches Square operation fields independently from its shared API tool envelope', async () => {
    state.servers.plugin_square_square = {
      url: 'https://mcp.squareup.com/mcp',
      managedBy: 'vendor_plugin',
    };
    state.credentials.current = { headers: { Authorization: 'Bearer t' } };
    state.descriptors.current = {
      ok: true,
      tools: [
        {
          name: 'make_api_request',
          inputSchema: {
            type: 'object',
            properties: {
              service: { type: 'string' },
              method: { type: 'string' },
              request: {
                type: 'object',
                properties: {},
                additionalProperties: {},
              },
            },
            required: ['service', 'method'],
          },
        },
      ],
    };
    await refreshMissingPluginNodeSchemas();
    const cached = listPluginNodeSchemas(testDb(), 'square');
    expect(cached.size).toBe(5);
    expect(cached.get('square.get_payment')?.inputs).toEqual({
      payment_id: { type: 'string', label: 'Payment ID', required: true },
    });
    expect(cached.get('square.get_order')?.inputs).toEqual({
      order_id: { type: 'string', label: 'Order ID', required: true },
    });
    expect(cached.get('square.list_locations')?.inputs).toEqual({});
    expect(listPluginNodes('square').map((node) => node.name)).toEqual([
      'square_list_locations',
      'square_list_payments',
      'square_get_payment',
      'square_get_order',
      'square_list_catalog',
      'square_call_tool',
    ]);
    expect(cached.get('square.list_payments')?.inputs.limit).toEqual({
      type: 'number',
    });
    expect(state.httpCalls).toHaveLength(1);
    await refreshMissingPluginNodeSchemas();
    expect(state.httpCalls).toHaveLength(1);
  });

  it('only caches Vercel actions whose named tools the vendor advertises', async () => {
    state.servers.plugin_vercel_vercel = {
      url: 'https://mcp.vercel.com',
      managedBy: 'vendor_plugin',
    };
    state.credentials.current = { headers: { Authorization: 'Bearer t' } };
    state.descriptors.current = {
      ok: true,
      tools: [
        {
          name: 'get_deployment',
          inputSchema: {
            type: 'object',
            properties: {
              idOrUrl: { type: 'string' },
              teamId: { type: 'string' },
            },
            required: ['idOrUrl', 'teamId'],
          },
        },
      ],
    };
    await refreshPluginNodeSchemas('vercel');
    const cached = listPluginNodeSchemas(testDb(), 'vercel');
    expect([...cached.keys()]).toEqual(['vercel.get_deployment']);
    expect(listPluginNodes('vercel').map((node) => node.name)).toEqual([
      'vercel_get_deployment',
      'vercel_call_tool',
    ]);
    expect(cached.get('vercel.get_deployment')?.inputs).toEqual({
      idOrUrl: { type: 'string', required: true },
      teamId: { type: 'string', required: true },
    });
  });

  it('lands probes for one plugin in call order, so a slow earlier probe never overwrites a later one', async () => {
    state.servers.plugin_posthog_posthog = {
      url: 'https://mcp.posthog.com/mcp',
      managedBy: 'vendor_plugin',
    };
    state.credentials.current = { headers: { Authorization: 'Bearer t' } };
    const tool = (property: string): McpToolListResult => ({
      ok: true,
      tools: [
        {
          name: 'feature-flag-get-all',
          inputSchema: {
            type: 'object',
            properties: { [property]: { type: 'string' } },
          },
        },
      ],
    });
    let releaseFirst = () => {};
    state.gate.current = new Promise<void>((resolve) => {
      releaseFirst = resolve;
    });
    state.descriptors.current = tool('stale');
    const first = refreshPluginNodeSchemas('posthog');
    state.descriptors.current = tool('fresh');
    const second = refreshPluginNodeSchemas('posthog');
    releaseFirst();
    await Promise.all([first, second]);
    expect(
      listPluginNodeSchemas(testDb(), 'posthog').get('posthog.list_feature_flags')?.inputs,
    ).toEqual({
      fresh: { type: 'string' },
    });
  });

  it.each(['missing', 'ambiguous', 'non-object'])(
    'preserves cached operation fields when a preset schema becomes %s',
    async (failure) => {
      state.servers.plugin_webflow_webflow = {
        url: 'https://mcp.webflow.com/mcp',
        managedBy: 'vendor_plugin',
      };
      state.credentials.current = { headers: { Authorization: 'Bearer t' } };
      const list = {
        type: 'object',
        properties: {
          list_sites: {
            type: 'object',
            properties: { limit: { type: 'integer' } },
          },
        },
      };
      const get = {
        type: 'object',
        properties: {
          get_site: {
            type: 'object',
            properties: { site_id: { type: 'string' } },
            required: ['site_id'],
          },
        },
      };
      const descriptor = (branches: unknown[]): McpToolListResult => ({
        ok: true,
        tools: [
          {
            name: 'data_sites_tool',
            inputSchema: {
              type: 'object',
              properties: {
                actions: { type: 'array', items: { anyOf: branches } },
                context: { type: 'string' },
              },
            },
          },
        ],
      });
      state.descriptors.current = descriptor([list, get]);
      await refreshPluginNodeSchemas('webflow');
      const before = listPluginNodeSchemas(testDb(), 'webflow').get('webflow.list_sites');
      expect(before).toEqual({
        inputs: { limit: { type: 'number' } },
        unsupportedFields: [],
      });
      state.captureMock.mockClear();
      const broken =
        failure === 'missing'
          ? []
          : failure === 'ambiguous'
            ? [list, list]
            : [
                {
                  type: 'object',
                  properties: { list_sites: { type: 'string' } },
                },
              ];
      state.descriptors.current = descriptor([...broken, get]);
      await refreshPluginNodeSchemas('webflow');
      expect(listPluginNodeSchemas(testDb(), 'webflow').get('webflow.list_sites')).toEqual(before);
      expect(state.captureMock).toHaveBeenCalledTimes(1);
      expect(state.captureMock).toHaveBeenCalledWith(
        expect.stringContaining('schema selection failed'),
        'warning',
        expect.objectContaining({ actionId: 'webflow.list_sites' }),
      );
    },
  );

  it('caches the projected schema of every pinned tool the live server advertises, and nothing for the rest', async () => {
    state.servers.plugin_posthog_posthog = {
      url: 'https://mcp.posthog.com/mcp',
      managedBy: 'vendor_plugin',
    };
    state.credentials.current = { headers: { Authorization: 'Bearer t' } };
    state.descriptors.current = {
      ok: true,
      tools: [
        {
          name: 'feature-flag-get-all',
          inputSchema: {
            type: 'object',
            properties: { search: { type: 'string' } },
          },
        },
      ],
    };
    await refreshPluginNodeSchemas('posthog');
    // One probe per server, the chat bearer plus the manifest's Flow-only header.
    expect(state.httpCalls).toEqual([
      {
        url: 'https://mcp.posthog.com/mcp',
        headers: { Authorization: 'Bearer t', 'x-posthog-mcp-mode': 'tools' },
      },
    ]);
    const cached = listPluginNodeSchemas(testDb(), 'posthog');
    expect(cached.get('posthog.list_feature_flags')).toEqual({
      inputs: { search: { type: 'string' } },
      unsupportedFields: [],
    });
    expect(cached.has('posthog.list_dashboards')).toBe(false);
    expect(cached.has('posthog.call_tool')).toBe(false);
  });

  it('keeps the previous row and reports the miss when the descriptor fetch fails', async () => {
    state.servers.plugin_shortcut_shortcut = {
      url: 'https://mcp.shortcut.com/mcp',
      managedBy: 'vendor_plugin',
    };
    state.credentials.current = { headers: { Authorization: 'Bearer t' } };
    state.descriptors.current = {
      ok: true,
      tools: [{ name: 'stories-search', inputSchema: { type: 'object' } }],
    };
    await refreshPluginNodeSchemas('shortcut');
    expect(listPluginNodeSchemas(testDb(), 'shortcut').has('shortcut.search_stories')).toBe(true);

    state.descriptors.current = {
      ok: false,
      reason: 'timeout',
      message: 'MCP fetch timeout',
    };
    await refreshPluginNodeSchemas('shortcut');
    expect(listPluginNodeSchemas(testDb(), 'shortcut').has('shortcut.search_stories')).toBe(true);
    expect(state.captureMock).toHaveBeenCalledWith(
      expect.stringContaining('timeout'),
      'warning',
      expect.objectContaining({ pluginId: 'shortcut' }),
    );
  });

  it('probeSchemasBestEffort turns a thrown probe into a warning, so no connect or Turn on fails on it', async () => {
    state.servers.plugin_posthog_posthog = {
      url: 'https://mcp.posthog.com/mcp',
      managedBy: 'vendor_plugin',
    };
    state.credentials.current = { headers: { Authorization: 'Bearer t' } };
    vi.mocked(fetchMcpToolDescriptors).mockRejectedValueOnce(
      new Error('Error while decrypting the ciphertext provided to safeStorage.decryptString.'),
    );
    await expect(probeSchemasBestEffort('posthog')).resolves.toBeUndefined();
    expect(state.captureMock).toHaveBeenCalledWith(
      expect.stringContaining('safeStorage'),
      'warning',
      expect.objectContaining({
        surface: 'plugin-node-schema-cache',
        pluginId: 'posthog',
      }),
    );
  });

  it('probes nothing for a plugin whose rows all carry their own schema', async () => {
    await refreshPluginNodeSchemas('slack');
    expect(state.httpCalls).toEqual([]);
    expect(listPluginNodeSchemas(testDb(), 'slack').size).toBe(0);
  });
});
