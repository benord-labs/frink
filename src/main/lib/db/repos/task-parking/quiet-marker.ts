/**
 * Atomic writes for the quiet-end marker (`result.quietEndedAt`). Every write patches ONLY the
 * marker key via SQLite json_set/json_remove inside a single status-guarded UPDATE, so a
 * concurrent `result` writer (the eager signal record, a park reason, a cancel marker) is never
 * clobbered by a whole-blob read-modify-write. Marker lifecycle overview: resume-scrub.ts.
 */

import { and, sql as drizzleSql, eq } from 'drizzle-orm';
import type { TaskStatus } from '../../../../../shared/types/task-status';
import { type TaskResultRecord, taskResultSchema } from '../../../../../shared/types/task-result';
import type { getDatabase } from '../..';
import type { Task } from '../../schema';
import { tasks } from '../../schema';

type Db = ReturnType<typeof getDatabase>;

/** Sets the marker on a running task. Returns the updated row, or null (not running / raced). */
export async function setQuietEndMarker(
  db: Db,
  taskId: string,
  quietEndedAt: string,
): Promise<Task | null> {
  const [row] = await db
    .update(tasks)
    .set({
      result: drizzleSql`json_set(COALESCE(${tasks.result}, '{}'), '$.quietEndedAt', ${quietEndedAt})`,
    })
    .where(and(eq(tasks.id, taskId), eq(tasks.status, 'running')))
    .returning();
  return row ?? null;
}

/**
 * Removes the marker from a running task. Returns the updated row, or null when there was nothing
 * to remove — no marker present, or the task is no longer `running` (e.g. the quiet-idle sweep
 * parked it); callers distinguish those two with a follow-up read.
 */
export async function removeQuietEndMarker(db: Db, taskId: string): Promise<Task | null> {
  const [row] = await db
    .update(tasks)
    .set({ result: drizzleSql`json_remove(${tasks.result}, '$.quietEndedAt')` })
    .where(
      and(
        eq(tasks.id, taskId),
        eq(tasks.status, 'running'),
        drizzleSql`json_extract(${tasks.result}, '$.quietEndedAt') IS NOT NULL`,
      ),
    )
    .returning();
  return row ?? null;
}

/** Wake-burst resume: `needs_attention` → `running` ONLY while the row is still the exact quiet-idle
 * park the burst read (status + result JSON), so a newer park is never overwritten by a stale one. */
export async function resumeQuietIdlePark(
  db: Db,
  taskId: string,
  parkedResult: Task['result'],
  result: TaskResultRecord,
): Promise<Task | null> {
  const [row] = await db
    .update(tasks)
    .set({ status: 'running', startedAt: new Date(), result })
    .where(
      and(
        eq(tasks.id, taskId),
        eq(tasks.status, 'needs_attention'),
        drizzleSql`json_extract(${tasks.result}, '$.agentSignal.state') = 'missing_completion_signal'`,
        drizzleSql`json(${tasks.result}) IS json(${JSON.stringify(parkedResult ?? null)})`,
      ),
    )
    .returning();
  return row ?? null;
}

/** Replace a WAKE-RESUMED row (status `running`) only while it is still exactly that row: the
 * rollback of a resume whose flow half could not follow, and the late signal of the same execution. */
export async function replaceWakeResumedRow(
  db: Db,
  taskId: string,
  /** The `result.resumedAt` stamp of the resume being replaced — unique per resume, and untouched
   * by the quiet-marker patch a burst end may have applied since. */
  resumedAt: string,
  next: { status: TaskStatus; result: unknown },
): Promise<Task | null> {
  const [row] = await db
    .update(tasks)
    .set({
      status: next.status,
      completedAt: new Date(),
      result: taskResultSchema.parse(next.result),
    })
    .where(
      and(
        eq(tasks.id, taskId),
        eq(tasks.status, 'running'),
        drizzleSql`json_extract(${tasks.result}, '$.resumedAt') = ${resumedAt}`,
      ),
    )
    .returning();
  return row ?? null;
}
