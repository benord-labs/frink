import { and, asc, eq, inArray, isNull } from 'drizzle-orm';
import type { getDatabase } from '../index';
import {
  type BatchStage,
  batchStageRuns,
  batchStages,
  flowRunAdmissions,
  type NewBatchStage,
} from '../schema';
import { ACTIVE_BSR_STATUSES } from './batch-stage-runs';

type Db = ReturnType<typeof getDatabase>;

/** A member's Retry that has not been promoted yet. Its run row and stage run still read as settled, so the
 * ticket is the only record that the member has work coming. */
function hasUnpromotedResume(db: Db, stageId: string): boolean {
  return Boolean(
    db
      .select({ ticket: flowRunAdmissions.ticket })
      .from(batchStageRuns)
      .innerJoin(
        flowRunAdmissions,
        and(
          eq(flowRunAdmissions.flowRunId, batchStageRuns.flowRunId),
          eq(flowRunAdmissions.priorityClass, 'resume'),
          inArray(flowRunAdmissions.state, ['queued', 'claimed']),
        ),
      )
      .where(eq(batchStageRuns.stageId, stageId))
      .limit(1)
      .get(),
  );
}

/** Settle a running stage in ONE synchronous transaction that recounts its runs first: a member a Retry
 * re-admitted since the caller's read keeps the stage running instead of being stranded under a settled one.
 * That holds from the moment the Retry is queued, so whichever terminal event asks, the stage waits for it. */
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
    if (hasUnpromotedResume(db, stage.id)) return null;
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

export type NewStageWithRuns = {
  stageNumber: number;
  name?: string;
  failureThreshold?: number;
  dependsOn?: number[];
  runs: Array<{ triggerContext?: Record<string, unknown> }>;
};

/** All-or-nothing stage + deps + runs insert (one sync transaction): a failure leaves no orphan stage to
 * block a retry. dependsOn also resolves against earlier calls' stages. Returns stageNumber → id. */
export function insertBatchStagesWithRuns(
  db: Db,
  batchId: string,
  stages: NewStageWithRuns[],
): Map<number, string> {
  return db.transaction(() => {
    const stageIdByNumber = new Map<number, string>(
      db
        .select({ id: batchStages.id, stageNumber: batchStages.stageNumber })
        .from(batchStages)
        .where(eq(batchStages.batchId, batchId))
        .all()
        .map((s) => [s.stageNumber, s.id]),
    );

    const seen = new Set<number>();
    const repeated = stages.map((s) => s.stageNumber).filter((n) => seen.has(n) || !seen.add(n));
    if (repeated.length > 0) {
      throw new Error(
        `Stage(s) ${[...new Set(repeated)].join(', ')} defined more than once in this call`,
      );
    }
    const existing = stages.map((s) => s.stageNumber).filter((n) => stageIdByNumber.has(n));
    if (existing.length > 0) {
      throw new Error(
        `Stage(s) ${existing.join(', ')} already exist for batch ${batchId}; use frink_flows_add_stage_runs to add runs`,
      );
    }

    for (const s of stages) {
      const inserted = db
        .insert(batchStages)
        .values({
          batchId,
          stageNumber: s.stageNumber,
          name: s.name ?? null,
          status: 'pending',
          failureThreshold: s.failureThreshold ?? 0,
          dependsOnStageIds: [], // backfilled once every stage in the call has an id
        })
        .returning({ id: batchStages.id })
        .get();
      stageIdByNumber.set(s.stageNumber, inserted.id);
    }

    for (const s of stages) {
      const id = stageIdByNumber.get(s.stageNumber) as string;
      const dependsOnStageIds = (s.dependsOn ?? [])
        .map((n) => stageIdByNumber.get(n))
        .filter((x): x is string => Boolean(x));
      if (dependsOnStageIds.length > 0) {
        db.update(batchStages).set({ dependsOnStageIds }).where(eq(batchStages.id, id)).run();
      }
      if (s.runs.length > 0) {
        db.insert(batchStageRuns)
          .values(
            s.runs.map((r) => ({
              stageId: id,
              triggerContext: r.triggerContext ?? null,
              status: 'pending',
            })),
          )
          .run();
      }
    }

    return stageIdByNumber;
  });
}
