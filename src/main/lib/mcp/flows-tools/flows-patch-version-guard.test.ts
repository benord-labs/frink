/** frink_flows_patch × stale reads (story 7866). Split from index.test.ts, whose size is capped. */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { FlowVersionConflictError } from '../../db/repos/flow-versions';
import { handleFlowsToolCall, resetFlowsPatchCount } from './index';
import { resetKnownFlowVersions } from './patch/version-guard';
import { expectMcpErrorText, expectMcpText } from './test-helpers';

const state = vi.hoisted(() => ({
  addStageRuns: vi.fn(),
  createFlow: vi.fn(),
  createFlowVersion: vi.fn(),
  defineFlowBatchStages: vi.fn(),
  deleteFlow: vi.fn(),
  listFlows: vi.fn(),
  getFlow: vi.fn(),
  getFlowRun: vi.fn(),
  getFlowVersionGraph: vi.fn(),
  listFlowRuns: vi.fn(),
  listBatchPlanTemplates: vi.fn(),
  listFlowBatchRuns: vi.fn(),
  listFlowBatchStages: vi.fn(),
  sendBatchMessage: vi.fn(),
  startFlowBatch: vi.fn(),
  startFlowRun: vi.fn(),
  discoverCustomNodes: vi.fn(() => ({ valid: [], manifestWarnings: [], errors: [] })),
  listPluginNodes: vi.fn(() => []),
  invalidateCustomNodesDiscoveryCache: vi.fn(),
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
  getFlowVersionGraph: state.getFlowVersionGraph,
  listFlowRuns: state.listFlowRuns,
  listBatchPlanTemplates: state.listBatchPlanTemplates,
  listFlowBatchRuns: state.listFlowBatchRuns,
  listFlowBatchStages: state.listFlowBatchStages,
  sendBatchMessage: state.sendBatchMessage,
  startFlowBatch: state.startFlowBatch,
  startFlowRun: state.startFlowRun,
}));
vi.mock('../../custom-nodes/discovery', () => ({
  discoverCustomNodes: state.discoverCustomNodes,
  invalidateCustomNodesDiscoveryCache: state.invalidateCustomNodesDiscoveryCache,
}));
// Bare on purpose: importOriginal() would load the real derivation graph (MCP-config read, Sentry).
// oxlint-disable-next-line anti-slop/no-module-mocking
vi.mock('../../integrations/plugin-node-derivation', () => ({
  listPluginNodes: state.listPluginNodes,
}));
vi.mock('../../custom-nodes/script-runner', () => ({ runCustomNodeScript: vi.fn() }));
vi.mock('../../db', () => ({ getDatabase: state.getDatabase }));
vi.mock('../../db/repos/projects', () => ({
  getProjectById: state.getProjectById,
  listProjects: state.listProjects,
}));
vi.mock('./resolve-creation-project', () => ({
  resolveCreationProject: vi.fn(async () => ({ projectId: null, outcome: 'none' })),
}));
vi.mock('../../commands', () => ({
  listCommands: state.listCommands,
  getCommandContent: state.getCommandContent,
}));

function graph(trackInstructions: string) {
  return {
    nodes: [
      { id: 'n1', blockType: 'manual_trigger' },
      {
        id: 'nst',
        blockType: 'start_task',
        config: { projectId: '550e8400-e29b-41d4-a716-446655440010', label: 'Start' },
      },
      { id: 'track', blockType: 'agent', config: { instructions: trackInstructions } },
      { id: 'other', blockType: 'agent', config: { instructions: 'other' } },
    ],
    edges: [
      { id: 'e0', source: 'n1', target: 'nst' },
      { id: 'e1', source: 'nst', target: 'track' },
      { id: 'e2', source: 'track', target: 'other' },
    ],
  };
}

const V65 = graph('v65 text');
const V66 = graph('v66 text from another session');
const CHAT_A = { sessionId: 'chat-a' };

function flowAt(version: number | null, flowGraph: unknown) {
  return { id: 'flow-1', name: 'Work', description: null, version_number: version, graph: flowGraph };
}

const editTrack = (expectedVersionNumber?: number | null) =>
  handleFlowsToolCall(
    'frink_flows_patch',
    {
      flowId: 'flow-1',
      ...(expectedVersionNumber !== undefined ? { expectedVersionNumber } : {}),
      operations: [{ op: 'update_node', nodeId: 'track', config: { instructions: 'mine' } }],
    },
    undefined,
    undefined,
    CHAT_A,
  );

/** The reported race: this chat reads v65, another session saves v66 before it patches. */
async function readThenRace() {
  state.getFlow.mockResolvedValueOnce(flowAt(65, V65));
  await handleFlowsToolCall('frink_flows_get', { flowId: 'flow-1' }, undefined, undefined, CHAT_A);
  state.getFlow.mockResolvedValue(flowAt(66, V66));
}

describe('frink_flows_patch — stale-read guard', () => {
  beforeEach(() => {
    state.getFlowVersionGraph.mockImplementation(async (_id: string, n: number) =>
      n === 65 ? V65 : null,
    );
    state.createFlowVersion.mockImplementation(
      async (_id: string, input: { expectedVersionNumber: number }) => ({
        id: 'ver',
        version_number: input.expectedVersionNumber + 1,
      }),
    );
  });

  afterEach(() => {
    vi.clearAllMocks();
    resetFlowsPatchCount();
    resetKnownFlowVersions();
  });

  it('rejects a stale expectedVersionNumber without saving', async () => {
    state.getFlow.mockResolvedValue(flowAt(66, V66));
    const body = JSON.parse(expectMcpErrorText(await editTrack(65)));
    expect(body).toMatchObject({
      status: 'failure',
      persistence: 'none',
      errorCode: 'FLOW_VERSION_CONFLICT',
      currentVersionNumber: 66,
      drift: { nodes: [{ id: 'track', change: 'changed', keys: ['config.instructions'] }] },
    });
    expect(state.createFlowVersion).not.toHaveBeenCalled();
  });

  it('saves when expectedVersionNumber matches, and accepts null for a flow with no version', async () => {
    state.getFlow.mockResolvedValue(flowAt(66, V66));
    expect(JSON.parse(expectMcpText(await editTrack(66))).versionNumber).toBe(67);

    state.getFlow.mockResolvedValue(flowAt(null, null));
    const created = await handleFlowsToolCall('frink_flows_patch', {
      flowId: 'flow-1',
      expectedVersionNumber: null,
      operations: [{ op: 'add_node', node: { id: 'n1', blockType: 'manual_trigger' } }],
    });
    expect(JSON.parse(expectMcpText(created)).status).toBe('success');
  });

  it('refuses expectedVersionNumber on a create before creating anything', async () => {
    const result = await handleFlowsToolCall('frink_flows_patch', {
      name: 'New',
      expectedVersionNumber: 1,
      operations: [{ op: 'add_node', node: { id: 'n1', blockType: 'manual_trigger' } }],
    });
    expect(expectMcpErrorText(result)).toContain('expectedVersionNumber applies only');
    expect(state.createFlow).not.toHaveBeenCalled();
  });

  it('rejects the reported race even when the caller omits expectedVersionNumber', async () => {
    await readThenRace();
    const body = JSON.parse(expectMcpErrorText(await editTrack()));
    expect(body).toMatchObject({ errorCode: 'FLOW_VERSION_CONFLICT', knownVersionNumber: 65 });
    expect(body.message).toContain('(track)');
    expect(state.createFlowVersion).not.toHaveBeenCalled();
  });

  it('keeps one chat’s stale view when a second chat reads the latest version', async () => {
    await readThenRace();
    await handleFlowsToolCall('frink_flows_get', { flowId: 'flow-1' }, undefined, undefined, {
      sessionId: 'chat-b',
    });
    const body = JSON.parse(expectMcpErrorText(await editTrack()));
    expect(body).toMatchObject({ errorCode: 'FLOW_VERSION_CONFLICT', knownVersionNumber: 65 });
  });

  it('keeps the other session’s change and saves when the patch edits a different node', async () => {
    await readThenRace();
    const result = await handleFlowsToolCall(
      'frink_flows_patch',
      {
        flowId: 'flow-1',
        operations: [{ op: 'update_node', nodeId: 'other', config: { instructions: 'mine' } }],
      },
      undefined,
      undefined,
      CHAT_A,
    );
    const body = JSON.parse(expectMcpText(result));
    expect(body.concurrentChanges).toMatchObject({ fromVersion: 65, toVersion: 66 });
    const saved = state.createFlowVersion.mock.calls[0]?.[1];
    expect(saved.graph.nodes.find((n: { id: string }) => n.id === 'track').config.instructions).toBe(
      'v66 text from another session',
    );
  });

  it('never treats a chat’s own chained patches as a conflict', async () => {
    state.getFlow.mockResolvedValueOnce(flowAt(65, V65));
    await handleFlowsToolCall('frink_flows_get', { flowId: 'flow-1' }, undefined, undefined, CHAT_A);
    state.getFlow.mockResolvedValueOnce(flowAt(65, V65));
    expectMcpText(await editTrack());
    state.getFlow.mockResolvedValueOnce(flowAt(66, V66));
    expectMcpText(await editTrack());
    expect(state.getFlowVersionGraph).not.toHaveBeenCalled();
  });

  it('saves both of one chat’s parallel patches instead of mistaking the first for another session', async () => {
    let latest = 65;
    state.getFlow.mockImplementation(async () => flowAt(latest, latest === 65 ? V65 : V66));
    state.getFlowVersionGraph.mockResolvedValue(V65);
    state.createFlowVersion.mockImplementation(
      async (_id: string, input: { expectedVersionNumber: number }) => {
        if (input.expectedVersionNumber !== latest) {
          throw new FlowVersionConflictError('flow-1', input.expectedVersionNumber, latest);
        }
        latest += 1;
        await new Promise((resolve) => setTimeout(resolve, 0));
        return { id: `ver-${latest}`, version_number: latest };
      },
    );
    await handleFlowsToolCall('frink_flows_get', { flowId: 'flow-1' }, undefined, undefined, CHAT_A);
    const results = await Promise.all([editTrack(), editTrack()]);
    expect(results.map((r) => JSON.parse(expectMcpText(r)).versionNumber)).toEqual([66, 67]);
  });

  it('does not track reads for a caller without a chat identity', async () => {
    state.getFlow.mockResolvedValueOnce(flowAt(65, V65));
    await handleFlowsToolCall('frink_flows_get', { flowId: 'flow-1' });
    state.getFlow.mockResolvedValue(flowAt(66, V66));
    expectMcpText(await editTrack());
  });

  it('does not spend the per-chat patch limit on rejected patches', async () => {
    state.getFlow.mockResolvedValue(flowAt(66, V66));
    for (let i = 0; i < 16; i += 1) expectMcpErrorText(await editTrack(65));
    expect(JSON.parse(expectMcpText(await editTrack(66))).status).toBe('success');
  });
});
