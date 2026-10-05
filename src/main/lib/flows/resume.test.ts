import { TRPCError } from '@trpc/server';
import { eq } from 'drizzle-orm';
import { beforeEach, describe, expect, it, type Mock, vi } from 'vitest';
import type { FlowGraph } from '../../../shared/lib/validate-flow-graph';
import { type NodeOutput, RESTART_INTERRUPTION_REASON } from '../../../shared/types/flow';
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
import { abandonRestartInterruption } from '../db/repos/task-parking/abandon-marker';
import {
  batchStageRuns,
  batchStages,
  flowRunAdmissions,
  flowRuns,
  type NewNodeRun,
  tasks,
} from '../db/schema';
import { seedActiveAdmission, seedFlowRun } from '../db/test-utils/flow-fixtures';
import { freshDb, type TestDb } from '../db/test-utils/fresh-db';
import { unparkFlowInPlace } from '../tasks';
import { isRestartInterrupted } from './transitions';
import { hasFlowResourceActivity, setFlowAdmissionLifecycleHooks } from './admission/activity';
import {
  TerminalResumeAdmissionError,
  TerminalResumeChatDeletedError,
} from './admission/terminal-resume/resume-store';

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
import {
  approvedOutputFrom,
  isRunRestartInterrupted,
  rerunFlowRunFromInterruption,
  resumeFailedFlowInPlace,
  resumeFlowRun,
} from './resume';
import { forgetAdvancedTask, stopTaskCompletionWatcher, tick } from './task-completion-watcher';

beforeEach(() => _setFlowAdmissionControllerForTests(null));

const GRAPH: FlowGraph = {
  nodes: [
    { id: 't', blockType: 'manual_trigger', position: { x: 0, y: 0 } },
    { id: 'a', blockType: 'agent', config: { instructions: 'go' }, position: { x: 0, y: 1 } },
  ],
  edges: [{ id: 'e1', source: 't', target: 'a' }],
};
const SIGNALLED_PARK: NodeOutput = {
  status: 'awaiting_input',
  outputs: {
    summary: 'Ready to push',
    details: 'Two files changed',
    verification: { shouldProceed: true },
    taskId: 'task-1',
  },
  artifacts: [{ type: 'log', uri: 'out.md' }],
  durationMs: 4200,
  signal: 'awaiting_input',
};
const APPROVED_ALONE: NodeOutput = {
  status: 'completed',
  outputs: { approved: true },
  artifacts: [],
  durationMs: 0,
};

describe('approvedOutputFrom', () => {
  const parked = (outputs: NodeOutput['outputs'], signalled = true) => ({
    outputs,
    artifacts: SIGNALLED_PARK.artifacts,
    durationMs: 4200,
    signalled,
  });

  it('keeps what a signalled park stored and marks it approved', () => {
    expect(approvedOutputFrom(parked(SIGNALLED_PARK.outputs))).toEqual({
      status: 'completed',
      outputs: { ...SIGNALLED_PARK.outputs, approved: true },
      artifacts: SIGNALLED_PARK.artifacts,
      durationMs: 4200,
    });
  });

  // The stored row drops an absent `details`; the bag handed downstream must agree with it.
  it('adds no summary or details key the signalled park did not store', () => {
    const { details: _details, ...outputs } = SIGNALLED_PARK.outputs;
    expect(Object.keys(approvedOutputFrom(parked(outputs)).outputs)).toEqual([
      'summary',
      'verification',
      'taskId',
      'approved',
    ]);
  });

  it('leaves the needs-attention marker behind', () => {
    const outputs = { ...SIGNALLED_PARK.outputs, taskStatus: 'needs_attention' };
    expect(approvedOutputFrom(parked(outputs)).outputs).not.toHaveProperty('taskStatus');
  });

  it('does not pass a pause message on as the result of a park with no agent signal', () => {
    const outputs = { summary: 'Paused by user', details: 'Paused', taskId: 'task-1' };
    expect(approvedOutputFrom(parked(outputs, false)).outputs).toEqual({
      taskId: 'task-1',
      approved: true,
    });
  });

  it('approves a bag that says it was not approved', () => {
    expect(approvedOutputFrom(parked({ approved: false })).outputs).toEqual({ approved: true });
  });
});

describe('resumeFlowRun — approve keeps the parked output (sc-3255)', () => {
  let db: TestDb;

  beforeEach(() => {
    db = freshDb();
    holder.db = db;
    vi.mocked(loadRunContext).mockReset();
    vi.mocked(loadRunContext, { partial: true }).mockResolvedValue({ graph: GRAPH });
    vi.mocked(advanceFlowRun).mockReset();
    setFlowAdmissionLifecycleHooks({
      reconcile: vi.fn(async () => {}),
      requestRelease: vi.fn(async () => {}),
    });
  });

  async function seedParkedNode(nodeOutput?: NewNodeRun['nodeOutput']) {
    const { flowRunId } = await seedFlowRun(db, GRAPH);
    await setFlowRunStatus(db, flowRunId, 'paused');
    const node = await createNodeRun(db, {
      flowRunId,
      nodeId: 'a',
      blockType: 'agent',
      status: 'awaiting_input',
      nodeOutput,
    });
    seedActiveAdmission(db, flowRunId);
    return { flowRunId, nodeRunId: node.id };
  }

  const advancedWith = () => vi.mocked(advanceFlowRun).mock.calls[0][2];

  it('advances with the summary, details and verification the node parked with', async () => {
    const { flowRunId, nodeRunId } = await seedParkedNode(SIGNALLED_PARK);

    await resumeFlowRun(flowRunId, 'approve', nodeRunId);

    expect(advancedWith()).toEqual({
      status: 'completed',
      outputs: { ...SIGNALLED_PARK.outputs, approved: true },
      artifacts: SIGNALLED_PARK.artifacts,
      durationMs: 4200,
    });
  });

  // An approval block parks with no output and is documented as emitting nothing but `approved`.
  it.each([
    ['no stored output', undefined],
    ['a stored output that is not an object', 'oops'],
    ['a stored output with no bag', { status: 'awaiting_input', outputs: null }],
  ])('advances with approved alone for %s', async (_label, stored) => {
    const { flowRunId, nodeRunId } = await seedParkedNode(stored);

    await resumeFlowRun(flowRunId, 'approve', nodeRunId);

    expect(advancedWith()).toEqual(APPROVED_ALONE);
  });

  it('still skips with an empty bag', async () => {
    const { flowRunId, nodeRunId } = await seedParkedNode(SIGNALLED_PARK);

    await resumeFlowRun(flowRunId, 'skip', nodeRunId);

    expect(advancedWith()).toEqual({
      status: 'skipped',
      outputs: {},
      artifacts: [],
      durationMs: 0,
    });
  });

  it('merges the bag of a re-park that landed while the resume was loading', async () => {
    const { flowRunId, nodeRunId } = await seedParkedNode(SIGNALLED_PARK);
    vi.mocked(loadRunContext, { partial: true }).mockImplementationOnce(async () => {
      await setNodeRunStatus(db, nodeRunId, 'awaiting_input', {
        nodeOutput: {
          ...SIGNALLED_PARK,
          outputs: { ...SIGNALLED_PARK.outputs, summary: 'Second question' },
        },
      });
      return { graph: GRAPH };
    });

    await resumeFlowRun(flowRunId, 'approve', nodeRunId);

    expect(advancedWith().outputs.summary).toBe('Second question');
  });

  it('merges the reviewed bag when the approve carries a matching snapshot', async () => {
    const { flowRunId, nodeRunId } = await seedParkedNode(SIGNALLED_PARK);
    const snapshot: FlowResumeSnapshot = {
      status: 'awaiting_input',
      nodeOutput: SIGNALLED_PARK,
      startedAt: null,
      completedAt: null,
      attemptIds: [nodeRunId],
    };

    await resumeFlowRun(flowRunId, 'approve', nodeRunId, snapshot);

    expect(advanceFlowRun).toHaveBeenCalledWith(
      flowRunId,
      nodeRunId,
      expect.objectContaining({ outputs: { ...SIGNALLED_PARK.outputs, approved: true } }),
      undefined,
      snapshot,
    );
  });
});

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

    await expect(resumeFlowRun(flowRunId, 'retry', old.id)).rejects.toThrow('already changed');
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
    const ticket = seedActiveAdmission(db, flowRunId);
    (dispatchAndAdvance as Mock).mockImplementationOnce(async () => {
      expect(hasFlowResourceActivity(flowRunId)).toBe(true);
    });

    await resumeFlowRun(flowRunId, 'retry', nodeRun.id);

    expect(dispatchAndAdvance).toHaveBeenCalledOnce();
    expect(dispatchAndAdvance).toHaveBeenCalledWith(
      { flowRunId, ticket },
      GRAPH.nodes[1],
      undefined,
      expect.anything(),
      undefined,
      { supersedesNodeRunId: nodeRun.id },
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
    const ticket = seedActiveAdmission(db, flowRunId);
    vi.mocked(dispatchAndAdvance).mockReset().mockResolvedValue(undefined);

    await resumeFlowRun(flowRunId, 'retry', nodeRun.id);

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
      admit: expect.any(Function),
    });
    expect(loadRunContext).not.toHaveBeenCalled();
    expect(dispatchAndAdvance).not.toHaveBeenCalled();
    expect((await getFlowRun(db, flowRunId))?.status).toBe('cancelled');
  });

  it('reports a Cancel that lands while the enqueue drains as the user cancelling', async () => {
    const flowRunId = await seedCancelledRun();
    await seedInterruptedNode(flowRunId);
    const dropped = new TerminalResumeAdmissionError('Flow resume admission cancelled');
    holder.requestTerminalFlowResume.mockImplementation(async () => {
      abandonRestartInterruption(db, flowRunId);
      throw dropped;
    });
    await expect(rerunFlowRunFromInterruption(flowRunId)).rejects.toThrow(/cancelled by the user/i);
  });

  it('passes an admission failure through while the run is still interrupted', async () => {
    const flowRunId = await seedCancelledRun();
    await seedInterruptedNode(flowRunId);
    const failed = new TerminalResumeAdmissionError('Flow resume admission failed');
    holder.requestTerminalFlowResume.mockRejectedValue(failed);
    await expect(rerunFlowRunFromInterruption(flowRunId)).rejects.toBe(failed);
  });

  it('refuses a run whose chat was deleted in plain words, keeping its interruption marker', async () => {
    const flowRunId = await seedCancelledRun();
    await seedInterruptedNode(flowRunId);
    holder.requestTerminalFlowResume.mockRejectedValue(new TerminalResumeChatDeletedError());
    await expect(rerunFlowRunFromInterruption(flowRunId)).rejects.toSatisfy(
      (error: unknown) =>
        error instanceof TRPCError &&
        error.code === 'PRECONDITION_FAILED' &&
        error.message === "This run's chat was deleted — start the flow again to re-run it.",
    );
    expect(isRestartInterrupted(db, flowRunId)).toBe(true);
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
      admit: expect.any(Function),
    });
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
