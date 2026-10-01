import { eq } from 'drizzle-orm';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  type FlowExecutionEvent,
  type NodeOutput,
  RESTART_INTERRUPTION_REASON,
} from '../../../shared/types/flow';
import { getFlowRun, setFlowRunStatus } from '../db/repos/flow-runs';
import { createNodeRun, getNodeRun, setNodeRunStatus } from '../db/repos/node-runs';
import { createTask, getTaskById, parseResultRecord, updateTaskStatus } from '../db/repos/tasks';
import { flowRunAdmissions, tasks } from '../db/schema';
import { seedActiveAdmission, seedFlowRun } from '../db/test-utils/flow-fixtures';
import { freshDb, type TestDb } from '../db/test-utils/fresh-db';

const holder = vi.hoisted(() => ({ db: null as unknown, capture: vi.fn() }));
vi.mock('../db', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../db')>()),
  getDatabase: () => holder.db,
}));
vi.mock('../sentry/init', () => ({
  captureMainException: holder.capture,
  captureMainMessage: holder.capture,
}));
vi.mock('../flows/task-completion-watcher', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../flows/task-completion-watcher')>();
  return { ...actual, forgetAdvancedTask: vi.fn(actual.forgetAdvancedTask) };
});

import { FlowAdmissionController } from '../flows/admission/controller';
import { _setFlowAdmissionControllerForTests } from '../flows/admission/runtime';
import { cancelFlowRun } from '../flows/engine';
import { subscribeFlowEvents } from '../flows/events';
import { forgetAdvancedTask } from '../flows/task-completion-watcher';
import { reviveRestartInterruptedFlow } from './revive-interrupted-flow';

const GRAPH = {
  nodes: [{ id: 'a', blockType: 'agent', config: { instructions: 'x' }, position: { x: 0, y: 0 } }],
  edges: [],
};
const MARKED_OUTPUT: NodeOutput = {
  status: 'cancelled',
  outputs: {},
  artifacts: [],
  durationMs: 0,
  error: { message: RESTART_INTERRUPTION_REASON, retryable: true },
};
/** The result a restart cancel merges onto the task, stale markers of the ended attempt and all. */
const CANCELLED_RESULT = {
  cancelled: true,
  error: RESTART_INTERRUPTION_REASON,
  subChatId: 'sub-1',
  userPause: { at: '2026-07-14T00:00:00Z' },
  agentSignal: { state: 'awaiting_input', summary: 'stale ask' },
};

let db: TestDb;
let flowRunId: string;
let nodeRunId: string;
let taskId: string;
let ticket: number;

/** The shape a restart leaves: run, node and task cancelled, the marker on the node, slot active. */
async function seedInterruptedRun(nodeOutput: NodeOutput = MARKED_OUTPUT): Promise<void> {
  ({ flowRunId } = await seedFlowRun(db, GRAPH));
  ticket = seedActiveAdmission(db, flowRunId);
  nodeRunId = (await createNodeRun(db, { flowRunId, nodeId: 'a', blockType: 'agent' })).id;
  await setNodeRunStatus(db, nodeRunId, 'cancelled', { nodeOutput, completedAt: new Date() });
  await setFlowRunStatus(db, flowRunId, 'cancelled', { completedAt: new Date() });
  const task = await createTask(db, { description: 'agent', source: 'flow', flowRunId, nodeRunId });
  taskId = task.id;
  await updateTaskStatus(db, taskId, 'cancelled', { result: CANCELLED_RESULT });
}

const statuses = async () => ({
  run: (await getFlowRun(db, flowRunId))?.status,
  node: (await getNodeRun(db, nodeRunId))?.status,
  task: (await getTaskById(db, taskId))?.status,
});

beforeEach(() => {
  db = freshDb();
  holder.db = db;
  holder.capture.mockReset();
  vi.mocked(forgetAdvancedTask).mockClear();
  _setFlowAdmissionControllerForTests(
    new FlowAdmissionController(db, async () => ({
      version: 1,
      queuePaused: false,
      concurrencyLimitEnabled: false,
      maxConcurrentRuns: 4,
    })),
  );
});

afterEach(() => _setFlowAdmissionControllerForTests(null));

describe('reviveRestartInterruptedFlow', () => {
  it('revives task, marked node and run together, scrubbing the ended attempt’s markers', async () => {
    await seedInterruptedRun();

    await reviveRestartInterruptedFlow(taskId, flowRunId, 'sub-1');

    expect(await statuses()).toEqual({ run: 'running', node: 'running', task: 'running' });
    expect(forgetAdvancedTask).toHaveBeenCalledWith(taskId);
    expect((await getNodeRun(db, nodeRunId))?.nodeOutput).toBeNull();
    const result = parseResultRecord((await getTaskById(db, taskId))?.result ?? null);
    expect(result).toMatchObject({
      subChatId: 'sub-1',
      resumedBy: 'follow_up_message',
      previousStatus: 'cancelled',
    });
    for (const marker of ['cancelled', 'error', 'userPause', 'agentSignal']) {
      expect(result).not.toHaveProperty(marker);
    }
  });

  // Continuing in place skips re-admission, so a slot that already began releasing (a settle, or a
  // teardown cleanup error) must decline and leave the run on the Re-run path.
  it('writes nothing once the slot is no longer active', async () => {
    await seedInterruptedRun();
    db.update(flowRunAdmissions)
      .set({ state: 'releasing', error: 'cleanup failed' })
      .where(eq(flowRunAdmissions.ticket, ticket))
      .run();

    await reviveRestartInterruptedFlow(taskId, flowRunId, 'sub-1');

    expect(await statuses()).toEqual({ run: 'cancelled', node: 'cancelled', task: 'cancelled' });
    expect((await getNodeRun(db, nodeRunId))?.nodeOutput).toEqual(MARKED_OUTPUT);
    expect(parseResultRecord((await getTaskById(db, taskId))?.result ?? null)).toEqual(
      CANCELLED_RESULT,
    );
  });

  it('never revives a run the user cancelled (no restart marker)', async () => {
    await seedInterruptedRun({ ...MARKED_OUTPUT, error: undefined });

    await reviveRestartInterruptedFlow(taskId, flowRunId, 'sub-1');

    expect(await statuses()).toEqual({ run: 'cancelled', node: 'cancelled', task: 'cancelled' });
    expect(forgetAdvancedTask).not.toHaveBeenCalled();
  });

  it('writes nothing once the driving task left cancelled', async () => {
    await seedInterruptedRun();
    db.update(tasks).set({ status: 'done' }).where(eq(tasks.id, taskId)).run();

    await reviveRestartInterruptedFlow(taskId, flowRunId, 'sub-1');

    expect(await statuses()).toEqual({ run: 'cancelled', node: 'cancelled', task: 'done' });
  });

  it('never revives a marked node on a run that is not cancelled', async () => {
    await seedInterruptedRun();
    await setFlowRunStatus(db, flowRunId, 'failed');

    await reviveRestartInterruptedFlow(taskId, flowRunId, 'sub-1');

    expect(await statuses()).toEqual({ run: 'failed', node: 'cancelled', task: 'cancelled' });
  });

  it('a second revive (double message) writes nothing over the first', async () => {
    await seedInterruptedRun();
    await reviveRestartInterruptedFlow(taskId, flowRunId, 'sub-1');
    const first = await getTaskById(db, taskId);

    await reviveRestartInterruptedFlow(taskId, flowRunId, 'sub-1');

    expect(await getTaskById(db, taskId)).toEqual(first);
    expect(await statuses()).toEqual({ run: 'running', node: 'running', task: 'running' });
  });

  describe('against Cancel', () => {
    let cancelled: FlowExecutionEvent[];
    let unsubscribe: () => void;
    beforeEach(() => {
      cancelled = [];
      unsubscribe = subscribeFlowEvents((event) => {
        if (event.eventType === 'run_cancelled') cancelled.push(event);
      });
    });
    afterEach(() => unsubscribe());

    it('a Stop after the revive commits cancels the revived run once and releases its slot', async () => {
      await seedInterruptedRun();
      await reviveRestartInterruptedFlow(taskId, flowRunId, 'sub-1');

      await cancelFlowRun(flowRunId);

      expect(await statuses()).toEqual({ run: 'cancelled', node: 'cancelled', task: 'cancelled' });
      expect(cancelled).toHaveLength(1);
      const slot = db
        .select()
        .from(flowRunAdmissions)
        .where(eq(flowRunAdmissions.ticket, ticket))
        .get();
      expect(slot?.state).not.toBe('active');
      expect(holder.capture).not.toHaveBeenCalled();
    });

    it('a revive after the Stop released the slot writes nothing', async () => {
      await seedInterruptedRun();
      const { requestFlowAdmissionRelease } = await import('../flows/admission/runtime');
      await cancelFlowRun(flowRunId);
      await requestFlowAdmissionRelease(flowRunId);

      await reviveRestartInterruptedFlow(taskId, flowRunId, 'sub-1');

      expect(await statuses()).toEqual({ run: 'cancelled', node: 'cancelled', task: 'cancelled' });
      expect(cancelled).toHaveLength(0);
    });
  });
});
