import type {
  FlowChangeGraph,
  FlowChangePhase,
  FlowChangePresentation,
  FlowPatchReasonCode,
  FlowSemanticChange,
} from '../../../../shared/types/flows/flow-change-presentation';
import { selectAffectedFlowTopology } from '../flow-change-topology';
import {
  attachOutlineChanges,
  buildDisplayGraph,
  buildGraphIndex,
  byOperation,
  truthfulGraph,
} from './graph';
import { buildOutlineRoute, type FlowOutlineRoute } from './route';

export type { FlowOutlineRoute, FlowOutlineStep, FlowOutlineTerminal } from './route';

const FULL_FLOW_NODE_LIMIT = 10;

/** Redaction-safe, presentation-ready hierarchy derived only from the semantic receipt. */
export type FlowChangeOutlineModel = {
  heading: string;
  scope: 'full' | 'neighborhood' | 'changes-only';
  routes: FlowOutlineRoute[];
  settingsChanges: FlowSemanticChange[];
  unplacedChanges: FlowSemanticChange[];
  omittedNodeCount: number;
  omittedRouteCount: number;
  synopsis?: string;
  totalNodeCount: number;
  branchCount: number;
};

const ACTION_NOUN: Record<FlowSemanticChange['action'], string> = {
  add: 'addition',
  remove: 'removal',
  update: 'update',
};

const APPLIED_ACTION_COPY: Record<FlowSemanticChange['action'], string> = {
  add: 'added',
  remove: 'removed',
  update: 'updated',
};

const STATUS_ACTION_COPY: Partial<Record<FlowSemanticChange['status'], (noun: string) => string>> =
  {
    failed: (noun) => `${noun} not applied`,
    skipped: (noun) => `${noun} not applied`,
    pending: (noun) => `${noun} requested`,
    unknown: (noun) => `${noun} attempted`,
    unchanged: () => 'already current',
  };

type ChangeCopy = (target: string) => string;

const MUTATION_STATUS_COPY: Partial<
  Record<FlowSemanticChange['status'], Record<FlowSemanticChange['action'], ChangeCopy>>
> = {
  pending: {
    add: (target) => `Will add ${target}`,
    remove: (target) => `Will remove ${target}`,
    update: (target) => `Will change ${target}`,
  },
  failed: {
    add: (target) => `Could not add ${target}`,
    remove: (target) => `Could not remove ${target}`,
    update: (target) => `Could not change ${target}`,
  },
  skipped: {
    add: (target) => `Did not add ${target}`,
    remove: (target) => `Did not remove ${target}`,
    update: (target) => `Did not change ${target}`,
  },
};

/**
 * Replaces the generic status phrase when the receipt knows why an operation did not apply.
 * Looked up defensively: receipts are replayed from stored chat history, so a code written by a
 * different build must degrade to the status copy rather than break the render.
 */
const REASON_COPY = {
  'cascade-removed': (target: string) =>
    `No change needed — ${target} was already removed with an earlier step`,
  'dependency-failed': (target: string) =>
    `Skipped — ${target} needed a step that could not be added`,
  'stale-parent': (target: string) =>
    `Could not add ${target} — it must sit inside a Fan Out step in this Flow`,
} satisfies Record<FlowPatchReasonCode, ChangeCopy>;

const UNKNOWN_ACTION_COPY: Record<FlowSemanticChange['action'], ChangeCopy> = {
  add: (target) => `Could not confirm adding ${target}`,
  remove: () => 'Could not confirm removal from this Flow',
  update: (target) => `Could not confirm the change to ${target}`,
};

const UPDATED_STEP_STATUS_COPY: Partial<
  Record<FlowSemanticChange['status'], (label: string) => string>
> = {
  unchanged: (label) => `${label} is already current`,
  unknown: (label) => `Update attempted for ${label}`,
};

function headingForPhase(phase: FlowChangePhase): string {
  if (phase === 'proposed' || phase === 'applying') return 'Requested flow';
  if (phase === 'partial') return 'Saved flow';
  if (phase === 'failed' || phase === 'denied' || phase === 'stale') {
    return 'Changes not applied';
  }
  if (phase === 'unconfirmed' || phase === 'interrupted') return 'Attempted layout';
  return 'Resulting flow';
}

function actionCopy(change: FlowSemanticChange): string {
  return (
    STATUS_ACTION_COPY[change.status]?.(ACTION_NOUN[change.action]) ??
    APPLIED_ACTION_COPY[change.action]
  );
}

function usefulDetail(change: FlowSemanticChange): string | undefined {
  const detail = change.detail?.trim();
  if (!detail) return undefined;
  const genericDetail =
    (change.kind === 'edge' && detail.toLowerCase() === 'route') ||
    (change.kind === 'node' && detail.toLowerCase() === 'step') ||
    (change.kind === 'settings' && detail.toLowerCase() === 'settings');
  return genericDetail ? undefined : detail;
}

function joinDetails(details: string[]): string {
  if (details.length <= 1) return details[0] ?? '';
  return `${details.slice(0, -1).join(', ')} and ${details.at(-1)}`;
}

function friendlyFlowChangeDetail(change: FlowSemanticChange): string | undefined {
  const detail = usefulDetail(change);
  if (!detail) return undefined;
  return joinDetails(
    detail.split(' · ').map((item) => {
      const trimmed = item.trim();
      if (trimmed === 'Step label') return 'step name';
      if (trimmed === 'Step setup') return 'step settings';
      if (trimmed === 'Other step setup') return 'other step settings';
      return `${trimmed.charAt(0).toLowerCase()}${trimmed.slice(1)}`;
    }),
  );
}

function changeTarget(change: FlowSemanticChange): string {
  const detail = friendlyFlowChangeDetail(change);
  if (detail) return detail;
  if (change.kind === 'edge') return 'this connection';
  if (change.kind === 'settings') return 'flow settings';
  return 'this step';
}

export function describeFlowChange(change: FlowSemanticChange): string {
  const target = changeTarget(change);
  // A reason only explains an operation that did not apply; on any other status a stored receipt
  // is self-inconsistent, so the status copy is the truthful reading.
  const explainsFailure = change.status === 'failed' || change.status === 'skipped';
  const reasonCopy =
    explainsFailure && change.reasonCode ? REASON_COPY[change.reasonCode] : undefined;
  if (reasonCopy) return reasonCopy(target);
  const mutationCopy = MUTATION_STATUS_COPY[change.status]?.[change.action];
  if (mutationCopy) return mutationCopy(target);
  if (change.status === 'unknown') return UNKNOWN_ACTION_COPY[change.action](target);
  if (change.status === 'unchanged') return `${target} is already current`;
  if (change.action === 'add') return 'Added to this Flow';
  if (change.action === 'remove') {
    return change.kind === 'node' ? 'Removed from this Flow' : `Removed ${target}`;
  }
  return `Updated: ${target}`;
}

export function visibleFlowChanges(changes: FlowSemanticChange[]): FlowSemanticChange[] {
  return changes.filter((change) => !(change.action === 'add' && change.status === 'applied'));
}

function singleUpdatedNode(presentation: FlowChangePresentation): FlowSemanticChange | undefined {
  const semantic = presentation.changes.filter((change) => change.kind !== 'settings');
  const change = semantic.length === 1 ? semantic[0] : undefined;
  return change?.kind === 'node' && change.action === 'update' ? change : undefined;
}

function updatedStepSynopsis(presentation: FlowChangePresentation) {
  const change = singleUpdatedNode(presentation);
  if (!change) return undefined;
  const detail = friendlyFlowChangeDetail(change);
  if (change.status === 'applied') {
    return detail ? `${change.label}: ${detail} changed` : `Updated ${change.label}`;
  }
  if (change.status === 'pending') {
    return detail
      ? `${change.label}: ${detail} will change`
      : `Update requested for ${change.label}`;
  }
  return (
    UPDATED_STEP_STATUS_COPY[change.status]?.(change.label) ?? `Could not update ${change.label}`
  );
}

function routeSynopsis(routes: FlowOutlineRoute[]) {
  const firstRoute = routes[0];
  if (!firstRoute) return undefined;
  const labels = firstRoute.steps.map((step) => step.label);
  if (labels.length > 4) return `${labels[0]} → ${labels[1]} → … → ${labels.at(-1)}`;
  if (labels.length > 0) return labels.join(' → ');
  return undefined;
}

function firstChangeSynopsis(presentation: FlowChangePresentation) {
  const first = presentation.changes[0];
  return first ? `${first.label} ${actionCopy(first)}` : undefined;
}

function synopsisFor(
  presentation: FlowChangePresentation,
  routes: FlowOutlineRoute[],
): string | undefined {
  return (
    updatedStepSynopsis(presentation) ?? routeSynopsis(routes) ?? firstChangeSynopsis(presentation)
  );
}

function changesOnlyModel(
  presentation: FlowChangePresentation,
  graph: FlowChangeGraph | undefined,
): FlowChangeOutlineModel {
  return {
    heading: headingForPhase(presentation.phase),
    scope: 'changes-only',
    routes: [],
    settingsChanges: presentation.changes
      .filter((change) => change.kind === 'settings')
      .sort(byOperation),
    unplacedChanges: presentation.changes
      .filter((change) => change.kind !== 'settings')
      .sort(byOperation),
    omittedNodeCount: 0,
    omittedRouteCount: 0,
    synopsis: synopsisFor(presentation, []),
    totalNodeCount: graph?.nodes.length ?? 0,
    branchCount: 0,
  };
}

export function buildFlowChangeOutline(
  presentation: FlowChangePresentation,
): FlowChangeOutlineModel {
  const graph = truthfulGraph(presentation);
  const topologyChanges = presentation.changes.filter((change) => change.kind !== 'settings');
  if (
    !graph ||
    graph.nodes.length === 0 ||
    (presentation.changes.length > 0 && topologyChanges.length === 0)
  ) {
    return changesOnlyModel(presentation, graph);
  }
  const scope = graph.nodes.length <= FULL_FLOW_NODE_LIMIT ? 'full' : 'neighborhood';
  const selected =
    scope === 'full'
      ? { graph, omittedNodeCount: 0 }
      : selectAffectedFlowTopology(graph, topologyChanges, FULL_FLOW_NODE_LIMIT);
  const visibleIds = new Set(selected.graph.nodes.map((node) => node.id));
  const display = buildDisplayGraph(graph, visibleIds);
  const index = buildGraphIndex(display);
  const attached = attachOutlineChanges(presentation.changes, visibleIds, display.edges);
  const context = { ...index, ...attached, rendered: new Set<string>() };
  const routes = index.rootIds.map((id) => buildOutlineRoute(id, context, `route:${id}`));
  for (const id of index.orderedIds) {
    if (!context.rendered.has(id)) routes.push(buildOutlineRoute(id, context, `route:${id}`));
  }
  const visibleRoutes = routes.filter((route) => route.steps.length > 0 || route.terminal);
  return {
    heading: headingForPhase(presentation.phase),
    scope,
    routes: visibleRoutes,
    settingsChanges: attached.settingsChanges,
    unplacedChanges: attached.unplacedChanges,
    omittedNodeCount: selected.omittedNodeCount,
    omittedRouteCount: display.omittedConnectionCount,
    synopsis: synopsisFor(presentation, visibleRoutes),
    totalNodeCount: graph.nodes.length,
    branchCount: index.branchCount,
  };
}
