import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { FrinkMcpServerConfig } from '../../mcp/types';
import type { TestDb } from '../../db/test-utils/fresh-db';

type ServerFixture = Partial<
  Pick<FrinkMcpServerConfig, 'command' | 'url' | 'enabled' | 'managedBy'>
>;
type DbSlot = { current: TestDb | null };

const state = vi.hoisted(() => {
  const servers: Record<string, ServerFixture> = {};
  const db: DbSlot = { current: null };
  return { servers, db };
});

// The registry file under ~/.frink is the connection truth; each case declares its own entries.
// oxlint-disable-next-line anti-slop/no-module-mocking
vi.mock('../../mcp', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../mcp')>()),
  readMcpConfigSync: () => ({ version: 2, servers: state.servers, deletedImports: {} }),
}));
// The derivation opens the app database; each case gets an in-memory one.
// oxlint-disable-next-line anti-slop/no-module-mocking
vi.mock('../../db', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../db')>()),
  getDatabase: () => testDb(),
}));

import {
  GENERIC_CALL_TOOL_INPUTS,
  MCP_TOOL_NODE_OUTPUTS,
} from '../../../../shared/integrations/plugin-nodes';
import { upsertConnectionLifecycle } from '../../db/repos/plugin-connection-lifecycle';
import { install } from '../../db/repos/plugin-installations';
import { upsertPluginNodeSchema } from '../../db/repos/plugin-node-schemas';
import { freshDb } from '../../db/test-utils/fresh-db';
import { listConnectedPluginIds, listPluginNodes } from './index';

/** Cloud integration ids are UUIDs; the provisioned MCP entry is `<provider>-<uuid>`. */

function testDb(): TestDb {
  if (!state.db.current) throw new Error('test database not seeded');
  return state.db.current;
}

describe('plugin node derivation', () => {
  beforeEach(() => {
    state.db.current = freshDb();
    for (const key of Object.keys(state.servers)) delete state.servers[key];
  });

  it('lists nothing while no plugin is connected', () => {
    expect(listConnectedPluginIds().size).toBe(0);
    expect(listPluginNodes()).toEqual([]);
  });

  it('never derives nodes from a trigger account alone: the account powers triggers only', async () => {
    await install(testDb(), { pluginId: 'generic_webhook', sourceKind: 'frink_builtin' });
    await upsertConnectionLifecycle(testDb(), {
      pluginId: 'generic_webhook',
      connectionId: 'conn-1',
      lifecycleState: 'active',
    });
    expect(listConnectedPluginIds().size).toBe(0);
  });

  it('derives a pinned provider from its enabled vendor server, curated rows only once probed', () => {
    state.servers.plugin_clickup_clickup = {
      url: 'https://mcp.clickup.com/mcp',
      managedBy: 'vendor_plugin',
    };
    expect(listConnectedPluginIds()).toEqual(new Set(['clickup']));
    // The generic call-tool row carries its own inputs; every curated row waits for the probe.
    expect(listPluginNodes('clickup').map((node) => node.name)).toEqual(['clickup_call_tool']);

    upsertPluginNodeSchema(testDb(), {
      pluginId: 'clickup',
      actionId: 'clickup.get_task',
      inputs: { taskId: { type: 'string', required: true } },
      unsupportedFields: [],
    });
    const nodes = listPluginNodes('clickup');
    expect(nodes.map((node) => node.name)).toEqual(['clickup_get_task', 'clickup_call_tool']);
    expect(nodes[0]).toMatchObject({
      kind: 'plugin_mcp_tool',
      owner: { pluginId: 'clickup', actionId: 'clickup.get_task' },
      outputs: MCP_TOOL_NODE_OUTPUTS,
    });
  });

  it('derives an attachment from its enabled vendor server, with the generic call-tool row', () => {
    state.servers.plugin_linear_linear = {
      url: 'https://mcp.linear.app/mcp',
      managedBy: 'vendor_plugin',
    };
    expect(listPluginNodes('linear').map((node) => node.name)).toEqual(['linear_call_tool']);
  });

  it('derives Shortcut nodes from its managed HTTP server', () => {
    state.servers.plugin_shortcut_shortcut = {
      url: 'https://mcp.shortcut.com/mcp',
      managedBy: 'vendor_plugin',
    };
    expect(listPluginNodes().map((node) => node.name)).toEqual(['shortcut_call_tool']);

    upsertPluginNodeSchema(testDb(), {
      pluginId: 'shortcut',
      actionId: 'shortcut.search_stories',
      inputs: { query: { type: 'string' } },
      unsupportedFields: ['owners'],
    });
    const names = listPluginNodes().map((node) => node.name);
    expect(names).toContain('shortcut_search_stories');
    expect(names).not.toContain('shortcut_get_story');
    const searched = listPluginNodes('shortcut').find((n) => n.name === 'shortcut_search_stories');
    expect(searched).toMatchObject({
      kind: 'plugin_mcp_tool',
      inputs: { query: { type: 'string' } },
      unsupportedFields: ['owners'],
      outputs: MCP_TOOL_NODE_OUTPUTS,
    });
  });

  it('derives a chat-only catalog plugin from its enabled vendor server, with the generic call-tool row and no probe', () => {
    state.servers.plugin_posthog_posthog = {
      url: 'https://mcp.posthog.com/mcp',
      managedBy: 'vendor_plugin',
    };
    const nodes = listPluginNodes('posthog');
    expect(nodes.map((node) => node.name)).toEqual(['posthog_call_tool']);
    expect(nodes[0]).toMatchObject({
      source: { type: 'provider_mcp', serverId: 'posthog' },
      inputs: GENERIC_CALL_TOOL_INPUTS,
      outputs: MCP_TOOL_NODE_OUTPUTS,
    });
  });

  it('ignores a turned-off vendor server, a foreign entry of the same name, and unknown plugins', () => {
    state.servers.plugin_posthog_posthog = {
      url: 'https://mcp.posthog.com/mcp',
      managedBy: 'vendor_plugin',
      enabled: false,
    };
    state.servers.plugin_sentry_sentry = { url: 'https://mcp.sentry.dev/mcp' };
    expect(listConnectedPluginIds().size).toBe(0);
  });

  it('filters by plugin without consulting the others', () => {
    state.servers.plugin_clickup_clickup = {
      url: 'https://mcp.clickup.com/mcp',
      managedBy: 'vendor_plugin',
    };
    state.servers.plugin_posthog_posthog = {
      url: 'https://mcp.posthog.com/mcp',
      managedBy: 'vendor_plugin',
    };
    expect(new Set(listPluginNodes('posthog').map((n) => n.owner.pluginId))).toEqual(
      new Set(['posthog']),
    );
    expect(listConnectedPluginIds()).toEqual(new Set(['clickup', 'posthog']));
  });
});
