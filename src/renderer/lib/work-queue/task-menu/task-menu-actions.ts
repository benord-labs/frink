import type { TaskMenuStatus } from '../../../../shared/lib/task-recovery/menu-gate';

export {
  assessRowRetry,
  type TaskMenuStatus,
  taskMenuRecovery,
} from '../../../../shared/lib/task-recovery/menu-gate';

type MenuTask = { result?: { chatId?: string } | null; linkedChatId?: string | null };

const CANCELLABLE: ReadonlySet<TaskMenuStatus> = new Set([
  'running',
  'plan_ready',
  'needs_attention',
  'interrupted',
]);
const DELETABLE: ReadonlySet<TaskMenuStatus> = new Set([
  'completed',
  'cancelled',
  'failed',
  'done',
]);

function taskHasChat(task: MenuTask): boolean {
  return !!task.result?.chatId || !!task.linkedChatId;
}

/** A pending task without a chat has not run yet, so it can be started. */
export function canStartTask(task: MenuTask, status: TaskMenuStatus): boolean {
  return status === 'pending' && !taskHasChat(task);
}

/** One exit per state: Cancel while the task can still do something, Delete once nothing runs.
 * An interrupted run leaves via Cancel, never a row delete. */
export function canCancelTask(task: MenuTask, status: TaskMenuStatus): boolean {
  return CANCELLABLE.has(status) || (status === 'pending' && taskHasChat(task));
}

export function canDeleteTask(task: MenuTask, status: TaskMenuStatus): boolean {
  return DELETABLE.has(status) || canStartTask(task, status);
}
