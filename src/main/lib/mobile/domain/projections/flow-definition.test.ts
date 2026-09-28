import { describe, expect, it } from 'vitest';
import { projectMobileFlowDefinition } from './flow-definition';

const trigger = { id: 'trigger', blockType: 'manual_trigger' };
// A saved graph the desktop validator accepts: one trigger plus the given steps.
function saved(nodes: Array<Record<string, unknown>>, edges: Array<Record<string, unknown>> = []) {
  return { nodes: [trigger, ...nodes], edges };
}

describe('mobile current Flow definition', () => {
  it('retains branch, loop and parent references while omitting operational config', () => {
    const graph = {
      nodes: [
        { id: 'trigger', blockType: 'manual_trigger' },
        { id: 'branch', blockType: 'condition', config: { secret: 'condition config' } },
        { id: 'fan', blockType: 'fan_out' },
        {
          id: 'agent',
          blockType: 'agent',
          parentId: 'fan',
          label: 'Review changes',
          config: { instructions: 'Check accessibility', apiKey: 'secret' },
        },
        {
          id: 'command',
          blockType: 'run_command',
          config: { command: 'secret shell command', instructions: 'not agent instructions' },
        },
        {
          id: 'http',
          blockType: 'http_request',
          config: { headers: { Authorization: 'secret' }, url: 'https://private.example' },
        },
      ],
      edges: [
        { id: 'a', source: 'trigger', target: 'branch' },
        { id: 'b', source: 'branch', target: 'fan', sourceHandle: 'true', label: 'Continue' },
        { id: 'c', source: 'branch', target: 'command', sourceHandle: 'false' },
        { id: 'd', source: 'agent', target: 'branch', label: 'Recheck' },
      ],
      settings: { privateSetting: 'secret' },
    };
    const definition = projectMobileFlowDefinition(graph, 7);
    expect(definition).toEqual({
      versionNumber: 7,
      nodes: [
        {
          id: 'trigger',
          blockType: 'manual_trigger',
          label: 'Manual Trigger',
          parentId: null,
          instructions: null,
        },
        {
          id: 'branch',
          blockType: 'condition',
          label: 'Condition',
          parentId: null,
          instructions: null,
        },
        { id: 'fan', blockType: 'fan_out', label: 'Fan Out', parentId: null, instructions: null },
        {
          id: 'agent',
          blockType: 'agent',
          label: 'Review changes',
          parentId: 'fan',
          instructions: 'Check accessibility',
        },
        {
          id: 'command',
          blockType: 'run_command',
          label: 'Run Command',
          parentId: null,
          instructions: null,
        },
        {
          id: 'http',
          blockType: 'http_request',
          label: 'HTTP Request',
          parentId: null,
          instructions: null,
        },
      ],
      edges: graph.edges.map((edge) => ({
        ...edge,
        label: edge.label ?? null,
        sourceHandle: edge.sourceHandle ?? null,
      })),
    });
    expect(JSON.stringify(definition)).not.toContain('secret');
    expect(JSON.stringify(definition)).not.toContain('private.example');
  });

  it('keeps a disconnected definition at the desktop step limit whole', () => {
    const nodes = Array.from({ length: 49 }, (_, index) => ({
      id: String(index),
      blockType: 'agent',
      config: { instructions: 'x'.repeat(1000) },
    }));
    const definition = projectMobileFlowDefinition(saved(nodes), 2);
    expect(definition?.nodes).toHaveLength(50);
    expect(definition?.nodes[49].instructions).toHaveLength(1000);
  });

  it('withholds definitions the desktop save validator rejects', () => {
    expect(projectMobileFlowDefinition({ nodes: [], edges: [] }, 1)).toBeNull();
    expect(
      projectMobileFlowDefinition({ nodes: [{ id: 'a', blockType: 'agent' }], edges: [] }, 1),
    ).toBeNull();
    const tooMany = Array.from({ length: 50 }, (_, index) => ({
      id: String(index),
      blockType: 'agent',
    }));
    expect(projectMobileFlowDefinition(saved(tooMany), 1)).toBeNull();
  });

  it('returns unavailable for oversized topology instead of cutting off steps or connections', () => {
    const nodes = Array.from({ length: 501 }, (_, index) => ({
      id: String(index),
      blockType: 'agent',
    }));
    expect(projectMobileFlowDefinition({ nodes, edges: [] }, 1)).toBeNull();
    const edges = Array.from({ length: 2501 }, (_, index) => ({
      id: String(index),
      source: 'a',
      target: 'a',
    }));
    expect(
      projectMobileFlowDefinition({ nodes: [{ id: 'a', blockType: 'agent' }], edges }, 1),
    ).toBeNull();
  });

  it.each(['x'.repeat(512 * 1024), '😀'.repeat(150000), '\u0000'.repeat(100000)])(
    'rejects a definition whose text or serialized UTF-8 payload exceeds the mobile budget',
    (instructions) => {
      expect(
        projectMobileFlowDefinition(
          saved([{ id: 'a', blockType: 'agent', config: { instructions } }]),
          1,
        ),
      ).toBeNull();
      expect(
        projectMobileFlowDefinition(
          saved([{ id: 'a', blockType: 'agent', config: { instructions: 'ok' } }]),
          1,
        ),
      ).not.toBeNull();
    },
  );

  it('does not traverse or budget unused operational config', () => {
    const graph = saved([
      {
        id: 'a',
        blockType: 'run_command',
        config: {
          command: 'x'.repeat(1024 * 1024),
          headers: { secret: 'x'.repeat(1024 * 1024) },
        },
      },
    ]);
    expect(projectMobileFlowDefinition(graph, 1)?.nodes.slice(1)).toEqual([
      {
        id: 'a',
        blockType: 'run_command',
        label: 'Run Command',
        parentId: null,
        instructions: null,
      },
    ]);
  });

  it.each([
    null,
    {},
    { nodes: [null], edges: [] },
    {
      nodes: [
        { id: 'a', blockType: 'agent' },
        { id: 'a', blockType: 'agent' },
      ],
      edges: [],
    },
    { nodes: [{ id: 'a', blockType: 'agent', parentId: 'missing' }], edges: [] },
    { nodes: [{ id: 'a', blockType: 'agent', parentId: 'a' }], edges: [] },
    {
      nodes: [
        { id: 'a', blockType: 'agent' },
        { id: 'b', blockType: 'agent', parentId: 'a' },
      ],
      edges: [],
    },
    { nodes: [{ id: 'fan', blockType: 'fan_out', parentId: 'fan' }], edges: [] },
    {
      nodes: [{ id: 'a', blockType: 'agent' }],
      edges: [{ id: 'e', source: 'a', target: 'missing' }],
    },
  ])('does not invent a partial definition from absent or malformed topology: %j', (graph) => {
    expect(projectMobileFlowDefinition(graph, 1)).toBeNull();
  });

  it.each([null, undefined, '1', 0, -1, 1.5])(
    'requires the actual saved version number: %s',
    (version) => {
      expect(projectMobileFlowDefinition(saved([]), 1)).not.toBeNull();
      expect(projectMobileFlowDefinition(saved([]), version)).toBeNull();
    },
  );
});
