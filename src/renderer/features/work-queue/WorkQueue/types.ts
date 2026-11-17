import type { RecoveryKind } from '../../../../shared/types/flow-run/resume';
import type { TaskResultRecord } from '../../../../shared/types/task-result';

export type PaginatedCursor = { createdAt: string; id: string };
export type WorkQueueTaskStatus =
  | 'pending'
  | 'running'
  | 'plan_ready'
  | 'needs_attention'
  | 'done'
  | 'completed'
  | 'failed'
  | 'cancelled'
  // Derived by effectiveStatusExpr; never persisted.
  | 'interrupted';

export type WorkQueueTaskRow = {
  id: string;
  title?: string | null;
  description: string | null;
  status: WorkQueueTaskStatus;
  /** Per-flow display status; raw status remains mutation truth. */
  effectiveStatus?: WorkQueueTaskStatus;
  source: string;
  result: TaskResultRecord | null;
  createdAt: string;
  startedAt?: string | null;
  completedAt?: string | null;
  needsAttentionAt?: string | null;
  projectName?: string | null;
  projectId?: string | null;
  flowRunId?: string | null;
  linkedChatId?: string | null;
  triggerContext?: TaskResultRecord | null;
  /** The one recovery action of a stopped (failed / attention-parked) task whose run is not live. */
  recoveryKind?: RecoveryKind;
  /** Its Retry re-runs a started non-agent step, so it confirms first. */
  confirmSideEffects?: boolean;
  /** The step attempt a run-level recovery acts on. */
  recoveryNodeRunId?: string;
};

export type PaginatedTasksPayload = {
  items: WorkQueueTaskRow[];
  hasMore: boolean;
  nextCursor: PaginatedCursor | null;
};
