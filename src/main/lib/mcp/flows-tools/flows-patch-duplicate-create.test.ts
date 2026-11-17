/** frink_flows_patch × repeated create-by-name. Split from index.test.ts, whose size is capped. */
import { TRPCError } from '@trpc/server';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  FLOWS_TOOLS,
  handleFlowsToolCall,
  resetFlowsPatchCount,
  resetFlowsPatchCreateCount,
} from './index';
import { lookupCreatedFlowName } from './gating/patch-create-names';
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

const OPERATIONS = [
  { op: 'add_node' as const, node: { id: 'n1', blockType: 'manual_trigger' } },
  {
    op: 'add_node' as const,
    node: {
      id: 'nst',
      blockType: 'start_task',
      config: { projectId: '550e8400-e29b-41d4-a716-446655440010', label: 'Start' },
    },
  },
  {
    op: 'add_node' as const,
    node: { id: 'n2', blockType: 'agent', config: { instructions: 'do it' } },
  },
  { op: 'add_edge' as const, edge: { id: 'e0', source: 'n1', target: 'nst' } },
  { op: 'add_edge' as const, edge: { id: 'e1', source: 'nst', target: 'n2' } },
];

const EXEC = 'exec-duplicate-create';

async function createByName(
  name: string,
  executionId: string | undefined,
  operations = OPERATIONS,
) {
  return handleFlowsToolCall('frink_flows_patch', { name, operations }, executionId);
}

describe('handleFlowsToolCall — frink_flows_patch repeated create-by-name', () => {
  beforeEach(() => {
    resetFlowsPatchCount();
    resetFlowsPatchCreateCount();
    state.createFlow.mockImplementation(async ({ name }: { name: string }) => ({
      id: `flow-${state.createFlow.mock.calls.length}`,
      name,
    }));
    state.createFlowVersion.mockResolvedValue({ id: 'ver-1', version_number: 1 });
    state.getFlow.mockResolvedValue({ id: 'flow-1', name: 'Nightly', version_number: 1 });
    state.deleteFlow.mockResolvedValue(undefined);
  });

  afterEach(() => {
    vi.clearAllMocks();
  });

  it('rejects a resent create in the same chat without writing a second flow', async () => {
    await createByName('Nightly', EXEC);

    const retry = await createByName('Nightly', EXEC);

    expect(retry?.isError).toBe(true);
    expect(retry?.content[0]?.text).toContain('flow-1');
    expect(state.createFlow).toHaveBeenCalledTimes(1);
    expect(state.createFlowVersion).toHaveBeenCalledTimes(1);
  });

  it('keeps the name after a partial-success create, since that flow was saved', async () => {
    await createByName('Nightly', EXEC, [
      ...OPERATIONS,
      { op: 'update_node' as const, nodeId: 'missing', config: {} },
    ] as typeof OPERATIONS);

    const retry = await createByName('Nightly', EXEC);

    expect(retry?.isError).toBe(true);
    expect(state.createFlow).toHaveBeenCalledTimes(1);
  });

  it('allows the create again once the user has deleted the first flow', async () => {
    await createByName('Nightly', EXEC);
    state.getFlow.mockRejectedValueOnce(new TRPCError({ code: 'NOT_FOUND', message: 'gone' }));

    const retry = await createByName('Nightly', EXEC);

    expect(JSON.parse(expectMcpText(retry)).status).toBe('success');
    expect(state.createFlow).toHaveBeenCalledTimes(2);
  });

  it('frees the name when the first create was rolled back before saving', async () => {
    state.createFlowVersion.mockRejectedValueOnce(new Error('disk full'));
    await createByName('Nightly', EXEC);

    const retry = await createByName('Nightly', EXEC);

    expect(JSON.parse(expectMcpText(retry)).status).toBe('success');
    expect(state.createFlow).toHaveBeenCalledTimes(2);
  });

  it('refuses the retry without forgetting the first flow when the existence check fails', async () => {
    await createByName('Nightly', EXEC);
    state.getFlow.mockRejectedValueOnce(new Error('database is locked'));

    const failed = await createByName('Nightly', EXEC);
    const retry = await createByName('Nightly', EXEC);

    expect(failed?.isError).toBe(true);
    expect(retry?.content[0]?.text).toContain('flow-1');
    expect(state.createFlow).toHaveBeenCalledTimes(1);
  });

  it('frees the name when the create is refused by the per-session create limit', async () => {
    for (const name of ['A', 'B', 'C', 'D', 'E']) await createByName(name, EXEC);

    const limited = await createByName('Extra', EXEC);

    expect(limited?.content[0]?.text).toContain('Rate limit');
    expect(lookupCreatedFlowName(EXEC, 'Extra')).toBeUndefined();
  });

  it('forgets created names when the session is cleaned up', async () => {
    await createByName('Nightly', EXEC);

    resetFlowsPatchCreateCount(EXEC);
    await createByName('Nightly', EXEC);

    expect(state.createFlow).toHaveBeenCalledTimes(2);
  });

  it('does not share names across chats or guard calls without a chat id', async () => {
    await createByName('Nightly', EXEC);
    await createByName('Nightly', 'exec-other-chat');
    await createByName('Nightly', undefined);
    await createByName('Nightly', undefined);

    expect(state.createFlow).toHaveBeenCalledTimes(4);
  });

  it('tells the agent to check before retrying a cut-short result', async () => {
    const patchTool = FLOWS_TOOLS.find((tool) => tool.name === 'frink_flows_patch');

    expect(patchTool?.description).toContain('saved to <path>');
    expect(patchTool?.description).toContain('never resend a create');
  });
});
