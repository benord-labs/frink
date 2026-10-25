import log from 'electron-log';
import { captureMainException } from '../../sentry/init';

type FlowActivity = {
  count: number;
  cleanupError?: unknown;
};

type FlowAdmissionLifecycleHooks = {
  reconcile: (flowRunId: string, cleanupError?: unknown) => Promise<void>;
  reconcileTicket: (flowRunId: string, ticket: number) => Promise<void>;
  requestRelease: (flowRunId: string) => Promise<void>;
};

export type FlowResourceActivityRelease = (cleanupError?: unknown) => void;

const activeFlowResources = new Map<string, FlowActivity>();
const scheduledReconciles = new Map<string, NodeJS.Timeout>();
// Timers stop while the machine sleeps, so a long wait re-reads the clock at least this often.
const MAX_SCHEDULE_STEP_MS = 60_000;
const SCHEDULE_MARGIN_MS = 1_000;
let lifecycleHooks: FlowAdmissionLifecycleHooks | null = null;
export function captureFlowAdmissionException(error: unknown, stage: string): void {
  captureMainException(error, { surface: 'flow-admission', stage });
}

type StageSettler = (flowRunId: string) => Promise<void>;
let settleBatchStage: StageSettler | null = null;
/** Batch dispatch registers itself here; importing it from this module would be a cycle. */
export function registerBatchStageSettler(settler: StageSettler): void {
  settleBatchStage = settler;
}

/** A Retry that ends before promotion emits no terminal event, so its batch stage is settled here.
 * The Retry's end has already committed: a failed settle is reported, never thrown. */
export async function settleStageAfterUnpromotedRetry(flowRunId: string): Promise<void> {
  try {
    await settleBatchStage?.(flowRunId);
  } catch (error) {
    log.warn('[FlowAdmission] stage settle after an unpromoted retry failed', { flowRunId, error });
    captureFlowAdmissionException(error, 'batch-terminal-advance');
  }
}
export function setFlowAdmissionLifecycleHooks(hooks: FlowAdmissionLifecycleHooks): void {
  lifecycleHooks = hooks;
}

export function beginFlowResourceActivity(flowRunId: string): FlowResourceActivityRelease {
  const activity = activeFlowResources.get(flowRunId) ?? { count: 0 };
  activity.count += 1;
  activeFlowResources.set(flowRunId, activity);
  let released = false;
  return (cleanupError?: unknown): void => {
    if (released) return;
    released = true;
    if (activeFlowResources.get(flowRunId) !== activity) return;
    if (cleanupError !== undefined && activity.cleanupError === undefined) {
      activity.cleanupError = cleanupError;
    }
    activity.count -= 1;
    if (activity.count > 0) return;

    activeFlowResources.delete(flowRunId);
    if (!lifecycleHooks) {
      log.error('[Flow Admission] Activity settled before lifecycle hooks were registered', {
        flowRunId,
      });
      return;
    }
    void lifecycleHooks.reconcile(flowRunId, activity.cleanupError).catch((error) => {
      log.error('[Flow Admission] Activity reconciliation failed', { flowRunId, error });
      captureFlowAdmissionException(error, 'activity-reconcile');
    });
  };
}

export async function withFlowResourceCleanup<T>(
  flowRunId: string,
  operation: () => T | Promise<T>,
): Promise<T> {
  const release = beginFlowResourceActivity(flowRunId);
  try {
    return await operation();
  } finally {
    // Operation failures are not evidence that provider/resource cleanup failed.
    // Teardown owners report an unconfirmed cleanup explicitly through release(error).
    release();
  }
}

export function hasFlowResourceActivity(flowRunId: string): boolean {
  return (activeFlowResources.get(flowRunId)?.count ?? 0) > 0;
}

/** Re-checks the run's slot for `ticket` once the clock passes `at`; a later call for the run
 * replaces this one. Boot recovery reconciles every held slot, so a restart re-arms it. */
export function scheduleFlowReconcile(flowRunId: string, ticket: number, at: number): void {
  clearTimeout(scheduledReconciles.get(flowRunId));
  const timer = setTimeout(
    () => {
      if (Date.now() < at) return scheduleFlowReconcile(flowRunId, ticket, at);
      scheduledReconciles.delete(flowRunId);
      void lifecycleHooks?.reconcileTicket(flowRunId, ticket).catch((error) => {
        log.error('[Flow Admission] Scheduled reconciliation failed', { flowRunId, error });
        captureFlowAdmissionException(error, 'scheduled-reconcile');
      });
    },
    Math.min(Math.max(0, at - Date.now()) + SCHEDULE_MARGIN_MS, MAX_SCHEDULE_STEP_MS),
  );
  timer.unref();
  scheduledReconciles.set(flowRunId, timer);
}
