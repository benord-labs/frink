import type { RecoveryKind } from '../../types/flow-run/resume';
import type { TaskStatus } from '../../types/task-status';
import { assessTaskRetry } from '../task-retry-policy';

/** A queue row's DISPLAY status: the persisted TaskStatus plus derived `interrupted`. */
export type TaskMenuStatus = TaskStatus | 'interrupted';

type RecoverableTask = { status?: string; result?: unknown; recoveryKind?: RecoveryKind };

const RETRYABLE: ReadonlySet<string> = new Set<TaskMenuStatus>(['failed', 'needs_attention']);

/** The one recovery a row offers, if any. An interrupted row's kind is its run's marked step's. */
export function taskMenuRecovery(task: RecoverableTask, status: string): RecoveryKind | undefined {
  const canRecover =
    status === 'interrupted' || (RETRYABLE.has(status) && assessTaskRetry(task).canRetry);
  return canRecover ? task.recoveryKind : undefined;
}

/** A row its run recovers (interrupted, or failed on a later step) shows an earlier step's raw
 * status, so only a row whose own task stopped is assessed. */
export function assessRowRetry(
  row: RecoverableTask & { status: string; effectiveStatus?: string },
): ReturnType<typeof assessTaskRetry> {
  const ownTaskStopped = row.effectiveStatus !== 'interrupted' && RETRYABLE.has(row.status);
  return ownTaskStopped ? assessTaskRetry(row) : { canRetry: true, remediation: null };
}
