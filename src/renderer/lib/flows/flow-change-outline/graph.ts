import { findBackEdges } from '../../../../shared/lib/flow-graph-cycle';
import type {
  FlowChangeGraph,
  FlowChangeGraphEdge,
  FlowChangeGraphNode,
  FlowChangePhase,
  FlowChangePresentation,
  FlowSemanticChange,
} from '../../../../shared/types/flows/flow-change-presentation';
import { type DisplayEdge, type DisplayGraph, sortEdges } from './connections';

export {
  buildDisplayGraph,
  type DisplayEdge,
  type DisplayGraph,
  outlineEdgeLabel,
} from './connections';

export type OutlineGraphIndex = {
  nodes: Map<string, FlowChangeGraphNode>;
  outgoing: Map<string, DisplayEdge[]>;
  omittedBySource: Map<string, Set<string>>;
  backEdgeIds: Set<string>;
  orderedIds: string[];
  rootIds: string[];
  branchCount: number;
};

export type ChangeAttachments = {
  nodeChanges: Map<string, FlowSemanticChange[]>;
  edgeChanges: Map<string, FlowSemanticChange[]>;
  settingsChanges: FlowSemanticChange[];
  unplacedChanges: FlowSemanticChange[];
};

export const byOperation = (a: FlowSemanticChange, b: FlowSemanticChange): number =>
  a.operationIndex - b.operationIndex;

const HIDDEN_ENTITY_STATES = new Set([
  'remove:applied:*',
  'remove:unchanged:*',
  'remove:pending:applying',
  'remove:pending:proposed',
]);

const EXPLICIT_HIDDEN_ENTITY_STATES = new Set(['add:failed', 'add:skipped']);
const ENTITY_LIFECYCLE_ACTIONS = new Set<FlowSemanticChange['action']>(['add', 'remove']);
const EFFECTIVE_LIFECYCLE_STATUSES = new Set<FlowSemanticChange['status']>([
  'applied',
  'pending',
  'unchanged',
]);

function latestEntityChange(
  changes: FlowSemanticChange[],
  kind: 'node' | 'edge',
  id: string,
): FlowSemanticChange | undefined {
  return changes
    .filter(
      (change) =>
        change.kind === kind &&
        (kind === 'node' ? change.nodeId : change.edgeId) === id &&
        ENTITY_LIFECYCLE_ACTIONS.has(change.action) &&
        EFFECTIVE_LIFECYCLE_STATUSES.has(change.status),
    )
    .sort(byOperation)
    .at(-1);
}

function shouldHideEntity(
  entity: FlowChangeGraphNode | FlowChangeGraphEdge,
  lifecycleChange: FlowSemanticChange | undefined,
  phase: FlowChangePhase,
): boolean {
  const action = lifecycleChange?.action ?? entity.changeAction;
  const status = lifecycleChange?.status ?? entity.changeStatus;
  return (
    EXPLICIT_HIDDEN_ENTITY_STATES.has(`${entity.changeAction}:${entity.changeStatus}`) ||
    HIDDEN_ENTITY_STATES.has(`${action}:${status}:*`) ||
    HIDDEN_ENTITY_STATES.has(`${action}:${status}:${phase}`)
  );
}

export function truthfulGraph(presentation: FlowChangePresentation): FlowChangeGraph | undefined {
  if (!presentation.graph) return undefined;
  const nodes = presentation.graph.nodes.filter(
    (node) =>
      !shouldHideEntity(
        node,
        latestEntityChange(presentation.changes, 'node', node.id),
        presentation.phase,
      ),
  );
  const nodeIds = new Set(nodes.map((node) => node.id));
  const edges = presentation.graph.edges.filter(
    (edge) =>
      nodeIds.has(edge.source) &&
      nodeIds.has(edge.target) &&
      !shouldHideEntity(
        edge,
        latestEntityChange(presentation.changes, 'edge', edge.id),
        presentation.phase,
      ),
  );
  return { nodes: [...nodes].sort((a, b) => a.id.localeCompare(b.id)), edges: sortEdges(edges) };
}

function reachableDistances(
  start: string,
  outgoing: Map<string, DisplayEdge[]>,
  backEdges: Set<string>,
): Map<string, number> {
  const distances = new Map([[start, 0]]);
  const queue = [start];
  while (queue.length > 0) {
    const current = queue.shift();
    if (!current) break;
    for (const edge of outgoing.get(current) ?? []) {
      if (backEdges.has(edge.id) || distances.has(edge.target)) continue;
      distances.set(edge.target, (distances.get(current) ?? 0) + 1);
      queue.push(edge.target);
    }
  }
  return distances;
}

export function findNearestJoin(
  edges: DisplayEdge[],
  index: OutlineGraphIndex,
): string | undefined {
  const distances = edges.map((edge) =>
    reachableDistances(edge.target, index.outgoing, index.backEdgeIds),
  );
  const candidates = [...(distances[0]?.keys() ?? [])].filter((id) =>
    distances.every((map) => map.has(id)),
  );
  return candidates.sort((a, b) => {
    const aDistances = distances.map((map) => map.get(a) ?? Number.MAX_SAFE_INTEGER);
    const bDistances = distances.map((map) => map.get(b) ?? Number.MAX_SAFE_INTEGER);
    return (
      Math.max(...aDistances) - Math.max(...bDistances) ||
      aDistances.reduce((sum, value) => sum + value, 0) -
        bDistances.reduce((sum, value) => sum + value, 0) ||
      a.localeCompare(b)
    );
  })[0];
}

export function buildGraphIndex(display: DisplayGraph): OutlineGraphIndex {
  const nodes = new Map(display.nodes.map((node) => [node.id, node]));
  const outgoing = new Map<string, DisplayEdge[]>();
  for (const edge of display.edges)
    outgoing.set(edge.source, [...(outgoing.get(edge.source) ?? []), edge]);
  const backEdgeIds = findBackEdges({ nodes: [...nodes.values()], edges: display.edges });
  const indegree = new Map([...nodes.keys()].map((id) => [id, 0]));
  for (const edge of display.edges) {
    if (!backEdgeIds.has(edge.id)) indegree.set(edge.target, (indegree.get(edge.target) ?? 0) + 1);
  }
  const orderedIds = [...nodes.keys()].sort(
    (a, b) =>
      (nodes.get(a)?.label ?? a).localeCompare(nodes.get(b)?.label ?? b) || a.localeCompare(b),
  );
  const branchCount = [...outgoing.values()].reduce(
    (count, edges) => count + (edges.length > 1 ? edges.length : 0),
    0,
  );
  return {
    nodes,
    outgoing,
    omittedBySource: display.omittedBySource,
    backEdgeIds,
    orderedIds,
    rootIds: orderedIds.filter((id) => indegree.get(id) === 0),
    branchCount,
  };
}

export function attachOutlineChanges(
  changes: FlowSemanticChange[],
  nodeIds: Set<string>,
  edges: DisplayEdge[],
): ChangeAttachments {
  const result: ChangeAttachments = {
    nodeChanges: new Map(),
    edgeChanges: new Map(),
    settingsChanges: [],
    unplacedChanges: [],
  };
  const edgeOwners = new Map<string, Set<string>>();
  for (const edge of edges) {
    for (const originalId of edge.originalEdgeIds) {
      const owners = edgeOwners.get(originalId) ?? new Set<string>();
      owners.add(edge.id);
      edgeOwners.set(originalId, owners);
    }
  }
  for (const change of [...changes].sort(byOperation)) {
    attachChange(result, change, nodeIds, edgeOwners);
  }
  return result;
}
type ChangeAttachment =
  | { bucket: 'node'; id: string }
  | { bucket: 'edge'; ids: string[] }
  | { bucket: 'settings' }
  | { bucket: 'unplaced' };
function directAttachment(
  change: FlowSemanticChange,
  nodeIds: Set<string>,
  edgeOwners: Map<string, Set<string>>,
): ChangeAttachment | undefined {
  if (change.kind === 'settings') return { bucket: 'settings' };
  if (change.kind === 'node' && change.nodeId && nodeIds.has(change.nodeId)) {
    return { bucket: 'node', id: change.nodeId };
  }
  const edgeIds = change.edgeId ? [...(edgeOwners.get(change.edgeId) ?? [])] : [];
  if (change.kind === 'edge' && edgeIds.length > 0) return { bucket: 'edge', ids: edgeIds };
  return undefined;
}
function attachmentForChange(
  change: FlowSemanticChange,
  nodeIds: Set<string>,
  edgeOwners: Map<string, Set<string>>,
): ChangeAttachment {
  const direct = directAttachment(change, nodeIds, edgeOwners);
  if (direct) return direct;
  const relatedNodeId = change.relatedNodeIds?.find((id) => nodeIds.has(id));
  return relatedNodeId ? { bucket: 'node', id: relatedNodeId } : { bucket: 'unplaced' };
}
function attachChange(
  result: ChangeAttachments,
  change: FlowSemanticChange,
  nodeIds: Set<string>,
  edgeOwners: Map<string, Set<string>>,
): void {
  const attachment = attachmentForChange(change, nodeIds, edgeOwners);
  if (attachment.bucket === 'settings') result.settingsChanges.push(change);
  else if (attachment.bucket === 'unplaced') result.unplacedChanges.push(change);
  else if (attachment.bucket === 'node') {
    result.nodeChanges.set(attachment.id, [
      ...(result.nodeChanges.get(attachment.id) ?? []),
      change,
    ]);
  } else {
    for (const id of attachment.ids) {
      result.edgeChanges.set(id, [...(result.edgeChanges.get(id) ?? []), change]);
    }
  }
}
