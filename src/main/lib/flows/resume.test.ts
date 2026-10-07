import { eq } from 'drizzle-orm';
import { beforeEach, describe, expect, it, type Mock, vi } from 'vitest';
import type { FlowGraph } from '../../../shared/lib/validate-flow-graph';
import { RESTART_INTERRUPTION_REASON } from '../../../shared/types/flow';
import type { FlowResumeSnapshot } from '../../../shared/types/flow-run/resume';
import { getFlowRun, setFlowRunStatus } from '../db/repos/flow-runs';
import { createNodeRun, getNodeRun, setNodeRunStatus } from '../db/repos/node-runs';
import {
  createTask,
  getLatestFlowTaskForSubChat,
  getTaskById,
  recoverOrphanedTasks,
  updateTaskStatus,
} from '../db/repos/tasks';
import {
  batchStageRuns,
  batchStages,
  chats,
  flowRunAdmissions,
  flowRuns,
  subChatMessages,
  subChats,
  tasks,
} from '../db/schema';
import { seedActiveAdmission, seedFlowRun } from '../db/test-utils/flow-fixtures';
import { freshDb, type TestDb } from '../db/test-utils/fresh-db';
import { unparkFlowInPlace } from '../tasks';
import { hasFlowResourceActivity, setFlowAdmissionLifecycleHooks } from './admission/activity';

// The engine reads its db via the getDatabase() singleton; point it at the per-test
// in-memory db so the guard reads (getFlowRun / listNodeRunsForFlowRun) hit seeded rows.
const holder = vi.hoisted(() => ({
  db: null as unknown,
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
// Commands run through the real admission transaction; each test's controller binds its own db.
vi.mock('./admission/runtime', async (importOriginal) => ({
  ...(await importOriginal<typeof import('./admission/runtime')>()),
  probeFlowAdmission: holder.probeFlowAdmission,
  requestTerminalFlowResume: holder.requestTerminalFlowResume,
}));

import { _setFlowAdmissionControllerForTests } from './admission/runtime';
import { advanceFlowRun, dispatchAndAdvance, loadRunContext } from './advance';
import { isRunRestartInterrupted, resumeFailedFlowInPlace, resumeFlowRun } from './resume';
import { forgetAdvancedTask, stopTaskCompletionWatcher, tick } from './task-completion-watcher';

beforeEach(() => _setFlowAdmissionControllerForTests(null));

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
    (loadRunContext as Mock).mockReset();
    (loadRunContext as Mock).mockResolvedValue({ graph: GRAPH });
    (advanceFlowRun as Mock).mockReset();
    setFlowAdmissionLifecycleHooks({
      reconcile: vi.fn(async () => {}),
      requestRelease: vi.fn(async () => {}),
    });
  });

  it('refuses snapshot-based retry before changing the paused run', async () => {
    const { flowRunId } = await seedFlowRun(db, GRAPH);
    await setFlowRunStatus(db, flowRunId, 'paused');
    const node = await createNodeRun(db, {
      flowRunId,
      nodeId: 'a',
      blockType: 'agent',
      status: 'failed',
    });
    const snapshot: FlowResumeSnapshot = {
      status: 'failed',
      nodeOutput: null,
      startedAt: null,
      completedAt: null,
      attemptIds: [node.id],
    };
    await expect(resumeFlowRun(flowRunId, 'retry', node.id, snapshot)).rejects.toMatchObject({
      code: 'BAD_REQUEST',
      message: 'Retry this step on your computer.',
    });
    expect((await getFlowRun(db, flowRunId))?.status).toBe('paused');
    expect((await getNodeRun(db, node.id))?.status).toBe('failed');
    expect(loadRunContext).not.toHaveBeenCalled();
    expect(advanceFlowRun).not.toHaveBeenCalled();
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

    await expect(resumeFlowRun(flowRunId, 'approve', nodeRun.id)).rejects.toThrow(
      /lost its place in the run queue/,
    );

    expect((await getFlowRun(db, flowRunId))?.status).toBe('paused');
    expect(advanceFlowRun).not.toHaveBeenCalled();
  });

  it('rejects a stale node after another client advances and pauses the run elsewhere', async () => {
    const { flowRunId } = await seedFlowRun(db, GRAPH);
    await setFlowRunStatus(db, flowRunId, 'paused');
    const node = await createNodeRun(db, {
      flowRunId,
      nodeId: 'a',
      blockType: 'agent',
      status: 'awaiting_input',
    });
    (loadRunContext as Mock).mockImplementationOnce(async () => {
      await setNodeRunStatus(db, node.id, 'completed');
      return { graph: GRAPH };
    });
    await expect(resumeFlowRun(flowRunId, 'approve', node.id)).rejects.toThrow('already changed');
    expect((await getFlowRun(db, flowRunId))?.status).toBe('paused');
    expect(advanceFlowRun).not.toHaveBeenCalled();
  });

  // A second pane (or a double-click) still showing the old attempt's Retry after the first retry
  // replaced it and the replacement parked again: the superseded row is no longer actionable.
  it('refuses to retry an attempt a previous retry already superseded', async () => {
    const { flowRunId } = await seedFlowRun(db, GRAPH);
    await setFlowRunStatus(db, flowRunId, 'paused');
    const old = await createNodeRun(db, {
      flowRunId,
      nodeId: 'a',
      blockType: 'agent',
      status: 'superseded',
    });
    const replacement = await createNodeRun(db, {
      flowRunId,
      nodeId: 'a',
      blockType: 'agent',
      status: 'awaiting_input',
      attemptNumber: 2,
    });
    seedActiveAdmission(db, flowRunId);

    await expect(resumeFlowRun(flowRunId, 'retry', old.id, undefined, 'retry')).rejects.toThrow(
      'already changed',
    );
    expect((await getFlowRun(db, flowRunId))?.status).toBe('paused');
    expect((await getNodeRun(db, replacement.id))?.status).toBe('awaiting_input');
    expect(dispatchAndAdvance).not.toHaveBeenCalled();
  });

  it('rejects a changed park on the same node after loading context', async () => {
    const { flowRunId } = await seedFlowRun(db, GRAPH);
    await setFlowRunStatus(db, flowRunId, 'paused');
    const node = await createNodeRun(db, {
      flowRunId,
      nodeId: 'a',
      blockType: 'agent',
      status: 'awaiting_input',
    });
    const snapshot: FlowResumeSnapshot = {
      status: 'awaiting_input',
      nodeOutput: null,
      startedAt: null,
      completedAt: null,
      attemptIds: [node.id],
    };
    (loadRunContext as Mock).mockImplementationOnce(async () => {
      await setNodeRunStatus(db, node.id, 'running', { nodeOutput: null });
      await setNodeRunStatus(db, node.id, 'awaiting_input', {
        nodeOutput: { signal: 'awaiting_input' },
      });
      return { graph: GRAPH };
    });
    await expect(resumeFlowRun(flowRunId, 'approve', node.id, snapshot)).rejects.toThrow(
      'already changed',
    );
    expect((await getFlowRun(db, flowRunId))?.status).toBe('paused');
    expect(advanceFlowRun).not.toHaveBeenCalled();
  });

  it('reports a stale snapshot refused by the final atomic node write', async () => {
    const { flowRunId } = await seedFlowRun(db, GRAPH);
    await setFlowRunStatus(db, flowRunId, 'paused');
    const node = await createNodeRun(db, {
      flowRunId,
      nodeId: 'a',
      blockType: 'agent',
      status: 'awaiting_input',
    });
    const snapshot: FlowResumeSnapshot = {
      status: 'awaiting_input',
      nodeOutput: null,
      startedAt: null,
      completedAt: null,
      attemptIds: [node.id],
    };
    seedActiveAdmission(db, flowRunId);
    (advanceFlowRun as Mock).mockImplementationOnce(
      async (_run, id, _output, _driver, expected) => {
        await setNodeRunStatus(db, id, 'awaiting_input', {
          nodeOutput: { signal: 'awaiting_input' },
        });
        return Boolean(
          await setNodeRunStatus(db, id, 'completed', { expectResumeSnapshot: expected }),
        );
      },
    );
    await expect(resumeFlowRun(flowRunId, 'approve', node.id, snapshot)).rejects.toThrow(
      'already changed',
    );
    expect(advanceFlowRun).toHaveBeenCalledWith(
      flowRunId,
      node.id,
      expect.anything(),
      undefined,
      snapshot,
    );
    expect((await getFlowRun(db, flowRunId))?.status).toBe('paused');
    expect((await getNodeRun(db, node.id))?.status).toBe('awaiting_input');
  });

  it('never re-pauses a run that a Cancel and a Retry re-admitted under a new ticket', async () => {
    const { flowRunId } = await seedFlowRun(db, GRAPH);
    await setFlowRunStatus(db, flowRunId, 'paused');
    const node = await createNodeRun(db, {
      flowRunId,
      nodeId: 'a',
      blockType: 'agent',
      status: 'awaiting_input',
    });
    const ticket = seedActiveAdmission(db, flowRunId);
    (advanceFlowRun as Mock).mockImplementationOnce(async () => {
      db.update(flowRunAdmissions)
        .set({ state: 'released', settledAt: new Date() })
        .where(eq(flowRunAdmissions.ticket, ticket))
        .run();
      seedActiveAdmission(db, flowRunId);
      return false;
    });

    await expect(resumeFlowRun(flowRunId, 'approve', node.id)).rejects.toThrow('already changed');

    expect((await getFlowRun(db, flowRunId))?.status).toBe('running');
  });

  it('does not reopen a run cancelled while its context loads', async () => {
    const { flowRunId } = await seedFlowRun(db, GRAPH);
    await setFlowRunStatus(db, flowRunId, 'paused');
    const nodeRun = await createNodeRun(db, {
      flowRunId,
      nodeId: 'a',
      blockType: 'agent',
      status: 'awaiting_input',
    });
    seedActiveAdmission(db, flowRunId);
    (loadRunContext as Mock).mockImplementationOnce(async () => {
      await setFlowRunStatus(db, flowRunId, 'cancelled', {}, 'paused');
      return { graph: GRAPH };
    });

    await expect(resumeFlowRun(flowRunId, 'retry', nodeRun.id, undefined, 'retry')).rejects.toThrow(
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
    const ticket = seedActiveAdmission(db, flowRunId);
    (dispatchAndAdvance as Mock).mockImplementationOnce(async () => {
      expect(hasFlowResourceActivity(flowRunId)).toBe(true);
    });

    await resumeFlowRun(flowRunId, 'retry', nodeRun.id, undefined, 'retry');

    expect(dispatchAndAdvance).toHaveBeenCalledOnce();
    expect(dispatchAndAdvance).toHaveBeenCalledWith(
      { flowRunId, ticket },
      GRAPH.nodes[1],
      undefined,
      expect.anything(),
      undefined,
      // A Retry re-sends the step's instructions; only a Continue resumes the session.
      { supersedesNodeRunId: nodeRun.id },
    );
    expect(hasFlowResourceActivity(flowRunId)).toBe(false);
  });

  describe('the recovery kind the user clicked', () => {
    /** A paused agent step whose task's session (`sub-1`) has or has not answered it yet. */
    async function seedStep(answered: boolean) {
      const { flowRunId } = await seedFlowRun(db, GRAPH);
      await setFlowRunStatus(db, flowRunId, 'paused');
      const node = await createNodeRun(db, {
        flowRunId,
        nodeId: 'a',
        blockType: 'agent',
        status: 'failed',
      });
      seedActiveAdmission(db, flowRunId);
      db.insert(chats).values({ id: 'chat-1' }).run();
      db.insert(subChats).values({ id: 'sub-1', chatId: 'chat-1', sessionId: 'sess-1' }).run();
      const task = await createTask(db, {
        description: 'agent step',
        source: 'flow',
        sourceId: node.id,
        nodeRunId: node.id,
        flowRunId,
        result: { subChatId: 'sub-1' },
      });
      if (answered) answer(task.id);
      return { flowRunId, nodeRunId: node.id, taskId: task.id };
    }
    function answer(taskId: string) {
      const prompt = {
        id: `u-${taskId}`,
        role: 'user',
        parts: [],
        metadata: { dispatchTaskId: taskId },
      };
      db.insert(subChatMessages)
        .values([
          { subChatId: 'sub-1', seq: 0, message: JSON.stringify(prompt) },
          { subChatId: 'sub-1', seq: 1, message: '{"id":"a1","role":"assistant","parts":[]}' },
        ])
        .run();
    }

    beforeEach(() => vi.mocked(dispatchAndAdvance).mockReset().mockResolvedValue(undefined));

    it('continues the answering session when the click was Continue', async () => {
      const { flowRunId, nodeRunId } = await seedStep(true);
      await resumeFlowRun(flowRunId, 'retry', nodeRunId, undefined, 'continue');
      expect(vi.mocked(dispatchAndAdvance).mock.calls[0]?.[5]).toEqual({
        supersedesNodeRunId: nodeRunId,
        resumeKind: 'continuation',
      });
    });

    // The re-check shares the transaction that reopens the run, so an answer landing first wins.
    it('refuses a Retry whose session answered the step as the reopen began', async () => {
      const { flowRunId, nodeRunId, taskId } = await seedStep(false);
      const transaction = db.transaction.bind(db);
      vi.spyOn(db, 'transaction').mockImplementationOnce((command, config) => {
        answer(taskId);
        return transaction(command, config);
      });

      await expect(
        resumeFlowRun(flowRunId, 'retry', nodeRunId, undefined, 'retry'),
      ).rejects.toMatchObject({ code: 'PRECONDITION_FAILED', message: /refresh/ });
      expect((await getFlowRun(db, flowRunId))?.status).toBe('paused');
      expect(dispatchAndAdvance).not.toHaveBeenCalled();
    });

    it('refuses a retry that carries no kind', async () => {
      const { flowRunId, nodeRunId } = await seedStep(false);
      await expect(resumeFlowRun(flowRunId, 'retry', nodeRunId)).rejects.toMatchObject({
        code: 'PRECONDITION_FAILED',
      });
      expect((await getFlowRun(db, flowRunId))?.status).toBe('paused');
    });
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
    const ticket = seedActiveAdmission(db, flowRunId);
    vi.mocked(dispatchAndAdvance).mockReset().mockResolvedValue(undefined);

    await resumeFlowRun(flowRunId, 'retry', nodeRun.id, undefined, 'retry');

    expect(dispatchAndAdvance).toHaveBeenCalledWith(
      { flowRunId, ticket },
      GRAPH.nodes[1],
      undefined,
      expect.anything(),
      undefined,
      { laneIndex: 3, parentFanOutNodeRunId: parent.id, supersedesNodeRunId: nodeRun.id },
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

describe('unparkFlowInPlace — unpark an agent node after a chat follow-up', () => {
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
    seedActiveAdmission(db, flowRunId);
    const node = await createNodeRun(db, { flowRunId, nodeId: 'a', blockType: 'agent', status });
    return { flowRunId, nodeRunId: node.id };
  }

  const unpark = (flowRunId: string, nodeRunId: string) =>
    unparkFlowInPlace(flowRunId, nodeRunId, 'task-1', undefined, false);

  // An in-place un-park continues without re-admitting, so a paused run without its slot stays parked.
  it('declines when the run no longer holds its active slot', async () => {
    const { flowRunId } = await seedFlowRun(db, GRAPH);
    await setFlowRunStatus(db, flowRunId, 'paused');
    const node = await createNodeRun(db, {
      flowRunId,
      nodeId: 'a',
      blockType: 'agent',
      status: 'awaiting_input',
    });
    expect(await unpark(flowRunId, node.id)).toBe(false);
    expect((await getNodeRun(db, node.id))?.status).toBe('awaiting_input');
    expect((await getFlowRun(db, flowRunId))?.status).toBe('paused');
  });

  it('flips the node_run and flow_run back to running', async () => {
    const { flowRunId, nodeRunId } = await seedPausedAgentNode();
    expect(await unpark(flowRunId, nodeRunId)).toBe(true);
    expect((await getNodeRun(db, nodeRunId))?.status).toBe('running');
    expect((await getFlowRun(db, flowRunId))?.status).toBe('running');
  });

  it('unparks a blocked node too', async () => {
    const { flowRunId, nodeRunId } = await seedPausedAgentNode('blocked');
    expect(await unpark(flowRunId, nodeRunId)).toBe(true);
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
    expect(await unpark(flowRunId, nodeRunId)).toBe(true);
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
    expect(await unpark(flowRunId, node.id)).toBe(false);
    expect((await getNodeRun(db, node.id))?.status).toBe('awaiting_input');
  });

  it('no-ops (CAS miss) when the node is already running — guards double-fire', async () => {
    const { flowRunId } = await seedFlowRun(db, GRAPH);
    await setFlowRunStatus(db, flowRunId, 'paused');
    seedActiveAdmission(db, flowRunId);
    const node = await createNodeRun(db, {
      flowRunId,
      nodeId: 'a',
      blockType: 'agent',
      status: 'running',
    });
    expect(await unpark(flowRunId, node.id)).toBe(false);
    expect((await getFlowRun(db, flowRunId))?.status).toBe('paused');
  });

  it('unparks one Fan Out branch without changing its sibling', async () => {
    const { flowRunId } = await seedFlowRun(db, GRAPH);
    await setFlowRunStatus(db, flowRunId, 'paused');
    seedActiveAdmission(db, flowRunId);
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
    expect(await unpark(flowRunId, lane.id)).toBe(true);
    expect((await getNodeRun(db, lane.id))?.status).toBe('running');
    expect((await getNodeRun(db, sibling.id))?.status).toBe('awaiting_input');
    expect((await getFlowRun(db, flowRunId))?.status).toBe('paused');

    expect(await unpark(flowRunId, sibling.id)).toBe(true);
    expect((await getFlowRun(db, flowRunId))?.status).toBe('running');
  });
});

describe('resumeFailedFlowInPlace — failed-run retry unpark (non-batch only)', () => {
  let db: TestDb;
  beforeEach(() => {
    db = freshDb();
    holder.db = db;
    (loadRunContext as Mock).mockReset();
  });

  // Same lease rule as the interrupted revive: a terminal run's slot is settled, and flipping it
  // live anyway would strand it paused-without-slot at the next preflight rejection. Declining
  // leaves the run terminal, where Retry re-admits through a durable resume ticket.
  it('declines when the run no longer holds its admission slot', async () => {
    const { flowRunId, nodeRunId } = await seedFailedRun({ slot: false });

    expect(await resumeFailedFlowInPlace(flowRunId, 'task-1')).toBe(false);
    expect((await getNodeRun(db, nodeRunId))?.status).toBe('failed');
    expect((await getFlowRun(db, flowRunId))?.status).toBe('failed');
  });

  async function seedFailedRun({ slot = true } = {}): Promise<{
    flowRunId: string;
    nodeRunId: string;
  }> {
    const { flowRunId } = await seedFlowRun(db, GRAPH);
    if (slot) seedActiveAdmission(db, flowRunId);
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
    seedActiveAdmission(db, flowRunId);
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
    seedActiveAdmission(db, flowRunId);
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
    seedActiveAdmission(db, flowRunId);
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
    seedActiveAdmission(db, flowRunId);
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

describe('isRunRestartInterrupted — cancelled-run chat resume', () => {
  let db: TestDb;
  beforeEach(() => {
    db = freshDb();
    holder.db = db;
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
