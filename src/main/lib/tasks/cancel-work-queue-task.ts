import type { getDatabase } from '../db';
import { cancelTaskDetailed, getTaskById, type TaskMutationResult } from '../db/repos/tasks';
import type { Task } from '../db/schema';
import { stopTaskSession } from './abort-task-session';

type Db = ReturnType<typeof getDatabase>;

async function cancelFlowTask(db: Db, taskId: string, flowRunId: string) {
  // Dynamic import mirrors the tasks router's flows imports (avoids a static import cycle).
  const { cancelFlowRunFromWorkQueue } = await import('../flows/engine');
  const outcome = await cancelFlowRunFromWorkQueue(flowRunId, taskId);
  if (!outcome?.touched) return outcome?.clicked ?? { task: null, reason: 'not_found' as const };
  const sessions = new Map<string, Task>(outcome.stopped.map((row) => [row.id, row]));
  if (outcome.clicked.previous) sessions.set(taskId, outcome.clicked.previous);
  for (const row of sessions.values()) stopTaskSession(row);
  return { task: outcome.clicked.task ?? (await getTaskById(db, taskId)) };
}

/** The Work Queue's one Cancel: a manual row is a guarded flip; a flow row cancels its RUN, because
 * the queue shows one row per run. Sessions are stopped only after the Cancel committed. */
export async function cancelWorkQueueTask(db: Db, taskId: string): Promise<TaskMutationResult> {
  const task = await getTaskById(db, taskId);
  if (task?.flowRunId) return cancelFlowTask(db, taskId, task.flowRunId);
  const { task: cancelled, reason, previous } = cancelTaskDetailed(db, taskId);
  if (previous) stopTaskSession(previous);
  return { task: cancelled, reason };
}
