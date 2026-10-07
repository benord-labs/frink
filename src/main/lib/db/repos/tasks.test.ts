import { eq } from 'drizzle-orm';
import { beforeEach, describe, expect, it } from 'vitest';
import type { FlowGraph } from '../../../../shared/lib/validate-flow-graph';
import { RESTART_INTERRUPTION_REASON } from '../../../../shared/types/flow';
import { flowRuns } from '../schema';
import { seedFlowRun } from '../test-utils/flow-fixtures';
import { freshDb, type TestDb } from '../test-utils/fresh-db';
import {
  type FlowRunStatus,
  getOrCreateFlowRunByIdempotencyKey,
  setFlowRunStatus,
} from './flow-runs';
import { createNodeRun, setNodeRunStatus } from './node-runs';
import { parkFlowTaskForSubChat } from './task-parking';
import {
  cancelFlowTaskForSubChat,
  completeAllDoneTasks,
  completeDoneTasksForFlowRun,
  createTask,
  deleteTasksMatchingStatuses,
  getFlowBriefingForSubChat,
  getFlowChatForNodeRun,
  getFlowDriveInfoForSubChat,
  getLatestFlowTaskForRun,
  getLatestFlowTaskForSubChat,
  getTaskById,
  getTaskCounts,
  isTerminalFinalTaskStatus,
  listTasksWithProjectPaginated,
  retryTaskDetailed,
  type TaskFilterStatus,
  type TaskStatus,
  TERMINAL_FINAL_TASK_STATUSES,
  updateTaskResult,
  updateTaskStatus,
} from './tasks';

const GRAPH: FlowGraph = {
  nodes: [{ id: 'a', blockType: 'agent', config: { instructions: 'x' }, position: { x: 0, y: 0 } }],
  edges: [],
};
const ACTIVE: TaskFilterStatus[] = [
  'plan_ready',
  'needs_attention',
  'running',
  'failed',
  'interrupted',
];
const HISTORY: TaskFilterStatus[] = ['done', 'completed', 'cancelled'];

/** Insert a flow-linked task and drive it to `status` (a flow agent-node task row). */
async function addFlowTask(db: TestDb, flowRunId: string, status: TaskStatus) {
  const t = await createTask(db, { description: status, source: 'flow', flowRunId });
  if (status !== 'pending') await updateTaskStatus(db, t.id, status);
  return t;
}

describe('work queue — per-flow collapse (listTasksWithProjectPaginated + getTaskCounts)', () => {
  let db: TestDb;
  beforeEach(() => {
    db = freshDb();
  });

  const list = (statuses: TaskFilterStatus[]) =>
    listTasksWithProjectPaginated(db, { statuses, limit: 50, collapseByFlow: true });

  /**
   * A restart-interrupted run must NOT read as a deliberate Stop. The two differ only by the marker
   * on tasks.result.error, and getting it wrong files recoverable work under History labelled
   * "intentionally stopped" — where the chat's resume affordance is unreachable.
   */
  it('a restart-interrupted run derives `interrupted` and stays in Active', async () => {
    const { flowRunId } = await seedFlowRun(db, GRAPH);
    const task = await addFlowTask(db, flowRunId, 'running');
    await updateTaskStatus(db, task.id, 'cancelled', {
      result: { cancelled: true, error: RESTART_INTERRUPTION_REASON },
    });
    await setFlowRunStatus(db, flowRunId, 'cancelled');

    expect(await list(ACTIVE).then((r) => r.items.map((i) => i.effectiveStatus))).toEqual([
      'interrupted',
    ]);
    expect(await list(HISTORY).then((r) => r.items)).toHaveLength(0);

    const counts = await getTaskCounts(db, { collapseByFlow: true });
    expect(counts.interrupted).toBe(1);
    expect(counts.cancelled).toBe(0);
  });

  // Without collapseByFlow there is no effectiveStatusExpr, so the filter would degrade to
  // `tasks.status IN ('interrupted')` — a value never written to that column — and return zero rows
  // that read as "no interrupted runs". Fail loud rather than answer a question this shape cannot.
  it('refuses a derived status filter when collapseByFlow is off', async () => {
    await expect(
      listTasksWithProjectPaginated(db, {
        statuses: ['interrupted'],
        limit: 50,
      }),
    ).rejects.toThrow(/requires collapseByFlow/);
  });

  // The real shape: a flow runs N nodes, so an earlier node's task is already `done` when a later
  // node is interrupted. The representative-row ranking picks the highest-ranked task, which is the
  // `done` one — so the marker must be looked up across the FLOW, not on whichever row won.
  it('a multi-node flow interrupted at a later node still derives `interrupted`', async () => {
    const { flowRunId } = await seedFlowRun(db, GRAPH);
    await addFlowTask(db, flowRunId, 'done'); // earlier node, finished — outranks cancelled
    const current = await addFlowTask(db, flowRunId, 'running');
    await updateTaskStatus(db, current.id, 'cancelled', {
      result: { cancelled: true, error: RESTART_INTERRUPTION_REASON },
    });
    await setFlowRunStatus(db, flowRunId, 'cancelled');

    expect(await list(ACTIVE).then((r) => r.items.map((i) => i.effectiveStatus))).toEqual([
      'interrupted',
    ]);
    expect(await list(HISTORY).then((r) => r.items)).toHaveLength(0);
  });

  it('a deliberately stopped run carries no marker, so it stays `cancelled` in History', async () => {
    const { flowRunId } = await seedFlowRun(db, GRAPH);
    const task = await addFlowTask(db, flowRunId, 'running');
    await updateTaskStatus(db, task.id, 'cancelled', { result: { cancelled: true } });
    await setFlowRunStatus(db, flowRunId, 'cancelled');

    expect(await list(HISTORY).then((r) => r.items.map((i) => i.effectiveStatus))).toEqual([
      'cancelled',
    ]);
    expect(await list(ACTIVE).then((r) => r.items)).toHaveLength(0);

    const counts = await getTaskCounts(db, { collapseByFlow: true });
    expect(counts.cancelled).toBe(1);
    expect(counts.interrupted).toBe(0);
  });

  // Re-dispatch reuses the flow_run and mints a NEW task, leaving the old interrupted+marked task in
  // place forever. A subsequent DELIBERATE Stop must read as `cancelled` — the marker is scoped to the
  // CURRENT (newest) attempt, not any historical row, or a real Stop is misfiled into Active forever.
  it('a re-run of an interrupted run, then a deliberate Stop, reads as cancelled (not interrupted)', async () => {
    const { flowRunId } = await seedFlowRun(db, GRAPH);
    // 1) first attempt: restart-interrupted (older task keeps the marker forever)
    const first = await addFlowTask(db, flowRunId, 'running');
    await updateTaskStatus(db, first.id, 'cancelled', {
      result: { cancelled: true, error: RESTART_INTERRUPTION_REASON },
    });
    // 2) user re-runs → new task on the same flow_run; 3) deliberately stops it → no marker
    const rerun = await addFlowTask(db, flowRunId, 'running');
    await updateTaskStatus(db, rerun.id, 'cancelled', { result: { cancelled: true } });
    await setFlowRunStatus(db, flowRunId, 'cancelled');

    expect(await list(HISTORY).then((r) => r.items.map((i) => i.effectiveStatus))).toEqual([
      'cancelled',
    ]);
    expect(await list(ACTIVE).then((r) => r.items)).toHaveLength(0);
    const counts = await getTaskCounts(db, { collapseByFlow: true });
    expect(counts.cancelled).toBe(1);
    expect(counts.interrupted).toBe(0);
  });

  // Fan-out lanes support restart recovery, so their restart marker must surface the run as
  // `interrupted` just like a linear node. Filing it under History would hide recoverable work.
  it('an interrupted fan-out flow stays recoverable in Active', async () => {
    const { flowRunId } = await seedFlowRun(db, GRAPH);
    // a fan-out lane node_run carrying the restart marker
    const parent = await createNodeRun(db, { flowRunId, nodeId: 'fan', blockType: 'agent' });
    const lane = await createNodeRun(db, {
      flowRunId,
      nodeId: 'lane',
      blockType: 'agent',
      parentFanOutNodeRunId: parent.id,
    });
    await setNodeRunStatus(db, lane.id, 'cancelled', {
      nodeOutput: {
        status: 'cancelled',
        outputs: {},
        artifacts: [],
        durationMs: 0,
        error: { message: RESTART_INTERRUPTION_REASON, retryable: true },
      },
    });
    const task = await addFlowTask(db, flowRunId, 'running');
    await updateTaskStatus(db, task.id, 'cancelled', {
      result: { cancelled: true, error: RESTART_INTERRUPTION_REASON },
    });
    await setFlowRunStatus(db, flowRunId, 'cancelled');

    expect(await list(HISTORY).then((r) => r.items)).toHaveLength(0);
    expect(await list(ACTIVE).then((r) => r.items.map((i) => i.effectiveStatus))).toEqual([
      'interrupted',
    ]);
    expect((await getTaskCounts(db, { collapseByFlow: true })).interrupted).toBe(1);
  });

  // The exclusion is scoped to the INTERRUPTED (latest) node, not "the flow ever had a fan-out". A
  // linear node interrupted after an earlier fan-out section already COMPLETED is resumable
  // (resume.ts allows it), so it must still derive `interrupted` — a whole-flow carve-out would
  // wrongly bury it in History.
  it('a linear node interrupted after a completed fan-out section still derives `interrupted`', async () => {
    const { flowRunId } = await seedFlowRun(db, GRAPH);
    // an earlier fan-out lane that FINISHED
    const parent = await createNodeRun(db, { flowRunId, nodeId: 'fan', blockType: 'agent' });
    const lane = await createNodeRun(db, {
      flowRunId,
      nodeId: 'lane',
      blockType: 'agent',
      parentFanOutNodeRunId: parent.id,
    });
    await setNodeRunStatus(db, lane.id, 'completed', { nodeOutput: null });
    // a LATER linear node (no fan-out parent) that was restart-interrupted — the latest node_run
    const linear = await createNodeRun(db, { flowRunId, nodeId: 'linear', blockType: 'agent' });
    await setNodeRunStatus(db, linear.id, 'cancelled', {
      nodeOutput: {
        status: 'cancelled',
        outputs: {},
        artifacts: [],
        durationMs: 0,
        error: { message: RESTART_INTERRUPTION_REASON, retryable: true },
      },
    });
    const task = await addFlowTask(db, flowRunId, 'running');
    await updateTaskStatus(db, task.id, 'cancelled', {
      result: { cancelled: true, error: RESTART_INTERRUPTION_REASON },
    });
    await setFlowRunStatus(db, flowRunId, 'cancelled');

    expect(await list(ACTIVE).then((r) => r.items.map((i) => i.effectiveStatus))).toEqual([
      'interrupted',
    ]);
    expect((await getTaskCounts(db, { collapseByFlow: true })).interrupted).toBe(1);
  });

  it('running 2-agent flow → ONE active representative; the done agent is hidden; counts collapse', async () => {
    const { flowRunId } = await seedFlowRun(db, GRAPH); // status running
    await addFlowTask(db, flowRunId, 'done'); // evaluate (anchor), finished
    const build = await addFlowTask(db, flowRunId, 'running'); // build agent, running

    const active = await list(ACTIVE);
    expect(active.items).toHaveLength(1);
    expect(active.items[0].id).toBe(build.id);
    expect(active.items[0].effectiveStatus).toBe('running');
    expect(await list(HISTORY).then((r) => r.items)).toHaveLength(0);

    const counts = await getTaskCounts(db, { collapseByFlow: true });
    expect(counts.running).toBe(1);
    expect(counts.done).toBe(0);
    expect(counts.total).toBe(1);
  });

  it('transient gap: latest task done but flow still running → effective running, stays in Active', async () => {
    const { flowRunId } = await seedFlowRun(db, GRAPH);
    await addFlowTask(db, flowRunId, 'done');

    expect(await list(ACTIVE).then((r) => r.items.map((i) => i.effectiveStatus))).toEqual([
      'running',
    ]);
    expect(await list(HISTORY).then((r) => r.items)).toHaveLength(0);
  });

  it('paused plan-gate beats a newer queued pending next-agent (priority pick, not latest)', async () => {
    const { flowRunId } = await seedFlowRun(db, GRAPH);
    const gate = await addFlowTask(db, flowRunId, 'plan_ready'); // awaiting user
    await addFlowTask(db, flowRunId, 'pending'); // queued next agent, created later
    await setFlowRunStatus(db, flowRunId, 'paused');

    const active = await list(ACTIVE);
    expect(active.items).toHaveLength(1);
    expect(active.items[0].id).toBe(gate.id);
    expect(active.items[0].effectiveStatus).toBe('plan_ready');
    expect(await list(['pending']).then((r) => r.items)).toHaveLength(0); // pending hidden
  });

  // The newest attempt's own failure (the completion watcher fails the run moments later).
  it('a failed agent while the flow is still running surfaces as failed (not running)', async () => {
    const { flowRunId } = await seedFlowRun(db, GRAPH);
    await addFlowTask(db, flowRunId, 'failed');

    const active = await list(ACTIVE);
    expect(active.items).toHaveLength(1);
    expect(active.items[0].effectiveStatus).toBe('failed');
  });

  it('completed flow → ONE history row (done = review gate); cancelled flow → ONE (cancelled)', async () => {
    // Two runs on one version (seedFlowRun's project path is UNIQUE — only seed once).
    const { flowRunId: done, versionId } = await seedFlowRun(db, GRAPH);
    await addFlowTask(db, done, 'done');
    await addFlowTask(db, done, 'done');
    await setFlowRunStatus(db, done, 'completed', { completedAt: new Date() });

    const { run: cancelledRun } = await getOrCreateFlowRunByIdempotencyKey(db, {
      flowVersionId: versionId,
      status: 'running',
      triggerContext: null,
      idempotencyKey: 'c',
      startedAt: new Date(),
    });
    await addFlowTask(db, cancelledRun.id, 'cancelled');
    await setFlowRunStatus(db, cancelledRun.id, 'cancelled', { completedAt: new Date() });

    // Flow completion is not user confirmation: the run-completed flow surfaces as 'done'
    // (Ready for review) until its tasks are accepted to raw 'completed'.
    const history = await list(HISTORY);
    const effective = history.items.map((i) => i.effectiveStatus).sort();
    expect(effective).toEqual(['cancelled', 'done']);
    expect(await list(ACTIVE).then((r) => r.items)).toHaveLength(0);

    const counts = await getTaskCounts(db, { collapseByFlow: true });
    expect(counts.done).toBe(1); // awaiting user accept
    expect(counts.completed).toBe(0);
    expect(counts.cancelled).toBe(1);
  });

  it('completed flow with ALL tasks user-accepted (raw completed) → effective completed', async () => {
    const { flowRunId } = await seedFlowRun(db, GRAPH);
    await addFlowTask(db, flowRunId, 'done');
    await addFlowTask(db, flowRunId, 'done');
    await setFlowRunStatus(db, flowRunId, 'completed', { completedAt: new Date() });

    await completeDoneTasksForFlowRun(db, flowRunId);

    const history = await list(HISTORY);
    expect(history.items.map((i) => i.effectiveStatus)).toEqual(['completed']);
    const counts = await getTaskCounts(db, { collapseByFlow: true });
    expect(counts.completed).toBe(1);
    expect(counts.done).toBe(0);
  });

  it('completeDoneTasksForFlowRun scopes to its run — sibling runs untouched', async () => {
    const { flowRunId: a, versionId } = await seedFlowRun(db, GRAPH, { idempotencyKey: 'a' });
    const { run: b } = await getOrCreateFlowRunByIdempotencyKey(db, {
      flowVersionId: versionId,
      status: 'running',
      triggerContext: null,
      idempotencyKey: 'b',
      startedAt: new Date(),
    });
    const aTask = await addFlowTask(db, a, 'done');
    const bTask = await addFlowTask(db, b.id, 'done');

    expect(await completeDoneTasksForFlowRun(db, a)).toBe(1);
    expect((await getTaskById(db, aTask.id))?.status).toBe('completed');
    expect((await getTaskById(db, bTask.id))?.status).toBe('done');
  });

  it('manual (non-flow) tasks pass through untouched', async () => {
    const pending = await createTask(db, { description: 'm', source: 'manual' });
    const done = await createTask(db, { description: 'm2', source: 'manual' });
    await updateTaskStatus(db, done.id, 'done');

    expect(await list(['pending']).then((r) => r.items.map((i) => i.id))).toEqual([pending.id]);
    const hist = await list(HISTORY);
    expect(hist.items.map((i) => ({ id: i.id, s: i.effectiveStatus }))).toEqual([
      { id: done.id, s: 'done' },
    ]);
    expect((await getTaskCounts(db, { collapseByFlow: true })).done).toBe(1);
  });

  it('two concurrent flows stay distinct (one representative each)', async () => {
    const { flowRunId: a, versionId } = await seedFlowRun(db, GRAPH, { idempotencyKey: 'a' });
    const { run: b } = await getOrCreateFlowRunByIdempotencyKey(db, {
      flowVersionId: versionId,
      status: 'running',
      triggerContext: null,
      idempotencyKey: 'b',
      startedAt: new Date(),
    });
    await addFlowTask(db, a, 'running');
    await addFlowTask(db, b.id, 'running');

    expect(await list(ACTIVE).then((r) => r.items)).toHaveLength(2);
    expect((await getTaskCounts(db, { collapseByFlow: true })).running).toBe(2);
  });

  it('a flow with many continuation tasks collapses to ONE representative', async () => {
    const { flowRunId } = await seedFlowRun(db, GRAPH);
    for (let i = 0; i < 5; i++) await addFlowTask(db, flowRunId, 'done');
    const running = await addFlowTask(db, flowRunId, 'running');

    const active = await list(ACTIVE);
    expect(active.items).toHaveLength(1);
    expect(active.items[0].id).toBe(running.id);
    expect(await list(HISTORY).then((r) => r.items)).toHaveLength(0);
    expect((await getTaskCounts(db, { collapseByFlow: true })).running).toBe(1);
  });

  it('completeAllDoneTasks accepts manual + run-completed flow done tasks; never active/cancelled-run ones', async () => {
    const { flowRunId: activeRun, versionId } = await seedFlowRun(db, GRAPH, {
      idempotencyKey: 'a',
    });
    const midFlowDone = await addFlowTask(db, activeRun, 'done'); // hidden mid-flow agent

    const { run: completedRun } = await getOrCreateFlowRunByIdempotencyKey(db, {
      flowVersionId: versionId,
      status: 'running',
      triggerContext: null,
      idempotencyKey: 'b',
      startedAt: new Date(),
    });
    const reviewableDone = await addFlowTask(db, completedRun.id, 'done'); // surfaces as Ready for review
    await setFlowRunStatus(db, completedRun.id, 'completed', { completedAt: new Date() });

    const { run: cancelledRun } = await getOrCreateFlowRunByIdempotencyKey(db, {
      flowVersionId: versionId,
      status: 'running',
      triggerContext: null,
      idempotencyKey: 'c',
      startedAt: new Date(),
    });
    const cancelledRunDone = await addFlowTask(db, cancelledRun.id, 'done'); // surfaces as cancelled
    await setFlowRunStatus(db, cancelledRun.id, 'cancelled', { completedAt: new Date() });

    const manual = await createTask(db, { description: 'm', source: 'manual' });
    await updateTaskStatus(db, manual.id, 'done');

    const { completedCount } = await completeAllDoneTasks(db);

    expect(completedCount).toBe(2); // manual + the run-completed flow's done row
    const ids = await listTasksWithProjectPaginated(db, {}).then(
      (r) => new Map(r.items.map((t) => [t.id, t.status])),
    );
    expect(ids.get(manual.id)).toBe('completed');
    expect(ids.get(reviewableDone.id)).toBe('completed');
    expect(ids.get(midFlowDone.id)).toBe('done'); // left for the flow to manage
    expect(ids.get(cancelledRunDone.id)).toBe('done'); // cancelled flow: never silently accepted
  });
});

/** One attempt of a node: its own node_run plus the task bound to it, the shape dispatchAgent writes. */
async function addAttempt(
  db: TestDb,
  flowRunId: string,
  status: TaskStatus,
  opts: { nodeId?: string; laneIndex?: number } = {},
) {
  const nodeRun = await createNodeRun(db, {
    flowRunId,
    nodeId: opts.nodeId ?? 'a',
    blockType: 'agent',
    laneIndex: opts.laneIndex,
  });
  const t = await createTask(db, {
    description: status,
    source: 'flow',
    flowRunId,
    nodeRunId: nodeRun.id,
  });
  if (status !== 'pending') await updateTaskStatus(db, t.id, status);
  return t;
}

describe('work queue — a retry supersedes the attempt it replaced', () => {
  let db: TestDb;
  beforeEach(() => {
    db = freshDb();
  });

  const collapsed = () =>
    listTasksWithProjectPaginated(db, { limit: 50, collapseByFlow: true }).then((r) => r.items);

  it('the new attempt represents a live run and the old failure stops counting', async () => {
    const { flowRunId } = await seedFlowRun(db, GRAPH);
    await addAttempt(db, flowRunId, 'failed');
    const retry = await addAttempt(db, flowRunId, 'running');

    const items = await collapsed();
    expect(items.map((i) => [i.id, i.effectiveStatus])).toEqual([[retry.id, 'running']]);
    const counts = await getTaskCounts(db, { collapseByFlow: true });
    expect([counts.failed, counts.running]).toEqual([0, 1]);
    const running = await listTasksWithProjectPaginated(db, { workQueueSection: 'running' });
    expect(running.items.map((i) => i.id)).toEqual([retry.id]);
  });

  it('before the retry has a task, the old attempt still represents the run, as running', async () => {
    const { flowRunId } = await seedFlowRun(db, GRAPH);
    const old = await addAttempt(db, flowRunId, 'failed');
    await createNodeRun(db, { flowRunId, nodeId: 'a', blockType: 'agent' });

    expect((await collapsed()).map((i) => [i.id, i.effectiveStatus])).toEqual([
      [old.id, 'running'],
    ]);
  });

  it('a retried park no longer reads as needing attention', async () => {
    const { flowRunId } = await seedFlowRun(db, GRAPH);
    await addAttempt(db, flowRunId, 'needs_attention');
    const retry = await addAttempt(db, flowRunId, 'pending');
    await setFlowRunStatus(db, flowRunId, 'paused');

    expect((await collapsed()).map((i) => [i.id, i.effectiveStatus])).toEqual([
      [retry.id, 'running'],
    ]);
  });

  it('a lane retry supersedes only that lane', async () => {
    const { flowRunId } = await seedFlowRun(db, GRAPH);
    const lane1 = await addAttempt(db, flowRunId, 'failed', { laneIndex: 1 });
    const lane2 = await addAttempt(db, flowRunId, 'failed', { laneIndex: 2 });
    await createNodeRun(db, { flowRunId, nodeId: 'a', blockType: 'agent', laneIndex: 2 });

    const all = await listTasksWithProjectPaginated(db, { limit: 50 });
    const effective = new Map(all.items.map((i) => [i.id, i.effectiveStatus]));
    expect(effective.get(lane1.id)).toBe('failed');
    expect(effective.get(lane2.id)).toBe('running');
  });

  it('a retry that fails again: the newest failure represents the failed run', async () => {
    const { flowRunId } = await seedFlowRun(db, GRAPH);
    await addAttempt(db, flowRunId, 'failed');
    const retry = await addAttempt(db, flowRunId, 'failed');
    await setFlowRunStatus(db, flowRunId, 'failed');

    expect((await collapsed()).map((i) => [i.id, i.effectiveStatus])).toEqual([
      [retry.id, 'failed'],
    ]);
  });

  it('a multi-node run retried at a later node: the live attempt beats the earlier done node', async () => {
    const { flowRunId } = await seedFlowRun(db, GRAPH);
    await addAttempt(db, flowRunId, 'done', { nodeId: 'triage' });
    await addAttempt(db, flowRunId, 'failed', { nodeId: 'plan' });
    const retryRun = await createNodeRun(db, { flowRunId, nodeId: 'plan', blockType: 'agent' });
    await setFlowRunStatus(db, flowRunId, 'paused');

    // Before the retry's task exists, the run still reads live, never failed.
    expect((await collapsed()).map((i) => i.effectiveStatus)).toEqual(['running']);

    const retry = await createTask(db, {
      description: 'r',
      source: 'flow',
      flowRunId,
      nodeRunId: retryRun.id,
    });
    await updateTaskStatus(db, retry.id, 'running');
    expect((await collapsed()).map((i) => [i.id, i.effectiveStatus])).toEqual([
      [retry.id, 'running'],
    ]);
  });

  it('a retry that succeeds: the newest done task represents the completed run', async () => {
    const { flowRunId } = await seedFlowRun(db, GRAPH);
    await addAttempt(db, flowRunId, 'failed');
    const retry = await addAttempt(db, flowRunId, 'done');
    await setFlowRunStatus(db, flowRunId, 'completed', { completedAt: new Date() });

    expect((await collapsed()).map((i) => [i.id, i.effectiveStatus])).toEqual([[retry.id, 'done']]);
  });

  it('deleting failed tasks keeps the history of a run that is live again', async () => {
    const { flowRunId } = await seedFlowRun(db, GRAPH);
    const old = await addAttempt(db, flowRunId, 'failed');
    await addAttempt(db, flowRunId, 'running');

    expect(await deleteTasksMatchingStatuses(db, ['failed'])).toBe(0);
    expect(await getTaskById(db, old.id)).not.toBeNull();
  });
});

describe('deleteTasksMatchingStatuses — bulk delete matches the collapsed EFFECTIVE status', () => {
  let db: TestDb;
  beforeEach(() => {
    db = freshDb();
  });

  const remainingIds = async () =>
    listTasksWithProjectPaginated(db, {}).then((r) => r.items.map((i) => i.id));

  it('no statuses → no-op', async () => {
    await createTask(db, { description: 'm', source: 'manual' });
    expect(await deleteTasksMatchingStatuses(db, [])).toBe(0);
    expect(await remainingIds()).toHaveLength(1);
  });

  it("cancelled flow: deletes its tasks though their RAW status is done/running (zero raw 'cancelled' rows)", async () => {
    const { flowRunId } = await seedFlowRun(db, GRAPH);
    await addFlowTask(db, flowRunId, 'done');
    await addFlowTask(db, flowRunId, 'running'); // zombie raw-running of an already-cancelled flow
    await setFlowRunStatus(db, flowRunId, 'cancelled', { completedAt: new Date() });

    // The queue shows 1 cancelled (collapsed), but no row has raw status 'cancelled'.
    expect((await getTaskCounts(db, { collapseByFlow: true })).cancelled).toBe(1);

    expect(await deleteTasksMatchingStatuses(db, ['cancelled'])).toBe(2);
    expect(await remainingIds()).toHaveLength(0);
    expect((await getTaskCounts(db, { collapseByFlow: true })).cancelled).toBe(0);
  });

  it('active flow: deleting [failed] removes the failed node but preserves recoverable running/pending siblings', async () => {
    const { flowRunId } = await seedFlowRun(db, GRAPH);
    const failed = await addFlowTask(db, flowRunId, 'failed');
    const running = await addFlowTask(db, flowRunId, 'running');
    const pending = await addFlowTask(db, flowRunId, 'pending');
    await setFlowRunStatus(db, flowRunId, 'paused');

    expect(await deleteTasksMatchingStatuses(db, ['failed'])).toBe(1);
    const ids = new Set(await remainingIds());
    expect(ids.has(failed.id)).toBe(false);
    expect(ids.has(running.id)).toBe(true); // re-run-from-previous-node stays intact
    expect(ids.has(pending.id)).toBe(true);
  });

  it("completed-tab delete ['done','completed'] does NOT touch a cancelled flow's raw-done task", async () => {
    const { flowRunId: completedRun, versionId } = await seedFlowRun(db, GRAPH);
    await addFlowTask(db, completedRun, 'done');
    await setFlowRunStatus(db, completedRun, 'completed', { completedAt: new Date() });

    const { run: cancelledRun } = await getOrCreateFlowRunByIdempotencyKey(db, {
      flowVersionId: versionId,
      status: 'running',
      triggerContext: null,
      idempotencyKey: 'c',
      startedAt: new Date(),
    });
    const cancelledTask = await addFlowTask(db, cancelledRun.id, 'done'); // raw 'done', flow cancelled
    await setFlowRunStatus(db, cancelledRun.id, 'cancelled', { completedAt: new Date() });

    // Raw-status delete would wrongly remove cancelledTask (raw 'done'); effective-status delete must not.
    expect(await deleteTasksMatchingStatuses(db, ['done', 'completed'])).toBe(1);
    expect(await remainingIds()).toEqual([cancelledTask.id]);
  });

  it("completed flow: deleting ['done','completed'] clears ALL its node tasks (full collapse clear)", async () => {
    const { flowRunId } = await seedFlowRun(db, GRAPH);
    await addFlowTask(db, flowRunId, 'done');
    await addFlowTask(db, flowRunId, 'done');
    await addFlowTask(db, flowRunId, 'completed');
    await setFlowRunStatus(db, flowRunId, 'completed', { completedAt: new Date() });

    // The queue collapses these to ONE 'completed' row; the delete must clear every underlying task.
    expect(await deleteTasksMatchingStatuses(db, ['done', 'completed'])).toBe(3);
    expect(await remainingIds()).toHaveLength(0);
  });

  it("transient gap: a paused flow's hidden raw-done node is NOT cleared by a Completed-tab delete", async () => {
    // A done agent of a still-paused flow reads effective 'running' (collapsed into Active), so a
    // History>Completed "delete all" (['done','completed']) must not reach it.
    const { flowRunId } = await seedFlowRun(db, GRAPH);
    const doneNode = await addFlowTask(db, flowRunId, 'done');
    await setFlowRunStatus(db, flowRunId, 'paused');

    expect(await deleteTasksMatchingStatuses(db, ['done', 'completed'])).toBe(0);
    expect(await remainingIds()).toEqual([doneNode.id]);
  });

  it('manual (non-flow) tasks: effective == raw status, so raw matching is unchanged', async () => {
    const cancelled = await createTask(db, { description: 'm', source: 'manual' });
    await updateTaskStatus(db, cancelled.id, 'cancelled');
    const done = await createTask(db, { description: 'm2', source: 'manual' });
    await updateTaskStatus(db, done.id, 'done');

    expect(await deleteTasksMatchingStatuses(db, ['cancelled'])).toBe(1);
    expect(await remainingIds()).toEqual([done.id]);
  });

  // Every row belongs to the one owner of this database, so the status list is the only bound on
  // the delete: it reaches every matching row, and rows of other statuses stay.
  it('reaches every row of the listed statuses and no others', async () => {
    const cancelledA = await createTask(db, { description: 'a', source: 'manual' });
    await updateTaskStatus(db, cancelledA.id, 'cancelled');
    const cancelledB = await createTask(db, { description: 'b', source: 'manual' });
    await updateTaskStatus(db, cancelledB.id, 'cancelled');
    const failed = await createTask(db, { description: 'c', source: 'manual' });
    await updateTaskStatus(db, failed.id, 'failed');

    expect(await deleteTasksMatchingStatuses(db, ['cancelled'])).toBe(2);
    expect(await getTaskById(db, cancelledA.id)).toBeNull();
    expect(await getTaskById(db, cancelledB.id)).toBeNull();
    expect(await getTaskById(db, failed.id)).not.toBeNull();
  });

  // Guards the "protected from accidental bulk clear" invariant: an interrupted run derives
  // `interrupted`, so neither the History→Cancelled sweep (['cancelled']) nor the Needs-Attention
  // sweep (['needs_attention']) may reach it. If effectiveStatusExpr ever reverts to raw status this
  // fails, catching a silent regression that would destroy a recoverable run's worktree.
  it('an interrupted run is untouched by delete-all for cancelled OR needs_attention', async () => {
    const { flowRunId } = await seedFlowRun(db, GRAPH);
    const task = await addFlowTask(db, flowRunId, 'running');
    await updateTaskStatus(db, task.id, 'cancelled', {
      result: { cancelled: true, error: RESTART_INTERRUPTION_REASON },
    });
    await setFlowRunStatus(db, flowRunId, 'cancelled');

    expect(await deleteTasksMatchingStatuses(db, ['cancelled'])).toBe(0);
    expect(await deleteTasksMatchingStatuses(db, ['needs_attention'])).toBe(0);
    expect(await getTaskById(db, task.id)).not.toBeNull();
  });
});

describe('getFlowDriveInfoForSubChat — flow-driving task is the signal target', () => {
  let db: TestDb;
  beforeEach(() => {
    db = freshDb();
  });

  // A flow task linked to a sub-chat via result.subChatId, driven to `status`.
  const flowTaskOnSubChat = async (
    subChatId: string,
    status: TaskStatus,
    extraResult: Record<string, unknown> = {},
  ) => {
    const t = await createTask(db, {
      description: status,
      source: 'flow',
      result: { subChatId, ...extraResult },
    });
    if (status !== 'pending')
      await updateTaskStatus(db, t.id, status, { result: { subChatId, ...extraResult } });
    return t;
  };

  it('returns the RUNNING plan task, not the chat-pinned DONE evaluate task', async () => {
    await flowTaskOnSubChat('sc1', 'done'); // evaluate — terminal, must be ignored
    const plan = await flowTaskOnSubChat('sc1', 'running', { startMode: 'plan', skipReview: true });

    const info = await getFlowDriveInfoForSubChat(db, 'sc1');
    expect(info.active).toBe(true);
    expect(info.taskId).toBe(plan.id); // signal target = the running plan task
    expect(info.autoApprovePlan).toBe(true);
  });

  it('returns taskId null when no flow task drives the sub-chat', async () => {
    await flowTaskOnSubChat('other', 'running');
    const info = await getFlowDriveInfoForSubChat(db, 'sc-none');
    expect(info).toEqual({ active: false, autoApprovePlan: false, taskId: null });
  });

  it('ignores a terminal task on the sub-chat (only FLOW_DRIVING statuses count)', async () => {
    await flowTaskOnSubChat('sc2', 'done');
    const info = await getFlowDriveInfoForSubChat(db, 'sc2');
    expect(info.active).toBe(false);
    expect(info.taskId).toBeNull();
  });

  it('is blind to a freshly dispatched task until the executor stamps result.subChatId', async () => {
    // dispatchAgent creates the next node's task carrying chatId/subChatId in triggerContext ONLY;
    // task-executor writes result.{chatId,subChatId} on the running transition. So a node's task is
    // invisible here for the whole of its pending window — which is WHY a chat surface must take
    // flow liveness from getActiveFlowRunForSubChat (run-side) and never from a task row. Widening
    // this query to read triggerContext would not close the window: the watcher's poll gap precedes
    // task creation, and it would move the executor's effectiveSignalTaskId target.
    await createTask(db, {
      description: 'node 2',
      source: 'flow',
      triggerContext: { chatId: 'c1', subChatId: 'sc-pending' },
    });
    expect(await getFlowDriveInfoForSubChat(db, 'sc-pending')).toEqual({
      active: false,
      autoApprovePlan: false,
      taskId: null,
    });
  });

  it('resolves a non-running driving task too (e.g. a `needs_attention` plan task from a partial signal)', async () => {
    // The continuation agent signalled `partial` → needs_attention; the signal must still target
    // THIS task, not the pinned done one. needs_attention is a FLOW_DRIVING status.
    await flowTaskOnSubChat('sc3', 'done'); // first node, terminal
    const planNode = await flowTaskOnSubChat('sc3', 'needs_attention', { startMode: 'plan' });

    const info = await getFlowDriveInfoForSubChat(db, 'sc3');
    expect(info.active).toBe(true);
    expect(info.taskId).toBe(planNode.id);
  });

  // A parked task outlives its run going terminal, so status alone said "driving" long after the
  // flow was over — which re-armed the agent's task-signal apparatus on interactive turns.
  describe('run liveness gates driving-ness', () => {
    /** A parked (needs_attention) flow task on `sub`, linked to a run driven to `runStatus`. */
    const parkedTaskOnRun = async (sub: string, runStatus: FlowRunStatus) => {
      const { flowRunId } = await seedFlowRun(db, GRAPH, { idempotencyKey: `k-${sub}` });
      const t = await createTask(db, {
        description: 'parked',
        source: 'flow',
        flowRunId,
        result: { subChatId: sub },
      });
      await updateTaskStatus(db, t.id, 'needs_attention', { result: { subChatId: sub } });
      await setFlowRunStatus(db, flowRunId, runStatus);
      return { taskId: t.id, flowRunId };
    };

    it.each(['cancelled', 'completed'] as const)(
      'a parked task on a %s run does NOT drive',
      async (runStatus) => {
        const { taskId } = await parkedTaskOnRun(`sc-${runStatus}`, runStatus);
        const info = await getFlowDriveInfoForSubChat(db, `sc-${runStatus}`);
        expect(info.active).toBe(false);
        expect(info.taskId).toBeNull();
        // The row itself is untouched — this is a read-side guard, not a sweep.
        expect((await getTaskById(db, taskId))?.status).toBe('needs_attention');
      },
    );

    // Both are chat-reply resume surfaces: a follow-up flips the task back to running and unparks
    // the run in place. Disarming them would silently kill that recovery.
    it.each(['paused', 'failed'] as const)(
      'a parked task on a %s run STILL drives (resume surface)',
      async (runStatus) => {
        const { taskId } = await parkedTaskOnRun(`sc-${runStatus}`, runStatus);
        const info = await getFlowDriveInfoForSubChat(db, `sc-${runStatus}`);
        expect(info.active).toBe(true);
        expect(info.taskId).toBe(taskId);
      },
    );

    it('keeps driving when the run row is gone (flow_run_id NULL via onDelete: set null)', async () => {
      const t = await flowTaskOnSubChat('sc-orphan', 'needs_attention');
      const info = await getFlowDriveInfoForSubChat(db, 'sc-orphan');
      expect(info.active).toBe(true);
      expect(info.taskId).toBe(t.id);
    });
  });
});

describe('getLatestFlowTaskForSubChat — newest flow task incl. terminal (cancelled-resume signal)', () => {
  let db: TestDb;
  beforeEach(() => {
    db = freshDb();
  });

  const flowTaskOnSubChat = async (subChatId: string, status: TaskStatus, flowRunId?: string) => {
    const t = await createTask(db, {
      description: status,
      source: 'flow',
      flowRunId: flowRunId ?? null,
      result: { subChatId },
    });
    if (status !== 'pending') await updateTaskStatus(db, t.id, status, { result: { subChatId } });
    return t;
  };

  it('returns the newest task even when it is cancelled (unlike getFlowDriveInfoForSubChat)', async () => {
    // A real flow_run is required — tasks.flow_run_id is a FK.
    const { flowRunId } = await seedFlowRun(db, GRAPH);
    await flowTaskOnSubChat('sc1', 'done');
    const cancelled = await flowTaskOnSubChat('sc1', 'cancelled', flowRunId);
    const latest = await getLatestFlowTaskForSubChat(db, 'sc1');
    expect(latest?.id).toBe(cancelled.id);
    expect(latest?.status).toBe('cancelled');
    expect(latest?.flowRunId).toBe(flowRunId);
  });

  it('returns null for a sub-chat with no flow task', async () => {
    await flowTaskOnSubChat('other', 'running');
    expect(await getLatestFlowTaskForSubChat(db, 'sc-none')).toBeNull();
  });

  it('returns null for an empty sub-chat id', async () => {
    expect(await getLatestFlowTaskForSubChat(db, '')).toBeNull();
  });
});

describe('getLatestFlowTaskForRun — newest driving task on a flow_run (batch carry-on target)', () => {
  let db: TestDb;
  beforeEach(() => {
    db = freshDb();
  });

  it('returns the latest driving task, not an earlier done upstream task on the same run', async () => {
    const { flowRunId } = await seedFlowRun(db, GRAPH);
    await addFlowTask(db, flowRunId, 'done'); // upstream node finished earlier
    const failed = await addFlowTask(db, flowRunId, 'failed'); // the driving node that failed (latest)
    const latest = await getLatestFlowTaskForRun(db, flowRunId);
    expect(latest?.id).toBe(failed.id);
    expect(latest?.status).toBe('failed');
    expect(latest?.flowRunId).toBe(flowRunId);
  });

  it('returns null for a run with no flow task, and for an empty id', async () => {
    const { flowRunId } = await seedFlowRun(db, GRAPH);
    expect(await getLatestFlowTaskForRun(db, flowRunId)).toBeNull();
    expect(await getLatestFlowTaskForRun(db, '')).toBeNull();
  });
});

describe('getFlowChatForNodeRun — Runs-tab Answer jump chat resolution', () => {
  let db: TestDb;
  beforeEach(() => {
    db = freshDb();
  });

  const nodeRunWithTask = async (result: Record<string, unknown>) => {
    const { flowRunId } = await seedFlowRun(db, GRAPH);
    const nr = await createNodeRun(db, {
      flowRunId,
      nodeId: 'a',
      blockType: 'agent',
      status: 'pending',
    });
    await createTask(db, {
      description: 'agent',
      source: 'flow',
      flowRunId,
      nodeRunId: nr.id,
      result,
    });
    return nr;
  };

  it('resolves chatId + subChatId from the node_run task result', async () => {
    const nr = await nodeRunWithTask({ chatId: 'c1', subChatId: 'sc1' });
    expect(await getFlowChatForNodeRun(db, nr.id)).toEqual({ chatId: 'c1', subChatId: 'sc1' });
  });

  it('returns null when the task carries no chatId (non-agent block)', async () => {
    const nr = await nodeRunWithTask({ subChatId: 'sc1' });
    expect(await getFlowChatForNodeRun(db, nr.id)).toBeNull();
  });

  it('returns null for an unknown node_run and an empty id', async () => {
    await nodeRunWithTask({ chatId: 'c1' });
    expect(await getFlowChatForNodeRun(db, 'nr-nonexistent')).toBeNull();
    expect(await getFlowChatForNodeRun(db, '')).toBeNull();
  });
});

describe('getFlowBriefingForSubChat — session briefing from the newest flow task _config', () => {
  let db: TestDb;
  beforeEach(() => {
    db = freshDb();
  });

  const flowTaskWithBriefing = async (
    subChatId: string,
    briefing: string | undefined,
    status: TaskStatus = 'running',
  ) => {
    const t = await createTask(db, {
      description: 'agent',
      source: 'flow',
      result: { subChatId },
      triggerContext: briefing !== undefined ? { _config: { flowBriefing: briefing } } : null,
    });
    if (status !== 'pending') await updateTaskStatus(db, t.id, status, { result: { subChatId } });
    return t;
  };

  it('returns the briefing stashed on the flow task for the sub-chat', async () => {
    await flowTaskWithBriefing('sc1', 'PRD: use strict mode');
    expect(await getFlowBriefingForSubChat(db, 'sc1')).toBe('PRD: use strict mode');
  });

  it('persists after the flow completes — newest flow task (any status) wins', async () => {
    await flowTaskWithBriefing('sc1', 'first briefing', 'done');
    await flowTaskWithBriefing('sc1', 'latest briefing', 'done');
    expect(await getFlowBriefingForSubChat(db, 'sc1')).toBe('latest briefing');
  });

  it('returns "" for an interactive (non-flow) sub-chat', async () => {
    await createTask(db, { description: 'm', source: 'manual' });
    expect(await getFlowBriefingForSubChat(db, 'sc-none')).toBe('');
  });

  it('returns "" when the flow task carries no briefing', async () => {
    await flowTaskWithBriefing('sc1', undefined);
    expect(await getFlowBriefingForSubChat(db, 'sc1')).toBe('');
  });

  it('returns "" when _config exists but has no flowBriefing key (real flow task shape)', async () => {
    // Every flow task carries a _config (executionMode/continueChatId/…); only briefing flows stash
    // flowBriefing. json_extract of the absent key must resolve to '' — not the JSON of _config.
    await createTask(db, {
      description: 'agent',
      source: 'flow',
      result: { subChatId: 'sc1' },
      triggerContext: { _config: { executionMode: 'continue_chat', continueChatId: 'chat-1' } },
    });
    await updateTaskStatus(
      db,
      (await getLatestFlowTaskForSubChat(db, 'sc1'))?.id ?? '',
      'running',
      {
        result: { subChatId: 'sc1' },
      },
    );
    expect(await getFlowBriefingForSubChat(db, 'sc1')).toBe('');
  });

  it('ignores a newer non-flow task on the same sub-chat — reads only the flow task _config', async () => {
    await flowTaskWithBriefing('sc1', 'PRD: strict mode');
    // A manual (source != flow) task later lands on the same sub-chat; it must not shadow the briefing.
    const manual = await createTask(db, {
      description: 'manual follow-up',
      source: 'manual',
      result: { subChatId: 'sc1' },
    });
    await updateTaskStatus(db, manual.id, 'running', { result: { subChatId: 'sc1' } });
    expect(await getFlowBriefingForSubChat(db, 'sc1')).toBe('PRD: strict mode');
  });

  it('a newer briefing-less flow task (e.g. CEO batch_message) does not shadow the agent briefing', async () => {
    await flowTaskWithBriefing('sc1', 'PRD: strict mode');
    // A later flow task with a _config but NO flowBriefing (batch_message/CEO continuation shape).
    const batch = await createTask(db, {
      description: 'CEO message',
      source: 'flow',
      result: { subChatId: 'sc1' },
      triggerContext: { _config: { blockType: 'batch_message', isFlowContinuation: true } },
    });
    await updateTaskStatus(db, batch.id, 'running', { result: { subChatId: 'sc1' } });
    expect(await getFlowBriefingForSubChat(db, 'sc1')).toBe('PRD: strict mode');
  });

  it('returns "" for an empty sub-chat id', async () => {
    expect(await getFlowBriefingForSubChat(db, '')).toBe('');
  });
});

describe('cancelFlowTaskForSubChat — terminalize the driving flow task on teardown', () => {
  let db: TestDb;
  beforeEach(() => {
    db = freshDb();
  });

  const flowTaskOnSubChat = async (subChatId: string, status: TaskStatus) => {
    const t = await createTask(db, {
      description: status,
      source: 'flow',
      result: { subChatId },
    });
    if (status !== 'pending') await updateTaskStatus(db, t.id, status, { result: { subChatId } });
    return t;
  };

  it('interrupted (reload/crash): cancels the driving task and stamps the re-run marker', async () => {
    const task = await flowTaskOnSubChat('sc1', 'running');

    const id = await cancelFlowTaskForSubChat(db, 'sc1', { interrupted: true });
    expect(id).toBe(task.id);

    const row = await getTaskById(db, task.id);
    expect(row?.status).toBe('cancelled');
    expect((row?.result as { error?: string } | null)?.error).toBe(RESTART_INTERRUPTION_REASON);
  });

  it('deliberate Stop: cancels the driving task with NO re-run marker', async () => {
    const task = await flowTaskOnSubChat('sc2', 'running');

    const id = await cancelFlowTaskForSubChat(db, 'sc2', { interrupted: false });
    expect(id).toBe(task.id);

    const row = await getTaskById(db, task.id);
    expect(row?.status).toBe('cancelled');
    expect((row?.result as { error?: string } | null)?.error).toBeUndefined();
  });

  it('MERGES the cancel marker — result.subChatId survives, so the task stays findable', async () => {
    // The cancel marker used to REPLACE result, wiping the subChatId that is the ONLY link
    // getLatestFlowTaskForSubChat has. That orphaned the cancelled task from its sub-chat: the
    // restart-interrupted run it identifies could not be revived by a chat reply, and the chat
    // surface could not tell the interruption from a live taskless window.
    const task = await flowTaskOnSubChat('sc-merge', 'running');
    await updateTaskStatus(db, task.id, 'running', {
      result: { subChatId: 'sc-merge', startMode: 'plan' },
    });

    await cancelFlowTaskForSubChat(db, 'sc-merge', { interrupted: true });

    const row = await getTaskById(db, task.id);
    expect(row?.result).toMatchObject({
      subChatId: 'sc-merge',
      startMode: 'plan',
      cancelled: true,
      error: RESTART_INTERRUPTION_REASON,
    });
    expect(await getLatestFlowTaskForSubChat(db, 'sc-merge')).toMatchObject({
      id: task.id,
      status: 'cancelled',
    });
  });

  it('no-op for an interactive (non-flow) sub-chat — nothing to terminalize', async () => {
    const manual = await createTask(db, { description: 'm', source: 'manual' });
    await updateTaskStatus(db, manual.id, 'running');

    const id = await cancelFlowTaskForSubChat(db, 'sc-none', { interrupted: true });
    expect(id).toBeNull();
    expect((await getTaskById(db, manual.id))?.status).toBe('running');
  });

  it('cancels a still-pending (never-claimed) driving task — pending is a FLOW_DRIVING status', async () => {
    // 44's case: the next agent task was created but never claimed by the poller (started_at NULL).
    const task = await flowTaskOnSubChat('sc3', 'pending');

    const id = await cancelFlowTaskForSubChat(db, 'sc3', { interrupted: true });
    expect(id).toBe(task.id);
    const row = await getTaskById(db, task.id);
    expect(row?.status).toBe('cancelled');
    expect((row?.result as { error?: string } | null)?.error).toBe(RESTART_INTERRUPTION_REASON);
  });

  it('no-op when the driving task already went terminal (double-teardown race: first write wins)', async () => {
    // A Stop and a reload can both fire for the same sub-chat. getFlowDriveInfoForSubChat only sees
    // FLOW_DRIVING (non-terminal) tasks, so once the first teardown cancelled it the second is a no-op.
    await flowTaskOnSubChat('sc4', 'done'); // already terminal — not flow-driving
    const id = await cancelFlowTaskForSubChat(db, 'sc4', { interrupted: true });
    expect(id).toBeNull();
  });
});

describe('parkFlowTaskForSubChat — resumable interruptions park the driving task', () => {
  let db: TestDb;
  beforeEach(() => {
    db = freshDb();
  });

  const LIMIT_TEXT = "You've hit your limit · resets 2:20pm (Europe/London)";

  const runningFlowTaskOnSubChat = async (
    subChatId: string,
    extraResult: Record<string, unknown> = {},
  ) => {
    const t = await createTask(db, {
      description: 'agent node',
      source: 'flow',
      result: { subChatId, ...extraResult },
    });
    await updateTaskStatus(db, t.id, 'running', { result: { subChatId, ...extraResult } });
    return t;
  };

  it('parks the running driving task as needs_attention with the limit text', async () => {
    const task = await runningFlowTaskOnSubChat('sc1', { startMode: 'execute' });

    const id = await parkFlowTaskForSubChat(db, 'sc1', {
      kind: 'usage-limit',
      limitText: LIMIT_TEXT,
    });
    expect(id).toBe(task.id);

    const row = await getTaskById(db, task.id);
    expect(row?.status).toBe('needs_attention');
    // Result is MERGED — resume/signal routing depend on these surviving the park.
    expect(row?.result).toMatchObject({
      usageLimit: { message: LIMIT_TEXT },
      subChatId: 'sc1',
      startMode: 'execute',
    });
  });

  it('strips stale failure metadata — a limit is not an error', async () => {
    const task = await runningFlowTaskOnSubChat('sc2', {
      error: 'previous transient failure',
      failureCode: 'EXEC',
      staleExecution: true,
      staleDetectedAt: '2026-06-10T00:00:00Z',
    });

    await parkFlowTaskForSubChat(db, 'sc2', { kind: 'usage-limit', limitText: LIMIT_TEXT });

    const result = (await getTaskById(db, task.id))?.result as Record<string, unknown>;
    expect(result.error).toBeUndefined();
    expect(result.failureCode).toBeUndefined();
    expect(result.staleExecution).toBeUndefined();
    expect(result.staleDetectedAt).toBeUndefined();
  });

  it('no-op for a non-flow task on the sub-chat (work-queue semantics differ)', async () => {
    const manual = await createTask(db, {
      description: 'm',
      source: 'manual',
      result: { subChatId: 'sc3' },
    });
    await updateTaskStatus(db, manual.id, 'running');

    const id = await parkFlowTaskForSubChat(db, 'sc3', {
      kind: 'usage-limit',
      limitText: LIMIT_TEXT,
    });
    expect(id).toBeNull();
    expect((await getTaskById(db, manual.id))?.status).toBe('running');
  });

  it('no-op when the driving task is not running (only an active execution can hit the limit)', async () => {
    const t = await createTask(db, {
      description: 'parked',
      source: 'flow',
      result: { subChatId: 'sc4' },
    });
    await updateTaskStatus(db, t.id, 'needs_attention', { result: { subChatId: 'sc4' } });

    const id = await parkFlowTaskForSubChat(db, 'sc4', {
      kind: 'usage-limit',
      limitText: LIMIT_TEXT,
    });
    expect(id).toBeNull();
  });

  it('no-op when no task is linked to the sub-chat', async () => {
    const id = await parkFlowTaskForSubChat(db, 'sc-none', {
      kind: 'usage-limit',
      limitText: LIMIT_TEXT,
    });
    expect(id).toBeNull();
  });

  it('api-error reason writes result.apiError with status', async () => {
    const task = await runningFlowTaskOnSubChat('sc-api', { startMode: 'execute' });

    const id = await parkFlowTaskForSubChat(db, 'sc-api', {
      kind: 'api-error',
      status: 401,
      message: 'API Error: 401 authentication_error',
    });
    expect(id).toBe(task.id);

    const row = await getTaskById(db, task.id);
    expect(row?.status).toBe('needs_attention');
    const apiError = (row?.result as Record<string, unknown>).apiError as {
      message: string;
      status: number | null;
    };
    expect(apiError.status).toBe(401);
    expect(apiError.message).toContain('401');
  });

  it('a new park reason supersedes a prior one (no stale usageLimit alongside apiError)', async () => {
    const task = await runningFlowTaskOnSubChat('sc-super', {
      startMode: 'execute',
      usageLimit: { message: 'old limit', at: '2026-01-01T00:00:00Z' },
    });

    await parkFlowTaskForSubChat(db, 'sc-super', {
      kind: 'api-error',
      status: 529,
      message: 'API Error: 529',
    });

    const result = (await getTaskById(db, task.id))?.result as Record<string, unknown>;
    expect(result.usageLimit).toBeUndefined();
    expect((result.apiError as { status: number }).status).toBe(529);
  });

  it('a BATCH member parks needs_attention just like any other flow task', async () => {
    // A batch member's run is `paused` (not terminal) for its whole life on an agent node, so
    // stage settlement never depended on the task failing — it parks and recovers identically.
    const { flowRunId } = await seedFlowRun(db, GRAPH);
    await db.update(flowRuns).set({ batchId: 'b1' }).where(eq(flowRuns.id, flowRunId));
    const t = await createTask(db, {
      description: 'batch member',
      source: 'flow',
      flowRunId,
      result: { subChatId: 'sc-batch' },
    });
    await updateTaskStatus(db, t.id, 'running', { result: { subChatId: 'sc-batch' } });

    const id = await parkFlowTaskForSubChat(db, 'sc-batch', {
      kind: 'api-error',
      status: 401,
      message: 'API Error: 401',
    });
    expect(id).toBe(t.id);
    const row = await getTaskById(db, t.id);
    expect(row?.status).toBe('needs_attention');
    expect(row?.result).toMatchObject({ apiError: { status: 401 } });
    expect(row?.result).not.toHaveProperty('error');
  });

  it('user-pause parks with the userPause marker, scrubbing stale failure metadata', async () => {
    const task = await runningFlowTaskOnSubChat('sc-pause', {
      startMode: 'execute',
      error: 'previous transient failure',
      apiError: { message: 'old', status: 500, at: '2026-01-01T00:00:00Z' },
    });

    const id = await parkFlowTaskForSubChat(db, 'sc-pause', { kind: 'user-pause' });
    expect(id).toBe(task.id);

    const row = await getTaskById(db, task.id);
    expect(row?.status).toBe('needs_attention');
    const result = row?.result as Record<string, unknown>;
    expect((result.userPause as { at: string }).at).toBeTruthy();
    expect(result.error).toBeUndefined();
    expect(result.apiError).toBeUndefined();
    // Result is MERGED — resume/signal routing depend on these surviving the park.
    expect(result.subChatId).toBe('sc-pause');
    expect(result.startMode).toBe('execute');
  });

  it('user-pause voids a signal the agent recorded mid-turn (stale done must not advance)', async () => {
    const task = await runningFlowTaskOnSubChat('sc-pause-sig', {
      agentSignal: { state: 'done', summary: 'mid-stream record' },
    });

    await parkFlowTaskForSubChat(db, 'sc-pause-sig', { kind: 'user-pause' });

    const result = (await getTaskById(db, task.id))?.result as Record<string, unknown>;
    expect(result.agentSignal).toBeUndefined();
    expect(result.userPause).toBeTruthy();
  });

  it('a transient park keeps a recorded agentSignal (its turn resumes with that context)', async () => {
    const task = await runningFlowTaskOnSubChat('sc-limit-sig', {
      agentSignal: { state: 'awaiting_input', summary: 'question so far' },
    });

    await parkFlowTaskForSubChat(db, 'sc-limit-sig', { kind: 'usage-limit', limitText: 'limit' });

    const result = (await getTaskById(db, task.id))?.result as Record<string, unknown>;
    expect(result.agentSignal).toBeTruthy();
  });

  it('a later real park supersedes a stale userPause marker', async () => {
    const task = await runningFlowTaskOnSubChat('sc-pause-super', {
      userPause: { at: '2026-01-01T00:00:00Z' },
    });

    await parkFlowTaskForSubChat(db, 'sc-pause-super', {
      kind: 'api-error',
      status: 529,
      message: 'API Error: 529',
    });

    const result = (await getTaskById(db, task.id))?.result as Record<string, unknown>;
    expect(result.userPause).toBeUndefined();
    expect((result.apiError as { status: number }).status).toBe(529);
  });
});

describe('retryTaskDetailed — only the current attempt of a node can be retried', () => {
  let db: TestDb;
  beforeEach(() => {
    db = freshDb();
  });

  it('refuses the attempt a retry replaced and leaves it failed', async () => {
    const { flowRunId } = await seedFlowRun(db, GRAPH);
    const old = await addAttempt(db, flowRunId, 'failed');
    await addAttempt(db, flowRunId, 'running');
    await setFlowRunStatus(db, flowRunId, 'paused');

    const { task, reason } = await retryTaskDetailed(db, old.id, 'continue', flowRunId);
    expect([task, reason]).toEqual([null, 'invalid_state']);
    expect((await getTaskById(db, old.id))?.status).toBe('failed');
  });

  it('refuses the replaced attempt as soon as the new node_run exists, before it has a task', async () => {
    const { flowRunId } = await seedFlowRun(db, GRAPH);
    const old = await addAttempt(db, flowRunId, 'needs_attention');
    await createNodeRun(db, { flowRunId, nodeId: 'a', blockType: 'agent' });
    await setFlowRunStatus(db, flowRunId, 'paused');

    const { task, reason } = await retryTaskDetailed(db, old.id, 'continue', flowRunId);
    expect([task, reason]).toEqual([null, 'invalid_state']);
    expect((await getTaskById(db, old.id))?.status).toBe('needs_attention');
  });

  it('retries the newest attempt of a node that was retried before', async () => {
    const { flowRunId } = await seedFlowRun(db, GRAPH);
    await addAttempt(db, flowRunId, 'failed');
    const newest = await addAttempt(db, flowRunId, 'failed');
    await setFlowRunStatus(db, flowRunId, 'paused');

    const { task } = await retryTaskDetailed(db, newest.id, 'continue', flowRunId);
    expect(task?.status).toBe('pending');
  });

  it('is not blocked by a newer attempt in another fan-out lane or of another node', async () => {
    const { flowRunId } = await seedFlowRun(db, GRAPH);
    const lane1 = await addAttempt(db, flowRunId, 'failed', { laneIndex: 1 });
    await addAttempt(db, flowRunId, 'running', { laneIndex: 2 });
    await addAttempt(db, flowRunId, 'running', { nodeId: 'b', laneIndex: 1 });
    await setFlowRunStatus(db, flowRunId, 'paused');

    const { task } = await retryTaskDetailed(db, lane1.id, 'continue', flowRunId);
    expect(task?.status).toBe('pending');
  });
});

describe('retryTaskDetailed — user-requested retry flips failed/parked → pending, scrubbed', () => {
  let db: TestDb;
  beforeEach(() => {
    db = freshDb();
  });

  const failTaskWith = async (result: Record<string, unknown>) => {
    const t = await createTask(db, { description: 'agent', source: 'flow' });
    await updateTaskStatus(db, t.id, 'failed', { result });
    return t;
  };

  it('scrubs stale failure metadata, keeps the linkage, and records the retry marker', async () => {
    const t = await failTaskWith({
      chatId: 'c1',
      subChatId: 'sc1',
      startMode: 'execute',
      error: 'API Error: 401 boom',
      errorAction: 'open-connect-account',
      dispatchAttempts: 7,
      failureCode: 'X',
      agentSignal: { kind: 'failed' },
      usageLimit: { message: 'limit' },
      cancelled: true,
      heldQuestions: { 'tu-1': { summary: 'stale ask' } },
    });

    const { task } = await retryTaskDetailed(db, t.id, 'continue');
    expect(task?.status).toBe('pending');
    expect(task?.completedAt).toBeNull();

    const result = task?.result as Record<string, unknown>;
    expect(result.chatId).toBe('c1');
    expect(result.subChatId).toBe('sc1');
    expect(result.startMode).toBe('execute');
    expect(result.retryMode).toBe('continue');
    // Prior error is preserved (truncated) for the continuation nudge.
    expect(result.retryPriorError).toBe('API Error: 401 boom');
    for (const key of [
      'error',
      'errorAction',
      'dispatchAttempts',
      'failureCode',
      'agentSignal',
      'usageLimit',
      'cancelled',
      'heldQuestions',
    ]) {
      expect(result[key]).toBeUndefined();
    }
  });

  it('restart additionally drops the chat linkage so a fresh chat + worktree is provisioned', async () => {
    const t = await failTaskWith({ chatId: 'c1', subChatId: 'sc1', error: 'boom' });

    const { task } = await retryTaskDetailed(db, t.id, 'restart');
    const result = task?.result as Record<string, unknown>;
    expect(result.chatId).toBeUndefined();
    expect(result.subChatId).toBeUndefined();
    expect(result.retryMode).toBe('restart');
  });

  it('retries a needs_attention park, carrying the park reason as retryPriorError', async () => {
    const t = await createTask(db, { description: 'parked', source: 'flow' });
    await updateTaskStatus(db, t.id, 'needs_attention', {
      result: { subChatId: 'sc1', apiError: { message: 'API Error: 401', status: 401 } },
    });

    const { task } = await retryTaskDetailed(db, t.id, 'continue');
    expect(task?.status).toBe('pending');
    const result = task?.result as Record<string, unknown>;
    expect(result.apiError).toBeUndefined();
    // Parked tasks keep their stop reason under apiError/usageLimit, not error — the
    // continuation nudge must still receive it.
    expect(result.retryPriorError).toBe('API Error: 401');
  });

  it('carries a usage-limit park reason as retryPriorError too', async () => {
    const t = await createTask(db, { description: 'parked', source: 'flow' });
    await updateTaskStatus(db, t.id, 'needs_attention', {
      result: { subChatId: 'sc1', usageLimit: { message: "You've hit your limit · resets 3pm" } },
    });

    const { task } = await retryTaskDetailed(db, t.id, 'continue');
    expect((task?.result as Record<string, unknown>).retryPriorError).toBe(
      "You've hit your limit · resets 3pm",
    );
  });

  it('invalid_state for a running task (CAS — a double-click no-ops)', async () => {
    const t = await createTask(db, { description: 'live', source: 'flow' });
    await updateTaskStatus(db, t.id, 'running');

    const { task, reason } = await retryTaskDetailed(db, t.id, 'continue');
    expect(task).toBeNull();
    expect(reason).toBe('invalid_state');
  });

  it('not_found for a missing task', async () => {
    const { task, reason } = await retryTaskDetailed(db, 'nope', 'continue');
    expect(task).toBeNull();
    expect(reason).toBe('not_found');
  });

  it('rejects non-object task results at every repository write boundary', async () => {
    await expect(
      createTask(db, {
        description: 'invalid',
        source: 'flow',
        result: JSON.stringify({ chatId: 'c1' }),
      }),
    ).rejects.toThrow(/expected record/);

    const task = await createTask(db, { description: 'valid', source: 'flow' });
    expect(() =>
      updateTaskStatus(db, task.id, 'failed', { result: JSON.stringify({ error: 'boom' }) }),
    ).toThrow(/expected record/);
    await expect(updateTaskResult(db, task.id, 'invalid')).rejects.toThrow(/expected record/);
  });

  it('rejects mode restart for a flow-linked task — the flow run restarts via redispatch, not a task flip', async () => {
    const { flowRunId } = await seedFlowRun(db, GRAPH);
    const t = await createTask(db, {
      description: 'flow agent',
      source: 'flow',
      flowRunId,
    });
    await updateTaskStatus(db, t.id, 'failed', { result: { chatId: 'c1', error: 'boom' } });

    const { task, reason } = await retryTaskDetailed(db, t.id, 'restart');
    expect(task).toBeNull();
    expect(reason).toBe('invalid_state');
    expect((await getTaskById(db, t.id))?.status).toBe('failed');
  });
});

describe('terminal-final task statuses (signal disarm predicate)', () => {
  it('treats done/completed/cancelled as terminal-final', () => {
    for (const status of TERMINAL_FINAL_TASK_STATUSES) {
      expect(isTerminalFinalTaskStatus(status)).toBe(true);
    }
  });

  it('keeps resumable statuses armed — a follow-up message flips them back to running', () => {
    // failed/needs_attention MUST stay out of the terminal-final set: the executor's
    // resumeTaskOnFollowUpMessage revives them, so the task-signal apparatus must remain armed.
    for (const status of ['failed', 'needs_attention', 'running', 'pending', 'plan_ready']) {
      expect(isTerminalFinalTaskStatus(status)).toBe(false);
    }
  });
});
