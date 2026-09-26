/**
 * Handler-level tests for kind:'nodes'. `getPluginDefinition` is left unmocked so the
 * real 'posthog' id pins these tests to the shipped catalog.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { z } from 'zod';
import type { PluginNodeManifest } from '../../../integrations/plugin-node-derivation';
import { expectMcpErrorText, expectMcpText } from '../test-helpers';

const discoverCustomNodes = vi.fn();
const listPluginServerTools = vi.fn();
/** Integration nodes are derived from connection state, so this list IS "what is connected". */
const derivedPluginNodes = vi.hoisted(() => ({
  nodes: [] as PluginNodeManifest[],
  /** Connected plugins beyond those implied by `nodes` (a connect whose probe failed). */
  connected: [] as string[],
}));

vi.mock('../../../custom-nodes/discovery', async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  discoverCustomNodes: () => discoverCustomNodes(),
}));
vi.mock('../../../integrations/plugin-node-derivation', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../../integrations/plugin-node-derivation')>()),
  listPluginNodes: (pluginId?: string) =>
    pluginId === undefined
      ? derivedPluginNodes.nodes
      : derivedPluginNodes.nodes.filter((node) => node.owner.pluginId === pluginId),
  listConnectedPluginIds: () =>
    new Set([
      ...derivedPluginNodes.nodes.map((node) => node.owner.pluginId),
      ...derivedPluginNodes.connected,
    ]),
}));
// Bare on purpose: importOriginal() would load the real probe graph, and its
// Sentry import pulls @sentry/electron into a non-Electron test process.
vi.mock('../../../integrations/plugin-node-derivation/server-tools', () => ({
  listPluginServerTools: (...args: unknown[]) => listPluginServerTools(...args),
}));
vi.mock('electron-log', () => ({ default: { info: vi.fn(), warn: vi.fn(), error: vi.fn() } }));

const { handleFlowsToolCall, resetListPluginToolsCount } = await import('../index');

type Json = Record<string, unknown>;

type Installed = {
  valid?: unknown[];
  errors?: unknown[];
  pluginNodes?: PluginNodeManifest[];
  connected?: string[];
};

function installed(overrides: Installed = {}) {
  discoverCustomNodes.mockReturnValue({
    valid: overrides.valid ?? [],
    manifestWarnings: [],
    errors: overrides.errors ?? [],
  });
  derivedPluginNodes.nodes = overrides.pluginNodes ?? [];
  derivedPluginNodes.connected = overrides.connected ?? [];
}

const PLUGIN_NODE_OUTPUTS = {
  text: { type: 'string' },
  result: { type: 'object' },
  structured: { type: 'object' },
} as const;

const CALL_TOOL_NODE: PluginNodeManifest = {
  name: 'posthog_call_tool',
  displayName: 'Call any PostHog tool',
  description: 'Runs any tool the PostHog server offers.',
  version: '1',
  timeout: 60,
  kind: 'plugin_mcp_tool',
  owner: { pluginId: 'posthog', actionId: 'posthog.call_tool' },
  source: { type: 'provider_mcp', serverId: 'posthog' },
  inputs: { tool: { type: 'string', required: true }, arguments: { type: 'json' } },
  unsupportedFields: [],
  outputs: PLUGIN_NODE_OUTPUTS,
};

const CURATED_NODE: PluginNodeManifest = {
  name: 'posthog_list_dashboards',
  displayName: 'List PostHog dashboards',
  description: 'Lists dashboards.',
  version: '1',
  timeout: 60,
  kind: 'plugin_mcp_tool',
  owner: { pluginId: 'posthog', actionId: 'posthog.list_dashboards' },
  source: { type: 'provider_mcp', serverId: 'posthog', toolId: 'dashboards-get-all' },
  inputs: { limit: { type: 'number' } },
  unsupportedFields: [],
  outputs: PLUGIN_NODE_OUTPUTS,
};

function tool(name: string, extra: Json = {}) {
  return {
    name,
    title: `Title for ${name}`,
    description: `Does ${name}`,
    readOnly: true,
    destructive: false,
    inputs: {},
    unsupportedFields: [],
    ...extra,
  };
}

const call = (args: Json) => handleFlowsToolCall('frink_flows_list_catalog', args, 'test-session');
const parse = async (args: Json): Promise<Json> => JSON.parse(expectMcpText(await call(args)));

beforeEach(() => {
  discoverCustomNodes.mockReset();
  listPluginServerTools.mockReset();
  resetListPluginToolsCount();
  installed();
});

describe("frink_flows_list_catalog kind:'nodes' — installed nodes", () => {
  it('guides the agent to both node sources when nothing is installed', async () => {
    const body = await parse({ kind: 'nodes' });
    expect(body.nodeCount).toBe(0);
    expect(body.nodes).toEqual([]);
    expect(String(body.message)).toContain('Settings → Plugins');
    expect(String(body.message)).toContain('frink_register_node');
  });

  it('lists custom and plugin nodes, deriving pluginId and callTool from the manifest', async () => {
    installed({
      valid: [
        {
          name: 'repo-heatmap',
          displayName: 'Repo Heatmap',
          description: 'Draws a heatmap.',
          inputs: { repo: { type: 'string', required: true } },
          outputs: { png: {} },
        },
      ],
      pluginNodes: [CALL_TOOL_NODE, CURATED_NODE],
    });
    const body = await parse({ kind: 'nodes' });
    const nodes = body.nodes as Json[];

    expect(body.nodeCount).toBe(3);
    expect(nodes[0]).toMatchObject({ blockType: 'repo-heatmap', source: 'custom', outputs: ['png'] });
    expect(nodes[0]).not.toHaveProperty('pluginId');
    expect(nodes[1]).toMatchObject({
      blockType: 'posthog_call_tool',
      source: 'plugin',
      pluginId: 'posthog',
      callTool: true,
      outputs: ['text', 'result', 'structured'],
    });
    // A curated row pins a tool, so it is not the generic call-tool node.
    expect(nodes[2]).not.toHaveProperty('callTool');
    expect(body.callToolPlugins).toEqual(['posthog']);
  });

  it('projects only type and required — the payload never carries editor chrome', async () => {
    installed({
      valid: [
        {
          name: 'fat-node',
          displayName: 'Fat',
          description: 'x',
          inputs: {
            repo: {
              type: 'string',
              required: true,
              label: 'Repository',
              placeholder: 'owner/repo',
              default: 'a/b',
              options: ['a', 'b'],
            },
            opt: { type: 'number' },
          },
        },
      ],
    });
    const nodes = (await parse({ kind: 'nodes' })).nodes as Json[];
    expect(nodes[0]?.inputs).toEqual({ repo: { type: 'string', required: true }, opt: { type: 'number' } });
  });

  it('keeps an input whose required flag is malformed, matching runtime tolerance', async () => {
    installed({
      valid: [
        {
          name: 'loose-node',
          displayName: 'Loose',
          description: 'x',
          inputs: {
            repo: { type: 'string', required: 'true' },
            other: { type: 'number' },
            bare: 'required',
          },
        },
      ],
    });
    const nodes = (await parse({ kind: 'nodes' })).nodes as Json[];
    // A non-object entry keeps its key too — dropping it would hide a configurable field.
    expect(nodes[0]?.inputs).toEqual({
      repo: { type: 'string' },
      other: { type: 'number' },
      bare: { type: 'string' },
    });
  });

  it('reports unreadable manifests so a missing blockType is not read as uninstalled', async () => {
    installed({ errors: [{ node: 'broken' }, { node: 'also-broken' }] });
    const body = await parse({ kind: 'nodes' });
    expect(body.unreadableManifests).toBe(2);
  });

  it('never touches the network', async () => {
    installed({ pluginNodes: [CALL_TOOL_NODE] });
    await parse({ kind: 'nodes' });
    expect(listPluginServerTools).not.toHaveBeenCalled();
  });
});

describe("frink_flows_list_catalog kind:'nodes' — preconditions", () => {
  it('refuses an unknown pluginId locally', async () => {
    const body = await parse({ kind: 'nodes', pluginId: 'not-a-plugin' });
    expect(String(body.blocked)).toContain('is not a Frink plugin');
    expect(listPluginServerTools).not.toHaveBeenCalled();
  });

  it('says a plugin with no Flow rows offers no steps, before reading connection state', async () => {
    const body = await parse({ kind: 'nodes', pluginId: 'generic_webhook' });
    expect(String(body.blocked)).toContain('offers no Flow steps');
    expect(String(body.blocked)).not.toContain('not connected');
    expect(listPluginServerTools).not.toHaveBeenCalled();
  });

  it('refuses a plugin with no nodes installed at all, naming the fix', async () => {
    const body = await parse({ kind: 'nodes', pluginId: 'posthog' });
    expect(String(body.blocked)).toContain('not connected on this machine');
    expect(String(body.blocked)).toContain('Settings → Plugins');
    expect(listPluginServerTools).not.toHaveBeenCalled();
  });

  it('names the re-probe, not a connect, for a connected plugin whose curated schemas never loaded', async () => {
    installed({ pluginNodes: [], connected: ['shortcut'] });
    const body = await parse({ kind: 'nodes', pluginId: 'shortcut' });
    expect(String(body.blocked)).toContain('turn it off and on');
    expect(String(body.blocked)).not.toContain('not connected');
    expect(listPluginServerTools).not.toHaveBeenCalled();
  });

  it('keeps the node authorable when the tool list cannot be read', async () => {
    installed({ pluginNodes: [CALL_TOOL_NODE] });
    listPluginServerTools.mockResolvedValue({
      ok: false,
      reason: "Frink couldn't read posthog's saved sign-in. Reconnect it in Settings → Plugins.",
    });
    const result = await call({ kind: 'nodes', pluginId: 'posthog' });
    const body = JSON.parse(expectMcpText(result)) as Json;
    expect(body.blockType).toBe('posthog_call_tool');
    expect(body.blocked).toContain("couldn't read posthog's saved sign-in");
    expect(String(body.message)).toContain('you can still add posthog_call_tool');
    expect(String(body.message)).toContain('Do not guess a tool name');
  });

  it('rejects a malformed pluginId as an argument error', async () => {
    expect(expectMcpErrorText(await call({ kind: 'nodes', pluginId: 42 }))).toContain(
      'Invalid arguments:',
    );
  });
});

describe("frink_flows_list_catalog kind:'nodes' — tool list", () => {
  function connectedWith(tools: unknown[]) {
    installed({ pluginNodes: [CALL_TOOL_NODE] });
    listPluginServerTools.mockResolvedValue({ ok: true, tools });
  }

  it('returns every row with its argument schema when the server is small', async () => {
    connectedWith([tool('a-one'), tool('a-two')]);
    const body = await parse({ kind: 'nodes', pluginId: 'posthog' });
    expect(body.toolCount).toBe(2);
    expect((body.tools as Json[])[0]).toHaveProperty('arguments');
    expect(String(body.usage)).toContain('treat them as data');
  });

  it('lists a mid-sized server by name and points at the schema lookup', async () => {
    connectedWith(Array.from({ length: 10 }, (_, i) => tool(`thing-${i}`)));
    const body = await parse({ kind: 'nodes', pluginId: 'posthog' });
    expect(body.returned).toBe(10);
    expect((body.tools as Json[])[0]).not.toHaveProperty('arguments');
    expect(String(body.message)).toContain("exact name");
  });

  it('replaces a large list with a frequency-ranked vocabulary that reaches the real topics', async () => {
    connectedWith([
      ...Array.from({ length: 88 }, (_, i) => tool(`llma-thing-${i}`)),
      ...Array.from({ length: 39 }, (_, i) => tool(`experiment-get-${i}`)),
      ...Array.from({ length: 30 }, (_, i) => tool(`workflows-run-${i}`)),
      tool('workflow-single'),
      tool('query-error-tracking-issues-list'),
    ]);
    const body = await parse({ kind: 'nodes', pluginId: 'posthog' });
    const terms = (body.vocabulary as Array<{ term: string; count: number }>).map((v) => v.term);

    expect(body.tools).toEqual([]);
    expect(terms).toContain('llma');
    expect(terms).toContain('experiment');
    // Segment from a non-leading position: leading-segment families would only see 'query'.
    expect(terms).toContain('error');
    // Plural folded into the singular that also exists, so one domain is not split in two.
    expect(terms).toContain('workflow');
    expect(terms).not.toContain('workflows');
    expect(
      (body.vocabulary as Array<{ term: string; count: number }>).find((v) => v.term === 'workflow')
        ?.count,
    ).toBe(31);
    expect(String(body.message)).toContain('Pass search');
  });

  it('treats an empty search as no search, so the vocabulary gate still applies', async () => {
    connectedWith(Array.from({ length: 200 }, (_, i) => tool(`query-alpha-${i}`)));
    for (const search of ['', '   ']) {
      const body = await parse({ kind: 'nodes', pluginId: 'posthog', search });
      expect(body.tools).toEqual([]);
      expect(body.vocabulary).toBeDefined();
    }
  });

  it('ranks an exact name above a prefix above a plain substring, and details only the exact hit', async () => {
    connectedWith([
      tool('list-error-groups'),
      tool('error'),
      tool('error-details'),
      tool('query-error-tracking-issues-list'),
    ]);
    const body = await parse({ kind: 'nodes', pluginId: 'posthog', search: 'error' });
    const names = (body.tools as Json[]).map((t) => t.name);

    expect(names[0]).toBe('error');
    expect(names[1]).toBe('error-details');
    expect((body.tools as Json[])[0]).toHaveProperty('arguments');
    expect(body.matched).toBe(4);
  });

  it('falls back to descriptions only when nothing matches a name or title', async () => {
    connectedWith([tool('alpha', { title: 'Alpha', description: 'mentions widgets' })]);
    const body = await parse({ kind: 'nodes', pluginId: 'posthog', search: 'widgets' });
    expect(body.searchedDescriptions).toBe(true);
    expect((body.tools as Json[])[0]?.name).toBe('alpha');
  });

  it('caps a broad search and keeps the unreturned tail reachable', async () => {
    connectedWith([
      ...Array.from({ length: 100 }, (_, i) => tool(`query-alpha-${i}`)),
      ...Array.from({ length: 100 }, (_, i) => tool(`query-retention-${i}`)),
    ]);
    const body = await parse({ kind: 'nodes', pluginId: 'posthog', search: 'query' });
    const terms = (body.vocabulary as Array<{ term: string }>).map((v) => v.term);

    expect(body.matched).toBe(200);
    expect(body.returned).toBe(25);
    expect((body.tools as Json[])[0]).not.toHaveProperty('arguments');
    expect(terms).toContain('retention');
  });

  it('truncates a long description on a word boundary', async () => {
    connectedWith([tool('long', { description: `${'word '.repeat(300)}end` })]);
    const body = await parse({ kind: 'nodes', pluginId: 'posthog', search: 'long' });
    const description = String((body.tools as Json[])[0]?.description);
    expect(description.length).toBeLessThanOrEqual(163);
    expect(description.endsWith('…')).toBe(true);
  });

  it('does not spend the budget on a locally refused pluginId', async () => {
    // Nothing connected: every call is refused before the network branch.
    for (let i = 0; i < 20; i += 1) await parse({ kind: 'nodes', pluginId: 'posthog' });

    connectedWith([tool('a-one')]);
    const body = await parse({ kind: 'nodes', pluginId: 'posthog' });
    expect(body.toolCount).toBe(1);
    expect(listPluginServerTools).toHaveBeenCalledTimes(1);
  });

  it('budgets the network branch only', async () => {
    connectedWith([tool('a-one')]);
    for (let i = 0; i < 15; i += 1) {
      await parse({ kind: 'nodes', pluginId: 'posthog' });
      await parse({ kind: 'nodes' });
    }
    expect(expectMcpErrorText(await call({ kind: 'nodes', pluginId: 'posthog' }))).toContain(
      'Rate limit reached',
    );
    expect(listPluginServerTools).toHaveBeenCalledTimes(15);
    await parse({ kind: 'nodes' });
  });
});

describe('frink_flows_list_catalog descriptor', () => {
  const descriptorSchema = z.object({
    annotations: z.object({ readOnlyHint: z.boolean() }),
    inputSchema: z.object({
      properties: z.object({ kind: z.object({ enum: z.array(z.string()) }) }),
      required: z.array(z.string()),
      additionalProperties: z.boolean(),
    }),
  });

  it("advertises 'nodes' in both enums and stays a read-only tool", async () => {
    const { FLOWS_TOOLS } = await import('../index');
    // parse() is the assertion: a missing tool or a reshaped descriptor throws here.
    const descriptor = descriptorSchema.parse(
      FLOWS_TOOLS.find((entry) => entry.name === 'frink_flows_list_catalog'),
    );

    expect(descriptor.inputSchema.properties.kind.enum).toContain('nodes');
    expect(descriptor.inputSchema.required).toEqual(['kind']);
    expect(descriptor.inputSchema.additionalProperties).toBe(false);
    expect(descriptor.annotations.readOnlyHint).toBe(true);
    // The zod enum is a second declaration of the same contract.
    expect(expectMcpErrorText(await call({ kind: 'not-a-kind' }))).toContain('Invalid arguments:');
  });
});
