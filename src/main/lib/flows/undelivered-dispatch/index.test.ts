import { eq } from 'drizzle-orm';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { FlowGraph } from '../../../../shared/lib/validate-flow-graph';
import { getFlowRun } from '../../db/repos/flow-runs';
import { createNodeRun, getNodeRun } from '../../db/repos/node-runs';
import { createTask, getTaskById, parseResultRecord, updateTaskStatus } from '../../db/repos/tasks';
import { tasks } from '../../db/schema';
import { seedActiveAdmission, seedFlowRun } from '../../db/test-utils/flow-fixtures';
import { freshDb, type TestDb } from '../../db/test-utils/fresh-db';

const holder = vi.hoisted(() => ({ db: null as unknown }));
vi.mock('../../db', async (orig) => ({
  ...(await orig<typeof import('../../db')>()),
  getDatabase: () => holder.db,
}));
vi.mock('../dispatch', () => ({ dispatchNode: vi.fn() }));
vi.mock('../../socket/client', () => ({ broadcastTaskSignalPersisted: vi.fn() }));
const redeliverTaskDispatch = vi.hoisted(() => vi.fn());
const canRedeliver = vi.hoisted(() => vi.fn(() => true));
vi.mock('../../task-executor/dispatch-delivery', () => ({ canRedeliver, redeliverTaskDispatch }));
const forgetDispatch = vi.hoisted(() => vi.fn());
vi.mock('../../task-executor/dispatch-registry', () => ({ forgetDispatch }));

import { createSession, endSession } from '../../socket/claude-session-registry';
import { _setFlowAdmissionControllerForTests } from '../admission/runtime';
import { tick } from '../task-completion-watcher';
import { setDispatchStartedMarker } from '../../db/repos/task-parking/dispatch-marker';
import {
  DISPATCH_START_DEADLINE_MS,
  recoverUndeliveredDispatch,
  UNDELIVERED_DISPATCH_ERROR,
} from '.';

const GRAPH: FlowGraph = {
  nodes: [
    { id: 'ship', blockType: 'agent', config: { instructions: 'ship' }, position: { x: 0, y: 0 } },
  ],
  edges: [],
};

const MINUTE_MS = 60_000;
const SUB_CHAT_ID = 'ship-sub';

// sc-2775: Ship PR was dispatched into its chat, the prompt never became a turn, and the step sat
// `running` for 4 h until an unrelated operator turn completed it.
describe('task-completion-watcher — undelivered-dispatch watchdog', () => {
  let db: TestDb;
  let flowRunId: string;
  let nodeRunId: string;
  let taskId: string;

  beforeEach(async () => {
    db = freshDb();
    holder.db = db;
    redeliverTaskDispatch.mockReset().mockReturnValue(true);
    _setFlowAdmissionControllerForTests(null);
    ({ flowRunId } = await seedFlowRun(db, GRAPH));
    nodeRunId = (
      await createNodeRun(db, { flowRunId, nodeId: 'ship', blockType: 'agent', status: 'running' })
    ).id;
    taskId = (
      await createTask(db, { description: 'Ship PR', source: 'flow', flowRunId, nodeRunId })
    ).id;
    await updateTaskStatus(db, taskId, 'running');
  });

  async function setResult(result: Record<string, unknown>): Promise<void> {
    await db
      .update(tasks)
      .set({ result: { subChatId: SUB_CHAT_ID, ...result } })
      .where(eq(tasks.id, taskId));
  }

  const ago = (ms: number) => new Date(Date.now() - ms).toISOString();
  const readResult = async () => parseResultRecord((await getTaskById(db, taskId))?.result);

  it('does nothing before the deadline', async () => {
    await setResult({ dispatchedAt: ago(DISPATCH_START_DEADLINE_MS - MINUTE_MS) });

    await tick();

    expect(redeliverTaskDispatch).not.toHaveBeenCalled();
    expect((await getTaskById(db, taskId))?.status).toBe('running');
  });

  it('redelivers once past the deadline and stamps it', async () => {
    await setResult({ dispatchedAt: ago(DISPATCH_START_DEADLINE_MS + MINUTE_MS) });

    await tick();
    await tick();

    expect(redeliverTaskDispatch).toHaveBeenCalledTimes(1);
    expect(redeliverTaskDispatch).toHaveBeenCalledWith(taskId, expect.any(String));
    expect(typeof (await readResult()).dispatchRedeliveredAt).toBe('string');
    expect((await getTaskById(db, taskId))?.status).toBe('running');
  });

  it('fails the task, node and run when the redelivery also never starts a turn', async () => {
    seedActiveAdmission(db, flowRunId);
    await setResult({
      dispatchedAt: ago(3 * DISPATCH_START_DEADLINE_MS),
      dispatchRedeliveredAt: ago(DISPATCH_START_DEADLINE_MS + MINUTE_MS),
    });

    await tick(); // sweep fails the task
    await tick(); // watcher advances the failed task's node

    const task = await getTaskById(db, taskId);
    expect(task?.status).toBe('failed');
    expect(parseResultRecord(task?.result).error).toBe(UNDELIVERED_DISPATCH_ERROR);
    expect(redeliverTaskDispatch).not.toHaveBeenCalled();
    const node = await getNodeRun(db, nodeRunId);
    expect(node?.status).toBe('failed');
    expect(forgetDispatch).toHaveBeenCalledWith(SUB_CHAT_ID, taskId);
    expect(JSON.stringify(node?.nodeOutput)).toContain('no turn started');
    expect((await getFlowRun(db, flowRunId))?.status).toBe('failed');
  });

  it('waits, neither stamping nor failing, while no window exists to redeliver to', async () => {
    canRedeliver.mockReturnValueOnce(false);
    await setResult({ dispatchedAt: ago(DISPATCH_START_DEADLINE_MS + MINUTE_MS) });

    await tick();

    expect(redeliverTaskDispatch).not.toHaveBeenCalled();
    expect(await readResult()).not.toHaveProperty('dispatchRedeliveredAt');
    expect((await getTaskById(db, taskId))?.status).toBe('running');
  });

  it('waits rather than fails when the last window closes mid-redelivery, keeping its one retry', async () => {
    redeliverTaskDispatch.mockReturnValue(false);
    canRedeliver.mockReturnValueOnce(true).mockReturnValueOnce(false);
    await setResult({ dispatchedAt: ago(DISPATCH_START_DEADLINE_MS + MINUTE_MS) });

    await tick();

    expect((await getTaskById(db, taskId))?.status).toBe('running');
    expect(await readResult()).not.toHaveProperty('dispatchRedeliveredAt');
  });

  it('fails straight away when no dispatch is held to redeliver (after a restart)', async () => {
    redeliverTaskDispatch.mockReturnValue(false);
    await setResult({ dispatchedAt: ago(DISPATCH_START_DEADLINE_MS + MINUTE_MS) });

    await tick();

    expect((await getTaskById(db, taskId))?.status).toBe('failed');
  });

  it('leaves a delivered dispatch alone', async () => {
    await setResult({
      dispatchedAt: ago(3 * DISPATCH_START_DEADLINE_MS),
      dispatchStartedAt: ago(3 * DISPATCH_START_DEADLINE_MS - MINUTE_MS),
    });

    await tick();

    expect(redeliverTaskDispatch).not.toHaveBeenCalled();
    expect((await getTaskById(db, taskId))?.status).toBe('running');
  });

  it('leaves a row with no dispatch stamp alone (written before sc-2775)', async () => {
    await setResult({});

    await tick();

    expect(redeliverTaskDispatch).not.toHaveBeenCalled();
    expect((await getTaskById(db, taskId))?.status).toBe('running');
  });

  it('waits while the sub-chat is busy — a previous step may still hold the queue', async () => {
    // SAFETY: the watchdog reads only `busy`; the session's query is never driven.
    const session = createSession(SUB_CHAT_ID, () => ({}) as never);
    session.busy = true;
    await setResult({ dispatchedAt: ago(DISPATCH_START_DEADLINE_MS + MINUTE_MS) });

    await tick();

    expect(redeliverTaskDispatch).not.toHaveBeenCalled();
    session.busy = false;
    endSession(SUB_CHAT_ID);
  });

  it('treats a recorded signal as evidence a turn ran', async () => {
    await setResult({
      dispatchedAt: ago(3 * DISPATCH_START_DEADLINE_MS),
      dispatchRedeliveredAt: ago(DISPATCH_START_DEADLINE_MS + MINUTE_MS),
      agentSignal: { state: 'question', summary: 'which repo?', at: ago(MINUTE_MS) },
    });

    await tick();

    expect((await getTaskById(db, taskId))?.status).toBe('running');
  });

  // The sweep acts on a snapshot read at the start of the tick; the step's turn can be admitted, or
  // the task re-claimed, between that read and the watchdog's write.
  describe('races against the sweep snapshot', () => {
    const snapshot = async () => {
      const task = await getTaskById(db, taskId);
      if (!task) throw new Error('task missing');
      return task;
    };

    it('does not fail a step whose turn started after the snapshot', async () => {
      await setResult({
        dispatchedAt: ago(3 * DISPATCH_START_DEADLINE_MS),
        dispatchRedeliveredAt: ago(DISPATCH_START_DEADLINE_MS + MINUTE_MS),
      });
      const stale = await snapshot();
      await setDispatchStartedMarker(
        db,
        taskId,
        String(stale.result && (stale.result as Record<string, unknown>).dispatchedAt),
      );

      await recoverUndeliveredDispatch(db, stale, Date.now());

      expect((await getTaskById(db, taskId))?.status).toBe('running');
    });

    it('does not redeliver, or lend its clock to, a dispatch re-claimed after the snapshot', async () => {
      await setResult({ dispatchedAt: ago(DISPATCH_START_DEADLINE_MS + MINUTE_MS) });
      const stale = await snapshot();
      const reclaimedAt = new Date().toISOString();
      await setResult({ dispatchedAt: reclaimedAt });

      await recoverUndeliveredDispatch(db, stale, Date.now());

      expect(redeliverTaskDispatch).not.toHaveBeenCalled();
      expect(await readResult()).toEqual({ subChatId: SUB_CHAT_ID, dispatchedAt: reclaimedAt });
    });

    it('does not fail a re-claimed dispatch on the old dispatch’s expired clock', async () => {
      await setResult({
        dispatchedAt: ago(3 * DISPATCH_START_DEADLINE_MS),
        dispatchRedeliveredAt: ago(DISPATCH_START_DEADLINE_MS + MINUTE_MS),
      });
      const stale = await snapshot();
      await setResult({ dispatchedAt: new Date().toISOString() });

      await recoverUndeliveredDispatch(db, stale, Date.now());

      expect((await getTaskById(db, taskId))?.status).toBe('running');
    });
    // The watcher's setInterval does not wait for a slow tick, so two sweeps can act on the same
    // snapshot: exactly one may redeliver.
    it('redelivers once when two sweeps race on the same snapshot', async () => {
      await setResult({ dispatchedAt: ago(DISPATCH_START_DEADLINE_MS + MINUTE_MS) });
      const stale = await snapshot();

      await Promise.all([
        recoverUndeliveredDispatch(db, stale, Date.now()),
        recoverUndeliveredDispatch(db, stale, Date.now()),
      ]);

      expect(redeliverTaskDispatch).toHaveBeenCalledTimes(1);
      expect((await getTaskById(db, taskId))?.status).toBe('running');
    });

    it('a turn that ran but failed to stamp its start (quiet end since dispatch) is left alone', async () => {
      await setResult({
        dispatchedAt: ago(3 * DISPATCH_START_DEADLINE_MS),
        dispatchRedeliveredAt: ago(DISPATCH_START_DEADLINE_MS + MINUTE_MS),
        quietEndedAt: ago(2 * DISPATCH_START_DEADLINE_MS),
      });

      await tick();

      expect((await getTaskById(db, taskId))?.status).toBe('running');
    });
    it('never fails a turn admitted but not yet stamped as started', async () => {
      const { _registerExecutionForTests, _clearActiveExecutionsForTests } =
        await import('../../socket/streaming/execution-registry');
      await setResult({
        dispatchedAt: ago(3 * DISPATCH_START_DEADLINE_MS),
        dispatchRedeliveredAt: ago(DISPATCH_START_DEADLINE_MS + MINUTE_MS),
      });
      _registerExecutionForTests(SUB_CHAT_ID, new AbortController());

      await tick();

      expect((await getTaskById(db, taskId))?.status).toBe('running');
      _clearActiveExecutionsForTests();
    });
  });
});
