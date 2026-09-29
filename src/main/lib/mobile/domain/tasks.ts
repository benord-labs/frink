import { hostname } from 'node:os';
import { eq } from 'drizzle-orm';
import { assessTaskRetry } from '../../../../shared/lib/task-retry-policy';
import type { MobileRequest, MobileTaskAction } from '../../../../shared/types/remote/mobile';
import { getDatabase } from '../../db';
import { claimTask, getTaskById, parseResultRecord } from '../../db/repos/tasks';
import { chats, type Task } from '../../db/schema';
import { MobileApiError, mobileCallers, requireExecutionReady } from './context';

type ActionTask = Pick<Task, 'status' | 'flowRunId' | 'result'> & { linkedChatId: string | null };
type TaskActionRequest = Extract<MobileRequest, { type: MobileTaskAction }>;

const CHANGED = 'This item changed. Refresh and try again.';

/** The desktop Work Queue row menu's gates for Start task, Carry on task and Mark complete. A Flow
 *  item starts and carries on through its run. `status` is the queue's display status. */
export function mobileTaskActions(task: ActionTask, status: string = task.status) {
  const actions: MobileTaskAction[] = [];
  const chatTask = !task.flowRunId;
  if (
    chatTask &&
    status === 'pending' &&
    !task.linkedChatId &&
    !parseResultRecord(task.result).chatId
  )
    actions.push('startTask');
  if (
    chatTask &&
    (status === 'failed' || status === 'needs_attention') &&
    assessTaskRetry({ status, result: task.result }).canRetry
  )
    actions.push('continueTask');
  if (status === 'done' || status === 'needs_attention') actions.push('completeTask');
  return actions;
}

async function readActionTask(id: string) {
  const db = getDatabase();
  const [task, linked] = await Promise.all([
    getTaskById(db, id),
    db.select({ id: chats.id }).from(chats).where(eq(chats.taskId, id)).limit(1),
  ]);
  if (!task) throw new MobileApiError(404, 'This item no longer exists.');
  return { ...task, linkedChatId: linked[0]?.id ?? null };
}

/** Runs a Queue row action after checking, on the computer, that the task still offers it. */
export async function runMobileTaskAction(request: TaskActionRequest): Promise<{ ok: true }> {
  const task = await readActionTask(request.id);
  if (!mobileTaskActions(task).includes(request.type)) throw new MobileApiError(409, CHANGED);
  if (request.type === 'completeTask') {
    await mobileCallers.tasks.complete({
      taskId: task.id,
      result: { ...parseResultRecord(task.result), summary: 'Marked complete from your phone' },
    });
    return { ok: true };
  }
  requireExecutionReady();
  if (request.type === 'continueTask') await continueTask(task.id);
  else await startTask(task);
  return { ok: true };
}

/** Carry on resumes the task's own session, as desktop's does; without one there is nothing to resume. */
async function continueTask(taskId: string) {
  const { carryOnFlowTask } = await import('../../flows/rerun');
  const result = await carryOnFlowTask(getDatabase(), taskId);
  if (result.ok) return;
  throw new MobileApiError(
    409,
    result.reason === 'no-session'
      ? 'This task can’t carry on where it stopped. Open it in Frink on your computer to run it again.'
      : CHANGED,
  );
}

/** Desktop's Start task: the task runs as an agent now, even if its trigger holds it until started.
 *  Dispatch runs on as the poller's does; a failure is recorded on the task for the Queue to show. */
async function startTask(task: Task) {
  const claimed = await claimTask(getDatabase(), task.id, hostname());
  if (!claimed) throw new MobileApiError(409, CHANGED);
  const { handleClaimedTask } = await import('../../task-executor');
  void handleClaimedTask({
    ...claimed,
    result: { ...parseResultRecord(claimed.result), startMode: 'execute' },
  }).catch(() => {});
}
