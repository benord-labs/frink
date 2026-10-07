import { describe, expect, it } from 'vitest';
import type { FlowGraph } from '../../validate-flow-graph';
import { resetLayout } from './index';
import { diagnoseLayout } from './layout-diagnostics';

const FAN_OUT_GRAPH: FlowGraph = {
  nodes: [
    { id: 'trigger', blockType: 'manual_trigger' },
    { id: 'fan', blockType: 'fan_out' },
    { id: 'body-a', blockType: 'agent', parentId: 'fan' },
    { id: 'body-b', blockType: 'agent', parentId: 'fan' },
    { id: 'after', blockType: 'agent' },
  ],
  edges: [
    { id: 'e0', source: 'trigger', target: 'fan' },
    { id: 'e1', source: 'fan', target: 'body-a' },
    { id: 'e2', source: 'fan', target: 'body-b' },
    { id: 'e3', source: 'body-a', target: 'after' },
    { id: 'e4', source: 'body-b', target: 'after' },
  ],
};

describe('resetLayout', () => {
  it('positions every node and reports a clean layout', () => {
    const laidOut = resetLayout(FAN_OUT_GRAPH);
    expect(laidOut.nodes.every((node) => node.position !== undefined)).toBe(true);
    const report = diagnoseLayout(laidOut);
    expect(report.overlaps.count).toBe(0);
    expect(report.upwardEdges.count).toBe(0);
    expect(report.bounds.width).toBeGreaterThan(0);
  });

  it('ignores a dragged Fan Out member and an author size, so a second reset changes nothing', () => {
    const arranged: FlowGraph = {
      ...FAN_OUT_GRAPH,
      nodes: FAN_OUT_GRAPH.nodes.map((node) => {
        if (node.id === 'fan') return { ...node, size: { width: 1400, height: 1000 } };
        if (node.id === 'body-a') return { ...node, position: { x: 900, y: 700 } };
        return node;
      }),
    };
    const once = resetLayout(arranged);
    expect(once).toEqual(resetLayout(FAN_OUT_GRAPH));
    expect(once.nodes.some((node) => node.size !== undefined)).toBe(false);
    expect(resetLayout(once)).toEqual(once);
  });
});

describe('diagnoseLayout', () => {
  it('compares a top-level node with the container, never with the members inside it', () => {
    const graph: FlowGraph = {
      nodes: [
        { id: 'fan', blockType: 'fan_out', position: { x: 0, y: 0 } },
        { id: 'body-a', blockType: 'agent', parentId: 'fan', position: { x: 40, y: 152 } },
        { id: 'stray', blockType: 'agent', position: { x: 40, y: 152 } },
      ],
      edges: [{ id: 'e1', source: 'fan', target: 'body-a' }],
    };
    expect(diagnoseLayout(graph).overlaps).toEqual({ count: 1, sample: [['fan', 'stray']] });
  });

  it('reports an unplaced node that lands on a placed one', () => {
    const graph: FlowGraph = {
      nodes: [
        { id: 'trigger', blockType: 'manual_trigger' },
        { id: 'agent', blockType: 'agent' },
      ],
      edges: [{ id: 'e1', source: 'trigger', target: 'agent' }],
    };
    const placed = resetLayout(graph);
    const agentAt = placed.nodes.find((node) => node.id === 'agent')?.position;
    const mixed: FlowGraph = {
      ...graph,
      nodes: [{ id: 'trigger', blockType: 'manual_trigger', position: agentAt }, graph.nodes[1]!],
    };
    expect(diagnoseLayout(mixed).overlaps.sample).toEqual([['trigger', 'agent']]);
  });

  it('reports a forward edge drawn upward but not a condition loop', () => {
    const graph: FlowGraph = {
      nodes: [
        { id: 'trigger', blockType: 'manual_trigger', position: { x: 0, y: 0 } },
        { id: 'work', blockType: 'agent', position: { x: 0, y: 400 } },
        { id: 'check', blockType: 'condition', position: { x: 0, y: 600 } },
        { id: 'done', blockType: 'end', position: { x: 0, y: 200 } },
      ],
      edges: [
        { id: 'start', source: 'trigger', target: 'work' },
        { id: 'to-check', source: 'work', target: 'check' },
        { id: 'loop', source: 'check', target: 'work', sourceHandle: 'true' },
        { id: 'exit', source: 'check', target: 'done', sourceHandle: 'false' },
      ],
    };
    expect(diagnoseLayout(graph).upwardEdges).toEqual({ count: 1, sample: ['exit'] });
  });

  it('treats cards that only touch as clear, and a one-pixel intrusion as an overlap', () => {
    const pair = (x: number): FlowGraph => ({
      nodes: [
        { id: 'left', blockType: 'agent', position: { x: 0, y: 0 } },
        { id: 'right', blockType: 'agent', position: { x, y: 0 } },
      ],
      edges: [],
    });
    expect(diagnoseLayout(pair(320)).overlaps.count).toBe(0);
    expect(diagnoseLayout(pair(319)).overlaps.count).toBe(1);
  });

  it('measures bounds from the real extent, including negative coordinates', () => {
    const graph: FlowGraph = {
      nodes: [
        { id: 'a', blockType: 'agent', position: { x: -500, y: -200 } },
        { id: 'b', blockType: 'agent', position: { x: 100, y: 300 } },
      ],
      edges: [],
    };
    expect(diagnoseLayout(graph).bounds).toEqual({ x: -500, y: -200, width: 920, height: 580 });
  });

  it('compares a Fan Out member with an outside node in canvas coordinates', () => {
    // The member sits at y 152 inside a container at y 500, so on the canvas it is below the
    // continuation at y 300 and the edge into it is drawn upward.
    const graph: FlowGraph = {
      nodes: [
        { id: 'fan', blockType: 'fan_out', position: { x: 0, y: 500 } },
        { id: 'body', blockType: 'agent', parentId: 'fan', position: { x: 40, y: 152 } },
        { id: 'after', blockType: 'agent', position: { x: 600, y: 300 } },
      ],
      edges: [
        { id: 'into-body', source: 'fan', target: 'body' },
        { id: 'to-after', source: 'body', target: 'after' },
      ],
    };
    expect(diagnoseLayout(graph).upwardEdges).toEqual({ count: 1, sample: ['to-after'] });
  });

  it('caps each sample at ten while keeping the full count', () => {
    const nodes = Array.from({ length: 50 }, (_, index) => ({
      id: `n${index}`,
      blockType: 'agent',
      position: { x: 0, y: 0 },
    }));
    const report = diagnoseLayout({ nodes, edges: [] });
    expect(report.overlaps.count).toBe(1225);
    expect(report.overlaps.sample).toHaveLength(10);
  });
});
