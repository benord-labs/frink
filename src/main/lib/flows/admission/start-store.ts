import { and, eq, isNull } from 'drizzle-orm';
import {
  type FlowAdmissionIntentV1,
  isFlowAdmissionIntentV1,
} from '../../../../shared/lib/flow-admission';
import type { getDatabase } from '../../db';
import {
  batchStageRuns,
  batchStages,
  type FlowRun,
  flowRuns,
  type NewFlowRun,
} from '../../db/schema';
import { assertStageHasSlot } from './batch-promotion';
import { enqueueFlowAdmission, type FlowRunAdmission, liveAdmissionForRun } from './store';

type Db = ReturnType<typeof getDatabase>;

export type EnqueueFlowStartInput = Omit<NewFlowRun, 'status' | 'startedAt' | 'completedAt'> & {
  batchStageRunId?: string | null;
  requestedAt?: Date;
};

export type EnqueueFlowStartResult = {
  run: FlowRun;
  isReplay: boolean;
  admission: FlowRunAdmission | null;
};

function existingRunForStart(db: Db, idempotencyKey: string | null | undefined): FlowRun | null {
  if (!idempotencyKey) return null;
  return (
    db.select().from(flowRuns).where(eq(flowRuns.idempotencyKey, idempotencyKey)).limit(1).get() ??
    null
  );
}

function createPendingRun(
  db: Db,
  input: Omit<EnqueueFlowStartInput, 'batchStageRunId' | 'requestedAt'>,
): FlowRun {
  return db
    .insert(flowRuns)
    .values({
      ...input,
      status: 'pending',
      startedAt: null,
      completedAt: null,
    })
    .returning()
    .get();
}

function isProvenUnstarted(run: FlowRun): boolean {
  return run.status === 'pending' && run.startedAt === null;
}

function queueBatchMember(db: Db, batchStageRunId: string, run: FlowRun): void {
  const current = db
    .select({
      status: batchStageRuns.status,
      flowRunId: batchStageRuns.flowRunId,
      stageId: batchStageRuns.stageId,
      batchId: batchStages.batchId,
    })
    .from(batchStageRuns)
    .innerJoin(batchStages, eq(batchStages.id, batchStageRuns.stageId))
    .where(eq(batchStageRuns.id, batchStageRunId))
    .get();
  if (
    current?.status === 'queued' &&
    current.flowRunId === run.id &&
    current.batchId === run.batchId
  ) {
    return;
  }
  if (!run.batchId || current?.batchId !== run.batchId) {
    throw new Error(`Batch stage run ${batchStageRunId} is not eligible for admission`);
  }
  // Same transaction and mutex as a resume promotion's check, so the ceiling holds on both paths.
  assertStageHasSlot(db, current.stageId, run);
  const linked = db
    .update(batchStageRuns)
    .set({ status: 'queued', flowRunId: run.id })
    .where(
      and(
        eq(batchStageRuns.id, batchStageRunId),
        eq(batchStageRuns.status, 'pending'),
        isNull(batchStageRuns.flowRunId),
      ),
    )
    .returning({ id: batchStageRuns.id })
    .get();
  if (!linked) {
    throw new Error(`Batch stage run ${batchStageRunId} is not eligible for admission`);
  }
}

/** Must run inside the controller's BEGIN IMMEDIATE transaction. */
export function enqueueFlowStart(db: Db, input: EnqueueFlowStartInput): EnqueueFlowStartResult {
  const { batchStageRunId, requestedAt, ...runInput } = input;
  const existing = existingRunForStart(db, input.idempotencyKey);
  const run = existing ?? createPendingRun(db, runInput);
  const isReplay = Boolean(existing);
  if (!isProvenUnstarted(run)) return { run, isReplay, admission: null };

  const live = liveAdmissionForRun(db, run.id);
  if (
    live &&
    batchStageRunId &&
    (!isFlowAdmissionIntentV1(live.intentJson) ||
      live.intentJson.batch_stage_run_id !== batchStageRunId)
  ) {
    throw new Error(`Flow run ${run.id} already has a different live start admission`);
  }
  if (batchStageRunId) queueBatchMember(db, batchStageRunId, run);
  if (live) return { run, isReplay, admission: live };

  const intent: FlowAdmissionIntentV1 = {
    version: 1,
    action: 'start',
    flow_run_id: run.id,
    ...(batchStageRunId ? { batch_stage_run_id: batchStageRunId } : {}),
  };
  const { admission } = enqueueFlowAdmission(db, { intent, requestedAt });
  return { run, isReplay, admission };
}
