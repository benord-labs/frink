import { eq } from 'drizzle-orm';
import { beforeEach, describe, expect, it, type Mock, vi } from 'vitest';
import type { FlowGraph } from '../../../shared/lib/validate-flow-graph';
import { RESTART_INTERRUPTION_REASON } from '../../../shared/types/flow';
import { getFlowRun, setFlowRunStatus } from '../db/repos/flow-runs';
import { createNodeRun, getNodeRun, setNodeRunStatus } from '../db/repos/node-runs';
import {
  createTask,
  getLatestFlowTaskForSubChat,
  getTaskById,
  recoverOrphanedTasks,
  updateTaskStatus,
} from '../db/repos/tasks';
import { batchStageRuns, batchStages, flowRuns, tasks } from '../db/schema';
import { seedFlowRun } from '../db/test-utils/flow-fixtures';
import { freshDb, type TestDb } from '../db/test-utils/fresh-db';
import { hasFlowResourceActivity, setFlowAdmissionLifecycleHooks } from './admission/activity';

// The engine reads its db via the getDatabase() singleton; point it at the per-test
// in-memory db so the guard reads (getFlowRun / listNodeRunsForFlowRun) hit seeded rows.
const holder = vi.hoisted(() => ({
  db: null as unknown,
  hasActiveFlowAdmission: vi.fn(),
  probeFlowAdmission: vi.fn(async () => ({ active: false, queuedResume: false })),
  requestTerminalFlowResume: vi.fn(),
}));
vi.mock('../db', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../db')>()),
  getDatabase: () => holder.db,
}));
// Stub the dispatch side so the happy path asserts wiring without running a real node.
vi.mock('./advance', () => ({
  loadRunContext: vi.fn(),
  dispatchAndAdvance: vi.fn(),
  advanceFlowRun: vi.fn(),
}));
vi.mock('./admission/runtime', () => ({
  hasActiveFlowAdmission: holder.hasActiveFlowAdmission,
  probeFlowAdmission: holder.probeFlowAdmission,
  requestTerminalFlowResume: holder.requestTerminalFlowResume,
}));

import { advanceFlowRun, dispatchAndAdvance, loadRunContext } from './advance';
import {
  canReviveInterruptedFlowInPlace,
  isRunRestartInterrupted,
  rerunFlowRunFromInterruption,
  resumeFailedFlowInPlace,
  resumeFlowNodeInPlace,
  resumeFlowRun,
  resumeInterruptedFlowInPlace,
} from './resume';
import { forgetAdvancedTask, stopTaskCompletionWatcher, tick } from './task-completion-watcher';

const GRAPH: FlowGraph = {
  nodes: [
    { id: 't', blockType: 'manual_trigger', position: { x: 0, y: 0 } },
    { id: 'a', blockType: 'agent', config: { instructions: 'go' }, position: { x: 0, y: 1 } },
  ],
  edges: [{ id: 'e1', source: 't', target: 'a' }],
};
describe('resumeFlowRun — admission lease', () => {
  let db: TestDb;

  beforeEach(() => {
    db = freshDb();
    holder.db = db;
    holder.hasActiveFlowAdmission.mockReset();
    (loadRunContext as Mock).mockReset();
    (loadRunContext as Mock).mockResolvedValue({ graph: GRAPH });
    (advanceFlowRun as Mock).mockReset();
    setFlowAdmissionLifecycleHooks({
      reconcile: vi.fn(async () => {}),
      requestRelease: vi.fn(async () => {}),
    });
  });

  it('rejects a legacy paused run before mutating it when no active slot exists', async () => {
    const { flowRunId } = await seedFlowRun(db, GRAPH);
    await setFlowRunStatus(db, flowRunId, 'paused');
    const nodeRun = await createNodeRun(db, {
      flowRunId,
      nodeId: 'a',
      blockType: 'agent',
      status: 'awaiting_input',
    });
    holder.hasActiveFlowAdmission.mockResolvedValue(false);

    await expect(resumeFlowRun(flowRunId, 'approve', nodeRun.id)).rejects.toThrow(
      /lost its place in the run queue/,
    );

    expect((await getFlowRun(db, flowRunId))?.status).toBe('paused');
    expect(advanceFlowRun).not.toHaveBeenCalled();
  });

  it('does not resurrect a run cancelled while its admission is being checked', async () => {
    const { flowRunId } = await seedFlowRun(db, GRAPH);
    await setFlowRunStatus(db, flowRunId, 'paused');
    const nodeRun = await createNodeRun(db, {
      flowRunId,
      nodeId: 'a',
      blockType: 'agent',
      status: 'awaiting_input',
    });
    holder.hasActiveFlowAdmission.mockImplementationOnce(async () => {
      await setFlowRunStatus(db, flowRunId, 'cancelled', {}, 'running');
      return false;
    });

    await expect(resumeFlowRun(flowRunId, 'approve', nodeRun.id)).rejects.toThrow(
      /lost its place in the run queue/,
    );

    expect((await getFlowRun(db, flowRunId))?.status).toBe('cancelled');
    expect(advanceFlowRun).not.toHaveBeenCalled();
  });

  it('does not dispatch when cancellation wins after an active-admission check', async () => {
    const { flowRunId } = await seedFlowRun(db, GRAPH);
    await setFlowRunStatus(db, flowRunId, 'paused');
    const nodeRun = await createNodeRun(db, {
      flowRunId,
      nodeId: 'a',
      blockType: 'agent',
      status: 'awaiting_input',
    });
    holder.hasActiveFlowAdmission.mockImplementationOnce(async () => {
      await setFlowRunStatus(db, flowRunId, 'cancelled', {}, 'running');
      return true;
    });

    await expect(resumeFlowRun(flowRunId, 'retry', nodeRun.id)).rejects.toThrow(
      /changed while it was being resumed/,
    );

    expect((await getFlowRun(db, flowRunId))?.status).toBe('cancelled');
    expect(dispatchAndAdvance).not.toHaveBeenCalled();
  });

  it('holds Flow resource activity until retry dispatch settles', async () => {
    const { flowRunId } = await seedFlowRun(db, GRAPH);
    await setFlowRunStatus(db, flowRunId, 'paused');
    const nodeRun = await createNodeRun(db, {
      flowRunId,
      nodeId: 'a',
      blockType: 'agent',
      status: 'awaiting_input',
    });
    holder.hasActiveFlowAdmission.mockResolvedValue(true);
    (dispatchAndAdvance as Mock).mockImplementationOnce(async () => {
      expect(hasFlowResourceActivity(flowRunId)).toBe(true);
    });

    await resumeFlowRun(flowRunId, 'retry', nodeRun.id);

    expect(dispatchAndAdvance).toHaveBeenCalledOnce();
    expect(dispatchAndAdvance).toHaveBeenCalledWith(
      flowRunId,
      GRAPH.nodes[1],
      undefined,
      expect.anything(),
      undefined,
      expect.any(Function),
      undefined,
    );
    expect(hasFlowResourceActivity(flowRunId)).toBe(false);
  });

  it('preserves the Fan Out item scope when retrying one branch', async () => {
    const { flowRunId } = await seedFlowRun(db, GRAPH);
    await setFlowRunStatus(db, flowRunId, 'paused');
    const parent = await createNodeRun(db, {
      flowRunId,
      nodeId: 'fan',
      blockType: 'fan_out',
      status: 'completed',
    });
    const nodeRun = await createNodeRun(db, {
      flowRunId,
      nodeId: 'a',
      blockType: 'agent',
      status: 'awaiting_input',
      laneIndex: 3,
      parentFanOutNodeRunId: parent.id,
    });
    holder.hasActiveFlowAdmission.mockResolvedValue(true);
    vi.mocked(dispatchAndAdvance).mockReset().mockResolvedValue(undefined);

    await resumeFlowRun(flowRunId, 'retry', nodeRun.id);

    expect(dispatchAndAdvance).toHaveBeenCalledWith(
      flowRunId,
      GRAPH.nodes[1],
      undefined,
      expect.anything(),
      undefined,
      expect.any(Function),
      { laneIndex: 3, parentFanOutNodeRunId: parent.id },
    );
  });
});

describe('recoverOrphanedTasks — restart interruption is neutral, not an error', () => {
  let db: TestDb;
  beforeEach(() => {
    db = freshDb();
  });

  it('marks a running task cancelled and stamps the restart marker', async () => {
    const task = await createTask(db, { description: 'agent', source: 'flow' });
    await updateTaskStatus(db, task.id, 'running');

    const recoveredRows = await recoverOrphanedTasks(db, new Date(Date.now() + 10_000));
    expect(recoveredRows).toEqual([expect.objectContaining({ id: task.id })]);

    const recovered = await getTaskById(db, task.id);
    expect(recovered?.status).toBe('cancelled');
    expect((recovered?.result as { error?: string } | null)?.error).toBe(
      RESTART_INTERRUPTION_REASON,
    );
  });

  it('MERGES the restart marker, keeping the sub-chat linkage the resume path needs', async () => {
    // The sweep used to REPLACE result, wiping result.subChatId — the ONLY link
    // getLatestFlowTaskForSubChat has. The cancelled task then became invisible from its own
    // sub-chat, so the chat-reply revive this Target documents could not find it, and the flow-chat
    // surface could not tell a restart interruption (composer + Resume) from a live taskless window
    // (running strip). Verified at the seam: the sweep's writer against that reader.
    const task = await createTask(db, {
      description: 'agent',
      source: 'flow',
      result: { subChatId: 'sc-restart', startMode: 'plan' },
    });
    await updateTaskStatus(db, task.id, 'running', {
      result: { subChatId: 'sc-restart', startMode: 'plan' },
    });

    expect(await recoverOrphanedTasks(db, new Date(Date.now() + 10_000))).toHaveLength(1);

    expect((await getTaskById(db, task.id))?.result).toMatchObject({
      subChatId: 'sc-restart',
      startMode: 'plan',
      cancelled: true,
      error: RESTART_INTERRUPTION_REASON,
    });
    const latest = await getLatestFlowTaskForSubChat(db, 'sc-restart');
    expect(latest).toMatchObject({ id: task.id, status: 'cancelled' });
  });

  it('sweeps a running task that already carries a stale completed_at (lease re-claim race)', async () => {
    // Regression: a re-claim can leave the row `running` with a completed_at stamped (even one that
    // predates started_at). The boot sweep must still recover it — guarding on completed_at IS NULL
    // would skip exactly this row and strand the flow forever.
    const task = await createTask(db, { description: 'agent', source: 'flow' });
    await updateTaskStatus(db, task.id, 'running');
    await db
      .update(tasks)
      .set({ startedAt: new Date(2_000), completedAt: new Date(1_000) })
      .where(eq(tasks.id, task.id));

    expect(await recoverOrphanedTasks(db, new Date(Date.now() + 10_000))).toHaveLength(1);
    expect((await getTaskById(db, task.id))?.status).toBe('cancelled');
  });

  it('does NOT sweep a running task started after the boot cutoff (a live, current-process run)', async () => {
    // The startedAt<cutoff guard is the only thing protecting a genuinely live run once the
    // completed_at guard is gone. A task started after boot must survive the sweep.
    const task = await createTask(db, { description: 'agent', source: 'flow' });
    await updateTaskStatus(db, task.id, 'running');
    await db
      .update(tasks)
      .set({ startedAt: new Date(Date.now() + 60_000) })
      .where(eq(tasks.id, task.id));

    expect(await recoverOrphanedTasks(db, new Date())).toEqual([]);
    expect((await getTaskById(db, task.id))?.status).toBe('running');
  });
});

describe('rerunFlowRunFromInterruption — guards', () => {
  let db: TestDb;
  beforeEach(() => {
    db = freshDb();
    holder.db = db;
    holder.requestTerminalFlowResume.mockReset();
    (loadRunContext as Mock).mockReset();
    (dispatchAndAdvance as Mock).mockReset();
  });

  async function seedCancelledRun(): Promise<string> {
    const { flowRunId } = await seedFlowRun(db, GRAPH);
    await setFlowRunStatus(db, flowRunId, 'cancelled', { completedAt: new Date() });
    return flowRunId;
  }

  async function seedInterruptedNode(flowRunId: string): Promise<string> {
    const node = await createNodeRun(db, {
      flowRunId,
      nodeId: 'a',
      blockType: 'agent',
      status: 'running',
    });
    await setNodeRunStatus(db, node.id, 'cancelled', {
      nodeOutput: {
        status: 'cancelled',
        outputs: {},
        artifacts: [],
        durationMs: 0,
        error: { message: RESTART_INTERRUPTION_REASON, retryable: true },
      },
      completedAt: new Date(),
    });
    return node.id;
  }

  it('queues the marked interrupted node without reviving it', async () => {
    const flowRunId = await seedCancelledRun();
    const nodeRunId = await seedInterruptedNode(flowRunId);
    holder.requestTerminalFlowResume.mockResolvedValue({
      created: true,
      admission: { ticket: 9, state: 'queued' },
    });

    await rerunFlowRunFromInterruption(flowRunId);

    expect(holder.requestTerminalFlowResume).toHaveBeenCalledWith({
      flowRunId,
      nodeRunId,
    });
    expect(loadRunContext).not.toHaveBeenCalled();
    expect(dispatchAndAdvance).not.toHaveBeenCalled();
    expect((await getFlowRun(db, flowRunId))?.status).toBe('cancelled');
  });

  it('rejects a run that does not exist', async () => {
    await expect(rerunFlowRunFromInterruption('nope')).rejects.toThrow(/not found/i);
  });

  it('rejects a run that is not cancelled (still running)', async () => {
    const { flowRunId } = await seedFlowRun(db, GRAPH); // running
    await expect(rerunFlowRunFromInterruption(flowRunId)).rejects.toThrow(
      /interrupted \(cancelled\)/i,
    );
  });

  it('rejects a cancelled run with no interrupted node', async () => {
    const flowRunId = await seedCancelledRun();
    await expect(rerunFlowRunFromInterruption(flowRunId)).rejects.toThrow(/no interrupted node/i);
  });

  it('rejects a user-cancelled run (interrupted node lacks the restart marker)', async () => {
    const flowRunId = await seedCancelledRun();
    const node = await createNodeRun(db, {
      flowRunId,
      nodeId: 'a',
      blockType: 'agent',
      status: 'running',
    });
    await setNodeRunStatus(db, node.id, 'cancelled', {
      nodeOutput: { status: 'cancelled', outputs: {}, artifacts: [], durationMs: 0 },
      completedAt: new Date(),
    });
    await expect(rerunFlowRunFromInterruption(flowRunId)).rejects.toThrow(/cancelled by the user/i);
  });

  it('queues re-run from a contained Fan Out node', async () => {
    const flowRunId = await seedCancelledRun();
    const parent = await createNodeRun(db, {
      flowRunId,
      nodeId: 'fan',
      blockType: 'fan_out',
      status: 'completed',
    });
    const lane = await createNodeRun(db, {
      flowRunId,
      nodeId: 'a',
      blockType: 'agent',
      status: 'running',
      parentFanOutNodeRunId: parent.id,
      laneIndex: 0,
    });
    await setNodeRunStatus(db, parent.id, 'completed', { completedAt: new Date() });
    await setNodeRunStatus(db, lane.id, 'cancelled', {
      nodeOutput: {
        status: 'cancelled',
        outputs: {},
        artifacts: [],
        durationMs: 0,
        error: { message: RESTART_INTERRUPTION_REASON, retryable: true },
      },
      completedAt: new Date(),
    });
    holder.requestTerminalFlowResume.mockResolvedValue({
      created: true,
      admission: { ticket: 10, state: 'queued' },
    });
    await rerunFlowRunFromInterruption(flowRunId);
    expect(holder.requestTerminalFlowResume).toHaveBeenCalledWith({
      flowRunId,
      nodeRunId: lane.id,
    });
  });
});

describe('resumeFlowNodeInPlace — unpark an agent node after a chat follow-up', () => {
  let db: TestDb;
  beforeEach(() => {
    db = freshDb();
    holder.db = db;
    (loadRunContext as Mock).mockReset(); // returns undefined → emit branch skipped (assert state only)
  });

  async function seedPausedAgentNode(
    status: 'awaiting_input' | 'blocked' = 'awaiting_input',
  ): Promise<{ flowRunId: string; nodeRunId: string }> {
    const { flowRunId } = await seedFlowRun(db, GRAPH);
    await setFlowRunStatus(db, flowRunId, 'paused');
    const node = await createNodeRun(db, { flowRunId, nodeId: 'a', blockType: 'agent', status });
    return { flowRunId, nodeRunId: node.id };
  }

  it('flips the node_run and flow_run back to running', async () => {
    const { flowRunId, nodeRunId } = await seedPausedAgentNode();
    expect(await resumeFlowNodeInPlace(flowRunId, nodeRunId)).toBe(true);
    expect((await getNodeRun(db, nodeRunId))?.status).toBe('running');
    expect((await getFlowRun(db, flowRunId))?.status).toBe('running');
  });

  it('unparks a blocked node too', async () => {
    const { flowRunId, nodeRunId } = await seedPausedAgentNode('blocked');
    expect(await resumeFlowNodeInPlace(flowRunId, nodeRunId)).toBe(true);
    expect((await getNodeRun(db, nodeRunId))?.status).toBe('running');
  });

  it('emits run/node started events when the run context resolves (canvas refresh path)', async () => {
    const { flowRunId, nodeRunId } = await seedPausedAgentNode();
    (loadRunContext as Mock).mockResolvedValue({
      meta: { flowId: 'f', flowName: 'F' },
      graph: { nodes: [{ id: 'a', blockType: 'agent' }], edges: [] },
      triggerContext: null,
      userId: 'u1',
    });
    expect(await resumeFlowNodeInPlace(flowRunId, nodeRunId)).toBe(true);
    expect((await getNodeRun(db, nodeRunId))?.status).toBe('running');
    expect((await getFlowRun(db, flowRunId))?.status).toBe('running');
  });

  it('no-ops when the run is not paused', async () => {
    const { flowRunId } = await seedFlowRun(db, GRAPH); // running
    const node = await createNodeRun(db, {
      flowRunId,
      nodeId: 'a',
      blockType: 'agent',
      status: 'awaiting_input',
    });
    expect(await resumeFlowNodeInPlace(flowRunId, node.id)).toBe(false);
    expect((await getNodeRun(db, node.id))?.status).toBe('awaiting_input');
  });

  it('no-ops (CAS miss) when the node is already running — guards double-fire', async () => {
    const { flowRunId } = await seedFlowRun(db, GRAPH);
    await setFlowRunStatus(db, flowRunId, 'paused');
    const node = await createNodeRun(db, {
      flowRunId,
      nodeId: 'a',
      blockType: 'agent',
      status: 'running',
    });
    expect(await resumeFlowNodeInPlace(flowRunId, node.id)).toBe(false);
    expect((await getFlowRun(db, flowRunId))?.status).toBe('paused');
  });

  it('unparks one Fan Out branch without changing its sibling', async () => {
    const { flowRunId } = await seedFlowRun(db, GRAPH);
    await setFlowRunStatus(db, flowRunId, 'paused');
    const parent = await createNodeRun(db, {
      flowRunId,
      nodeId: 'fan',
      blockType: 'fan_out',
      status: 'running',
    });
    const lane = await createNodeRun(db, {
      flowRunId,
      nodeId: 'a',
      blockType: 'agent',
      status: 'awaiting_input',
      parentFanOutNodeRunId: parent.id,
      laneIndex: 0,
    });
    const sibling = await createNodeRun(db, {
      flowRunId,
      nodeId: 'b',
      blockType: 'agent',
      status: 'awaiting_input',
      parentFanOutNodeRunId: parent.id,
      laneIndex: 0,
    });
    expect(await resumeFlowNodeInPlace(flowRunId, lane.id)).toBe(true);
    expect((await getNodeRun(db, lane.id))?.status).toBe('running');
    expect((await getNodeRun(db, sibling.id))?.status).toBe('awaiting_input');
    expect((await getFlowRun(db, flowRunId))?.status).toBe('paused');

    expect(await resumeFlowNodeInPlace(flowRunId, sibling.id)).toBe(true);
    expect((await getFlowRun(db, flowRunId))?.status).toBe('running');
  });
});

describe('resumeFailedFlowInPlace — failed-run retry unpark (non-batch only)', () => {
  let db: TestDb;
  beforeEach(() => {
    db = freshDb();
    holder.db = db;
    (loadRunContext as Mock).mockReset();
    // These cases exercise the unpark itself; the lease gate below has its own decline case.
    holder.hasActiveFlowAdmission.mockReset().mockResolvedValue(true);
  });

  // Same lease rule as the interrupted revive: a terminal run's slot is settled, and flipping it
  // live anyway would strand it paused-without-slot at the next preflight rejection. Declining
  // leaves the run terminal, where Retry re-admits through a durable resume ticket.
  it('declines when the run no longer holds its admission slot', async () => {
    const { flowRunId, nodeRunId } = await seedFailedRun();
    holder.hasActiveFlowAdmission.mockResolvedValue(false);

    expect(await resumeFailedFlowInPlace(flowRunId, 'task-1')).toBe(false);
    expect((await getNodeRun(db, nodeRunId))?.status).toBe('failed');
    expect((await getFlowRun(db, flowRunId))?.status).toBe('failed');
  });

  // The probe is only check-then-act safe under a held reservation — settlement defers while
  // activity is live, so the slot the probe saw cannot settle before the unpark writes.
  it('holds a flow-resource reservation across the probe and unpark', async () => {
    const { flowRunId } = await seedFailedRun();
    holder.hasActiveFlowAdmission.mockImplementation(async () => {
      expect(hasFlowResourceActivity(flowRunId)).toBe(true);
      return true;
    });

    expect(await resumeFailedFlowInPlace(flowRunId, 'task-1')).toBe(true);
    expect(hasFlowResourceActivity(flowRunId)).toBe(false);
  });

  async function seedFailedRun(): Promise<{ flowRunId: string; nodeRunId: string }> {
    const { flowRunId } = await seedFlowRun(db, GRAPH);
    const node = await createNodeRun(db, {
      flowRunId,
      nodeId: 'a',
      blockType: 'agent',
      status: 'running',
    });
    await setNodeRunStatus(db, node.id, 'failed', { completedAt: new Date() });
    await setFlowRunStatus(db, flowRunId, 'failed', { completedAt: new Date() });
    return { flowRunId, nodeRunId: node.id };
  }

  it('CAS-flips the failed node_run + flow_run back to running', async () => {
    const { flowRunId, nodeRunId } = await seedFailedRun();

    expect(await resumeFailedFlowInPlace(flowRunId, 'task-1')).toBe(true);
    expect((await getNodeRun(db, nodeRunId))?.status).toBe('running');
    expect((await getFlowRun(db, flowRunId))?.status).toBe('running');
  });

  it('refuses a batch-member run whose stage-run was not pre-opened by carry-on', async () => {
    const { flowRunId, nodeRunId } = await seedFailedRun();
    await db.update(flowRuns).set({ batchId: 'b1' }).where(eq(flowRuns.id, flowRunId));

    expect(await resumeFailedFlowInPlace(flowRunId)).toBe(false);
    expect((await getNodeRun(db, nodeRunId))?.status).toBe('failed');
    expect((await getFlowRun(db, flowRunId))?.status).toBe('failed');
  });

  it('unparks a batch member once carry-on pre-opened its stage-run to dispatched', async () => {
    const { flowRunId, nodeRunId } = await seedFailedRun();
    await db.update(flowRuns).set({ batchId: 'b1' }).where(eq(flowRuns.id, flowRunId));
    const [stage] = await db
      .insert(batchStages)
      .values({ batchId: 'b1', stageNumber: 1 })
      .returning();
    await db.insert(batchStageRuns).values({ stageId: stage.id, flowRunId, status: 'dispatched' });

    expect(await resumeFailedFlowInPlace(flowRunId, 'task-1')).toBe(true);
    expect((await getNodeRun(db, nodeRunId))?.status).toBe('running');
    expect((await getFlowRun(db, flowRunId))?.status).toBe('running');
  });

  it('refuses when the run is still running', async () => {
    const { flowRunId } = await seedFlowRun(db, GRAPH); // running
    expect(await resumeFailedFlowInPlace(flowRunId)).toBe(false);
  });

  it('revives a boot-sweep-cancelled run (restart marker present) when the user retries its failed task', async () => {
    // Race: the task failed, then a restart sweep flipped run + node to cancelled before the
    // user clicked Retry. The sweep stamps the restart marker — that marker is what makes the
    // cancelled run recoverable here.
    const { flowRunId } = await seedFlowRun(db, GRAPH);
    const node = await createNodeRun(db, {
      flowRunId,
      nodeId: 'a',
      blockType: 'agent',
      status: 'running',
    });
    await setNodeRunStatus(db, node.id, 'cancelled', {
      completedAt: new Date(),
      nodeOutput: {
        status: 'cancelled',
        outputs: {},
        artifacts: [],
        durationMs: 0,
        error: { message: RESTART_INTERRUPTION_REASON },
      },
    });
    await setFlowRunStatus(db, flowRunId, 'cancelled', { completedAt: new Date() });

    expect(await resumeFailedFlowInPlace(flowRunId, 'task-1')).toBe(true);
    expect((await getNodeRun(db, node.id))?.status).toBe('running');
    expect((await getFlowRun(db, flowRunId))?.status).toBe('running');
  });

  it('refuses a DELIBERATELY cancelled run (no restart marker) — retry must not resurrect it', async () => {
    // A user-initiated cancel carries no restart marker. Retrying an older failed task of that
    // run must not flip the cancelled run back to running behind the user's back.
    const { flowRunId } = await seedFlowRun(db, GRAPH);
    const node = await createNodeRun(db, {
      flowRunId,
      nodeId: 'a',
      blockType: 'agent',
      status: 'running',
    });
    await setNodeRunStatus(db, node.id, 'cancelled', { completedAt: new Date() });
    await setFlowRunStatus(db, flowRunId, 'cancelled', { completedAt: new Date() });

    expect(await resumeFailedFlowInPlace(flowRunId, 'task-1')).toBe(false);
    expect((await getNodeRun(db, node.id))?.status).toBe('cancelled');
    expect((await getFlowRun(db, flowRunId))?.status).toBe('cancelled');
  });

  it('unparks a paused run whose node is awaiting_input (api-error/usage-limit park shape)', async () => {
    const { flowRunId } = await seedFlowRun(db, GRAPH);
    const node = await createNodeRun(db, {
      flowRunId,
      nodeId: 'a',
      blockType: 'agent',
      status: 'running',
    });
    await setNodeRunStatus(db, node.id, 'awaiting_input');
    await setFlowRunStatus(db, flowRunId, 'paused');

    expect(await resumeFailedFlowInPlace(flowRunId)).toBe(true);
    expect((await getNodeRun(db, node.id))?.status).toBe('running');
    expect((await getFlowRun(db, flowRunId))?.status).toBe('running');
  });

  it('unparks a failed contained Fan Out node', async () => {
    const { flowRunId } = await seedFlowRun(db, GRAPH);
    const parent = await createNodeRun(db, {
      flowRunId,
      nodeId: 't',
      blockType: 'fan_out',
      status: 'running',
    });
    const lane = await createNodeRun(db, {
      flowRunId,
      nodeId: 'a',
      blockType: 'agent',
      status: 'running',
      parentFanOutNodeRunId: parent.id,
      laneIndex: 0,
    });
    await setNodeRunStatus(db, parent.id, 'completed', { completedAt: new Date() });
    await setNodeRunStatus(db, lane.id, 'failed', { completedAt: new Date() });
    await setFlowRunStatus(db, flowRunId, 'failed', { completedAt: new Date() });

    expect(await resumeFailedFlowInPlace(flowRunId)).toBe(true);
    expect((await getNodeRun(db, lane.id))?.status).toBe('running');
  });
});

describe('resumeInterruptedFlowInPlace / isRunRestartInterrupted — cancelled-run chat resume', () => {
  let db: TestDb;
  beforeEach(() => {
    db = freshDb();
    holder.db = db;
    (loadRunContext as Mock).mockReset(); // undefined → emit branch skipped; assert state only
    // Default: the run still holds its slot (the activity-held window), so the wake is legal.
    holder.hasActiveFlowAdmission.mockReset().mockResolvedValue(true);
  });

  async function seedInterruptedCancelledRun(opts: {
    marker: boolean;
  }): Promise<{ flowRunId: string; nodeRunId: string }> {
    const { flowRunId } = await seedFlowRun(db, GRAPH);
    await setFlowRunStatus(db, flowRunId, 'cancelled', { completedAt: new Date() });
    const node = await createNodeRun(db, {
      flowRunId,
      nodeId: 'a',
      blockType: 'agent',
      status: 'running',
    });
    await setNodeRunStatus(db, node.id, 'cancelled', {
      nodeOutput: {
        status: 'cancelled',
        outputs: {},
        artifacts: [],
        durationMs: 0,
        ...(opts.marker
          ? { error: { message: RESTART_INTERRUPTION_REASON, retryable: true } }
          : {}),
      },
      completedAt: new Date(),
    });
    return { flowRunId, nodeRunId: node.id };
  }

  it('flips a marked-cancelled run + its interrupted node back to running, clearing the marker', async () => {
    const { flowRunId, nodeRunId } = await seedInterruptedCancelledRun({ marker: true });
    expect(await resumeInterruptedFlowInPlace(flowRunId)).toBe(true);
    expect((await getFlowRun(db, flowRunId))?.status).toBe('running');
    const node = await getNodeRun(db, nodeRunId);
    expect(node?.status).toBe('running');
    expect(node?.nodeOutput).toBeNull();
  });

  it('does NOT re-dispatch (in-place only) — leaves the agent turn to drive the work', async () => {
    const { flowRunId } = await seedInterruptedCancelledRun({ marker: true });
    await resumeInterruptedFlowInPlace(flowRunId);
    expect(dispatchAndAdvance).not.toHaveBeenCalled();
  });

  // The pre-flip probe the executor's revive keys on: same three gates as the unpark itself, so
  // "probe said yes" and "unpark would act" cannot drift apart.
  it('canRevive mirrors the unpark gates: marker + cancelled + live slot', async () => {
    const { flowRunId } = await seedInterruptedCancelledRun({ marker: true });
    expect(await canReviveInterruptedFlowInPlace(flowRunId)).toBe(true);
    holder.hasActiveFlowAdmission.mockResolvedValue(false);
    expect(await canReviveInterruptedFlowInPlace(flowRunId)).toBe(false);
  });

  it('canRevive declines a user-cancelled run (no marker)', async () => {
    const { flowRunId } = await seedInterruptedCancelledRun({ marker: false });
    expect(await canReviveInterruptedFlowInPlace(flowRunId)).toBe(false);
  });

  // A wake continues the run WITHOUT re-admitting: once the slot has settled, flipping the run
  // live would get the turn rejected at the provider preflight and the failure park would strand
  // it `paused` with no slot. Declining routes recovery to the re-dispatch path, which re-admits.
  it('declines when the run no longer holds its active admission slot', async () => {
    holder.hasActiveFlowAdmission.mockResolvedValue(false);
    const { flowRunId, nodeRunId } = await seedInterruptedCancelledRun({ marker: true });
    expect(await resumeInterruptedFlowInPlace(flowRunId)).toBe(false);
    expect((await getFlowRun(db, flowRunId))?.status).toBe('cancelled');
    expect((await getNodeRun(db, nodeRunId))?.status).toBe('cancelled');
  });

  it('no-ops on a user-cancelled run (interrupted node lacks the marker)', async () => {
    const { flowRunId, nodeRunId } = await seedInterruptedCancelledRun({ marker: false });
    expect(await resumeInterruptedFlowInPlace(flowRunId)).toBe(false);
    expect((await getFlowRun(db, flowRunId))?.status).toBe('cancelled');
    expect((await getNodeRun(db, nodeRunId))?.status).toBe('cancelled');
  });

  it('no-ops when the run is not cancelled (a paused/running run uses resumeFlowNodeInPlace)', async () => {
    const { flowRunId } = await seedFlowRun(db, GRAPH); // running
    expect(await resumeInterruptedFlowInPlace(flowRunId)).toBe(false);
  });

  it('is idempotent — a second resume no-ops once the run is already running (double message / click)', async () => {
    const { flowRunId } = await seedInterruptedCancelledRun({ marker: true });
    expect(await resumeInterruptedFlowInPlace(flowRunId)).toBe(true);
    // The run is no longer cancelled, so a racing/duplicate follow-up does not re-flip or re-advance.
    expect(await resumeInterruptedFlowInPlace(flowRunId)).toBe(false);
    expect((await getFlowRun(db, flowRunId))?.status).toBe('running');
  });

  it('resumes the LAST non-completed node, leaving an already-completed upstream node untouched', async () => {
    const { flowRunId } = await seedFlowRun(db, GRAPH);
    await setFlowRunStatus(db, flowRunId, 'cancelled', { completedAt: new Date() });
    const upstream = await createNodeRun(db, {
      flowRunId,
      nodeId: 'up',
      blockType: 'agent',
      status: 'running',
    });
    await setNodeRunStatus(db, upstream.id, 'completed', {
      nodeOutput: { status: 'completed', outputs: {}, artifacts: [], durationMs: 0 },
      completedAt: new Date(),
    });
    const interrupted = await createNodeRun(db, {
      flowRunId,
      nodeId: 'a',
      blockType: 'agent',
      status: 'running',
    });
    await setNodeRunStatus(db, interrupted.id, 'cancelled', {
      nodeOutput: {
        status: 'cancelled',
        outputs: {},
        artifacts: [],
        durationMs: 0,
        error: { message: RESTART_INTERRUPTION_REASON, retryable: true },
      },
      completedAt: new Date(),
    });

    expect(await resumeInterruptedFlowInPlace(flowRunId)).toBe(true);
    expect((await getNodeRun(db, interrupted.id))?.status).toBe('running');
    expect((await getNodeRun(db, upstream.id))?.status).toBe('completed');
  });

  it('resumes a contained Fan Out node interrupted by restart', async () => {
    const { flowRunId } = await seedFlowRun(db, GRAPH);
    await setFlowRunStatus(db, flowRunId, 'cancelled', { completedAt: new Date() });
    const parent = await createNodeRun(db, {
      flowRunId,
      nodeId: 'fan',
      blockType: 'fan_out',
      status: 'running',
    });
    const lane = await createNodeRun(db, {
      flowRunId,
      nodeId: 'a',
      blockType: 'agent',
      status: 'running',
      parentFanOutNodeRunId: parent.id,
      laneIndex: 0,
    });
    await setNodeRunStatus(db, parent.id, 'completed', { completedAt: new Date() });
    await setNodeRunStatus(db, lane.id, 'cancelled', {
      nodeOutput: {
        status: 'cancelled',
        outputs: {},
        artifacts: [],
        durationMs: 0,
        error: { message: RESTART_INTERRUPTION_REASON, retryable: true },
      },
      completedAt: new Date(),
    });

    expect(await resumeInterruptedFlowInPlace(flowRunId)).toBe(true);
    expect((await getFlowRun(db, flowRunId))?.status).toBe('running');
  });

  // Split per case: seedFlowRun can only run once per db (projects.path is unique).
  it('isRunRestartInterrupted is true for a marked-cancelled run', async () => {
    const { flowRunId } = await seedInterruptedCancelledRun({ marker: true });
    expect(await isRunRestartInterrupted(flowRunId)).toBe(true);
  });

  it('isRunRestartInterrupted is false for a user-cancelled run (no marker)', async () => {
    const { flowRunId } = await seedInterruptedCancelledRun({ marker: false });
    expect(await isRunRestartInterrupted(flowRunId)).toBe(false);
  });

  it('isRunRestartInterrupted is false for a non-cancelled (running) run', async () => {
    const { flowRunId } = await seedFlowRun(db, GRAPH);
    expect(await isRunRestartInterrupted(flowRunId)).toBe(false);
  });
});

describe('resume-in-place + watcher re-advance — the parked→resume→done→advance loop', () => {
  let db: TestDb;
  beforeEach(() => {
    db = freshDb();
    holder.db = db;
    (advanceFlowRun as Mock).mockReset();
    stopTaskCompletionWatcher(); // clears the watcher's module-level advanced-set between tests
  });

  async function seedParkedFlowTask(): Promise<{ flowRunId: string; taskId: string }> {
    const { flowRunId } = await seedFlowRun(db, GRAPH);
    const node = await createNodeRun(db, {
      flowRunId,
      nodeId: 'a',
      blockType: 'agent',
      status: 'running',
    });
    const task = await createTask(db, {
      description: 'agent',
      source: 'flow',
      flowRunId,
      nodeRunId: node.id,
      result: { agentSignal: { state: 'awaiting_input', summary: 'parked' } },
    });
    await updateTaskStatus(db, task.id, 'needs_attention');
    return { flowRunId, taskId: task.id };
  }

  it('forgetAdvancedTask (via resume-in-place) lets the watcher advance the task on its later done', async () => {
    const { taskId } = await seedParkedFlowTask();

    // 1) First park: watcher advances (awaiting_input) and records the task in the advanced-set.
    await tick();
    expect(advanceFlowRun).toHaveBeenCalledTimes(1);

    // 2) Agent resumes + signals done — WITHOUT eviction the watcher dedups it (the stuck-flow bug).
    await updateTaskStatus(db, taskId, 'done', {
      result: { agentSignal: { state: 'done', summary: 'implemented' } },
    });
    await tick();
    expect(advanceFlowRun).toHaveBeenCalledTimes(1);

    // 3) resume-in-place evicts the task → the next tick advances the `done`.
    forgetAdvancedTask(taskId);
    await tick();
    expect(advanceFlowRun).toHaveBeenCalledTimes(2);
  });
});
