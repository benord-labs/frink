import { describe, expect, it } from 'vitest';
import {
  addEdgeToGraph,
  addNodeToGraph,
  cycleBodyLength,
  getConnectionBlockReason,
  outgoingHandleSlotKey,
  reconcileNodeProjectsOnDefaultChange,
  removeEdgeFromGraph,
  removeNodeFromGraph,
  resizeNodeInGraph,
  splitEdgeInGraph,
  updateNodePositionInGraph,
  updateNodePositionsInGraph,
} from './flow-graph-mutations';
import type { FlowGraph } from './validate-flow-graph';
import { MAX_FLOW_GRAPH_NODES } from './validate-flow-graph';

const base: FlowGraph = {
  nodes: [
    { id: 't', blockType: 'manual_trigger' },
    { id: 'a', blockType: 'run_command', config: { command: 'step', projectId: 'p1' } },
  ],
  edges: [{ id: 'e1', source: 't', target: 'a' }],
};

describe('outgoingHandleSlotKey', () => {
  it('maps null, empty, and out to __default__', () => {
    expect(outgoingHandleSlotKey(null)).toBe('__default__');
    expect(outgoingHandleSlotKey(undefined)).toBe('__default__');
    expect(outgoingHandleSlotKey('')).toBe('__default__');
    expect(outgoingHandleSlotKey('out')).toBe('__default__');
  });

  it('preserves condition branch ids', () => {
    expect(outgoingHandleSlotKey('true')).toBe('true');
    expect(outgoingHandleSlotKey('false')).toBe('false');
  });
});

describe('cycleBodyLength', () => {
  it('returns hop count from target to source along directed edges', () => {
    const g: FlowGraph = {
      nodes: [
        { id: 't', blockType: 'manual_trigger' },
        { id: 'a', blockType: 'run_command', config: { command: 'step', projectId: 'p1' } },
        { id: 'b', blockType: 'run_command', config: { command: 'step', projectId: 'p1' } },
        { id: 'c', blockType: 'condition' },
      ],
      edges: [
        { id: 'e1', source: 't', target: 'a' },
        { id: 'e2', source: 'a', target: 'b' },
        { id: 'e3', source: 'b', target: 'c' },
      ],
    };
    expect(cycleBodyLength(g, 'c', 'a')).toBe(3);
  });

  it('returns 0 when source is not reachable from target', () => {
    const g: FlowGraph = {
      nodes: [
        { id: 't', blockType: 'manual_trigger' },
        { id: 'a', blockType: 'run_command', config: { command: 'step', projectId: 'p1' } },
      ],
      edges: [{ id: 'e1', source: 't', target: 'a' }],
    };
    expect(cycleBodyLength(g, 't', 'a')).toBe(0);
  });

  it('ignores edges whose endpoints are missing from nodes (dangling)', () => {
    const g: FlowGraph = {
      nodes: [
        { id: 't', blockType: 'manual_trigger' },
        { id: 'a', blockType: 'run_command', config: { command: 'step', projectId: 'p1' } },
        { id: 'b', blockType: 'run_command', config: { command: 'step', projectId: 'p1' } },
      ],
      edges: [
        { id: 'e1', source: 't', target: 'a' },
        { id: 'e2', source: 'a', target: 'b' },
        { id: 'eGhost', source: 't', target: 'not-a-node' },
      ],
    };
    expect(cycleBodyLength(g, 'b', 't')).toBe(3);
  });
});

describe('flow-graph-mutations', () => {
  it('addNodeToGraph appends a node', () => {
    const result = addNodeToGraph(base, 'run_command', { x: 1, y: 2 });
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.graph.nodes).toHaveLength(3);
      expect(result.graph.nodes[2]?.blockType).toBe('run_command');
      expect(result.graph.nodes[2]?.position).toEqual({ x: 1, y: 2 });
      expect(result.graph.edges).toEqual(base.edges);
    }
  });

  it('removeNodeFromGraph drops incident edges', () => {
    const g = removeNodeFromGraph(base, 'a');
    expect(g.nodes.map((n) => n.id)).toEqual(['t']);
    expect(g.edges).toHaveLength(0);
  });

  it('removeNodeFromGraph cascades through a Fan Out body', () => {
    const graph: FlowGraph = {
      nodes: [
        { id: 'fan', blockType: 'fan_out' },
        { id: 'body', blockType: 'agent', parentId: 'fan' },
        { id: 'after', blockType: 'agent' },
      ],
      edges: [
        { id: 'e1', source: 'fan', target: 'body' },
        { id: 'e2', source: 'body', target: 'after' },
      ],
    };
    const result = removeNodeFromGraph(graph, 'fan');
    expect(result.nodes.map((node) => node.id)).toEqual(['after']);
    expect(result.edges).toEqual([]);
  });

  it('addEdgeToGraph appends edge with optional sourceHandle when valid', () => {
    const g: FlowGraph = {
      nodes: [
        { id: 't', blockType: 'manual_trigger' },
        { id: 'c', blockType: 'condition' },
        { id: 'x', blockType: 'run_command', config: { command: 'step', projectId: 'p1' } },
      ],
      edges: [],
    };
    const r = addEdgeToGraph(g, { source: 'c', target: 'x', sourceHandle: 'true' });
    expect(r.success).toBe(true);
    if (r.success) {
      expect(r.graph.edges).toHaveLength(1);
      expect(r.graph.edges[0]?.sourceHandle).toBe('true');
    }
  });

  it('addEdgeToGraph returns error when getConnectionBlockReason rejects', () => {
    const r = addEdgeToGraph(base, { source: 'a', target: 't' });
    expect(r.success).toBe(false);
    if (!r.success) {
      expect(r.error).toMatch(/trigger/i);
    }
  });

  it('allows a Fan Out to connect to multiple contained branch roots', () => {
    const graph: FlowGraph = {
      nodes: [
        { id: 'fan', blockType: 'fan_out' },
        { id: 'a', blockType: 'agent', parentId: 'fan' },
        { id: 'b', blockType: 'agent', parentId: 'fan' },
      ],
      edges: [{ id: 'e1', source: 'fan', target: 'a' }],
    };

    expect(getConnectionBlockReason(graph, { source: 'fan', target: 'b' })).toBeNull();
  });

  it('removeEdgeFromGraph filters by id', () => {
    const g = removeEdgeFromGraph(base, 'e1');
    expect(g.edges).toHaveLength(0);
  });

  it('splitEdgeInGraph inserts node between endpoints', () => {
    const result = splitEdgeInGraph(base, 'e1', 'approval');
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.graph.nodes).toHaveLength(3);
      expect(result.graph.edges).toHaveLength(2);
      expect(result.graph.edges.some((e) => e.source === 't' && e.target !== 'a')).toBe(true);
      expect(result.graph.edges.some((e) => e.target === 'a')).toBe(true);
    }
  });

  it('splitEdgeInGraph keeps an inserted body step inside its Fan Out', () => {
    const graph: FlowGraph = {
      nodes: [
        { id: 'fan', blockType: 'fan_out' },
        { id: 'body', blockType: 'agent', parentId: 'fan' },
        { id: 'after', blockType: 'agent' },
      ],
      edges: [
        { id: 'entry', source: 'fan', target: 'body' },
        { id: 'exit', source: 'body', target: 'after' },
      ],
    };
    const result = splitEdgeInGraph(graph, 'entry', 'run_command');
    expect(result.success).toBe(true);
    if (!result.success) return;
    expect(result.graph.nodes.find((node) => !graph.nodes.includes(node))?.parentId).toBe('fan');
  });

  it('updateNodePositionInGraph sets position', () => {
    const g = updateNodePositionInGraph(base, 'a', { x: 10, y: 20 });
    expect(g.nodes.find((n) => n.id === 'a')?.position).toEqual({ x: 10, y: 20 });
  });

  it('resizeNodeInGraph commits the size and every moved position in one update', () => {
    const g = resizeNodeInGraph(base, 'a', { width: 900, height: 500 }, [
      { id: 'a', position: { x: -100, y: -50 } },
      { id: 't', position: { x: 140, y: 202 } },
    ]);
    expect(g.nodes.find((n) => n.id === 'a')).toMatchObject({
      size: { width: 900, height: 500 },
      position: { x: -100, y: -50 },
    });
    expect(g.nodes.find((n) => n.id === 't')).toMatchObject({ position: { x: 140, y: 202 } });
    expect(g.nodes.find((n) => n.id === 't')?.size).toBeUndefined();
  });

  it('updateNodePositionsInGraph applies many positions in one pass', () => {
    const g = updateNodePositionsInGraph(base, [
      { id: 't', position: { x: 1, y: 2 } },
      { id: 'a', position: { x: 3, y: 4 } },
    ]);
    expect(g.nodes.find((n) => n.id === 't')?.position).toEqual({ x: 1, y: 2 });
    expect(g.nodes.find((n) => n.id === 'a')?.position).toEqual({ x: 3, y: 4 });
    expect(g).not.toBe(base);
  });

  it('updateNodePositionsInGraph ignores unknown ids and leaves other nodes untouched', () => {
    const g = updateNodePositionsInGraph(base, [
      { id: 'a', position: { x: 9, y: 9 } },
      { id: 'ghost', position: { x: 0, y: 0 } },
    ]);
    expect(g.nodes.find((n) => n.id === 'a')?.position).toEqual({ x: 9, y: 9 });
    expect(g.nodes.find((n) => n.id === 't')?.position).toBeUndefined();
    expect(g.nodes).toHaveLength(base.nodes.length);
  });

  it('updateNodePositionsInGraph returns the same graph for an empty update', () => {
    expect(updateNodePositionsInGraph(base, [])).toBe(base);
  });

  it('updateNodePositionsInGraph keeps untouched node identity and preserves moved-node fields', () => {
    const g = updateNodePositionsInGraph(base, [{ id: 'a', position: { x: 7, y: 8 } }]);
    const movedBefore = base.nodes.find((n) => n.id === 'a');
    const movedAfter = g.nodes.find((n) => n.id === 'a');
    const untouchedBefore = base.nodes.find((n) => n.id === 't');
    const untouchedAfter = g.nodes.find((n) => n.id === 't');
    // Untouched nodes must keep object identity: FlowCanvas's render-sync merge and the FlowStepRf
    // memo (a.node === b.node) rely on it to avoid re-rendering every node on each group drag.
    expect(untouchedAfter).toBe(untouchedBefore);
    // Moved node is a fresh object carrying the new position, with all other fields preserved.
    expect(movedAfter).not.toBe(movedBefore);
    expect(movedAfter?.position).toEqual({ x: 7, y: 8 });
    expect(movedAfter?.blockType).toBe(movedBefore?.blockType);
    expect(movedAfter?.config).toBe(movedBefore?.config);
    // A position-only change reuses the edges array (no edge churn).
    expect(g.edges).toBe(base.edges);
  });

  it('getConnectionBlockReason rejects edge into trigger', () => {
    const reason = getConnectionBlockReason(base, { source: 'a', target: 't' });
    expect(reason).toMatch(/trigger/i);
  });

  it('getConnectionBlockReason rejects outgoing edge from end node', () => {
    const g: FlowGraph = {
      nodes: [
        { id: 't', blockType: 'manual_trigger' },
        { id: 'e', blockType: 'end' },
        { id: 'a', blockType: 'run_command', config: { command: 'step', projectId: 'p1' } },
      ],
      edges: [{ id: 'e1', source: 't', target: 'e' }],
    };
    const reason = getConnectionBlockReason(g, { source: 'e', target: 'a' });
    expect(reason).toMatch(/end/i);
  });

  it('getConnectionBlockReason rejects cycle', () => {
    const g: FlowGraph = {
      nodes: [
        { id: 't', blockType: 'manual_trigger' },
        { id: 'a', blockType: 'run_command', config: { command: 'step', projectId: 'p1' } },
        { id: 'b', blockType: 'run_command', config: { command: 'step', projectId: 'p1' } },
      ],
      edges: [
        { id: 'e1', source: 't', target: 'a' },
        { id: 'e2', source: 'a', target: 'b' },
      ],
    };
    const reason = getConnectionBlockReason(g, { source: 'b', target: 'a' });
    expect(reason).toMatch(/cycle/i);
  });

  it('addNodeToGraph returns MAX_NODES_REACHED when at capacity', () => {
    const fullGraph: FlowGraph = {
      nodes: Array.from({ length: MAX_FLOW_GRAPH_NODES }, (_, i) => ({
        id: `n${i}`,
        blockType: 'run_command',
        config: { command: 'step', projectId: 'p1' },
      })),
      edges: [],
    };
    const result = addNodeToGraph(fullGraph, 'run_command');
    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error).toBe('MAX_NODES_REACHED');
    }
  });

  it('splitEdgeInGraph wires condition true-branch to downstream node', () => {
    const result = splitEdgeInGraph(base, 'e1', 'condition');
    expect(result.success).toBe(true);
    if (result.success) {
      const { edges, nodes } = result.graph;
      const conditionId = nodes.find((n) => n.blockType === 'condition')?.id;
      const outgoing = edges.filter((e) => e.source === conditionId);
      expect(outgoing).toHaveLength(1);
      expect(outgoing[0]?.sourceHandle).toBe('true');
      expect(outgoing[0]?.target).toBe('a');
    }
  });

  it('splitEdgeInGraph preserves sourceHandle on the upstream segment', () => {
    const g: FlowGraph = {
      nodes: [
        { id: 't', blockType: 'manual_trigger' },
        { id: 'c', blockType: 'condition' },
        { id: 'a', blockType: 'run_command', config: { command: 'step', projectId: 'p1' } },
      ],
      edges: [{ id: 'ec', source: 'c', target: 'a', sourceHandle: 'false' }],
    };
    const result = splitEdgeInGraph(g, 'ec', 'http_request');
    expect(result.success).toBe(true);
    if (result.success) {
      const fromCondition = result.graph.edges.find((e) => e.source === 'c');
      expect(fromCondition?.sourceHandle).toBe('false');
      const toA = result.graph.edges.find((e) => e.target === 'a');
      expect(toA?.sourceHandle).toBeUndefined();
    }
  });

  it('splitEdgeInGraph can be chained on the inner segment (second insert-on-edge)', () => {
    const first = splitEdgeInGraph(base, 'e1', 'approval');
    expect(first.success).toBe(true);
    if (!first.success) return;
    const innerToA = first.graph.edges.find((e) => e.target === 'a' && e.source !== 't');
    expect(innerToA).toBeDefined();
    if (!innerToA) return;
    const second = splitEdgeInGraph(first.graph, innerToA.id, 'run_command');
    expect(second.success).toBe(true);
    if (second.success) {
      expect(second.graph.nodes).toHaveLength(4);
      expect(second.graph.edges).toHaveLength(3);
      const stillReachesA = second.graph.edges.some((e) => e.target === 'a');
      expect(stillReachesA).toBe(true);
      const fromTrigger = second.graph.edges.filter((e) => e.source === 't');
      expect(fromTrigger).toHaveLength(1);
    }
  });

  it('splitEdgeInGraph chained with condition on inner edge keeps true handle on final hop', () => {
    const first = splitEdgeInGraph(base, 'e1', 'approval');
    expect(first.success).toBe(true);
    if (!first.success) return;
    const innerToA = first.graph.edges.find((e) => e.target === 'a' && e.source !== 't');
    expect(innerToA).toBeDefined();
    if (!innerToA) return;
    const second = splitEdgeInGraph(first.graph, innerToA.id, 'condition');
    expect(second.success).toBe(true);
    if (second.success) {
      const conditionId = second.graph.nodes.find((n) => n.blockType === 'condition')?.id;
      expect(conditionId).toBeDefined();
      const fromCondition = second.graph.edges.filter((e) => e.source === conditionId);
      expect(fromCondition).toHaveLength(1);
      expect(fromCondition[0]?.sourceHandle).toBe('true');
      expect(fromCondition[0]?.target).toBe('a');
    }
  });

  it('splitEdgeInGraph returns EDGE_NOT_FOUND for missing edge', () => {
    const result = splitEdgeInGraph(base, 'nonexistent', 'approval');
    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error).toBe('EDGE_NOT_FOUND');
    }
  });

  it('splitEdgeInGraph returns MAX_NODES_REACHED when at capacity', () => {
    const fullGraph: FlowGraph = {
      nodes: Array.from({ length: MAX_FLOW_GRAPH_NODES }, (_, i) => ({
        id: `n${i}`,
        blockType: 'run_command',
        config: { command: 'step', projectId: 'p1' },
      })),
      edges: [{ id: 'e1', source: 'n0', target: 'n1' }],
    };
    const result = splitEdgeInGraph(fullGraph, 'e1', 'approval');
    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error).toBe('MAX_NODES_REACHED');
    }
  });

  it('splitEdgeInGraph with end: produces invalid graph (end cannot have outgoing edge) — UI must filter end from insert-on-edge mode', () => {
    // splitEdgeInGraph itself does not validate block-type constraints (that is validate-flow-graph's job).
    // The UI filters `end` from insert_edge creatorAllowedTypes to prevent this path.
    // This test documents the raw behavior so we know it IS structurally generated but invalid.
    const result = splitEdgeInGraph(base, 'e1', 'end');
    expect(result.success).toBe(true);
    if (result.success) {
      // The graph is structurally produced but will fail validate-flow-graph
      const endNode = result.graph.nodes.find((n) => n.blockType === 'end');
      expect(endNode).toBeDefined();
      const endOutgoing = result.graph.edges.filter((e) => e.source === endNode?.id);
      expect(endOutgoing.length).toBeGreaterThan(0);
    }
  });

  it('splitEdgeInGraph with fan_out: no sourceHandle on downstream edge', () => {
    // fan_out has exactly 1 outgoing edge with no sourceHandle (unlike condition which uses 'true')
    const result = splitEdgeInGraph(base, 'e1', 'fan_out');
    expect(result.success).toBe(true);
    if (result.success) {
      const { edges, nodes } = result.graph;
      const fanOutId = nodes.find((n) => n.blockType === 'fan_out')?.id;
      expect(fanOutId).toBeDefined();
      const outgoing = edges.filter((e) => e.source === fanOutId);
      expect(outgoing).toHaveLength(1);
      // fan_out must NOT have a sourceHandle — it has exactly 1 outgoing edge
      expect(outgoing[0]?.sourceHandle).toBeUndefined();
      expect(outgoing[0]?.target).toBe('a');
    }
  });
});

describe('reconcileNodeProjectsOnDefaultChange', () => {
  const OLD_PID = 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa';
  const NEW_PID = 'bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb';
  const OTHER_PID = 'cccccccc-cccc-cccc-cccc-cccccccccccc';

  const mkGraph = (nodeConfigs: (Record<string, unknown> | undefined)[]): FlowGraph => ({
    nodes: nodeConfigs.map((config, i) => ({
      id: `n${i}`,
      blockType: i === 0 ? 'manual_trigger' : 'run_command',
      ...(config !== undefined ? { config } : {}),
    })),
    edges: [],
    settings: { defaultProjectId: OLD_PID },
  });

  it('clears projectId on nodes matching the previous default', () => {
    const g = mkGraph([undefined, { projectId: OLD_PID, command: 'echo hi' }]);
    const result = reconcileNodeProjectsOnDefaultChange(g, OLD_PID, NEW_PID);
    const cfg = result.nodes[1]?.config as Record<string, unknown> | undefined;
    expect(cfg?.projectId).toBeUndefined();
    expect(cfg?.command).toBe('echo hi');
  });

  it('removes config entirely when projectId was the only key', () => {
    const g = mkGraph([undefined, { projectId: OLD_PID }]);
    const result = reconcileNodeProjectsOnDefaultChange(g, OLD_PID, NEW_PID);
    expect(result.nodes[1]?.config).toBeUndefined();
  });

  it('leaves nodes with a different override untouched', () => {
    const g = mkGraph([undefined, { projectId: OTHER_PID, command: 'x' }]);
    const result = reconcileNodeProjectsOnDefaultChange(g, OLD_PID, NEW_PID);
    const cfg = result.nodes[1]?.config as Record<string, unknown>;
    expect(cfg.projectId).toBe(OTHER_PID);
  });

  it('leaves nodes with no projectId untouched', () => {
    const g = mkGraph([undefined, { command: 'hello' }]);
    const result = reconcileNodeProjectsOnDefaultChange(g, OLD_PID, NEW_PID);
    const cfg = result.nodes[1]?.config as Record<string, unknown>;
    expect(cfg.command).toBe('hello');
    expect(cfg.projectId).toBeUndefined();
  });

  it('returns same graph reference when prev and next are equal', () => {
    const g = mkGraph([undefined, { projectId: OLD_PID }]);
    const result = reconcileNodeProjectsOnDefaultChange(g, OLD_PID, OLD_PID);
    expect(result).toBe(g);
  });

  it('returns same graph reference when prev is empty', () => {
    const g = mkGraph([undefined, { projectId: OLD_PID }]);
    const result = reconcileNodeProjectsOnDefaultChange(g, undefined, NEW_PID);
    expect(result).toBe(g);
  });

  it('clears matching overrides when next default is undefined (user clears default)', () => {
    const g = mkGraph([undefined, { projectId: OLD_PID, command: 'x' }]);
    const result = reconcileNodeProjectsOnDefaultChange(g, OLD_PID, undefined);
    const cfg = result.nodes[1]?.config as Record<string, unknown> | undefined;
    expect(cfg?.projectId).toBeUndefined();
    expect(cfg?.command).toBe('x');
  });

  it('handles whitespace-padded IDs correctly', () => {
    const g = mkGraph([undefined, { projectId: ` ${OLD_PID} ` }]);
    const result = reconcileNodeProjectsOnDefaultChange(g, ` ${OLD_PID}`, NEW_PID);
    expect(
      (result.nodes[1]?.config as Record<string, unknown> | undefined)?.projectId,
    ).toBeUndefined();
  });
});

describe('addNodeToGraph plugin labelling', () => {
  it('labels a plugin step from its catalog action so no surface shows the raw node name', () => {
    const result = addNodeToGraph({ nodes: [], edges: [] }, 'clickup_create_task');
    expect(result.success).toBe(true);
    if (!result.success) return;
    expect(result.graph.nodes[0].label).toBe('Create a ClickUp task');
  });

  it('leaves a user-authored node unlabelled', () => {
    const result = addNodeToGraph({ nodes: [], edges: [] }, 'my_node');
    expect(result.success).toBe(true);
    if (!result.success) return;
    expect(result.graph.nodes[0].label).toBeUndefined();
  });
});
