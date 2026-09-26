/**
 * "Delete all" policy for the work queue's terminal History view: which statuses a bulk delete
 * matches and how many rows to warn about. Pure policy, no markup, so it stays independently
 * readable and testable.
 */

/** Matches tRPC `tasks.deleteMatching` / Railway bulk delete (excludes `running`). */
export type BulkDeleteTaskStatus =
  | 'pending'
  | 'plan_ready'
  | 'needs_attention'
  | 'done'
  | 'completed'
  | 'failed'
  | 'cancelled';

/** The terminal statuses rendered by standalone History and targeted by its bulk delete. */
export const HISTORY_TASK_STATUSES = [
  'completed',
  'cancelled',
] as const satisfies readonly BulkDeleteTaskStatus[];

type TaskCountsLite = {
  completed?: number;
  cancelled?: number;
};

const toTarget = (
  statuses: readonly BulkDeleteTaskStatus[],
  estimateCount: number,
): { statuses: BulkDeleteTaskStatus[]; estimateCount: number } | null =>
  estimateCount === 0 ? null : { statuses: [...statuses], estimateCount };

/** Standalone History is a single chronological view, so its bulk action covers both terminal rows. */
export function getHistoryDeleteAllTarget(
  counts: TaskCountsLite | undefined,
): { statuses: BulkDeleteTaskStatus[]; estimateCount: number } | null {
  return toTarget(HISTORY_TASK_STATUSES, (counts?.completed ?? 0) + (counts?.cancelled ?? 0));
}
