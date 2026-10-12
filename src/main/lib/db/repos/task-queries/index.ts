/**
 * Shared SQL fragments for reading tasks — the pieces the list and count paths both need, kept out
 * of tasks.ts so that file stays inside its size ratchet and each fragment is findable on its own.
 */

export { effectiveStatusExpr, isFlowRepresentative } from './flow-collapse';
export {
  getWorkQueueSectionFilter,
  isWaitModeTask,
  type WorkQueueSection,
} from './work-queue-overview-filter';
export {
  beforeQueueCursor,
  getQueueTaskRow,
  selectQueueTaskRows,
  type TaskListCursor,
  type TaskWithProjectRow,
  toQueueTaskRow,
} from './queue-row';
