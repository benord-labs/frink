import { eq } from 'drizzle-orm';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { RESTART_INTERRUPTION_REASON } from '../../../../shared/types/flow';
import { setFlowRunStatus } from '../../db/repos/flow-runs';
import {
  chats,
  flowRuns,
  nodeRuns,
  subChatMessages,
  subChats,
  type Task,
  tasks,
} from '../../db/schema';
import { seedFlowRun } from '../../db/test-utils/flow-fixtures';
import { freshDb, type TestDb } from '../../db/test-utils/fresh-db';
import {
  assertRecoveryStep,
  getTaskWithRunOutcome,
  stoppedTaskRecoveries,
  withStoppedTaskRecoveries,
} from './tasks-subchat';

let db: TestDb;
let flowRunId: string;
let versionId: string;

const MARKED = {
  status: 'cancelled',
  outputs: {},
  artifacts: [],
  durationMs: 0,
  error: { message: RESTART_INTERRUPTION_REASON, retryable: true },
} as const;

beforeEach(async () => {
  db = freshDb();
  ({ flowRunId, versionId } = await seedFlowRun(db, { nodes: [], edges: [] }));
  await setFlowRunStatus(db, flowRunId, 'cancelled');
  await db.insert(chats).values({ id: 'chat-1', name: 'chat' });
  await db.insert(subChats).values({ id: 'sub-1', chatId: 'chat-1', sessionId: 'sess-1' });
});

/** A step of the run and the task that drove it; `answered` persists its prompt and the reply. */
async function seedStep(
  id: string,
  status: Task['status'],
  step: Partial<typeof nodeRuns.$inferInsert>,
  answered = false,
): Promise<Task> {
  await db
    .insert(nodeRuns)
    .values({ id, flowRunId, nodeId: id, blockType: 'agent', status: 'completed', ...step });
  const [task] = await db
    .insert(tasks)
    .values({
      id: `task-${id}`,
      description: id,
      source: 'flow',
      status,
      result: { chatId: 'chat-1', subChatId: 'sub-1' },
      flowRunId,
      sourceId: id,
      nodeRunId: id,
    })
    .returning();
  if (answered) {
    const prompt = {
      id: `u-${id}`,
      role: 'user',
      parts: [],
      metadata: { dispatchTaskId: task.id },
    };
    const reply = { id: `a-${id}`, role: 'assistant', parts: [] };
    await db.insert(subChatMessages).values([
      { subChatId: 'sub-1', seq: 0, message: JSON.stringify(prompt) },
      { subChatId: 'sub-1', seq: 1, message: JSON.stringify(reply) },
    ]);
  }
  return task;
}

const row = (task: Task, effectiveStatus: string) => ({
  ...task,
  flowRunStatus: 'cancelled',
  effectiveStatus,
});

describe('stoppedTaskRecoveries for restart-interrupted rows', () => {
  // The queue's row for a run is its highest-ranked task, often an earlier finished step.
  it("gives the row its run's marked step recovery, even when the row is an earlier step", async () => {
    const earlier = await seedStep('a', 'done', {});
    await seedStep('b', 'cancelled', { status: 'cancelled', nodeOutput: MARKED }, true);

    const { kinds } = await stoppedTaskRecoveries(db, [row(earlier, 'interrupted')]);
    expect(kinds.get(earlier.id)).toBe('continue');
  });

  it('retries a marked step its session never answered', async () => {
    const marked = await seedStep('b', 'cancelled', { status: 'cancelled', nodeOutput: MARKED });

    const { kinds } = await stoppedTaskRecoveries(db, [row(marked, 'interrupted')]);
    expect(kinds.get(marked.id)).toBe('retry');
  });

  it('offers a confirmed Retry for a started non-agent step, which may repeat side effects', async () => {
    const earlier = await seedStep('a', 'failed', {}, true);
    await db.insert(nodeRuns).values({
      id: 'cmd',
      flowRunId,
      nodeId: 'cmd',
      blockType: 'run_command',
      status: 'cancelled',
      startedAt: new Date(),
      nodeOutput: MARKED,
    });

    const [stamped] = await withStoppedTaskRecoveries(db, [row(earlier, 'interrupted')]);
    expect(stamped).toMatchObject({ recoveryKind: 'retry', confirmSideEffects: true });
    // The chat's own recovery row reads the same rule for the same task.
    expect(await getTaskWithRunOutcome(db, earlier.id)).toMatchObject({
      recoveryKind: 'retry',
      confirmSideEffects: true,
    });
  });

  it('offers nothing for a run the user cancelled', async () => {
    const stopped = await seedStep('a', 'cancelled', { status: 'cancelled' }, true);

    const { kinds } = await stoppedTaskRecoveries(db, [
      row(stopped, 'cancelled'),
      row(stopped, 'interrupted'),
    ]);
    expect(kinds.size).toBe(0);
  });

  it('resolves a page of stopped runs in as many queries as one run', async () => {
    const rows = [];
    // Answered, unanswered, and cancelled by the user (no restart marker).
    for (const id of ['a', 'b', 'c']) {
      flowRunId = `run-${id}`;
      await db
        .insert(flowRuns)
        .values({ id: flowRunId, flowVersionId: versionId, status: 'cancelled' });
      const step = { status: 'cancelled', nodeOutput: id === 'c' ? null : MARKED };
      rows.push(row(await seedStep(id, 'cancelled', step, id === 'a'), 'interrupted'));
    }
    flowRunId = 'run-d';
    await db.insert(flowRuns).values({ id: flowRunId, flowVersionId: versionId, status: 'failed' });
    rows.push(failedRow(await seedStep('d', 'done', {})));
    await seedStep('e', 'cancelled', { status: 'failed' });
    const queries = vi.spyOn(db.$client, 'prepare');
    await stoppedTaskRecoveries(db, rows.slice(0, 1));
    const forOneRun = queries.mock.calls.length;

    const { kinds } = await stoppedTaskRecoveries(db, rows);
    expect(queries.mock.calls.length - forOneRun).toBe(forOneRun);
    expect([...kinds]).toEqual([
      ['task-a', 'continue'],
      ['task-b', 'retry'],
      ['task-d', 'retry'],
    ]);
  });
});

const failedRow = (task: Task) => ({ ...task, flowRunStatus: 'failed', effectiveStatus: 'failed' });

// The row is the run's highest-ranked task, an earlier `done` step: the stopped step outranks it
// only when it has a failed task of its own.
describe('stoppedTaskRecoveries for a run that failed on a later step', () => {
  beforeEach(() => setFlowRunStatus(db, flowRunId, 'failed'));

  it('offers a confirmed Retry when the run failed on a started non-agent step', async () => {
    const earlier = await seedStep('a', 'done', {}, true);
    await db.insert(nodeRuns).values({
      id: 'cmd',
      flowRunId,
      nodeId: 'cmd',
      blockType: 'run_command',
      status: 'failed',
      startedAt: new Date(),
    });

    const [stamped] = await withStoppedTaskRecoveries(db, [failedRow(earlier)]);
    expect(stamped).toMatchObject({
      recoveryKind: 'retry',
      confirmSideEffects: true,
      recoveryNodeRunId: 'cmd',
    });
  });

  // A confirmation names the attempt it was asked about, so it never retries a newer one.
  it('refuses a recovery pinned to an attempt the run has since moved past', async () => {
    const earlier = await seedStep('a', 'done', {}, true);
    const cmd = {
      flowRunId,
      nodeId: 'cmd',
      blockType: 'run_command',
      status: 'failed',
    } satisfies typeof nodeRuns.$inferInsert;
    await db.insert(nodeRuns).values({ ...cmd, id: 'cmd-1', startedAt: new Date() });
    await db.insert(nodeRuns).values({ ...cmd, id: 'cmd-2', startedAt: new Date() });

    await expect(assertRecoveryStep(db, earlier.id, 'cmd-1')).rejects.toMatchObject({
      code: 'PRECONDITION_FAILED',
    });
    await expect(assertRecoveryStep(db, earlier.id, 'cmd-2')).resolves.toBeUndefined();
    await expect(assertRecoveryStep(db, earlier.id, undefined)).resolves.toBeUndefined();
  });

  it("gives the row its stopped agent step's recovery", async () => {
    const earlier = await seedStep('a', 'done', {});
    await seedStep('b', 'cancelled', { status: 'failed' }, true);

    const [stamped] = await withStoppedTaskRecoveries(db, [failedRow(earlier)]);
    expect(stamped).toMatchObject({ recoveryKind: 'continue', confirmSideEffects: false });
  });

  // The chat acts on the newest agent task, here the cancelled one of the step the run stopped on.
  it("gives the chat's newest task, cancelled by the failure, its run's recovery", async () => {
    await seedStep('a', 'done', {});
    const newest = await seedStep('b', 'cancelled', { status: 'failed' }, true);

    expect(await getTaskWithRunOutcome(db, newest.id)).toMatchObject({
      flowRunStatus: 'failed',
      recoveryKind: 'continue',
      recoveryNodeRunId: 'b',
    });
  });

  // Fan-out lanes run in chats of their own; a finished lane's chat cannot continue another lane.
  it("offers no recovery in a chat whose step finished when another chat's step failed", async () => {
    const otherLane = await seedStep('a', 'done', {});
    const lane = { chatId: 'chat-1', subChatId: 'sub-2' };
    await db.update(tasks).set({ result: lane }).where(eq(tasks.id, otherLane.id));
    const failed = await seedStep('b', 'cancelled', { status: 'failed' }, true);

    const outcome = await getTaskWithRunOutcome(db, otherLane.id);
    expect(outcome).toMatchObject({ flowRunStatus: 'failed' });
    expect(outcome?.recoveryKind).toBeUndefined();
    expect(outcome?.recoveryNodeRunId).toBeUndefined();
    expect(await getTaskWithRunOutcome(db, failed.id)).toMatchObject({ recoveryKind: 'continue' });
  });

  it('leaves a completed run with nothing to recover', async () => {
    const done = await seedStep('a', 'done', {});
    await setFlowRunStatus(db, flowRunId, 'completed');

    const { kinds } = await stoppedTaskRecoveries(db, [row(done, 'done')]);
    expect(kinds.size).toBe(0);
  });
});
