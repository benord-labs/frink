import { and, eq, inArray, isNotNull, ne, or, sql } from 'drizzle-orm';
import type { getDatabase } from '../../db';
import { ACTIVE_BSR_STATUSES, setStageRunStatusIf } from '../../db/repos/batch-stage-runs';
import {
  type BatchStageRun,
  batchStageRuns,
  batchStages,
  type FlowRun,
  flowRunAdmissions,
  flowVersions,
} from '../../db/schema';
import { buildCtx } from '../batch-context';

type Db = ReturnType<typeof getDatabase>;

/** Thrown inside the admission transaction when a member would exceed its stage's ceiling; the
 * dispatcher leaves that member `pending` for the next settle instead of failing it. */
export class StageAtConcurrencyLimitError extends Error {
  constructor(stageId: string) {
    super(`Batch stage ${stageId} is at its concurrency limit`);
    this.name = 'StageAtConcurrencyLimitError';
  }
}

/** Thrown inside the admission transaction when a member was reassigned to another stage after the
 * dispatcher read it; the dispatcher leaves it `pending` for its new stage instead of failing it. */
export class StageRunMovedError extends Error {
  constructor(batchStageRunId: string, expectedStageId: string) {
    super(`Batch stage run ${batchStageRunId} is no longer in stage ${expectedStageId}`);
    this.name = 'StageRunMovedError';
  }
}

/** The stage ceiling a member's own pinned flow version declares; null for a run outside a batch. */
export function stageConcurrencyLimit(
  db: Db,
  run: Pick<FlowRun, 'flowVersionId' | 'batchId'>,
): number | null {
  if (!run.batchId) return null;
  const version = db
    .select()
    .from(flowVersions)
    .where(eq(flowVersions.id, run.flowVersionId))
    .get();
  return version ? buildCtx(version, run.batchId).limit : null;
}

/** Refuse a member a slot in a full stage. Runs inside the admission transaction that flips the member to
 * `queued`, so the throw rolls that enqueue back and the member stays `pending` for the next settle. */
export function assertStageHasSlot(
  db: Db,
  stageId: string,
  run: Pick<FlowRun, 'flowVersionId' | 'batchId'>,
): void {
  const limit = stageConcurrencyLimit(db, run);
  if (limit !== null && occupiedStageSlots(db, stageId) >= limit) {
    throw new StageAtConcurrencyLimitError(stageId);
  }
}

/** A resume ticket re-dispatches a settled member only: a still-`dispatched` row belongs to the
 * in-flight terminal settle (or, before boot recovery ran, to the crashed process). */
export const RESUMABLE_BSR_STATUSES: readonly string[] = ['failed'];

/** Statuses that still let a member back in. A completed or cancelled stage has settled on it. */
const REOPENABLE_STAGE_STATUSES: readonly string[] = ['failed', 'running'];

/** Mirrors slot-fill's occupancy: these are the rows that hold a stage concurrency slot. */
const OCCUPIED_BSR_STATUSES: readonly string[] = ['queued', 'dispatched'];

/** The one occupancy count the dispatcher and a resume promotion measure `maxBatchConcurrency` against: a
 * queued/dispatched run, or a member whose resume ticket is already live (its slot is reserved from enqueue). */
export function occupiedStageSlots(db: Db, stageId: string, exceptId?: string): number {
  return (
    db
      .select({ count: sql<number>`count(*)` })
      .from(batchStageRuns)
      .leftJoin(
        flowRunAdmissions,
        and(
          eq(flowRunAdmissions.flowRunId, batchStageRuns.flowRunId),
          eq(flowRunAdmissions.priorityClass, 'resume'),
          inArray(flowRunAdmissions.state, ['queued', 'claimed']),
        ),
      )
      .where(
        and(
          eq(batchStageRuns.stageId, stageId),
          // The member's own row is the slot being asked for: its live ticket must not count against it.
          exceptId ? ne(batchStageRuns.id, exceptId) : undefined,
          or(
            inArray(batchStageRuns.status, [...OCCUPIED_BSR_STATUSES]),
            isNotNull(flowRunAdmissions.ticket),
          ),
        ),
      )
      .get()?.count ?? 0
  );
}

/** The stage slot a resume ticket re-enters. `limit` is the ceiling of the run's pinned flow version. */
export type BatchMemberResumeTarget = {
  batchStageRunId: string;
  stageId: string;
  limit: number;
};

export function batchMemberPromotionError(
  db: Db,
  flowRunId: string,
  batchStageRunId: string | null | undefined,
  expected: readonly string[],
): string | null {
  if (!batchStageRunId) return null;
  const member = db
    .select({ status: batchStageRuns.status, flowRunId: batchStageRuns.flowRunId })
    .from(batchStageRuns)
    .where(eq(batchStageRuns.id, batchStageRunId))
    .get();
  return member && expected.includes(member.status) && member.flowRunId === flowRunId
    ? null
    : `Batch stage run ${batchStageRunId} is not ${expected.join('/')} for flow run ${flowRunId}`;
}

/** Why this member may not re-enter its stage, or null. Every check re-reads the database (no stale
 * snapshot between validation and promotion); the messages reach the Retry button verbatim. */
export function batchMemberResumeError(
  db: Db,
  flowRunId: string,
  member: BatchMemberResumeTarget | null,
): string | null {
  if (
    !member ||
    batchMemberPromotionError(db, flowRunId, member.batchStageRunId, RESUMABLE_BSR_STATUSES)
  ) {
    return "this batch member already settled in its stage — retry isn't available";
  }
  const stage = db
    .select({ status: batchStages.status })
    .from(batchStages)
    .where(eq(batchStages.id, member.stageId))
    .get();
  if (!stage || !REOPENABLE_STAGE_STATUSES.includes(stage.status)) {
    return "this stage already settled — retry isn't available";
  }
  const occupied = occupiedStageSlots(db, member.stageId, member.batchStageRunId);
  return occupied < member.limit
    ? null
    : `stage is at its concurrency limit (${occupied} running); retry when a member finishes`;
}

/** Guarded flip to `dispatched`, synchronous so both promotion paths compose it inside their transaction. */
export function promoteStageRunToDispatched(
  db: Db,
  batchStageRunId: string,
  flowRunId: string,
  expected: readonly string[],
): boolean {
  return Boolean(
    db
      .update(batchStageRuns)
      .set({ status: 'dispatched' })
      .where(
        and(
          eq(batchStageRuns.id, batchStageRunId),
          eq(batchStageRuns.flowRunId, flowRunId),
          inArray(batchStageRuns.status, [...expected]),
        ),
      )
      .returning({ id: batchStageRuns.id })
      .get(),
  );
}

/** Hand a settled stage back its in-flight status so the retried member's terminal event settles it again. */
export function reopenFailedStage(db: Db, stageId: string): void {
  db.update(batchStages)
    .set({ status: 'running' })
    .where(and(eq(batchStages.id, stageId), eq(batchStages.status, 'failed')))
    .run();
}

export async function settleTerminalBatchReplay(
  db: Db,
  bsr: BatchStageRun,
  run: FlowRun,
  isReplay: boolean,
): Promise<boolean> {
  if (!isReplay || !['completed', 'failed', 'cancelled'].includes(run.status)) return false;
  await setStageRunStatusIf(
    db,
    bsr.id,
    [...ACTIVE_BSR_STATUSES],
    run.status === 'completed' ? 'completed' : 'failed',
    run.id,
  );
  return true;
}
