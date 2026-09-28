import { eq } from 'drizzle-orm';
import { beforeEach, describe, expect, it } from 'vitest';
import {
  batchStageRuns,
  batchStages,
  flowRunAdmissions,
  flowRuns,
  flows,
  flowVersions,
  nodeRuns,
} from '../../../db/schema';
import { freshDb, type TestDb } from '../../../db/test-utils/fresh-db';
import { _resetFlowAdmissionControllerMutexForTests, FlowAdmissionController } from '../controller';
import { promoteTerminalResumeRun } from './resume-store';

type TerminalStatus = 'completed' | 'failed' | 'cancelled';

function seedRun(
  db: TestDb,
  id: string,
  status: TerminalStatus | 'paused' = 'failed',
  batchId: string | null = null,
): void {
  db.insert(flows)
    .values({ id: `flow-${id}`, name: 'Resume' })
    .run();
  db.insert(flowVersions)
    .values({
      id: `version-${id}`,
      flowId: `flow-${id}`,
      versionNumber: 1,
      graph: { nodes: [], edges: [] },
    })
    .run();
  db.insert(flowRuns)
    .values({
      id,
      flowVersionId: `version-${id}`,
      status,
      batchId,
      startedAt: new Date('2026-08-01T10:00:00Z'),
      completedAt: status === 'paused' ? null : new Date('2026-08-01T10:05:00Z'),
    })
    .run();
}

function seedNode(
  db: TestDb,
  flowRunId: string,
  id: string,
  options: { blockType?: string; parentFanOutNodeRunId?: string; laneIndex?: number } = {},
): void {
  db.insert(nodeRuns)
    .values({
      id,
      flowRunId,
      nodeId: id,
      blockType: options.blockType ?? 'agent',
      status: 'failed',
      parentFanOutNodeRunId: options.parentFanOutNodeRunId,
      laneIndex: options.laneIndex,
    })
    .run();
}

function admissionController(db: TestDb): FlowAdmissionController {
  return new FlowAdmissionController(db, async () => ({
    version: 1,
    queuePaused: false,
    concurrencyLimitEnabled: true,
    maxConcurrentRuns: 1,
  }));
}

describe('terminal Flow resume admission store', () => {
  beforeEach(() => _resetFlowAdmissionControllerMutexForTests());

  it('deduplicates one canonical target and rejects a different live intent', async () => {
    const db = freshDb();
    seedRun(db, 'dedupe');
    seedNode(db, 'dedupe', 'node-1');
    seedNode(db, 'dedupe', 'node-2');
    const controller = admissionController(db);

    const first = await controller.enqueueTerminalResume({
      flowRunId: 'dedupe',
      nodeRunId: 'node-1',
    });
    const duplicate = await controller.enqueueTerminalResume({
      flowRunId: 'dedupe',
      nodeRunId: 'node-1',
    });

    expect(first.created).toBe(true);
    expect(duplicate).toMatchObject({
      created: false,
      admission: { ticket: first.admission.ticket },
    });
    await expect(
      controller.enqueueTerminalResume({ flowRunId: 'dedupe', nodeRunId: 'node-2' }),
    ).rejects.toThrow(/different live admission/);
  });

  it('treats resume KIND as part of the target: a Retry (continuation) never coalesces with a deliberate Re-run', async () => {
    const db = freshDb();
    seedRun(db, 'kind-clash');
    seedNode(db, 'kind-clash', 'node-1');
    const controller = admissionController(db);

    const retry = await controller.enqueueTerminalResume({
      flowRunId: 'kind-clash',
      nodeRunId: 'node-1',
      continuation: true,
    });
    expect(retry.created).toBe(true);

    // Same kind re-request coalesces...
    const again = await controller.enqueueTerminalResume({
      flowRunId: 'kind-clash',
      nodeRunId: 'node-1',
      continuation: true,
    });
    expect(again).toMatchObject({ created: false, admission: { ticket: retry.admission.ticket } });

    // ...a different kind on the same node errs instead of silently winning/losing the race.
    await expect(
      controller.enqueueTerminalResume({ flowRunId: 'kind-clash', nodeRunId: 'node-1' }),
    ).rejects.toThrow(/different live admission/);
  });

  it.each(['completed', 'failed', 'cancelled'] as const)(
    'atomically promotes a %s run without changing its clocks or prior node attempt',
    async (status) => {
      const db = freshDb();
      const flowRunId = `promote-${status}`;
      const nodeRunId = `node-${status}`;
      seedRun(db, flowRunId, status);
      seedNode(db, flowRunId, nodeRunId);
      const controller = admissionController(db);
      const queued = await controller.enqueueTerminalResume({ flowRunId, nodeRunId });
      const [claimed] = (await controller.claimEligible()).admissions;
      const before = db.select().from(flowRuns).where(eq(flowRuns.id, flowRunId)).get();

      const attempts = await Promise.all([
        controller.beginDispatch(claimed.ticket),
        controller.beginDispatch(claimed.ticket),
      ]);

      expect(attempts.filter(Boolean)).toHaveLength(1);
      expect(await controller.getByTicket(queued.admission.ticket)).toMatchObject({
        state: 'active',
      });
      expect(db.select().from(flowRuns).where(eq(flowRuns.id, flowRunId)).get()).toMatchObject({
        status: 'running',
        startedAt: before?.startedAt,
        completedAt: before?.completedAt,
      });
      expect(db.select().from(nodeRuns).where(eq(nodeRuns.id, nodeRunId)).get()?.status).toBe(
        'failed',
      );
    },
  );

  it('fails a claimed resume if its canonical run or node changes before promotion', async () => {
    const db = freshDb();
    seedRun(db, 'stale-run');
    seedNode(db, 'stale-run', 'stale-node');
    const controller = admissionController(db);
    const stale = await controller.enqueueTerminalResume({
      flowRunId: 'stale-run',
      nodeRunId: 'stale-node',
    });
    const [staleClaim] = (await controller.claimEligible()).admissions;
    db.update(flowRuns).set({ status: 'running' }).where(eq(flowRuns.id, 'stale-run')).run();

    await expect(controller.beginDispatch(staleClaim.ticket)).resolves.toBeNull();
    expect(await controller.getByTicket(stale.admission.ticket)).toMatchObject({
      state: 'failed',
      error: expect.stringContaining('not eligible'),
    });

    seedRun(db, 'missing-node');
    seedNode(db, 'missing-node', 'deleted-node');
    const missing = await controller.enqueueTerminalResume({
      flowRunId: 'missing-node',
      nodeRunId: 'deleted-node',
    });
    const [missingClaim] = (await controller.claimEligible()).admissions;
    db.delete(nodeRuns).where(eq(nodeRuns.id, 'deleted-node')).run();

    await expect(controller.beginDispatch(missingClaim.ticket)).resolves.toBeNull();
    expect(await controller.getByTicket(missing.admission.ticket)).toMatchObject({
      state: 'failed',
      error: expect.stringContaining('Missing node run'),
    });
  });

  it.each(['dispatch', 'cancel'] as const)(
    'serializes cancellation against a claimed resume when %s enters first',
    async (first) => {
      const db = freshDb();
      const flowRunId = `race-${first}`;
      const nodeRunId = `node-${first}`;
      seedRun(db, flowRunId);
      seedNode(db, flowRunId, nodeRunId);
      const controller = admissionController(db);
      const queued = await controller.enqueueTerminalResume({ flowRunId, nodeRunId });
      const [claimed] = (await controller.claimEligible()).admissions;
      const operations =
        first === 'dispatch'
          ? [
              controller.beginDispatch(claimed.ticket),
              controller.cancelUndispatchedForRun(flowRunId),
            ]
          : [
              controller.cancelUndispatchedForRun(flowRunId),
              controller.beginDispatch(claimed.ticket),
            ];
      const [firstResult, secondResult] = await Promise.all(operations);
      const dispatched = first === 'dispatch' ? firstResult : secondResult;
      const cancelled = first === 'cancel' ? firstResult : secondResult;

      expect([dispatched, cancelled].filter(Boolean)).toHaveLength(1);
      expect(await controller.getByTicket(queued.admission.ticket)).toMatchObject({
        state: dispatched ? 'active' : 'cancelled',
      });
      expect(db.select().from(flowRuns).where(eq(flowRuns.id, flowRunId)).get()?.status).toBe(
        dispatched ? 'running' : 'failed',
      );
    },
  );

  it('rejects paused, fan-out, foreign-node, and releasing activations', async () => {
    const db = freshDb();
    seedRun(db, 'paused', 'paused');
    seedNode(db, 'paused', 'paused-node');
    seedRun(db, 'fan');
    seedNode(db, 'fan', 'fan-node', { blockType: 'fan_out' });
    seedRun(db, 'foreign');
    seedNode(db, 'foreign', 'foreign-node');
    seedRun(db, 'releasing');
    seedNode(db, 'releasing', 'releasing-node');
    const controller = admissionController(db);

    await expect(
      controller.enqueueTerminalResume({ flowRunId: 'paused', nodeRunId: 'paused-node' }),
    ).rejects.toThrow(/not eligible/);
    await expect(
      controller.enqueueTerminalResume({ flowRunId: 'fan', nodeRunId: 'fan-node' }),
    ).rejects.toThrow(/fan-out/);
    await expect(
      controller.enqueueTerminalResume({ flowRunId: 'paused', nodeRunId: 'foreign-node' }),
    ).rejects.toThrow(/does not belong/);

    const live = await controller.enqueueTerminalResume({
      flowRunId: 'releasing',
      nodeRunId: 'releasing-node',
    });
    const [claim] = (await controller.claimEligible()).admissions;
    await controller.beginDispatch(claim.ticket);
    await controller.beginRelease(live.admission.ticket);
    await expect(
      controller.enqueueTerminalResume({
        flowRunId: 'releasing',
        nodeRunId: 'releasing-node',
      }),
    ).rejects.toThrow(/different live admission/);
    expect(
      db.select().from(flowRunAdmissions).where(eq(flowRunAdmissions.flowRunId, 'releasing')).get(),
    ).toMatchObject({ state: 'releasing' });
  });

  it('admits a contained Fan Out node', async () => {
    const db = freshDb();
    seedRun(db, 'branch');
    seedNode(db, 'branch', 'branch-parent', { blockType: 'fan_out' });
    seedNode(db, 'branch', 'branch-node', {
      parentFanOutNodeRunId: 'branch-parent',
      laneIndex: 0,
    });

    await expect(
      admissionController(db).enqueueTerminalResume({
        flowRunId: 'branch',
        nodeRunId: 'branch-node',
      }),
    ).resolves.toMatchObject({ created: true });
  });
});

type BatchMemberFixture = {
  /** batch_stages.status the member's stage sits at. */
  stageStatus: string;
  /** batch_stage_runs.status of the member's own row. */
  memberStatus: string;
  /** graph.settings.maxBatchConcurrency; unset leaves the default per-stage ceiling. */
  limit?: number;
};

/** A batch member — flow run, node run, its stage and the stage run that links them. */
function seedBatchMember(db: TestDb, id: string, fixture: BatchMemberFixture) {
  seedRun(db, id, 'failed', `batch-${id}`);
  seedNode(db, id, `${id}-node`);
  if (fixture.limit !== undefined) {
    db.update(flowVersions)
      .set({ graph: { nodes: [], edges: [], settings: { maxBatchConcurrency: fixture.limit } } })
      .where(eq(flowVersions.id, `version-${id}`))
      .run();
  }
  db.insert(batchStages)
    .values({
      id: `stage-${id}`,
      batchId: `batch-${id}`,
      stageNumber: 1,
      status: fixture.stageStatus,
    })
    .run();
  db.insert(batchStageRuns)
    .values({
      id: `bsr-${id}`,
      stageId: `stage-${id}`,
      flowRunId: id,
      status: fixture.memberStatus,
    })
    .run();
  return {
    flowRunId: id,
    nodeRunId: `${id}-node`,
    stageId: `stage-${id}`,
    batchStageRunId: `bsr-${id}`,
  };
}

/** Another row occupying the same stage — the member it belongs to is irrelevant to slot accounting. */
function seedStageSibling(db: TestDb, stageId: string, id: string, status: string): void {
  db.insert(batchStageRuns).values({ id, stageId, status }).run();
}

const stageRunStatus = (db: TestDb, id: string): string | undefined =>
  db
    .select({ status: batchStageRuns.status })
    .from(batchStageRuns)
    .where(eq(batchStageRuns.id, id))
    .get()?.status;

const stageStatus = (db: TestDb, id: string): string | undefined =>
  db.select({ status: batchStages.status }).from(batchStages).where(eq(batchStages.id, id)).get()
    ?.status;

const runStatus = (db: TestDb, id: string): string | undefined =>
  db.select({ status: flowRuns.status }).from(flowRuns).where(eq(flowRuns.id, id)).get()?.status;

describe('batch members resume through the same terminal ticket', () => {
  beforeEach(() => _resetFlowAdmissionControllerMutexForTests());

  it('refuses a member its stage run, its stage, or its concurrency ceiling will not take back', async () => {
    const db = freshDb();
    const settled = seedBatchMember(db, 'settled-member', {
      stageStatus: 'running',
      memberStatus: 'completed',
    });
    const closed = seedBatchMember(db, 'closed-stage', {
      stageStatus: 'completed',
      memberStatus: 'failed',
    });
    const full = seedBatchMember(db, 'full-stage', {
      stageStatus: 'failed',
      memberStatus: 'failed',
      limit: 1,
    });
    seedStageSibling(db, full.stageId, 'bsr-full-stage-sibling', 'dispatched');
    seedRun(db, 'unlinked-member', 'failed', 'batch-unlinked');
    seedNode(db, 'unlinked-member', 'unlinked-node');
    const controller = admissionController(db);

    await expect(
      controller.enqueueTerminalResume({
        flowRunId: settled.flowRunId,
        nodeRunId: settled.nodeRunId,
      }),
    ).rejects.toThrow(/already settled in its stage/);
    await expect(
      controller.enqueueTerminalResume({
        flowRunId: 'unlinked-member',
        nodeRunId: 'unlinked-node',
      }),
    ).rejects.toThrow(/already settled in its stage/);
    await expect(
      controller.enqueueTerminalResume({
        flowRunId: closed.flowRunId,
        nodeRunId: closed.nodeRunId,
      }),
    ).rejects.toThrow(/stage already settled/);
    await expect(
      controller.enqueueTerminalResume({ flowRunId: full.flowRunId, nodeRunId: full.nodeRunId }),
    ).rejects.toThrow(/concurrency limit \(1 running\)/);
  });

  it('re-opens the run, its stage run and its stage in one dispatch, leaving siblings settled', async () => {
    const db = freshDb();
    const member = seedBatchMember(db, 'retry-member', {
      stageStatus: 'failed',
      memberStatus: 'failed',
    });
    // Retrying one member is not a verdict on the others: the stage's next settle must still
    // count this failure, so a failureThreshold-0 stage fails again unless the retry succeeds.
    seedStageSibling(db, member.stageId, 'bsr-retry-member-sibling', 'failed');
    const controller = admissionController(db);

    const queued = await controller.enqueueTerminalResume({
      flowRunId: member.flowRunId,
      nodeRunId: member.nodeRunId,
    });
    expect(queued).toMatchObject({ created: true, admission: { priorityClass: 'resume' } });

    const [claimed] = (await controller.claimEligible()).admissions;
    await expect(controller.beginDispatch(claimed.ticket)).resolves.toMatchObject({
      state: 'active',
    });

    expect(runStatus(db, member.flowRunId)).toBe('running');
    expect(stageRunStatus(db, member.batchStageRunId)).toBe('dispatched');
    expect(stageStatus(db, member.stageId)).toBe('running');
    expect(stageRunStatus(db, 'bsr-retry-member-sibling')).toBe('failed');
  });

  it('fails a claimed member whose stage filled up before dispatch, leaving it terminal and retryable', async () => {
    const db = freshDb();
    const member = seedBatchMember(db, 'late-full', {
      stageStatus: 'failed',
      memberStatus: 'failed',
      limit: 1,
    });
    const controller = admissionController(db);
    const queued = await controller.enqueueTerminalResume({
      flowRunId: member.flowRunId,
      nodeRunId: member.nodeRunId,
    });
    const [claimed] = (await controller.claimEligible()).admissions;
    seedStageSibling(db, member.stageId, 'bsr-late-full-sibling', 'dispatched');

    await expect(controller.beginDispatch(claimed.ticket)).resolves.toBeNull();

    expect(await controller.getByTicket(queued.admission.ticket)).toMatchObject({
      state: 'failed',
      error: expect.stringContaining('concurrency limit'),
    });
    expect(runStatus(db, member.flowRunId)).toBe('failed');
    expect(stageRunStatus(db, member.batchStageRunId)).toBe('failed');
    expect(stageStatus(db, member.stageId)).toBe('failed');
  });

  it('reserves the stage slot from enqueue, so the second of two concurrent Retries is refused while the first ticket is live', async () => {
    const db = freshDb();
    const first = seedBatchMember(db, 'twin-a', {
      stageStatus: 'failed',
      memberStatus: 'failed',
      limit: 1,
    });
    seedRun(db, 'twin-b', 'failed', 'batch-twin-a');
    seedNode(db, 'twin-b', 'twin-b-node');
    db.update(flowVersions)
      .set({ graph: { nodes: [], edges: [], settings: { maxBatchConcurrency: 1 } } })
      .where(eq(flowVersions.id, 'version-twin-b'))
      .run();
    db.insert(batchStageRuns)
      .values({ id: 'bsr-twin-b', stageId: first.stageId, flowRunId: 'twin-b', status: 'failed' })
      .run();
    const controller = admissionController(db);
    const second = { flowRunId: 'twin-b', nodeRunId: 'twin-b-node' };

    await controller.enqueueTerminalResume({
      flowRunId: first.flowRunId,
      nodeRunId: first.nodeRunId,
    });
    await expect(controller.enqueueTerminalResume(second)).rejects.toThrow(/concurrency limit/);

    const [claimed] = (await controller.claimEligible()).admissions;
    await expect(controller.beginDispatch(claimed.ticket)).resolves.toMatchObject({
      state: 'active',
    });
    expect(stageRunStatus(db, first.batchStageRunId)).toBe('dispatched');
    await expect(controller.enqueueTerminalResume(second)).rejects.toThrow(/concurrency limit/);

    db.update(batchStageRuns)
      .set({ status: 'completed' })
      .where(eq(batchStageRuns.id, first.batchStageRunId))
      .run();
    await expect(controller.enqueueTerminalResume(second)).resolves.toMatchObject({
      admission: expect.objectContaining({ state: 'queued' }),
    });
  });

  it('keeps a Work Queue removal off a claimed or promoted member, so no dispatched slot is stranded', async () => {
    const db = freshDb();
    const member = seedBatchMember(db, 'dequeue-member', {
      stageStatus: 'failed',
      memberStatus: 'failed',
    });
    const controller = admissionController(db);
    const queued = await controller.enqueueTerminalResume({
      flowRunId: member.flowRunId,
      nodeRunId: member.nodeRunId,
    });
    const [claimed] = (await controller.claimEligible()).admissions;

    // Removal is scoped to `queued` tickets: a claimed one already belongs to the scheduler.
    await expect(
      controller.cancelUndispatchedForRun(member.flowRunId, new Date(), {
        states: ['queued'],
        ticket: claimed.ticket,
      }),
    ).resolves.toBeNull();
    expect(runStatus(db, member.flowRunId)).toBe('failed');
    expect(stageRunStatus(db, member.batchStageRunId)).toBe('failed');

    await controller.beginDispatch(claimed.ticket);
    await expect(controller.cancelUndispatchedForRun(member.flowRunId)).resolves.toBeNull();

    // Only cancelFlowRun reaches a promoted member, and its run_cancelled event settles the stage.
    expect(await controller.getByTicket(queued.admission.ticket)).toMatchObject({
      state: 'active',
    });
    expect(stageRunStatus(db, member.batchStageRunId)).toBe('dispatched');
    expect(stageStatus(db, member.stageId)).toBe('running');
  });
  it('undoes the run promotion when the stage run CAS is lost, so a failed ticket never strands a running run', async () => {
    const db = freshDb();
    const member = seedBatchMember(db, 'lost-cas', {
      stageStatus: 'failed',
      memberStatus: 'failed',
    });
    const { admission } = await admissionController(db).enqueueTerminalResume({
      flowRunId: member.flowRunId,
      nodeRunId: member.nodeRunId,
    });
    db.update(batchStageRuns)
      .set({ status: 'completed' })
      .where(eq(batchStageRuns.id, member.batchStageRunId))
      .run();

    expect(
      promoteTerminalResumeRun(db, admission, 'failed', {
        batchStageRunId: member.batchStageRunId,
        stageId: member.stageId,
        limit: 5,
      }),
    ).toContain('lost its resume dispatch promotion');
    expect(runStatus(db, member.flowRunId)).toBe('failed');
    expect(stageStatus(db, member.stageId)).toBe('failed');
  });
});
