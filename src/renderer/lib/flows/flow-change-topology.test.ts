import { describe, expect, it } from 'vitest';
import type {
  FlowChangeGraph,
  FlowSemanticChange,
} from '../../../shared/types/flows/flow-change-presentation';
import { selectAffectedFlowTopology } from './flow-change-topology';

const GRAPH: FlowChangeGraph = {
  nodes: Array.from({ length: 10 }, (_, index) => ({
    id: `n${index}`,
    label: `Step ${index}`,
    blockType: index === 0 ? 'manual_trigger' : 'agent',
  })),
  edges: Array.from({ length: 9 }, (_, index) => ({
    id: `e${index}`,
    source: `n${index}`,
    target: `n${index + 1}`,
  })),
};

describe('selectAffectedFlowTopology', () => {
  it('keeps the changed neighborhood and reports omitted nodes', () => {
    const changes: FlowSemanticChange[] = [
      {
        operationIndex: 0,
        action: 'update',
        kind: 'node',
        status: 'applied',
        label: 'Step 7',
        nodeId: 'n7',
      },
    ];

    const result = selectAffectedFlowTopology(GRAPH, changes, 5);

    expect(result.graph.nodes.map((node) => node.id)).toContain('n7');
    expect(result.graph.nodes.map((node) => node.id)).toContain('n6');
    expect(result.omittedNodeCount).toBe(5);
    expect(
      result.graph.edges.every(
        (edge) =>
          result.graph.nodes.some((node) => node.id === edge.source) &&
          result.graph.nodes.some((node) => node.id === edge.target),
      ),
    ).toBe(true);
  });

  it('falls back to topological order when a settings-only change has no target node', () => {
    const result = selectAffectedFlowTopology(
      GRAPH,
      [
        {
          operationIndex: 0,
          action: 'update',
          kind: 'settings',
          status: 'pending',
          label: 'Flow settings',
        },
      ],
      3,
    );

    expect(result.graph.nodes.map((node) => node.id)).toEqual(['n0', 'n1', 'n2']);
    expect(result.omittedNodeCount).toBe(7);
  });

  it('orders acyclic roots first and appends cyclic nodes in graph order', () => {
    const graph: FlowChangeGraph = {
      nodes: ['cycle-a', 'cycle-b', 'root', 'leaf'].map((id) => ({
        id,
        label: id,
        blockType: 'agent',
      })),
      edges: [
        { id: 'cycle-a-b', source: 'cycle-a', target: 'cycle-b' },
        { id: 'cycle-b-a', source: 'cycle-b', target: 'cycle-a' },
        { id: 'root-leaf', source: 'root', target: 'leaf' },
      ],
    };

    const result = selectAffectedFlowTopology(graph, [], 2);

    expect(result.graph.nodes.map((node) => node.id)).toEqual(['root', 'leaf']);
    expect(result.graph.edges.map((edge) => edge.id)).toEqual(['root-leaf']);
    expect(result.omittedNodeCount).toBe(2);
  });
});
