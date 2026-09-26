/**
 * Local draft store for in-progress Flow graph edits.
 *
 * Persists the working graph per flowId in localStorage so leaving the editor never loses unsaved
 * work and never needs a destructive "discard changes?" prompt. A draft is transient UI working
 * state, NOT a flow version — explicit Save still cuts the real version (and clears the draft).
 *
 * One localStorage entry holds a `Record<flowId, FlowGraphDraft>`; mirrors the agents draft pattern
 * (features/agents/lib/drafts.ts) minus the attachment/blob machinery a graph doesn't need.
 */
import type { FlowGraph } from '../../shared/lib/validate-flow-graph';

const FLOW_DRAFTS_KEY = 'flow-graph-drafts';
const MAX_FLOW_DRAFT_BYTES = 2 * 1024 * 1024; // 2MB safe limit for the whole map

export type FlowGraphDraft = {
  graph: FlowGraph;
  /** version_number the draft was forked from — used for drift detection on restore. */
  baselineVersion: number;
  updatedAt: number;
};

type FlowDraftsMap = Record<string, FlowGraphDraft>;

function loadFlowDraftsMap(): FlowDraftsMap {
  if (typeof window === 'undefined') return {};
  try {
    const stored = localStorage.getItem(FLOW_DRAFTS_KEY);
    const parsed = stored ? JSON.parse(stored) : {};
    return parsed && typeof parsed === 'object' ? (parsed as FlowDraftsMap) : {};
  } catch {
    return {};
  }
}

function writeFlowDraftsMap(map: FlowDraftsMap): void {
  if (typeof window === 'undefined') return;
  try {
    localStorage.setItem(FLOW_DRAFTS_KEY, JSON.stringify(map));
  } catch {
    // localStorage full / unavailable — drafts are best-effort, drop silently.
  }
}

export function loadFlowDraft(flowId: string): FlowGraphDraft | null {
  return loadFlowDraftsMap()[flowId] ?? null;
}

/** flowIds that currently have a local draft — one map read, for the dashboard "Unsaved changes" pill. */
export function loadFlowDraftIds(): Set<string> {
  return new Set(Object.keys(loadFlowDraftsMap()));
}

export function saveFlowDraft(flowId: string, draft: FlowGraphDraft): void {
  const next = { ...loadFlowDraftsMap(), [flowId]: draft };
  // Reject an over-budget write without corrupting the existing map (UTF-16 = 2 bytes/char).
  if (JSON.stringify(next).length * 2 > MAX_FLOW_DRAFT_BYTES) return;
  writeFlowDraftsMap(next);
}

export function deleteFlowDraft(flowId: string): void {
  const map = loadFlowDraftsMap();
  if (!(flowId in map)) return;
  delete map[flowId];
  writeFlowDraftsMap(map);
}
