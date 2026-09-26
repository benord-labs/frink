import { describe, expect, it } from 'vitest';
import type {
  FlowChangeGraph,
  FlowSemanticChange,
} from '../../../shared/types/flows/flow-change-presentation';
import {
  markFlowChangeGraph,
  projectProposedFlowGraph,
  toSafeFlowChangeGraph,
} from './flow-change-graph';

describe('Flow change graph projection', () => {
  it('preserves valid opaque ids instead of imposing a renderer-only length contract', () => {
    const longId = `node-${'x'.repeat(600)}\nopaque`;
    const graph = toSafeFlowChangeGraph({
      nodes: [{ id: longId, blockType: 'agent', label: 'Long-id step' }],
      edges: [],
    });

    expect(graph?.nodes[0]?.id).toBe(longId);
  });

  it('applies every structural proposal operation without exposing config values', () => {
    const projected = projectProposedFlowGraph(
      {
        nodes: [
          { id: 'start', blockType: 'manual_trigger', label: 'Start' },
          { id: 'draft', blockType: 'agent', label: 'Draft' },
          { id: 'retired', blockType: 'agent', label: 'Retired' },
        ],
        edges: [
          { id: 'start-draft', source: 'start', target: 'draft' },
          { id: 'draft-retired', source: 'draft', target: 'retired' },
        ],
      },
      [
        { op: 'update_node', nodeId: 'draft', label: 'Write release' },
        {
          op: 'add_node',
          node: {
            id: 'publish',
            blockType: 'agent',
            label: 'Publish',
            config: { instructions: 'PRIVATE-INSTRUCTION' },
          },
        },
        {
          op: 'add_edge',
          edge: { id: 'draft-publish', source: 'draft', target: 'publish' },
        },
        {
          op: 'update_edge',
          edgeId: 'draft-publish',
          label: 'Approved',
          sourceHandle: 'true',
        },
        { op: 'remove_edge', edgeId: 'start-draft' },
        { op: 'remove_node', nodeId: 'retired' },
        { op: 'update_settings', settings: { briefing: 'PRIVATE-BRIEFING' } },
      ],
    );

    expect(projected.nodes).toEqual([
      { id: 'start', blockType: 'manual_trigger', label: 'Start' },
      { id: 'draft', blockType: 'agent', label: 'Write release' },
      { id: 'publish', blockType: 'agent', label: 'Publish' },
    ]);
    expect(projected.edges).toEqual([
      {
        id: 'draft-publish',
        source: 'draft',
        target: 'publish',
        label: 'Approved',
        sourceHandle: 'true',
      },
    ]);
    expect(JSON.stringify(projected)).not.toMatch(/PRIVATE|config|briefing|instructions/);
  });

  it('keeps node, edge, and operation safety caps while allowing capped replacements', () => {
    const nodes = Array.from({ length: 50 }, (_, index) => ({
      id: `node-${index}`,
      blockType: 'agent',
      label: `Node ${index}`,
    }));
    const edges = Array.from({ length: 200 }, (_, index) => ({
      id: `edge-${index}`,
      source: 'node-0',
      target: 'node-1',
    }));
    const operations = [
      {
        op: 'add_node',
        node: { id: 'overflow', blockType: 'agent', label: 'Overflow' },
      },
      {
        op: 'add_node',
        node: { id: 'node-0', blockType: 'agent', label: 'Replacement' },
      },
      {
        op: 'add_edge',
        edge: { id: 'edge-overflow', source: 'node-0', target: 'node-1' },
      },
      {
        op: 'add_edge',
        edge: {
          id: 'edge-0',
          source: 'node-0',
          target: 'node-1',
          label: 'Replacement route',
        },
      },
      ...Array.from({ length: 96 }, () => ({ op: 'unknown' })),
      { op: 'update_node', nodeId: 'node-0', label: 'Past operation cap' },
    ];

    const projected = projectProposedFlowGraph({ nodes, edges }, operations);

    expect(projected.nodes).toHaveLength(50);
    expect(projected.nodes.some((node) => node.id === 'overflow')).toBe(false);
    expect(projected.nodes.at(-1)).toEqual(
      expect.objectContaining({ id: 'node-0', label: 'Replacement' }),
    );
    expect(projected.edges).toHaveLength(200);
    expect(projected.edges.some((edge) => edge.id === 'edge-overflow')).toBe(false);
    expect(projected.edges.at(-1)).toEqual(
      expect.objectContaining({ id: 'edge-0', label: 'Replacement route' }),
    );
  });

  it('caps safe projection by raw candidate position and keeps first duplicate ids', () => {
    const graph = toSafeFlowChangeGraph({
      nodes: [
        { id: 'kept', blockType: 'agent', label: 'First' },
        { id: 'kept', blockType: 'agent', label: 'Duplicate' },
        ...Array.from({ length: 48 }, () => null),
        { id: 'past-cap', blockType: 'agent', label: 'Past cap' },
      ],
      edges: [],
    });

    expect(graph?.nodes).toEqual([{ id: 'kept', blockType: 'agent', label: 'First' }]);
  });

  it('synthesizes a receipt-targeted route omitted by the safe graph cap', () => {
    const graph = toSafeFlowChangeGraph({
      nodes: [
        { id: 'source', blockType: 'agent', label: 'Source' },
        { id: 'target', blockType: 'agent', label: 'Target' },
      ],
      edges: Array.from({ length: 201 }, (_, index) => ({
        id: `edge-${index}`,
        source: 'source',
        target: 'target',
      })),
    });
    const change: FlowSemanticChange = {
      operationIndex: 0,
      action: 'update',
      kind: 'edge',
      status: 'applied',
      label: 'Source → Target',
      edgeId: 'edge-200',
      relatedNodeIds: ['source', 'target'],
    };

    const marked = markFlowChangeGraph(
      graph ?? { nodes: [], edges: [] },
      graph ?? {
        nodes: [],
        edges: [],
      },
      [change],
    );

    expect(marked.edges.find((edge) => edge.id === 'edge-200')).toEqual(
      expect.objectContaining({ changeAction: 'update', changeStatus: 'applied' }),
    );
  });

  it('restores removed nodes and routes from a durable semantic receipt', () => {
    const finalGraph: FlowChangeGraph = {
      nodes: [{ id: 'source', blockType: 'agent', label: 'Source' }],
      edges: [],
    };
    const changes: FlowSemanticChange[] = [
      {
        operationIndex: 0,
        action: 'remove',
        kind: 'node',
        status: 'applied',
        label: 'Removed target',
        nodeId: 'target',
        blockType: 'agent',
      },
      {
        operationIndex: 1,
        action: 'remove',
        kind: 'edge',
        status: 'applied',
        label: 'Source → Removed target',
        edgeId: 'route',
        relatedNodeIds: ['source', 'target'],
      },
    ];

    const marked = markFlowChangeGraph(finalGraph, finalGraph, changes);

    expect(marked.nodes.find((node) => node.id === 'target')).toEqual(
      expect.objectContaining({ changeAction: 'remove', changeStatus: 'applied' }),
    );
    expect(marked.edges.find((edge) => edge.id === 'route')).toEqual(
      expect.objectContaining({ changeAction: 'remove', changeStatus: 'applied' }),
    );
  });

  it('preserves a saved duplicate but does not synthesize a failed addition', () => {
    const savedGraph: FlowChangeGraph = {
      nodes: [{ id: 'existing', blockType: 'agent', label: 'Existing step' }],
      edges: [],
    };
    const fallbackGraph: FlowChangeGraph = {
      nodes: [...savedGraph.nodes, { id: 'new', blockType: 'agent', label: 'Proposed step' }],
      edges: [],
    };
    const changes: FlowSemanticChange[] = [
      {
        operationIndex: 0,
        action: 'add',
        kind: 'node',
        status: 'failed',
        label: 'Existing step',
        nodeId: 'existing',
      },
      {
        operationIndex: 1,
        action: 'add',
        kind: 'node',
        status: 'failed',
        label: 'Proposed step',
        nodeId: 'new',
      },
    ];

    expect(markFlowChangeGraph(savedGraph, fallbackGraph, changes)).toEqual(savedGraph);
  });

  it('keeps status and action from the same highest-severity operation', () => {
    const graph: FlowChangeGraph = {
      nodes: [{ id: 'step', blockType: 'agent', label: 'Step' }],
      edges: [],
    };
    const changes: FlowSemanticChange[] = [
      {
        operationIndex: 0,
        action: 'update',
        kind: 'node',
        status: 'failed',
        label: 'Step',
        nodeId: 'step',
      },
      {
        operationIndex: 1,
        action: 'add',
        kind: 'node',
        status: 'applied',
        label: 'Step',
        nodeId: 'step',
      },
    ];

    expect(markFlowChangeGraph(graph, graph, changes).nodes[0]).toEqual(
      expect.objectContaining({ changeAction: 'update', changeStatus: 'failed' }),
    );
  });
});
