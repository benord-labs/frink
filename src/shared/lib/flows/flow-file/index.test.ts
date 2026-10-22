import { describe, expect, it } from 'vitest';
import type { FlowGraphInput } from '../../../types/flow-graph-schema';
import { type FlowFile, localizeFlowGraph, parseFlowFile, serializeFlowFile } from '.';

const HOME_PROJECTS = [
  { id: 'api-a', name: 'api' },
  { id: 'web-a', name: 'web' },
  { id: 'unused-a', name: 'unused' },
];

const GRAPH: FlowGraphInput = {
  nodes: [
    { id: 't', blockType: 'manual_trigger' },
    { id: 'build', blockType: 'run_command', label: 'Build', config: { projectId: 'api-a' } },
    { id: 'ship', blockType: 'start_task', label: 'Ship', config: { projectId: 'web-a' } },
  ],
  edges: [
    { id: 'e1', source: 't', target: 'build' },
    { id: 'e2', source: 'build', target: 'ship' },
  ],
  settings: { defaultProjectId: 'api-a', briefing: 'Spec' },
};

function exported(graph: FlowGraphInput = GRAPH): FlowFile {
  const text = serializeFlowFile({ name: 'Release', description: null, graph }, HOME_PROJECTS);
  const parsed = parseFlowFile(text);
  if (!parsed.ok) throw new Error(parsed.message);
  return parsed.file;
}

function withNode(node: FlowGraphInput['nodes'][number]): FlowGraphInput {
  return { ...GRAPH, nodes: [...GRAPH.nodes, node] };
}

describe('flow file', () => {
  it('round-trips a saved flow and names only the projects its steps use', () => {
    const saved = { ...GRAPH, settings: { ...GRAPH.settings, currentBatchId: 'batch-1' } };

    const file = exported(saved);

    expect(file).toEqual({
      kind: 'frink-flow',
      version: 1,
      name: 'Release',
      description: null,
      graph: GRAPH,
      projects: { 'api-a': 'api', 'web-a': 'web' },
    });
  });

  it.each([
    ['not JSON', '{nope', "This file isn't a Frink flow."],
    ['another kind of file', '{"version":1,"name":"Dusk"}', "This file isn't a Frink flow."],
    [
      'a newer format',
      '{"kind":"frink-flow","version":2}',
      'This flow was made by a newer version of Frink. Update Frink to import it.',
    ],
    [
      'a file missing its graph',
      '{"kind":"frink-flow","version":1,"name":"F"}',
      'This flow file is damaged or incomplete.',
    ],
  ])('refuses %s in plain words', (_case, text, message) => {
    expect(parseFlowFile(text)).toEqual({ ok: false, message });
  });

  it('refuses a name longer than a flow can have', () => {
    const text = serializeFlowFile({ name: 'x'.repeat(201), description: null, graph: GRAPH }, []);
    expect(parseFlowFile(text).ok).toBe(false);
  });

  it('reads a file that an editor saved with a byte-order mark', () => {
    const text = serializeFlowFile({ name: 'F', description: 'D', graph: GRAPH }, []);
    expect(parseFlowFile(`\uFEFF${text}`).ok).toBe(true);
  });
});

describe('localizeFlowGraph', () => {
  const noAccounts = new Set<string>();

  it('matches projects by name on another computer', () => {
    const projects = [
      { id: 'api-b', name: 'api' },
      { id: 'web-b', name: 'web' },
    ];

    const result = localizeFlowGraph(exported(), { projects, accountIds: noAccounts });

    expect(result.projectId).toBe('api-b');
    expect(result.graph.settings?.defaultProjectId).toBe('api-b');
    expect(result.graph.nodes.map((node) => node.config?.projectId)).toEqual([
      undefined,
      'api-b',
      'web-b',
    ]);
    expect(result.needsSetup).toEqual([]);
  });

  it('keeps a missing project by name on its step and drops it as the default', () => {
    const projects = [
      { id: 'web-1', name: 'web' },
      { id: 'web-2', name: 'web' },
    ];

    const result = localizeFlowGraph(exported(), { projects, accountIds: noAccounts });

    expect(result.projectId).toBeNull();
    expect(result.graph.settings).toEqual({ briefing: 'Spec' });
    expect(result.graph.nodes.map((node) => node.config?.projectId)).toEqual([
      undefined,
      'api',
      'web',
    ]);
    expect(result.needsSetup).toEqual(['Build', 'Ship']);
  });

  it('leaves templates, project names and ids already on this computer as written', () => {
    const graph = withNode({
      id: 'deploy',
      blockType: 'run_command',
      config: { projectId: '{{trigger.project}}' },
    });
    const file = exported(graph);
    file.graph.nodes[1].config = { projectId: 'api' };

    const result = localizeFlowGraph(file, { projects: HOME_PROJECTS, accountIds: noAccounts });

    expect(result.graph.nodes.map((node) => node.config?.projectId)).toEqual([
      undefined,
      'api',
      'web-a',
      '{{trigger.project}}',
    ]);
    expect(result.projectId).toBe('api-a');
  });

  it('keeps a project id named like a built-in object key as written', () => {
    const file = exported();
    file.graph.nodes[1].config = { projectId: 'toString' };

    const result = localizeFlowGraph(file, { projects: [], accountIds: noAccounts });

    expect(result.graph.nodes[1].config).toEqual({ projectId: 'toString' });
    expect(result.needsSetup).toEqual(['Ship']);
  });

  it('keeps accounts this computer has and clears the rest', () => {
    const graph = withNode({
      id: 'note',
      blockType: 'slack_post',
      config: { connectionId: 'slack-a', channel: 'general' },
    });
    const file = exported({
      ...graph,
      nodes: graph.nodes.map((node) =>
        node.id === 't'
          ? { ...node, blockType: 'webhook_trigger', config: { integrationId: 'gh-a' } }
          : node,
      ),
    });

    const result = localizeFlowGraph(file, {
      projects: HOME_PROJECTS,
      accountIds: new Set(['gh-a']),
    });

    expect(result.graph.nodes[0].config).toEqual({ integrationId: 'gh-a' });
    expect(result.graph.nodes[3].config).toEqual({ channel: 'general' });
  });

  it('asks for the post-task automation to be turned on again', () => {
    const graph: FlowGraphInput = {
      nodes: [
        {
          id: 't',
          blockType: 'post_task_trigger',
          config: { bindingProjectId: 'api-a', triggerStates: ['completed'] },
        },
        { id: 'end', blockType: 'end' },
      ],
      edges: [{ id: 'e1', source: 't', target: 'end' }],
    };

    const result = localizeFlowGraph(exported(graph), { projects: [], accountIds: noAccounts });

    expect(result.graph.nodes[0].config).toEqual({ triggerStates: ['completed'] });
    expect(result.needsSetup).toEqual(['Post-Task Trigger']);
  });
});
