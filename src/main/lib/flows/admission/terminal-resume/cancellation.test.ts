import { eq } from 'drizzle-orm';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { FlowGraph } from '../../../../../shared/lib/validate-flow-graph';
import type { FlowExecutionEvent } from '../../../../../shared/types/flow';
import { createBatchStageRun } from '../../../db/repos/batch-stage-runs';
import { createBatchStage, getBatchStage } from '../../../db/repos/batch-stages';
import { getFlowRun, setFlowRunStatus } from '../../../db/repos/flow-runs';
import { createTask, getTaskById, updateTaskStatus } from '../../../db/repos/tasks';
import { batchStageRuns, flowRunAdmissions, flowRuns } from '../../../db/schema';
import { seedFlowRun } from '../../../db/test-utils/flow-fixtures';
import { freshDb, type TestDb } from '../../../db/test-utils/fresh-db';

const holder = vi.hoisted(() => ({
  db: null as unknown,
  cancelUndispatched: vi.fn(),
}));

vi.mock('../../../db', async (original) => ({
  ...(await original<typeof import('../../../db')>()),
  getDatabase: () => holder.db,
}));
vi.mock('../runtime', async (original) => ({
  ...(await original<typeof import('../runtime')>()),
  cancelUndispatchedFlowAdmission: holder.cancelUndispatched,
}));

import { onBatchRunTerminal } from '../../batch-dispatch';
import { cancelFlowRun, cancelFlowRunForChatDeletion } from '../../engine';
import { subscribeFlowEvents } from '../../events';
import { registerBatchStageSettler } from '../activity';
import { _setFlowAdmissionControllerForTests } from '../runtime';
import { recoverFlowAdmissionsAtStartup } from '../startup';

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
  _setFlowAdmissionControllerForTests(null);
});

function seedAdmission(
  db: TestDb,
  flowRunId: string,
  state: 'queued' | 'claimed' | 'active',
  action: 'start' | 'resume',
): number {
  return db
    .insert(flowRunAdmissions)
    .values({
      flowRunId,
      state,
      priorityClass: action,
      intentVersion: 1,
      intentJson: { version: 1, action, flow_run_id: flowRunId },
    })
    .returning({ ticket: flowRunAdmissions.ticket })
    .get().ticket;
}

const seedResumeAdmission = (db: TestDb, flowRunId: string, state: 'queued' | 'active') =>
  seedAdmission(db, flowRunId, state, 'resume');

/** Makes the run the only member of a running batch stage; returns the stage id. */
async function seedBatchMembership(
  db: TestDb,
  flowRunId: string,
  member: { run: 'pending' | 'cancelled' | 'failed'; stageRun: 'queued' | 'failed' },
): Promise<string> {
  await db
    .update(flowRuns)
    .set({ batchId: 'batch-1', status: member.run, startedAt: null })
    .where(eq(flowRuns.id, flowRunId));
  const stage = await createBatchStage(db, {
    batchId: 'batch-1',
    stageNumber: 1,
    name: 's1',
    status: 'running',
    failureThreshold: 0,
    dependsOnStageIds: [],
  });
  await createBatchStageRun(db, {
    stageId: stage.id,
    triggerContext: {},
    status: member.stageRun,
    flowRunId,
  });
  return stage.id;
}

const stageStatus = async (db: TestDb, stageId: string) =>
  (await getBatchStage(db, stageId))?.status;

/** Runs the Cancel with no batch listener attached, returning the terminal events it emitted. */
async function cancelCollectingEvents(
  flowRunId: string,
  options?: Parameters<typeof cancelFlowRun>[1],
): Promise<FlowExecutionEvent[]> {
  const seen: FlowExecutionEvent[] = [];
  const unsubscribe = subscribeFlowEvents((event) => seen.push(event));
  await cancelFlowRun(flowRunId, options);
  unsubscribe();
  return seen;
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

  it('keeps the stage running when a retry re-admits the run before its cancel event lands', async () => {
    const db = freshDb();
    holder.db = db;
    const { flowRunId } = await seedFlowRun(db, GRAPH);
    const stageId = await seedBatchMembership(db, flowRunId, {
      run: 'pending',
      stageRun: 'queued',
    });
    const ticket = seedAdmission(db, flowRunId, 'queued', 'start');

    const seen = await cancelCollectingEvents(flowRunId);
    expect(admissionState(db, ticket)).toBe('cancelled');
    // The user's Retry is queued before the cancel event reaches the batch listener.
    seedResumeAdmission(db, flowRunId, 'queued');
    for (const event of seen) await onBatchRunTerminal(event.flowRunId ?? '');

    expect(seen).toContainEqual(expect.objectContaining({ eventType: 'run_cancelled', flowRunId }));
    expect(await stageStatus(db, stageId)).toBe('running');
  });

  it('settles the stage when the queued retry of a finished member is cancelled', async () => {
    const db = freshDb();
    holder.db = db;
    const { flowRunId } = await seedFlowRun(db, GRAPH);
    const stageId = await seedBatchMembership(db, flowRunId, { run: 'failed', stageRun: 'failed' });
    const ticket = seedResumeAdmission(db, flowRunId, 'queued');

    const seen = await cancelCollectingEvents(flowRunId);

    expect(admissionState(db, ticket)).toBe('cancelled');
    // The run was already terminal, so its ending is not announced a second time.
    expect(seen.filter((event) => event.flowRunId)).toEqual([]);
    expect(await stageStatus(db, stageId)).toBe('failed');
  });
});

describe('a queued retry dropped without a terminal event', () => {
  it('settles the stage when the chat that owns the finished member is deleted', async () => {
    const db = freshDb();
    holder.db = db;
    const { flowRunId } = await seedFlowRun(db, GRAPH);
    const stageId = await seedBatchMembership(db, flowRunId, { run: 'failed', stageRun: 'failed' });
    const ticket = seedResumeAdmission(db, flowRunId, 'queued');

    await cancelFlowRunForChatDeletion(flowRunId, ['chat-1']);

    expect(admissionState(db, ticket)).toBe('cancelled');
    expect(await stageStatus(db, stageId)).toBe('failed');
  });

  it('settles the stage at startup once recovery drops a claim a dead process left behind', async () => {
    const db = freshDb();
    holder.db = db;
    const { flowRunId } = await seedFlowRun(db, GRAPH);
    const stageId = await seedBatchMembership(db, flowRunId, { run: 'failed', stageRun: 'failed' });
    const ticket = seedAdmission(db, flowRunId, 'claimed', 'resume');

    await recoverFlowAdmissionsAtStartup();

    expect(admissionState(db, ticket)).toBe('failed');
    expect(await stageStatus(db, stageId)).toBe('failed');
  });

  it('still reports the Cancel as done when the stage settle fails', async () => {
    const db = freshDb();
    holder.db = db;
    const { flowRunId } = await seedFlowRun(db, GRAPH);
    const stageId = await seedBatchMembership(db, flowRunId, { run: 'failed', stageRun: 'failed' });
    const ticket = seedResumeAdmission(db, flowRunId, 'queued');
    registerBatchStageSettler(async () => {
      throw new Error('stage settle failed');
    });

    const result = await cancelFlowRun(flowRunId).finally(() =>
      registerBatchStageSettler(onBatchRunTerminal),
    );

    // The ticket is gone either way; the stage is picked up by the next member event or sweep.
    expect(result?.status).toBe('failed');
    expect(admissionState(db, ticket)).toBe('cancelled');
    expect(await stageStatus(db, stageId)).toBe('running');
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

  it('keeps the stage running when a retry re-admits the run before its cancel event lands', async () => {
    const db = freshDb();
    holder.db = db;
    const { flowRunId } = await seedFlowRun(db, GRAPH);
    const stageId = await seedBatchMembership(db, flowRunId, {
      run: 'pending',
      stageRun: 'queued',
    });
    // The dequeue's own transaction: the never-dispatched run and its stage run are terminalized.
    holder.cancelUndispatched.mockImplementationOnce(async () => {
      await setFlowRunStatus(db, flowRunId, 'cancelled');
      await db
        .update(batchStageRuns)
        .set({ status: 'failed' })
        .where(eq(batchStageRuns.flowRunId, flowRunId));
      return true;
    });

    const seen = await cancelCollectingEvents(flowRunId, { queuedOnly: QUEUED_ONLY });
    // The user's Retry is queued before the cancel event reaches the batch listener.
    seedResumeAdmission(db, flowRunId, 'queued');
    for (const event of seen) await onBatchRunTerminal(event.flowRunId ?? '');

    expect(seen).toContainEqual(expect.objectContaining({ eventType: 'run_cancelled', flowRunId }));
    expect(await stageStatus(db, stageId)).toBe('running');
  });

  it('settles the stage when the queued retry of a finished member is removed', async () => {
    const db = freshDb();
    holder.db = db;
    const { flowRunId } = await seedFlowRun(db, GRAPH);
    const stageId = await seedBatchMembership(db, flowRunId, { run: 'failed', stageRun: 'failed' });
    // The removed ticket was the only thing the stage was still waiting on.
    holder.cancelUndispatched.mockResolvedValueOnce(true);

    const seen = await cancelCollectingEvents(flowRunId, { queuedOnly: QUEUED_ONLY });

    expect(seen.filter((event) => event.flowRunId)).toEqual([]);
    expect(await stageStatus(db, stageId)).toBe('failed');
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
