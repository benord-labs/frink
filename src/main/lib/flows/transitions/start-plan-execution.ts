import { eq } from 'drizzle-orm';
import type { getDatabase } from '../../db';
import { startExecutionFromReviewCommand, type TaskMutationResult } from '../../db/repos/tasks';
import { tasks } from '../../db/schema';
import { isCancellableRunStatus, readRun } from './run-rows';
import { hasActiveSlot } from './unpark';

type Db = ReturnType<typeof getDatabase>;

/** plan_ready → running; a Flow task also needs a live run holding an active slot. Run it under
 * `transitionFlowRun` so no release lands between the check and the write. */
export function startPlanExecutionCommand(
  db: Db,
  taskId: string,
  machineId: string | null,
): TaskMutationResult {
  const task = db
    .select({ flowRunId: tasks.flowRunId })
    .from(tasks)
    .where(eq(tasks.id, taskId))
    .get();
  if (!task) return { task: null, reason: 'not_found' };
  if (task.flowRunId) {
    const run = readRun(db, task.flowRunId);
    // A terminal run can still hold an `active` slot until its release reconciles.
    if (!run || !isCancellableRunStatus(run.status) || !hasActiveSlot(db, task.flowRunId)) {
      return { task: null, reason: 'flow_admission_lost' };
    }
  }
  return startExecutionFromReviewCommand(db, taskId, machineId);
}
