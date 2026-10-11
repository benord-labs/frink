import { eq, sql } from 'drizzle-orm';
import { beforeEach, describe, expect, it } from 'vitest';
import {
  batchStageRuns,
  batchStages,
  flowRunAdmissions,
  flowRuns,
  flows,
  flowVersions,
} from '../../db/schema';
import { freshDb, type TestDb } from '../../db/test-utils/fresh-db';
import { _resetFlowAdmissionControllerMutexForTests, FlowAdmissionController } from './controller';

const GRAPH = { nodes: [], edges: [], settings: {} };

function seedVersion(db: TestDb): string {
  db.insert(flows).values({ id: 'flow-start', name: 'Start admission' }).run();
  db.insert(flowVersions)
    .values({
      id: 'version-start',
      flowId: 'flow-start',
      versionNumber: 1,
      graph: GRAPH,
    })
    .run();
  return 'version-start';
}

function seedBatchStageRun(db: TestDb, status = 'pending'): string {
  db.insert(batchStages)
    .values({ id: 'stage-start', batchId: 'batch-start', stageNumber: 1 })
    .run();
  db.insert(batchStageRuns).values({ id: 'stage-run-start', stageId: 'stage-start', status }).run();
  return 'stage-run-start';
}

function startInput(flowVersionId: string, idempotencyKey: string) {
  return {
    flowVersionId,
    userId: 'u1',
    triggerContext: { source: 'test' },
    idempotencyKey,
    batchId: null,
  };
}

describe('atomic Flow start admission', () => {
  beforeEach(() => {
    _resetFlowAdmissionControllerMutexForTests();
  });

  it('serializes same-key starts into one pending run and one admission', async () => {
    const db = freshDb();
    const flowVersionId = seedVersion(db);
    const controller = new FlowAdmissionController(db);
    const [first, second] = await Promise.all([
      controller.enqueueStart(startInput(flowVersionId, 'same-start')),
      controller.enqueueStart(startInput(flowVersionId, 'same-start')),
    ]);
    expect([first.isReplay, second.isReplay].sort()).toEqual([false, true]);
    expect(first.run.id).toBe(second.run.id);
    expect(first.admission?.ticket).toBe(second.admission?.ticket);
    expect(first.run).toMatchObject({ status: 'pending', startedAt: null, completedAt: null });
    expect(db.select().from(flowRuns).all()).toHaveLength(1);
    expect(db.select().from(flowRunAdmissions).all()).toHaveLength(1);
  });
  it('replays one run for a repeated idempotency key', async () => {
    const db = freshDb();
    const flowVersionId = seedVersion(db);
    const controller = new FlowAdmissionController(db);
    const first = await controller.enqueueStart(startInput(flowVersionId, 'repeat-start'));

    const replay = await controller.enqueueStart(startInput(flowVersionId, 'repeat-start'));

    expect(replay.isReplay).toBe(true);
    expect(replay.run.id).toBe(first.run.id);
    expect(db.select().from(flowRuns).all()).toEqual([first.run]);
  });
  it('re-enqueues only a replay that is still pending and proven unstarted', async () => {
    const db = freshDb();
    const flowVersionId = seedVersion(db);
    const controller = new FlowAdmissionController(db);
    const first = await controller.enqueueStart(startInput(flowVersionId, 'retry-start'));
    db.update(flowRunAdmissions)
      .set({ state: 'failed', settledAt: new Date('2026-08-01T10:00:00Z') })
      .where(eq(flowRunAdmissions.ticket, first.admission?.ticket ?? -1))
      .run();
    const replay = await controller.enqueueStart(startInput(flowVersionId, 'retry-start'));
    expect(replay).toMatchObject({ isReplay: true, run: { status: 'pending', startedAt: null } });
    expect(replay.admission?.ticket).toBeGreaterThan(first.admission?.ticket ?? 0);
    expect(db.select().from(flowRunAdmissions).all()).toHaveLength(2);
  });
  it('returns no new admission for a replay that has already begun or terminated', async () => {
    const db = freshDb();
    const flowVersionId = seedVersion(db);
    const controller = new FlowAdmissionController(db);
    const first = await controller.enqueueStart(startInput(flowVersionId, 'begun-start'));
    const [claimed] = (await controller.claimEligible()).admissions;
    await controller.beginDispatch(claimed.ticket, new Date('2026-08-01T11:00:00Z'));
    const replay = await controller.enqueueStart(startInput(flowVersionId, 'begun-start'));
    expect(replay).toMatchObject({ isReplay: true, admission: null, run: { status: 'running' } });
    expect(await controller.getLiveForRun(first.run.id)).toMatchObject({ state: 'active' });

    await controller.beginRelease(claimed.ticket);
    await controller.settle(claimed.ticket, 'released');
    db.update(flowRuns)
      .set({ status: 'completed', completedAt: new Date('2026-08-01T11:01:00Z') })
      .where(eq(flowRuns.id, first.run.id))
      .run();
    const terminalReplay = await controller.enqueueStart(startInput(flowVersionId, 'begun-start'));
    expect(terminalReplay).toMatchObject({
      isReplay: true,
      admission: null,
      run: { status: 'completed' },
    });
    expect(db.select().from(flowRunAdmissions).all()).toHaveLength(1);
  });
  it('atomically links an eligible batch member and rolls back an ineligible one', async () => {
    const db = freshDb();
    const flowVersionId = seedVersion(db);
    const batchStageRunId = seedBatchStageRun(db, 'dispatched');
    const controller = new FlowAdmissionController(db);
    await expect(
      controller.enqueueStart({
        ...startInput(flowVersionId, 'batch-rejected'),
        batchId: 'batch-start',
        batchStageRunId,
      }),
    ).rejects.toThrow(/not eligible for admission/);
    expect(db.select().from(flowRuns).all()).toEqual([]);
    expect(db.select().from(flowRunAdmissions).all()).toEqual([]);
    expect(
      db.select().from(batchStageRuns).where(eq(batchStageRuns.id, batchStageRunId)).get(),
    ).toMatchObject({ status: 'dispatched', flowRunId: null });
  });
  it('queues a batch member with the attachments it holds at link time, not the dispatch snapshot', async () => {
    const db = freshDb();
    const flowVersionId = seedVersion(db);
    const batchStageRunId = seedBatchStageRun(db);
    const early = { url: 'frink-attachment://stage-run-start/a.png', type: 'image/png' };
    const late = { url: 'frink-attachment://stage-run-start/b.png', type: 'image/png' };
    // An upload committed after dispatch read the member but before it was queued.
    db.update(batchStageRuns)
      .set({ triggerContext: { attachments: [early, late] } })
      .where(eq(batchStageRuns.id, batchStageRunId))
      .run();
    const controller = new FlowAdmissionController(db);

    const { run } = await controller.enqueueStart({
      ...startInput(flowVersionId, 'batch-attachments'),
      triggerContext: { source: 'test', attachments: [early] },
      batchId: 'batch-start',
      batchStageRunId,
    });

    const expected = { source: 'test', attachments: [early, late] };
    expect(run.triggerContext).toEqual(expected);
    expect(db.select().from(flowRuns).where(eq(flowRuns.id, run.id)).get()?.triggerContext).toEqual(
      expected,
    );
  });
  it.each([['not-an-array'], [42], [null]])(
    'keeps the dispatch snapshot when the member attachments value is malformed (%j)',
    async (malformed) => {
      const db = freshDb();
      const flowVersionId = seedVersion(db);
      const batchStageRunId = seedBatchStageRun(db);
      db.update(batchStageRuns)
        .set({ triggerContext: { attachments: malformed } })
        .where(eq(batchStageRuns.id, batchStageRunId))
        .run();
      const snapshot = { url: 'frink-attachment://stage-run-start/a.png', type: 'image/png' };
      const controller = new FlowAdmissionController(db);

      const { run } = await controller.enqueueStart({
        ...startInput(flowVersionId, 'batch-malformed'),
        triggerContext: { source: 'test', attachments: [snapshot] },
        batchId: 'batch-start',
        batchStageRunId,
      });

      expect(run.triggerContext).toEqual({ source: 'test', attachments: [snapshot] });
    },
  );
  it('leaves the run trigger_context alone when the batch member has no attachments', async () => {
    const db = freshDb();
    const flowVersionId = seedVersion(db);
    const batchStageRunId = seedBatchStageRun(db);
    const controller = new FlowAdmissionController(db);

    const { run } = await controller.enqueueStart({
      ...startInput(flowVersionId, 'batch-no-attachments'),
      batchId: 'batch-start',
      batchStageRunId,
    });

    expect(run.triggerContext).toEqual({ source: 'test' });
  });
  it('refuses to queue a member into a stage at its concurrency limit and leaves it pending', async () => {
    const db = freshDb();
    seedVersion(db);
    db.insert(flowVersions)
      .values({
        id: 'version-limit-1',
        flowId: 'flow-start',
        versionNumber: 2,
        graph: { ...GRAPH, settings: { maxBatchConcurrency: 1 } },
      })
      .run();
    const batchStageRunId = seedBatchStageRun(db, 'pending');
    db.insert(batchStageRuns)
      .values({ id: 'stage-run-occupant', stageId: 'stage-start', status: 'dispatched' })
      .run();
    const controller = new FlowAdmissionController(db);
    await expect(
      controller.enqueueStart({
        ...startInput('version-limit-1', 'batch-full'),
        batchId: 'batch-start',
        batchStageRunId,
      }),
    ).rejects.toThrow(/at its concurrency limit/);
    expect(db.select().from(flowRuns).all()).toEqual([]);
    expect(db.select().from(flowRunAdmissions).all()).toEqual([]);
    expect(
      db.select().from(batchStageRuns).where(eq(batchStageRuns.id, batchStageRunId)).get(),
    ).toMatchObject({ status: 'pending', flowRunId: null });
  });
  it('promotes run, batch member, and admission in one dispatch transaction', async () => {
    const db = freshDb();
    const flowVersionId = seedVersion(db);
    const batchStageRunId = seedBatchStageRun(db);
    const controller = new FlowAdmissionController(db);
    const enqueued = await controller.enqueueStart({
      ...startInput(flowVersionId, 'batch-started'),
      batchId: 'batch-start',
      batchStageRunId,
    });
    expect(
      db.select().from(batchStageRuns).where(eq(batchStageRuns.id, batchStageRunId)).get(),
    ).toMatchObject({ status: 'queued', flowRunId: enqueued.run.id });
    const [claimed] = (await controller.claimEligible()).admissions;
    const now = new Date('2026-08-01T12:00:00Z');
    const active = await controller.beginDispatch(claimed.ticket, now);
    expect(active).toMatchObject({ state: 'active', startedAt: now });
    expect(db.select().from(flowRuns).where(eq(flowRuns.id, enqueued.run.id)).get()).toMatchObject({
      status: 'running',
      startedAt: now,
    });
    expect(
      db.select().from(batchStageRuns).where(eq(batchStageRuns.id, batchStageRunId)).get(),
    ).toMatchObject({ status: 'dispatched', flowRunId: enqueued.run.id });
    expect(await controller.requestCancellation(enqueued.admission?.ticket ?? -1)).toMatchObject({
      state: 'releasing',
      error: null,
    });
    expect(
      db.select().from(batchStageRuns).where(eq(batchStageRuns.id, batchStageRunId)).get(),
    ).toMatchObject({ status: 'failed' });
  });
  it('requeues a claimed batch start without dispatching its batch member', async () => {
    const db = freshDb();
    const flowVersionId = seedVersion(db);
    const batchStageRunId = seedBatchStageRun(db);
    const controller = new FlowAdmissionController(db);
    const enqueued = await controller.enqueueStart({
      ...startInput(flowVersionId, 'batch-claimed-recovery'),
      batchId: 'batch-start',
      batchStageRunId,
    });
    const [claimed] = (await controller.claimEligible()).admissions;

    const recovery = await controller.recoverySnapshot();

    expect(recovery.autoDrainable).toEqual([
      expect.objectContaining({ ticket: claimed.ticket, state: 'queued', claimedAt: null }),
    ]);
    expect(db.select().from(flowRuns).where(eq(flowRuns.id, enqueued.run.id)).get()).toMatchObject({
      status: 'pending',
      startedAt: null,
    });
    expect(
      db.select().from(batchStageRuns).where(eq(batchStageRuns.id, batchStageRunId)).get(),
    ).toMatchObject({ status: 'queued', flowRunId: enqueued.run.id });
  });
  it('fails a batch member when its globally queued Flow is cancelled', async () => {
    const db = freshDb();
    const flowVersionId = seedVersion(db);
    const batchStageRunId = seedBatchStageRun(db);
    const controller = new FlowAdmissionController(db);
    const enqueued = await controller.enqueueStart({
      ...startInput(flowVersionId, 'batch-cancelled'),
      batchId: 'batch-start',
      batchStageRunId,
    });

    const cancelled = await controller.requestCancellation(enqueued.admission?.ticket ?? -1);

    expect(cancelled).toMatchObject({ state: 'cancelled' });
    expect(db.select().from(flowRuns).where(eq(flowRuns.id, enqueued.run.id)).get()).toMatchObject({
      status: 'cancelled',
      startedAt: null,
    });
    expect(
      db.select().from(batchStageRuns).where(eq(batchStageRuns.id, batchStageRunId)).get(),
    ).toMatchObject({ status: 'failed', flowRunId: enqueued.run.id });
  });
  it('does not overwrite a terminal run or its batch result when cancellation loses the CAS', async () => {
    const db = freshDb();
    const flowVersionId = seedVersion(db);
    const batchStageRunId = seedBatchStageRun(db);
    const controller = new FlowAdmissionController(db);
    const enqueued = await controller.enqueueStart({
      ...startInput(flowVersionId, 'batch-terminal-race'),
      batchId: 'batch-start',
      batchStageRunId,
    });
    const [claimed] = (await controller.claimEligible()).admissions;
    await controller.beginDispatch(claimed.ticket);
    db.update(flowRuns)
      .set({ status: 'completed', completedAt: new Date() })
      .where(eq(flowRuns.id, enqueued.run.id))
      .run();

    expect(await controller.requestCancellation(claimed.ticket)).toBeNull();
    expect(db.select().from(flowRuns).where(eq(flowRuns.id, enqueued.run.id)).get()?.status).toBe(
      'completed',
    );
    expect(
      db.select().from(batchStageRuns).where(eq(batchStageRuns.id, batchStageRunId)).get(),
    ).toMatchObject({ status: 'dispatched' });
    expect(await controller.getLiveForRun(enqueued.run.id)).toMatchObject({ state: 'active' });
  });
  it('fails the unstarted run and releases a claim when batch promotion is lost', async () => {
    const db = freshDb();
    const flowVersionId = seedVersion(db);
    const batchStageRunId = seedBatchStageRun(db);
    const controller = new FlowAdmissionController(db);
    const enqueued = await controller.enqueueStart({
      ...startInput(flowVersionId, 'batch-lost'),
      batchId: 'batch-start',
      batchStageRunId,
    });
    const [claimed] = (await controller.claimEligible()).admissions;
    db.update(batchStageRuns)
      .set({ status: 'cancelled' })
      .where(eq(batchStageRuns.id, batchStageRunId))
      .run();

    expect(await controller.beginDispatch(claimed.ticket)).toBeNull();
    expect(db.select().from(flowRuns).where(eq(flowRuns.id, enqueued.run.id)).get()).toMatchObject({
      status: 'failed',
      startedAt: null,
      completedAt: expect.any(Date),
    });
    expect(
      db.select().from(flowRunAdmissions).where(eq(flowRunAdmissions.ticket, claimed.ticket)).get(),
    ).toMatchObject({ state: 'failed', error: expect.stringContaining('not queued') });
    expect((await controller.getSnapshot()).occupied).toBe(0);
  });
  it('rolls back run promotion when the admission loses its dispatch claim', async () => {
    const db = freshDb();
    const flowVersionId = seedVersion(db);
    const controller = new FlowAdmissionController(db);
    const enqueued = await controller.enqueueStart(startInput(flowVersionId, 'lost-claim'));
    const [claimed] = (await controller.claimEligible()).admissions;
    db.run(sql`
      CREATE TRIGGER lose_flow_start_dispatch_claim
      AFTER UPDATE OF status ON flow_runs
      WHEN OLD.status = 'pending' AND NEW.status = 'running'
      BEGIN
        UPDATE flow_run_admissions
        SET state = 'cancelled'
        WHERE flow_run_id = NEW.id AND state = 'claimed';
      END
    `);

    await expect(controller.beginDispatch(claimed.ticket)).rejects.toThrow(
      `Admission ${claimed.ticket} lost its dispatch claim`,
    );

    expect(db.select().from(flowRuns).where(eq(flowRuns.id, enqueued.run.id)).get()).toMatchObject({
      status: 'pending',
      startedAt: null,
    });
    expect(
      db.select().from(flowRunAdmissions).where(eq(flowRunAdmissions.ticket, claimed.ticket)).get(),
    ).toMatchObject({ state: 'claimed', startedAt: null, error: null });
  });
});
