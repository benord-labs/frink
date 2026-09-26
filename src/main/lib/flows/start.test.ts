import { beforeEach, describe, expect, it, vi } from 'vitest';

// Edge case (F1): the matcher (extractFlowWebhookBindingFromGraph) finds the
// webhook_trigger at ANY index, but startFlowRun must dispatch from the actual
// trigger node — identified by block type, NOT array position — so a flow whose
// trigger isn't nodes[0] (e.g. an MCP-patch-built graph) still runs instead of
// silently no-firing.

const { mocks } = vi.hoisted(() => ({
  mocks: {
    getFlowById: vi.fn(),
    getLatestVersion: vi.fn(),
    getVersion: vi.fn(),
    getFlowRun: vi.fn(),
    setFlowRunStatus: vi.fn(),
    listNodeRunsForFlowRun: vi.fn(),
    loadRunContext: vi.fn(),
    dispatchAndAdvance: vi.fn(),
    emitRunStarted: vi.fn(),
    requestFlowStart: vi.fn(),
    requestTerminalFlowResume: vi.fn(),
    registerFlowAdmissionStartDispatcher: vi.fn(),
    registerTerminalFlowResumeDispatcher: vi.fn(),
    admittedResumeDispatcher: null as null | ((intent: Record<string, unknown>) => Promise<void>),
  },
}));

vi.mock('../db', () => ({ getDatabase: vi.fn(() => ({})) }));
vi.mock('../db/repos/flows', () => ({ getFlowById: mocks.getFlowById }));
vi.mock('../db/repos/flow-versions', () => ({
  getLatestVersion: mocks.getLatestVersion,
  getVersion: mocks.getVersion,
}));
vi.mock('../db/repos/flow-runs', () => ({
  getFlowRun: mocks.getFlowRun,
  setFlowRunStatus: mocks.setFlowRunStatus,
}));
vi.mock('../db/repos/node-runs', () => ({
  listNodeRunsForFlowRun: mocks.listNodeRunsForFlowRun,
}));
vi.mock('./advance', () => ({
  loadRunContext: mocks.loadRunContext,
  dispatchAndAdvance: mocks.dispatchAndAdvance,
}));
vi.mock('./event-emit', () => ({ emitRunStarted: mocks.emitRunStarted }));
vi.mock('./admission/runtime', () => ({
  registerFlowAdmissionStartDispatcher: mocks.registerFlowAdmissionStartDispatcher,
  registerTerminalFlowResumeDispatcher:
    mocks.registerTerminalFlowResumeDispatcher.mockImplementation((dispatcher) => {
      mocks.admittedResumeDispatcher = dispatcher;
    }),
  requestFlowStart: mocks.requestFlowStart,
  requestTerminalFlowResume: mocks.requestTerminalFlowResume,
}));

import { retryTerminalFlowRun } from './admission/terminal-resume/dispatcher';
import { startFlowRun } from './start';

const WEBHOOK = {
  id: 't',
  blockType: 'webhook_trigger',
  config: { integrationId: 'i', eventType: 'e' },
};
const STEP = { id: 'a', blockType: 'run_command', config: {} };

function graph(nodes: Array<Record<string, unknown>>) {
  return { nodes, edges: [{ id: 'edge', source: 't', target: 'a' }] };
}

beforeEach(() => {
  vi.clearAllMocks();
  mocks.getFlowById.mockResolvedValue({ id: 'flow-1', name: 'F', isEnabled: true });
  mocks.getFlowRun.mockResolvedValue({ id: 'run-1', status: 'running' });
  mocks.requestFlowStart.mockResolvedValue({
    run: { id: 'run-1', flowVersionId: 'v1' },
    admission: { ticket: 1 },
    isReplay: false,
  });
  // runFlow no-ops: loadRunContext null short-circuits before any real dispatch.
  mocks.loadRunContext.mockResolvedValue(null);
});

describe('startFlowRun — trigger selection is position-independent', () => {
  it('starts a flow whose trigger node is NOT nodes[0]', async () => {
    mocks.getLatestVersion.mockResolvedValue({ id: 'v1', graph: graph([STEP, WEBHOOK]) });

    const res = await startFlowRun({ flowId: 'flow-1', idempotencyKey: 'k1' });

    expect(res.isReplay).toBe(false);
    // Admission is only reached AFTER the trigger is found — before the fix this
    // threw "First node must be a trigger block, got run_command" and never got here.
    expect(mocks.requestFlowStart).toHaveBeenCalledTimes(1);
  });

  it('starts a flow whose trigger IS nodes[0] (control — unchanged behavior)', async () => {
    mocks.getLatestVersion.mockResolvedValue({ id: 'v1', graph: graph([WEBHOOK, STEP]) });

    const res = await startFlowRun({ flowId: 'flow-1', idempotencyKey: 'k2' });

    expect(res.isReplay).toBe(false);
    expect(mocks.requestFlowStart).toHaveBeenCalledTimes(1);
  });

  it('throws when the graph contains no trigger node at all', async () => {
    mocks.getLatestVersion.mockResolvedValue({
      id: 'v1',
      graph: graph([STEP, { id: 'b', blockType: 'agent', config: {} }]),
    });

    await expect(startFlowRun({ flowId: 'flow-1', idempotencyKey: 'k3' })).rejects.toThrow();
    expect(mocks.requestFlowStart).not.toHaveBeenCalled();
  });

  it('persists through durable admission', async () => {
    mocks.getLatestVersion.mockResolvedValue({ id: 'v1', graph: graph([WEBHOOK, STEP]) });
    mocks.requestFlowStart.mockResolvedValue({
      run: { id: 'queued-run', flowVersionId: 'v1', status: 'pending', startedAt: null },
      admission: { ticket: 4 },
      isReplay: false,
    });

    const result = await startFlowRun({
      flowId: 'flow-1',
      triggerContext: { source: 'manual' },
      idempotencyKey: 'queued-key',
      batchId: 'batch-1',
      batchStageRunId: 'bsr-1',
    });

    expect(result.run).toMatchObject({ id: 'queued-run', status: 'pending', startedAt: null });
    expect(mocks.requestFlowStart).toHaveBeenCalledWith({
      flowVersionId: 'v1',
      triggerContext: { source: 'manual' },
      idempotencyKey: 'queued-key',
      batchId: 'batch-1',
      batchStageRunId: 'bsr-1',
    });
    expect(mocks.emitRunStarted).not.toHaveBeenCalled();
  });

  it('returns the canonical pinned version for an admitted replay', async () => {
    mocks.getLatestVersion.mockResolvedValue({ id: 'v2', graph: graph([WEBHOOK, STEP]) });
    mocks.getVersion.mockResolvedValue({ id: 'v1', graph: graph([WEBHOOK, STEP]) });
    mocks.requestFlowStart.mockResolvedValue({
      run: { id: 'existing-run', flowVersionId: 'v1', status: 'running' },
      admission: null,
      isReplay: true,
    });

    const result = await startFlowRun({ flowId: 'flow-1' });

    expect(mocks.getVersion).toHaveBeenCalledWith({}, 'v1');
    expect(result).toMatchObject({ isReplay: true, version: { id: 'v1' } });
    expect(mocks.emitRunStarted).not.toHaveBeenCalled();
  });
});

const RERUN_GRAPH = {
  nodes: [
    { id: 'trigger', blockType: 'manual_trigger' },
    { id: 'setup', blockType: 'start_task' },
    { id: 'work', blockType: 'agent' },
  ],
  edges: [
    { id: 'e1', source: 'trigger', target: 'setup' },
    { id: 'e2', source: 'setup', target: 'work' },
  ],
};
const RERUN_CTX = {
  meta: { flowId: 'flow-1', flowName: 'F' },
  graph: RERUN_GRAPH,
  triggerContext: null,
  userId: 'u',
};
const nr = (nodeId: string, status: string) => ({ id: `run-${nodeId}`, nodeId, status });
const db = {} as Parameters<typeof retryTerminalFlowRun>[0];

describe('terminal Flow retry admission', () => {
  beforeEach(() => {
    mocks.loadRunContext.mockResolvedValue(RERUN_CTX);
    mocks.listNodeRunsForFlowRun.mockResolvedValue([
      nr('setup', 'completed'),
      nr('work', 'failed'),
    ]);
    mocks.requestTerminalFlowResume.mockResolvedValue({
      created: true,
      admission: { ticket: 7, state: 'queued' },
    });
  });

  it('queues the terminal retry without mutating or dispatching the run', async () => {
    await expect(retryTerminalFlowRun(db, 'run-1')).resolves.toBe(true);

    expect(mocks.requestTerminalFlowResume).toHaveBeenCalledWith({
      flowRunId: 'run-1',
      nodeRunId: 'run-work',
      continuation: true,
    });
    expect(mocks.setFlowRunStatus).not.toHaveBeenCalled();
    expect(mocks.dispatchAndAdvance).not.toHaveBeenCalled();
  });

  it('anchors a completed run to the prior fallback-node attempt', async () => {
    mocks.listNodeRunsForFlowRun.mockResolvedValue([
      nr('setup', 'completed'),
      nr('work', 'completed'),
    ]);

    await expect(retryTerminalFlowRun(db, 'run-1')).resolves.toBe(true);

    expect(mocks.requestTerminalFlowResume).toHaveBeenCalledWith({
      flowRunId: 'run-1',
      nodeRunId: 'run-work',
      continuation: true,
    });
  });

  it('dispatches an admitted retry only from its durable node-run anchor', async () => {
    expect(mocks.admittedResumeDispatcher).not.toBeNull();

    await mocks.admittedResumeDispatcher?.({
      version: 1,
      action: 'resume',
      flow_run_id: 'run-1',
      node_run_id: 'run-work',
    });

    expect(mocks.emitRunStarted).toHaveBeenCalledWith(RERUN_CTX.meta, 'run-1');
    expect(mocks.dispatchAndAdvance).toHaveBeenCalledWith(
      'run-1',
      expect.objectContaining({ id: 'work' }),
      undefined,
      RERUN_CTX,
      undefined,
      expect.any(Function),
      // A plain resume intent (no continuation flag) is the deliberate re-run lane.
      { resumeKind: 'redispatch' },
    );
  });

  it('rejects a changed canonical anchor before dispatch', async () => {
    mocks.listNodeRunsForFlowRun.mockResolvedValue([
      nr('setup', 'completed'),
      { id: 'run-work-new', nodeId: 'work', status: 'failed' },
    ]);

    await expect(
      mocks.admittedResumeDispatcher?.({
        version: 1,
        action: 'resume',
        flow_run_id: 'run-1',
        node_run_id: 'run-work',
      }),
    ).rejects.toThrow(/changed its canonical resume target/);
    expect(mocks.emitRunStarted).not.toHaveBeenCalled();
    expect(mocks.dispatchAndAdvance).not.toHaveBeenCalled();
  });
});
