/**
 * Routing for the Flow editor's Run button (and run-hotkey).
 *
 * A flow with a CURRENT BATCH always dispatches via the batch so each run carries its
 * own trigger_context; a single run (triggerContext null) is only correct when there is
 * NO batch — otherwise {{trigger.*}} renders literally in the chat title / agent prompt.
 * startBatch safely no-ops once the batch's roots are started, so re-running an already-
 * dispatched batch never falls through to a context-less single run.
 *
 * Extracted (and dependency-injected) so the decision + dispatch wiring is unit-testable
 * without rendering the FlowEditor component.
 */

export type FlowRunDispatchHandlers = {
  startBatch: (batchId: string) => void;
  runSingle: () => void;
};

export function dispatchFlowRun(
  currentBatchId: string | null | undefined,
  handlers: FlowRunDispatchHandlers,
): void {
  if (currentBatchId) {
    handlers.startBatch(currentBatchId);
    return;
  }
  handlers.runSingle();
}
