import { and, asc, eq, inArray } from 'drizzle-orm';
import { z } from 'zod';
import type { RunAttachment } from '../../../../shared/types/run-attachment';
import type { getDatabase } from '../index';
import { type BatchStageRun, batchStageRuns, flowRuns, type NewBatchStageRun } from '../schema';

type Db = ReturnType<typeof getDatabase>;

/**
 * Cloud-parity vocabulary. Locally there is no queue, so the writer goes
 * pending → dispatched directly; 'queued' exists for type/renderer parity only.
 */
export type BatchStageRunStatus =
  | 'pending'
  | 'queued'
  | 'dispatched'
  | 'completed'
  | 'failed'
  | 'cancelled';

/** Non-terminal statuses — a stage with any of these still has work in flight or waiting. */
export const ACTIVE_BSR_STATUSES = ['pending', 'queued', 'dispatched'] as const;

export async function createBatchStageRun(db: Db, input: NewBatchStageRun): Promise<BatchStageRun> {
  const [row] = await db.insert(batchStageRuns).values(input).returning();
  return row;
}

export async function listRunsForStage(db: Db, stageId: string): Promise<BatchStageRun[]> {
  return db
    .select()
    .from(batchStageRuns)
    .where(eq(batchStageRuns.stageId, stageId))
    .orderBy(asc(batchStageRuns.createdAt));
}

export async function getBatchStageRun(db: Db, id: string): Promise<BatchStageRun | null> {
  const [row] = await db.select().from(batchStageRuns).where(eq(batchStageRuns.id, id)).limit(1);
  return row ?? null;
}

/** A run's trigger_context; only the attachment list is typed, other keys pass through. */
export const stageRunTriggerContextSchema = z
  .looseObject({
    attachments: z
      .array(
        z.looseObject({
          url: z.string(),
          type: z.string(),
          label: z.string().optional(),
          mimeType: z.string().optional(),
        }),
      )
      .default([]),
  })
  .nullable()
  .transform((tc) => tc ?? { attachments: [] });

export type StageRunTriggerContext = z.infer<typeof stageRunTriggerContextSchema>;

export type AppendAttachmentResult =
  | { ok: true; triggerContext: StageRunTriggerContext }
  | { ok: false; reason: 'not_found' | 'cap' | 'invalid' };

/**
 * Append one attachment under `max` in a single transaction, building on the
 * current trigger_context so concurrent uploads and edits are never lost.
 */
export function appendStageRunAttachment(
  db: Db,
  runId: string,
  attachment: RunAttachment,
  max: number,
): AppendAttachmentResult {
  return db.transaction((tx): AppendAttachmentResult => {
    const row = tx
      .select({ triggerContext: batchStageRuns.triggerContext })
      .from(batchStageRuns)
      .where(eq(batchStageRuns.id, runId))
      .get();
    if (!row) return { ok: false, reason: 'not_found' };
    // Refuse rather than rewrite a context we cannot read: that would drop its attachments.
    const parsed = stageRunTriggerContextSchema.safeParse(row.triggerContext);
    if (!parsed.success) return { ok: false, reason: 'invalid' };
    if (parsed.data.attachments.length >= max) return { ok: false, reason: 'cap' };
    const next = { ...parsed.data, attachments: [...parsed.data.attachments, attachment] };
    tx.update(batchStageRuns)
      .set({ triggerContext: next })
      .where(eq(batchStageRuns.id, runId))
      .run();
    return { ok: true, triggerContext: next };
  });
}

export async function setStageRunStatus(
  db: Db,
  id: string,
  status: BatchStageRunStatus,
  flowRunId?: string,
): Promise<BatchStageRun | null> {
  const update: Partial<BatchStageRun> = { status };
  if (flowRunId !== undefined) update.flowRunId = flowRunId;
  const [row] = await db
    .update(batchStageRuns)
    .set(update)
    .where(eq(batchStageRuns.id, id))
    .returning();
  return row ?? null;
}

/**
 * Guarded status transition — only applies when the row is currently in one of
 * `fromStatuses`. Returns null on a lost race (e.g. the run-terminal listener
 * already settled the row), so callers never downgrade a terminal status.
 */
export async function setStageRunStatusIf(
  db: Db,
  id: string,
  fromStatuses: BatchStageRunStatus[],
  status: BatchStageRunStatus,
  flowRunId?: string,
): Promise<BatchStageRun | null> {
  const update: Partial<BatchStageRun> = { status };
  if (flowRunId !== undefined) update.flowRunId = flowRunId;
  const [row] = await db
    .update(batchStageRuns)
    .set(update)
    .where(and(eq(batchStageRuns.id, id), inArray(batchStageRuns.status, fromStatuses)))
    .returning();
  return row ?? null;
}

/** Settle an in-flight stage run from its run row, reading and writing in ONE synchronous transaction:
 * a Retry promoted since the caller looked has the run running again, and must not be settled. */
export function settleStageRunFromRun(db: Db, id: string, flowRunId: string): void {
  db.transaction(() => {
    const run = db
      .select({ status: flowRuns.status })
      .from(flowRuns)
      .where(eq(flowRuns.id, flowRunId))
      .get();
    if (!run || !['completed', 'failed', 'cancelled'].includes(run.status)) return;
    db.update(batchStageRuns)
      .set({ status: run.status === 'completed' ? 'completed' : 'failed', flowRunId })
      .where(
        and(eq(batchStageRuns.id, id), inArray(batchStageRuns.status, [...ACTIVE_BSR_STATUSES])),
      )
      .run();
  });
}

export async function getStageRunByFlowRunId(
  db: Db,
  flowRunId: string,
): Promise<BatchStageRun | null> {
  const [row] = await db
    .select()
    .from(batchStageRuns)
    .where(eq(batchStageRuns.flowRunId, flowRunId))
    .limit(1);
  return row ?? null;
}

/** All non-terminal stage runs across every stage — startup recovery sweep input. */
export async function listActiveStageRuns(db: Db): Promise<BatchStageRun[]> {
  return db
    .select()
    .from(batchStageRuns)
    .where(inArray(batchStageRuns.status, [...ACTIVE_BSR_STATUSES]));
}

/** Cancel a stage's not-yet-dispatched runs (cascade-cancel; dispatched runs keep their flow_run). */
export async function cancelUndispatchedRunsForStage(db: Db, stageId: string): Promise<number> {
  const rows = await db
    .update(batchStageRuns)
    .set({ status: 'cancelled' })
    .where(
      and(
        eq(batchStageRuns.stageId, stageId),
        inArray(batchStageRuns.status, ['pending', 'queued']),
      ),
    )
    .returning({ id: batchStageRuns.id });
  return rows.length;
}
