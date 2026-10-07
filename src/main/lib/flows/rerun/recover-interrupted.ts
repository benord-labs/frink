/** Continue every run a restart interrupted in one action, each through its own recovery. */

import type {
  BulkRecoverResult,
  RecoverOutcome,
  RecoveryKind,
} from '../../../../shared/types/flow-run/resume';
import type { getDatabase } from '../../db';
import { getTaskById } from '../../db/repos/tasks';
import { isRestartInterrupted } from '../transitions';
import { resolveSettledRunRecoveries } from './recovery-kind';

type Db = ReturnType<typeof getDatabase>;

export type InterruptedRecoveryItem = {
  taskId: string;
  kind: RecoveryKind;
  recoveryNodeRunId?: string;
};

/** The single-row recovery each chat's button runs; it re-checks the step and kind itself. */
export type RecoverOne = (
  taskId: string,
  kind: RecoveryKind,
  recoveryNodeRunId: string,
) => Promise<RecoverOutcome>;

export type RecoverInterruptedDeps = {
  recoverOne: RecoverOne;
  /** A resume already waits for the run: a queued ticket (startup queues some) or a staged one. */
  hasQueuedResume: (flowRunId: string) => Promise<boolean>;
};

const STEP_CHANGED = 'This step changed — refresh and try again';
const NOT_INTERRUPTED = 'No longer interrupted';
const NEEDS_CONFIRMATION = 'Its step had started and may repeat what it did; confirm it on its own';

/** One at a time, so tickets queue behind the run limit in the order the user saw them. */
export async function recoverInterruptedRuns(
  db: Db,
  items: readonly InterruptedRecoveryItem[],
  deps: RecoverInterruptedDeps,
): Promise<BulkRecoverResult[]> {
  const results: BulkRecoverResult[] = [];
  for (const item of items) results.push(await recoverItem(db, item, deps));
  return results;
}

async function recoverItem(
  db: Db,
  item: InterruptedRecoveryItem,
  { recoverOne, hasQueuedResume }: RecoverInterruptedDeps,
): Promise<BulkRecoverResult> {
  const task = await getTaskById(db, item.taskId);
  const flowRunId = task?.flowRunId ?? null;
  const refuse = (reason: string): BulkRecoverResult => ({
    taskId: item.taskId,
    flowRunId,
    outcome: 'refused',
    reason,
  });
  if (!task) return refuse('Task not found');
  if (!flowRunId || !isRestartInterrupted(db, flowRunId)) return refuse(NOT_INTERRUPTED);
  // Its queued ticket may carry no recovery kind, which a click's ticket would not merge into. A run
  // that only holds its slot is not queued: recoverOne stages it behind that slot.
  if (await hasQueuedResume(flowRunId)) {
    return { taskId: item.taskId, flowRunId, outcome: 'already-queued' };
  }
  const step = resolveSettledRunRecoveries(db, [{ id: flowRunId, status: 'cancelled' }]).get(
    flowRunId,
  );
  if (!step) return refuse(NOT_INTERRUPTED);
  const moved = item.recoveryNodeRunId !== undefined && item.recoveryNodeRunId !== step.nodeRunId;
  if (moved || step.kind !== item.kind) return refuse(STEP_CHANGED);
  if (step.confirmSideEffects) {
    return {
      taskId: item.taskId,
      flowRunId,
      outcome: 'needs-confirmation',
      reason: NEEDS_CONFIRMATION,
    };
  }
  try {
    const outcome = await recoverOne(item.taskId, step.kind, step.nodeRunId);
    return { taskId: item.taskId, flowRunId, outcome };
  } catch (error) {
    return refuse(error instanceof Error ? error.message : String(error));
  }
}
