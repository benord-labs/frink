import type { TaskMenuStatus } from '../../../../shared/lib/task-recovery/menu-gate';

export {
  assessRowRetry,
  type TaskMenuStatus,
  taskMenuRecovery,
} from '../../../../shared/lib/task-recovery/menu-gate';

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

/** One exit per state: Cancel while the task can still do something, Delete once nothing runs.
 * An interrupted run leaves via Cancel, never a row delete. */
export function canCancelTask(status: TaskMenuStatus): boolean {
  return CANCELLABLE.has(status);
}

export function canDeleteTask(status: TaskMenuStatus): boolean {
  return DELETABLE.has(status);
}
