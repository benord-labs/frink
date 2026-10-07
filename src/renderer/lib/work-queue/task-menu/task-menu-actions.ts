import { assessTaskRetry } from '../../../../shared/lib/task-retry-policy';
import type { RecoveryKind } from '../../../../shared/types/flow-run/resume';
import type { TaskStatus } from '../../../../shared/types/task-status';

/** A queue row's DISPLAY status: the persisted TaskStatus plus derived `interrupted`. */
export type TaskMenuStatus = TaskStatus | 'interrupted';

type RecoverableTask = { status?: string; result?: unknown; recoveryKind?: RecoveryKind };
type MenuTask = { result?: { chatId?: string } | null; linkedChatId?: string | null };

const RETRYABLE: ReadonlySet<TaskMenuStatus> = new Set(['failed', 'needs_attention']);
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

/** The one recovery a row offers, if any. An interrupted row's kind is its run's marked step's. */
export function taskMenuRecovery(
  task: RecoverableTask,
  status: TaskMenuStatus,
): RecoveryKind | undefined {
  const canRecover =
    status === 'interrupted' || (RETRYABLE.has(status) && assessTaskRetry(task).canRetry);
  return canRecover ? task.recoveryKind : undefined;
}

/** A row its run recovers (interrupted, or failed on a later step) shows an earlier step's raw
 * status, so only a row whose own task stopped is assessed. */
export function assessRowRetry(
  row: RecoverableTask & { status: TaskMenuStatus; effectiveStatus?: TaskMenuStatus },
): ReturnType<typeof assessTaskRetry> {
  const ownTaskStopped = row.effectiveStatus !== 'interrupted' && RETRYABLE.has(row.status);
  return ownTaskStopped ? assessTaskRetry(row) : { canRetry: true, remediation: null };
}

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
