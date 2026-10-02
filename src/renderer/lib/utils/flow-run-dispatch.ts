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
  startBatch: (batchId: string, hadUnsavedChanges: boolean) => void;
  runSingle: (hadUnsavedChanges: boolean) => void;
};

/** `hadUnsavedChanges` is captured at dispatch, so a save landing mid-flight can't change the copy. */
export function dispatchFlowRun(
  currentBatchId: string | null | undefined,
  handlers: FlowRunDispatchHandlers,
  hadUnsavedChanges = false,
): void {
  if (currentBatchId) {
    handlers.startBatch(currentBatchId, hadUnsavedChanges);
    return;
  }
  handlers.runSingle(hadUnsavedChanges);
}

/** Run executes the latest SAVED version, never the draft: say so when the canvas is dirty. */
const UNSAVED_SUFFIX = "your unsaved edits aren't included";

export const UNSAVED_RUN_TITLE = `Runs the last saved version — ${UNSAVED_SUFFIX}`;

/** Batch runs are pinned to a saved version the start response does not name. */
export function batchStartedMessage(hadUnsavedChanges: boolean): string {
  return hadUnsavedChanges
    ? `Batch started on the saved version — ${UNSAVED_SUFFIX}`
    : 'Batch started';
}

export function runStartedMessage({
  status,
  versionNumber,
  hadUnsavedChanges,
}: {
  status: string;
  versionNumber: number | null | undefined;
  hadUnsavedChanges: boolean;
}): string {
  const verb = status === 'pending' ? 'Run queued' : 'Run started';
  if (!hadUnsavedChanges) return verb;
  const target = versionNumber != null ? `saved v${versionNumber}` : 'the saved version';
  return `${verb} on ${target} — ${UNSAVED_SUFFIX}`;
}
