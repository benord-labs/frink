/** Run readiness against the real integration-node derivation; run-readiness.test.ts stubs it. */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { FlowGraph } from '../../../../shared/lib/validate-flow-graph';
import type { TestDb } from '../../db/test-utils/fresh-db';
import type { FrinkMcpServerConfig } from '../types';

type ServerFixture = Partial<Pick<FrinkMcpServerConfig, 'url' | 'enabled' | 'managedBy'>>;
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
// Script discovery scans ~/.frink/nodes on the host; these cases are about integration nodes only.
// oxlint-disable-next-line anti-slop/no-module-mocking
vi.mock('../../custom-nodes/discovery', () => ({
  discoverCustomNodes: () => ({ valid: [], manifestWarnings: [], errors: [] }),
}));

import { jsonSchemaToManifestInputs } from '../../../../shared/lib/flows/json-schema-to-manifest-inputs';
import { upsertPluginNodeSchema } from '../../db/repos/plugin-node-schemas';
import { freshDb } from '../../db/test-utils/fresh-db';
import { describeFlowRunBlockers } from './run-readiness';

function testDb(): TestDb {
  if (!state.db.current) throw new Error('test database not seeded');
  return state.db.current;
}

function connectShortcut(overrides: ServerFixture = {}): void {
  state.servers.plugin_shortcut_shortcut = {
    url: 'https://mcp.shortcut.com/mcp',
    managedBy: 'vendor_plugin',
    ...overrides,
  };
}

/** A provider `inputSchema` in the shape a real tools/list returns: mixed types, enum, default, no-type field. */
const SEARCH_STORIES_SCHEMA = {
  type: 'object',
  properties: {
    query: { type: 'string', description: 'Search text' },
    state: { type: 'string', enum: ['open', 'done'], title: 'State' },
    limit: { type: 'integer', default: 25 },
    filters: { type: 'object', properties: { owner: { type: 'string' } } },
    archived: { type: 'boolean' },
    owners: { description: 'No type: the form cannot render it' },
  },
  required: ['query', 'state', 'limit', 'filters', 'owners'],
};

/** Store the schema exactly as the probe does: projected, then written to the cache row. */
function cacheSearchStoriesSchema(): void {
  upsertPluginNodeSchema(testDb(), {
    pluginId: 'shortcut',
    actionId: 'shortcut.search_stories',
    ...jsonSchemaToManifestInputs(SEARCH_STORIES_SCHEMA),
  });
}

function graphWith(blockType: string, config?: Record<string, unknown>): FlowGraph {
  return {
    nodes: [
      { id: 't', blockType: 'manual_trigger' },
      { id: 'pn', blockType, ...(config ? { config } : {}) },
    ],
    edges: [{ id: 'e', source: 't', target: 'pn' }],
  } as FlowGraph;
}

describe('describeFlowRunBlockers — derived integration nodes', () => {
  beforeEach(() => {
    state.db.current = freshDb();
    for (const key of Object.keys(state.servers)) delete state.servers[key];
  });

  it('blocks a connected plugin call-tool node saved with no config at all', () => {
    connectShortcut();
    expect(describeFlowRunBlockers(graphWith('shortcut_call_tool'))).toBe(
      'Custom node "shortcut_call_tool" is missing required inputs: tool',
    );
  });

  it('names exactly the unset required fields of a probed provider schema', () => {
    connectShortcut();
    cacheSearchStoriesSchema();
    // `limit` carries a schema default and `owners` has no renderable type, so neither is reported.
    expect(describeFlowRunBlockers(graphWith('shortcut_search_stories', {}))).toBe(
      'Custom node "shortcut_search_stories" is missing required inputs: query, state, filters',
    );
  });

  it('accepts a probed-schema node whose required fields are all set', () => {
    connectShortcut();
    cacheSearchStoriesSchema();
    const config = {
      connectionId: 'conn-1',
      query: '{{trigger.text}}',
      state: 'open',
      filters: '{"owner":"me"}',
    };
    expect(describeFlowRunBlockers(graphWith('shortcut_search_stories', config))).toBeNull();
  });

  it('does not judge a pinned tool whose schema has not been probed yet', () => {
    connectShortcut();
    expect(describeFlowRunBlockers(graphWith('shortcut_search_stories', {}))).toBeNull();
  });

  it('does not judge a node whose plugin is turned off', () => {
    connectShortcut({ enabled: false });
    cacheSearchStoriesSchema();
    expect(describeFlowRunBlockers(graphWith('shortcut_search_stories', {}))).toBeNull();
    expect(describeFlowRunBlockers(graphWith('shortcut_call_tool', {}))).toBeNull();
  });
});
