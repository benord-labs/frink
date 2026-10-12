import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { FlowGraph } from '../../../../shared/lib/validate-flow-graph';

const discoverCustomNodes = vi.fn();
vi.mock('../../custom-nodes/discovery', () => ({
  discoverCustomNodes: () => discoverCustomNodes(),
}));

const listPluginNodes = vi.fn();
vi.mock('../../integrations/plugin-node-derivation', () => ({
  listPluginNodes: () => listPluginNodes(),
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
    manifestWarnings: [],
    errors: [],
  });
}

/** Script discovery and plugin derivation both reset to "one input-less script node, no plugins". */
function resetNodeSources(): void {
  discoverCustomNodes.mockReset();
  listPluginNodes.mockReset();
  listPluginNodes.mockReturnValue([]);
  installed({});
}

describe('describeFlowRunBlockers', () => {
  beforeEach(resetNodeSources);

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
    discoverCustomNodes.mockReturnValue({ valid: [], manifestWarnings: [], errors: [] });
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
    expect(listPluginNodes).not.toHaveBeenCalled();
  });
});

describe('describeFlowRunBlockers — integration (plugin) nodes', () => {
  const PINNED_TOOL = 'shortcut_search_stories';
  const CALL_TOOL = 'shortcut_call_tool';

  /** A runnable two-step flow whose second step is the integration node under test. */
  function pluginGraph(blockType: string, config: Record<string, unknown>): FlowGraph {
    return {
      nodes: [
        { id: 't', blockType: 'manual_trigger' },
        { id: 'pn', blockType, config },
      ],
      edges: [{ id: 'e', source: 't', target: 'pn' }],
    } as FlowGraph;
  }

  function connected(name: string, inputs: Record<string, unknown>): void {
    listPluginNodes.mockReturnValue([{ name, inputs, unsupportedFields: [] }]);
  }

  /** The generic call-tool row: `tool` is required, `arguments` is optional json. */
  function connectedCallTool(): void {
    connected(CALL_TOOL, {
      tool: { type: 'string', required: true, label: 'Tool' },
      arguments: { type: 'json', label: 'Arguments' },
    });
  }

  beforeEach(resetNodeSources);

  it('blocks the run and names a required input that has no value', () => {
    connected(PINNED_TOOL, { query: { type: 'string', required: true } });
    const blockers = describeFlowRunBlockers(pluginGraph(PINNED_TOOL, {}));
    expect(blockers).toContain(PINNED_TOOL);
    expect(blockers).toContain('missing required inputs: query');
  });

  it('returns null once every required input is set', () => {
    connected(PINNED_TOOL, { query: { type: 'string', required: true } });
    expect(describeFlowRunBlockers(pluginGraph(PINNED_TOOL, { query: 'owner:me' }))).toBeNull();
  });

  it('does not block a required input that holds a template', () => {
    connected(PINNED_TOOL, { query: { type: 'string', required: true } });
    expect(
      describeFlowRunBlockers(pluginGraph(PINNED_TOOL, { query: '{{previous.text}}' })),
    ).toBeNull();
  });

  it('returns null when the schema default covers the required input', () => {
    connected(PINNED_TOOL, { query: { type: 'string', required: true, default: 'owner:me' } });
    expect(describeFlowRunBlockers(pluginGraph(PINNED_TOOL, {}))).toBeNull();
  });

  it('treats false, zero and an object as set values', () => {
    connected(PINNED_TOOL, {
      archived: { type: 'boolean', required: true },
      limit: { type: 'number', required: true },
      filter: { type: 'json', required: true },
    });
    expect(
      describeFlowRunBlockers(
        pluginGraph(PINNED_TOOL, { archived: false, limit: 0, filter: { state: 'open' } }),
      ),
    ).toBeNull();
  });

  it('blocks the generic call-tool node when no tool is chosen', () => {
    connectedCallTool();
    expect(describeFlowRunBlockers(pluginGraph(CALL_TOOL, {}))).toContain(
      'missing required inputs: tool',
    );
  });

  it('does not require arguments on the generic call-tool node', () => {
    connectedCallTool();
    expect(describeFlowRunBlockers(pluginGraph(CALL_TOOL, { tool: 'stories-search' }))).toBeNull();
  });

  it('does not block a node whose plugin is not connected', () => {
    // No derived manifest to judge against; dispatch reports the accurate connection message.
    expect(describeFlowRunBlockers(pluginGraph(PINNED_TOOL, {}))).toBeNull();
  });

  it('judges by the derived manifest when a script manifest shares its name', () => {
    // Discovery rejects a node squatting a plugin namespace, so this is defence in depth: dispatch
    // routes the block type to the plugin, so the plugin's declarations are the ones that apply.
    discoverCustomNodes.mockReturnValue({
      valid: [{ name: PINNED_TOOL, inputs: { repo: { type: 'string', required: true } } }],
      manifestWarnings: [],
      errors: [],
    });
    connected(PINNED_TOOL, { query: { type: 'string', required: true } });
    expect(describeFlowRunBlockers(pluginGraph(PINNED_TOOL, {}))).toContain(
      'missing required inputs: query',
    );
    expect(describeFlowRunBlockers(pluginGraph(PINNED_TOOL, { query: 'owner:me' }))).toBeNull();
  });

  it('still reports a script node alongside a satisfied integration node', () => {
    installed({ repo: { type: 'string', required: true } });
    connected(PINNED_TOOL, { query: { type: 'string', required: true } });
    const graph = {
      nodes: [
        { id: 't', blockType: 'manual_trigger' },
        { id: 'cn', blockType: 'my-custom-node', config: {} },
        { id: 'pn', blockType: PINNED_TOOL, config: { query: 'owner:me' } },
      ],
      edges: [
        { id: 'e1', source: 't', target: 'cn' },
        { id: 'e2', source: 'cn', target: 'pn' },
      ],
    } as FlowGraph;
    const blockers = describeFlowRunBlockers(graph);
    expect(blockers).toContain('missing required inputs: repo');
    expect(blockers).not.toContain(PINNED_TOOL);
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

  beforeEach(resetNodeSources);

  it('blocks a run whose agent instructions are over the cap', () => {
    expect(describeFlowRunBlockers(agentGraph('a'.repeat(50_001)))).toBe(
      'Agent node "Writer" instructions is 50,001 characters; the limit is 50,000',
    );
  });

  it('does not block at exactly the cap', () => {
    expect(describeFlowRunBlockers(agentGraph('a'.repeat(50_000)))).toBeNull();
  });
});
