import { describe, expect, it } from 'vitest';
import type {
  FlowChangeGraph,
  FlowChangePresentation,
  FlowSemanticChange,
} from '../../../../shared/types/flows/flow-change-presentation';
import { markFlowChangeGraph } from '../flow-change-graph';
import { attachOutlineChanges, buildDisplayGraph, truthfulGraph } from './graph';
import { buildFlowChangeOutline } from './index';

function receipt(
  graph: FlowChangeGraph | undefined,
  changes: FlowSemanticChange[],
  overrides: Partial<FlowChangePresentation> = {},
): FlowChangePresentation {
  return {
    name: 'Test flow',
    mode: 'update',
    phase: 'applied',
    graph,
    changes,
    warningCount: 0,
    ...overrides,
  };
}

function nodeChange(
  operationIndex: number,
  nodeId: string,
  action: FlowSemanticChange['action'] = 'add',
  status: FlowSemanticChange['status'] = 'applied',
): FlowSemanticChange {
  return {
    operationIndex,
    action,
    kind: 'node',
    status,
    label: nodeId,
    nodeId,
  };
}

function linearGraph(count: number): FlowChangeGraph {
  return {
    nodes: Array.from({ length: count }, (_, index) => ({
      id: `n${index}`,
      label: `Step ${index}`,
      blockType: index === 0 ? 'manual_trigger' : 'agent',
    })).reverse(),
    edges: Array.from({ length: count - 1 }, (_, index) => ({
      id: `e${index}`,
      source: `n${index}`,
      target: `n${index + 1}`,
    })).reverse(),
  };
}

function cappedRouteGraph(): FlowChangeGraph {
  return {
    nodes: [
      { id: 'start', label: 'Start', blockType: 'manual_trigger' },
      { id: 'action', label: 'Choose route', blockType: 'condition' },
      { id: 'end', label: 'Finish', blockType: 'end' },
    ],
    edges: [
      { id: 'start-action', source: 'start', target: 'action' },
      ...Array.from({ length: 65 }, (_, index) => ({
        id: `action-end-${index}`,
        source: 'action',
        target: 'end',
        label: `Path ${String(index + 1).padStart(2, '0')}`,
      })),
    ],
  };
}

function reconvergingDiamondGraph(count: number): FlowChangeGraph {
  const nodes: FlowChangeGraph['nodes'] = [
    { id: 'start', label: 'Start', blockType: 'manual_trigger' },
  ];
  const edges: FlowChangeGraph['edges'] = [
    { id: 'start-split-0', source: 'start', target: 'split-0' },
  ];
  for (let index = 0; index < count; index += 1) {
    const split = `split-${index}`;
    const yes = `yes-${index}`;
    const no = `no-${index}`;
    const next = index === count - 1 ? 'done' : `split-${index + 1}`;
    nodes.push(
      { id: split, label: `Check ${index}`, blockType: 'condition' },
      { id: yes, label: `Yes ${index}`, blockType: 'agent' },
      { id: no, label: `No ${index}`, blockType: 'agent' },
    );
    edges.push(
      { id: `${split}-yes`, source: split, target: yes, sourceHandle: 'true' },
      { id: `${split}-no`, source: split, target: no, sourceHandle: 'false' },
      { id: `${yes}-${next}`, source: yes, target: next },
      { id: `${no}-${next}`, source: no, target: next },
    );
  }
  nodes.push({ id: 'done', label: 'Done', blockType: 'end' });
  return { nodes, edges };
}

function nestedRouteCount(routes: ReturnType<typeof buildFlowChangeOutline>['routes']): number {
  return routes.reduce(
    (count, route) =>
      count + 1 + route.steps.reduce((sum, step) => sum + nestedRouteCount(step.branches), 0),
    0,
  );
}

describe('buildFlowChangeOutline', () => {
  it('orders a linear creation by routes rather than node array order', () => {
    const graph: FlowChangeGraph = {
      nodes: [
        { id: 'report', label: 'Post report', blockType: 'agent' },
        { id: 'trigger', label: 'Run manually', blockType: 'manual_trigger' },
        { id: 'task', label: 'Open task', blockType: 'start_task' },
      ],
      edges: [
        { id: 'task-report', source: 'task', target: 'report' },
        { id: 'trigger-task', source: 'trigger', target: 'task' },
      ],
    };
    const edgeChange: FlowSemanticChange = {
      operationIndex: 3,
      action: 'add',
      kind: 'edge',
      status: 'applied',
      label: 'Open task → Post report',
      edgeId: 'task-report',
      relatedNodeIds: ['task', 'report'],
    };
    const model = buildFlowChangeOutline(
      receipt(
        graph,
        [nodeChange(0, 'trigger'), nodeChange(1, 'task'), nodeChange(2, 'report'), edgeChange],
        {
          mode: 'create',
        },
      ),
    );
    expect(model.heading).toBe('Resulting flow');
    expect(model.scope).toBe('full');
    expect(model.routes[0]?.steps.map((step) => step.label)).toEqual([
      'Run manually',
      'Open task',
      'Post report',
    ]);
    expect(model.routes[0]?.steps[2]?.relationChanges).toEqual([edgeChange]);
    expect(model.synopsis).toBe('Run manually → Open task → Post report');
  });
  it('describes one updated step with concise change-first copy', () => {
    const graph: FlowChangeGraph = {
      nodes: [
        { id: 'post', label: 'Post report', blockType: 'agent' },
        { id: 'collect', label: 'Collect git activity', blockType: 'agent' },
      ],
      edges: [{ id: 'route', source: 'collect', target: 'post' }],
    };
    const change = {
      ...nodeChange(0, 'post', 'update'),
      label: 'Post report',
      detail: 'Instructions',
    };
    expect(buildFlowChangeOutline(receipt(graph, [change])).synopsis).toBe(
      'Post report: instructions changed',
    );
  });
  it('describes an unchanged step as already current', () => {
    const graph: FlowChangeGraph = {
      nodes: [
        { id: 'post', label: 'Post report', blockType: 'agent' },
        { id: 'collect', label: 'Collect git activity', blockType: 'agent' },
      ],
      edges: [{ id: 'route', source: 'collect', target: 'post' }],
    };
    const change = {
      ...nodeChange(0, 'post', 'update', 'unchanged'),
      label: 'Post report',
    };

    expect(buildFlowChangeOutline(receipt(graph, [change], { phase: 'unchanged' })).synopsis).toBe(
      'Post report is already current',
    );
  });
  it('nests true and false routes and resumes at their convergence', () => {
    const graph: FlowChangeGraph = {
      nodes: [
        { id: 'join', label: 'Post report', blockType: 'agent' },
        { id: 'no', label: 'Skip draft', blockType: 'end' },
        { id: 'condition', label: 'Has changes?', blockType: 'condition' },
        { id: 'yes', label: 'Draft report', blockType: 'agent' },
        { id: 'start', label: 'Run manually', blockType: 'manual_trigger' },
      ],
      edges: [
        { id: 'no-join', source: 'no', target: 'join' },
        { id: 'false', source: 'condition', target: 'no', sourceHandle: 'false' },
        { id: 'start-condition', source: 'start', target: 'condition' },
        { id: 'yes-join', source: 'yes', target: 'join' },
        { id: 'true', source: 'condition', target: 'yes', sourceHandle: 'true' },
      ],
    };
    const model = buildFlowChangeOutline(receipt(graph, []));
    const branchStep = model.routes[0]?.steps.find((step) => step.nodeId === 'condition');
    expect(branchStep?.branches.map((branch) => branch.label)).toEqual(['If yes', 'If no']);
    expect(branchStep?.branches.map((branch) => branch.steps[0]?.label)).toEqual([
      'Draft report',
      'Skip draft',
    ]);
    expect(branchStep?.branches.map((branch) => branch.terminal?.text)).toEqual([
      'Joins at Post report',
      'Joins at Post report',
    ]);
    expect(model.routes[0]?.steps.at(-1)?.label).toBe('Post report');
    expect(model.branchCount).toBe(2);
  });
  it('reports a direct-to-join route change once at the branch entry', () => {
    const graph: FlowChangeGraph = {
      nodes: [
        { id: 'join', label: 'Post report', blockType: 'agent' },
        { id: 'no', label: 'Skip draft', blockType: 'agent' },
        { id: 'condition', label: 'Has changes?', blockType: 'condition' },
        { id: 'start', label: 'Run manually', blockType: 'manual_trigger' },
      ],
      edges: [
        { id: 'false-join', source: 'no', target: 'join' },
        { id: 'false', source: 'condition', target: 'no', sourceHandle: 'false' },
        { id: 'true', source: 'condition', target: 'join', sourceHandle: 'true' },
        { id: 'start-condition', source: 'start', target: 'condition' },
      ],
    };
    const directChange: FlowSemanticChange = {
      operationIndex: 0,
      action: 'add',
      kind: 'edge',
      status: 'applied',
      label: 'Has changes? → Post report',
      edgeId: 'true',
      relatedNodeIds: ['condition', 'join'],
    };

    const model = buildFlowChangeOutline(receipt(graph, [directChange]));
    const condition = model.routes[0]?.steps.find((step) => step.nodeId === 'condition');
    const directBranch = condition?.branches.find((branch) => branch.label === 'If yes');

    expect(directBranch?.changes).toEqual([directChange]);
    expect(directBranch?.terminal?.changes).toEqual([]);
  });
  it('attaches a shared hidden-edge change to every compressed branch', () => {
    const graph: FlowChangeGraph = {
      nodes: [
        { id: 'source', label: 'Choose route', blockType: 'condition' },
        { id: 'yes', label: 'Yes path', blockType: 'agent' },
        { id: 'no', label: 'No path', blockType: 'agent' },
        { id: 'shared', label: 'Shared work', blockType: 'agent' },
        { id: 'target', label: 'Finish', blockType: 'end' },
      ],
      edges: [
        { id: 'source-yes', source: 'source', target: 'yes', sourceHandle: 'true' },
        { id: 'source-no', source: 'source', target: 'no', sourceHandle: 'false' },
        { id: 'yes-shared', source: 'yes', target: 'shared' },
        { id: 'no-shared', source: 'no', target: 'shared' },
        { id: 'shared-target', source: 'shared', target: 'target' },
      ],
    };
    const change: FlowSemanticChange = {
      operationIndex: 0,
      action: 'update',
      kind: 'edge',
      status: 'applied',
      label: 'Shared work → Finish',
      edgeId: 'shared-target',
      relatedNodeIds: ['shared', 'target'],
    };
    const visibleIds = new Set(['source', 'target']);
    const display = buildDisplayGraph(graph, visibleIds);
    const attached = attachOutlineChanges([change], visibleIds, display.edges);

    expect(display.edges).toHaveLength(2);
    expect(display.edges.every((edge) => edge.originalEdgeIds.includes('shared-target'))).toBe(
      true,
    );
    expect([...attached.edgeChanges.values()]).toEqual([[change], [change]]);
  });
  it('retains every real edge when parallel routes collapse into one display route', () => {
    const graph: FlowChangeGraph = {
      nodes: [
        { id: 'source', label: 'Start', blockType: 'manual_trigger' },
        { id: 'target', label: 'Finish', blockType: 'end' },
      ],
      edges: [
        { id: 'route-a', source: 'source', target: 'target' },
        { id: 'route-b', source: 'source', target: 'target' },
      ],
    };
    const changes: FlowSemanticChange[] = graph.edges.map((edge, operationIndex) => ({
      operationIndex,
      action: 'update',
      kind: 'edge',
      status: 'applied',
      label: 'Start → Finish',
      edgeId: edge.id,
      relatedNodeIds: [edge.source, edge.target],
    }));
    const visibleIds = new Set(graph.nodes.map((node) => node.id));
    const display = buildDisplayGraph(graph, visibleIds);
    const attached = attachOutlineChanges(changes, visibleIds, display.edges);

    expect(display.edges).toHaveLength(1);
    expect(display.edges[0]?.originalEdgeIds).toEqual(['route-a', 'route-b']);
    expect(attached.edgeChanges.get(display.edges[0]?.id ?? '')).toEqual(changes);
    expect(attached.nodeChanges.size).toBe(0);
  });
  it('represents a cycle as a loop reference instead of repeating steps', () => {
    const graph: FlowChangeGraph = {
      nodes: [
        { id: 'work', label: 'Try again', blockType: 'agent' },
        { id: 'start', label: 'Start', blockType: 'manual_trigger' },
      ],
      edges: [
        { id: 'loop', source: 'work', target: 'work' },
        { id: 'start-work', source: 'start', target: 'work' },
      ],
    };
    const model = buildFlowChangeOutline(receipt(graph, []));
    expect(model.routes[0]?.steps.map((step) => step.label)).toEqual(['Start', 'Try again']);
    expect(model.routes[0]?.terminal).toEqual(
      expect.objectContaining({ kind: 'loop', text: 'Loops back to Try again' }),
    );
  });
  it('keeps disconnected components as separate deterministic routes', () => {
    const graph: FlowChangeGraph = {
      nodes: [
        { id: 'z', label: 'Second route', blockType: 'agent' },
        { id: 'a', label: 'First route', blockType: 'agent' },
      ],
      edges: [],
    };
    expect(
      buildFlowChangeOutline(receipt(graph, [])).routes.map((route) => route.steps[0]?.label),
    ).toEqual(['First route', 'Second route']);
  });
  it('keeps all ten steps visible at the full-Flow boundary', () => {
    const model = buildFlowChangeOutline(receipt(linearGraph(10), []));

    expect(model.scope).toBe('full');
    expect(model.totalNodeCount).toBe(10);
    expect(model.omittedNodeCount).toBe(0);
    expect(model.routes.flatMap((route) => route.steps)).toHaveLength(10);
  });
  it('uses an adaptive neighborhood and anchors omitted steps to visible predecessors', () => {
    const graph = linearGraph(12);
    const firstCompressedEdge = graph.edges.find((edge) => edge.id === 'e6');
    if (firstCompressedEdge) firstCompressedEdge.sourceHandle = 'true';
    const change = { ...nodeChange(0, 'n9', 'update'), label: 'Step 9' };
    const model = buildFlowChangeOutline(receipt(graph, [change]));
    const steps = model.routes.flatMap((route) => route.steps);
    expect(model.scope).toBe('neighborhood');
    expect(model.totalNodeCount).toBe(12);
    expect(model.omittedNodeCount).toBe(2);
    expect(steps.find((step) => step.nodeId === 'n6')?.omittedAfter).toBe(1);
    expect(steps.find((step) => step.nodeId === 'n10')?.omittedAfter).toBe(1);
    expect(steps.find((step) => step.nodeId === 'n8')?.relationBefore).toBe('If yes');
    expect(steps.some((step) => step.nodeId === 'n9')).toBe(true);
    expect(model.synopsis).not.toContain('+');
  });
  it('bounds compressed routes through a maximum-size reconverging graph', () => {
    const graph = reconvergingDiamondGraph(16);
    const visibleIds = new Set([
      'start',
      'split-0',
      'yes-0',
      'no-0',
      'split-1',
      'yes-15',
      'no-15',
      'done',
    ]);
    const display = buildDisplayGraph(graph, visibleIds);
    const model = buildFlowChangeOutline(
      receipt(graph, [{ ...nodeChange(0, 'done', 'update'), label: 'Done' }]),
    );

    expect(graph.nodes).toHaveLength(50);
    expect(graph.edges).toHaveLength(65);
    expect(display.edges.length).toBeLessThanOrEqual(64);
    expect(nestedRouteCount(model.routes)).toBeLessThanOrEqual(72);
    expect(model.routes[0]?.steps.find((step) => step.nodeId === 'split-0')?.branches).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ label: 'If yes' }),
        expect.objectContaining({ label: 'If no' }),
      ]),
    );
    expect(model.omittedNodeCount).toBe(40);
  });
  it('reports every unique visible route omitted by the display cap', () => {
    const graph = cappedRouteGraph();
    const visibleIds = new Set(graph.nodes.map((node) => node.id));
    const display = buildDisplayGraph(graph, visibleIds);
    const reversedDisplay = buildDisplayGraph(
      { nodes: [...graph.nodes].reverse(), edges: [...graph.edges].reverse() },
      visibleIds,
    );
    const model = buildFlowChangeOutline(receipt(graph, []));

    expect(graph.edges).toHaveLength(66);
    expect(display.edges).toHaveLength(64);
    expect(display.omittedConnectionCount).toBe(2);
    expect(reversedDisplay.omittedConnectionCount).toBe(2);
    expect(reversedDisplay.edges).toEqual(display.edges);
    expect(model.scope).toBe('full');
    expect(model.omittedRouteCount).toBe(2);
  });
  it('keeps settings-only changes separate even when graph context exists', () => {
    const setting: FlowSemanticChange = {
      operationIndex: 0,
      action: 'update',
      kind: 'settings',
      status: 'pending',
      label: 'Flow settings',
      detail: 'Flow briefing',
    };
    const graph: FlowChangeGraph = {
      nodes: [{ id: 'context', label: 'Unchanged context', blockType: 'agent' }],
      edges: [],
    };
    const model = buildFlowChangeOutline(receipt(graph, [setting], { phase: 'proposed' }));
    expect(model.heading).toBe('Requested flow');
    expect(model.scope).toBe('changes-only');
    expect(model.settingsChanges).toEqual([setting]);
    expect(model.unplacedChanges).toEqual([]);
  });
  it('removes an applied removal ghost but preserves its change', () => {
    const removal = { ...nodeChange(0, 'removed', 'remove'), label: 'Removed step' };
    const graph: FlowChangeGraph = {
      nodes: [
        { id: 'kept', label: 'Kept', blockType: 'agent' },
        {
          id: 'removed',
          label: 'Removed step',
          blockType: 'agent',
          changeAction: 'remove',
          changeStatus: 'applied',
        },
      ],
      edges: [],
    };
    const model = buildFlowChangeOutline(receipt(graph, [removal]));
    expect(model.totalNodeCount).toBe(1);
    expect(model.routes.flatMap((route) => route.steps).map((step) => step.nodeId)).toEqual([
      'kept',
    ]);
    expect(model.unplacedChanges).toEqual([removal]);
  });
  it.each([
    {
      name: 'keeps a removal final when a later update fails',
      changes: [
        nodeChange(0, 'transient', 'remove', 'applied'),
        nodeChange(1, 'transient', 'update', 'failed'),
      ],
      expectedNodeIds: [],
    },
    {
      name: 'shows a step added after it was removed',
      changes: [
        nodeChange(0, 'transient', 'remove', 'applied'),
        nodeChange(1, 'transient', 'add', 'applied'),
      ],
      expectedNodeIds: ['transient'],
    },
    {
      name: 'hides a step removed after it was added',
      changes: [
        nodeChange(0, 'transient', 'add', 'applied'),
        nodeChange(1, 'transient', 'remove', 'applied'),
      ],
      expectedNodeIds: [],
    },
    {
      name: 'uses a final removal when an earlier failure owns the marker',
      changes: [
        nodeChange(0, 'transient', 'update', 'failed'),
        nodeChange(1, 'transient', 'add', 'applied'),
        nodeChange(2, 'transient', 'remove', 'applied'),
      ],
      expectedNodeIds: [],
    },
    {
      name: 'hides a net-zero unchanged addition followed by removal',
      changes: [
        nodeChange(0, 'transient', 'add', 'unchanged'),
        nodeChange(1, 'transient', 'remove', 'unchanged'),
      ],
      expectedNodeIds: [],
    },
    {
      name: 'shows an unchanged addition that follows a removal',
      changes: [
        nodeChange(0, 'transient', 'remove', 'unchanged'),
        nodeChange(1, 'transient', 'add', 'unchanged'),
      ],
      expectedNodeIds: ['transient'],
    },
  ])('$name', ({ changes, expectedNodeIds }) => {
    const emptyGraph: FlowChangeGraph = { nodes: [], edges: [] };
    const markedGraph = markFlowChangeGraph(emptyGraph, emptyGraph, changes);
    const graph = truthfulGraph(receipt(markedGraph, changes, { phase: 'partial' }));

    expect(graph?.nodes.map((node) => node.id)).toEqual(expectedNodeIds);
  });
  it('removes a failed addition ghost from a not-applied topology', () => {
    const failedAdd = nodeChange(0, 'new', 'add', 'failed');
    const graph: FlowChangeGraph = {
      nodes: [
        { id: 'base', label: 'Existing', blockType: 'agent' },
        {
          id: 'new',
          label: 'New',
          blockType: 'agent',
          changeAction: 'add',
          changeStatus: 'failed',
        },
      ],
      edges: [],
    };
    const model = buildFlowChangeOutline(receipt(graph, [failedAdd], { phase: 'failed' }));
    expect(model.heading).toBe('Changes not applied');
    expect(model.totalNodeCount).toBe(1);
    expect(model.unplacedChanges).toEqual([failedAdd]);
  });
  it('keeps an existing saved step when a duplicate addition fails', () => {
    const failedAdd = {
      ...nodeChange(0, 'existing', 'add', 'failed'),
      label: 'Existing step',
    };
    const graph: FlowChangeGraph = {
      nodes: [{ id: 'existing', label: 'Existing step', blockType: 'agent' }],
      edges: [],
    };

    const model = buildFlowChangeOutline(receipt(graph, [failedAdd], { phase: 'partial' }));

    expect(model.totalNodeCount).toBe(1);
    expect(model.routes[0]?.steps[0]).toEqual(
      expect.objectContaining({ nodeId: 'existing', changes: [failedAdd] }),
    );
    expect(model.unplacedChanges).toEqual([]);
  });
  it('keeps a failed update in context and attached to its step', () => {
    const failedUpdate = {
      ...nodeChange(0, 'step', 'update', 'failed'),
      label: 'Post report',
      detail: 'Instructions',
    };
    const graph: FlowChangeGraph = {
      nodes: [
        {
          id: 'step',
          label: 'Post report',
          blockType: 'agent',
          changeAction: 'update',
          changeStatus: 'failed',
        },
      ],
      edges: [],
    };
    const model = buildFlowChangeOutline(receipt(graph, [failedUpdate], { phase: 'partial' }));
    expect(model.heading).toBe('Saved flow');
    expect(model.routes[0]?.steps[0]?.changes).toEqual([failedUpdate]);
    expect(model.unplacedChanges).toEqual([]);
  });
  it('places changes by related ids and preserves any change that still cannot be placed', () => {
    const missing = nodeChange(0, 'not-in-graph', 'update', 'unknown');
    const related: FlowSemanticChange = {
      operationIndex: 1,
      action: 'remove',
      kind: 'edge',
      status: 'applied',
      label: 'Context → Removed',
      edgeId: 'removed-edge',
      relatedNodeIds: ['context', 'removed'],
    };
    const graph: FlowChangeGraph = {
      nodes: [{ id: 'context', label: 'Context', blockType: 'agent' }],
      edges: [],
    };
    const model = buildFlowChangeOutline(
      receipt(graph, [missing, related], { phase: 'unconfirmed' }),
    );
    expect(model.heading).toBe('Attempted layout');
    expect(model.routes[0]?.steps[0]?.changes).toEqual([related]);
    expect(model.unplacedChanges).toEqual([missing]);
  });
});
