import { describe, expect, it } from 'vitest';
import type { FlowGraph } from '../../../../shared/lib/validate-flow-graph';
import { buildFlowPatchChangeSummary } from './flow-change-presentation';
import type { PatchOperation } from './flow-patch';

const BASE_GRAPH: FlowGraph = {
  nodes: [
    { id: 'trigger', blockType: 'manual_trigger', label: 'Launch' },
    {
      id: 'agent',
      blockType: 'agent',
      label: 'Draft release',
      config: { instructions: 'SECRET-INSTRUCTION', apiToken: 'SECRET-TOKEN' },
    },
    { id: 'review', blockType: 'agent', label: 'Review draft' },
  ],
  edges: [
    { id: 'launch-agent', source: 'trigger', target: 'agent' },
    { id: 'agent-review', source: 'agent', target: 'review' },
  ],
};

describe('buildFlowPatchChangeSummary', () => {
  it('describes exact semantic targets without serializing node config values', () => {
    const operations: PatchOperation[] = [
      {
        op: 'update_node',
        nodeId: 'agent',
        label: 'Write release',
        config: { instructions: 'NEW-SECRET', cwd: '/private/repo' },
      },
      { op: 'remove_edge', edgeId: 'agent-review' },
      { op: 'update_settings', settings: { briefing: 'PRIVATE-BRIEFING' } },
    ];
    const finalGraph: FlowGraph = {
      ...BASE_GRAPH,
      nodes: BASE_GRAPH.nodes.map((node) =>
        node.id === 'agent' ? { ...node, label: 'Write release' } : node,
      ),
      edges: BASE_GRAPH.edges.filter((edge) => edge.id !== 'agent-review'),
    };

    const summary = buildFlowPatchChangeSummary({
      mode: 'update',
      baseGraph: BASE_GRAPH,
      finalGraph,
      operations,
      applied: [0, 1, 2],
      failed: [],
      skipped: [],
      baseVersionNumber: 4,
      versionNumber: 5,
    });

    expect(summary.changes).toEqual([
      expect.objectContaining({
        operationIndex: 0,
        label: 'Write release',
        detail: 'Step label · Instructions · Other step setup',
        status: 'applied',
      }),
      expect.objectContaining({
        operationIndex: 1,
        label: 'Write release → Review draft',
        status: 'applied',
      }),
      expect.objectContaining({
        operationIndex: 2,
        label: 'Flow settings',
        detail: 'Flow briefing',
        status: 'applied',
      }),
    ]);
    expect(JSON.stringify(summary)).not.toMatch(
      /SECRET|PRIVATE-BRIEFING|\/private\/repo|instructions|apiToken/,
    );
  });

  it('names safe configuration facets without exposing their values', () => {
    const summary = buildFlowPatchChangeSummary({
      mode: 'update',
      baseGraph: BASE_GRAPH,
      finalGraph: BASE_GRAPH,
      operations: [
        {
          op: 'update_node',
          nodeId: 'agent',
          config: {
            instructions: 'PRIVATE-INSTRUCTIONS',
            agentInstructions: 'PRIVATE-ROLE',
            model: 'PRIVATE-MODEL',
            fireAndForget: true,
          },
        },
      ],
      applied: [0],
      failed: [],
      skipped: [],
      baseVersionNumber: 4,
      versionNumber: 5,
    });

    expect(summary.changes[0]?.detail).toBe(
      'Instructions · Agent role · Model · Completion behavior',
    );
    expect(JSON.stringify(summary)).not.toMatch(/PRIVATE-/);
  });

  it('maps partial result indexes to applied, failed, and skipped ledger rows', () => {
    const operations: PatchOperation[] = [
      { op: 'update_node', nodeId: 'agent', config: { instructions: 'updated' } },
      { op: 'remove_node', nodeId: 'review' },
      {
        op: 'add_node',
        node: { id: 'publish', blockType: 'run_command', label: 'Publish release' },
      },
    ];
    const finalGraph: FlowGraph = {
      nodes: [
        ...BASE_GRAPH.nodes,
        operations[2].op === 'add_node' ? operations[2].node : neverNode(),
      ],
      edges: BASE_GRAPH.edges,
    };

    const summary = buildFlowPatchChangeSummary({
      mode: 'update',
      baseGraph: BASE_GRAPH,
      finalGraph,
      operations,
      applied: [0],
      failed: [{ index: 1, error: 'not found' }],
      skipped: [{ index: 2, reason: 'dependency failed', code: 'dependency-failed' }],
      baseVersionNumber: 7,
      versionNumber: 8,
    });

    expect(summary.changes.map((change) => change.status)).toEqual([
      'applied',
      'failed',
      'skipped',
    ]);
    expect(summary.changes[1]?.label).toBe('Review draft');
  });

  it('carries the closed reason code and keeps raw operation text out of the receipt', () => {
    const operations: PatchOperation[] = [
      { op: 'remove_node', nodeId: 'fan' },
      { op: 'remove_node', nodeId: 'body' },
    ];

    const summary = buildFlowPatchChangeSummary({
      mode: 'update',
      baseGraph: BASE_GRAPH,
      finalGraph: BASE_GRAPH,
      operations,
      applied: [0],
      failed: [],
      skipped: [
        {
          index: 1,
          reason: "Operation 2 (remove_node): node 'body' was already removed by remove_node",
          code: 'cascade-removed',
        },
      ],
      baseVersionNumber: 7,
      versionNumber: 8,
    });

    expect(summary.changes[0]?.reasonCode).toBeUndefined();
    expect(summary.changes[1]?.reasonCode).toBe('cascade-removed');
    expect(JSON.stringify(summary)).not.toMatch(/Operation \d|remove_node|already removed/);
  });

  it('normalizes control characters and bounds display labels', () => {
    const longLabel = `${'A'.repeat(120)}\u0000 hidden`;
    const operation: PatchOperation = {
      op: 'add_node',
      node: { id: 'long', blockType: 'agent', label: longLabel },
    };
    const finalGraph: FlowGraph = {
      nodes: [...BASE_GRAPH.nodes, operation.node],
      edges: BASE_GRAPH.edges,
    };

    const summary = buildFlowPatchChangeSummary({
      mode: 'create',
      baseGraph: { nodes: [], edges: [] },
      finalGraph,
      operations: [operation],
      applied: [0],
      failed: [],
      skipped: [],
      baseVersionNumber: 0,
      versionNumber: 1,
    });

    expect(summary.changes[0]?.label).not.toContain('\u0000');
    expect(summary.changes[0]?.label.length).toBeLessThanOrEqual(96);
  });

  it('marks applied operations unchanged when the durable graph was already current', () => {
    const operation: PatchOperation = {
      op: 'update_node',
      nodeId: 'agent',
      label: 'Draft release',
    };

    const summary = buildFlowPatchChangeSummary({
      mode: 'update',
      baseGraph: BASE_GRAPH,
      finalGraph: BASE_GRAPH,
      operations: [operation],
      applied: [0],
      failed: [],
      skipped: [],
      baseVersionNumber: 4,
      versionNumber: 4,
      versionSaved: false,
    });

    expect(summary.changes[0]).toEqual(
      expect.objectContaining({ status: 'unchanged', action: 'update', nodeId: 'agent' }),
    );
  });

  it('includes removed node shape needed for a durable topology ghost', () => {
    const summary = buildFlowPatchChangeSummary({
      mode: 'update',
      baseGraph: BASE_GRAPH,
      finalGraph: {
        nodes: BASE_GRAPH.nodes.filter((node) => node.id !== 'review'),
        edges: BASE_GRAPH.edges.filter(
          (edge) => edge.source !== 'review' && edge.target !== 'review',
        ),
      },
      operations: [{ op: 'remove_node', nodeId: 'review' }],
      applied: [0],
      failed: [],
      skipped: [],
      baseVersionNumber: 4,
      versionNumber: 5,
    });

    expect(summary.changes[0]).toEqual(
      expect.objectContaining({ nodeId: 'review', blockType: 'agent', action: 'remove' }),
    );
  });
});

function neverNode(): never {
  throw new Error('unreachable');
}
