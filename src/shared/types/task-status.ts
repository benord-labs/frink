/**
 * Canonical task status union for the UI.
 *
 * These are the persisted DB statuses. WorkQueueTaskStatus is a deliberate SUPERSET — it also
 * includes DERIVED display statuses (e.g. `interrupted`) that are never written to `tasks.status`;
 * the split is enforced by `task-status-parity.test.ts`.
 *
 * **Settled workflow:** Agent/run stops at `'done'` first — execution finished, awaiting user
 * review (UI: "Ready for review"); moving to `'completed'` is the user-confirmed terminal step.
 * `updateTaskStatus` stamps `completed_at` at `done` as well as at `completed`, so rely on
 * `status` to tell the two apart. New code must not treat them interchangeably.
 */

export type TaskStatus =
  | 'pending'
  | 'running'
  | 'plan_ready'
  | 'needs_attention'
  | 'done' // Execution finished (typ. running → done); awaiting user review — not user-confirmed
  | 'completed' // Terminal: user confirmed the outcome (from running, needs_attention, or done)
  | 'failed'
  | 'cancelled';

/** Runtime check for strings from IPC or other untrusted boundaries (aligns with {@link TaskStatus}). */
const TASK_STATUS_VALUES = [
  'pending',
  'running',
  'plan_ready',
  'needs_attention',
  'done',
  'completed',
  'failed',
  'cancelled',
] as const satisfies readonly TaskStatus[];

const taskStatusValueSet = new Set<string>(TASK_STATUS_VALUES);

export function isValidTaskStatus(value: string): value is TaskStatus {
  return taskStatusValueSet.has(value);
}
