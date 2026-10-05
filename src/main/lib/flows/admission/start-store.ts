import { and, eq, isNull } from 'drizzle-orm';
import { z } from 'zod';
import {
  type FlowAdmissionIntentV1,
  isFlowAdmissionIntentV1,
} from '../../../../shared/lib/flow-admission';
import type { getDatabase } from '../../db';
import {
  type BatchStageRun,
  batchStageRuns,
  batchStages,
  type FlowRun,
  flowRuns,
  type NewFlowRun,
} from '../../db/schema';
import { parseRunTriggerContext } from '../../db/repos/batch-stage-runs';
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

const memberAttachmentsSchema = z.object({ attachments: z.array(z.unknown()) });

/** Uploads append only while the member is pending, so this read is final for its run. */
function withMemberAttachments(
  db: Db,
  run: FlowRun,
  memberContext: BatchStageRun['triggerContext'],
): FlowRun {
  // Only a real list replaces the snapshot; a malformed value must not erase it.
  const member = memberAttachmentsSchema.safeParse(memberContext);
  if (!member.success) return run;
  const triggerContext = {
    ...parseRunTriggerContext(run.triggerContext),
    attachments: member.data.attachments,
  };
  return db
    .update(flowRuns)
    .set({ triggerContext })
    .where(eq(flowRuns.id, run.id))
    .returning()
    .get();
}

function queueBatchMember(db: Db, batchStageRunId: string, run: FlowRun): FlowRun {
  const current = db
    .select({
      status: batchStageRuns.status,
      flowRunId: batchStageRuns.flowRunId,
      stageId: batchStageRuns.stageId,
      batchId: batchStages.batchId,
      triggerContext: batchStageRuns.triggerContext,
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
    return run;
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
  return withMemberAttachments(db, run, current.triggerContext);
}

/** Must run inside the controller's BEGIN IMMEDIATE transaction. */
export function enqueueFlowStart(db: Db, input: EnqueueFlowStartInput): EnqueueFlowStartResult {
  const { batchStageRunId, requestedAt, ...runInput } = input;
  const existing = existingRunForStart(db, input.idempotencyKey);
  const created = existing ?? createPendingRun(db, runInput);
  const isReplay = Boolean(existing);
  if (!isProvenUnstarted(created)) return { run: created, isReplay, admission: null };

  const live = liveAdmissionForRun(db, created.id);
  if (
    live &&
    batchStageRunId &&
    (!isFlowAdmissionIntentV1(live.intentJson) ||
      live.intentJson.batch_stage_run_id !== batchStageRunId)
  ) {
    throw new Error(`Flow run ${created.id} already has a different live start admission`);
  }
  const run = batchStageRunId ? queueBatchMember(db, batchStageRunId, created) : created;
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
