import { eq } from 'drizzle-orm';
import { beforeEach, describe, expect, it, vi } from 'vitest';

// Real in-memory SQLite (freshDb) + mocked startFlowRun: the unit under test is
// batch dispatch/advancement — root dispatch, slot-fill, threshold settling,
// successor promotion, cascade cancel, and the event-less restart sweep — not
// the node engine itself.

const { mocks } = vi.hoisted(() => ({
  mocks: {
    startFlowRun: vi.fn(),
    getDatabase: vi.fn(),
  },
}));

vi.mock('../db', () => ({ getDatabase: mocks.getDatabase }));
vi.mock('./start', () => ({
  startFlowRun: mocks.startFlowRun,
}));

import { listRunsForStage, setStageRunStatusIf } from '../db/repos/batch-stage-runs';
import { getBatchStage, setStageStatusIf } from '../db/repos/batch-stages';
import { flowRuns } from '../db/schema';
import { freshDb, type TestDb } from '../db/test-utils/fresh-db';
import { setFlowAdmissionLifecycleHooks } from './admission/activity';
import { onBatchRunTerminal, recoverBatchStages, startFlowBatchLocal } from './batch-dispatch';
import {
  makeStartFlowRunMock,
  runId,
  seedBatchFlow,
  seedBatchStage,
  setRunStatus,
} from './batch-test-factories';

let db: TestDb;
let flowId: string;
let versionId: string;

const BATCH = 'batch-1';
async function seedFlow(settings: Record<string, unknown> = {}) {
  ({ flowId, versionId } = await seedBatchFlow(db, settings));
}

const seedStage = (input: Parameters<typeof seedBatchStage>[2]) => seedBatchStage(db, BATCH, input);

/** Drive a dispatched run to terminal the way the engine would: row + event hook. */
async function finishRun(flowRunId: string, status: 'completed' | 'failed' | 'cancelled') {
  await setRunStatus(db, flowRunId, status);
  await onBatchRunTerminal(flowRunId);
}

beforeEach(async () => {
  vi.clearAllMocks();
  db = freshDb();
  mocks.getDatabase.mockReturnValue(db);
  mocks.startFlowRun.mockImplementation(makeStartFlowRunMock(db, () => versionId));
  await seedFlow();
});

describe('startFlowBatchLocal — root dispatch', () => {
  it('creates real flow_runs for root BSRs and reports honest counts', async () => {
    await seedStage({ stageNumber: 1, runCount: 2 });

    const result = await startFlowBatchLocal(flowId, BATCH);

    expect(result).toMatchObject({ started: true, startedStageNumbers: [1], totalEnqueued: 2 });
    expect(mocks.startFlowRun).toHaveBeenCalledTimes(2);
    const runs = await db.select().from(flowRuns);
    expect(runs).toHaveLength(2);
    expect(runs.every((r) => r.batchId === BATCH)).toBe(true);
  });

  it('links BSRs to their flow_runs and marks them dispatched', async () => {
    const stage = await seedStage({ stageNumber: 1, runCount: 1 });
    await startFlowBatchLocal(flowId, BATCH);

    const [bsr] = await listRunsForStage(db, stage.id);
    expect(bsr.status).toBe('dispatched');
    expect(bsr.flowRunId).toBeTruthy();
    expect((await getBatchStage(db, stage.id))?.status).toBe('running');
  });

  it('is idempotent: a second call reports all-roots-started without re-dispatching', async () => {
    await seedStage({ stageNumber: 1, runCount: 1 });
    await startFlowBatchLocal(flowId, BATCH);
    mocks.startFlowRun.mockClear();

    const second = await startFlowBatchLocal(flowId, BATCH);

    expect(second).toMatchObject({ started: false, reason: 'all-roots-started' });
    expect(mocks.startFlowRun).not.toHaveBeenCalled();
  });

  it('returns no-stages-defined / no-root-stages for malformed batches', async () => {
    expect(await startFlowBatchLocal(flowId, BATCH)).toMatchObject({
      started: false,
      reason: 'no-stages-defined',
    });

    await seedStage({ stageNumber: 1, runCount: 1, dependsOnStageIds: ['ghost'] });
    expect(await startFlowBatchLocal(flowId, BATCH)).toMatchObject({
      started: false,
      reason: 'no-root-stages',
    });
  });

  it('settles an empty root stage immediately and promotes its successor', async () => {
    const root = await seedStage({ stageNumber: 1, runCount: 0 });
    const next = await seedStage({ stageNumber: 2, runCount: 1, dependsOnStageIds: [root.id] });

    const result = await startFlowBatchLocal(flowId, BATCH);

    expect((await getBatchStage(db, root.id))?.status).toBe('completed');
    expect((await getBatchStage(db, next.id))?.status).toBe('running');
    expect(mocks.startFlowRun).toHaveBeenCalledTimes(1);
    // The empty root itself enqueued nothing.
    expect(result.totalEnqueued).toBe(0);
  });

  it('fails a BSR loudly (no spawn) when trigger_context mismatches the declared schema', async () => {
    await seedFlow({ batchTriggerSchema: [{ key: 'ticket', type: 'string' }] });
    const stage = await seedStage({
      stageNumber: 1,
      runCount: 1,
      triggerContext: { ticket: 42 },
    });

    const result = await startFlowBatchLocal(flowId, BATCH);

    expect(mocks.startFlowRun).not.toHaveBeenCalled();
    expect(result.totalEnqueued).toBe(0);
    const [bsr] = await listRunsForStage(db, stage.id);
    expect(bsr.status).toBe('failed');
    // Sole run failed with threshold 0 → stage failed.
    expect((await getBatchStage(db, stage.id))?.status).toBe('failed');
  });
});

describe('concurrency — maxBatchConcurrency slot-fill', () => {
  it('caps in-flight runs at the limit and promotes pending BSRs as runs finish', async () => {
    await seedFlow({ maxBatchConcurrency: 2 });
    const stage = await seedStage({ stageNumber: 1, runCount: 5 });

    const result = await startFlowBatchLocal(flowId, BATCH);
    expect(result.totalEnqueued).toBe(2);

    let runs = await listRunsForStage(db, stage.id);
    expect(runs.filter((r) => r.status === 'dispatched')).toHaveLength(2);
    expect(runs.filter((r) => r.status === 'pending')).toHaveLength(3);

    const first = runs.find((r) => r.status === 'dispatched');
    await finishRun(runId(first), 'completed');

    runs = await listRunsForStage(db, stage.id);
    expect(runs.filter((r) => r.status === 'dispatched')).toHaveLength(2); // slot refilled
    expect(runs.filter((r) => r.status === 'pending')).toHaveLength(2);
    expect(runs.filter((r) => r.status === 'completed')).toHaveLength(1);
  });
});

describe('stage advancement', () => {
  it('promotes a successor only after ALL dependencies complete', async () => {
    const rootA = await seedStage({ stageNumber: 1, runCount: 1 });
    const rootB = await seedStage({ stageNumber: 2, runCount: 1 });
    const join = await seedStage({
      stageNumber: 3,
      runCount: 1,
      dependsOnStageIds: [rootA.id, rootB.id],
    });
    await startFlowBatchLocal(flowId, BATCH);

    const [runA] = await listRunsForStage(db, rootA.id);
    await finishRun(runId(runA), 'completed');
    expect((await getBatchStage(db, join.id))?.status).toBe('pending'); // B still running

    const [runB] = await listRunsForStage(db, rootB.id);
    await finishRun(runId(runB), 'completed');
    expect((await getBatchStage(db, join.id))?.status).toBe('running');
    expect(mocks.startFlowRun).toHaveBeenCalledTimes(3);
  });

  it('failureThreshold 0: a failed run fails the stage and cascade-cancels blocked stages', async () => {
    const root = await seedStage({ stageNumber: 1, runCount: 1, failureThreshold: 0 });
    const mid = await seedStage({ stageNumber: 2, runCount: 1, dependsOnStageIds: [root.id] });
    const leaf = await seedStage({ stageNumber: 3, runCount: 1, dependsOnStageIds: [mid.id] });
    await startFlowBatchLocal(flowId, BATCH);

    const [run] = await listRunsForStage(db, root.id);
    await finishRun(runId(run), 'failed');

    expect((await getBatchStage(db, root.id))?.status).toBe('failed');
    expect((await getBatchStage(db, mid.id))?.status).toBe('cancelled');
    expect((await getBatchStage(db, leaf.id))?.status).toBe('cancelled');
    const [midBsr] = await listRunsForStage(db, mid.id);
    expect(midBsr.status).toBe('cancelled');
  });

  it('failureThreshold -1 never blocks: stage completes despite failures', async () => {
    const root = await seedStage({ stageNumber: 1, runCount: 2, failureThreshold: -1 });
    const next = await seedStage({ stageNumber: 2, runCount: 0, dependsOnStageIds: [root.id] });
    await startFlowBatchLocal(flowId, BATCH);

    const runs = await listRunsForStage(db, root.id);
    await finishRun(runId(runs[0]), 'failed');
    await finishRun(runId(runs[1]), 'completed');

    expect((await getBatchStage(db, root.id))?.status).toBe('completed');
    expect((await getBatchStage(db, next.id))?.status).toBe('completed'); // empty successor settles through
  });

  it('treats a cancelled run as failed for the threshold', async () => {
    const root = await seedStage({ stageNumber: 1, runCount: 1, failureThreshold: 0 });
    await startFlowBatchLocal(flowId, BATCH);

    const [run] = await listRunsForStage(db, root.id);
    await finishRun(runId(run), 'cancelled');

    expect((await getBatchStage(db, root.id))?.status).toBe('failed');
  });

  it('links an unlinked BSR via the idempotencyKey fallback and settles it', async () => {
    // Fire-and-forget race / restart: the run exists (idempotencyKey = bsr.id)
    // but the dispatch loop's flowRunId link never landed.
    const root = await seedStage({ stageNumber: 1, runCount: 1 });
    await startFlowBatchLocal(flowId, BATCH);
    const { batchStageRuns } = await import('../db/schema');
    const [bsr] = await listRunsForStage(db, root.id);
    await db.update(batchStageRuns).set({ flowRunId: null }).where(eq(batchStageRuns.id, bsr.id));

    await finishRun(runId(bsr), 'completed');

    const [settled] = await listRunsForStage(db, root.id);
    expect(settled.status).toBe('completed');
    expect(settled.flowRunId).toBe(bsr.flowRunId);
    expect((await getBatchStage(db, root.id))?.status).toBe('completed');
  });

  it('ignores terminal events from non-batch runs', async () => {
    const [plain] = await db
      .insert(flowRuns)
      .values({ flowVersionId: versionId, status: 'completed' })
      .returning();

    await expect(onBatchRunTerminal(plain.id)).resolves.toBeUndefined();
  });

  it('reconciles a standalone admission on its later terminal event', async () => {
    const reconcile = vi.fn(async () => {});
    setFlowAdmissionLifecycleHooks({ reconcile, requestRelease: vi.fn(async () => {}) });
    const { startBatchAdvanceListener } = await import('./batch-dispatch');
    const { flowEventBus } = await import('./events');
    const unsubscribe = startBatchAdvanceListener();
    flowEventBus.emitFlowEvent({
      eventType: 'run_completed',
      flowId,
      flowName: 'Runtime recovery',
      flowRunId: 'standalone-run',
      runStatus: 'completed',
    });
    await vi.waitFor(() => expect(reconcile).toHaveBeenCalledWith('standalone-run', undefined));
    unsubscribe();
  });

  it('releases terminal activity cleanly when batch advancement fails', async () => {
    const reconcile = vi.fn(async () => {});
    setFlowAdmissionLifecycleHooks({ reconcile, requestRelease: vi.fn(async () => {}) });
    const { startBatchAdvanceListener } = await import('./batch-dispatch');
    const { flowEventBus } = await import('./events');
    const unsubscribe = startBatchAdvanceListener();
    mocks.getDatabase.mockImplementationOnce(() => {
      throw new Error('transient batch advancement failure');
    });

    flowEventBus.emitFlowEvent({
      eventType: 'run_completed',
      flowId,
      flowName: 'Runtime recovery',
      flowRunId: 'failed-advance-run',
      runStatus: 'completed',
      batchId: BATCH,
    });

    await vi.waitFor(() => expect(reconcile).toHaveBeenCalledWith('failed-advance-run', undefined));
    unsubscribe();
  });
});

describe('recoverBatchStages — event-less restart sweep', () => {
  it('fails stale existing-run redispatch instead of bypassing global admission', async () => {
    const root = await seedStage({ stageNumber: 1, runCount: 1 });
    await startFlowBatchLocal(flowId, BATCH);
    const [bsr] = await listRunsForStage(db, root.id);
    await finishRun(runId(bsr), 'failed');
    await setStageRunStatusIf(db, bsr.id, ['failed'], 'pending', bsr.flowRunId ?? undefined);
    await setStageStatusIf(db, root.id, 'failed', 'running');

    await recoverBatchStages();

    expect((await listRunsForStage(db, root.id))[0].status).toBe('failed');
  });

  it('settles dispatched BSRs whose runs terminalized without an event, then advances', async () => {
    const root = await seedStage({ stageNumber: 1, runCount: 1 });
    const next = await seedStage({ stageNumber: 2, runCount: 1, dependsOnStageIds: [root.id] });
    await startFlowBatchLocal(flowId, BATCH);

    // Simulate restart: the orphan sweep cancelled the run with no event.
    const [bsr] = await listRunsForStage(db, root.id);
    await db
      .update(flowRuns)
      .set({ status: 'completed' })
      .where(eq(flowRuns.id, runId(bsr)));

    await recoverBatchStages();

    expect((await listRunsForStage(db, root.id))[0].status).toBe('completed');
    expect((await getBatchStage(db, root.id))?.status).toBe('completed');
    expect((await getBatchStage(db, next.id))?.status).toBe('running');
  });

  it('fails a dispatched BSR whose flow_run is missing entirely', async () => {
    const root = await seedStage({ stageNumber: 1, runCount: 1, failureThreshold: 0 });
    await startFlowBatchLocal(flowId, BATCH);

    const [bsr] = await listRunsForStage(db, root.id);
    await db.delete(flowRuns).where(eq(flowRuns.id, runId(bsr)));

    await recoverBatchStages();

    expect((await listRunsForStage(db, root.id))[0].status).toBe('failed');
    expect((await getBatchStage(db, root.id))?.status).toBe('failed');
  });

  it('re-dispatches pending BSRs of a running stage after restart', async () => {
    await seedFlow({ maxBatchConcurrency: 1 });
    const root = await seedStage({ stageNumber: 1, runCount: 2 });
    await startFlowBatchLocal(flowId, BATCH);

    const dispatched = (await listRunsForStage(db, root.id)).find((r) => r.status === 'dispatched');
    await db
      .update(flowRuns)
      .set({ status: 'completed' })
      .where(eq(flowRuns.id, runId(dispatched)));

    await recoverBatchStages();

    const runs = await listRunsForStage(db, root.id);
    expect(runs.filter((r) => r.status === 'completed')).toHaveLength(1);
    expect(runs.filter((r) => r.status === 'dispatched')).toHaveLength(1); // slot-filled
  });

  it('resets a running stage with no batch runs back to pending (pre-dispatch crash)', async () => {
    const root = await seedStage({ stageNumber: 1, runCount: 1 });
    await startFlowBatchLocal(flowId, BATCH);
    // Wipe all evidence of dispatch: BSR back to pending, runs gone.
    const [bsr] = await listRunsForStage(db, root.id);
    await db.delete(flowRuns);
    const { batchStageRuns } = await import('../db/schema');
    await db
      .update(batchStageRuns)
      .set({ status: 'pending', flowRunId: null })
      .where(eq(batchStageRuns.id, bsr.id));

    await recoverBatchStages();

    expect((await getBatchStage(db, root.id))?.status).toBe('pending');
    expect(await startFlowBatchLocal(flowId, BATCH)).toMatchObject({ started: true });
  });
});
