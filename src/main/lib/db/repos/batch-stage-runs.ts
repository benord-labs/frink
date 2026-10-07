import { and, asc, eq, inArray } from 'drizzle-orm';
import { z } from 'zod';
import type { RunAttachment } from '../../../../shared/types/run-attachment';
import type { getDatabase } from '../index';
import { type BatchStageRun, batchStageRuns, type NewBatchStageRun } from '../schema';

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

/** Stored trigger_context: open-ended keys, plus an attachments list that is reset when malformed. */
const runTriggerContextSchema = z.looseObject({
  attachments: z.array(z.unknown()).optional().catch([]),
});

export type RunTriggerContext = z.infer<typeof runTriggerContextSchema>;

/** Parse a stored trigger_context column; a null column reads as empty. */
export function parseRunTriggerContext(stored: BatchStageRun['triggerContext']): RunTriggerContext {
  return runTriggerContextSchema.parse(stored ?? {});
}

export type AppendRunAttachmentResult =
  | { kind: 'ok'; triggerContext: RunTriggerContext }
  | { kind: 'not_found' }
  | { kind: 'not_pending' }
  | { kind: 'cap_exceeded' };

/**
 * One transaction: re-read, then append only to a pending run under `max`. Writes
 * trigger_context only, so a status set since the caller's read is never undone.
 */
export function appendRunAttachment(
  db: Db,
  runId: string,
  attachment: RunAttachment,
  max: number,
): AppendRunAttachmentResult {
  return db.transaction(() => {
    const row = db
      .select({ status: batchStageRuns.status, triggerContext: batchStageRuns.triggerContext })
      .from(batchStageRuns)
      .where(eq(batchStageRuns.id, runId))
      .get();
    if (!row) return { kind: 'not_found' } as const;
    if (row.status !== 'pending') return { kind: 'not_pending' } as const;
    const current = parseRunTriggerContext(row.triggerContext);
    const existing = current.attachments ?? [];
    if (existing.length >= max) return { kind: 'cap_exceeded' } as const;
    const triggerContext = { ...current, attachments: [...existing, attachment] };
    db.update(batchStageRuns).set({ triggerContext }).where(eq(batchStageRuns.id, runId)).run();
    return { kind: 'ok', triggerContext } as const;
  });
}

/** Read-modify-write trigger_context in one transaction; null when the run is missing. */
export function updateRunTriggerContext(
  db: Db,
  runId: string,
  patch: (current: RunTriggerContext) => RunTriggerContext,
): RunTriggerContext | null {
  return db.transaction(() => {
    const row = db
      .select({ triggerContext: batchStageRuns.triggerContext })
      .from(batchStageRuns)
      .where(eq(batchStageRuns.id, runId))
      .get();
    if (!row) return null;
    const triggerContext = patch(parseRunTriggerContext(row.triggerContext));
    db.update(batchStageRuns).set({ triggerContext }).where(eq(batchStageRuns.id, runId)).run();
    return triggerContext;
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
