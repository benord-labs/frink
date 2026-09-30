import { eq } from 'drizzle-orm';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { FlowGraph } from '../../../../../shared/lib/validate-flow-graph';
import type { FlowExecutionEvent } from '../../../../../shared/types/flow';
import { getFlowRun, setFlowRunStatus } from '../../../db/repos/flow-runs';
import { createTask, getTaskById, updateTaskStatus } from '../../../db/repos/tasks';
import { flowRunAdmissions, flowRuns } from '../../../db/schema';
import { seedFlowRun } from '../../../db/test-utils/flow-fixtures';
import { freshDb, type TestDb } from '../../../db/test-utils/fresh-db';

const holder = vi.hoisted(() => ({
  db: null as unknown,
  cancelUndispatched: vi.fn(),
  hasLive: vi.fn(async () => false),
}));

vi.mock('../../../db', async (original) => ({
  ...(await original<typeof import('../../../db')>()),
  getDatabase: () => holder.db,
}));
vi.mock('../runtime', async (original) => ({
  ...(await original<typeof import('../runtime')>()),
  cancelUndispatchedFlowAdmission: holder.cancelUndispatched,
  hasLiveFlowAdmission: holder.hasLive,
}));

import { cancelFlowRun } from '../../engine';
import { subscribeFlowEvents } from '../../events';
import { _setFlowAdmissionControllerForTests } from '../runtime';

const GRAPH: FlowGraph = {
  nodes: [
    {
      id: 'agent',
      blockType: 'agent',
      config: { instructions: 'work' },
      position: { x: 0, y: 0 },
    },
  ],
  edges: [],
};

afterEach(() => {
  holder.cancelUndispatched.mockReset();
  holder.hasLive.mockReset();
  holder.hasLive.mockResolvedValue(false);
  _setFlowAdmissionControllerForTests(null);
});

function seedResumeAdmission(db: TestDb, flowRunId: string, state: 'queued' | 'active'): number {
  return db
    .insert(flowRunAdmissions)
    .values({
      flowRunId,
      state,
      priorityClass: 'resume',
      intentVersion: 1,
      intentJson: { version: 1, action: 'resume', flow_run_id: flowRunId },
    })
    .returning({ ticket: flowRunAdmissions.ticket })
    .get().ticket;
}

const admissionState = (db: TestDb, ticket: number) =>
  db.select().from(flowRunAdmissions).where(eq(flowRunAdmissions.ticket, ticket)).get()?.state;

describe('terminal Flow retry cancellation', () => {
  it('cancels a queued resume admission without sweeping the terminal run', async () => {
    const db = freshDb();
    holder.db = db;
    const { flowRunId } = await seedFlowRun(db, GRAPH);
    const task = await createTask(db, {
      description: 'existing terminal task',
      source: 'flow',
      flowRunId,
    });
    await updateTaskStatus(db, task.id, 'running');
    await setFlowRunStatus(db, flowRunId, 'failed');
    const ticket = seedResumeAdmission(db, flowRunId, 'queued');

    const result = await cancelFlowRun(flowRunId);

    expect(admissionState(db, ticket)).toBe('cancelled');
    expect(result?.status).toBe('failed');
    expect((await getFlowRun(db, flowRunId))?.status).toBe('failed');
    expect((await getTaskById(db, task.id))?.status).toBe('running');
  });

  it('cancels a retry that was promoted before the Cancel', async () => {
    const db = freshDb();
    holder.db = db;
    const { flowRunId } = await seedFlowRun(db, GRAPH);
    const task = await createTask(db, {
      description: 'promoted retry task',
      source: 'flow',
      flowRunId,
    });
    await updateTaskStatus(db, task.id, 'running');
    await setFlowRunStatus(db, flowRunId, 'running');
    const ticket = seedResumeAdmission(db, flowRunId, 'active');

    const result = await cancelFlowRun(flowRunId);

    expect(result?.status).toBe('cancelled');
    expect((await getTaskById(db, task.id))?.status).toBe('cancelled');
    // The Cancel releases the promoted slot; nothing else holds it.
    expect(admissionState(db, ticket)).toBe('cancelled');
  });
});

describe('Work Queue dequeue', () => {
  const QUEUED_ONLY = { ticket: 7 };

  it('stays silent for a resume whose run was already terminal', async () => {
    const db = freshDb();
    holder.db = db;
    const { flowRunId } = await seedFlowRun(db, GRAPH);
    await setFlowRunStatus(db, flowRunId, 'cancelled');
    // Dequeuing a resume cancels the admission and leaves the finished run alone.
    holder.cancelUndispatched.mockResolvedValueOnce(true);
    const seen: FlowExecutionEvent[] = [];
    const unsubscribe = subscribeFlowEvents((event) => seen.push(event));

    const result = await cancelFlowRun(flowRunId, { queuedOnly: QUEUED_ONLY });
    unsubscribe();

    // Replaying the run's terminal event would settle its batch stage a second time.
    expect(seen).toEqual([]);
    expect(result?.status).toBe('cancelled');
  });

  it('withholds the terminal event when a retry has already re-admitted the run', async () => {
    const db = freshDb();
    holder.db = db;
    const { flowRunId } = await seedFlowRun(db, GRAPH);
    await db.update(flowRuns).set({ batchId: 'batch-1' }).where(eq(flowRuns.id, flowRunId));
    holder.cancelUndispatched.mockImplementationOnce(async () => {
      await setFlowRunStatus(db, flowRunId, 'cancelled');
      return true;
    });
    // A replacement admission won the run between the cancellation and this emit.
    holder.hasLive.mockResolvedValueOnce(true);
    const seen: FlowExecutionEvent[] = [];
    const unsubscribe = subscribeFlowEvents((event) => seen.push(event));

    await cancelFlowRun(flowRunId, { queuedOnly: QUEUED_ONLY });
    unsubscribe();

    // Emitting would settle the batch stage while the replacement is still waiting to run.
    expect(seen).toEqual([]);
  });

  it('emits the terminal event a removed batch member needs to settle its stage', async () => {
    const db = freshDb();
    holder.db = db;
    const { flowRunId } = await seedFlowRun(db, GRAPH);
    await db.update(flowRuns).set({ batchId: 'batch-1' }).where(eq(flowRuns.id, flowRunId));
    holder.cancelUndispatched.mockImplementationOnce(async () => {
      await setFlowRunStatus(db, flowRunId, 'cancelled');
      return true;
    });
    const seen: FlowExecutionEvent[] = [];
    const unsubscribe = subscribeFlowEvents((event) => seen.push(event));

    const result = await cancelFlowRun(flowRunId, { queuedOnly: QUEUED_ONLY });
    unsubscribe();

    // The ticket travels into the transaction: cancelling by run alone could hit a replacement.
    expect(holder.cancelUndispatched).toHaveBeenCalledWith(flowRunId, {
      states: ['queued'],
      ...QUEUED_ONLY,
    });
    expect(result?.status).toBe('cancelled');
    expect((await getFlowRun(db, flowRunId))?.status).toBe('cancelled');
    // batchId on the event is what reaches onBatchRunTerminal; without it the owning stage would
    // stay `running` with no active members until the next app restart.
    expect(seen).toContainEqual(
      expect.objectContaining({ eventType: 'run_cancelled', flowRunId, batchId: 'batch-1' }),
    );
  });
});
