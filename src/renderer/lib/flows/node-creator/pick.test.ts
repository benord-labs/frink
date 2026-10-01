import { describe, expect, it } from 'vitest';
import { type FlowGraph, MAX_FLOW_GRAPH_NODES } from '../../../../shared/lib/validate-flow-graph';
import { applyCreatorPick } from './pick';

const graph: FlowGraph = {
  nodes: [
    { id: 'trigger', blockType: 'manual_trigger' },
    { id: 'task', blockType: 'start_task' },
    { id: 'fan', blockType: 'fan_out' },
  ],
  edges: [{ id: 'e1', source: 'trigger', target: 'task' }],
  settings: {},
};

/** The node a pick reports as selected must be one the editor can actually select. */
function selected(result: ReturnType<typeof applyCreatorPick>) {
  if (!result.ok) throw new Error(`expected a pick, got: ${result.error}`);
  const node = result.graph.nodes.find((n) => n.id === result.selectId);
  expect(node, 'selectId names a node in the returned graph').toBeDefined();
  return node;
}

describe('applyCreatorPick', () => {
  it('places a floating step where the gesture pointed, and lets the layout place one with no point', () => {
    const atPoint = applyCreatorPick(
      graph,
      { kind: 'floating', position: { x: 40, y: 80 } },
      'agent',
    );
    expect(selected(atPoint)).toMatchObject({ blockType: 'agent', position: { x: 40, y: 80 } });

    // The header button and the keyboard shortcut name no point: a random spot could land the step
    // outside the viewport the author is looking at.
    const noPoint = applyCreatorPick(graph, { kind: 'floating' }, 'agent');
    expect(selected(noPoint)).not.toHaveProperty('position');
  });

  it('appends a connected step and reports it, carrying the branch parent of a fan-out', () => {
    const result = applyCreatorPick(
      graph,
      { kind: 'append', sourceId: 'task', sourceHandle: undefined },
      'run_command',
    );
    if (!result.ok) throw new Error(result.error);
    expect(selected(result)).toMatchObject({ blockType: 'run_command' });
    expect(result.graph.edges).toContainEqual(
      expect.objectContaining({ source: 'task', target: result.selectId }),
    );

    const inBranch = applyCreatorPick(
      graph,
      { kind: 'append', sourceId: 'fan', sourceHandle: undefined },
      'run_command',
    );
    expect(selected(inBranch)).toMatchObject({ parentId: 'fan' });
  });

  it('splits an edge, reporting the inserted step rather than either end', () => {
    const result = applyCreatorPick(graph, { kind: 'insert_edge', edgeId: 'e1' }, 'condition');
    if (!result.ok) throw new Error(result.error);
    expect(selected(result)).toMatchObject({ blockType: 'condition' });
    expect(result.selectId).not.toBe('trigger');
    expect(result.selectId).not.toBe('task');
    expect(result.graph.edges.map((e) => e.id)).not.toContain('e1');
  });

  it('refuses with the message the editor shows when the graph is full or the edge is gone', () => {
    const full: FlowGraph = {
      ...graph,
      nodes: Array.from({ length: MAX_FLOW_GRAPH_NODES }, (_, i) => ({
        id: `n${i}`,
        blockType: 'agent',
      })),
    };
    expect(applyCreatorPick(full, { kind: 'floating' }, 'agent')).toEqual({
      ok: false,
      error: `Cannot add node: Maximum of ${MAX_FLOW_GRAPH_NODES} nodes reached`,
    });
    expect(
      applyCreatorPick(full, { kind: 'append', sourceId: 'n0', sourceHandle: undefined }, 'agent'),
    ).toMatchObject({ ok: false });
    expect(applyCreatorPick(graph, { kind: 'insert_edge', edgeId: 'gone' }, 'agent')).toEqual({
      ok: false,
      error: 'Cannot split edge: Edge not found',
    });
  });

  it('refuses an append the graph rules reject, and leaves the graph alone', () => {
    const result = applyCreatorPick(
      graph,
      { kind: 'append', sourceId: 'task', sourceHandle: undefined },
      'manual_trigger',
    );
    expect(result.ok).toBe(false);
  });
});
