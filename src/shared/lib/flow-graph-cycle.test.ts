import { describe, expect, it } from 'vitest';
import {
  buildAdjacency,
  canReachInGraph,
  findCyclicComponents,
  flowGraphHasDirectedCycle,
  wouldNewEdgeCreateCycle,
} from './flow-graph-cycle';

describe('buildAdjacency', () => {
  it('omits edges when source or target is not in nodeIds', () => {
    const edges = [
      { source: 'a', target: 'b' },
      { source: 'a', target: 'ghost' },
      { source: 'ghost', target: 'b' },
    ];
    const nodeIds = new Set(['a', 'b']);
    const adj = buildAdjacency(edges, nodeIds);
    expect(adj.get('a')).toEqual(['b']);
    expect(adj.get('ghost')).toBeUndefined();
  });

  it('matches canReachInGraph when only valid edges exist', () => {
    const edges = [{ source: 't', target: 'a' }];
    const nodeIds = new Set(['t', 'a']);
    const adj = buildAdjacency(edges, nodeIds);
    expect(adj.get('t')).toEqual(['a']);
    expect(canReachInGraph(edges, 't', 'a', nodeIds)).toBe(true);
    expect(canReachInGraph(edges, 'a', 't', nodeIds)).toBe(false);
  });
});

describe('wouldNewEdgeCreateCycle', () => {
  it('detects when target can already reach source', () => {
    const graph = {
      nodes: [{ id: 'a' }, { id: 'b' }],
      edges: [{ source: 'a', target: 'b' }],
    };
    expect(wouldNewEdgeCreateCycle(graph, 'b', 'a')).toBe(true);
    expect(wouldNewEdgeCreateCycle(graph, 'a', 'b')).toBe(false);
  });

  it('treats self-loop as a cycle (source === target)', () => {
    const graph = {
      nodes: [{ id: 'a' }],
      edges: [] as { source: string; target: string }[],
    };
    expect(wouldNewEdgeCreateCycle(graph, 'a', 'a')).toBe(true);
  });

  it('detects closing a longer directed path (a→b→c, propose c→a)', () => {
    const graph = {
      nodes: [{ id: 'a' }, { id: 'b' }, { id: 'c' }],
      edges: [
        { source: 'a', target: 'b' },
        { source: 'b', target: 'c' },
      ],
    };
    expect(wouldNewEdgeCreateCycle(graph, 'c', 'a')).toBe(true);
    expect(wouldNewEdgeCreateCycle(graph, 'a', 'c')).toBe(false);
  });

  it('returns false when connecting disconnected components without a back-edge', () => {
    const graph = {
      nodes: [{ id: 'a' }, { id: 'b' }, { id: 'c' }, { id: 'd' }],
      edges: [{ source: 'a', target: 'b' }],
    };
    expect(wouldNewEdgeCreateCycle(graph, 'c', 'd')).toBe(false);
    expect(wouldNewEdgeCreateCycle(graph, 'b', 'c')).toBe(false);
  });

  it('returns false for empty edges / sparse graph until a back-edge would appear', () => {
    const noEdges = {
      nodes: [{ id: 'a' }, { id: 'b' }],
      edges: [] as { source: string; target: string }[],
    };
    expect(wouldNewEdgeCreateCycle(noEdges, 'a', 'b')).toBe(false);
    expect(wouldNewEdgeCreateCycle(noEdges, 'b', 'a')).toBe(false);
  });
});

describe('flowGraphHasDirectedCycle', () => {
  it('returns false for an acyclic chain', () => {
    expect(
      flowGraphHasDirectedCycle({
        nodes: [{ id: 't' }, { id: 'a' }, { id: 'b' }],
        edges: [
          { source: 't', target: 'a' },
          { source: 'a', target: 'b' },
        ],
      }),
    ).toBe(false);
  });

  it('treats self-loop as a cycle (source === target)', () => {
    expect(
      flowGraphHasDirectedCycle({
        nodes: [{ id: 'a' }],
        edges: [{ source: 'a', target: 'a' }],
      }),
    ).toBe(true);
  });

  it('returns true when a directed cycle exists among listed nodes', () => {
    expect(
      flowGraphHasDirectedCycle({
        nodes: [{ id: 'a' }, { id: 'b' }],
        edges: [
          { source: 'a', target: 'b' },
          { source: 'b', target: 'a' },
        ],
      }),
    ).toBe(true);
  });

  it('does not treat edges to missing nodes as cycle edges (adjacency omits them)', () => {
    expect(
      flowGraphHasDirectedCycle({
        nodes: [{ id: 'a' }, { id: 'b' }],
        edges: [
          { source: 'a', target: 'b' },
          { source: 'b', target: 'ghost' },
        ],
      }),
    ).toBe(false);
  });
});

describe('findCyclicComponents', () => {
  const nodes = (...ids: string[]) => ids.map((id) => ({ id }));

  it('returns nothing for an acyclic graph', () => {
    const edges = [
      { source: 'a', target: 'b' },
      { source: 'b', target: 'c' },
    ];
    expect(findCyclicComponents({ nodes: nodes('a', 'b', 'c'), edges })).toEqual([]);
  });

  it('returns a single node that loops to itself', () => {
    const edges = [
      { source: 'a', target: 'b' },
      { source: 'b', target: 'b' },
    ];
    expect(findCyclicComponents({ nodes: nodes('a', 'b'), edges })).toEqual([['b']]);
  });

  it('returns each disjoint cycle with members in node order', () => {
    const edges = [
      { source: 'a', target: 'b' },
      { source: 'b', target: 'a' },
      { source: 'b', target: 'c' },
      { source: 'c', target: 'e' },
      { source: 'e', target: 'd' },
      { source: 'd', target: 'c' },
    ];
    const components = findCyclicComponents({
      nodes: nodes('a', 'b', 'c', 'd', 'e'),
      edges,
    });
    expect(components).toHaveLength(2);
    expect(components).toContainEqual(['a', 'b']);
    expect(components).toContainEqual(['c', 'd', 'e']);
  });

  it('ignores edges to nodes that are not in the graph', () => {
    const edges = [
      { source: 'a', target: 'ghost' },
      { source: 'ghost', target: 'a' },
    ];
    expect(findCyclicComponents({ nodes: nodes('a'), edges })).toEqual([]);
  });
});
