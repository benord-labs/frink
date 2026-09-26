import { eq } from 'drizzle-orm';
import { beforeEach, describe, expect, it } from 'vitest';
import type { FlowGraph } from '../../../../../shared/lib/validate-flow-graph';
import { flowRunAdmissions, flowRuns } from '../../schema';
import { seedFlowRun } from '../../test-utils/flow-fixtures';
import { freshDb, type TestDb } from '../../test-utils/fresh-db';
import { getOrCreateFlowRunByIdempotencyKey, setFlowRunStatus } from '../flow-runs';
import { createTask, listTasksWithProjectPaginated, updateTaskStatus } from '../tasks';
import { getWorkQueueOverviewCounts } from './work-queue-overview-counts';

const GRAPH: FlowGraph = {
  nodes: [{ id: 'agent', blockType: 'agent', config: {}, position: { x: 0, y: 0 } }],
  edges: [],
};

async function addQueuedAdmission(
  db: TestDb,
  flowRunId: string,
  priorityClass: 'start' | 'resume' = 'start',
) {
  await db.insert(flowRunAdmissions).values({
    flowRunId,
    state: 'queued',
    priorityClass,
    intentVersion: 1,
    intentJson: { version: 1, action: priorityClass, flow_run_id: flowRunId },
    requestedAt: new Date(),
  });
}

async function addFlowRun(db: TestDb, flowVersionId: string, idempotencyKey: string) {
  const { run } = await getOrCreateFlowRunByIdempotencyKey(db, {
    flowVersionId,
    status: 'running',
    triggerContext: null,
    idempotencyKey,
    startedAt: new Date(),
  });
  return run;
}

describe('getWorkQueueOverviewCounts', () => {
  let db: TestDb;

  beforeEach(() => {
    db = freshDb();
  });

  it('counts admission-queued Flow starts before task rows exist', async () => {
    const first = await seedFlowRun(db, GRAPH, { idempotencyKey: 'queued-start-1' });
    const second = await addFlowRun(db, first.versionId, 'queued-start-2');
    await db
      .update(flowRuns)
      .set({ status: 'pending', startedAt: null })
      .where(eq(flowRuns.id, first.flowRunId));
    await db
      .update(flowRuns)
      .set({ status: 'pending', startedAt: null })
      .where(eq(flowRuns.id, second.id));
    await addQueuedAdmission(db, first.flowRunId);
    await addQueuedAdmission(db, second.id);

    await expect(getWorkQueueOverviewCounts(db)).resolves.toEqual({
      inbox: 0,
      queued: 2,
      review: 0,
      running: 0,
    });
  });

  it('moves a queued resume out of Review without double-counting the Flow', async () => {
    const queued = await seedFlowRun(db, GRAPH, { idempotencyKey: 'queued-resume' });
    const queuedTask = await createTask(db, {
      description: 'Queued retry',
      source: 'flow',
      flowRunId: queued.flowRunId,
    });
    await updateTaskStatus(db, queuedTask.id, 'failed');
    await setFlowRunStatus(db, queued.flowRunId, 'failed');
    await addQueuedAdmission(db, queued.flowRunId, 'resume');

    const review = await addFlowRun(db, queued.versionId, 'ordinary-review');
    const reviewTask = await createTask(db, {
      description: 'Ordinary failure',
      source: 'flow',
      flowRunId: review.id,
    });
    await updateTaskStatus(db, reviewTask.id, 'failed');
    await setFlowRunStatus(db, review.id, 'failed');

    await expect(getWorkQueueOverviewCounts(db)).resolves.toEqual({
      inbox: 0,
      queued: 1,
      review: 1,
      running: 0,
    });
    await expect(
      listTasksWithProjectPaginated(db, {
        workQueueSection: 'attention',
      }).then((page) => page.items.map((task) => task.id)),
    ).resolves.toEqual([reviewTask.id]);
  });

  it('counts manual-wait Inbox tasks separately from machine admission', async () => {
    await createTask(db, {
      description: 'Wait for pickup',
      source: 'manual',
      triggerContext: { _config: { startMode: 'wait' } },
    });

    await expect(getWorkQueueOverviewCounts(db)).resolves.toEqual({
      inbox: 1,
      queued: 0,
      review: 0,
      running: 0,
    });
  });
});
