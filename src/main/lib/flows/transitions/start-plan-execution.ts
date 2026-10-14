import { and, eq } from 'drizzle-orm';
import type { getDatabase } from '../../db';
import {
  parseResultRecord,
  startExecutionFromReviewCommand,
  type TaskMutationResult,
} from '../../db/repos/tasks';
import { isWaitModeTask } from '../../db/repos/task-queries';
import { tasks } from '../../db/schema';
import { isCancellableRunStatus, readRun } from './run-rows';
import { hasActiveSlot } from './unpark';

type Db = ReturnType<typeof getDatabase>;

/** A terminal run can still hold an `active` slot until its release reconciles. */
function runAcceptsStart(db: Db, flowRunId: string): boolean {
  const run = readRun(db, flowRunId);
  return Boolean(run && isCancellableRunStatus(run.status) && hasActiveSlot(db, flowRunId));
}

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
  if (task.flowRunId && !runAcceptsStart(db, task.flowRunId)) {
    return { task: null, reason: 'flow_admission_lost' };
  }
  return startExecutionFromReviewCommand(db, taskId, machineId);
}

/** Releases a waiting task to the executor, which claims it into its existing chat: a saved start
 * mode is what the poller reads as started. A repeat Start returns the task unchanged. */
export function startWaitingTaskCommand(db: Db, taskId: string): TaskMutationResult {
  const task = db.select().from(tasks).where(eq(tasks.id, taskId)).get();
  if (!task) return { task: null, reason: 'not_found' };
  if (task.status !== 'pending' && task.status !== 'running') {
    return { task: null, reason: 'invalid_state' };
  }
  if (task.flowRunId && !runAcceptsStart(db, task.flowRunId)) {
    return { task: null, reason: 'flow_admission_lost' };
  }
  const started = db
    .update(tasks)
    .set({ result: { ...parseResultRecord(task.result), startMode: 'execute' } })
    .where(and(eq(tasks.id, taskId), isWaitModeTask))
    .returning()
    .get();
  return { task: started ?? task };
}
