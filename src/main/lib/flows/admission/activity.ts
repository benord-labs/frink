import log from 'electron-log';
import { captureMainException } from '../../sentry/init';

type FlowActivity = {
  count: number;
  cleanupError?: unknown;
};

type FlowAdmissionLifecycleHooks = {
  reconcile: (flowRunId: string, cleanupError?: unknown) => Promise<void>;
  requestRelease: (flowRunId: string) => Promise<void>;
};

export type FlowResourceActivityRelease = (cleanupError?: unknown) => void;

const activeFlowResources = new Map<string, FlowActivity>();
let lifecycleHooks: FlowAdmissionLifecycleHooks | null = null;
export function captureFlowAdmissionException(error: unknown, stage: string): void {
  captureMainException(error, { surface: 'flow-admission', stage });
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
