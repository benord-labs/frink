import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { FlowGraph } from '../../../../shared/lib/validate-flow-graph';

const discoverCustomNodes = vi.fn();
vi.mock('../../custom-nodes/discovery', () => ({
  discoverCustomNodes: () => discoverCustomNodes(),
}));

const { describeFlowRunBlockers } = await import('./run-readiness');

/** A runnable two-step flow whose second step is the custom node under test. */
function graphWith(config: Record<string, unknown>): FlowGraph {
  return {
    nodes: [
      { id: 't', blockType: 'manual_trigger' },
      { id: 'cn', blockType: 'my-custom-node', config },
    ],
    edges: [{ id: 'e', source: 't', target: 'cn' }],
  } as FlowGraph;
}

function installed(inputs: Record<string, unknown>): void {
  discoverCustomNodes.mockReturnValue({
    valid: [{ name: 'my-custom-node', inputs }],
  });
}

describe('describeFlowRunBlockers', () => {
  beforeEach(() => {
    discoverCustomNodes.mockReset();
    installed({});
  });

  it('blocks the run for a saved draft that has a Fan Out inside another Fan Out', () => {
    const graph = {
      nodes: [
        { id: 't', blockType: 'manual_trigger' },
        { id: 'outer', blockType: 'fan_out' },
        { id: 'inner', blockType: 'fan_out', parentId: 'outer' },
      ],
      edges: [{ id: 'e', source: 't', target: 'outer' }],
    } as FlowGraph;

    expect(describeFlowRunBlockers(graph)).toContain(
      '(id "inner") cannot sit inside another Fan Out',
    );
  });

  it('returns null for a flow whose custom node declares no inputs', () => {
    expect(describeFlowRunBlockers(graphWith({}))).toBeNull();
  });

  it('blocks the run and names a required input that has no value', () => {
    installed({ repo: { type: 'string', required: true } });
    expect(describeFlowRunBlockers(graphWith({}))).toContain('repo');
  });

  it('returns null once the required input is satisfied', () => {
    installed({ repo: { type: 'string', required: true } });
    expect(
      describeFlowRunBlockers(graphWith({ repo: 'owner/repo' })),
    ).toBeNull();
  });

  it('returns null when a manifest default covers the required input', () => {
    installed({
      repo: { type: 'string', required: true, default: 'owner/repo' },
    });
    expect(describeFlowRunBlockers(graphWith({}))).toBeNull();
  });

  it('reports every offending node, not just the first', () => {
    installed({ repo: { type: 'string', required: true } });
    const graph = {
      nodes: [
        { id: 't', blockType: 'manual_trigger' },
        { id: 'a', blockType: 'my-custom-node', config: {} },
        { id: 'b', blockType: 'my-custom-node', config: {}, label: 'Second step' },
      ],
      edges: [
        { id: 'e1', source: 't', target: 'a' },
        { id: 'e2', source: 'a', target: 'b' },
      ],
    } as FlowGraph;
    const blockers = describeFlowRunBlockers(graph);
    expect(blockers).toContain('my-custom-node');
    expect(blockers).toContain('Second step');
  });

  it('does not block a run for a custom node that is not installed locally', () => {
    // Discovery knows nothing about it, so there is no manifest to judge against. Blocking here
    // would be a guess; the executor already fails with a "not found" message if it truly is gone.
    discoverCustomNodes.mockReturnValue({ valid: [] });
    expect(describeFlowRunBlockers(graphWith({}))).toBeNull();
  });

  it('appends the catalog hint only when the blocker is an unresolved webhook selection', () => {
    installed({ repo: { type: 'string', required: true } });
    expect(describeFlowRunBlockers(graphWith({}))).not.toContain(
      'frink_flows_list_catalog',
    );
  });

  it('skips manifest discovery entirely for a graph with no custom nodes', () => {
    const graph = {
      nodes: [
        { id: 't', blockType: 'manual_trigger' },
        { id: 'r', blockType: 'run_command', config: { command: 'echo hi' } },
      ],
      edges: [{ id: 'e', source: 't', target: 'r' }],
    } as FlowGraph;
    expect(describeFlowRunBlockers(graph)).toBeNull();
    expect(discoverCustomNodes).not.toHaveBeenCalled();
  });
});

// sc-3166: frink_flows_run refuses an over-cap agent prompt instead of dispatching it to fail.
describe('describeFlowRunBlockers — agent prose length cap', () => {
  const agentGraph = (instructions: string): FlowGraph =>
    ({
      nodes: [
        { id: 't', blockType: 'manual_trigger' },
        { id: 'st', blockType: 'start_task', config: { projectId: 'p1' } },
        { id: 'a', blockType: 'agent', label: 'Writer', config: { instructions } },
      ],
      edges: [
        { id: 'e1', source: 't', target: 'st' },
        { id: 'e2', source: 'st', target: 'a' },
      ],
    }) as FlowGraph;

  beforeEach(() => {
    discoverCustomNodes.mockReset();
    installed({});
  });

  it('blocks a run whose agent instructions are over the cap', () => {
    expect(describeFlowRunBlockers(agentGraph('a'.repeat(50_001)))).toBe(
      'Agent node "Writer" instructions is 50,001 characters; the limit is 50,000',
    );
  });

  it('does not block at exactly the cap', () => {
    expect(describeFlowRunBlockers(agentGraph('a'.repeat(50_000)))).toBeNull();
  });
});
