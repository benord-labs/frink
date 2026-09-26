/**
 * Redaction-safe semantic receipt for a Flow graph patch.
 *
 * The MCP response still contains the full graph for agents. Chat renderers must
 * prefer this projection so node config, instructions, paths, and secret-like
 * values never become presentation copy by accident.
 */

export type FlowChangeMode = 'create' | 'update';

export const FLOW_PATCH_VERSION_CONFLICT_CODE = 'FLOW_VERSION_CONFLICT' as const;

/** Short user-voice summaries paired with the full agent-facing permission message. */
export const FLOW_PERMISSION_SUMMARIES = {
  staleContext: 'This Flow request expired. Retry it from the current turn.',
  missingProject: 'Flow changes need an active project. Open this chat in a project and retry.',
  timedOut: 'Permission request timed out. Retry the Flow change.',
  denied: 'Permission was not approved. Nothing changed.',
  blocked: 'Frink permissions blocked this Flow change. Review the agent response for details.',
  /** Per-flow agent-run consent card is up and unanswered (unattended runs). */
  consentPending: 'Waiting for you to allow the agent to run this Flow.',
  /** The consent card could not be delivered at all — no decision was made. */
  consentUnavailable: "Frink couldn't ask you to approve this Flow run. Nothing ran.",
  /** Approved, but a sibling call in the same turn already used the single run. */
  consentSuperseded: 'Your approval covered one run, which another step already started.',
  /** The batch grew after the card was raised, so the approval no longer fits. */
  consentBatchChanged:
    'This batch grew after you were asked — nothing ran. You will be asked again.',
} as const;

export type FlowChangeAction = 'add' | 'update' | 'remove';

export type FlowChangeKind = 'node' | 'edge' | 'settings';

export type FlowChangeOperationStatus =
  | 'pending'
  | 'applied'
  | 'failed'
  | 'skipped'
  | 'unchanged'
  | 'unknown';

/**
 * Closed, redaction-safe classification of why a patch operation did not apply.
 * `cascade-removed` is benign — the graph already matches the caller's intent — so it
 * never warrants a retry; the others do or signal an authoring error.
 */
export const FLOW_PATCH_REASON_CODES = [
  'cascade-removed',
  'dependency-failed',
  'stale-parent',
] as const;

export type FlowPatchReasonCode = (typeof FLOW_PATCH_REASON_CODES)[number];

export type FlowSemanticChange = {
  operationIndex: number;
  action: FlowChangeAction;
  kind: FlowChangeKind;
  status: FlowChangeOperationStatus;
  reasonCode?: FlowPatchReasonCode;
  label: string;
  detail?: string;
  nodeId?: string;
  edgeId?: string;
  relatedNodeIds?: string[];
  blockType?: string;
};

export type FlowPatchChangeSummary = {
  schemaVersion: 1;
  mode: FlowChangeMode;
  baseVersionNumber: number;
  versionNumber: number;
  changes: FlowSemanticChange[];
};

export type FlowChangePhase =
  | 'proposed'
  | 'applying'
  | 'applied'
  | 'partial'
  | 'unchanged'
  | 'failed'
  | 'unconfirmed'
  | 'denied'
  | 'stale'
  | 'interrupted';

export type FlowChangeGraphNode = {
  id: string;
  label: string;
  blockType: string;
  changeStatus?: FlowChangeOperationStatus;
  changeAction?: FlowChangeAction;
};

export type FlowChangeGraphEdge = {
  id: string;
  source: string;
  target: string;
  sourceHandle?: string;
  label?: string;
  changeStatus?: FlowChangeOperationStatus;
  changeAction?: FlowChangeAction;
};

export type FlowChangeGraph = {
  nodes: FlowChangeGraphNode[];
  edges: FlowChangeGraphEdge[];
};

export type FlowChangePresentation = {
  flowId?: string;
  name: string;
  mode: FlowChangeMode;
  phase: FlowChangePhase;
  denialReason?: string;
  baseVersionNumber?: number;
  versionNumber?: number;
  graph?: FlowChangeGraph;
  changes: FlowSemanticChange[];
  warningCount: number;
};
