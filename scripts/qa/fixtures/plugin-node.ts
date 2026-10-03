/** A plugin-node flow with no run, so the editor alone is the surface under test. */
import * as schema from '../../../src/main/lib/db/schema';
import { pluginNodeSchemas } from '../../../src/main/lib/db/schema/plugin-installations';
import { MCP_CONFIG_VERSION, vendorPluginServerConfig } from '../../../src/main/lib/mcp/types';
import { FIXTURE_PROJECT_ID, T0, type SqliteDb } from './base';

// A plugin-node flow with NO run: the editor alone is the surface under test. Its PostHog steps are
// derived from the seeded MCP config entry below (the rig's own FRINK_HOME, no credentials) and the
// seeded schema row, so the config panel is identical on every boot and never depends on the
// operator's real ~/.frink or a connected PostHog account. The palette stays at exactly these two
// rows on purpose: PostHog's other pinned actions have no schema row and are omitted.
export const FIXTURE_PLUGIN_NODE_FLOW_ID = 'qa-fixture-flow-plugin-node';
export const FIXTURE_PLUGIN_NODE_FLOW_VERSION_ID = 'qa-fixture-flow-plugin-node-version';
export const FIXTURE_PLUGIN_NODE_FLOW_NAME = 'Plugin node QA flow';
/** Must equal pluginActionNodeName('posthog.list_errors'): discovery derives the folder from the owner. */
export const FIXTURE_PLUGIN_NODE_NAME = 'posthog_list_errors';
/** Must equal pluginActionNodeName('posthog.call_tool'): the generic row every http plugin carries. */
export const FIXTURE_CALL_TOOL_NODE_NAME = 'posthog_call_tool';

const FIXTURE_PLUGIN_NODE_GRAPH = {
  nodes: [
    {
      id: 'trigger-1',
      blockType: 'manual_trigger',
      label: 'Run manually',
      config: {},
      position: { x: 0, y: 0 },
    },
    {
      id: 'posthog-1',
      blockType: FIXTURE_PLUGIN_NODE_NAME,
      label: 'List PostHog errors',
      config: {},
      position: { x: 320, y: 0 },
    },
    {
      id: 'posthog-2',
      blockType: FIXTURE_CALL_TOOL_NODE_NAME,
      label: 'Call any PostHog tool',
      config: {},
      position: { x: 640, y: 0 },
    },
  ],
  edges: [
    { id: 'e-trigger-posthog', source: 'trigger-1', target: 'posthog-1' },
    { id: 'e-posthog-call', source: 'posthog-1', target: 'posthog-2' },
  ],
  settings: {},
};

/** The probed schema of the curated PostHog row, frozen with one `json` input and two unsupported fields. */
export const FIXTURE_PLUGIN_NODE_SCHEMA = {
  pluginId: 'posthog',
  actionId: 'posthog.list_errors',
  inputs: {
    status: {
      type: 'string',
      options: ['active', 'resolved', 'all'],
      default: 'active',
      placeholder: 'Filter by issue status.',
    },
    dateRange: {
      type: 'json',
      default: { date_from: '-7d', date_to: null },
      placeholder: 'Only issues seen inside this window.',
    },
  },
  unsupportedFields: ['assignee', 'filterGroup'],
} as const;

/** The rig's whole ~/.frink/mcp/config.json: PostHog registered (so it derives as connected), no credentials. */
export const FIXTURE_MCP_CONFIG = {
  version: MCP_CONFIG_VERSION,
  servers: {
    plugin_posthog_posthog: vendorPluginServerConfig('posthog', 'https://mcp.posthog.com/mcp'),
  },
  deletedImports: {},
};

export function seedPluginNodeFlowFixture(db: SqliteDb): void {
  db.insert(pluginNodeSchemas)
    .values({
      pluginId: FIXTURE_PLUGIN_NODE_SCHEMA.pluginId,
      actionId: FIXTURE_PLUGIN_NODE_SCHEMA.actionId,
      inputs: { ...FIXTURE_PLUGIN_NODE_SCHEMA.inputs },
      unsupportedFields: [...FIXTURE_PLUGIN_NODE_SCHEMA.unsupportedFields],
    })
    .run();
  db.insert(schema.flows)
    .values({
      id: FIXTURE_PLUGIN_NODE_FLOW_ID,
      projectId: FIXTURE_PROJECT_ID,
      name: FIXTURE_PLUGIN_NODE_FLOW_NAME,
      createdAt: T0,
      updatedAt: T0,
    })
    .run();
  db.insert(schema.flowVersions)
    .values({
      id: FIXTURE_PLUGIN_NODE_FLOW_VERSION_ID,
      flowId: FIXTURE_PLUGIN_NODE_FLOW_ID,
      versionNumber: 1,
      graph: FIXTURE_PLUGIN_NODE_GRAPH,
      createdAt: T0,
    })
    .run();
}
