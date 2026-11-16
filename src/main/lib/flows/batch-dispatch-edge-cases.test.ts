import { eq } from 'drizzle-orm';
import { beforeEach, describe, expect, it, vi } from 'vitest';

// Edge cases for batch dispatch beyond the happy paths in batch-dispatch.test.ts:
// concurrent settle/promote races (multi-pane), terminal-status downgrade
// protection, threshold timing with in-flight stragglers, ceiling clamping,
// dispatch-time failures, crash-replay, and paused-run link recovery.

const { mocks } = vi.hoisted(() => ({
  mocks: {
    startFlowRun: vi.fn(),
    getDatabase: vi.fn(),
  },
}));

vi.mock('../db', () => ({ getDatabase: mocks.getDatabase }));
vi.mock('./start', () => ({ startFlowRun: mocks.startFlowRun }));

import type { FlowExecutionEvent } from '../../../shared/types/flow';
import { listRunsForStage, settleStageRunFromRun } from '../db/repos/batch-stage-runs';
import { getBatchStage, settleStageIfQuiescent } from '../db/repos/batch-stages';
import { batchStageRuns, batchStages, flowRunAdmissions, flowRuns } from '../db/schema';
import { freshDb, type TestDb } from '../db/test-utils/fresh-db';
import { setFlowAdmissionLifecycleHooks } from './admission/activity';
import { StageRunMovedError } from './admission/batch-promotion';
import { FlowAdmissionController } from './admission/controller';
import { _setFlowAdmissionControllerForTests, drainFlowAdmissions } from './admission/runtime';
import {
  onBatchRunTerminal,
  recoverBatchStages,
  startBatchAdvanceListener,
  startFlowBatchLocal,
} from './batch-dispatch';
import { reassignStageRunLocal } from './batch-mutations';
import {
  makeStartFlowRunMock,
  runId,
  seedBatchFlow,
  seedBatchStage,
  setRunStatus,
} from './batch-test-factories';
import { flowEventBus, subscribeFlowEvents } from './events';
import { defineFlowBatchStages } from './mcp-cloud-shim';

let db: TestDb;
let flowId: string;
let versionId: string;

const BATCH = 'batch-edge';

async function seedFlow(settings: Record<string, unknown> = {}) {
  ({ flowId, versionId } = await seedBatchFlow(db, settings));
}

const seedStage = (input: Parameters<typeof seedBatchStage>[2]) => seedBatchStage(db, BATCH, input);

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

describe('concurrency races (multi-pane)', () => {
  it('promotes the successor exactly once when sibling runs terminalize concurrently', async () => {
    const root = await seedStage({ stageNumber: 1, runCount: 2 });
    const next = await seedStage({ stageNumber: 2, runCount: 1, dependsOnStageIds: [root.id] });
    await startFlowBatchLocal(flowId, BATCH);
    const dispatched = await listRunsForStage(db, root.id);
    await Promise.all(
      dispatched.map((bsr) =>
        db
          .update(flowRuns)
          .set({ status: 'completed' })
          .where(eq(flowRuns.id, runId(bsr))),
      ),
    );

    // Both terminal events race into settleStage/promoteSuccessors.
    await Promise.all(dispatched.map((bsr) => onBatchRunTerminal(runId(bsr))));

    expect((await getBatchStage(db, root.id))?.status).toBe('completed');
    expect((await getBatchStage(db, next.id))?.status).toBe('running');
    // 2 root runs + exactly 1 successor run — a lost CAS race would double-spawn.
    expect(mocks.startFlowRun).toHaveBeenCalledTimes(3);
    const nextRuns = await listRunsForStage(db, next.id);
    expect(nextRuns.filter((r) => r.status === 'dispatched')).toHaveLength(1);
  });

  it('dispatches each BSR exactly once when startBatch is called concurrently from two panes', async () => {
    await seedStage({ stageNumber: 1, runCount: 3 });

    const [a, b] = await Promise.all([
      startFlowBatchLocal(flowId, BATCH),
      startFlowBatchLocal(flowId, BATCH),
    ]);

    // The stage CAS lets exactly one caller win the root promotion.
    expect(mocks.startFlowRun).toHaveBeenCalledTimes(3);
    expect((a.totalEnqueued ?? 0) + (b.totalEnqueued ?? 0)).toBe(3);
    expect([a.started, b.started].filter(Boolean)).toHaveLength(1);
  });

  it('never downgrades a terminal BSR on a duplicate/conflicting terminal event', async () => {
    const root = await seedStage({ stageNumber: 1, runCount: 1, failureThreshold: 0 });
    await startFlowBatchLocal(flowId, BATCH);
    const [bsr] = await listRunsForStage(db, root.id);

    await finishRun(runId(bsr), 'completed');
    // Stale second event (e.g. a cancel emitted after the watcher already settled).
    await onBatchRunTerminal(runId(bsr));

    expect((await listRunsForStage(db, root.id))[0].status).toBe('completed');
    expect((await getBatchStage(db, root.id))?.status).toBe('completed');
  });
});

describe('failure threshold timing', () => {
  it('lets in-flight siblings finish after a failure, then fails the stage without promoting', async () => {
    const root = await seedStage({ stageNumber: 1, runCount: 2, failureThreshold: 0 });
    const next = await seedStage({ stageNumber: 2, runCount: 1, dependsOnStageIds: [root.id] });
    await startFlowBatchLocal(flowId, BATCH);
    const [bsr1, bsr2] = await listRunsForStage(db, root.id);

    await finishRun(runId(bsr1), 'failed');
    // Threshold is evaluated only once every run is terminal — the straggler keeps running.
    expect((await getBatchStage(db, root.id))?.status).toBe('running');

    await finishRun(runId(bsr2), 'completed');
    expect((await getBatchStage(db, root.id))?.status).toBe('failed');
    expect((await getBatchStage(db, next.id))?.status).toBe('cancelled');
    expect(mocks.startFlowRun).toHaveBeenCalledTimes(2); // successor never spawned
  });
});

describe('dispatch-time failures and clamps', () => {
  it('clamps maxBatchConcurrency above the built-in ceiling to 5', async () => {
    await seedFlow({ maxBatchConcurrency: 20 });
    const stage = await seedStage({ stageNumber: 1, runCount: 7 });

    const result = await startFlowBatchLocal(flowId, BATCH);

    expect(result.totalEnqueued).toBe(5);
    const runs = await listRunsForStage(db, stage.id);
    expect(runs.filter((r) => r.status === 'pending')).toHaveLength(2);
  });

  it('fails BSRs and the stage when startFlowRun rejects (e.g. flow disabled mid-batch)', async () => {
    mocks.startFlowRun.mockRejectedValue(new Error('Flow is disabled'));
    const root = await seedStage({ stageNumber: 1, runCount: 2, failureThreshold: 0 });
    const next = await seedStage({ stageNumber: 2, runCount: 1, dependsOnStageIds: [root.id] });

    const result = await startFlowBatchLocal(flowId, BATCH);

    expect(result.started).toBe(true); // root was promoted…
    expect(result.totalEnqueued).toBe(0); // …but nothing actually spawned — honest count
    const runs = await listRunsForStage(db, root.id);
    expect(runs.every((r) => r.status === 'failed')).toBe(true);
    expect((await getBatchStage(db, root.id))?.status).toBe('failed');
    expect((await getBatchStage(db, next.id))?.status).toBe('cancelled');
  });

  it('settles a BSR whose dispatch replays an already-terminal run (crash replay)', async () => {
    const root = await seedStage({ stageNumber: 1, runCount: 1, failureThreshold: 0 });
    mocks.startFlowRun.mockImplementation(async (input: { idempotencyKey?: string | null }) => {
      const [run] = await db
        .insert(flowRuns)
        .values({
          flowVersionId: versionId,
          status: 'completed',
          idempotencyKey: input.idempotencyKey ?? null,
          batchId: BATCH,
        })
        .returning();
      return { run, version: undefined, isReplay: true };
    });

    const result = await startFlowBatchLocal(flowId, BATCH);

    // No terminal event will ever fire for a replayed finished run — the
    // dispatch loop itself must settle the BSR and the stage.
    expect(result.totalEnqueued).toBe(0);
    expect((await listRunsForStage(db, root.id))[0].status).toBe('completed');
    expect((await getBatchStage(db, root.id))?.status).toBe('completed');
  });
});

describe('recovery with still-active runs', () => {
  it('restores a lost BSR↔run link for a paused agent run without settling the stage', async () => {
    const root = await seedStage({ stageNumber: 1, runCount: 1 });
    await startFlowBatchLocal(flowId, BATCH);
    const [bsr] = await listRunsForStage(db, root.id);
    // Restart scenario: run survives paused (agent mid-session), link UPDATE was lost.
    await db
      .update(flowRuns)
      .set({ status: 'paused' })
      .where(eq(flowRuns.id, runId(bsr)));
    await db.update(batchStageRuns).set({ flowRunId: null }).where(eq(batchStageRuns.id, bsr.id));

    await recoverBatchStages();

    const [recovered] = await listRunsForStage(db, root.id);
    expect(recovered.flowRunId).toBe(bsr.flowRunId); // re-linked via idempotencyKey
    expect(recovered.status).toBe('dispatched'); // NOT settled — run still active
    expect((await getBatchStage(db, root.id))?.status).toBe('running');
  });
});

describe('batch_completed emission', () => {
  // The emitter's debounce map is module-level and keyed by batchId; real
  // batch ids are unique, so each test here uses its own id rather than the
  // shared BATCH const (which earlier suites have already terminalized).
  let emitBatch: string;
  let seq = 0;
  beforeEach(() => {
    emitBatch = `batch-emit-${seq++}`;
  });

  const seedEmitStage = (input: Parameters<typeof seedBatchStage>[2]) =>
    seedBatchStage(db, emitBatch, input);

  /** Collect batch_completed events for the duration of one test. */
  function collectBatchCompleted() {
    const events: FlowExecutionEvent[] = [];
    const unsubscribe = subscribeFlowEvents((e) => {
      if (e.eventType === 'batch_completed') events.push(e);
    });
    return { events, unsubscribe };
  }

  it('emits once when the last member of the last stage terminalizes', async () => {
    const { events, unsubscribe } = collectBatchCompleted();
    try {
      const root = await seedEmitStage({ stageNumber: 1, runCount: 2 });
      await startFlowBatchLocal(flowId, emitBatch);
      const [a, b] = await listRunsForStage(db, root.id);

      await finishRun(runId(a), 'completed');
      expect(events).toHaveLength(0); // batch not terminal yet

      await finishRun(runId(b), 'completed');
      expect(events).toHaveLength(1);
      expect(events[0]).toMatchObject({ batchId: emitBatch, runStatus: 'completed', flowId });
      expect(events[0].flowRunId).toBeUndefined();
    } finally {
      unsubscribe();
    }
  });

  it('emits a failed verdict when the threshold fails the stage and cascade-cancels the rest', async () => {
    const { events, unsubscribe } = collectBatchCompleted();
    try {
      const root = await seedEmitStage({ stageNumber: 1, runCount: 1, failureThreshold: 0 });
      await seedEmitStage({ stageNumber: 2, runCount: 1, dependsOnStageIds: [root.id] });
      await startFlowBatchLocal(flowId, emitBatch);
      const [a] = await listRunsForStage(db, root.id);

      // Root fails over threshold → successor is cascade-cancelled → batch is
      // all-terminal via the cancel exit, and must still announce itself.
      await finishRun(runId(a), 'failed');
      expect(events).toHaveLength(1);
      expect(events[0]).toMatchObject({ batchId: emitBatch, runStatus: 'failed' });
    } finally {
      unsubscribe();
    }
  });

  it('emits exactly once when two parallel roots terminalize concurrently', async () => {
    const { events, unsubscribe } = collectBatchCompleted();
    try {
      const rootA = await seedEmitStage({ stageNumber: 1, runCount: 1 });
      const rootB = await seedEmitStage({ stageNumber: 2, runCount: 1 });
      await startFlowBatchLocal(flowId, emitBatch);
      const [a] = await listRunsForStage(db, rootA.id);
      const [b] = await listRunsForStage(db, rootB.id);

      // Both settle-winners can observe the all-terminal batch in the same
      // tick — the debounce must collapse them to one landing.
      await Promise.all([finishRun(runId(a), 'completed'), finishRun(runId(b), 'completed')]);
      expect(events).toHaveLength(1);
    } finally {
      unsubscribe();
    }
  });

  it('emits exactly once when an empty successor settles nested inside its promoter', async () => {
    const { events, unsubscribe } = collectBatchCompleted();
    try {
      const root = await seedEmitStage({ stageNumber: 1, runCount: 1 });
      // Zero-run successor: promoteOneSuccessor settles it SYNCHRONOUSLY
      // inside the root's own finalize — the nested double-observe case.
      await seedEmitStage({ stageNumber: 2, runCount: 0, dependsOnStageIds: [root.id] });
      await startFlowBatchLocal(flowId, emitBatch);
      const [a] = await listRunsForStage(db, root.id);

      await finishRun(runId(a), 'completed');
      expect(events).toHaveLength(1);
      expect(events[0]).toMatchObject({ batchId: emitBatch, runStatus: 'completed' });
    } finally {
      unsubscribe();
    }
  });

  it('re-emits when a rerun re-terminalizes IMMEDIATELY (transition-keyed, not time-debounced)', async () => {
    const { events, unsubscribe } = collectBatchCompleted();
    try {
      const root = await seedEmitStage({ stageNumber: 1, runCount: 1 });
      await startFlowBatchLocal(flowId, emitBatch);
      const [a] = await listRunsForStage(db, root.id);

      await finishRun(runId(a), 'completed');
      expect(events).toHaveLength(1);

      // An instant rerun (no wall-clock gap at all) re-opens the stage and
      // re-terminalizes it — the landing must fire again.
      await db.update(batchStages).set({ status: 'running' }).where(eq(batchStages.id, root.id));
      await db
        .update(batchStageRuns)
        .set({ status: 'dispatched' })
        .where(eq(batchStageRuns.id, a.id));
      await finishRun(runId(a), 'completed');
      expect(events).toHaveLength(2);
    } finally {
      unsubscribe();
    }
  });
});

// Only onBatchRunTerminal's completed/failed/cancelled event moves a BSR: a paused run is invisible
// to stage bookkeeping and keeps its slot until it terminates, like any in-flight member.
describe('a parked (needs_attention) member is not a terminal event to the stage', () => {
  it('keeps its BSR dispatched and its slot occupied while paused, then settles normally', async () => {
    await seedFlow({ maxBatchConcurrency: 1 });
    const root = await seedStage({ stageNumber: 1, runCount: 2 });
    await startFlowBatchLocal(flowId, BATCH);
    const dispatched = (await listRunsForStage(db, root.id)).find((r) => r.status === 'dispatched');
    if (!dispatched) throw new Error('expected one dispatched BSR under a concurrency limit of 1');

    // The driving task parks needs_attention on a resumable interruption — its flow_run pauses,
    // which is not a batch-terminal event.
    await setRunStatus(db, runId(dispatched), 'paused');

    const afterPark = await listRunsForStage(db, root.id);
    expect(afterPark.find((r) => r.id === dispatched.id)?.status).toBe('dispatched');
    expect(afterPark.filter((r) => r.status === 'pending')).toHaveLength(1); // sibling still waits
    expect((await getBatchStage(db, root.id))?.status).toBe('running');

    // The member later finishes for real — settlement is identical to an un-parked member: its
    // BSR completes and the freed slot dispatches the waiting sibling.
    await finishRun(runId(dispatched), 'completed');

    const settled = await listRunsForStage(db, root.id);
    expect(settled.find((r) => r.id === dispatched.id)?.status).toBe('completed');
    expect(settled.filter((r) => r.status === 'dispatched')).toHaveLength(1);
    expect((await getBatchStage(db, root.id))?.status).toBe('running');
  });
});

/**
 * Stand-in for the terminal-resume promotion admission owns: retrying a settled member re-opens its
 * flow_run, its BSR and its stage together, so the stage settles again on the retry's verdict.
 */
async function retryFailedMember(stageId: string, bsrId: string, flowRunId: string): Promise<void> {
  await db.update(batchStages).set({ status: 'running' }).where(eq(batchStages.id, stageId));
  await db.update(batchStageRuns).set({ status: 'dispatched' }).where(eq(batchStageRuns.id, bsrId));
  await db.update(flowRuns).set({ status: 'running' }).where(eq(flowRuns.id, flowRunId));
}

describe('retrying a member of a failed stage', () => {
  it('reopens a cascade-cancelled successor once a retried dependency re-completes', async () => {
    const root = await seedStage({ stageNumber: 1, runCount: 2, failureThreshold: 0 });
    const next = await seedStage({ stageNumber: 2, runCount: 1, dependsOnStageIds: [root.id] });
    await startFlowBatchLocal(flowId, BATCH);
    const [bsr1, bsr2] = await listRunsForStage(db, root.id);

    await finishRun(runId(bsr1), 'failed');
    await finishRun(runId(bsr2), 'completed');
    expect((await getBatchStage(db, root.id))?.status).toBe('failed');
    expect((await getBatchStage(db, next.id))?.status).toBe('cancelled');

    // The user retries the failed member and it passes, so the stage completes after all —
    // the successor the cascade killed must come back with it.
    await retryFailedMember(root.id, bsr1.id, runId(bsr1));
    await finishRun(runId(bsr1), 'completed');

    expect((await getBatchStage(db, root.id))?.status).toBe('completed');
    expect((await getBatchStage(db, next.id))?.status).toBe('running');
    const nextRuns = await listRunsForStage(db, next.id);
    expect(nextRuns.filter((r) => r.status === 'dispatched')).toHaveLength(1);
    expect(mocks.startFlowRun).toHaveBeenCalledTimes(3); // 2 members + the revived successor

    // The revived successor is a first-class member again: it settles its own stage.
    await finishRun(runId(nextRuns[0]), 'completed');
    expect((await getBatchStage(db, next.id))?.status).toBe('completed');
  });

  it('leaves an orphaned successor cancelled when a sibling dep is still failed', async () => {
    const depA = await seedStage({ stageNumber: 1, runCount: 1, failureThreshold: 0 });
    const depB = await seedStage({ stageNumber: 2, runCount: 1, failureThreshold: 0 });
    const next = await seedStage({
      stageNumber: 3,
      runCount: 1,
      dependsOnStageIds: [depA.id, depB.id],
    });
    await startFlowBatchLocal(flowId, BATCH);
    const [bsrA] = await listRunsForStage(db, depA.id);
    const [bsrB] = await listRunsForStage(db, depB.id);

    await finishRun(runId(bsrA), 'failed');
    await finishRun(runId(bsrB), 'failed');
    expect((await getBatchStage(db, next.id))?.status).toBe('cancelled');

    // Only one of the two failed dependencies is retried — the successor still can never run,
    // so it must stay cancelled rather than churn back to pending.
    await retryFailedMember(depB.id, bsrB.id, runId(bsrB));
    await finishRun(runId(bsrB), 'completed');

    expect((await getBatchStage(db, depB.id))?.status).toBe('completed');
    expect((await getBatchStage(db, next.id))?.status).toBe('cancelled');
    const nextRuns = await listRunsForStage(db, next.id);
    expect(nextRuns.every((r) => r.status === 'cancelled')).toBe(true);
    expect(mocks.startFlowRun).toHaveBeenCalledTimes(2); // successor never spawned
  });
});

describe('stage concurrency against a racing resume promotion', () => {
  it('stops dispatching once a retried member claims the last slot mid-loop', async () => {
    await seedFlow({ maxBatchConcurrency: 2 });
    const root = await seedStage({ stageNumber: 1, runCount: 3 });
    const [retried] = await listRunsForStage(db, root.id);
    // A member that already settled in this stage, about to be re-admitted by the user's Retry.
    await db
      .update(batchStageRuns)
      .set({ status: 'failed' })
      .where(eq(batchStageRuns.id, retried.id));

    const dispatchRun = makeStartFlowRunMock(db, () => versionId);
    mocks.startFlowRun.mockImplementation(async (input: Parameters<typeof dispatchRun>[0]) => {
      const started = await dispatchRun(input);
      // The terminal-resume promotion commits in its own transaction while this dispatch awaits.
      await db
        .update(batchStageRuns)
        .set({ status: 'dispatched' })
        .where(eq(batchStageRuns.id, retried.id));
      return started;
    });

    await startFlowBatchLocal(flowId, BATCH);

    // Two slots, two occupants: the retried member plus ONE freshly dispatched sibling. A budget
    // sliced before the loop would have spent both slots on siblings and overfilled the stage.
    const runs = await listRunsForStage(db, root.id);
    expect(runs.filter((r) => r.status === 'dispatched')).toHaveLength(2);
    expect(runs.filter((r) => r.status === 'pending')).toHaveLength(1);
    expect(mocks.startFlowRun).toHaveBeenCalledTimes(1);
  });
});

describe('finalize recounts inside its own transaction', () => {
  it('keeps a stage running when a Retry re-admitted a member after the settle read', async () => {
    const stage = await seedStage({ stageNumber: 1, runCount: 2, failureThreshold: 0 });
    await startFlowBatchLocal(flowId, BATCH);
    const [bsr1, bsr2] = await listRunsForStage(db, stage.id);
    await finishRun(runId(bsr1), 'failed');
    await finishRun(runId(bsr2), 'completed');
    // The stage settled on bsr1's failure; a Retry now re-admits it while a stale settle could still
    // be in flight: with bsr1 dispatched again, no snapshot may finalize the stage.
    await db.update(batchStages).set({ status: 'running' }).where(eq(batchStages.id, stage.id));
    await db
      .update(batchStageRuns)
      .set({ status: 'dispatched' })
      .where(eq(batchStageRuns.id, bsr1.id));
    expect(settleStageIfQuiescent(db, { id: stage.id, failureThreshold: 0 })).toBeNull();
    expect((await getBatchStage(db, stage.id))?.status).toBe('running');

    await finishRun(runId(bsr1), 'completed');
    expect((await getBatchStage(db, stage.id))?.status).toBe('completed');
  });

  it('settles an all-terminal stage with the threshold applied to the live counts', async () => {
    const stage = await seedStage({ stageNumber: 1, runCount: 2, failureThreshold: 0 });
    await startFlowBatchLocal(flowId, BATCH);
    const [bsr1, bsr2] = await listRunsForStage(db, stage.id);
    await db.update(batchStageRuns).set({ status: 'failed' }).where(eq(batchStageRuns.id, bsr1.id));
    await db
      .update(batchStageRuns)
      .set({ status: 'completed' })
      .where(eq(batchStageRuns.id, bsr2.id));
    expect(settleStageIfQuiescent(db, { id: stage.id, failureThreshold: 0 })).toEqual({
      failed: true,
      failedCount: 1,
    });
    expect((await getBatchStage(db, stage.id))?.status).toBe('failed');
    expect(settleStageIfQuiescent(db, { id: stage.id, failureThreshold: 0 })).toBeNull();
  });
});

/** A member's admission ticket, as the admission store would have written it. */
function seedAdmission(
  flowRunId: string,
  priorityClass: 'start' | 'resume',
  state: 'queued' | 'claimed' | 'active',
): void {
  db.insert(flowRunAdmissions)
    .values({
      flowRunId,
      state,
      priorityClass,
      intentVersion: 1,
      intentJson: {
        version: 1,
        action: priorityClass === 'start' ? 'start' : 'resume',
        flow_run_id: flowRunId,
      },
    })
    .run();
}

/** The promotion transaction of a queued Retry: ticket active, run running, member dispatched again. */
async function promoteRetry(bsrId: string, flowRunId: string): Promise<void> {
  await db
    .update(flowRunAdmissions)
    .set({ state: 'active' })
    .where(eq(flowRunAdmissions.flowRunId, flowRunId));
  await db.update(flowRuns).set({ status: 'running' }).where(eq(flowRuns.id, flowRunId));
  await db.update(batchStageRuns).set({ status: 'dispatched' }).where(eq(batchStageRuns.id, bsrId));
}

describe('a stage waits for a member whose Retry is still queued', () => {
  it('settles on a normal completion while the member still holds its own slot', async () => {
    const stage = await seedStage({ stageNumber: 1, runCount: 1 });
    await startFlowBatchLocal(flowId, BATCH);
    const [bsr] = await listRunsForStage(db, stage.id);
    // The run's own ticket is released only after its terminal event has been handled.
    seedAdmission(runId(bsr), 'start', 'active');

    await finishRun(runId(bsr), 'completed');

    expect((await getBatchStage(db, stage.id))?.status).toBe('completed');
  });

  it('ignores a cancel event that a Retry has already overtaken', async () => {
    const root = await seedStage({ stageNumber: 1, runCount: 1, failureThreshold: 0 });
    const next = await seedStage({ stageNumber: 2, runCount: 1, dependsOnStageIds: [root.id] });
    await startFlowBatchLocal(flowId, BATCH);
    const [bsr] = await listRunsForStage(db, root.id);
    // The Cancel committed, then the user's Retry was queued, and only now does the event arrive.
    await setRunStatus(db, runId(bsr), 'cancelled');
    await db.update(batchStageRuns).set({ status: 'failed' }).where(eq(batchStageRuns.id, bsr.id));
    seedAdmission(runId(bsr), 'resume', 'queued');

    await onBatchRunTerminal(runId(bsr));

    expect((await getBatchStage(db, root.id))?.status).toBe('running');
    // Settling would have cascade-cancelled the successor the Retry can still unblock.
    expect((await getBatchStage(db, next.id))?.status).toBe('pending');
  });

  it('stays running when a sibling finishes while a Retry is queued', async () => {
    const stage = await seedStage({ stageNumber: 1, runCount: 2, failureThreshold: 0 });
    await startFlowBatchLocal(flowId, BATCH);
    const [bsr1, bsr2] = await listRunsForStage(db, stage.id);
    await finishRun(runId(bsr1), 'failed');
    seedAdmission(runId(bsr1), 'resume', 'queued');

    await finishRun(runId(bsr2), 'completed');

    expect((await getBatchStage(db, stage.id))?.status).toBe('running');
  });

  it('settles from the Retry once it has run, not from the event it overtook', async () => {
    const stage = await seedStage({ stageNumber: 1, runCount: 1, failureThreshold: 0 });
    await startFlowBatchLocal(flowId, BATCH);
    const [bsr] = await listRunsForStage(db, stage.id);
    await setRunStatus(db, runId(bsr), 'cancelled');
    await db.update(batchStageRuns).set({ status: 'failed' }).where(eq(batchStageRuns.id, bsr.id));
    seedAdmission(runId(bsr), 'resume', 'queued');
    await promoteRetry(bsr.id, runId(bsr));

    // The overtaken cancel event lands on a member that is running again.
    await onBatchRunTerminal(runId(bsr));
    expect((await listRunsForStage(db, stage.id))[0].status).toBe('dispatched');
    expect((await getBatchStage(db, stage.id))?.status).toBe('running');

    await finishRun(runId(bsr), 'completed');
    expect((await listRunsForStage(db, stage.id))[0].status).toBe('completed');
    expect((await getBatchStage(db, stage.id))?.status).toBe('completed');
  });

  it('settles once a queued Retry is dropped without ever running', async () => {
    const stage = await seedStage({ stageNumber: 1, runCount: 1, failureThreshold: 0 });
    await startFlowBatchLocal(flowId, BATCH);
    const [bsr] = await listRunsForStage(db, stage.id);
    await setRunStatus(db, runId(bsr), 'failed');
    await db.update(batchStageRuns).set({ status: 'failed' }).where(eq(batchStageRuns.id, bsr.id));
    seedAdmission(runId(bsr), 'resume', 'queued');
    await onBatchRunTerminal(runId(bsr));
    expect((await getBatchStage(db, stage.id))?.status).toBe('running');

    await db
      .update(flowRunAdmissions)
      .set({ state: 'cancelled' })
      .where(eq(flowRunAdmissions.flowRunId, runId(bsr)));
    await onBatchRunTerminal(runId(bsr));

    expect((await getBatchStage(db, stage.id))?.status).toBe('failed');
  });

  it('settles at the next startup sweep once a Retry claim left by a dead process is dropped', async () => {
    const stage = await seedStage({ stageNumber: 1, runCount: 1, failureThreshold: 0 });
    await startFlowBatchLocal(flowId, BATCH);
    const [bsr] = await listRunsForStage(db, stage.id);
    await setRunStatus(db, runId(bsr), 'failed');
    await db.update(batchStageRuns).set({ status: 'failed' }).where(eq(batchStageRuns.id, bsr.id));
    seedAdmission(runId(bsr), 'resume', 'claimed');

    await recoverBatchStages();
    expect((await getBatchStage(db, stage.id))?.status).toBe('running');

    // Admission recovery fails the stranded claim; the sweep that follows it settles the stage.
    await db
      .update(flowRunAdmissions)
      .set({ state: 'failed' })
      .where(eq(flowRunAdmissions.flowRunId, runId(bsr)));
    await recoverBatchStages();

    expect((await getBatchStage(db, stage.id))?.status).toBe('failed');
  });

  it('settles once a queued Retry is refused at claim', async () => {
    const stage = await seedStage({ stageNumber: 1, runCount: 1, failureThreshold: 0 });
    await startFlowBatchLocal(flowId, BATCH);
    const [bsr] = await listRunsForStage(db, stage.id);
    await finishRun(runId(bsr), 'failed');
    await db.update(batchStages).set({ status: 'running' }).where(eq(batchStages.id, stage.id));
    // The node run this Retry points at is gone, so claim validation refuses the ticket.
    db.insert(flowRunAdmissions)
      .values({
        flowRunId: runId(bsr),
        state: 'queued',
        priorityClass: 'resume',
        intentVersion: 1,
        intentJson: {
          version: 1,
          action: 'resume',
          flow_run_id: runId(bsr),
          node_run_id: 'missing-node-run',
        },
      })
      .run();
    _setFlowAdmissionControllerForTests(new FlowAdmissionController(db));

    await drainFlowAdmissions();
    _setFlowAdmissionControllerForTests(null);

    const [ticket] = db.select().from(flowRunAdmissions).all();
    expect(ticket.state).toBe('failed');
    expect((await getBatchStage(db, stage.id))?.status).toBe('failed');
  });

  it('leaves a member alone when its run is running again by the time of the write', async () => {
    const stage = await seedStage({ stageNumber: 1, runCount: 1 });
    await startFlowBatchLocal(flowId, BATCH);
    const [bsr] = await listRunsForStage(db, stage.id);

    // The caller saw a terminal run; a Retry promotion committed before this write.
    settleStageRunFromRun(db, bsr.id, runId(bsr));
    expect((await listRunsForStage(db, stage.id))[0].status).toBe('dispatched');

    await setRunStatus(db, runId(bsr), 'cancelled');
    settleStageRunFromRun(db, bsr.id, runId(bsr));
    expect((await listRunsForStage(db, stage.id))[0].status).toBe('failed');
  });

  it('does not hold a stage open for a Retry queued in a different stage', async () => {
    const stageA = await seedStage({ stageNumber: 1, runCount: 1, failureThreshold: 0 });
    const stageB = await seedStage({ stageNumber: 2, runCount: 1, failureThreshold: 0 });
    await startFlowBatchLocal(flowId, BATCH);
    const [bsrA] = await listRunsForStage(db, stageA.id);
    const [bsrB] = await listRunsForStage(db, stageB.id);
    await setRunStatus(db, runId(bsrB), 'failed');
    await db.update(batchStageRuns).set({ status: 'failed' }).where(eq(batchStageRuns.id, bsrB.id));
    seedAdmission(runId(bsrB), 'resume', 'queued');

    await finishRun(runId(bsrA), 'completed');

    expect((await getBatchStage(db, stageA.id))?.status).toBe('completed');
    expect((await getBatchStage(db, stageB.id))?.status).toBe('running');
  });

  it('stays running when both members race in while one has a queued Retry', async () => {
    const root = await seedStage({ stageNumber: 1, runCount: 2, failureThreshold: 0 });
    const next = await seedStage({ stageNumber: 2, runCount: 1, dependsOnStageIds: [root.id] });
    await startFlowBatchLocal(flowId, BATCH);
    const [bsr1, bsr2] = await listRunsForStage(db, root.id);
    await setRunStatus(db, runId(bsr1), 'cancelled');
    await setRunStatus(db, runId(bsr2), 'completed');
    seedAdmission(runId(bsr1), 'resume', 'queued');

    // The overtaken cancel event and the sibling's completion are handled in the same tick.
    await Promise.all([onBatchRunTerminal(runId(bsr1)), onBatchRunTerminal(runId(bsr2))]);
    expect((await getBatchStage(db, root.id))?.status).toBe('running');
    expect((await getBatchStage(db, next.id))?.status).toBe('pending');

    await promoteRetry(bsr1.id, runId(bsr1));
    await finishRun(runId(bsr1), 'completed');
    expect((await getBatchStage(db, root.id))?.status).toBe('completed');
    expect((await getBatchStage(db, next.id))?.status).toBe('running');
    expect(mocks.startFlowRun).toHaveBeenCalledTimes(3); // 2 members + the successor, once
  });

  it('settles from the run row when the delivered event names a different outcome', async () => {
    setFlowAdmissionLifecycleHooks({
      reconcile: vi.fn(async () => {}),
      reconcileTicket: vi.fn(async () => {}),
      requestRelease: vi.fn(async () => {}),
    });
    const stage = await seedStage({ stageNumber: 1, runCount: 1, failureThreshold: 0 });
    await startFlowBatchLocal(flowId, BATCH);
    const [bsr] = await listRunsForStage(db, stage.id);
    await setRunStatus(db, runId(bsr), 'failed');
    const unsubscribe = startBatchAdvanceListener();
    const event = { flowId, flowName: 'F', flowRunId: runId(bsr), batchId: BATCH };

    // A pause is not an ending, whatever the run row says.
    flowEventBus.emitFlowEvent({ ...event, eventType: 'run_paused', runStatus: 'paused' });
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect((await listRunsForStage(db, stage.id))[0].status).toBe('dispatched');

    flowEventBus.emitFlowEvent({ ...event, eventType: 'run_completed', runStatus: 'completed' });
    await vi.waitFor(async () =>
      expect((await getBatchStage(db, stage.id))?.status).toBe('failed'),
    );
    unsubscribe();

    expect((await listRunsForStage(db, stage.id))[0].status).toBe('failed');
  });

  it.each(['queued', 'claimed'] as const)('is not quiescent with a %s Retry', async (state) => {
    const stage = await seedStage({ stageNumber: 1, runCount: 1, failureThreshold: 0 });
    await startFlowBatchLocal(flowId, BATCH);
    const [bsr] = await listRunsForStage(db, stage.id);
    await db.update(batchStageRuns).set({ status: 'failed' }).where(eq(batchStageRuns.id, bsr.id));
    seedAdmission(runId(bsr), 'resume', state);

    expect(settleStageIfQuiescent(db, { id: stage.id, failureThreshold: 0 })).toBeNull();
    expect((await getBatchStage(db, stage.id))?.status).toBe('running');
  });
});

describe('stages defined after the batch started (cross-call dependsOn)', () => {
  const stageByNumber = async (n: number) =>
    (await db.select().from(batchStages).where(eq(batchStages.batchId, BATCH))).find(
      (s) => s.stageNumber === n,
    );

  async function startAndFinishStage1(status: 'completed' | 'failed') {
    await defineFlowBatchStages(flowId, BATCH, [{ stageNumber: 1, runs: [{}] }]);
    await startFlowBatchLocal(flowId, BATCH);
    const stage1 = await stageByNumber(1);
    const [bsr] = await listRunsForStage(db, stage1?.id ?? '');
    await finishRun(runId(bsr), status);
    expect((await stageByNumber(1))?.status).toBe(status);
  }

  it('start_batch starts a late stage whose dependency already completed', async () => {
    await startAndFinishStage1('completed');

    await defineFlowBatchStages(flowId, BATCH, [{ stageNumber: 2, dependsOn: [1], runs: [{}] }]);
    const result = await startFlowBatchLocal(flowId, BATCH);

    expect(result).toMatchObject({
      started: true,
      startedStageNumbers: [2],
      totalEnqueued: 1,
      rootStageCount: 1,
      startedRootCount: 0,
    });
    expect((await stageByNumber(2))?.status).toBe('running');
  });

  it('start_batch cancels a late stage whose dependency already failed instead of stranding it', async () => {
    await startAndFinishStage1('failed');

    await defineFlowBatchStages(flowId, BATCH, [{ stageNumber: 2, dependsOn: [1], runs: [{}] }]);
    mocks.startFlowRun.mockClear();
    await startFlowBatchLocal(flowId, BATCH);

    expect(mocks.startFlowRun).not.toHaveBeenCalled();
    expect((await stageByNumber(2))?.status).toBe('cancelled');
  });

  it('promotes a late stage automatically when its still-running dependency completes', async () => {
    await defineFlowBatchStages(flowId, BATCH, [{ stageNumber: 1, runs: [{}] }]);
    await startFlowBatchLocal(flowId, BATCH);

    await defineFlowBatchStages(flowId, BATCH, [{ stageNumber: 2, dependsOn: [1], runs: [{}] }]);
    expect((await stageByNumber(2))?.status).toBe('pending');
    const [bsr] = await listRunsForStage(db, (await stageByNumber(1))?.id ?? '');
    await finishRun(runId(bsr), 'completed');

    expect((await stageByNumber(2))?.status).toBe('running');
  });

  it('defineFlowBatchStages reports the persisted ids, run counts and root count', async () => {
    const result = await defineFlowBatchStages(flowId, BATCH, [
      { stageNumber: 1, name: 'build', runs: [{}, {}] },
      { stageNumber: 2, dependsOn: [1], runs: [{}] },
    ]);

    const s1 = await stageByNumber(1);
    const s2 = await stageByNumber(2);
    expect(result).toMatchObject({
      rootStageCount: 1,
      stages: [
        { id: s1?.id, stageNumber: 1, name: 'build', status: 'pending', runCount: 2 },
        { id: s2?.id, stageNumber: 2, name: null, runCount: 1, dependsOnStageNumbers: [1] },
      ],
    });
  });

  it('a define call with one bad stage saves nothing, and the corrected call then succeeds', async () => {
    // A BigInt cannot be JSON-serialised, so stage 2's run insert throws after stage 1's row exists.
    await expect(
      defineFlowBatchStages(flowId, BATCH, [
        { stageNumber: 1, runs: [{}] },
        { stageNumber: 2, dependsOn: [1], runs: [{ triggerContext: { n: BigInt(1) } }] },
      ]),
    ).rejects.toThrow();
    expect(await stageByNumber(1)).toBeUndefined();
    expect(await stageByNumber(2)).toBeUndefined();

    const result = await defineFlowBatchStages(flowId, BATCH, [
      { stageNumber: 1, runs: [{}] },
      { stageNumber: 2, dependsOn: [1], runs: [{ triggerContext: { n: 1 } }] },
    ]);

    expect(result.stages.map((s) => s.stageNumber)).toEqual([1, 2]);
    expect(await listRunsForStage(db, (await stageByNumber(2))?.id ?? '')).toHaveLength(1);
  });
});

async function getRun(id: string) {
  const [row] = await db.select().from(batchStageRuns).where(eq(batchStageRuns.id, id));
  return row;
}

const stageStatus = async (id: string) => (await getBatchStage(db, id))?.status;

/** One-slot root with X dispatched and P waiting behind it. */
async function seedBusyRoot() {
  await seedFlow({ maxBatchConcurrency: 1 });
  const root = await seedStage({ stageNumber: 1, runCount: 2 });
  const next = await seedStage({ stageNumber: 2, runCount: 0, dependsOnStageIds: [root.id] });
  await startFlowBatchLocal(flowId, BATCH);
  const runs = await listRunsForStage(db, root.id);
  const x = runs.find((r) => r.status === 'dispatched');
  const p = runs.find((r) => r.status === 'pending');
  if (!x || !p) throw new Error('expected one dispatched and one pending run');
  return { root, next, x, p };
}

describe('reassign eligibility', () => {
  it('rejects a run that is already dispatched or queued', async () => {
    const { root, next, x, p } = await seedBusyRoot();

    await expect(reassignStageRunLocal(flowId, x.id, next.id)).rejects.toMatchObject({
      code: 'CONFLICT',
    });
    await db.update(batchStageRuns).set({ status: 'queued' }).where(eq(batchStageRuns.id, p.id));
    await expect(reassignStageRunLocal(flowId, p.id, next.id)).rejects.toMatchObject({
      code: 'CONFLICT',
    });

    expect((await getRun(x.id)).stageId).toBe(root.id);
    expect((await getRun(p.id)).stageId).toBe(root.id);
  });

  it('rejects a pending run that already carries a flow run link', async () => {
    const { root, next, x, p } = await seedBusyRoot();
    await db.update(batchStageRuns).set({ flowRunId: null }).where(eq(batchStageRuns.id, x.id));
    await db
      .update(batchStageRuns)
      .set({ flowRunId: x.flowRunId })
      .where(eq(batchStageRuns.id, p.id));

    await expect(reassignStageRunLocal(flowId, p.id, next.id)).rejects.toMatchObject({
      code: 'CONFLICT',
    });
    expect((await getRun(p.id)).stageId).toBe(root.id);
  });

  it.each(['completed', 'failed', 'cancelled'])('rejects a %s target stage', async (status) => {
    const { root, next, p } = await seedBusyRoot();
    await db.update(batchStages).set({ status }).where(eq(batchStages.id, next.id));

    await expect(reassignStageRunLocal(flowId, p.id, next.id)).rejects.toMatchObject({
      code: 'CONFLICT',
    });
    expect((await getRun(p.id)).stageId).toBe(root.id);
  });

  it('reports an unknown run or target stage as not found', async () => {
    const { root, next, p } = await seedBusyRoot();

    await expect(reassignStageRunLocal(flowId, 'no-such-run', next.id)).rejects.toMatchObject({
      code: 'NOT_FOUND',
      message: 'Stage run not found',
    });
    await expect(reassignStageRunLocal(flowId, p.id, 'no-such-stage')).rejects.toMatchObject({
      code: 'NOT_FOUND',
      message: 'Target stage not found',
    });
    expect((await getRun(p.id)).stageId).toBe(root.id);
  });

  it("treats a move to the run's own stage as a no-op that dispatches nothing", async () => {
    const { root, x } = await seedBusyRoot();
    mocks.startFlowRun.mockClear();

    const result = await reassignStageRunLocal(flowId, x.id, root.id);

    expect(result).toEqual({ runId: x.id, sourceStageId: root.id, targetStageId: root.id });
    expect(mocks.startFlowRun).not.toHaveBeenCalled();
    expect(await getRun(x.id)).toMatchObject({ stageId: root.id, status: 'dispatched' });
  });

  it('rejects a run whose own stage has already finished', async () => {
    const { root, next, p } = await seedBusyRoot();
    // Cascade cancel flips the stage first and cancels its pending runs a tick later.
    await db.update(batchStages).set({ status: 'cancelled' }).where(eq(batchStages.id, root.id));

    await expect(reassignStageRunLocal(flowId, p.id, next.id)).rejects.toMatchObject({
      code: 'CONFLICT',
      message: 'This stage has already finished',
    });
    expect((await getRun(p.id)).stageId).toBe(root.id);
  });

  it('rejects a target stage from another batch', async () => {
    const { root, p } = await seedBusyRoot();
    const foreign = await seedBatchStage(db, 'other-batch', { stageNumber: 1, runCount: 0 });

    await expect(reassignStageRunLocal(flowId, p.id, foreign.id)).rejects.toMatchObject({
      code: 'NOT_FOUND',
    });
    expect((await getRun(p.id)).stageId).toBe(root.id);
  });
});

describe('re-settle after a move', () => {
  it('finalizes a running source left with nothing active and promotes its successor', async () => {
    const { root, next, x, p } = await seedBusyRoot();
    // X settled with no terminal event delivered: the source is running with only P left.
    await db.update(batchStageRuns).set({ status: 'completed' }).where(eq(batchStageRuns.id, x.id));

    await reassignStageRunLocal(flowId, p.id, next.id);

    expect(await stageStatus(root.id)).toBe('completed');
    expect(await stageStatus(next.id)).toBe('running');
    expect(await getRun(p.id)).toMatchObject({ stageId: next.id, status: 'dispatched' });
  });

  it('dispatches a run moved into a running stage with a free slot', async () => {
    await seedFlow();
    const rootA = await seedStage({ stageNumber: 1, runCount: 1 });
    const rootB = await seedStage({ stageNumber: 2, runCount: 1 });
    const later = await seedStage({ stageNumber: 3, runCount: 1, dependsOnStageIds: [rootA.id] });
    await startFlowBatchLocal(flowId, BATCH);
    const [p] = await listRunsForStage(db, later.id);

    await reassignStageRunLocal(flowId, p.id, rootB.id);

    expect(await getRun(p.id)).toMatchObject({ stageId: rootB.id, status: 'dispatched' });
  });

  it('keeps a run moved to a waiting stage pending until that stage starts', async () => {
    const { root, next, x, p } = await seedBusyRoot();

    await reassignStageRunLocal(flowId, p.id, next.id);

    // The source still has X in flight: it does not wait on the moved run.
    expect(await stageStatus(root.id)).toBe('running');
    expect(await getRun(p.id)).toMatchObject({ stageId: next.id, status: 'pending' });
    expect(mocks.startFlowRun).toHaveBeenCalledTimes(1);

    await finishRun(runId(x), 'completed');

    expect(await stageStatus(root.id)).toBe('completed');
    expect(await stageStatus(next.id)).toBe('running');
    expect(await getRun(p.id)).toMatchObject({ stageId: next.id, status: 'dispatched' });
  });
});

describe('re-settle boundaries', () => {
  it('holds a run moved into a full running stage until a slot frees', async () => {
    await seedFlow({ maxBatchConcurrency: 1 });
    const rootA = await seedStage({ stageNumber: 1, runCount: 2 });
    const rootB = await seedStage({ stageNumber: 2, runCount: 1 });
    await startFlowBatchLocal(flowId, BATCH);
    const p = (await listRunsForStage(db, rootA.id)).find((r) => r.status === 'pending');
    const [occupant] = await listRunsForStage(db, rootB.id);
    if (!p) throw new Error('expected a pending run behind the busy slot');
    mocks.startFlowRun.mockClear();

    await reassignStageRunLocal(flowId, p.id, rootB.id);

    expect(await getRun(p.id)).toMatchObject({ stageId: rootB.id, status: 'pending' });
    expect(mocks.startFlowRun).not.toHaveBeenCalled();

    await finishRun(runId(occupant), 'completed');

    expect(await getRun(p.id)).toMatchObject({ stageId: rootB.id, status: 'dispatched' });
    expect(await stageStatus(rootB.id)).toBe('running');
  });

  it.each(['deleted-flow', 'other-flow'])(
    'moves nothing when %s does not own the batch',
    async (kind) => {
      const { root, next, p } = await seedBusyRoot();
      const foreign = kind === 'other-flow' ? (await seedBatchFlow(db)).flowId : 'deleted-flow';
      mocks.startFlowRun.mockClear();

      await expect(reassignStageRunLocal(foreign, p.id, next.id)).rejects.toMatchObject({
        code: 'NOT_FOUND',
        message: 'Batch not found for this flow',
      });

      expect(await getRun(p.id)).toMatchObject({ stageId: root.id, status: 'pending' });
      expect(mocks.startFlowRun).not.toHaveBeenCalled();
    },
  );

  it('moves a run in a batch with no runs yet without dispatching anything', async () => {
    await seedFlow();
    const source = await seedStage({ stageNumber: 1, runCount: 1 });
    const target = await seedStage({ stageNumber: 2, runCount: 0 });
    // A running stage with no run on record has no verified owner to dispatch under.
    await db.update(batchStages).set({ status: 'running' }).where(eq(batchStages.id, target.id));
    const [p] = await listRunsForStage(db, source.id);

    await reassignStageRunLocal(flowId, p.id, target.id);

    expect(await getRun(p.id)).toMatchObject({ stageId: target.id, status: 'pending' });
    expect(mocks.startFlowRun).not.toHaveBeenCalled();
  });

  it('completes the re-settle when a move whose re-settle failed is retried', async () => {
    const { root, next, x, p } = await seedBusyRoot();
    await db.update(batchStageRuns).set({ status: 'completed' }).where(eq(batchStageRuns.id, x.id));
    // The move and the ownership lookup each ask for the database before the re-settle does.
    mocks.getDatabase
      .mockReturnValueOnce(db)
      .mockReturnValueOnce(db)
      .mockImplementationOnce(() => {
        throw new Error('database unavailable');
      });

    await expect(reassignStageRunLocal(flowId, p.id, next.id)).rejects.toThrow(
      'database unavailable',
    );
    expect(await getRun(p.id)).toMatchObject({ stageId: next.id, status: 'pending' });
    expect(await stageStatus(root.id)).toBe('running');

    await reassignStageRunLocal(flowId, p.id, next.id);

    expect(await stageStatus(root.id)).toBe('completed');
    expect(await getRun(p.id)).toMatchObject({ stageId: next.id, status: 'dispatched' });
  });

  it('lets the later of two panes moving the same run win, with the run in one stage', async () => {
    const { root, next, p } = await seedBusyRoot();
    const other = await seedStage({ stageNumber: 3, runCount: 0, dependsOnStageIds: [root.id] });

    const [first, second] = await Promise.all([
      reassignStageRunLocal(flowId, p.id, next.id),
      reassignStageRunLocal(flowId, p.id, other.id),
    ]);

    expect(first).toMatchObject({ sourceStageId: root.id, targetStageId: next.id });
    expect(second).toMatchObject({ sourceStageId: next.id, targetStageId: other.id });
    expect(await getRun(p.id)).toMatchObject({ stageId: other.id, status: 'pending' });
    expect(await listRunsForStage(db, next.id)).toHaveLength(0);
    expect(await stageStatus(root.id)).toBe('running');
  });
});

describe('move during dispatch', () => {
  it('leaves a run moved mid-loop pending in its new stage instead of failing it', async () => {
    await seedFlow();
    const root = await seedStage({ stageNumber: 1, runCount: 2 });
    const next = await seedStage({ stageNumber: 2, runCount: 0, dependsOnStageIds: [root.id] });
    const [first, second] = await listRunsForStage(db, root.id);
    const start = makeStartFlowRunMock(db, () => versionId);
    mocks.startFlowRun.mockImplementation(
      async (input: Parameters<typeof start>[0] & { batchStageId?: string }) => {
        const member = await getRun(input.batchStageRunId ?? '');
        // Stands in for the admission guard, which the mocked startFlowRun bypasses.
        if (member.stageId !== input.batchStageId) {
          throw new StageRunMovedError(member.id, input.batchStageId ?? '');
        }
        const other = member.id === first.id ? second : first;
        await db
          .update(batchStageRuns)
          .set({ stageId: next.id })
          .where(eq(batchStageRuns.id, other.id));
        return start(input);
      },
    );

    await startFlowBatchLocal(flowId, BATCH);

    const stayed = await listRunsForStage(db, root.id);
    const moved = await listRunsForStage(db, next.id);
    expect(stayed.map((r) => r.status)).toEqual(['dispatched']);
    expect(moved.map((r) => r.status)).toEqual(['pending']);
  });
});
