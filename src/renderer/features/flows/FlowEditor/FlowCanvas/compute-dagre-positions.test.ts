import { describe, expect, it } from 'vitest';
import { type FlowGraph, flowGraphsEqual } from '../../../../../shared/lib/validate-flow-graph';
import {
  computeDagreLayoutPositions,
  embedMissingPositionsFromDagre,
  fanOutContainerDimensions,
  fanOutFitDimensions,
} from './compute-dagre-positions';

describe('computeDagreLayoutPositions', () => {
  it('returns an empty map when there are no nodes', () => {
    expect(computeDagreLayoutPositions({ nodes: [], edges: [] }).size).toBe(0);
  });

  it('assigns finite top-left coordinates for each node in a small chain', () => {
    const graph: FlowGraph = {
      nodes: [
        { id: 't', blockType: 'manual_trigger' },
        { id: 'a', blockType: 'start_task' },
      ],
      edges: [{ id: 'e1', source: 't', target: 'a' }],
    };
    const m = computeDagreLayoutPositions(graph);
    expect(m.size).toBe(2);
    for (const id of ['t', 'a']) {
      const p = m.get(id);
      expect(p).toBeDefined();
      expect(Number.isFinite(p?.x)).toBe(true);
      expect(Number.isFinite(p?.y)).toBe(true);
    }
  });

  it('positions Fan Out members relative to their container', () => {
    const graph: FlowGraph = {
      nodes: [
        { id: 'fan', blockType: 'fan_out' },
        { id: 'body-a', blockType: 'agent', parentId: 'fan' },
        { id: 'body-b', blockType: 'agent', parentId: 'fan' },
        { id: 'after', blockType: 'agent' },
      ],
      edges: [
        { id: 'e1', source: 'fan', target: 'body-a' },
        { id: 'e2', source: 'body-a', target: 'body-b' },
        { id: 'e3', source: 'body-b', target: 'after' },
      ],
    };
    const positions = computeDagreLayoutPositions(graph);
    expect(positions.get('body-a')).toEqual({ x: 40, y: 152 });
    expect(positions.get('body-b')).toEqual({ x: 40, y: 288 });
    expect((positions.get('after')?.y ?? 0) > (positions.get('fan')?.y ?? 0)).toBe(true);
  });

  it('places uneven Fan Out branches in separate columns', () => {
    const graph: FlowGraph = {
      nodes: [
        { id: 'fan', blockType: 'fan_out' },
        { id: 'a', blockType: 'agent', parentId: 'fan' },
        { id: 'a2', blockType: 'agent', parentId: 'fan' },
        { id: 'b', blockType: 'agent', parentId: 'fan' },
        { id: 'after', blockType: 'agent' },
      ],
      edges: [
        { id: 'e1', source: 'fan', target: 'a' },
        { id: 'e2', source: 'fan', target: 'b' },
        { id: 'e3', source: 'a', target: 'a2' },
        { id: 'e4', source: 'a2', target: 'after' },
        { id: 'e5', source: 'b', target: 'after' },
      ],
    };

    const positions = computeDagreLayoutPositions(graph);
    expect(positions.get('a')).toEqual({ x: 40, y: 152 });
    expect(positions.get('a2')).toEqual({ x: 40, y: 288 });
    expect(positions.get('b')).toEqual({ x: 400, y: 152 });
    expect(fanOutContainerDimensions(graph, 'fan')).toEqual({ width: 760, height: 456 });
  });
});

describe('fanOutContainerDimensions', () => {
  /** One branch of one child: default fit is 400 × 320. */
  function fanOut(
    size?: { width: number; height: number },
    childPosition?: { x: number; y: number },
  ): FlowGraph {
    return {
      nodes: [
        { id: 'fan', blockType: 'fan_out', ...(size ? { size } : {}) },
        {
          id: 'a',
          blockType: 'agent',
          parentId: 'fan',
          ...(childPosition ? { position: childPosition } : {}),
        },
      ],
      edges: [{ id: 'e1', source: 'fan', target: 'a' }],
    };
  }

  it('uses the saved size when it is larger than the fit', () => {
    expect(fanOutContainerDimensions(fanOut({ width: 900, height: 700 }), 'fan')).toEqual({
      width: 900,
      height: 700,
    });
  });

  it('never renders smaller than the fit, even with a smaller saved size', () => {
    expect(fanOutContainerDimensions(fanOut({ width: 100, height: 100 }), 'fan')).toEqual({
      width: 400,
      height: 320,
    });
  });

  it('grows the fit to contain a child dragged beyond the default layout', () => {
    expect(fanOutFitDimensions(fanOut(undefined, { x: 500, y: 600 }), 'fan')).toEqual({
      width: 820,
      height: 680,
    });
  });

  // React Flow clamps `extent: 'parent'` children flush to the container edge; that drop must not
  // enlarge the container, or every drag against the edge would grow it a little more.
  it('keeps a saved size unchanged when a child sits flush against its right and bottom edges', () => {
    const size = { width: 900, height: 700 };
    const flush = { x: size.width - 320, y: size.height - 80 };
    expect(fanOutContainerDimensions(fanOut(size, flush), 'fan')).toEqual(size);
  });

  it('grows a snugly saved container when a branch is added', () => {
    const graph = fanOut({ width: 400, height: 320 });
    graph.nodes.push({ id: 'b', blockType: 'agent', parentId: 'fan' });
    graph.edges.push({ id: 'e2', source: 'fan', target: 'b' });
    expect(fanOutContainerDimensions(graph, 'fan').width).toBe(760);
  });
});

describe('embedMissingPositionsFromDagre', () => {
  it('returns the same graph reference when there are no nodes', () => {
    const graph: FlowGraph = { nodes: [], edges: [] };
    expect(embedMissingPositionsFromDagre(graph)).toBe(graph);
  });

  // Locks the invariant the save-diff (flowGraphsEqual) relies on: when every node already has a
  // position, embedding preserves those positions, so the output is content-stable across calls.
  // A saved baseline always has positions, so re-serializing it can never manufacture a false
  // "has changes".
  it('is content-stable when all nodes already have positions', () => {
    const graph: FlowGraph = {
      nodes: [
        { id: 't', blockType: 'manual_trigger', position: { x: 10, y: 20 } },
        { id: 'a', blockType: 'start_task', position: { x: 30, y: 40 } },
      ],
      edges: [{ id: 'e1', source: 't', target: 'a' }],
    };
    expect(flowGraphsEqual(embedMissingPositionsFromDagre(graph), graph)).toBe(true);
    expect(
      flowGraphsEqual(embedMissingPositionsFromDagre(graph), embedMissingPositionsFromDagre(graph)),
    ).toBe(true);
  });

  it('preserves existing positions and fills only missing nodes', () => {
    const graph: FlowGraph = {
      nodes: [
        { id: 't', blockType: 'manual_trigger', position: { x: 99, y: 88 } },
        { id: 'a', blockType: 'start_task' },
      ],
      edges: [{ id: 'e1', source: 't', target: 'a' }],
    };
    const out = embedMissingPositionsFromDagre(graph);
    expect(out.nodes.find((n) => n.id === 't')?.position).toEqual({ x: 99, y: 88 });
    const filled = out.nodes.find((n) => n.id === 'a')?.position;
    expect(filled).toBeDefined();
    expect(Number.isFinite(filled?.x)).toBe(true);
    expect(Number.isFinite(filled?.y)).toBe(true);
  });

  it('fills every node when none have positions', () => {
    const graph: FlowGraph = {
      nodes: [
        { id: 't', blockType: 'manual_trigger' },
        { id: 'a', blockType: 'agent', config: { instructions: 'x' } },
      ],
      edges: [{ id: 'e1', source: 't', target: 'a' }],
    };
    const out = embedMissingPositionsFromDagre(graph);
    for (const n of out.nodes) {
      expect(n.position).toBeDefined();
      expect(Number.isFinite(n.position?.x)).toBe(true);
      expect(Number.isFinite(n.position?.y)).toBe(true);
    }
  });

  // CRITICAL for the save-diff on brand-new flows: a freshly-created flow's graph has NO
  // positions, so the editor's `graph` keeps running a live Dagre layout while the saved baseline
  // already carries embedded positions. hasChanges compares buildGraphToSaveWithSchema(both). If
  // Dagre were nondeterministic, the position-less side would embed different coordinates each
  // call, making hasChanges permanently true → Save button stuck enabled forever after the first
  // save. This locks that layout is deterministic across calls for the same position-less graph.
  it('is deterministic across calls for a position-less graph', () => {
    const graph: FlowGraph = {
      nodes: [
        { id: 't', blockType: 'manual_trigger' },
        { id: 's', blockType: 'start_task' },
        { id: 'a', blockType: 'agent', config: { instructions: 'x' } },
      ],
      edges: [
        { id: 'e1', source: 't', target: 's' },
        { id: 'e2', source: 's', target: 'a' },
      ],
    };
    expect(
      flowGraphsEqual(embedMissingPositionsFromDagre(graph), embedMissingPositionsFromDagre(graph)),
    ).toBe(true);
  });
});
