import { describe, expect, it } from 'vitest';
import type { FlowGraph } from '../../../../shared/lib/validate-flow-graph';
import { applyPatchOperations } from './flow-patch';

const BASE_GRAPH: FlowGraph = {
  nodes: [
    { id: 'n1', blockType: 'manual_trigger' },
    {
      id: 'nst',
      blockType: 'start_task',
      config: { projectId: '550e8400-e29b-41d4-a716-446655440010' },
    },
    { id: 'n2', blockType: 'agent', config: { instructions: 'do it', fireAndForget: true } },
  ],
  edges: [
    { id: 'e0', source: 'n1', target: 'nst' },
    { id: 'e1', source: 'nst', target: 'n2' },
  ],
};

/** BASE_GRAPH plus a Fan Out owning one body step, reached from the agent step. */
const FAN_OUT_GRAPH: FlowGraph = {
  nodes: [
    ...BASE_GRAPH.nodes,
    { id: 'fan', blockType: 'fan_out' },
    { id: 'body', blockType: 'agent', parentId: 'fan', config: { instructions: 'per item' } },
  ],
  edges: [
    ...BASE_GRAPH.edges,
    { id: 'e-fan', source: 'n2', target: 'fan' },
    { id: 'e-body', source: 'fan', target: 'body' },
  ],
};

describe('applyPatchOperations — implicit node removal (remove_node cascade)', () => {
  it('treats removing a Fan Out body already removed with its parent as satisfied, not failed', () => {
    const r = applyPatchOperations(FAN_OUT_GRAPH, [
      { op: 'remove_node', nodeId: 'fan' },
      { op: 'remove_node', nodeId: 'body' },
    ]);

    expect(r.status).toBe('partial');
    if (r.status !== 'partial') return;
    expect(r.failed).toEqual([]);
    expect(r.applied).toEqual([0]);
    const skip = r.skipped.find((s) => s.index === 1);
    expect(skip?.code).toBe('cascade-removed');
    expect(skip?.reason).toMatch(/at operation 1\b/);
  });

  it('keeps update_node on a cascade-removed body a failure — the change never happened', () => {
    const r = applyPatchOperations(FAN_OUT_GRAPH, [
      { op: 'remove_node', nodeId: 'fan' },
      { op: 'update_node', nodeId: 'body', label: 'late' },
    ]);

    expect(r.status).toBe('partial');
    if (r.status !== 'partial') return;
    expect(r.skipped).toEqual([]);
    const fail = r.failed.find((f) => f.index === 1);
    expect(fail?.code).toBeUndefined();
    expect(fail?.error).toMatch(/at operation 1\b/);
  });

  it('keeps add_edge to a cascade-removed node a failure, attributed to the removal', () => {
    const r = applyPatchOperations(FAN_OUT_GRAPH, [
      { op: 'remove_node', nodeId: 'fan' },
      { op: 'add_edge', edge: { id: 'e-late', source: 'body', target: 'n2' } },
    ]);

    expect(r.status).toBe('partial');
    if (r.status !== 'partial') return;
    expect(r.skipped).toEqual([]);
    const fail = r.failed.find((f) => f.index === 1);
    // No reason code: the edge really was not added, so the receipt must not read as satisfied.
    expect(fail?.code).toBeUndefined();
    expect(fail?.error).toMatch(/at operation 1\b/);
  });

  it('re-adding a removed node clears its cascade skip so a later update applies', () => {
    const r = applyPatchOperations(BASE_GRAPH, [
      { op: 'remove_node', nodeId: 'n2' },
      { op: 'add_node', node: { id: 'n2', blockType: 'agent', config: { instructions: 'again' } } },
      { op: 'update_node', nodeId: 'n2', label: 'renamed' },
      { op: 'add_edge', edge: { id: 'e1', source: 'nst', target: 'n2' } },
    ]);

    expect(r.status).toBe('success');
    if (r.status !== 'success') return;
    expect(r.graph.nodes.find((n) => n.id === 'n2')?.label).toBe('renamed');
  });

  it('classifies a not-added dependency skip as retryable', () => {
    const r = applyPatchOperations(BASE_GRAPH, [
      { op: 'add_node', node: { id: 'n1', blockType: 'agent', config: { instructions: 'dup' } } },
      { op: 'update_node', nodeId: 'n1', label: 'later' },
      { op: 'update_settings', settings: { briefing: 'ok' } },
    ]);

    expect(r.status).toBe('partial');
    if (r.status !== 'partial') return;
    expect(r.skipped.find((s) => s.index === 1)?.code).toBe('dependency-failed');
  });
});

describe('applyPatchOperations — repeated and isolated removal', () => {
  it('treats removing the same node twice as satisfied rather than not-found', () => {
    const r = applyPatchOperations(BASE_GRAPH, [
      { op: 'remove_node', nodeId: 'nst' },
      { op: 'remove_node', nodeId: 'nst' },
    ]);

    expect(r.status).toBe('partial');
    if (r.status !== 'partial') return;
    expect(r.failed).toEqual([]);
    expect(r.skipped.find((s) => s.index === 1)?.code).toBe('cascade-removed');
  });

  it('keeps a removal retryable while a failed re-add of the same node is still pending', () => {
    // Re-sending only the corrected add would resurrect a node the batch asked to remove, so the
    // removal must travel with it in retryOps rather than being reported as already satisfied.
    const r = applyPatchOperations(BASE_GRAPH, [
      { op: 'remove_node', nodeId: 'n2' },
      { op: 'add_node', node: { id: 'n2', blockType: 'agent', parentId: 'not-a-fan-out' } },
      { op: 'remove_node', nodeId: 'n2' },
    ]);

    expect(r.status).toBe('partial');
    if (r.status !== 'partial') return;
    expect(r.failed.find((f) => f.index === 1)?.code).toBe('stale-parent');
    expect(r.skipped).toEqual([]);
    expect(r.failed.some((f) => f.index === 2)).toBe(true);
  });

  it('lets a recreated edge be removed again instead of skipping it as already gone', () => {
    const r = applyPatchOperations(BASE_GRAPH, [
      { op: 'remove_node', nodeId: 'nst' },
      { op: 'add_edge', edge: { id: 'e0', source: 'n1', target: 'n2' } },
      { op: 'remove_edge', edgeId: 'e0' },
    ]);

    expect(r.status).toBe('success');
    if (r.status !== 'success') return;
    expect(r.graph.edges.some((e) => e.id === 'e0')).toBe(false);
    expect(r.applied).toEqual([0, 1, 2]);
  });

  it('leaves the caller’s graph untouched so concurrent readers see no partial state', () => {
    const before = structuredClone(FAN_OUT_GRAPH);

    applyPatchOperations(FAN_OUT_GRAPH, [
      { op: 'remove_node', nodeId: 'fan' },
      { op: 'remove_node', nodeId: 'body' },
    ]);

    expect(FAN_OUT_GRAPH).toEqual(before);
  });
});

describe('applyPatchOperations — classification precedence', () => {
  it('keeps a cascade removal retryable when a failed add of the same node precedes it', () => {
    // A later cascade must not erase the pending add: were the removal reported as satisfied,
    // retrying the corrected add alone would resurrect a node the batch asked to remove.
    const r = applyPatchOperations(FAN_OUT_GRAPH, [
      { op: 'add_node', node: { id: 'body', blockType: 'agent', config: { instructions: 'x' } } },
      { op: 'remove_node', nodeId: 'fan' },
      { op: 'remove_node', nodeId: 'body' },
    ]);

    expect(r.status).toBe('partial');
    if (r.status !== 'partial') return;
    expect(r.skipped).toEqual([]);
    expect(r.failed.map((f) => f.index)).toEqual([0, 2]);
  });

  it('applies a later update to a node that was re-added after an earlier add failed', () => {
    const r = applyPatchOperations(BASE_GRAPH, [
      { op: 'add_node', node: { id: 'body', blockType: 'agent', parentId: 'fan' } },
      { op: 'add_node', node: { id: 'fan', blockType: 'fan_out' } },
      {
        op: 'add_node',
        node: { id: 'body', blockType: 'agent', parentId: 'fan', config: { instructions: 'x' } },
      },
      { op: 'update_node', nodeId: 'body', label: 'Per item' },
      { op: 'add_edge', edge: { id: 'e-fan', source: 'n2', target: 'fan' } },
      { op: 'add_edge', edge: { id: 'e-body', source: 'fan', target: 'body' } },
    ]);

    expect(r.status).toBe('partial');
    if (r.status !== 'partial') return;
    expect(r.failed.map((f) => f.index)).toEqual([0]);
    expect(r.skipped).toEqual([]);
    expect(r.graph.nodes.find((n) => n.id === 'body')?.label).toBe('Per item');
  });
});

describe('applyPatchOperations — add_node parent ownership', () => {
  it('fails only the add_node whose Fan Out was removed, keeping the batch partial', () => {
    const r = applyPatchOperations(FAN_OUT_GRAPH, [
      { op: 'remove_node', nodeId: 'fan' },
      { op: 'add_node', node: { id: 'orphan', blockType: 'agent', parentId: 'fan' } },
      { op: 'update_settings', settings: { briefing: 'still saved' } },
    ]);

    expect(r.status).toBe('partial');
    if (r.status !== 'partial') return;
    expect(r.failed.find((f) => f.index === 1)?.code).toBe('stale-parent');
    expect(r.applied).toEqual([0, 2]);
  });

  it('accepts a Fan Out and its owned body added in the same batch when ordered', () => {
    const r = applyPatchOperations(BASE_GRAPH, [
      { op: 'add_node', node: { id: 'fan2', blockType: 'fan_out' } },
      {
        op: 'add_node',
        node: {
          id: 'body2',
          blockType: 'agent',
          parentId: 'fan2',
          config: { instructions: 'per item', fireAndForget: true },
        },
      },
      { op: 'add_edge', edge: { id: 'e-fan2', source: 'n2', target: 'fan2' } },
      { op: 'add_edge', edge: { id: 'e-body2', source: 'fan2', target: 'body2' } },
    ]);

    expect(r.status).toBe('success');
  });
});

describe('applyPatchOperations — implicit edge removal (remove_node cascade)', () => {
  it('treats a later remove_edge of a cascade-removed edge as satisfied', () => {
    const r = applyPatchOperations(BASE_GRAPH, [
      { op: 'remove_node', nodeId: 'nst' },
      { op: 'remove_edge', edgeId: 'e0' },
    ]);

    expect(r.status).toBe('partial');
    if (r.status !== 'partial') return;
    const skip = r.skipped.find((s) => s.index === 1);
    expect(skip?.code).toBe('cascade-removed');
    expect(skip?.reason).toMatch(/at operation 1\b/);
  });

  it('keeps update_edge on a cascade-removed edge a failure — the change never happened', () => {
    const r = applyPatchOperations(BASE_GRAPH, [
      { op: 'remove_node', nodeId: 'nst' },
      { op: 'update_edge', edgeId: 'e1', label: 'boom' },
      { op: 'update_settings', settings: { briefing: 'x' } },
    ]);

    expect(r.status).toBe('partial');
    if (r.status !== 'partial') return;
    expect(r.applied).toEqual([0, 2]);
    expect(r.skipped).toEqual([]);
    const fail = r.failed.find((f) => f.index === 1);
    expect(fail?.code).toBeUndefined();
    expect(fail?.error).toContain('e1');
    expect(fail?.error).toMatch(/at operation 1\b/);
  });

  it('names the causal remove_node when the edge was removed mid-batch', () => {
    const r = applyPatchOperations(BASE_GRAPH, [
      { op: 'update_settings', settings: { briefing: 'op1' } },
      { op: 'remove_node', nodeId: 'nst' },
      { op: 'update_node', nodeId: 'n2', config: { instructions: 'op3' } },
      { op: 'update_settings', settings: { defaultModel: 'claude-sonnet-4-5' } },
      { op: 'update_edge', edgeId: 'e1', label: 'late' },
    ]);

    expect(r.status).toBe('partial');
    if (r.status !== 'partial') return;
    expect(r.applied).toEqual([0, 1, 2, 3]);
    expect(r.failed.find((f) => f.index === 4)?.error).toMatch(/at operation 2\b/);
  });
});
