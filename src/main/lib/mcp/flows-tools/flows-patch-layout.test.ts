/** frink_flows_patch × canvas layout. Split from index.test.ts, whose size is capped. */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { expectMcpText } from './test-helpers';

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
  discoverCustomNodes: vi.fn(() => ({ valid: [], manifestWarnings: [], errors: [] })),
  listPluginNodes: vi.fn(() => []),
  invalidateCustomNodesDiscoveryCache: vi.fn(),
  runCustomNodeScript: vi.fn(),
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

describe('handleFlowsToolCall — frink_flows_patch canvas layout', () => {
  beforeEach(() => {
    state.getFlow.mockResolvedValue({
      id: 'flow-patch',
      name: 'Patchable',
      description: null,
      version_number: 3,
      graph: VALID_GRAPH,
    });
    state.createFlowVersion.mockResolvedValue({ id: 'ver-patch' });
  });

  afterEach(() => {
    vi.clearAllMocks();
  });

  it('auto_layout persists a position for every node and reports the layout', async () => {
    const { handleFlowsToolCall } = await getModule();
    const result = await handleFlowsToolCall('frink_flows_patch', {
      flowId: 'flow-patch',
      operations: [{ op: 'auto_layout' }],
    });
    const saved = state.createFlowVersion.mock.calls[0]?.[1] as {
      graph: { nodes: Array<{ position?: unknown }> };
    };
    expect(saved.graph.nodes.every((node) => node.position !== undefined)).toBe(true);
    const body = JSON.parse(expectMcpText(result));
    expect(body.status).toBe('success');
    expect(body.layout).toMatchObject({ overlaps: { count: 0 }, upwardEdges: { count: 0 } });
  });

  it('reports layout when a patch moves a node, not when it only edits config', async () => {
    const { handleFlowsToolCall } = await getModule();
    const configOnly = await handleFlowsToolCall('frink_flows_patch', {
      flowId: 'flow-patch',
      operations: [{ op: 'update_node', nodeId: 'n2', config: { instructions: 'patched' } }],
    });
    expect(JSON.parse(expectMcpText(configOnly)).layout).toBeUndefined();

    const moved = await handleFlowsToolCall('frink_flows_patch', {
      flowId: 'flow-patch',
      operations: [{ op: 'update_node', nodeId: 'n2', position: { x: 0, y: 900 } }],
    });
    expect(JSON.parse(expectMcpText(moved)).layout).toBeDefined();
  });
});
