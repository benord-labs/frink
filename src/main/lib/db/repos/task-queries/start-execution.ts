import { and, eq } from 'drizzle-orm';
import type { getDatabase } from '../../index';
import { tasks } from '../../schema';
import type { TaskMutationResult } from '../tasks';

type Db = ReturnType<typeof getDatabase>;

/** plan_ready → running, else invalid_state. Sync so a Flow caller can compose it with its
 * admission check in one transaction. */
export function startExecutionFromReviewCommand(
  db: Db,
  taskId: string,
  machineId: string | null,
): TaskMutationResult {
  // Atomic plan_ready → running: WHERE pins source status to prevent racing
  // the poller / a concurrent cancel.
  const updated = db
    .update(tasks)
    .set({ status: 'running', startedAt: new Date(), executedBy: machineId ?? null })
    .where(and(eq(tasks.id, taskId), eq(tasks.status, 'plan_ready')))
    .returning()
    .get();
  if (updated) return { task: updated };
  const existing = db.select({ id: tasks.id }).from(tasks).where(eq(tasks.id, taskId)).get();
  if (!existing) return { task: null, reason: 'not_found' };
  return { task: null, reason: 'invalid_state' };
}

export async function startExecutionFromReviewDetailed(
  db: Db,
  taskId: string,
  machineId: string | null,
): Promise<TaskMutationResult> {
  return startExecutionFromReviewCommand(db, taskId, machineId);
}
