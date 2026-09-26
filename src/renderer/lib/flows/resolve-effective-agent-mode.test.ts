import { describe, expect, it } from 'vitest';
import { resolveEffectiveAgentMode } from './resolve-effective-agent-mode';

/** Linear start_task → …pass-through… → agent chain with the given start_task startMode. */
function chainGraph(startMode: unknown, hops = 0) {
  const middleIds = Array.from({ length: hops }, (_, i) => `c${i}`);
  const chain = ['start', ...middleIds, 'a'];
  return {
    nodes: [
      { id: 'start', blockType: 'start_task', config: { startMode } },
      ...middleIds.map((id) => ({ id, blockType: 'condition', config: {} })),
      { id: 'a', blockType: 'agent', config: {} },
    ],
    edges: chain.slice(0, -1).map((source, i) => ({ source, target: chain[i + 1] })),
  };
}

describe('resolveEffectiveAgentMode', () => {
  it("uses the node's own mode when set, ignoring the upstream start_task", () => {
    const graph = chainGraph('plan');
    graph.nodes[graph.nodes.length - 1].config = { mode: 'agent' };
    expect(resolveEffectiveAgentMode(graph, 'a')).toBe('agent');
  });

  it('inherits the start_task mode when the node has no override', () => {
    expect(resolveEffectiveAgentMode(chainGraph('plan'), 'a')).toBe('plan');
    expect(resolveEffectiveAgentMode(chainGraph('debug'), 'a')).toBe('debug');
  });

  it('inherits across intermediate nodes, not just a direct predecessor', () => {
    expect(resolveEffectiveAgentMode(chainGraph('plan', 3), 'a')).toBe('plan');
  });

  it.each([['execute'], ['wait'], [undefined], ['nonsense']])(
    'collapses start_task mode %s to agent — none of these gate on a plan',
    (startMode) => {
      expect(resolveEffectiveAgentMode(chainGraph(startMode), 'a')).toBe('agent');
    },
  );

  it('terminates on a cyclic graph rather than recursing forever', () => {
    const graph = {
      nodes: [
        { id: 'a', blockType: 'agent', config: {} },
        { id: 'b', blockType: 'condition', config: {} },
      ],
      edges: [
        { source: 'b', target: 'a' },
        { source: 'a', target: 'b' },
      ],
    };
    expect(resolveEffectiveAgentMode(graph, 'a')).toBeUndefined();
  });

  it('returns undefined — "cannot tell", not "agent" — when the mode is unresolvable', () => {
    // A caller that defaulted these to 'agent' would silently suppress a real plan gate.
    expect(resolveEffectiveAgentMode(chainGraph('plan'), 'missing-node')).toBeUndefined();
    expect(
      resolveEffectiveAgentMode({ nodes: [{ id: 'a', blockType: 'agent' }] }, 'a'),
    ).toBeUndefined();
    expect(resolveEffectiveAgentMode(null, 'a')).toBeUndefined();
    expect(resolveEffectiveAgentMode(undefined, 'a')).toBeUndefined();
  });

  it('returns undefined when edges are absent so no walk is possible', () => {
    const graph = { nodes: chainGraph('plan').nodes };
    expect(resolveEffectiveAgentMode(graph, 'a')).toBeUndefined();
  });

  it.each([[null], [123], ['Plan'], [''], ['inherit'], [{ mode: 'plan' }]])(
    'treats an unrecognised config.mode (%o) as "no override" and inherits instead',
    (ownMode) => {
      // Flow config is writable by MCP (frink_flows_patch) as well as the editor, so the node's
      // mode can be any shape. Only the three real modes count as an override; anything else must
      // fall through to inheritance rather than being read as a mode or throwing.
      const graph = chainGraph('plan');
      graph.nodes[graph.nodes.length - 1].config = { mode: ownMode } as Record<string, unknown>;
      expect(resolveEffectiveAgentMode(graph, 'a')).toBe('plan');
    },
  );

  it('treats a start_task with no config at all as agent mode', () => {
    const graph = chainGraph('plan');
    graph.nodes[0] = { id: 'start', blockType: 'start_task' } as (typeof graph.nodes)[number];
    expect(resolveEffectiveAgentMode(graph, 'a')).toBe('agent');
  });

  it('skips a dangling edge whose source node no longer exists', () => {
    // Deleting a node in the editor can leave an edge pointing at a missing id; the walk must step
    // over it and keep going rather than treating the branch as exhausted.
    const graph = chainGraph('plan');
    graph.edges.unshift({ source: 'deleted-node', target: 'a' });
    expect(resolveEffectiveAgentMode(graph, 'a')).toBe('plan');
  });

  it('keeps searching sibling branches after one branch dead-ends', () => {
    // The visited set is shared across the whole walk. A branch that terminates without a
    // start_task must not poison the search of a branch that has one.
    const graph = {
      nodes: [
        { id: 'a', blockType: 'agent', config: {} },
        { id: 'dead-end', blockType: 'condition', config: {} },
        { id: 'live', blockType: 'condition', config: {} },
        { id: 'start', blockType: 'start_task', config: { startMode: 'plan' } },
      ],
      edges: [
        { source: 'dead-end', target: 'a' },
        { source: 'live', target: 'a' },
        { source: 'start', target: 'live' },
      ],
    };
    expect(resolveEffectiveAgentMode(graph, 'a')).toBe('plan');
  });

  it('resolves a merge of two start_tasks by edge order, not by distance', () => {
    // Documented limit shared with cloud's findUpstreamStartTaskConfig: the walk is depth-first in
    // `edges` order, so at a merge point the first branch explored wins even when a nearer
    // start_task sits on another branch. Per-branch disambiguation for multi-start_task DAGs is
    // out of scope on both engines (decision flow-agent-node-mode) — pinned here so a change to
    // the traversal is a deliberate one.
    const graph = {
      nodes: [
        { id: 'a', blockType: 'agent', config: {} },
        { id: 'mid', blockType: 'condition', config: {} },
        { id: 'far', blockType: 'start_task', config: { startMode: 'debug' } },
        { id: 'near', blockType: 'start_task', config: { startMode: 'plan' } },
      ],
      edges: [
        { source: 'mid', target: 'a' },
        { source: 'near', target: 'a' },
        { source: 'far', target: 'mid' },
      ],
    };
    expect(resolveEffectiveAgentMode(graph, 'a')).toBe('debug');
  });
});
