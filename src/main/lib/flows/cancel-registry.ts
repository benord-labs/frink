/**
 * Per-flow-run AbortController registry. cancelFlowRun() looks up the set and
 * aborts every controller; node dispatch registers controllers before launching
 * any abortable work and unregisters in `finally`.
 * Keyed by flow run rather than node run, so one cancel fans out to every in-flight node.
 */

const flowRunControllers = new Map<string, Set<AbortController>>();

export function registerNodeAbort(flowRunId: string, controller: AbortController): void {
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
