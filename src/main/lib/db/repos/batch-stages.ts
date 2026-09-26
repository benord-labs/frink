import { and, asc, eq, isNull } from 'drizzle-orm';
import type { getDatabase } from '../index';
import { type BatchStage, batchStageRuns, batchStages, type NewBatchStage } from '../schema';
import { ACTIVE_BSR_STATUSES } from './batch-stage-runs';

type Db = ReturnType<typeof getDatabase>;

/** Settle a running stage in ONE synchronous transaction that recounts its runs first: a member a Retry
 * re-admitted since the caller's read keeps the stage running instead of being stranded under a settled one. */
export function settleStageIfQuiescent(
  db: Db,
  stage: Pick<BatchStage, 'id' | 'failureThreshold'>,
): { failed: boolean; failedCount: number } | null {
  const active = new Set<string>(ACTIVE_BSR_STATUSES);
  return db.transaction(() => {
    const statuses = db
      .select({ status: batchStageRuns.status })
      .from(batchStageRuns)
      .where(eq(batchStageRuns.stageId, stage.id))
      .all();
    if (statuses.some((r) => active.has(r.status))) return null;
    const failedCount = statuses.filter((r) => r.status === 'failed').length;
    const failed = stage.failureThreshold >= 0 && failedCount > stage.failureThreshold;
    const won = db
      .update(batchStages)
      .set({ status: failed ? 'failed' : 'completed' })
      .where(and(eq(batchStages.id, stage.id), eq(batchStages.status, 'running')))
      .returning({ id: batchStages.id })
      .get();
    return won ? { failed, failedCount } : null;
  });
}

export async function createBatchStage(db: Db, input: NewBatchStage): Promise<BatchStage> {
  const [row] = await db.insert(batchStages).values(input).returning();
  return row;
}

export async function listStagesForBatch(db: Db, batchId: string): Promise<BatchStage[]> {
  return db
    .select()
    .from(batchStages)
    .where(eq(batchStages.batchId, batchId))
    .orderBy(asc(batchStages.stageNumber));
}

export async function listStagesByStatus(db: Db, status: string): Promise<BatchStage[]> {
  return db.select().from(batchStages).where(eq(batchStages.status, status));
}

export async function getBatchStage(db: Db, id: string): Promise<BatchStage | null> {
  const [row] = await db.select().from(batchStages).where(eq(batchStages.id, id)).limit(1);
  return row ?? null;
}

/**
 * Guarded status transition (mutex, cloud parity): only the first caller whose
 * `WHERE status = from` matches proceeds. Returns false on a lost race so
 * concurrent settle/advance paths never double-dispatch a stage.
 */
export async function setStageStatusIf(
  db: Db,
  stageId: string,
  from: string,
  to: string,
): Promise<boolean> {
  const rows = await db
    .update(batchStages)
    .set({ status: to })
    .where(and(eq(batchStages.id, stageId), eq(batchStages.status, from)))
    .returning({ id: batchStages.id });
  return rows.length > 0;
}

/** Re-open a cascade-cancelled successor once a retried dependency completes — its never-dispatched runs and
 * the stage in ONE transaction, so a restart cannot leave runs pending under a still-cancelled stage. */
export function reopenCascadedSuccessor(db: Db, stageId: string): void {
  db.transaction(() => {
    db.update(batchStageRuns)
      .set({ status: 'pending' })
      .where(
        and(
          eq(batchStageRuns.stageId, stageId),
          eq(batchStageRuns.status, 'cancelled'),
          isNull(batchStageRuns.flowRunId),
        ),
      )
      .run();
    db.update(batchStages)
      .set({ status: 'pending' })
      .where(and(eq(batchStages.id, stageId), eq(batchStages.status, 'cancelled')))
      .run();
  });
}

export async function patchStageDeps(
  db: Db,
  batchId: string,
  stageId: string,
  dependsOnStageIds: string[],
): Promise<BatchStage | null> {
  const [row] = await db
    .update(batchStages)
    .set({ dependsOnStageIds })
    .where(and(eq(batchStages.batchId, batchId), eq(batchStages.id, stageId)))
    .returning();
  return row ?? null;
}
