// A save completing must not delete the crash draft of edits typed while it was in flight.

import { type FlowGraph, flowGraphsEqual } from '../../../../shared/lib/validate-flow-graph';
import { deleteFlowDraft, type FlowGraphDraft, saveFlowDraft } from '../../flow-drafts';

export type DraftAfterSaveInput = {
  /** The working copy right now, unprocessed — what a restored draft should hold. */
  currentGraph: FlowGraph;
  /** The working copy in save form, comparable with `savedGraph`. */
  currentGraphToSave: FlowGraph;
  /** The graph the completed save persisted. */
  savedGraph: FlowGraph;
  /** The version the save produced; the draft's new baseline. */
  savedVersion: number;
  now: number;
};

/** The draft to keep after a save, or null when the working copy is exactly what was saved. */
export function resolveDraftAfterSave({
  currentGraph,
  currentGraphToSave,
  savedGraph,
  savedVersion,
  now,
}: DraftAfterSaveInput): FlowGraphDraft | null {
  if (flowGraphsEqual(currentGraphToSave, savedGraph)) return null;
  return { graph: currentGraph, baselineVersion: savedVersion, updatedAt: now };
}

/** Keep or drop the crash draft after a save (edits typed during it survive); true when kept. */
export function persistDraftAfterSave(flowId: string, input: DraftAfterSaveInput): boolean {
  const draft = resolveDraftAfterSave(input);
  if (draft) saveFlowDraft(flowId, draft);
  else deleteFlowDraft(flowId);
  return draft !== null;
}
