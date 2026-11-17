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

import { stuckConditionLoops } from '../../../shared/lib/flows/graph/condition-loops';
import {
  formatFlowNodeLabel,
  normalizeFlowGraph,
  validateGraph,
} from '../../../shared/lib/validate-flow-graph';

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

/**
 * Stuck-loop blocker from the graphs that may be the saved version Run executes (never the draft).
 * Unloaded or invalid graphs are skipped; the server rejects those anyway.
 */
export function savedVersionRunBlocker(...savedGraphs: unknown[]): string | null {
  for (const raw of savedGraphs) {
    const graph = normalizeFlowGraph(raw);
    if (!graph || !validateGraph(graph).valid) continue;
    const [message] = stuckConditionLoops(graph.nodes, graph.edges, formatFlowNodeLabel).messages;
    if (message) return message;
  }
  return null;
}

/** What the editor knows when Run (button or hotkey) is asked to start. */
export type EditorRunState = {
  hasManualTrigger: boolean;
  /** Saved version number; 0 until the flow is first saved. */
  baselineVersion: number;
  flowEnabled: boolean;
  /** Graphs that may be the version Run executes (see `savedVersionRunBlocker`). */
  savedGraphs: unknown[];
};

/** Why the editor's Run must not start, as the toast to show; null when it may. */
export function editorRunBlocker(state: EditorRunState): string | null {
  if (!state.hasManualTrigger) {
    return 'Run is only available for flows that start with a manual trigger.';
  }
  if (state.baselineVersion < 1) return 'Save your flow before running.';
  if (!state.flowEnabled) {
    return 'This flow is paused. Enable it in Flow settings or the flows list to run.';
  }
  return savedVersionRunBlocker(...state.savedGraphs);
}
