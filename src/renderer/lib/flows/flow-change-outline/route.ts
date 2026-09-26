import { getBlockRegistration } from '../../../../shared/lib/block-registry';
import type { FlowSemanticChange } from '../../../../shared/types/flows/flow-change-presentation';
import {
  type ChangeAttachments,
  type DisplayEdge,
  findNearestJoin,
  type OutlineGraphIndex,
  outlineEdgeLabel,
} from './graph';

export type FlowOutlineTerminal = {
  kind: 'join' | 'loop';
  nodeId: string;
  label: string;
  text: string;
  relationLabel?: string;
  changes: FlowSemanticChange[];
};

export type FlowOutlineRoute = {
  id: string;
  label?: string;
  steps: FlowOutlineStep[];
  changes: FlowSemanticChange[];
  terminal?: FlowOutlineTerminal;
  omittedAfter?: number;
};

export type FlowOutlineStep = {
  id: string;
  nodeId: string;
  label: string;
  blockType: string;
  blockTypeLabel: string;
  relationBefore?: string;
  relationChanges: FlowSemanticChange[];
  changes: FlowSemanticChange[];
  branches: FlowOutlineRoute[];
  omittedAfter?: number;
};

type OutlineContext = OutlineGraphIndex &
  Pick<ChangeAttachments, 'nodeChanges' | 'edgeChanges'> & {
    rendered: Set<string>;
  };

type RouteCursor = {
  nodeId: string;
  incoming?: DisplayEdge;
};

type RouteAdvance =
  | { kind: 'continue'; cursor: RouteCursor }
  | { kind: 'stop'; terminal?: FlowOutlineTerminal };

function changesForEdge(edge: DisplayEdge | undefined, context: OutlineContext) {
  return edge ? (context.edgeChanges.get(edge.id) ?? []) : [];
}

function terminal(
  kind: 'join' | 'loop',
  nodeId: string,
  context: OutlineContext,
  changes: FlowSemanticChange[] = [],
  relationLabel?: string,
): FlowOutlineTerminal {
  const label = context.nodes.get(nodeId)?.label ?? 'Unknown step';
  return {
    kind,
    nodeId,
    label,
    text: `${kind === 'join' ? 'Joins at' : 'Loops back to'} ${label}`,
    relationLabel,
    changes,
  };
}

function joinAtCursor(
  cursor: RouteCursor,
  stopAt: string | undefined,
  context: OutlineContext,
  includeIncomingChanges: boolean,
): FlowOutlineTerminal | undefined {
  if (cursor.nodeId !== stopAt && !context.rendered.has(cursor.nodeId)) return undefined;
  return terminal(
    'join',
    cursor.nodeId,
    context,
    includeIncomingChanges ? changesForEdge(cursor.incoming, context) : [],
    cursor.incoming ? outlineEdgeLabel(cursor.incoming) : undefined,
  );
}

function blockTypeLabel(blockType: string): string {
  const registration = getBlockRegistration(blockType);
  return registration ? registration.label : blockType.replace(/[_-]+/g, ' ');
}

function relationBefore(
  incoming: DisplayEdge | undefined,
  hasPriorStep: boolean,
  context: OutlineContext,
): Pick<FlowOutlineStep, 'relationBefore' | 'relationChanges'> {
  if (!incoming || !hasPriorStep) return { relationBefore: undefined, relationChanges: [] };
  return {
    relationBefore: outlineEdgeLabel(incoming),
    relationChanges: changesForEdge(incoming, context),
  };
}

function omittedAfter(nodeId: string, context: OutlineContext): number | undefined {
  const omitted = context.omittedBySource.get(nodeId);
  return omitted && omitted.size > 0 ? omitted.size : undefined;
}

function buildStep(
  nodeId: string,
  incoming: DisplayEdge | undefined,
  hasPriorStep: boolean,
  context: OutlineContext,
): FlowOutlineStep | undefined {
  const node = context.nodes.get(nodeId);
  if (!node) return undefined;
  context.rendered.add(nodeId);
  return {
    id: `step:${node.id}`,
    nodeId: node.id,
    label: node.label,
    blockType: node.blockType,
    blockTypeLabel: blockTypeLabel(node.blockType),
    ...relationBefore(incoming, hasPriorStep, context),
    changes: context.nodeChanges.get(node.id) ?? [],
    branches: [],
    omittedAfter: omittedAfter(nodeId, context),
  };
}

function loopRoute(edge: DisplayEdge, context: OutlineContext): FlowOutlineRoute {
  return {
    id: `route:${edge.id}`,
    label: outlineEdgeLabel(edge),
    steps: [],
    changes: changesForEdge(edge, context),
    terminal: terminal('loop', edge.target, context),
  };
}

function advanceFromStep(
  step: FlowOutlineStep,
  edges: DisplayEdge[],
  context: OutlineContext,
): RouteAdvance {
  const loops = edges.filter((edge) => context.backEdgeIds.has(edge.id));
  const forward = edges.filter((edge) => !context.backEdgeIds.has(edge.id));
  if (forward.length === 0 && loops.length === 1) {
    const loop = loops[0];
    if (!loop) return { kind: 'stop' };
    return {
      kind: 'stop',
      terminal: terminal(
        'loop',
        loop.target,
        context,
        changesForEdge(loop, context),
        outlineEdgeLabel(loop),
      ),
    };
  }
  step.branches.push(...loops.map((edge) => loopRoute(edge, context)));
  if (forward.length === 0) return { kind: 'stop' };
  const next = forward[0];
  if (forward.length === 1 && next) {
    return { kind: 'continue', cursor: { nodeId: next.target, incoming: next } };
  }
  const join = findNearestJoin(forward, context);
  step.branches.push(
    ...forward.map((edge) =>
      buildOutlineRoute(
        edge.target,
        context,
        `route:${edge.id}`,
        outlineEdgeLabel(edge),
        edge,
        join,
      ),
    ),
  );
  return join ? { kind: 'continue', cursor: { nodeId: join } } : { kind: 'stop' };
}

export function buildOutlineRoute(
  start: string,
  context: OutlineContext,
  id: string,
  label?: string,
  entry?: DisplayEdge,
  stopAt?: string,
): FlowOutlineRoute {
  const route: FlowOutlineRoute = {
    id,
    label,
    steps: [],
    changes: changesForEdge(entry, context),
  };
  let cursor: RouteCursor | undefined = { nodeId: start, incoming: entry };
  while (cursor) {
    const join = joinAtCursor(cursor, stopAt, context, route.steps.length > 0);
    if (join) {
      route.terminal = join;
      break;
    }
    const step = buildStep(cursor.nodeId, cursor.incoming, route.steps.length > 0, context);
    if (!step) break;
    route.steps.push(step);
    const advance = advanceFromStep(step, context.outgoing.get(cursor.nodeId) ?? [], context);
    if (advance.kind === 'stop') {
      if (advance.terminal) route.terminal = advance.terminal;
      break;
    }
    cursor = advance.cursor;
  }
  return route;
}
