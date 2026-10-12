/**
 * Layout facts an agent cannot see: where nodes land on the canvas and whether they collide.
 * Uses the positions the canvas would render (stored, else dagre) and nominal node sizes.
 */

import { findBackEdges } from '../../flow-graph-cycle';
import type { FlowGraph } from '../../validate-flow-graph';
import { RF_NODE_HEIGHT, RF_NODE_WIDTH } from './constants';
import { computeDagreLayoutPositions, fanOutContainerDimensions } from './index';

const SAMPLE_LIMIT = 10;

type Rect = { id: string; x: number; y: number; width: number; height: number };

type Sampled<T> = { count: number; sample: T[] };

export type LayoutDiagnostics = {
  /** Extent of the top-level nodes, in canvas pixels. */
  bounds: { x: number; y: number; width: number; height: number };
  /** Node id pairs whose rectangles intersect. */
  overlaps: Sampled<[string, string]>;
  /** Edge ids drawn upward (target above source) that are not loop back-edges. */
  upwardEdges: Sampled<string>;
};

function sampled<T>(items: T[]): Sampled<T> {
  return { count: items.length, sample: items.slice(0, SAMPLE_LIMIT) };
}

function intersects(a: Rect, b: Rect): boolean {
  return a.x < b.x + b.width && b.x < a.x + a.width && a.y < b.y + b.height && b.y < a.y + a.height;
}

function overlappingPairs(rects: Rect[]): [string, string][] {
  const pairs: [string, string][] = [];
  for (let i = 0; i < rects.length; i += 1) {
    for (let j = i + 1; j < rects.length; j += 1) {
      const a = rects[i];
      const b = rects[j];
      if (a && b && intersects(a, b)) pairs.push([a.id, b.id]);
    }
  }
  return pairs;
}

export function diagnoseLayout(graph: FlowGraph): LayoutDiagnostics {
  const dagre = computeDagreLayoutPositions(graph);
  const nodeById = new Map(graph.nodes.map((node) => [node.id, node]));
  const rectOf = (id: string): Rect | undefined => {
    const node = nodeById.get(id);
    if (!node) return undefined;
    const at = node.position ?? dagre.get(id) ?? { x: 0, y: 0 };
    const size =
      node.blockType === 'fan_out'
        ? fanOutContainerDimensions(graph, id)
        : { width: RF_NODE_WIDTH, height: RF_NODE_HEIGHT };
    return { id, x: at.x, y: at.y, ...size };
  };

  // A Fan Out member's position is relative to its container, so members are only ever compared
  // with their siblings, and top-level nodes (containers included) only with each other.
  const groups = new Map<string, Rect[]>();
  for (const node of graph.nodes) {
    const rect = rectOf(node.id);
    if (!rect) continue;
    const key = node.parentId ?? '';
    groups.set(key, [...(groups.get(key) ?? []), rect]);
  }
  const overlaps = [...groups.values()].flatMap(overlappingPairs);

  const topLevel = groups.get('') ?? [];
  const edge = (pick: (...values: number[]) => number, of: (rect: Rect) => number): number =>
    topLevel.length > 0 ? pick(...topLevel.map(of)) : 0;
  const minX = edge(Math.min, (r) => r.x);
  const minY = edge(Math.min, (r) => r.y);
  const maxX = edge(Math.max, (r) => r.x + r.width);
  const maxY = edge(Math.max, (r) => r.y + r.height);

  // Canvas y of a node's top edge; a member sits inside its container's frame.
  const canvasTop = (id: string): number | undefined => {
    const rect = rectOf(id);
    if (!rect) return undefined;
    const parentId = nodeById.get(id)?.parentId;
    return rect.y + (parentId ? (rectOf(parentId)?.y ?? 0) : 0);
  };
  const backEdges = findBackEdges(graph);
  const placed = (id: string): boolean => nodeById.get(id)?.position !== undefined;
  const upwardEdges = graph.edges
    .filter((edge) => {
      // Two auto-laid-out endpoints are dagre's call, not something the author can correct.
      if (backEdges.has(edge.id) || !(placed(edge.source) || placed(edge.target))) return false;
      const from = canvasTop(edge.source);
      const to = canvasTop(edge.target);
      return from !== undefined && to !== undefined && to < from;
    })
    .map((edge) => edge.id);

  return {
    bounds: { x: minX, y: minY, width: maxX - minX, height: maxY - minY },
    overlaps: sampled(overlaps),
    upwardEdges: sampled(upwardEdges),
  };
}
