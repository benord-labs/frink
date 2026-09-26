/* eslint-disable max-lines */
import { TRPCError } from '@trpc/server';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { FlowVersionConflictError } from '../../db/repos/flow-versions';
import { invocableFlowFixture } from './flow-run-test-fixtures';
import { expectMcpText, type McpToolResultLike } from './test-helpers';

const notFound = (message = 'Not found') => new TRPCError({ code: 'NOT_FOUND', message });

// ---------------------------------------------------------------------------
// Mocks
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
  // valid is typed: bare [] infers never[], rejecting every mocked manifest.
  discoverCustomNodes: vi.fn(() => ({ valid: [] as unknown[], manifestWarnings: [], errors: [] })),
  invalidateCustomNodesDiscoveryCache: vi.fn(),
  resolveCustomNodeEntrypoint: vi.fn(),
  runCustomNodeScript: vi.fn(),
  localIntegrationRows: vi.fn(),
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
}));
vi.mock('node:os', () => ({ homedir: () => '/home/testuser' }));
vi.mock('../../custom-nodes/discovery', () => ({
  discoverCustomNodes: state.discoverCustomNodes,
  invalidateCustomNodesDiscoveryCache: state.invalidateCustomNodesDiscoveryCache,
}));
vi.mock('../../custom-nodes/runtime', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../custom-nodes/runtime')>();
  return {
    ...actual,
    resolveCustomNodeEntrypoint: (...args: unknown[]) => state.resolveCustomNodeEntrypoint(...args),
  };
});
vi.mock('../../custom-nodes/script-runner', () => ({
  runCustomNodeScript: state.runCustomNodeScript,
}));
// Integration nodes are derived from live connection state; no plugin is connected in these tests.
vi.mock('../../integrations/plugin-node-derivation', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../integrations/plugin-node-derivation')>()),
  listPluginNodes: () => [],
}));
vi.mock('../../webhooks/local-endpoints', () => ({
  localIntegrationRows: state.localIntegrationRows,
}));
vi.mock('../../db', () => ({ getDatabase: state.getDatabase }));
vi.mock('../../db/repos/projects', () => ({
  getProjectById: state.getProjectById,
  listProjects: state.listProjects,
}));
// Session-project resolution has its own unit tests; isolate index.test.ts from the
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

/** Patch operations that build a save-valid minimal graph from an empty base (matches VALID_GRAPH topology). */
const OPERATIONS_BUILD_MIN_VALID = [
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

/** Deferred import of `./index` (avoids mock hoisting issues; fresh module instance when tests need it). */
async function getModule() {
  return import('./index');
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('flows-tools', () => {
  afterEach(() => {
    vi.clearAllMocks();
  });

  // -------------------------------------------------------------------------
  // frink_flows_patch
  // -------------------------------------------------------------------------

  describe('handleFlowsToolCall — frink_flows_patch', () => {
    const existingWithGraph = {
      id: 'flow-patch',
      name: 'Patchable',
      description: null,
      version_number: 3,
      graph: VALID_GRAPH,
    };

    beforeEach(() => {
      state.getFlow.mockResolvedValue(existingWithGraph);
      state.createFlowVersion.mockResolvedValue({ id: 'ver-patch' });
    });

    it('applies update_node and saves new version', async () => {
      const { handleFlowsToolCall } = await getModule();
      const result = await handleFlowsToolCall('frink_flows_patch', {
        flowId: 'flow-patch',
        operations: [{ op: 'update_node', nodeId: 'n2', config: { instructions: 'patched' } }],
      });
      expect(state.createFlow).not.toHaveBeenCalled();
      expect(state.getFlow).toHaveBeenCalledWith('flow-patch');
      expect(state.createFlowVersion).toHaveBeenCalledWith('flow-patch', {
        graph: expect.objectContaining({
          nodes: expect.arrayContaining([
            expect.objectContaining({
              id: 'n2',
              config: expect.objectContaining({ instructions: 'patched' }),
            }),
          ]),
        }),
        expectedVersionNumber: 3,
      });
      const body = JSON.parse(expectMcpText(result));
      expect(body.status).toBe('success');
      expect(body.graph.nodes.find((n: { id: string }) => n.id === 'n2').config.instructions).toBe(
        'patched',
      );
    });

    it('accepts flow with null graph (starts from empty)', async () => {
      const { handleFlowsToolCall } = await getModule();
      state.getFlow.mockResolvedValue({ ...existingWithGraph, graph: null, version_number: null });
      state.createFlowVersion.mockResolvedValue({
        id: 'new-ver',
        flow_id: 'flow-patch',
        version_number: 1,
      });
      const result = await handleFlowsToolCall('frink_flows_patch', {
        flowId: 'flow-patch',
        operations: [{ op: 'add_node', node: { id: 't1', blockType: 'manual_trigger' } }],
      });
      // Null graph now starts from empty -- patch should succeed
      expect(result?.isError).toBe(false);
      expect(state.createFlowVersion).toHaveBeenCalled();
    });

    it('seeds the null-graph fallback from the flow project (UI-created flow patched before first save)', async () => {
      const { handleFlowsToolCall } = await getModule();
      state.getFlow.mockResolvedValue({
        ...existingWithGraph,
        graph: null,
        version_number: null,
        project_id: '550e8400-e29b-41d4-a716-446655440020',
      });
      state.createFlowVersion.mockResolvedValue({
        id: 'new-ver-seeded',
        flow_id: 'flow-patch',
        version_number: 1,
      });
      await handleFlowsToolCall('frink_flows_patch', {
        flowId: 'flow-patch',
        operations: [{ op: 'add_node', node: { id: 't1', blockType: 'manual_trigger' } }],
      });
      expect(state.createFlowVersion).toHaveBeenCalledWith('flow-patch', {
        graph: expect.objectContaining({
          settings: expect.objectContaining({
            defaultProjectId: '550e8400-e29b-41d4-a716-446655440020',
          }),
        }),
        expectedVersionNumber: 0,
      });
    });

    it('returns 404 when getFlow fails', async () => {
      const { handleFlowsToolCall } = await getModule();
      state.getFlow.mockRejectedValue(notFound());
      const result = await handleFlowsToolCall('frink_flows_patch', {
        flowId: 'missing',
        operations: [{ op: 'update_node', nodeId: 'n2', config: {} }],
      });
      expect(result?.isError).toBe(true);
      expect(result?.content[0].text).toContain('Flow not found');
      expect(state.createFlowVersion).not.toHaveBeenCalled();
    });

    it('rejects empty operations array', async () => {
      const { handleFlowsToolCall } = await getModule();
      const result = await handleFlowsToolCall('frink_flows_patch', {
        flowId: 'flow-patch',
        operations: [],
      });
      expect(result?.isError).toBe(true);
      expect(result?.content[0].text).toContain('at least one');
    });

    it('rejects more than 50 operations', async () => {
      const { handleFlowsToolCall } = await getModule();
      const operations = Array.from({ length: 51 }, (_, i) => ({
        op: 'update_node' as const,
        nodeId: 'n2',
        config: { _touch: i },
      }));
      const result = await handleFlowsToolCall('frink_flows_patch', {
        flowId: 'flow-patch',
        operations,
      });
      expect(result?.isError).toBe(true);
      expect(result?.content[0].text).toContain('50');
    });

    it('surfaces per-operation error without calling createFlowVersion', async () => {
      const { handleFlowsToolCall } = await getModule();
      const result = await handleFlowsToolCall('frink_flows_patch', {
        flowId: 'flow-patch',
        operations: [{ op: 'update_node', nodeId: 'nonexistent', config: {} }],
      });
      expect(result?.isError).toBe(true);
      expect(result?.content[0].text).toContain('Operation 1');
      expect(result?.content[0].text).toContain('not found');
      expect(state.createFlowVersion).not.toHaveBeenCalled();
    });

    it('does not save when save-mode validation fails after ops apply (illegal cycle)', async () => {
      const { handleFlowsToolCall } = await getModule();
      const result = await handleFlowsToolCall('frink_flows_patch', {
        flowId: 'flow-patch',
        operations: [{ op: 'add_edge', edge: { id: 'e-cycle', source: 'n2', target: 'n1' } }],
      });
      expect(result?.isError).toBe(true);
      const text = result?.content[0].text ?? '';
      expect(text).toMatch(/Graph validation failed/i);
      expect(text).toMatch(/cycle/i);
      expect(state.createFlowVersion).not.toHaveBeenCalled();
    });

    it('surfaces 409 conflict', async () => {
      const { handleFlowsToolCall } = await getModule();
      state.createFlowVersion.mockRejectedValue(new FlowVersionConflictError('flow-patch', 3, 9));
      const result = await handleFlowsToolCall('frink_flows_patch', {
        flowId: 'flow-patch',
        operations: [{ op: 'update_node', nodeId: 'n2', config: { instructions: 'x' } }],
      });
      expect(result?.isError).toBe(true);
      expect(result?.content[0].text).toContain('conflict');
      expect(result?.content[0].text).toContain('9');
    });

    it('patch warns when run_command wraps an auto-quoted template value in shell quotes', async () => {
      const { handleFlowsToolCall, resetFlowsPatchCount } = await getModule();
      const execId = 'exec-patch-template';
      resetFlowsPatchCount(execId);
      const operations = JSON.parse(
        `[{"op":"add_node","node":{"id":"n3","blockType":"run_command","config":{"command":"echo '{{trigger.summary}}'"}}},{"op":"add_edge","edge":{"id":"e2","source":"n2","target":"n3"}}]`,
      );
      const result = await handleFlowsToolCall(
        'frink_flows_patch',
        { flowId: 'flow-patch', operations },
        execId,
      );
      const body = JSON.parse(expectMcpText(result));
      expect(body.templateWarnings).toMatchObject([
        {
          nodeId: 'n3',
          placeholder: '{{trigger.summary}}',
          message: expect.stringContaining('executable shell syntax'),
        },
      ]);
      resetFlowsPatchCount(execId);
    });

    it('patch success response omits templateWarnings when graph is clean', async () => {
      const { handleFlowsToolCall, resetFlowsPatchCount } = await getModule();
      const execId = 'exec-patch-clean';
      resetFlowsPatchCount(execId);
      const result = await handleFlowsToolCall(
        'frink_flows_patch',
        {
          flowId: 'flow-patch',
          operations: [{ op: 'update_node', nodeId: 'n2', config: { instructions: 'clean' } }],
        },
        execId,
      );
      const body = JSON.parse(expectMcpText(result));
      expect(body.status).toBe('success');
      expect(body.templateWarnings).toBeUndefined();
      resetFlowsPatchCount(execId);
    });

    it('rate limits after 15 successful patches per execution session', async () => {
      const { handleFlowsToolCall, resetFlowsPatchCount } = await getModule();
      const execId = 'exec-patch-rate';
      resetFlowsPatchCount(execId);
      state.createFlowVersion.mockResolvedValue({ id: 'ver-patch' });
      for (let i = 0; i < 15; i++) {
        const r = await handleFlowsToolCall(
          'frink_flows_patch',
          {
            flowId: 'flow-patch',
            operations: [{ op: 'update_node', nodeId: 'n2', config: { instructions: `v${i}` } }],
          },
          execId,
        );
        expect(r?.isError).toBe(false);
      }
      const blocked = await handleFlowsToolCall(
        'frink_flows_patch',
        {
          flowId: 'flow-patch',
          operations: [{ op: 'update_node', nodeId: 'n2', config: { instructions: 'too-many' } }],
        },
        execId,
      );
      expect(blocked?.isError).toBe(true);
      expect(blocked?.content[0].text).toContain('15');
      expect(blocked?.content[0].text).toContain('Rate limit');
      resetFlowsPatchCount(execId);
    });
  });

  // -------------------------------------------------------------------------
  // frink_flows_patch — auto-create (name without flowId)
  // -------------------------------------------------------------------------

  describe('handleFlowsToolCall — frink_flows_patch auto-create', () => {
    it('creates a flow when name is provided and saves version 0 → 1', async () => {
      const { handleFlowsToolCall, resetFlowsPatchCount, resetFlowsPatchCreateCount } =
        await getModule();
      const execId = 'exec-patch-autocreate-ok';
      resetFlowsPatchCount(execId);
      resetFlowsPatchCreateCount(execId);

      state.createFlow.mockResolvedValue({ id: 'auto-new-flow', name: 'New From Patch' });
      state.createFlowVersion.mockResolvedValue({
        id: 'ver-ac1',
        flow_id: 'auto-new-flow',
        version_number: 1,
      });

      const result = await handleFlowsToolCall(
        'frink_flows_patch',
        { name: 'New From Patch', operations: OPERATIONS_BUILD_MIN_VALID },
        execId,
      );

      expect(state.getFlow).not.toHaveBeenCalled();
      expect(state.createFlow).toHaveBeenCalledWith(
        expect.objectContaining({ name: 'New From Patch' }),
      );
      expect(state.createFlowVersion).toHaveBeenCalledWith('auto-new-flow', {
        graph: expect.objectContaining({
          nodes: expect.arrayContaining([
            expect.objectContaining({ id: 'n2', blockType: 'agent' }),
          ]),
        }),
        expectedVersionNumber: 0,
      });
      const body = JSON.parse(expectMcpText(result));
      expect(body.status).toBe('success');
      expect(body.flowId).toBe('auto-new-flow');
      resetFlowsPatchCount(execId);
      resetFlowsPatchCreateCount(execId);
    });

    /** Auto-create a flow via frink_flows_patch with fresh rate-limit slots; returns parsed body. */
    async function autoCreateFlow(
      execId: string,
      flowId: string,
      args: { name: string; projectId?: string },
    ) {
      const { handleFlowsToolCall, resetFlowsPatchCount, resetFlowsPatchCreateCount } =
        await getModule();
      resetFlowsPatchCount(execId);
      resetFlowsPatchCreateCount(execId);
      state.createFlow.mockResolvedValue({ id: flowId, name: args.name });
      state.createFlowVersion.mockResolvedValue({
        id: `ver-${flowId}`,
        flow_id: flowId,
        version_number: 1,
      });
      const result = await handleFlowsToolCall(
        'frink_flows_patch',
        { ...args, operations: OPERATIONS_BUILD_MIN_VALID },
        execId,
      );
      resetFlowsPatchCount(execId);
      resetFlowsPatchCreateCount(execId);
      return JSON.parse(expectMcpText(result));
    }

    it('seeds settings.defaultProjectId from the creation projectId and states it in the message', async () => {
      const pid = '550e8400-e29b-41d4-a716-446655440010';
      const body = await autoCreateFlow('exec-patch-autocreate-seed', 'auto-seeded', {
        name: 'Seeded',
        projectId: pid,
      });
      expect(body.status).toBe('success');
      expect(state.createFlow).toHaveBeenCalledWith(expect.objectContaining({ projectId: pid }));
      expect(state.createFlowVersion).toHaveBeenCalledWith('auto-seeded', {
        graph: expect.objectContaining({
          settings: expect.objectContaining({ defaultProjectId: pid }),
        }),
        expectedVersionNumber: 0,
      });
    });

    it('states the no-project outcome when created without a resolvable project', async () => {
      const body = await autoCreateFlow('exec-patch-autocreate-noproj', 'auto-noproj', {
        name: 'NoProj',
      });
      expect(body.message).toContain('without a project');
      expect(state.createFlowVersion).toHaveBeenCalledWith('auto-noproj', {
        graph: expect.not.objectContaining({ settings: expect.anything() }),
        expectedVersionNumber: 0,
      });
    });

    it('rolls back auto-created flow when createFlowVersion fails', async () => {
      const { handleFlowsToolCall, resetFlowsPatchCount, resetFlowsPatchCreateCount } =
        await getModule();
      const execId = 'exec-patch-ac-rollback';
      resetFlowsPatchCount(execId);
      resetFlowsPatchCreateCount(execId);

      state.createFlow.mockResolvedValue({ id: 'ac-rollback', name: 'R' });
      state.createFlowVersion.mockRejectedValue(new Error('save failed'));
      state.deleteFlow.mockResolvedValue(undefined);

      const result = await handleFlowsToolCall(
        'frink_flows_patch',
        { name: 'R', operations: OPERATIONS_BUILD_MIN_VALID },
        execId,
      );

      expect(result?.isError).toBe(true);
      expect(result?.content[0].text).toContain('save failed');
      expect(state.deleteFlow).toHaveBeenCalledWith('ac-rollback');
      resetFlowsPatchCount(execId);
      resetFlowsPatchCreateCount(execId);
    });

    it('rolls back auto-created flow when patch operations fail before save', async () => {
      const { handleFlowsToolCall, resetFlowsPatchCount, resetFlowsPatchCreateCount } =
        await getModule();
      const execId = 'exec-patch-ac-bad-op';
      resetFlowsPatchCount(execId);
      resetFlowsPatchCreateCount(execId);

      state.createFlow.mockResolvedValue({ id: 'ac-bad-op', name: 'Bad' });
      state.deleteFlow.mockResolvedValue(undefined);

      const result = await handleFlowsToolCall(
        'frink_flows_patch',
        {
          name: 'Bad',
          operations: [{ op: 'update_node', nodeId: 'missing', config: {} }],
        },
        execId,
      );

      expect(result?.isError).toBe(true);
      expect(state.createFlowVersion).not.toHaveBeenCalled();
      expect(state.deleteFlow).toHaveBeenCalledWith('ac-bad-op');
      resetFlowsPatchCount(execId);
      resetFlowsPatchCreateCount(execId);
    });

    it('rolls back auto-created flow on 409 from createFlowVersion', async () => {
      const { handleFlowsToolCall, resetFlowsPatchCount, resetFlowsPatchCreateCount } =
        await getModule();
      const execId = 'exec-patch-ac-409';
      resetFlowsPatchCount(execId);
      resetFlowsPatchCreateCount(execId);

      state.createFlow.mockResolvedValue({ id: 'ac-409', name: 'X' });
      state.createFlowVersion.mockRejectedValue(new FlowVersionConflictError('ac-409', 0, 2));
      state.deleteFlow.mockResolvedValue(undefined);

      const result = await handleFlowsToolCall(
        'frink_flows_patch',
        { name: 'X', operations: OPERATIONS_BUILD_MIN_VALID },
        execId,
      );

      expect(result?.isError).toBe(true);
      expect(result?.content[0].text).toContain('conflict');
      expect(state.deleteFlow).toHaveBeenCalledWith('ac-409');
      resetFlowsPatchCount(execId);
      resetFlowsPatchCreateCount(execId);
    });

    it('allows at most 5 name-based flow creations per session then blocks', async () => {
      const { handleFlowsToolCall, resetFlowsPatchCount, resetFlowsPatchCreateCount } =
        await getModule();
      const execId = 'exec-patch-create-cap';
      resetFlowsPatchCount(execId);
      resetFlowsPatchCreateCount(execId);

      state.createFlow.mockImplementation((args: { name: string }) =>
        Promise.resolve({ id: `id-${args.name}`, name: args.name }),
      );
      state.createFlowVersion.mockResolvedValue({ id: 'v' });

      for (let i = 0; i < 5; i++) {
        const r = await handleFlowsToolCall(
          'frink_flows_patch',
          { name: `Cap${i}`, operations: OPERATIONS_BUILD_MIN_VALID },
          execId,
        );
        expect(r?.isError).toBe(false);
      }

      const blocked = await handleFlowsToolCall(
        'frink_flows_patch',
        { name: 'Cap6', operations: OPERATIONS_BUILD_MIN_VALID },
        execId,
      );
      expect(blocked?.isError).toBe(true);
      expect(blocked?.content[0].text).toMatch(/5/);
      expect(blocked?.content[0].text).toMatch(/creation|creates/i);

      resetFlowsPatchCount(execId);
      resetFlowsPatchCreateCount(execId);
    });

    it('after patch-create limit, patching an existing flow by flowId still works', async () => {
      const { handleFlowsToolCall, resetFlowsPatchCount, resetFlowsPatchCreateCount } =
        await getModule();
      const execId = 'exec-patch-create-then-flowid';
      resetFlowsPatchCount(execId);
      resetFlowsPatchCreateCount(execId);

      state.createFlow.mockImplementation((args: { name: string }) =>
        Promise.resolve({ id: `id-${args.name}`, name: args.name }),
      );
      state.createFlowVersion.mockResolvedValue({ id: 'v' });

      for (let i = 0; i < 5; i++) {
        await handleFlowsToolCall(
          'frink_flows_patch',
          { name: `Then${i}`, operations: OPERATIONS_BUILD_MIN_VALID },
          execId,
        );
      }

      const blocked = await handleFlowsToolCall(
        'frink_flows_patch',
        { name: 'Blocked', operations: OPERATIONS_BUILD_MIN_VALID },
        execId,
      );
      expect(blocked?.isError).toBe(true);

      state.getFlow.mockResolvedValue({
        id: 'id-Then0',
        name: 'Then0',
        description: null,
        version_number: 1,
        graph: VALID_GRAPH,
      });

      const ok = await handleFlowsToolCall(
        'frink_flows_patch',
        {
          flowId: 'id-Then0',
          operations: [
            { op: 'update_node', nodeId: 'n2', config: { instructions: 'after limit' } },
          ],
        },
        execId,
      );
      expect(ok?.isError).toBe(false);

      resetFlowsPatchCount(execId);
      resetFlowsPatchCreateCount(execId);
    });
  });

  // -------------------------------------------------------------------------
  // frink_flows_patch — partial success (per-op resilience)
  // -------------------------------------------------------------------------

  describe('handleFlowsToolCall — frink_flows_patch partial success', () => {
    const existingForPartial = {
      id: 'flow-partial',
      name: 'PartialFlow',
      description: null,
      version_number: 1,
      graph: {
        nodes: [
          { id: 'n1', blockType: 'manual_trigger' },
          {
            id: 'nst',
            blockType: 'start_task',
            config: { projectId: '550e8400-e29b-41d4-a716-446655440010' },
          },
          { id: 'n2', blockType: 'agent', config: { instructions: 'base', fireAndForget: true } },
        ],
        edges: [
          { id: 'e0', source: 'n1', target: 'nst' },
          { id: 'e1', source: 'nst', target: 'n2' },
        ],
      },
    };

    beforeEach(() => {
      state.getFlow.mockResolvedValue(existingForPartial);
      state.createFlowVersion.mockResolvedValue({ id: 'ver-partial' });
    });

    it('returns status:partial when some ops fail, saves partial graph, returns failed/skipped/retryOps', async () => {
      const { handleFlowsToolCall, resetFlowsPatchCount } = await getModule();
      const execId = 'exec-partial-basic';
      resetFlowsPatchCount(execId);

      const result = await handleFlowsToolCall(
        'frink_flows_patch',
        {
          flowId: 'flow-partial',
          operations: [
            { op: 'update_node', nodeId: 'MISSING', config: { instructions: 'x' } },
            { op: 'update_node', nodeId: 'n2', config: { instructions: 'applied' } },
          ],
        },
        execId,
      );

      expect(result?.isError).toBe(false);
      const body = JSON.parse(expectMcpText(result));
      expect(body.status).toBe('partial');
      expect(body.flowId).toBe('flow-partial');
      expect(body.applied).toEqual([1]);
      expect(body.failed).toHaveLength(1);
      expect(body.failed[0].index).toBe(0);
      expect(body.skipped).toEqual([]);
      expect(body.retryOps).toEqual([0]);
      expect(state.createFlowVersion).toHaveBeenCalledOnce();

      resetFlowsPatchCount(execId);
    });

    it('partial response includes partial-graph note in templateWarnings', async () => {
      const { handleFlowsToolCall, resetFlowsPatchCount } = await getModule();
      const execId = 'exec-partial-tw';
      resetFlowsPatchCount(execId);

      const result = await handleFlowsToolCall(
        'frink_flows_patch',
        {
          flowId: 'flow-partial',
          operations: [
            { op: 'update_node', nodeId: 'MISSING', config: { instructions: 'x' } },
            { op: 'update_settings', settings: { briefing: 'ok' } },
          ],
        },
        execId,
      );

      expect(result?.isError).toBe(false);
      const body = JSON.parse(expectMcpText(result));
      expect(body.status).toBe('partial');
      expect(Array.isArray(body.templateWarnings)).toBe(true);
      expect(body.templateWarnings[0]).toContain('partial');

      resetFlowsPatchCount(execId);
    });

    it('retryOps includes indices from both failed and skipped', async () => {
      const { handleFlowsToolCall, resetFlowsPatchCount } = await getModule();
      const execId = 'exec-partial-retry';
      resetFlowsPatchCount(execId);

      // Op 0: add_node with existing id -> fails
      // Op 1: add_edge referencing failed node -> skipped
      // Op 2: update_settings -> succeeds
      const result = await handleFlowsToolCall(
        'frink_flows_patch',
        {
          flowId: 'flow-partial',
          operations: [
            {
              op: 'add_node',
              node: { id: 'n2', blockType: 'run_command', config: { command: 'x' } },
            },
            { op: 'add_edge', edge: { id: 'e-new', source: 'n2', target: 'n1' } },
            { op: 'update_settings', settings: { briefing: 'ok' } },
          ],
        },
        execId,
      );

      expect(result?.isError).toBe(false);
      const body = JSON.parse(expectMcpText(result));
      expect(body.status).toBe('partial');
      expect(body.failed.map((f: { index: number }) => f.index)).toContain(0);
      expect(body.skipped.map((s: { index: number }) => s.index)).toContain(1);
      expect(body.retryOps).toContain(0);
      expect(body.retryOps).toContain(1);
      expect(body.applied).toContain(2);

      resetFlowsPatchCount(execId);
    });

    it('auto-create + partial: saves flow, returns flowId, does NOT rollback', async () => {
      const { handleFlowsToolCall, resetFlowsPatchCount, resetFlowsPatchCreateCount } =
        await getModule();
      const execId = 'exec-partial-ac';
      resetFlowsPatchCount(execId);
      resetFlowsPatchCreateCount(execId);

      state.createFlow.mockResolvedValue({ id: 'ac-partial', name: 'NewPartial' });

      const result = await handleFlowsToolCall(
        'frink_flows_patch',
        {
          name: 'NewPartial',
          operations: [
            { op: 'add_node', node: { id: 'n1', blockType: 'manual_trigger' } },
            { op: 'update_node', nodeId: 'MISSING', config: { instructions: 'x' } },
          ],
        },
        execId,
      );

      expect(result?.isError).toBe(false);
      const body = JSON.parse(expectMcpText(result));
      expect(body.status).toBe('partial');
      expect(body.flowId).toBe('ac-partial');
      expect(state.deleteFlow).not.toHaveBeenCalled();

      resetFlowsPatchCount(execId);
      resetFlowsPatchCreateCount(execId);
    });

    it('auto-create + all ops fail (zero applied): rollbacks auto-created flow', async () => {
      const { handleFlowsToolCall, resetFlowsPatchCount, resetFlowsPatchCreateCount } =
        await getModule();
      const execId = 'exec-partial-ac-all-fail';
      resetFlowsPatchCount(execId);
      resetFlowsPatchCreateCount(execId);

      state.createFlow.mockResolvedValue({ id: 'ac-zero', name: 'ZeroApplied' });
      state.deleteFlow.mockResolvedValue(undefined);

      const result = await handleFlowsToolCall(
        'frink_flows_patch',
        {
          name: 'ZeroApplied',
          operations: [{ op: 'update_node', nodeId: 'MISSING', config: { instructions: 'x' } }],
        },
        execId,
      );

      expect(result?.isError).toBe(true);
      expect(state.deleteFlow).toHaveBeenCalledWith('ac-zero');
      expect(state.createFlowVersion).not.toHaveBeenCalled();

      resetFlowsPatchCount(execId);
      resetFlowsPatchCreateCount(execId);
    });
  });
});

// -------------------------------------------------------------------------
// frink_flows_list
// -------------------------------------------------------------------------

describe('handleFlowsToolCall — frink_flows_list', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('returns list of flows', async () => {
    const { handleFlowsToolCall } = await getModule();
    state.listFlows.mockResolvedValue([
      {
        id: 'f1',
        name: 'My Flow',
        description: null,
        is_enabled: true,
        agent_invocable: false,
        trigger_type: 'manual_trigger',
        node_count: 3,
        created_at: '2026-01-01',
      },
    ]);
    const result = await handleFlowsToolCall('frink_flows_list', {});
    const body = JSON.parse(expectMcpText(result));
    expect(body.flows).toHaveLength(1);
    expect(body.flows[0].id).toBe('f1');
    expect(body.flows[0].agent_invocable).toBe(false);
  });

  it('returns empty message when no flows exist', async () => {
    const { handleFlowsToolCall } = await getModule();
    state.listFlows.mockResolvedValue([]);
    const result = await handleFlowsToolCall('frink_flows_list', {});
    const body = JSON.parse(expectMcpText(result));
    expect(body.flows).toHaveLength(0);
  });

  it('returns error when listFlows throws', async () => {
    const { handleFlowsToolCall } = await getModule();
    state.listFlows.mockRejectedValue(new Error('network error'));
    const result = await handleFlowsToolCall('frink_flows_list', {});
    expect(result?.isError).toBe(true);
    expect(result?.content[0].text).toContain('network error');
  });

  it('returns validation error for invalid args and does not call listFlows', async () => {
    const { handleFlowsToolCall } = await getModule();
    const result = await handleFlowsToolCall('frink_flows_list', { projectId: 123 });
    expect(result?.isError).toBe(true);
    expect(result?.content[0].text).toMatch(/^Invalid arguments:/);
    expect(state.listFlows).not.toHaveBeenCalled();
  });

  it('passes optional projectId string through to listFlows', async () => {
    const { handleFlowsToolCall } = await getModule();
    state.listFlows.mockResolvedValue([]);
    const pid = '550e8400-e29b-41d4-a716-446655440000';
    await handleFlowsToolCall('frink_flows_list', { projectId: pid });
    expect(state.listFlows).toHaveBeenCalledWith(pid);
  });
});

// -------------------------------------------------------------------------
// frink_flows_get
// -------------------------------------------------------------------------

describe('handleFlowsToolCall — frink_flows_get', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('returns flow metadata and graph', async () => {
    const { handleFlowsToolCall } = await getModule();
    state.getFlow.mockResolvedValue({
      id: 'flow-1',
      name: 'PR Review',
      description: 'Reviews PRs',
      is_enabled: true,
      agent_invocable: true,
      trigger_type: 'schedule_trigger',
      node_count: 3,
      latest_version_id: 'ver-1',
      version_number: 1,
      graph: {
        nodes: [{ id: 'n1', blockType: 'schedule_trigger' }],
        edges: [],
      },
      created_at: '2026-01-01',
      updated_at: '2026-01-02',
    });
    const result = await handleFlowsToolCall('frink_flows_get', { flowId: 'flow-1' });
    const body = JSON.parse(expectMcpText(result));
    expect(body.id).toBe('flow-1');
    expect(body.name).toBe('PR Review');
    expect(body.agent_invocable).toBe(true);
    expect(body.graph.nodes).toHaveLength(1);
    expect(state.getFlow).toHaveBeenCalledWith('flow-1');
  });

  it('returns error for missing flowId', async () => {
    const { handleFlowsToolCall } = await getModule();
    const result = await handleFlowsToolCall('frink_flows_get', {});
    expect(result?.isError).toBe(true);
    expect(state.getFlow).not.toHaveBeenCalled();
  });

  it('returns error for empty flowId', async () => {
    const { handleFlowsToolCall } = await getModule();
    const result = await handleFlowsToolCall('frink_flows_get', { flowId: '' });
    expect(result?.isError).toBe(true);
  });

  it('returns error for whitespace-only flowId', async () => {
    const { handleFlowsToolCall } = await getModule();
    const result = await handleFlowsToolCall('frink_flows_get', { flowId: '   ' });
    expect(result?.isError).toBe(true);
    expect(state.getFlow).not.toHaveBeenCalled();
  });

  it('returns error when getFlow throws', async () => {
    const { handleFlowsToolCall } = await getModule();
    state.getFlow.mockRejectedValue(new Error('not found'));
    const result = await handleFlowsToolCall('frink_flows_get', { flowId: 'missing' });
    expect(result?.isError).toBe(true);
    expect(result?.content[0].text).toContain('not found');
  });

  it('includes project_id in response', async () => {
    const { handleFlowsToolCall } = await getModule();
    state.getFlow.mockResolvedValue({
      id: 'flow-2',
      name: 'Test',
      description: null,
      project_id: 'proj-abc',
      is_enabled: true,
      agent_invocable: false,
      trigger_type: 'manual_trigger',
      node_count: 1,
      latest_version_id: 'ver-2',
      version_number: 1,
      graph: null,
      created_at: '2026-01-01',
      updated_at: '2026-01-01',
    });
    const result = await handleFlowsToolCall('frink_flows_get', { flowId: 'flow-2' });
    const body = JSON.parse(expectMcpText(result));
    expect(body.project_id).toBe('proj-abc');
    expect(body.graph).toBeNull();
  });
});

// -------------------------------------------------------------------------
// frink_flows_run
// -------------------------------------------------------------------------

describe('handleFlowsToolCall — frink_flows_run', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    state.getFlow.mockClear();
    state.startFlowRun.mockClear();
  });

  const runFlowId = '550e8400-e29b-41d4-a716-446655440099';

  function mockInvocableGetFlow() {
    state.getFlow.mockResolvedValue(invocableFlowFixture);
  }

  it('calls startFlowRun when the flow carries the standing agent-run grant', async () => {
    const { handleFlowsToolCall, resetFlowsRunCount } = await getModule();
    resetFlowsRunCount();
    mockInvocableGetFlow();
    state.startFlowRun.mockResolvedValue({
      flowRunId: 'run-1',
      status: 'running',
      started_at: '2026-08-03T10:00:00.000Z',
    });

    const result = await handleFlowsToolCall('frink_flows_run', { flowId: runFlowId });
    const body = JSON.parse(expectMcpText(result));
    expect(body).toMatchObject({
      success: true,
      flowRunId: 'run-1',
      status: 'started',
      runStatus: 'running',
    });
    expect(state.startFlowRun).toHaveBeenCalledWith(runFlowId, { triggerContext: null });
    resetFlowsRunCount();
  });

  it('rejects when the flow has no agent-run grant and none was consented', async () => {
    const { handleFlowsToolCall, resetFlowsRunCount } = await getModule();
    resetFlowsRunCount();
    state.getFlow.mockResolvedValue({
      id: runFlowId,
      name: 'Locked',
      description: null,
      project_id: null,
      is_enabled: true,
      agent_invocable: false,
      trigger_type: 'manual_trigger',
      node_count: 1,
      latest_version_id: 'ver-1',
      version_number: 1,
      graph: { nodes: [], edges: [] },
      created_at: '2026-01-01',
      updated_at: '2026-01-01',
    });

    const result = await handleFlowsToolCall('frink_flows_run', { flowId: runFlowId });
    expect(result?.isError).toBe(true);
    expect(result?.content[0].text).toMatch(/does not allow agent runs yet/);
    expect(state.startFlowRun).not.toHaveBeenCalled();
    resetFlowsRunCount();
  });

  it('rejects when flow is disabled', async () => {
    const { handleFlowsToolCall, resetFlowsRunCount } = await getModule();
    resetFlowsRunCount();
    state.getFlow.mockResolvedValue({
      id: runFlowId,
      name: 'Off',
      description: null,
      project_id: null,
      is_enabled: false,
      agent_invocable: true,
      trigger_type: 'manual_trigger',
      node_count: 1,
      latest_version_id: 'ver-1',
      version_number: 1,
      graph: { nodes: [], edges: [] },
      created_at: '2026-01-01',
      updated_at: '2026-01-01',
    });

    const result = await handleFlowsToolCall('frink_flows_run', { flowId: runFlowId });
    expect(result?.isError).toBe(true);
    expect(result?.content[0].text).toContain('disabled');
    expect(state.startFlowRun).not.toHaveBeenCalled();
    resetFlowsRunCount();
  });

  it('returns a friendly not-found message when startFlowRun throws TRPCError NOT_FOUND', async () => {
    const { handleFlowsToolCall, resetFlowsRunCount } = await getModule();
    resetFlowsRunCount();
    mockInvocableGetFlow();
    state.startFlowRun.mockRejectedValue(notFound('Flow not found'));
    const result = await handleFlowsToolCall('frink_flows_run', { flowId: runFlowId });
    expect(result?.isError).toBe(true);
    expect(result?.content[0].text).toMatch(/Flow not found[\s\S]*published version/);
  });

  it('rate limits independently from patch (5 runs per session)', async () => {
    const { handleFlowsToolCall, resetFlowsRunCount, resetFlowsPatchCount } = await getModule();
    resetFlowsRunCount();
    resetFlowsPatchCount();
    mockInvocableGetFlow();
    const execId = 'exec-runs-cap';
    state.startFlowRun.mockResolvedValue({
      id: 'run-cancelled',
      status: 'cancelled',
      started_at: null,
    });
    for (let i = 0; i < 5; i++) {
      const rejected = await handleFlowsToolCall('frink_flows_run', { flowId: runFlowId }, execId);
      expect(rejected?.isError).toBe(true);
    }
    state.startFlowRun.mockResolvedValue({
      flowRunId: 'run-x',
      status: 'running',
      started_at: '2026-08-03T10:00:00.000Z',
    });

    for (let i = 0; i < 5; i++) {
      const r = await handleFlowsToolCall('frink_flows_run', { flowId: runFlowId }, execId);
      expect(r?.isError).toBe(false);
    }
    const blocked = await handleFlowsToolCall('frink_flows_run', { flowId: runFlowId }, execId);
    expect(blocked?.isError).toBe(true);
    expect(blocked?.content[0].text).toMatch(/Rate limit/);

    resetFlowsRunCount(execId);
    resetFlowsPatchCount(execId);
  });

  it('rejects when graph fails run-mode validation (agent missing effective instructions)', async () => {
    const { handleFlowsToolCall, resetFlowsRunCount } = await getModule();
    resetFlowsRunCount();
    state.getFlow.mockResolvedValue({
      id: runFlowId,
      name: 'Runnable',
      description: null,
      project_id: null,
      is_enabled: true,
      agent_invocable: true,
      trigger_type: 'manual_trigger',
      node_count: 3,
      latest_version_id: 'ver-1',
      version_number: 1,
      graph: {
        nodes: [
          { id: 't1', blockType: 'manual_trigger' },
          {
            id: 'st1',
            blockType: 'start_task',
            config: { projectId: '550e8400-e29b-41d4-a716-446655440010' },
          },
          { id: 'a1', blockType: 'agent', config: { instructions: '   ' } },
        ],
        edges: [
          { id: 'e1', source: 't1', target: 'st1' },
          { id: 'e2', source: 'st1', target: 'a1' },
        ],
      },
      created_at: '2026-01-01',
      updated_at: '2026-01-01',
    });

    const result = await handleFlowsToolCall('frink_flows_run', { flowId: runFlowId });
    expect(result?.isError).toBe(true);
    expect(result?.content[0].text).toMatch(/not ready to run/);
    expect(result?.content[0].text).toMatch(/instructions/i);
    expect(state.startFlowRun).not.toHaveBeenCalled();
    resetFlowsRunCount();
  });

  it('rejects when flow has no saved graph (graph is null)', async () => {
    const { handleFlowsToolCall, resetFlowsRunCount } = await getModule();
    resetFlowsRunCount();
    state.getFlow.mockResolvedValue({
      id: runFlowId,
      name: 'No Graph',
      description: null,
      project_id: null,
      is_enabled: true,
      agent_invocable: true,
      trigger_type: 'manual_trigger',
      node_count: 0,
      latest_version_id: null,
      version_number: null,
      graph: null,
      created_at: '2026-01-01',
      updated_at: '2026-01-01',
    });

    const result = await handleFlowsToolCall('frink_flows_run', { flowId: runFlowId });
    expect(result?.isError).toBe(true);
    expect(result?.content[0].text).toContain('frink_flows_patch');
    expect(state.startFlowRun).not.toHaveBeenCalled();
    resetFlowsRunCount();
  });
});

// -------------------------------------------------------------------------
// frink_flows_add_stage_runs
// -------------------------------------------------------------------------

describe('handleFlowsToolCall — frink_flows_add_stage_runs', () => {
  const flowUuid = '550e8400-e29b-41d4-a716-446655440099';
  const batchUuid = '6ba7b810-9dad-11d1-80b4-00c04fd430c8';

  beforeEach(() => {
    vi.clearAllMocks();
    state.addStageRuns.mockClear();
    state.defineFlowBatchStages.mockClear();
    state.addStageRuns.mockResolvedValue({
      added: [{ runId: 'run-a', index: 0 }],
      failed: [],
    });
  });

  it('calls addStageRuns and returns structured success', async () => {
    const { handleFlowsToolCall } = await getModule();
    const result = await handleFlowsToolCall('frink_flows_add_stage_runs', {
      flowId: flowUuid,
      batchId: batchUuid,
      stageNumber: 2,
      runs: [{ triggerContext: { ticket: 1 } }],
    });

    expect(state.addStageRuns).toHaveBeenCalledWith(flowUuid, 2, batchUuid, [
      { triggerContext: { ticket: 1 } },
    ]);
    const body = JSON.parse(expectMcpText(result));
    expect(body.success).toBe(true);
    expect(body.added).toBe(1);
    expect(body.failed).toBe(0);
    expect(body.stageNumber).toBe(2);
  });

  it('rejects empty flowId so addStageRuns is not invoked', async () => {
    const { handleFlowsToolCall } = await getModule();
    const result = await handleFlowsToolCall('frink_flows_add_stage_runs', {
      flowId: '',
      batchId: batchUuid,
      stageNumber: 1,
      runs: [{}],
    });
    expect(result?.isError).toBe(true);
    expect(state.addStageRuns).not.toHaveBeenCalled();
  });

  it('rejects invalid batchId so addStageRuns is not invoked', async () => {
    const { handleFlowsToolCall } = await getModule();
    const result = await handleFlowsToolCall('frink_flows_add_stage_runs', {
      flowId: flowUuid,
      batchId: 'not-a-uuid',
      stageNumber: 1,
      runs: [{}],
    });
    expect(result?.isError).toBe(true);
    expect(state.addStageRuns).not.toHaveBeenCalled();
  });

  it('rejects more than 50 runs per call (server contract)', async () => {
    const { handleFlowsToolCall } = await getModule();
    const runs = Array.from({ length: 51 }, () => ({}));
    const result = await handleFlowsToolCall('frink_flows_add_stage_runs', {
      flowId: flowUuid,
      batchId: batchUuid,
      stageNumber: 1,
      runs,
    });
    expect(result?.isError).toBe(true);
    expect(result?.content[0].text).toMatch(/50/i);
    expect(state.addStageRuns).not.toHaveBeenCalled();
  });

  it('rejects empty runs array', async () => {
    const { handleFlowsToolCall } = await getModule();
    const result = await handleFlowsToolCall('frink_flows_add_stage_runs', {
      flowId: flowUuid,
      batchId: batchUuid,
      stageNumber: 1,
      runs: [],
    } as Record<string, unknown>);
    expect(result?.isError).toBe(true);
    expect(state.addStageRuns).not.toHaveBeenCalled();
  });

  it('rejects stageNumber < 1', async () => {
    const { handleFlowsToolCall } = await getModule();
    const result = await handleFlowsToolCall('frink_flows_add_stage_runs', {
      flowId: flowUuid,
      batchId: batchUuid,
      stageNumber: 0,
      runs: [{}],
    });
    expect(result?.isError).toBe(true);
    expect(state.addStageRuns).not.toHaveBeenCalled();
  });

  it('rejects non-integer stageNumber', async () => {
    const { handleFlowsToolCall } = await getModule();
    const result = await handleFlowsToolCall('frink_flows_add_stage_runs', {
      flowId: flowUuid,
      batchId: batchUuid,
      stageNumber: 1.5,
      runs: [{}],
    });
    expect(result?.isError).toBe(true);
    expect(state.addStageRuns).not.toHaveBeenCalled();
  });

  it('includes failedRuns when API returns partial per-run failures', async () => {
    state.addStageRuns.mockResolvedValue({
      added: [{ runId: 'r1', index: 0 }],
      failed: [{ index: 1, error: 'triggerContext exceeds 10000 character limit' }],
    });
    const { handleFlowsToolCall } = await getModule();
    const result = await handleFlowsToolCall('frink_flows_add_stage_runs', {
      flowId: flowUuid,
      batchId: batchUuid,
      stageNumber: 1,
      runs: [{}, {}],
    });
    const body = JSON.parse(expectMcpText(result));
    expect(body.success).toBe(true);
    expect(body.added).toBe(1);
    expect(body.failed).toBe(1);
    expect(body.failedRuns).toEqual([
      { index: 1, error: 'triggerContext exceeds 10000 character limit' },
    ]);
    expect(body.message).toMatch(/1 run\(s\) failed/);
  });

  it('returns generic tool error for an unexpected addStageRuns failure', async () => {
    state.addStageRuns.mockRejectedValue(new Error("Stage 2 is 'running', not 'pending'"));
    const { handleFlowsToolCall } = await getModule();
    const result = await handleFlowsToolCall('frink_flows_add_stage_runs', {
      flowId: flowUuid,
      batchId: batchUuid,
      stageNumber: 2,
      runs: [{}],
    });
    expect(result?.isError).toBe(true);
    expect(result?.content[0].text).toMatch(/Failed to add stage runs/);
    expect(result?.content[0].text).toContain('pending');
  });

  it('returns clearer tool error when addStageRuns throws TRPCError NOT_FOUND', async () => {
    state.addStageRuns.mockRejectedValue(notFound('Stage 3 not found in batch.'));
    const { handleFlowsToolCall } = await getModule();
    const result = await handleFlowsToolCall('frink_flows_add_stage_runs', {
      flowId: flowUuid,
      batchId: batchUuid,
      stageNumber: 3,
      runs: [{}],
    });
    expect(result?.isError).toBe(true);
    expect(result?.content[0].text).toMatch(/Batch or flow not found — cannot add stage runs/);
    expect(result?.content[0].text).toContain('Stage 3 not found');
    expect(result?.content[0].text).not.toMatch(/^Failed to add stage runs:/);
  });

  it('invalid arguments do not consume add_stage_runs rate-limit slots (validate before acquire)', async () => {
    const { handleFlowsToolCall, resetFlowsAddStageRunsCount } = await getModule();
    const execId = 'exec-add-runs-invalid-no-slot-burn';
    resetFlowsAddStageRunsCount(execId);

    for (let i = 0; i < 25; i++) {
      const r = await handleFlowsToolCall(
        'frink_flows_add_stage_runs',
        {
          flowId: '',
          batchId: batchUuid,
          stageNumber: 1,
          runs: [{}],
        },
        execId,
      );
      expect(r?.isError).toBe(true);
      expect(r?.content[0].text).toMatch(/Invalid arguments/);
      expect(r?.content[0].text).not.toMatch(/Rate limit/);
    }

    const ok = await handleFlowsToolCall(
      'frink_flows_add_stage_runs',
      {
        flowId: flowUuid,
        batchId: batchUuid,
        stageNumber: 1,
        runs: [{}],
      },
      execId,
    );
    expect(ok?.isError).toBe(false);
    expect(state.addStageRuns).toHaveBeenCalled();
    resetFlowsAddStageRunsCount(execId);
  });

  it('rate limit — blocks after 20 successful add_stage_runs calls per session', async () => {
    const { handleFlowsToolCall, resetFlowsAddStageRunsCount } = await getModule();
    const execId = 'exec-add-stage-runs-rate-cap';
    resetFlowsAddStageRunsCount(execId);

    for (let i = 0; i < 20; i++) {
      const r = await handleFlowsToolCall(
        'frink_flows_add_stage_runs',
        {
          flowId: flowUuid,
          batchId: batchUuid,
          stageNumber: 1,
          runs: [{}],
        },
        execId,
      );
      expect(r?.isError).toBe(false);
    }

    const blocked = await handleFlowsToolCall(
      'frink_flows_add_stage_runs',
      {
        flowId: flowUuid,
        batchId: batchUuid,
        stageNumber: 1,
        runs: [{}],
      },
      execId,
    );
    expect(blocked?.isError).toBe(true);
    expect(blocked?.content[0].text).toContain('Rate limit');
    expect(blocked?.content[0].text).toContain('add_stage_runs');
    resetFlowsAddStageRunsCount(execId);
  });

  /**
   * Regression: staged batch is pinned to the flow version from define_stages; publishing a newer
   * graph version must not make add_stage_runs re-fetch the flow to resolve "latest". The handler
   * should only POST add runs (no getFlow — the client primitive used when resolving current graph).
   */
  it('mixed-version batch: add_stage_runs succeeds after a new flow version without calling getFlow', async () => {
    const { handleFlowsToolCall, resetFlowsPatchCount, resetFlowsAddStageRunsCount } =
      await getModule();
    const execId = 'exec-mixed-batch-flow-version';

    resetFlowsPatchCount(execId);
    resetFlowsAddStageRunsCount(execId);

    state.defineFlowBatchStages.mockResolvedValue({
      stages: [
        {
          id: 'stage-row-1',
          stageNumber: 1,
          name: 'Stage 1',
          status: 'running',
          runCount: 1,
        },
      ],
      rootStageCount: 1,
      maxDepth: 1,
    });

    state.getFlow.mockResolvedValue({
      id: flowUuid,
      name: 'Mixed-version flow',
      description: null,
      version_number: 1,
      graph: VALID_GRAPH,
    });
    state.createFlowVersion.mockResolvedValue({
      id: 'new-published-version-id',
      version_number: 2,
    });

    const defineResult = await handleFlowsToolCall('frink_flows_define_stages', {
      flowId: flowUuid,
      batchId: batchUuid,
      stages: [
        {
          stageNumber: 1,
          name: 'S1',
          runs: [{ triggerContext: { batchPinnedAtDefine: true } }],
        },
      ],
    });
    expect(defineResult?.isError).toBe(false);
    expect(state.defineFlowBatchStages).toHaveBeenCalledWith(
      flowUuid,
      batchUuid,
      expect.arrayContaining([
        expect.objectContaining({
          stageNumber: 1,
          runs: [{ triggerContext: { batchPinnedAtDefine: true } }],
        }),
      ]),
    );

    const patchResult = await handleFlowsToolCall(
      'frink_flows_patch',
      {
        flowId: flowUuid,
        operations: [
          {
            op: 'update_node' as const,
            nodeId: 'n2',
            config: { instructions: 'bumped-after-batch' },
          },
        ],
      },
      execId,
    );
    expect(patchResult?.isError).toBe(false);
    expect(state.createFlowVersion).toHaveBeenCalled();

    state.getFlow.mockClear();

    const addResult = await handleFlowsToolCall(
      'frink_flows_add_stage_runs',
      {
        flowId: flowUuid,
        batchId: batchUuid,
        stageNumber: 1,
        runs: [{ triggerContext: { incremental: true } }],
      },
      execId,
    );

    const body = JSON.parse(expectMcpText(addResult));
    expect(body.success).toBe(true);
    expect(state.addStageRuns).toHaveBeenCalledWith(flowUuid, 1, batchUuid, [
      { triggerContext: { incremental: true } },
    ]);
    expect(state.getFlow).not.toHaveBeenCalled();

    resetFlowsPatchCount(execId);
    resetFlowsAddStageRunsCount(execId);
  });
});

// -------------------------------------------------------------------------
// Unknown tool
// -------------------------------------------------------------------------

describe('handleFlowsToolCall — unknown tool', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('returns null for unknown tool names', async () => {
    const { handleFlowsToolCall } = await getModule();
    const result = await handleFlowsToolCall('some_other_tool', {});
    expect(result).toBeNull();
  });
});

// -------------------------------------------------------------------------
// FLOWS_TOOL_NAMES set
// -------------------------------------------------------------------------

describe('FLOWS_TOOL_NAMES', () => {
  it('contains the key MCP flow tool names', async () => {
    const { FLOWS_TOOL_NAMES } = await getModule();
    // frink_flows_learn was migrated to the `frink-flows` skill in 0.0.7 —
    // it must NOT be exposed as an MCP tool anymore.
    expect(FLOWS_TOOL_NAMES.has('frink_flows_learn')).toBe(false);
    expect(FLOWS_TOOL_NAMES.has('frink_flows_patch')).toBe(true);
    expect(FLOWS_TOOL_NAMES.has('frink_flows_list')).toBe(true);
    expect(FLOWS_TOOL_NAMES.has('frink_flows_get')).toBe(true);
    expect(FLOWS_TOOL_NAMES.has('frink_flows_add_stage_runs')).toBe(true);
    expect(FLOWS_TOOL_NAMES.has('frink_register_node')).toBe(true);
    expect(FLOWS_TOOL_NAMES.has('frink_flows_run')).toBe(true);
    // Merged read tools: the former list_runs/list_stages fold into get_batch, and
    // integrations/commands/templates fold into list_catalog.
    expect(FLOWS_TOOL_NAMES.has('frink_flows_get_batch')).toBe(true);
    expect(FLOWS_TOOL_NAMES.has('frink_flows_list_catalog')).toBe(true);
    // The pre-merge tool names must NOT be exposed anymore.
    expect(FLOWS_TOOL_NAMES.has('frink_flows_list_runs')).toBe(false);
    expect(FLOWS_TOOL_NAMES.has('frink_flows_list_stages')).toBe(false);
    expect(FLOWS_TOOL_NAMES.has('frink_flows_list_templates')).toBe(false);
    expect(FLOWS_TOOL_NAMES.has('frink_integrations_list')).toBe(false);
    expect(FLOWS_TOOL_NAMES.has('frink_commands_list')).toBe(false);
  });
});

describe('FLOWS_TOOLS readOnlyHint (drives the write-gate derivation)', () => {
  it('annotates exactly the read tools, and the rest equals FRINK_MUTATING_FLOW_TOOLS', async () => {
    const { FLOWS_TOOLS } = await getModule();
    const { FRINK_MUTATING_FLOW_TOOLS } = await import('../../../../shared/lib/mcp-tool-name');
    // Permission anchor: check.ts and gateFlowWrite key off FRINK_MUTATING_FLOW_TOOLS,
    // so a new flow tool missing from the set would silently auto-allow at the trust
    // short-circuit, and a write tool carrying readOnlyHint would auto-approve.
    const readOnly = FLOWS_TOOLS.filter(
      (t) =>
        'annotations' in t &&
        (t as { annotations: { readOnlyHint?: boolean } }).annotations.readOnlyHint,
    ).map((t) => t.name);
    const mutating = FLOWS_TOOLS.map((t) => t.name).filter((n) => !readOnly.includes(n));
    expect(new Set(mutating)).toEqual(new Set(FRINK_MUTATING_FLOW_TOOLS));
    expect(new Set(readOnly)).toEqual(
      new Set([
        'frink_flows_list',
        'frink_flows_get',
        'frink_flows_get_run',
        'frink_flows_get_batch',
        'frink_flows_list_catalog',
      ]),
    );
  });
});

describe("handleFlowsToolCall — frink_flows_list_catalog (kind: 'integrations')", () => {
  afterEach(() => {
    vi.clearAllMocks();
  });

  it('returns active integrations with provider event ids; filters inactive rows', async () => {
    const { handleFlowsToolCall } = await getModule();
    state.localIntegrationRows.mockResolvedValue([
      {
        id: 'int-shortcut',
        provider: 'shortcut',
        accountName: 'benjinorval',
        accountIdentifier: 'acc-1',
        isActive: true,
      },
      {
        id: 'int-dead',
        provider: 'linear',
        accountName: null,
        accountIdentifier: 'T-OLD',
        isActive: false,
      },
    ]);

    const body = JSON.parse(
      expectMcpText(
        await handleFlowsToolCall('frink_flows_list_catalog', { kind: 'integrations' }),
      ),
    );
    expect(body.integrations).toHaveLength(1);
    const sc = body.integrations[0];
    expect(sc).toMatchObject({ id: 'int-shortcut', provider: 'shortcut', account: 'benjinorval' });
    // events come from the real provider registry (selectors is NOT mocked).
    expect(sc.events.length).toBeGreaterThan(0);
    expect(sc.events.every((e: { id: string; label: string }) => Boolean(e.id && e.label))).toBe(
      true,
    );
    expect(sc.events.map((e: { id: string }) => e.id)).toContain('story_created');
    // never leaks secret-bearing raw fields.
    expect(Object.keys(sc).sort()).toEqual(['account', 'events', 'id', 'provider']);
  });

  it('falls back to account_identifier when account_name is null', async () => {
    const { handleFlowsToolCall } = await getModule();
    state.localIntegrationRows.mockResolvedValue([
      {
        id: 'i',
        provider: 'linear',
        accountName: null,
        accountIdentifier: 'T123',
        isActive: true,
      },
    ]);
    const body = JSON.parse(
      expectMcpText(
        await handleFlowsToolCall('frink_flows_list_catalog', { kind: 'integrations' }),
      ),
    );
    expect(body.integrations[0].account).toBe('T123');
  });

  it('returns connect guidance (not an error) when none are connected', async () => {
    const { handleFlowsToolCall } = await getModule();
    state.localIntegrationRows.mockResolvedValue([]);
    const body = JSON.parse(
      expectMcpText(
        await handleFlowsToolCall('frink_flows_list_catalog', { kind: 'integrations' }),
      ),
    );
    expect(body.integrations).toEqual([]);
    expect(body.message).toContain('Settings → Plugins');
  });

  it('reports an error when the account read throws', async () => {
    const { handleFlowsToolCall } = await getModule();
    state.localIntegrationRows.mockRejectedValue(new Error('network down'));
    const result = await handleFlowsToolCall('frink_flows_list_catalog', { kind: 'integrations' });
    expect(result?.isError).toBe(true);
    expect(result?.content[0]?.text).toContain('network down');
  });

  it("lists local projects via kind: 'projects', flagging virtual rows", async () => {
    const { handleFlowsToolCall } = await getModule();
    state.listProjects.mockResolvedValue([
      { id: 'p1', name: 'Frink', path: '/repo/frink' },
      { id: 'pv', name: 'Scratch', path: 'virtual://scratch' },
    ]);
    const body = JSON.parse(
      expectMcpText(await handleFlowsToolCall('frink_flows_list_catalog', { kind: 'projects' })),
    );
    expect(body.count).toBe(2);
    expect(body.projects[0]).toEqual({ id: 'p1', name: 'Frink', path: '/repo/frink' });
    expect(body.projects[1]).toEqual({ id: 'pv', name: 'Scratch', virtual: true });
  });

  it('falls back to account_identifier when account_name is an empty string', async () => {
    const { handleFlowsToolCall } = await getModule();
    state.localIntegrationRows.mockResolvedValue([
      {
        id: 'i',
        provider: 'linear',
        accountName: '',
        accountIdentifier: 'T123',
        isActive: true,
      },
    ]);
    const body = JSON.parse(
      expectMcpText(
        await handleFlowsToolCall('frink_flows_list_catalog', { kind: 'integrations' }),
      ),
    );
    // An empty account_name must not surface as a blank label — match the UI's truthy fallback,
    // otherwise two same-provider accounts both render blank and become indistinguishable.
    expect(body.integrations[0].account).toBe('T123');
  });

  it('maps an unknown provider to empty events without poisoning valid rows', async () => {
    const { handleFlowsToolCall } = await getModule();
    state.localIntegrationRows.mockResolvedValue([
      {
        id: 'bogus',
        provider: 'not_a_provider',
        accountName: 'x',
        accountIdentifier: 'x1',
        isActive: true,
      },
      {
        id: 'int-shortcut',
        provider: 'shortcut',
        accountName: 'benjinorval',
        accountIdentifier: 'acc-1',
        isActive: true,
      },
    ]);
    const body = JSON.parse(
      expectMcpText(
        await handleFlowsToolCall('frink_flows_list_catalog', { kind: 'integrations' }),
      ),
    );
    expect(body.integrations).toHaveLength(2);
    const bogus = body.integrations.find((i: { id: string }) => i.id === 'bogus');
    expect(bogus.events).toEqual([]);
    // a single unregistered row must not break event resolution for valid rows.
    const sc = body.integrations.find((i: { id: string }) => i.id === 'int-shortcut');
    expect(sc.events.length).toBeGreaterThan(0);
  });
});

describe('handleFlowsToolCall — frink_flows_patch webhook setup hint', () => {
  afterEach(() => {
    vi.clearAllMocks();
  });

  it('hints to call frink_flows_list_catalog when a webhook_trigger lacks integration/event', async () => {
    const { handleFlowsToolCall } = await getModule();
    state.getFlow.mockResolvedValue({
      id: 'f-wh',
      name: 'WH',
      description: null,
      version_number: 1,
      graph: { nodes: [], edges: [] },
    });
    state.createFlowVersion.mockResolvedValue({ id: 'ver-wh' });

    const body = JSON.parse(
      expectMcpText(
        await handleFlowsToolCall(
          'frink_flows_patch',
          {
            flowId: 'f-wh',
            operations: [
              {
                op: 'add_node',
                node: { id: 'n1', blockType: 'webhook_trigger', label: 'Shortcut story' },
              },
              {
                op: 'add_node',
                node: {
                  id: 'nst',
                  blockType: 'start_task',
                  config: { projectId: '550e8400-e29b-41d4-a716-446655440010', label: 'Start' },
                },
              },
              {
                op: 'add_node',
                node: { id: 'n2', blockType: 'agent', config: { instructions: 'do it' } },
              },
              { op: 'add_edge', edge: { id: 'e0', source: 'n1', target: 'nst' } },
              { op: 'add_edge', edge: { id: 'e1', source: 'nst', target: 'n2' } },
            ],
          },
          'wh-hint-session',
        ),
      ),
    );
    expect(body.status).toBe('success');
    expect(body.webhookSetup).toBeDefined();
    expect(body.webhookSetup[0]).toContain('frink_flows_list_catalog');
    expect(body.webhookSetup[0]).toContain('Shortcut story');
  });

  it('still hints when a webhook_trigger has integrationId but no eventType', async () => {
    const { handleFlowsToolCall } = await getModule();
    state.getFlow.mockResolvedValue({
      id: 'f-wh2',
      name: 'WH2',
      description: null,
      version_number: 1,
      graph: { nodes: [], edges: [] },
    });
    state.createFlowVersion.mockResolvedValue({ id: 'ver-wh2' });

    const body = JSON.parse(
      expectMcpText(
        await handleFlowsToolCall(
          'frink_flows_patch',
          {
            flowId: 'f-wh2',
            operations: [
              {
                op: 'add_node',
                node: {
                  id: 'n1',
                  blockType: 'webhook_trigger',
                  label: 'Partial',
                  config: { integrationId: 'abc-123' },
                },
              },
              {
                op: 'add_node',
                node: {
                  id: 'nst',
                  blockType: 'start_task',
                  config: { projectId: '550e8400-e29b-41d4-a716-446655440010' },
                },
              },
              {
                op: 'add_node',
                node: { id: 'n2', blockType: 'agent', config: { instructions: 'do it' } },
              },
              { op: 'add_edge', edge: { id: 'e0', source: 'n1', target: 'nst' } },
              { op: 'add_edge', edge: { id: 'e1', source: 'nst', target: 'n2' } },
            ],
          },
          'wh-partial-session',
        ),
      ),
    );
    expect(body.webhookSetup).toBeDefined();
    expect(body.webhookSetup[0]).toContain('frink_flows_list_catalog');
  });

  it('does not hint when a webhook_trigger has both integrationId and eventType', async () => {
    const { handleFlowsToolCall } = await getModule();
    state.getFlow.mockResolvedValue({
      id: 'f-ok',
      name: 'OK',
      description: null,
      version_number: 1,
      graph: { nodes: [], edges: [] },
    });
    state.createFlowVersion.mockResolvedValue({ id: 'ver-ok' });

    const body = JSON.parse(
      expectMcpText(
        await handleFlowsToolCall(
          'frink_flows_patch',
          {
            flowId: 'f-ok',
            operations: [
              {
                op: 'add_node',
                node: {
                  id: 'n1',
                  blockType: 'webhook_trigger',
                  config: { integrationId: 'abc-123', eventType: 'story_created' },
                },
              },
              {
                op: 'add_node',
                node: {
                  id: 'nst',
                  blockType: 'start_task',
                  config: { projectId: '550e8400-e29b-41d4-a716-446655440010' },
                },
              },
              {
                op: 'add_node',
                node: { id: 'n2', blockType: 'agent', config: { instructions: 'do it' } },
              },
              { op: 'add_edge', edge: { id: 'e0', source: 'n1', target: 'nst' } },
              { op: 'add_edge', edge: { id: 'e1', source: 'nst', target: 'n2' } },
            ],
          },
          'wh-ok-session',
        ),
      ),
    );
    expect(body.status).toBe('success');
    expect(body.webhookSetup).toBeUndefined();
  });
});

describe('handleFlowsToolCall — frink_flows_run webhook readiness hint', () => {
  afterEach(() => {
    vi.clearAllMocks();
  });

  const runFlowId = '550e8400-e29b-41d4-a716-446655440042';

  function mockRunnableFlow(
    overrides: Partial<{ trigger: Record<string, unknown>; agentInstructions: string }> = {},
  ) {
    const trigger = overrides.trigger ?? { id: 't1', blockType: 'webhook_trigger' };
    state.getFlow.mockResolvedValue({
      id: runFlowId,
      name: 'WH run',
      description: null,
      project_id: null,
      is_enabled: true,
      agent_invocable: true,
      trigger_type: 'webhook_trigger',
      node_count: 3,
      latest_version_id: 'ver-1',
      version_number: 1,
      graph: {
        nodes: [
          trigger,
          {
            id: 'st1',
            blockType: 'start_task',
            config: { projectId: '550e8400-e29b-41d4-a716-446655440010' },
          },
          {
            id: 'a1',
            blockType: 'agent',
            config: { instructions: overrides.agentInstructions ?? 'do work' },
          },
        ],
        edges: [
          { id: 'e1', source: 't1', target: 'st1' },
          { id: 'e2', source: 'st1', target: 'a1' },
        ],
      },
      created_at: '2026-01-01',
      updated_at: '2026-01-01',
    });
  }

  it('appends the frink_flows_list_catalog hint when a webhook_trigger is unconfigured at run time', async () => {
    const { handleFlowsToolCall, resetFlowsRunCount } = await getModule();
    resetFlowsRunCount();
    mockRunnableFlow(); // webhook_trigger with no integrationId/eventType
    const result = await handleFlowsToolCall('frink_flows_run', { flowId: runFlowId });
    expect(result?.isError).toBe(true);
    expect(result?.content[0].text).toMatch(/not ready to run/);
    expect(result?.content[0].text).toContain('frink_flows_list_catalog');
    expect(state.startFlowRun).not.toHaveBeenCalled();
    resetFlowsRunCount();
  });

  it('does not append the integrations hint for a non-webhook readiness error', async () => {
    const { handleFlowsToolCall, resetFlowsRunCount } = await getModule();
    resetFlowsRunCount();
    mockRunnableFlow({
      trigger: { id: 't1', blockType: 'manual_trigger' },
      agentInstructions: '   ',
    });
    const result = await handleFlowsToolCall('frink_flows_run', { flowId: runFlowId });
    expect(result?.isError).toBe(true);
    expect(result?.content[0].text).toMatch(/not ready to run/);
    expect(result?.content[0].text).not.toContain('frink_flows_list_catalog');
    resetFlowsRunCount();
  });
});

// ---------------------------------------------------------------------------
// frink_flows_patch — author-time agent /command expansion
// ---------------------------------------------------------------------------

describe('handleFlowsToolCall — agent /command expansion', () => {
  const CMD = {
    name: 'edge-cases',
    description: 'Edge cases',
    origin: 'frink' as const,
    source: 'project' as const,
    path: '/proj/.frink/commands/edge-cases.md',
  };

  type SavedAgent = { id: string; config?: Record<string, unknown> };

  afterEach(() => {
    vi.clearAllMocks();
  });

  /** The agent node (n2) from the saved graph of the first createFlowVersion call. */
  function savedAgentNode(): SavedAgent | undefined {
    const graph = state.createFlowVersion.mock.calls[0]?.[1]?.graph as
      | { nodes: SavedAgent[] }
      | undefined;
    return graph?.nodes.find((n) => n.id === 'n2');
  }

  function patchInstructions(execId: string, instructions: string) {
    return handleCall(execId, instructions);
  }

  let handleCall: (execId: string, instructions: string) => Promise<McpToolResultLike | null>;

  beforeEach(async () => {
    const { handleFlowsToolCall, resetFlowsPatchCount } = await getModule();
    state.getFlow.mockResolvedValue({
      id: 'flow-patch',
      name: 'Patchable',
      description: null,
      version_number: 3,
      graph: VALID_GRAPH,
    });
    state.createFlowVersion.mockResolvedValue({ id: 'ver-patch' });
    state.getDatabase.mockReturnValue({});
    state.getProjectById.mockResolvedValue({ path: '/proj' });
    state.listCommands.mockResolvedValue([CMD]);
    state.getCommandContent.mockResolvedValue('Find the edge cases.');
    handleCall = (execId, instructions) => {
      resetFlowsPatchCount(execId);
      return handleFlowsToolCall(
        'frink_flows_patch',
        {
          flowId: 'flow-patch',
          operations: [{ op: 'update_node', nodeId: 'n2', config: { instructions } }],
        },
        execId,
      ) as Promise<McpToolResultLike | null>;
    };
  });

  it('expands a known leading /command into its saved-prompt body and records the name', async () => {
    const result = await patchInstructions('exec-cmd-ok', '/edge-cases');
    expect(result?.isError).toBe(false);
    expect(state.getProjectById).toHaveBeenCalledWith({}, '550e8400-e29b-41d4-a716-446655440010');
    const agent = savedAgentNode();
    expect(agent?.config?.instructions).toBe('Find the edge cases.');
    expect(agent?.config?.instructionsCommandName).toBe('edge-cases');
  });

  it('substitutes $ARGUMENTS from the trailing text', async () => {
    state.getCommandContent.mockResolvedValue('Review $ARGUMENTS carefully.');
    const result = await patchInstructions('exec-cmd-args', '/edge-cases the auth flow');
    expect(result?.isError).toBe(false);
    expect(savedAgentNode()?.config?.instructions).toBe('Review the auth flow carefully.');
  });

  it('hard-fails the patch on an unknown /command and saves nothing', async () => {
    const result = await patchInstructions('exec-cmd-bad', '/edge-cazes');
    expect(result?.isError).toBe(true);
    const text = result?.content[0]?.text ?? '';
    expect(text).toContain('Command expansion failed');
    expect(text).toContain('edge-cases'); // did-you-mean suggestion
    expect(state.createFlowVersion).not.toHaveBeenCalled();
  });

  it('leaves a built-in /command literal (no expansion, no command name)', async () => {
    const result = await patchInstructions('exec-cmd-builtin', '/plan refactor the auth flow');
    expect(result?.isError).toBe(false);
    expect(state.listCommands).not.toHaveBeenCalled();
    const agent = savedAgentNode();
    expect(agent?.config?.instructions).toBe('/plan refactor the auth flow');
    expect(agent?.config?.instructionsCommandName).toBeUndefined();
  });

  it('does not re-expand a previously-expanded slash-body node when an unrelated node is patched', async () => {
    // n2 was expanded on an earlier patch; its stored body happens to begin with
    // "/think" (not a real command). Patching an unrelated node (n3) must not
    // re-scan n2 — otherwise the flow can never be patched again.
    state.getFlow.mockResolvedValue({
      id: 'flow-patch',
      name: 'Patchable',
      description: null,
      version_number: 3,
      graph: {
        nodes: [
          { id: 'n1', blockType: 'manual_trigger' },
          {
            id: 'nst',
            blockType: 'start_task',
            config: { projectId: '550e8400-e29b-41d4-a716-446655440010' },
          },
          {
            id: 'n2',
            blockType: 'agent',
            config: {
              instructions: '/think hard about the auth flow',
              instructionsCommandName: 'edge-cases',
            },
          },
          { id: 'n3', blockType: 'agent', config: { instructions: 'plain instructions' } },
        ],
        edges: [
          { id: 'e0', source: 'n1', target: 'nst' },
          { id: 'e1', source: 'nst', target: 'n2' },
          { id: 'e2', source: 'n2', target: 'n3' },
        ],
      },
    });
    state.listCommands.mockResolvedValue([]); // "think" is not a known command
    const { handleFlowsToolCall, resetFlowsPatchCount } = await getModule();
    const execId = 'exec-no-reexpand';
    resetFlowsPatchCount(execId);
    const result = await handleFlowsToolCall(
      'frink_flows_patch',
      {
        flowId: 'flow-patch',
        operations: [
          { op: 'update_node', nodeId: 'n3', config: { instructions: 'updated plain' } },
        ],
      },
      execId,
    );
    expect(result?.isError).toBe(false); // must NOT hard-fail on n2's stale body
    expect(state.createFlowVersion).toHaveBeenCalled();
  });

  it('releases the create slot when an auto-created flow is rolled back on expansion failure', async () => {
    // Creating a flow by name with a mistyped /command rolls the flow back. That
    // must NOT consume a lifetime create slot — otherwise an agent iterating on a
    // typo exhausts its 5 creates without ever saving a flow.
    const { handleFlowsToolCall, resetFlowsPatchCount, resetFlowsPatchCreateCount } =
      await getModule();
    const execId = 'exec-create-slot-release';
    resetFlowsPatchCount(execId);
    resetFlowsPatchCreateCount(execId);
    state.listCommands.mockResolvedValue([]); // every /command is unknown
    state.createFlow.mockResolvedValue({ id: 'new-flow', name: 'N' });
    state.deleteFlow.mockResolvedValue(undefined);

    const createByName = (instructions: string) =>
      handleFlowsToolCall(
        'frink_flows_patch',
        {
          name: 'N',
          operations: [
            { op: 'add_node', node: { id: 'n1', blockType: 'manual_trigger' } },
            {
              op: 'add_node',
              node: {
                id: 'nst',
                blockType: 'start_task',
                config: { projectId: '550e8400-e29b-41d4-a716-446655440010' },
              },
            },
            { op: 'add_node', node: { id: 'n2', blockType: 'agent', config: { instructions } } },
            { op: 'add_edge', edge: { id: 'e0', source: 'n1', target: 'nst' } },
            { op: 'add_edge', edge: { id: 'e1', source: 'nst', target: 'n2' } },
          ],
        },
        execId,
      );

    // 5 failed creates (== MAX_PATCH_CREATE_PER_SESSION); each must give its slot back.
    for (let i = 0; i < 5; i++) {
      const failed = await createByName('/bogus-command');
      expect(failed?.isError).toBe(true);
    }
    expect(state.deleteFlow).toHaveBeenCalledTimes(5); // all rolled back

    // A 6th create succeeds only if the slots were released, not leaked.
    const ok = await createByName('plain instructions');
    expect(ok?.isError).toBe(false);
    resetFlowsPatchCreateCount(execId);
  });
});

// ---------------------------------------------------------------------------
// frink_flows_list_catalog (kind: 'commands')
// ---------------------------------------------------------------------------

describe("handleFlowsToolCall — frink_flows_list_catalog (kind: 'commands')", () => {
  afterEach(() => {
    vi.clearAllMocks();
  });

  beforeEach(() => {
    state.getDatabase.mockReturnValue({});
  });

  it('lists user-global commands when no flowId is given', async () => {
    const { handleFlowsToolCall } = await getModule();
    state.listCommands.mockResolvedValue([
      {
        name: 'edge-cases',
        description: 'Edge cases',
        origin: 'frink',
        source: 'user',
        path: '/u/edge-cases.md',
      },
    ]);
    const result = await handleFlowsToolCall('frink_flows_list_catalog', { kind: 'commands' });
    const body = JSON.parse(expectMcpText(result));
    expect(body.count).toBe(1);
    expect(body.projectScoped).toBe(false);
    expect(body.commands[0].name).toBe('edge-cases');
    expect(state.getProjectById).not.toHaveBeenCalled();
    expect(state.listCommands).toHaveBeenCalledWith(undefined);
  });

  it('scopes to the flow project when flowId is given', async () => {
    const { handleFlowsToolCall } = await getModule();
    state.getFlow.mockResolvedValue({ id: 'f1', project_id: 'proj-1', graph: VALID_GRAPH });
    state.getProjectById.mockResolvedValue({ path: '/proj' });
    state.listCommands.mockResolvedValue([
      {
        name: 'deploy',
        description: '',
        origin: 'frink',
        source: 'project',
        path: '/proj/.frink/commands/deploy.md',
      },
    ]);
    const result = await handleFlowsToolCall('frink_flows_list_catalog', {
      kind: 'commands',
      flowId: 'f1',
    });
    const body = JSON.parse(expectMcpText(result));
    expect(body.projectScoped).toBe(true);
    expect(state.listCommands).toHaveBeenCalledWith('/proj');
  });

  it('falls back to user-global when the flow lookup fails', async () => {
    const { handleFlowsToolCall } = await getModule();
    state.getFlow.mockRejectedValue(notFound());
    state.listCommands.mockResolvedValue([]);
    const result = await handleFlowsToolCall('frink_flows_list_catalog', {
      kind: 'commands',
      flowId: 'missing',
    });
    const body = JSON.parse(expectMcpText(result));
    expect(body.projectScoped).toBe(false);
    expect(state.listCommands).toHaveBeenCalledWith(undefined);
  });
});
