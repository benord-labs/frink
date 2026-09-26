/** The `json` input path of dispatchPluginNode: render JSON-aware, parse, omit blank, fail closed on bad JSON. */
// oxlint-disable anti-slop/no-module-mocking -- the dispatcher's db, cloud and MCP edges are stubbed exactly as index.test.ts stubs them
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { TestDb } from '../../../db/test-utils/fresh-db';
import type { McpToolCallResult } from '../../../mcp/tools-probe/call';
import type { FrinkMcpCredentials, FrinkMcpServerConfig } from '../../../mcp/types';

type ServerFixture = Partial<Pick<FrinkMcpServerConfig, 'url' | 'managedBy'>>;
type DbSlot = { current: TestDb | null };

const state = vi.hoisted(() => {
  const db: DbSlot = { current: null };
  const servers: Record<string, ServerFixture> = {};
  const callResult: McpToolCallResult = { ok: true, result: { content: [] } };
  return { db, servers, callResult };
});

vi.mock('../../../cloud-client', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../../cloud-client')>()),
  getIntegrations: vi.fn(async () => []),
}));
vi.mock('../../../mcp', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../../mcp')>()),
  getGlobalMcpServers: vi.fn(async () => state.servers),
  getMcpCredentials: vi.fn(async (): Promise<FrinkMcpCredentials> => ({
    headers: { Authorization: 'Bearer t' },
  })),
}));
vi.mock('../../../mcp/tools-probe/call', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../../mcp/tools-probe/call')>()),
  callMcpTool: vi.fn(async () => state.callResult),
}));
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
vi.mock('../../../db', () => ({ getDatabase: () => testDb() }));
vi.mock('../../../db/repos/plugin-installations', () => ({
  getByPluginId: vi.fn(async () => ({ isInstalled: true, isEnabled: true })),
}));

import { upsertPluginNodeSchema } from '../../../db/repos/plugin-node-schemas';
import { freshDb } from '../../../db/test-utils/fresh-db';
import { callMcpTool } from '../../../mcp/tools-probe/call';
import { dispatchPluginNode } from './index';

type Ctx = Parameters<typeof dispatchPluginNode>[0];

function testDb(): TestDb {
  const db = state.db.current;
  if (!db) throw new Error('no test database — resetSchemaCache() runs first');
  return db;
}

/** An empty probed-schema cache; the generic call-tool node carries its own fields and needs no row. */
function resetSchemaCache(): void {
  state.db.current = freshDb();
}

function ctxFor(
  config: Ctx['node']['config'],
  triggerContext: Ctx['triggerContext'] = null,
  blockType = 'posthog_list_errors',
) {
  // SAFETY: the plugin-node dispatcher reads only these fields; run ids and the parsed graph are unused.
  return {
    node: { id: 'n1', blockType, config },
    triggerContext,
    previousOutput: undefined,
    loopContext: undefined,
  } as Ctx;
}

const sentArgs = () => vi.mocked(callMcpTool).mock.calls.map(([, , toolArgs]) => toolArgs);

describe('dispatchPluginNode json inputs', () => {
  beforeEach(() => {
    vi.mocked(callMcpTool).mockClear();
    state.servers = {
      plugin_posthog_posthog: { url: 'https://mcp.posthog.com/mcp', managedBy: 'vendor_plugin' },
    };
    resetSchemaCache();
    upsertPluginNodeSchema(testDb(), {
      pluginId: 'posthog',
      actionId: 'posthog.list_errors',
      inputs: { status: { type: 'string' }, dateRange: { type: 'json' } },
      unsupportedFields: [],
    });
  });

  it('renders templates JSON-aware, parses the field, and omits a blank one', async () => {
    await dispatchPluginNode(
      ctxFor(
        {
          status: 'active',
          dateRange: '{"label": "{{trigger.text}}", "range": {{trigger.range}}}',
        },
        { text: 'say "hi"', range: { from: '-7d' } },
      ),
    );
    await dispatchPluginNode(ctxFor({ status: 'active', dateRange: '  ' }));

    expect(sentArgs()).toEqual([
      { status: 'active', dateRange: { label: 'say "hi"', range: { from: '-7d' } } },
      { status: 'active' },
    ]);
  });

  it('renders templates inside a field authored as a structure: a whole placeholder keeps its type', async () => {
    await dispatchPluginNode(
      ctxFor(
        { dateRange: { from: '-1d', label: 'since {{trigger.text}}', range: '{{trigger.range}}' } },
        { text: 'x', range: { from: '-7d' } },
      ),
    );
    expect(sentArgs()).toEqual([
      { dateRange: { from: '-1d', label: 'since x', range: { from: '-7d' } } },
    ]);
  });

  it('fails the node before any call when the field does not parse, naming it', async () => {
    const result = await dispatchPluginNode(ctxFor({ dateRange: '{"from": {{trigger.missing}}}' }));

    expect(result).toEqual({
      type: 'error',
      message: 'posthog_list_errors input "dateRange": not valid JSON.',
    });
    expect(sentArgs()).toEqual([]);
  });
});

describe('dispatchPluginNode generic call-tool node', () => {
  const call = (config: Ctx['node']['config'], triggerContext: Ctx['triggerContext'] = null) =>
    dispatchPluginNode(ctxFor(config, triggerContext, 'posthog_call_tool'));
  const sentTools = () => vi.mocked(callMcpTool).mock.calls.map(([, toolName]) => toolName);

  beforeEach(() => {
    vi.mocked(callMcpTool).mockClear();
    state.servers = {
      plugin_posthog_posthog: { url: 'https://mcp.posthog.com/mcp', managedBy: 'vendor_plugin' },
    };
    resetSchemaCache();
  });

  it('calls the tool named in config with manual-mode arguments, templates rendered by type', async () => {
    await call(
      {
        tool: 'error-tracking-list',
        arguments: { limit: '{{trigger.limit}}', q: '{{trigger.q}}!' },
      },
      { limit: 5, q: 'crash' },
    );
    expect(sentTools()).toEqual(['error-tracking-list']);
    expect(sentArgs()).toEqual([{ limit: 5, q: 'crash!' }]);
  });

  it('accepts arguments authored as JSON text and sends an empty object when none are given', async () => {
    await call(
      { tool: 'feature-flag-get-all', arguments: '{"search": "{{trigger.q}}"}' },
      { q: 'x' },
    );
    await call({ tool: 'feature-flag-get-all' });
    expect(sentArgs()).toEqual([{ search: 'x' }, {}]);
  });

  it('fails before any call when arguments are not an object', async () => {
    const result = await call({ tool: 'feature-flag-get-all', arguments: '[1, 2]' });
    expect(result).toMatchObject({
      type: 'completed',
      output: {
        status: 'failed',
        error: {
          message: 'posthog_call_tool: "arguments" must be a JSON object.',
          retryable: false,
        },
      },
    });
    expect(sentArgs()).toEqual([]);
  });

  it('hands the next step the tool text and the envelope, and fails the step on a tool-level error', async () => {
    state.callResult = {
      ok: true,
      result: {
        content: [
          { type: 'text', text: 'flag-a: on' },
          { type: 'image', data: '', mimeType: 'image/png' },
          { type: 'text', text: 'flag-b: off' },
        ],
        structuredContent: { flags: 2 },
      },
    };
    const ok = await call({ tool: 'feature-flag-get-all' });
    expect(ok).toMatchObject({
      type: 'completed',
      output: {
        status: 'completed',
        outputs: { text: 'flag-a: on\nflag-b: off', structured: { flags: 2 } },
      },
    });

    state.callResult = {
      ok: true,
      result: { content: [{ type: 'text', text: 'Tool nope not found' }], isError: true },
    };
    const refused = await call({ tool: 'nope' });
    expect(refused).toMatchObject({
      type: 'completed',
      output: {
        status: 'failed',
        error: { message: 'posthog_call_tool: Tool nope not found', retryable: false },
      },
    });
    state.callResult = { ok: true, result: { content: [] } };
  });

  it('fails before any call when no tool is picked, naming the field', async () => {
    const result = await call({ arguments: { limit: 1 } });
    expect(result).toEqual({
      type: 'error',
      message: 'posthog_call_tool is missing required input: "tool"',
    });
    expect(sentArgs()).toEqual([]);
  });
});
