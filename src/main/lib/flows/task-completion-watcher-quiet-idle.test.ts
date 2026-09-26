import { eq } from 'drizzle-orm';
import log from 'electron-log';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { FlowGraph } from '../../../shared/lib/validate-flow-graph';
import { getFlowRun } from '../db/repos/flow-runs';
import { createNodeRun, getNodeRun } from '../db/repos/node-runs';
import { createTask, getTaskById, parseResultRecord, updateTaskStatus } from '../db/repos/tasks';
import { flowRuns, tasks } from '../db/schema';
import { seedFlowRun } from '../db/test-utils/flow-fixtures';
import { freshDb, type TestDb } from '../db/test-utils/fresh-db';

// tick() and its callees read the db via the getDatabase() singleton — point it at the per-test
// in-memory db. Dispatch and the signal broadcast are spied so no real work fans out.
const holder = vi.hoisted(() => ({ db: null as unknown }));
vi.mock('../db', async (orig) => ({
  ...(await orig<typeof import('../db')>()),
  getDatabase: () => holder.db,
}));
vi.mock('./dispatch', () => ({ dispatchNode: vi.fn() }));
vi.mock('../socket/client', () => ({ broadcastTaskSignalPersisted: vi.fn() }));

import { endSession, createSession } from '../socket/claude-session-registry';
import { broadcastTaskSignalPersisted } from '../socket/client';
import {
  resumeQuietIdleParkOnBurst,
  settleBurstSignal,
} from '../socket/execution/wake-hold-signal';
import { resumeParkedTaskInPlace } from '../tasks';
import {
  markLinkedTaskQuietEnd,
  persistLinkedTaskSignal,
} from '../trpc/routers/frink-task-signal-persist';
import { advanceFlowRun } from './advance';
import { resumeFlowNodeInPlace } from './resume';
import { mapTaskToNodeOutput } from './signal-bridge';
import { QUIET_IDLE_PARK_CEILING_MS, tick } from './task-completion-watcher';

const GRAPH: FlowGraph = {
  nodes: [
    { id: 'agent1', blockType: 'agent', config: { instructions: 'go' }, position: { x: 0, y: 0 } },
  ],
  edges: [],
};

const MINUTE_MS = 60_000;
/** A run old enough that a ceiling-expired marker is still newer than its start. */
const RUN_STARTED_AGO_MS = QUIET_IDLE_PARK_CEILING_MS + 5 * MINUTE_MS;

describe('task-completion-watcher — quiet-idle sweep', () => {
  let db: TestDb;
  let flowRunId: string;
  let nodeRunId: string;
  let taskId: string;

  beforeEach(async () => {
    db = freshDb();
    holder.db = db;
    ({ flowRunId } = await seedFlowRun(db, GRAPH));
    const node = await createNodeRun(db, {
      flowRunId,
      nodeId: 'agent1',
      blockType: 'agent',
      status: 'running',
    });
    nodeRunId = node.id;
    const task = await createTask(db, {
      description: 'flow agent turn',
      source: 'flow',
      flowRunId,
      nodeRunId,
    });
    taskId = task.id;
    await updateTaskStatus(db, taskId, 'running');
  });

  async function setRunClock(
    startedAgoMs: number,
    quietEndedAgoMs: number,
    extraResult: Record<string, unknown> = {},
  ): Promise<void> {
    const now = Date.now();
    await db
      .update(tasks)
      .set({
        startedAt: new Date(now - startedAgoMs),
        result: { quietEndedAt: new Date(now - quietEndedAgoMs).toISOString(), ...extraResult },
      })
      .where(eq(tasks.id, taskId));
  }

  it('parks a quiet task once the idle ceiling elapses and pauses its flow run', async () => {
    await setRunClock(RUN_STARTED_AGO_MS, QUIET_IDLE_PARK_CEILING_MS + MINUTE_MS);

    await tick();

    const task = await getTaskById(db, taskId);
    expect(task?.status).toBe('needs_attention');
    expect(JSON.stringify(task?.result)).toContain('missing_completion_signal');
    expect(JSON.stringify(task?.result)).toContain(
      `${QUIET_IDLE_PARK_CEILING_MS / 60_000} minutes`,
    );
    expect((await getNodeRun(db, nodeRunId))?.status).toBe('awaiting_input');
    expect((await getFlowRun(db, flowRunId))?.status).toBe('paused');
    expect(vi.mocked(broadcastTaskSignalPersisted)).toHaveBeenCalledWith({
      taskId,
      status: 'needs_attention',
      isFlowLinked: true,
    });
  });

  it('leaves a quiet task running while the ceiling has not elapsed', async () => {
    await setRunClock(10 * MINUTE_MS, 5 * MINUTE_MS);

    await tick();

    expect((await getTaskById(db, taskId))?.status).toBe('running');
  });

  it('ignores a marker older than startedAt (stale marker from a since-resumed run)', async () => {
    await setRunClock(0, QUIET_IDLE_PARK_CEILING_MS + MINUTE_MS);

    await tick();

    expect((await getTaskById(db, taskId))?.status).toBe('running');
  });

  it('never touches a running task without a quiet-end marker', async () => {
    await tick();

    expect((await getTaskById(db, taskId))?.status).toBe('running');
  });

  it('skips a task with a recorded agent signal — the post-stream terminal flip owns it', async () => {
    const now = Date.now();
    await db
      .update(tasks)
      .set({
        startedAt: new Date(now - RUN_STARTED_AGO_MS),
        result: {
          quietEndedAt: new Date(now - (QUIET_IDLE_PARK_CEILING_MS + MINUTE_MS)).toISOString(),
          agentSignal: { state: 'done', summary: 'Finished', at: new Date(now).toISOString() },
        },
      })
      .where(eq(tasks.id, taskId));

    await tick();

    expect((await getTaskById(db, taskId))?.status).toBe('running');
  });

  it('skips a ceiling-expired task while a RECENTLY ACTIVE session owns its chat, parks once it is gone', async () => {
    const subChatId = `live-${taskId}`;
    // SAFETY: the sweep reads only busy/lastActiveAt; the session's query is never driven.
    const session = createSession(subChatId, () => ({}) as never);
    session.busy = true; // a turn or the wake pump holds the generator — the wait is attended
    session.lastActiveAt = Date.now(); // …and showed activity within the ceiling
    await setRunClock(RUN_STARTED_AGO_MS, QUIET_IDLE_PARK_CEILING_MS + MINUTE_MS, { subChatId });

    await tick();
    expect((await getTaskById(db, taskId))?.status).toBe('running');

    session.busy = false;
    endSession(subChatId);
    await tick();
    expect((await getTaskById(db, taskId))?.status).toBe('needs_attention');
  });

  it('a dead-but-armed pump (busy, no activity for a ceiling) does NOT block the park', async () => {
    const subChatId = `dead-${taskId}`;
    // SAFETY: the sweep reads only busy/lastActiveAt; the session's query is never driven.
    const session = createSession(subChatId, () => ({}) as never);
    session.busy = true;
    // The wake never arrived: the pump has been silent longer than the ceiling itself.
    session.lastActiveAt = Date.now() - (QUIET_IDLE_PARK_CEILING_MS + MINUTE_MS);
    await setRunClock(RUN_STARTED_AGO_MS, QUIET_IDLE_PARK_CEILING_MS + MINUTE_MS, { subChatId });

    await tick();
    expect((await getTaskById(db, taskId))?.status).toBe('needs_attention');
    endSession(subChatId);
  });

  it('a late wake done-signal supersedes the park, re-opens the run, and the next tick advances', async () => {
    await setRunClock(RUN_STARTED_AGO_MS, QUIET_IDLE_PARK_CEILING_MS + MINUTE_MS);
    await tick(); // park: task needs_attention, node awaiting_input, run paused

    const superseded = await persistLinkedTaskSignal({
      taskIdForExecution: taskId,
      signal: {
        state: 'done',
        summary: 'Coverage passed; PR opened',
        at: new Date().toISOString(),
      },
    });
    expect(superseded).toBe(true);
    expect((await getTaskById(db, taskId))?.status).toBe('done');
    expect((await getFlowRun(db, flowRunId))?.status).toBe('running');

    await tick(); // the watcher advances the superseded terminal through the awaiting_input node
    expect((await getNodeRun(db, nodeRunId))?.status).toBe('completed');
    expect((await getFlowRun(db, flowRunId))?.status).toBe('completed');
  });

  it('parks a batch member the same as any other flow-linked task', async () => {
    await db.update(flowRuns).set({ batchId: 'batch-1' }).where(eq(flowRuns.id, flowRunId));
    await setRunClock(RUN_STARTED_AGO_MS, QUIET_IDLE_PARK_CEILING_MS + MINUTE_MS);

    await tick();

    const task = await getTaskById(db, taskId);
    expect(task?.status).toBe('needs_attention');
    const result = parseResultRecord(task?.result);
    expect(result.agentSignal).toMatchObject({ state: 'missing_completion_signal' });
    expect(vi.mocked(broadcastTaskSignalPersisted)).toHaveBeenCalledWith({
      taskId,
      status: 'needs_attention',
      isFlowLinked: true,
    });
  });

  describe('task-completion-watcher — a wake burst un-parks a quiet-idle park', () => {
    const quietPark = (at = '2026-09-04T00:00:00.000Z') => ({
      agentSignal: { state: 'missing_completion_signal', summary: 'went quiet', at },
    });

    async function parkViaSweep(): Promise<void> {
      await setRunClock(RUN_STARTED_AGO_MS, QUIET_IDLE_PARK_CEILING_MS + MINUTE_MS);
      await tick();
      vi.mocked(broadcastTaskSignalPersisted).mockClear();
    }

    async function readTask() {
      const row = await getTaskById(db, taskId);
      if (!row) throw new Error('task row missing');
      return row;
    }

    it('flips the task, node and run back to running, and the later done still advances', async () => {
      await parkViaSweep();

      await resumeQuietIdleParkOnBurst(taskId, 'sub-1');

      const task = await getTaskById(db, taskId);
      expect(task?.status).toBe('running');
      const result = parseResultRecord(task?.result);
      expect(result.resumedBy).toBe('wake_burst');
      expect(result.agentSignal).toBeUndefined();
      expect(result.quietEndedAt).toBeUndefined();
      expect((await getNodeRun(db, nodeRunId))?.status).toBe('running');
      expect((await getFlowRun(db, flowRunId))?.status).toBe('running');
      expect(vi.mocked(broadcastTaskSignalPersisted)).toHaveBeenLastCalledWith({
        taskId,
        status: 'running',
        isFlowLinked: true,
      });

      await persistLinkedTaskSignal({
        taskIdForExecution: taskId,
        signal: { state: 'done', summary: 'Suite green', at: new Date().toISOString() },
      });
      await tick();
      expect((await getNodeRun(db, nodeRunId))?.status).toBe('completed');
      expect((await getFlowRun(db, flowRunId))?.status).toBe('completed');
    });

    it('un-parks a batch-linked quiet park on a wake burst same as any other flow', async () => {
      await db.update(flowRuns).set({ batchId: 'batch-1' }).where(eq(flowRuns.id, flowRunId));
      await parkViaSweep();
      expect((await getFlowRun(db, flowRunId))?.status).toBe('paused');

      await resumeQuietIdleParkOnBurst(taskId, 'sub-1');

      expect((await getTaskById(db, taskId))?.status).toBe('running');
      expect((await getFlowRun(db, flowRunId))?.status).toBe('running');
    });

    it('stays advanceable when the burst lands before the park reaches the flow (advance in flight)', async () => {
      // The sweep recorded the task in its advanced-set and parked the node; rewinding node + run to
      // `running` reproduces the moment the burst opens while that node advance is still in flight.
      await parkViaSweep();
      const { setNodeRunStatus } = await import('../db/repos/node-runs');
      const { setFlowRunStatus } = await import('../db/repos/flow-runs');
      await setNodeRunStatus(db, nodeRunId, 'running', { completedAt: null, nodeOutput: null });
      await setFlowRunStatus(db, flowRunId, 'running');

      await resumeQuietIdleParkOnBurst(taskId, 'sub-1');
      expect((await getTaskById(db, taskId))?.status).toBe('running');

      await persistLinkedTaskSignal({
        taskIdForExecution: taskId,
        signal: { state: 'done', summary: 'Suite green', at: new Date().toISOString() },
      });
      await tick();
      expect((await getNodeRun(db, nodeRunId))?.status).toBe('completed');
    });

    it('re-parks after one more ceiling when the un-parked wait goes silent again', async () => {
      await parkViaSweep();
      await resumeQuietIdleParkOnBurst(taskId, 'sub-1');
      expect(await markLinkedTaskQuietEnd(taskId)).toBe(true); // the burst-end quiet mark lands

      const now = Date.now();
      await db
        .update(tasks)
        .set({
          startedAt: new Date(now - (QUIET_IDLE_PARK_CEILING_MS + 2 * MINUTE_MS)),
          result: {
            quietEndedAt: new Date(now - (QUIET_IDLE_PARK_CEILING_MS + MINUTE_MS)).toISOString(),
          },
        })
        .where(eq(tasks.id, taskId));
      await tick();
      expect((await getTaskById(db, taskId))?.status).toBe('needs_attention');
    });

    it('is also triggered at burst end when the quiet mark finds the row already parked', async () => {
      await parkViaSweep();

      await settleBurstSignal({
        subChatId: 'sub-1',
        signalTaskId: taskId,
        executionContextId: undefined,
        getLatestTaskSignal: () => null,
        pending: null,
        lastSeenSignalAt: null,
        throwOnError: true,
      });

      expect((await getTaskById(db, taskId))?.status).toBe('running');
      expect((await getFlowRun(db, flowRunId))?.status).toBe('running');
    });

    it('refuses a stale quiet-park snapshot once another actor re-parked the task on a question', async () => {
      await parkViaSweep();
      const stale = await readTask();
      const question = {
        agentSignal: { state: 'awaiting_input', summary: 'Which branch?', at: 'x' },
      };
      await updateTaskStatus(db, taskId, 'needs_attention', { result: question });

      expect(await resumeParkedTaskInPlace(stale, 'wake_burst', 'sub-1')).toBe(false);

      const task = await getTaskById(db, taskId);
      expect(task?.status).toBe('needs_attention');
      expect(parseResultRecord(task?.result).agentSignal).toEqual(question.agentSignal);
    });

    it("the watcher's park write is refused once the task has left the parked status", async () => {
      // The sweep parked the task; a burst resumes it before the watcher writes the node.
      await updateTaskStatus(db, taskId, 'needs_attention', { result: quietPark() });
      const parked = await readTask();
      await resumeQuietIdleParkOnBurst(taskId, 'sub-1');
      expect((await getTaskById(db, taskId))?.status).toBe('running');

      const advanced = await advanceFlowRun(flowRunId, nodeRunId, mapTaskToNodeOutput(parked), {
        id: taskId,
        status: parked.status,
        result: parked.result,
      });

      expect(advanced).toBe(false);
      expect((await getNodeRun(db, nodeRunId))?.status).toBe('running');
      expect((await getFlowRun(db, flowRunId))?.status).toBe('running');
    });

    it("the watcher's park write is refused after a resume-and-repark cycle (same status, new row)", async () => {
      await updateTaskStatus(db, taskId, 'needs_attention', { result: quietPark() });
      const parked = await readTask();
      // Resumed, then re-parked on a real question — same status, a different terminal row.
      await resumeQuietIdleParkOnBurst(taskId, 'sub-1');
      const question = {
        agentSignal: { state: 'awaiting_input', summary: 'Which branch?', at: 'x' },
      };
      await updateTaskStatus(db, taskId, 'needs_attention', { result: question });

      const advanced = await advanceFlowRun(flowRunId, nodeRunId, mapTaskToNodeOutput(parked), {
        id: taskId,
        status: parked.status,
        result: parked.result,
      });

      expect(advanced).toBe(false);
      expect((await getNodeRun(db, nodeRunId))?.status).toBe('running');
    });

    it('repairs a running task whose node and run were left parked behind it', async () => {
      await parkViaSweep();
      // The task half of a resume landed; the flow half did not (crash / thrown unpark).
      await updateTaskStatus(db, taskId, 'running', { result: { resumedBy: 'wake_burst' } });
      expect((await getFlowRun(db, flowRunId))?.status).toBe('paused');

      await resumeQuietIdleParkOnBurst(taskId, 'sub-1');

      expect((await getNodeRun(db, nodeRunId))?.status).toBe('running');
      expect((await getFlowRun(db, flowRunId))?.status).toBe('running');
      expect(vi.mocked(broadcastTaskSignalPersisted)).toHaveBeenLastCalledWith({
        taskId,
        status: 'running',
        isFlowLinked: true,
      });
    });

    it('reports success when the node was never parked (the sweep lost the node write)', async () => {
      await updateTaskStatus(db, taskId, 'needs_attention', { result: quietPark() });
      const parked = await readTask();

      expect(await resumeParkedTaskInPlace(parked, 'wake_burst', 'sub-1')).toBe(true);
      expect((await getTaskById(db, taskId))?.status).toBe('running');
      expect((await getNodeRun(db, nodeRunId))?.status).toBe('running');
    });

    it('reports false (and the burst does not broadcast) when the flow is already over', async () => {
      const { setNodeRunStatus } = await import('../db/repos/node-runs');
      const { setFlowRunStatus } = await import('../db/repos/flow-runs');
      await setNodeRunStatus(db, nodeRunId, 'cancelled', { completedAt: new Date() });
      await setFlowRunStatus(db, flowRunId, 'cancelled', { completedAt: new Date() });
      await updateTaskStatus(db, taskId, 'needs_attention', { result: quietPark() });
      vi.mocked(broadcastTaskSignalPersisted).mockClear();

      await resumeQuietIdleParkOnBurst(taskId, 'sub-1');

      expect((await getTaskById(db, taskId))?.status).toBe('needs_attention');
      expect(vi.mocked(broadcastTaskSignalPersisted)).not.toHaveBeenCalled();
    });

    it('does not reopen a flow whose task was user-paused after the repair read it as running', async () => {
      await parkViaSweep();
      await updateTaskStatus(db, taskId, 'running', { result: { resumedBy: 'wake_burst' } });
      const readAsRunning = await readTask();
      await updateTaskStatus(db, taskId, 'needs_attention', { result: { userPause: true } });

      const reopened = await resumeFlowNodeInPlace(flowRunId, nodeRunId, taskId, {
        id: taskId,
        status: readAsRunning.status,
        result: readAsRunning.result,
      });

      expect(reopened).toBe(false);
      expect((await getNodeRun(db, nodeRunId))?.status).toBe('awaiting_input');
      expect((await getFlowRun(db, flowRunId))?.status).toBe('paused');
    });

    it('never resumes a wake-parked task whose run is already over', async () => {
      const { setFlowRunStatus } = await import('../db/repos/flow-runs');
      await updateTaskStatus(db, taskId, 'needs_attention', { result: quietPark() });
      await setFlowRunStatus(db, flowRunId, 'completed', { completedAt: new Date() });

      await resumeQuietIdleParkOnBurst(taskId, 'sub-1');

      expect((await getTaskById(db, taskId))?.status).toBe('needs_attention');
    });

    it('rolls a wake resume back when the node finished under it and nothing can follow', async () => {
      const { setNodeRunStatus } = await import('../db/repos/node-runs');
      await updateTaskStatus(db, taskId, 'needs_attention', { result: quietPark() });
      await setNodeRunStatus(db, nodeRunId, 'completed', { completedAt: new Date() });
      const { setFlowRunStatus } = await import('../db/repos/flow-runs');
      await setFlowRunStatus(db, flowRunId, 'paused');
      vi.mocked(broadcastTaskSignalPersisted).mockClear();

      await resumeQuietIdleParkOnBurst(taskId, 'sub-1');

      const task = await getTaskById(db, taskId);
      expect(task?.status).toBe('needs_attention');
      expect(parseResultRecord(task?.result).agentSignal).toEqual(quietPark().agentSignal);
      expect(vi.mocked(broadcastTaskSignalPersisted)).not.toHaveBeenCalled();
    });

    it.each([
      ['a user pause', { userPause: true }],
      [
        'an awaiting_input question',
        { agentSignal: { state: 'awaiting_input', summary: 'Which branch?', at: 'x' } },
      ],
    ])('leaves %s park alone — those wait for the user', async (_label, result) => {
      await updateTaskStatus(db, taskId, 'needs_attention', { result });

      await resumeQuietIdleParkOnBurst(taskId, 'sub-1');

      expect((await getTaskById(db, taskId))?.status).toBe('needs_attention');
      expect(vi.mocked(broadcastTaskSignalPersisted)).not.toHaveBeenCalled();
    });

    it('leaves a failed row alone even when it carries the quiet-park signal', async () => {
      await updateTaskStatus(db, taskId, 'failed', { result: quietPark() });

      await resumeQuietIdleParkOnBurst(taskId, 'sub-1');

      expect((await getTaskById(db, taskId))?.status).toBe('failed');
      expect(vi.mocked(broadcastTaskSignalPersisted)).not.toHaveBeenCalled();
    });

    it('is a no-op on a task that is still running', async () => {
      await resumeQuietIdleParkOnBurst(taskId, 'sub-1');

      const task = await getTaskById(db, taskId);
      expect(task?.status).toBe('running');
      expect(parseResultRecord(task?.result).resumedBy).toBeUndefined();
      expect(vi.mocked(broadcastTaskSignalPersisted)).not.toHaveBeenCalled();
    });

    it('un-parks a plain (non-flow) task without touching flow state', async () => {
      const plain = await createTask(db, { description: 'plain task', source: 'chat' });
      await updateTaskStatus(db, plain.id, 'running');
      await updateTaskStatus(db, plain.id, 'needs_attention', { result: quietPark() });

      await resumeQuietIdleParkOnBurst(plain.id, 'sub-2');

      expect((await getTaskById(db, plain.id))?.status).toBe('running');
      expect(vi.mocked(broadcastTaskSignalPersisted)).toHaveBeenLastCalledWith({
        taskId: plain.id,
        status: 'running',
        isFlowLinked: false,
      });
    });
  });
});

describe('task-completion-watcher — dispatched-but-never-executed telemetry', () => {
  // A flow task the renderer was told to run (task:chat-ready) but never sent stays `running`
  // with no turn recorded anywhere. Main cannot repair renderer bookkeeping; it names the stall.
  let db: TestDb;
  let taskId: string;
  const subChatId = 'never-executed-sub';

  beforeEach(async () => {
    db = freshDb();
    holder.db = db;
    const { flowRunId } = await seedFlowRun(db, GRAPH);
    const node = await createNodeRun(db, {
      flowRunId,
      nodeId: 'agent1',
      blockType: 'agent',
      status: 'running',
    });
    const task = await createTask(db, {
      description: 'flow agent turn',
      source: 'flow',
      flowRunId,
      nodeRunId: node.id,
    });
    taskId = task.id;
    await updateTaskStatus(db, taskId, 'running');
    vi.spyOn(log, 'warn')
      .mockImplementation(() => {})
      .mockClear();
  });

  async function setStartedAgo(startedAgoMs: number): Promise<void> {
    await db
      .update(tasks)
      .set({ startedAt: new Date(Date.now() - startedAgoMs), result: { subChatId } })
      .where(eq(tasks.id, taskId));
  }

  const neverExecutedWarnings = () =>
    vi
      .mocked(log.warn)
      .mock.calls.filter((call) => String(call[0]).includes('dispatched but never executed'));

  it('warns once past the ceiling and leaves the task untouched', async () => {
    await setStartedAgo(RUN_STARTED_AGO_MS);

    await tick();
    await tick();

    expect(neverExecutedWarnings()).toHaveLength(1);
    expect(neverExecutedWarnings()[0]?.[1]).toMatchObject({ taskId, subChatId });
    expect((await getTaskById(db, taskId))?.status).toBe('running');
  });

  it("ignores a quiet-end marker older than startedAt (a retry's leftover) and still warns", async () => {
    const now = Date.now();
    await db
      .update(tasks)
      .set({
        startedAt: new Date(now - RUN_STARTED_AGO_MS),
        result: { subChatId, quietEndedAt: new Date(now - 2 * RUN_STARTED_AGO_MS).toISOString() },
      })
      .where(eq(tasks.id, taskId));

    await tick();

    expect(neverExecutedWarnings()).toHaveLength(1);
  });

  it('a quiet-end marker from this run means the turn happened — no warning', async () => {
    const now = Date.now();
    await db
      .update(tasks)
      .set({
        startedAt: new Date(now - RUN_STARTED_AGO_MS),
        result: { subChatId, quietEndedAt: new Date(now - MINUTE_MS).toISOString() },
      })
      .where(eq(tasks.id, taskId));

    await tick();

    expect(neverExecutedWarnings()).toHaveLength(0);
  });

  it('stays quiet before the ceiling', async () => {
    await setStartedAgo(10 * MINUTE_MS);

    await tick();

    expect(neverExecutedWarnings()).toHaveLength(0);
  });

  it('stays quiet while an execution is registered for the sub-chat (any provider)', async () => {
    // Codex and Cursor turns hold no Claude session; the execution registry is the shared signal.
    const { _registerExecutionForTests, _clearActiveExecutionsForTests } =
      await import('../socket/streaming/execution-registry');
    _registerExecutionForTests(subChatId, new AbortController());
    await setStartedAgo(RUN_STARTED_AGO_MS);

    await tick();

    expect(neverExecutedWarnings()).toHaveLength(0);
    _clearActiveExecutionsForTests();
  });

  it('stays quiet while a busy session owns the sub-chat — the turn is merely long', async () => {
    // SAFETY: the sweep reads only busy/lastActiveAt; the session's query is never driven.
    const session = createSession(subChatId, () => ({}) as never);
    session.busy = true;
    await setStartedAgo(RUN_STARTED_AGO_MS);

    await tick();

    expect(neverExecutedWarnings()).toHaveLength(0);
    session.busy = false;
    endSession(subChatId);
  });
});
