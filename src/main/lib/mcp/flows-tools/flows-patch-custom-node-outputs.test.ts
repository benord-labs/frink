/**
 * frink_flows_patch × custom node manifest outputs (sc-1501): the MCP call site must wire a
 * custom node's manifest-declared `outputs` into template-variable validation, not just fall
 * back to the generic [exitCode, _rawStdout] schema. Split from index.test.ts (size ratchet).
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { CustomNodeManifest } from '../../custom-nodes/discovery';
import type { PluginNodeManifest } from '../../integrations/plugin-node-derivation';
import { expectMcpText } from './test-helpers';

type DiscoveryResultShape = {
  valid: CustomNodeManifest[];
  manifestWarnings: unknown[];
  errors: unknown[];
};

/** Only `name` + `outputs` are read at the patch call site, so fixtures declare only those. */
type PluginNodeFixture = Pick<PluginNodeManifest, 'name' | 'outputs'>;

// ---------------------------------------------------------------------------
// Mocks — same surface as index.test.ts (this module's static import graph needs all of it)
// ---------------------------------------------------------------------------

const state = vi.hoisted(() => ({
  addStageRuns: vi.fn(),
  createFlow: vi.fn(),
  createFlowVersion: vi.fn(),
  defineFlowBatchStages: vi.fn(),
  deleteFlow: vi.fn(),
  listFlows: vi.fn(),
  getFlow: vi.fn(),
  getFlowRun: vi.fn(),
  listFlowRuns: vi.fn(),
  listFlowRunsForFlow: vi.fn(),
  listBatchPlanTemplates: vi.fn(),
  listFlowBatchRuns: vi.fn(),
  listFlowBatchStages: vi.fn(),
  sendBatchMessage: vi.fn(),
  startFlowBatch: vi.fn(),
  startFlowRun: vi.fn(),
  mkdir: vi.fn(),
  writeFile: vi.fn(),
  copyFile: vi.fn(),
  readFile: vi.fn(),
  rm: vi.fn(),
  rename: vi.fn(),
  stat: vi.fn(),
  discoverCustomNodes: vi.fn(
    (): DiscoveryResultShape => ({ valid: [], manifestWarnings: [], errors: [] }),
  ),
  listPluginNodes: vi.fn((): PluginNodeFixture[] => []),
  invalidateCustomNodesDiscoveryCache: vi.fn(),
  runCustomNodeScript: vi.fn(),
  getIntegrations: vi.fn(),
  getDatabase: vi.fn(),
  getProjectById: vi.fn(),
  listProjects: vi.fn(),
  listCommands: vi.fn(),
  getCommandContent: vi.fn(),
}));

vi.mock('electron-log', () => ({ default: { warn: vi.fn(), error: vi.fn() } }));
vi.mock('../../flows/mcp-cloud-shim', () => ({
  addStageRuns: state.addStageRuns,
  createFlow: state.createFlow,
  createFlowVersion: state.createFlowVersion,
  defineFlowBatchStages: state.defineFlowBatchStages,
  deleteFlow: state.deleteFlow,
  listFlows: state.listFlows,
  getFlow: state.getFlow,
  getFlowRun: state.getFlowRun,
  listFlowRuns: state.listFlowRuns,
  listFlowRunsForFlow: state.listFlowRunsForFlow,
  listBatchPlanTemplates: state.listBatchPlanTemplates,
  listFlowBatchRuns: state.listFlowBatchRuns,
  listFlowBatchStages: state.listFlowBatchStages,
  sendBatchMessage: state.sendBatchMessage,
  startFlowBatch: state.startFlowBatch,
  startFlowRun: state.startFlowRun,
}));
vi.mock('node:fs/promises', () => ({
  mkdir: state.mkdir,
  writeFile: state.writeFile,
  copyFile: state.copyFile,
  readFile: state.readFile,
  rm: state.rm,
  rename: state.rename,
  stat: state.stat,
}));
vi.mock('node:os', () => ({ homedir: () => '/home/testuser' }));
vi.mock('../../custom-nodes/discovery', () => ({
  discoverCustomNodes: state.discoverCustomNodes,
  invalidateCustomNodesDiscoveryCache: state.invalidateCustomNodesDiscoveryCache,
}));
// Bare on purpose: importOriginal() would load the real derivation graph (MCP-config read, Sentry).
// oxlint-disable-next-line anti-slop/no-module-mocking
vi.mock('../../integrations/plugin-node-derivation', () => ({
  listPluginNodes: state.listPluginNodes,
}));
vi.mock('../../custom-nodes/script-runner', () => ({
  runCustomNodeScript: state.runCustomNodeScript,
}));
vi.mock('../../cloud/integrations', () => ({
  getIntegrations: state.getIntegrations,
}));
vi.mock('../../db', () => ({ getDatabase: state.getDatabase }));
vi.mock('../../db/repos/projects', () => ({
  getProjectById: state.getProjectById,
  listProjects: state.listProjects,
}));
// Session-project resolution has its own unit tests; isolate this file from the
// claude-config import chain it pulls in.
vi.mock('./resolve-creation-project', () => ({
  resolveCreationProject: vi.fn(async ({ explicitProjectId }: { explicitProjectId?: string }) =>
    explicitProjectId
      ? { projectId: explicitProjectId, outcome: 'explicit' }
      : { projectId: null, outcome: 'none' },
  ),
}));
vi.mock('../../commands', () => ({
  listCommands: state.listCommands,
  getCommandContent: state.getCommandContent,
}));

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const VALID_GRAPH = {
  nodes: [
    { id: 'n1', blockType: 'manual_trigger' },
    {
      id: 'nst',
      blockType: 'start_task',
      config: { projectId: '550e8400-e29b-41d4-a716-446655440010', label: 'Start' },
    },
    { id: 'n2', blockType: 'agent', config: { instructions: 'do it' } },
  ],
  edges: [
    { id: 'e0', source: 'n1', target: 'nst' },
    { id: 'e1', source: 'nst', target: 'n2' },
  ],
};

/** Deferred import of `./index` (avoids mock hoisting issues; fresh module instance when tests need it). */
async function getModule() {
  return import('./index');
}

/** Fills in the boilerplate manifest fields; pass only what a given test cares about. */
function mockManifest(
  overrides: Partial<CustomNodeManifest> & { name: string },
): CustomNodeManifest {
  return {
    displayName: overrides.name,
    description: 'Test node',
    version: '1.0.0',
    entrypoint: 'index.js',
    timeout: 30000,
    inputs: {},
    credentials: {},
    nodePath: `/home/testuser/.frink/nodes/${overrides.name}`,
    ...overrides,
  };
}

/** The slice of a patch receipt these tests assert on. Warnings are objects, not strings. */
type PatchBody = {
  templateWarnings?: { placeholder: string; message: string }[];
  nodeVariables?: Record<string, { previous: { key: string }[] }>;
};

/** Runs frink_flows_patch and returns its parsed receipt (asserting a successful patch). */
async function patchAndGetBody(execId: string, operations: unknown[]): Promise<PatchBody> {
  const { handleFlowsToolCall, resetFlowsPatchCount } = await getModule();
  resetFlowsPatchCount(execId);
  const result = await handleFlowsToolCall(
    'frink_flows_patch',
    { flowId: 'flow-patch', operations },
    execId,
  );
  const body = JSON.parse(expectMcpText(result));
  expect(body.status).toBe('success');
  resetFlowsPatchCount(execId);
  return body;
}

/** Placeholders the patch receipt warned about, in receipt order. */
function warnedPlaceholders(body: PatchBody): string[] {
  return (body.templateWarnings ?? []).map((w) => w.placeholder);
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('handleFlowsToolCall — frink_flows_patch × custom node outputs', () => {
  afterEach(() => {
    vi.clearAllMocks();
  });

  beforeEach(() => {
    state.getFlow.mockResolvedValue({
      id: 'flow-patch',
      name: 'Patchable',
      description: null,
      version_number: 3,
      graph: VALID_GRAPH,
    });
    state.createFlowVersion.mockResolvedValue({ id: 'ver-patch' });
    state.listPluginNodes.mockReturnValue([]);
  });

  it('does not warn about {{previous.<field>}} declared in a custom node manifest (sc-1501)', async () => {
    state.discoverCustomNodes.mockReturnValue({
      valid: [
        mockManifest({
          name: 'pr-checker',
          outputs: { prCount: { type: 'number', description: 'Number of open PRs' } },
        }),
      ],
      manifestWarnings: [],
      errors: [],
    });
    const body = await patchAndGetBody('exec-patch-custom-node-outputs', [
      { op: 'add_node', node: { id: 'cn1', blockType: 'pr-checker', config: {} } },
      { op: 'add_edge', edge: { id: 'e2', source: 'n2', target: 'cn1' } },
      {
        op: 'add_node',
        node: { id: 'n3', blockType: 'agent', config: { instructions: '{{previous.prCount}}' } },
      },
      { op: 'add_edge', edge: { id: 'e3', source: 'cn1', target: 'n3' } },
    ]);
    expect(warnedPlaceholders(body)).not.toContain('{{previous.prCount}}');
  });

  it('a manifest with a declared-but-empty outputs object still falls back to the generic custom-node schema', async () => {
    // Boundary: {} (declared, zero fields) vs undefined (never declared) must behave
    // identically through the real handlePatch -> buildCustomNodeOutputsMap wiring —
    // both fall back to CUSTOM_NODE_FALLBACK_OUTPUT_SCHEMA, not an empty/strict schema.
    state.discoverCustomNodes.mockReturnValue({
      valid: [mockManifest({ name: 'empty-manifest-node', outputs: {} })],
      manifestWarnings: [],
      errors: [],
    });
    const body = await patchAndGetBody('exec-patch-empty-manifest-outputs', [
      { op: 'add_node', node: { id: 'cn2', blockType: 'empty-manifest-node', config: {} } },
      { op: 'add_edge', edge: { id: 'e4', source: 'n2', target: 'cn2' } },
      {
        op: 'add_node',
        node: { id: 'n4', blockType: 'agent', config: { instructions: '{{previous.exitCode}}' } },
      },
      { op: 'add_edge', edge: { id: 'e5', source: 'cn2', target: 'n4' } },
    ]);
    expect(warnedPlaceholders(body)).not.toContain('{{previous.exitCode}}');
  });

  it("reads a plugin node's catalog-declared outputs, not the generic fallback (sc-2508)", async () => {
    // Plugin nodes are derived, never in `valid`; reading only `valid` left them on
    // [exitCode, _rawStdout] and flagged their real fields as undeclared.
    state.listPluginNodes.mockReturnValue([
      {
        name: 'clickup_create_task',
        outputs: {
          ts: { type: 'string', description: 'Timestamp id of the posted message' },
          channel: { type: 'string', description: 'Channel the message landed in' },
        },
      },
    ]);
    const body = await patchAndGetBody('exec-patch-plugin-node-outputs', [
      { op: 'add_node', node: { id: 'cn3', blockType: 'clickup_create_task', config: {} } },
      { op: 'add_edge', edge: { id: 'e6', source: 'n2', target: 'cn3' } },
      {
        op: 'add_node',
        node: { id: 'n5', blockType: 'agent', config: { instructions: '{{previous.ts}}' } },
      },
      { op: 'add_edge', edge: { id: 'e7', source: 'cn3', target: 'n5' } },
    ]);
    expect(warnedPlaceholders(body)).not.toContain('{{previous.ts}}');
    // The receipt no longer echoes nodeVariables (sc-2667); the merge is proven by the
    // declared field passing here and the fallback field warning in the next case.
  });

  it('warns on {{previous.exitCode}} after a plugin node — its declared outputs replace the fallback (sc-2508)', async () => {
    // Deliberate: plugin dispatch returns the provider response, never exitCode/_rawStdout, so
    // this reference never resolved. Once the catalog schema is read, the validator says so.
    state.listPluginNodes.mockReturnValue([
      { name: 'clickup_create_task', outputs: { ts: { type: 'string', description: 'Message id' } } },
    ]);
    const body = await patchAndGetBody('exec-patch-plugin-node-exit-code', [
      { op: 'add_node', node: { id: 'cn4', blockType: 'clickup_create_task', config: {} } },
      { op: 'add_edge', edge: { id: 'e8', source: 'n2', target: 'cn4' } },
      {
        op: 'add_node',
        node: { id: 'n6', blockType: 'agent', config: { instructions: '{{previous.exitCode}}' } },
      },
      { op: 'add_edge', edge: { id: 'e9', source: 'cn4', target: 'n6' } },
    ]);
    const warning = (body.templateWarnings ?? []).find(
      (w) => w.placeholder === '{{previous.exitCode}}',
    );
    expect(warning).toBeDefined();
    expect(warning?.message).toContain('plugin catalog');
    expect(warning?.message).not.toContain('frink_register_node');
  });

  it('a script node and a plugin node in one graph each resolve from their own list (sc-2508)', async () => {
    // The two node kinds come from separate readers — disk discovery and catalog derivation. Every
    // other test populates one and leaves the other empty, so this proves the merge, not a swap.
    state.discoverCustomNodes.mockReturnValue({
      valid: [
        mockManifest({
          name: 'pr-checker',
          outputs: { prCount: { type: 'number', description: 'Number of open PRs' } },
        }),
      ],
      manifestWarnings: [],
      errors: [],
    });
    state.listPluginNodes.mockReturnValue([
      { name: 'clickup_create_task', outputs: { ts: { type: 'string', description: 'Msg id' } } },
    ]);
    const body = await patchAndGetBody('exec-patch-mixed-node-kinds', [
      { op: 'add_node', node: { id: 'cn5', blockType: 'pr-checker', config: {} } },
      { op: 'add_edge', edge: { id: 'e10', source: 'n2', target: 'cn5' } },
      {
        op: 'add_node',
        node: { id: 'n7', blockType: 'agent', config: { instructions: '{{previous.prCount}}' } },
      },
      { op: 'add_edge', edge: { id: 'e11', source: 'cn5', target: 'n7' } },
      { op: 'add_node', node: { id: 'cn6', blockType: 'clickup_create_task', config: {} } },
      { op: 'add_edge', edge: { id: 'e12', source: 'n7', target: 'cn6' } },
      {
        op: 'add_node',
        node: { id: 'n8', blockType: 'agent', config: { instructions: '{{previous.ts}}' } },
      },
      { op: 'add_edge', edge: { id: 'e13', source: 'cn6', target: 'n8' } },
    ]);
    expect(warnedPlaceholders(body)).not.toContain('{{previous.prCount}}');
    expect(warnedPlaceholders(body)).not.toContain('{{previous.ts}}');
  });
});
