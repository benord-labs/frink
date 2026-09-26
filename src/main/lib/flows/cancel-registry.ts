/**
 * Per-flow-run AbortController registry. cancelFlowRun() looks up the set and
 * aborts every controller; node dispatch registers controllers before launching
 * any abortable work and unregisters in `finally`.
 * Keyed by flow run rather than node run, so one cancel fans out to every in-flight node.
 */

const flowRunControllers = new Map<string, Set<AbortController>>();
const flowRunCancellationDepth = new Map<string, number>();

type PendingAbortRegistration = {
  settled: Promise<void>;
  settle: () => void;
};

const pendingAbortRegistrations = new Map<string, Set<PendingAbortRegistration>>();

/**
 * Reserves a node-controller registration and its dispatch handoff. The returned release must travel
 * with that dispatch and run immediately after its controller is registered. It is also an idempotent
 * fallback when dispatch fails before installing a controller.
 */
export function reserveNodeAbortRegistration(flowRunId: string): (() => void) | null {
  if (flowRunCancellationDepth.has(flowRunId)) return null;
  let resolve!: () => void;
  let live = true;
  const settled = new Promise<void>((done) => (resolve = done));
  const reservation: PendingAbortRegistration = {
    settled,
    settle: () => {
      if (!live) return;
      live = false;
      const pending = pendingAbortRegistrations.get(flowRunId);
      pending?.delete(reservation);
      if (pending?.size === 0) pendingAbortRegistrations.delete(flowRunId);
      resolve();
    },
  };
  const pending = pendingAbortRegistrations.get(flowRunId) ?? new Set();
  pending.add(reservation);
  pendingAbortRegistrations.set(flowRunId, pending);
  return reservation.settle;
}

export function registerNodeAbort(flowRunId: string, controller: AbortController): void {
  if (flowRunCancellationDepth.has(flowRunId)) {
    controller.abort();
    return;
  }
  let set = flowRunControllers.get(flowRunId);
  if (!set) {
    set = new Set();
    flowRunControllers.set(flowRunId, set);
  }
  set.add(controller);
}

export function unregisterNodeAbort(flowRunId: string, controller: AbortController): void {
  const set = flowRunControllers.get(flowRunId);
  if (!set) return;
  set.delete(controller);
  if (set.size === 0) flowRunControllers.delete(flowRunId);
}

export function abortFlowRun(flowRunId: string): number {
  const set = flowRunControllers.get(flowRunId);
  if (!set) return 0;
  let count = 0;
  for (const controller of set) {
    if (!controller.signal.aborted) {
      controller.abort();
      count += 1;
    }
  }
  flowRunControllers.delete(flowRunId);
  return count;
}

function releaseFlowRunCancellation(flowRunId: string): void {
  const remaining = (flowRunCancellationDepth.get(flowRunId) ?? 1) - 1;
  if (remaining > 0) flowRunCancellationDepth.set(flowRunId, remaining);
  else flowRunCancellationDepth.delete(flowRunId);
}

/** Drains dispatch handoffs, then blocks new registrations for one synchronous ownership write. */
export async function withFlowRunCancellationGuard<T>(
  flowRunId: string,
  persist: () => T,
): Promise<T> {
  while (pendingAbortRegistrations.has(flowRunId)) {
    const pending = [...(pendingAbortRegistrations.get(flowRunId) ?? [])];
    await Promise.all(pending.map(({ settled }) => settled));
  }
  flowRunCancellationDepth.set(flowRunId, (flowRunCancellationDepth.get(flowRunId) ?? 0) + 1);
  try {
    return persist();
  } finally {
    releaseFlowRunCancellation(flowRunId);
  }
}

/** Keeps late provider registrations aborted until the durable cancellation write settles. */
export async function withFlowRunCancellation<T>(
  flowRunId: string,
  persist: () => Promise<T>,
): Promise<T> {
  flowRunCancellationDepth.set(flowRunId, (flowRunCancellationDepth.get(flowRunId) ?? 0) + 1);
  abortFlowRun(flowRunId);
  try {
    const pending = [...(pendingAbortRegistrations.get(flowRunId) ?? [])];
    if (pending.length > 0) await Promise.all(pending.map(({ settled }) => settled));
    return await persist();
  } finally {
    releaseFlowRunCancellation(flowRunId);
  }
}
