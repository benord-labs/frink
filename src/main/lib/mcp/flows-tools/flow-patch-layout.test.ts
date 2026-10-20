import { describe, expect, it } from 'vitest';
import type { FlowGraph } from '../../../../shared/lib/validate-flow-graph';
import { applyPatchOperations, type PatchOperation, patchArgsSchema } from './flow-patch';
import { buildFlowPatchChangeSummary } from './flow-change-presentation';
import {
  buildFlowPatchReceipt,
  buildFlowPatchResult,
  operationsTouchPositions,
} from './flow-patch-result';

const GRAPH: FlowGraph = {
  nodes: [
    { id: 'trigger', blockType: 'manual_trigger', position: { x: 900, y: 900 } },
    {
      id: 'start',
      blockType: 'start_task',
      config: { projectId: '550e8400-e29b-41d4-a716-446655440010' },
      position: { x: 900, y: 900 },
    },
  ],
  edges: [{ id: 'e0', source: 'trigger', target: 'start' }],
};

const ADD_AGENT: PatchOperation[] = [
  {
    op: 'add_node',
    node: { id: 'agent', blockType: 'agent', config: { instructions: 'do it' } },
  },
  { op: 'add_edge', edge: { id: 'e1', source: 'start', target: 'agent' } },
];

function patched(operations: PatchOperation[], graph: FlowGraph = GRAPH): FlowGraph {
  const result = applyPatchOperations(graph, operations);
  if (result.status === 'failure') throw new Error(result.error);
  return result.graph;
}

function resultBody(graph: FlowGraph, positionsTouched: boolean): Record<string, unknown> {
  const operations: PatchOperation[] = [{ op: 'auto_layout' }];
  const result = buildFlowPatchResult({
    patch: { status: 'success', graph, applied: [0], failed: [], skipped: [] },
    receipt: buildFlowPatchReceipt({
      mode: 'update',
      baseGraph: graph,
      finalGraph: graph,
      operations,
      applied: [0],
      failed: [],
      skipped: [],
      baseVersionNumber: 1,
      persistedVersionNumber: 2,
    }),
    flowId: 'flow-layout',
    versionId: 'version-2',
    name: 'Layout flow',
    operationCount: 1,
    creationProjectNote: null,
    createdFlow: false,
    templateWarnings: [],
    webhookSetup: [],
    positionsTouched,
  });
  return JSON.parse(result.content[0]?.text ?? '{}') as Record<string, unknown>;
}

describe('auto_layout patch operation', () => {
  it('accepts the bare op and rejects extra fields', () => {
    const parse = (op: unknown) => patchArgsSchema.safeParse({ flowId: 'f', operations: [op] });
    expect(parse({ op: 'auto_layout' }).success).toBe(true);
    expect(parse({ op: 'auto_layout', style: 'compact' }).success).toBe(false);
  });

  it('lays out the final graph wherever it sits in the batch', () => {
    const first = patched([{ op: 'auto_layout' }, ...ADD_AGENT]);
    const last = patched([...ADD_AGENT, { op: 'auto_layout' }]);

    expect(first).toEqual(last);
    expect(first.nodes.every((node) => node.position !== undefined)).toBe(true);
    const ys = first.nodes.map((node) => node.position?.y ?? Number.NaN);
    expect(ys).toEqual([...ys].sort((a, b) => a - b));
    expect(new Set(ys).size).toBe(3);
  });

  it('overrides a position set in the same batch', () => {
    const moved: PatchOperation = { op: 'update_node', nodeId: 'start', position: { x: 5, y: 5 } };
    expect(patched([moved, { op: 'auto_layout' }])).toEqual(patched([{ op: 'auto_layout' }]));
  });

  it('is unchanged when applied to its own output', () => {
    const once = patched([{ op: 'auto_layout' }]);
    expect(patched([{ op: 'auto_layout' }], once)).toEqual(once);
  });

  it('fails a second auto_layout in one patch and still applies the first', () => {
    const result = applyPatchOperations(GRAPH, [{ op: 'auto_layout' }, { op: 'auto_layout' }]);
    expect(result.status).toBe('partial');
    expect(result.applied).toEqual([0]);
    expect(result.failed[0]?.error).toContain('only once per patch');
  });

  it('is presented as a canvas layout change', () => {
    const summary = buildFlowPatchChangeSummary({
      mode: 'update',
      baseGraph: GRAPH,
      finalGraph: patched([{ op: 'auto_layout' }]),
      operations: [{ op: 'auto_layout' }],
      applied: [0],
      failed: [],
      skipped: [],
      baseVersionNumber: 1,
      versionNumber: 2,
    });
    expect(summary.changes[0]).toMatchObject({
      kind: 'settings',
      label: 'Canvas layout',
      detail: 'Reset to automatic layout',
      status: 'applied',
    });
  });
});

describe('patch result layout report', () => {
  it('names colliding nodes even when the patch moved nothing', () => {
    const layout = resultBody(GRAPH, false).layout as { overlaps: unknown };
    expect(layout.overlaps).toEqual({ count: 1, sample: [['trigger', 'start']] });
  });

  it('reports bounds after a layout change and stays silent for a clean untouched flow', () => {
    const clean = patched([{ op: 'auto_layout' }]);
    expect(resultBody(clean, true).layout).toMatchObject({ overlaps: { count: 0, sample: [] } });
    expect(resultBody(clean, false).layout).toBeUndefined();
  });

  it('keeps fifty stacked nodes within the tool-result budget', () => {
    const nodes = Array.from({ length: 50 }, (_, index) => ({
      id: `node-${index}`,
      blockType: index === 0 ? 'manual_trigger' : 'agent',
      position: { x: 0, y: 0 },
    }));
    const body = resultBody({ nodes, edges: [] }, true);
    const layout = body.layout as { overlaps: { count: number; sample: unknown[] } };
    expect(layout.overlaps.count).toBe(1225);
    expect(layout.overlaps.sample).toHaveLength(10);
    expect(JSON.stringify(body, null, 2).length).toBeLessThan(40_000);
  });
});

const FAN_GRAPH: FlowGraph = {
  nodes: [
    ...GRAPH.nodes,
    { id: 'fan', blockType: 'fan_out' },
    { id: 'body', blockType: 'agent', parentId: 'fan', config: { instructions: 'per item' } },
  ],
  edges: [
    ...GRAPH.edges,
    { id: 'e-fan', source: 'start', target: 'fan' },
    { id: 'e-body', source: 'fan', target: 'body' },
  ],
};

const SIZE = { width: 900, height: 2400 };

const nodeById = (graph: FlowGraph, id: string) => graph.nodes.find((node) => node.id === id);

describe('Fan Out size patch operations', () => {
  it('accepts size and null on update_node and rejects a non-positive size', () => {
    const parse = (op: unknown) => patchArgsSchema.safeParse({ flowId: 'f', operations: [op] });
    expect(parse({ op: 'update_node', nodeId: 'fan', size: SIZE }).success).toBe(true);
    expect(parse({ op: 'update_node', nodeId: 'fan', size: null }).success).toBe(true);
    expect(
      parse({ op: 'update_node', nodeId: 'fan', size: { width: 0, height: 10 } }).success,
    ).toBe(false);
  });

  it('add_node keeps a Fan Out size instead of dropping it', () => {
    const graph = patched(
      [
        { op: 'add_node', node: { id: 'fan-2', blockType: 'fan_out', size: SIZE } },
        { op: 'add_edge', edge: { id: 'e-fan-2', source: 'start', target: 'fan-2' } },
      ],
      FAN_GRAPH,
    );
    expect(nodeById(graph, 'fan-2')?.size).toEqual(SIZE);
  });

  it('add_node fails an op that puts size on a non-Fan Out and still applies the rest', () => {
    const result = applyPatchOperations(FAN_GRAPH, [
      { op: 'add_node', node: { id: 'agent-2', blockType: 'agent', size: SIZE } },
      { op: 'update_node', nodeId: 'body', label: 'Per item' },
    ]);
    expect(result.status).toBe('partial');
    expect(result.applied).toEqual([1]);
    expect(result.failed[0]?.error).toBe(
      "Operation 1 (add_node): size applies only to Fan Out nodes; 'agent-2' is agent",
    );
  });

  it('update_node sets a Fan Out size and null clears it', () => {
    const sized = patched([{ op: 'update_node', nodeId: 'fan', size: SIZE }], FAN_GRAPH);
    expect(nodeById(sized, 'fan')?.size).toEqual(SIZE);

    const cleared = patched([{ op: 'update_node', nodeId: 'fan', size: null }], sized);
    expect(nodeById(cleared, 'fan')).not.toHaveProperty('size');
  });

  it('update_node fails size on a non-Fan Out without applying its other fields', () => {
    const result = applyPatchOperations(FAN_GRAPH, [
      { op: 'update_node', nodeId: 'body', label: 'Per item', size: SIZE },
    ]);
    expect(result.status).toBe('failure');
    if (result.status !== 'failure') return;
    expect(result.error).toContain("size applies only to Fan Out nodes; 'body' is agent");
  });

  it('auto_layout in the same patch discards a size set earlier in it', () => {
    const graph = patched(
      [{ op: 'update_node', nodeId: 'fan', size: SIZE }, { op: 'auto_layout' }],
      FAN_GRAPH,
    );
    expect(nodeById(graph, 'fan')).not.toHaveProperty('size');
  });

  it('counts a size change on either op as a layout change, but not a label edit', () => {
    expect(operationsTouchPositions([{ op: 'update_node', nodeId: 'fan', size: null }])).toBe(true);
    expect(
      operationsTouchPositions([
        { op: 'add_node', node: { id: 'fan-2', blockType: 'fan_out', size: SIZE } },
      ]),
    ).toBe(true);
    expect(operationsTouchPositions([{ op: 'update_node', nodeId: 'fan', label: 'x' }])).toBe(
      false,
    );
  });

  it('describes a size change in the change receipt', () => {
    const detailFor = (op: PatchOperation & { op: 'update_node' }) =>
      buildFlowPatchChangeSummary({
        mode: 'update',
        baseGraph: FAN_GRAPH,
        finalGraph: patched([op], FAN_GRAPH),
        operations: [op],
        applied: [0],
        failed: [],
        skipped: [],
        baseVersionNumber: 1,
        versionNumber: 2,
      }).changes[0]?.detail;
    expect(detailFor({ op: 'update_node', nodeId: 'fan', size: SIZE })).toBe('Container size');
    expect(detailFor({ op: 'update_node', nodeId: 'fan', size: null })).toBe(
      'Container size cleared',
    );
  });
});
