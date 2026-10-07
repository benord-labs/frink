/**
 * Pure dagre layout from `graph.edges` for persisting positions on save and React Flow rendering.
 */

import dagre from '@dagrejs/dagre';
import type { FlowGraph } from '../../validate-flow-graph';
import {
  DAGRE_OPTS,
  FAN_OUT_BODY_TOP,
  FAN_OUT_BOTTOM_PADDING,
  FAN_OUT_CHILD_COLUMN_GAP,
  FAN_OUT_CHILD_STEP,
  FAN_OUT_CHILD_X,
  RF_NODE_HEIGHT,
  RF_NODE_WIDTH,
} from './constants';

const H_SPACING = 48;
const V_SPACING = 100;

type Size = { width: number; height: number };

type FanOutLayout = Size & {
  /** Default top-left slot for each owned node, relative to the container. */
  slots: Map<string, { x: number; y: number }>;
};

function fanOutLayout(graph: FlowGraph, fanOutId: string): FanOutLayout {
  const members = graph.nodes.filter((node) => node.parentId === fanOutId);
  const memberIds = new Set(members.map((node) => node.id));
  const claimed = new Set<string>();
  const roots = graph.edges
    .filter((edge) => edge.source === fanOutId && memberIds.has(edge.target))
    .map((edge) => edge.target);
  const branches = roots.map((rootId) => {
    const branch: string[] = [];
    let currentId: string | undefined = rootId;
    while (currentId && memberIds.has(currentId) && !claimed.has(currentId)) {
      claimed.add(currentId);
      branch.push(currentId);
      const containedTargets = graph.edges
        .filter((edge) => edge.source === currentId && memberIds.has(edge.target))
        .map((edge) => edge.target);
      currentId = containedTargets.length === 1 ? containedTargets[0] : undefined;
    }
    return branch;
  });
  for (const member of members) {
    if (!claimed.has(member.id)) branches.push([member.id]);
  }
  const slots = new Map<string, { x: number; y: number }>();
  branches.forEach((branch, branchIndex) => {
    branch.forEach((nodeId, depth) => {
      slots.set(nodeId, {
        x: FAN_OUT_CHILD_X + branchIndex * (RF_NODE_WIDTH + FAN_OUT_CHILD_COLUMN_GAP),
        y: FAN_OUT_BODY_TOP + depth * FAN_OUT_CHILD_STEP,
      });
    });
  });
  const branchCount = Math.max(branches.length, 1);
  const maxDepth = Math.max(...branches.map((branch) => branch.length), 1);
  let width =
    FAN_OUT_CHILD_X * 2 +
    branchCount * RF_NODE_WIDTH +
    (branchCount - 1) * FAN_OUT_CHILD_COLUMN_GAP;
  let height = FAN_OUT_BODY_TOP + maxDepth * FAN_OUT_CHILD_STEP + FAN_OUT_BOTTOM_PADDING;
  // Fit dragged children too; unpadded, since RF clamps them flush to the edge (padding would make
  // the container creep on every drag against its edge).
  for (const member of members) {
    const at = member.position ?? slots.get(member.id);
    if (!at) continue;
    width = Math.max(width, at.x + RF_NODE_WIDTH);
    height = Math.max(height, at.y + RF_NODE_HEIGHT);
  }
  return { slots, width, height };
}

/** Smallest size that fits the default layout and every (possibly dragged) child. */
export function fanOutFitDimensions(graph: FlowGraph, fanOutId: string): Size {
  const { width, height } = fanOutLayout(graph, fanOutId);
  return { width, height };
}

/** Rendered size: the author-set `size` when larger than the fit, per axis. */
export function fanOutContainerDimensions(graph: FlowGraph, fanOutId: string): Size {
  const fit = fanOutFitDimensions(graph, fanOutId);
  const size = graph.nodes.find((node) => node.id === fanOutId)?.size;
  return {
    width: Math.max(fit.width, size?.width ?? 0),
    height: Math.max(fit.height, size?.height ?? 0),
  };
}

/**
 * Computes top-left React Flow positions for every node id (dagre center → top-left).
 * Matches `useFlowLayout` when `FlowNode.position` is unset.
 */
export function computeDagreLayoutPositions(
  graph: FlowGraph,
): Map<string, { x: number; y: number }> {
  const out = new Map<string, { x: number; y: number }>();
  const list = graph.nodes;
  if (list.length === 0) {
    return out;
  }

  const nodeById = new Map(list.map((node) => [node.id, node]));
  const topLevel = list.filter((node) => !node.parentId);
  const ownerId = (nodeId: string): string => nodeById.get(nodeId)?.parentId ?? nodeId;
  const dimensions = (nodeId: string): { width: number; height: number } =>
    nodeById.get(nodeId)?.blockType === 'fan_out'
      ? fanOutContainerDimensions(graph, nodeId)
      : { width: RF_NODE_WIDTH, height: RF_NODE_HEIGHT };

  const g = new dagre.graphlib.Graph().setDefaultEdgeLabel(() => ({}));
  g.setGraph({ ...DAGRE_OPTS });

  for (const n of topLevel) {
    g.setNode(n.id, dimensions(n.id));
  }
  for (const e of graph.edges) {
    const source = ownerId(e.source);
    const target = ownerId(e.target);
    if (source !== target) g.setEdge(source, target);
  }

  dagre.layout(g);

  for (let index = 0; index < topLevel.length; index += 1) {
    const n = topLevel[index];
    if (n === undefined) continue;
    const d = g.node(n.id);
    const { width, height } = dimensions(n.id);
    const baseX = d ? d.x - width / 2 : index * (width + H_SPACING);
    const baseY = d ? d.y - height / 2 : index * V_SPACING;
    out.set(n.id, { x: baseX, y: baseY });
  }

  for (const parent of topLevel) {
    for (const [nodeId, slot] of fanOutLayout(graph, parent.id).slots) out.set(nodeId, slot);
  }

  return out;
}

/**
 * Fills `position` on nodes that lack it using the same dagre layout as the canvas.
 * Call before saving a flow version so run-history sorting has stable y/x.
 */
export function embedMissingPositionsFromDagre(graph: FlowGraph): FlowGraph {
  if (graph.nodes.length === 0) {
    return graph;
  }
  const byId = computeDagreLayoutPositions(graph);
  return {
    ...graph,
    nodes: graph.nodes.map((n) => ({
      ...n,
      position: n.position ?? byId.get(n.id) ?? { x: 0, y: 0 },
    })),
  };
}

/**
 * Discards every stored position and Fan Out size, then lays the whole graph out again.
 * Stripping first keeps the result independent of the previous arrangement, so it is idempotent.
 */
export function resetLayout(graph: FlowGraph): FlowGraph {
  const bare: FlowGraph = {
    ...graph,
    nodes: graph.nodes.map(({ position: _position, size: _size, ...node }) => node),
  };
  return embedMissingPositionsFromDagre(bare);
}
