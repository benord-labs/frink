import { describe, expect, it } from 'vitest';
import type { FlowGraph } from '../../../../shared/lib/validate-flow-graph';
import {
  applyPatchOperations,
  type PatchOperation,
  patchArgsSchema,
  seedDefaultProject,
} from './flow-patch';
import { deepMergePatch } from './deep-merge-patch';

const MIN_VALID_GRAPH: FlowGraph = {
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

describe('patchArgsSchema', () => {
  it('rejects update_node with forbidden blockType (strict schema)', () => {
    const r = patchArgsSchema.safeParse({
      flowId: 'flow-1',
      operations: [{ op: 'update_node', nodeId: 'n1', blockType: 'agent' }],
    });
    expect(r.success).toBe(false);
    if (r.success) return;
    const combined = r.error.issues.map((i) => i.message).join(' ');
    expect(combined).toMatch(/Unrecognized key/i);
  });

  it('accepts Fan Out ownership on add_node and update_node', () => {
    expect(
      patchArgsSchema.safeParse({
        flowId: 'flow-1',
        operations: [
          { op: 'add_node', node: { id: 'body', blockType: 'agent', parentId: 'fan' } },
          { op: 'update_node', nodeId: 'body', parentId: null },
        ],
      }).success,
    ).toBe(true);
  });
});

describe('seedDefaultProject', () => {
  const EMPTY: FlowGraph = { nodes: [], edges: [] };

  it('seeds settings.defaultProjectId on a graph without settings', () => {
    expect(seedDefaultProject(EMPTY, 'proj-1')).toEqual({
      nodes: [],
      edges: [],
      settings: { defaultProjectId: 'proj-1' },
    });
  });

  it('is a no-op when projectId is absent or blank', () => {
    expect(seedDefaultProject(EMPTY, null)).toBe(EMPTY);
    expect(seedDefaultProject(EMPTY, undefined)).toBe(EMPTY);
    expect(seedDefaultProject(EMPTY, '   ')).toBe(EMPTY);
  });

  it('never overwrites existing settings', () => {
    const withSettings: FlowGraph = {
      nodes: [],
      edges: [],
      settings: { defaultProjectId: 'existing' },
    };
    expect(seedDefaultProject(withSettings, 'proj-1')).toBe(withSettings);
  });

  it('an explicit update_settings op applied on top of the seed wins', () => {
    const seeded = seedDefaultProject(EMPTY, '550e8400-e29b-41d4-a716-446655440010');
    const r = applyPatchOperations(seeded, [
      ...MIN_VALID_GRAPH.nodes.map((node): PatchOperation => ({ op: 'add_node', node })),
      ...MIN_VALID_GRAPH.edges.map(
        (edge): PatchOperation => ({
          op: 'add_edge',
          edge: { id: edge.id, source: edge.source, target: edge.target },
        }),
      ),
      {
        op: 'update_settings',
        settings: { defaultProjectId: '550e8400-e29b-41d4-a716-446655440099' },
      },
    ]);
    expect(r.status).toBe('success');
    if (r.status === 'failure') return;
    expect(r.graph.settings?.defaultProjectId).toBe('550e8400-e29b-41d4-a716-446655440099');
  });

  it('the seed survives unrelated ops', () => {
    const seeded = seedDefaultProject(EMPTY, '550e8400-e29b-41d4-a716-446655440010');
    const r = applyPatchOperations(seeded, [
      ...MIN_VALID_GRAPH.nodes.map((node): PatchOperation => ({ op: 'add_node', node })),
      ...MIN_VALID_GRAPH.edges.map(
        (edge): PatchOperation => ({
          op: 'add_edge',
          edge: { id: edge.id, source: edge.source, target: edge.target },
        }),
      ),
    ]);
    expect(r.status).toBe('success');
    if (r.status === 'failure') return;
    expect(r.graph.settings?.defaultProjectId).toBe('550e8400-e29b-41d4-a716-446655440010');
  });
});

describe('deepMergePatch', () => {
  it('merges nested objects without dropping sibling keys', () => {
    const target = {
      expression: 'true',
      loop: { maxIterations: 5, onMaxReached: 'fail' },
    };
    const patch = { loop: { maxIterations: 10 } };
    expect(deepMergePatch(target, patch)).toEqual({
      expression: 'true',
      loop: { maxIterations: 10, onMaxReached: 'fail' },
    });
  });

  it('removes keys when patch value is null', () => {
    const target = { a: 1, headers: { x: 1 } };
    expect(deepMergePatch(target, { headers: null })).toEqual({ a: 1 });
  });

  it('preserves sibling top-level keys when updating instructions', () => {
    const target = { instructions: 'old', fireAndForget: true };
    expect(deepMergePatch(target, { instructions: 'new' })).toEqual({
      instructions: 'new',
      fireAndForget: true,
    });
  });
});

describe('applyPatchOperations — success path', () => {
  it('returns status:success and empty failed/skipped when all ops succeed', () => {
    const r = applyPatchOperations(MIN_VALID_GRAPH, [
      { op: 'update_node', nodeId: 'n2', config: { instructions: 'updated' } },
    ]);
    expect(r.status).toBe('success');
    if (r.status !== 'success') return;
    expect(r.applied).toEqual([0]);
    expect(r.failed).toEqual([]);
    expect(r.skipped).toEqual([]);
    const agent = r.graph.nodes.find((n) => n.id === 'n2');
    expect(agent?.config).toEqual({ instructions: 'updated', fireAndForget: true });
  });

  it('remove_node removes incident edges', () => {
    const r = applyPatchOperations(MIN_VALID_GRAPH, [{ op: 'remove_node', nodeId: 'nst' }]);
    expect(r.status).toBe('success');
  });

  it('removing a Fan Out also removes its owned body', () => {
    const graph: FlowGraph = {
      nodes: [
        ...MIN_VALID_GRAPH.nodes,
        { id: 'fan', blockType: 'fan_out' },
        { id: 'body', blockType: 'agent', parentId: 'fan' },
      ],
      edges: [
        ...MIN_VALID_GRAPH.edges,
        { id: 'e-fan', source: 'n2', target: 'fan' },
        { id: 'e-body', source: 'fan', target: 'body' },
      ],
    };

    const r = applyPatchOperations(graph, [{ op: 'remove_node', nodeId: 'fan' }]);

    expect(r.status).toBe('success');
    if (r.status !== 'success') return;
    expect(r.graph).toEqual(MIN_VALID_GRAPH);
  });

  it('add_node then add_edge in one batch succeeds when ordered', () => {
    const r = applyPatchOperations(MIN_VALID_GRAPH, [
      {
        op: 'add_node',
        node: {
          id: 'ncmd',
          blockType: 'run_command',
          config: { command: 'echo hi', projectId: '550e8400-e29b-41d4-a716-446655440010' },
        },
      },
      { op: 'add_edge', edge: { id: 'e-new', source: 'n2', target: 'ncmd' } },
    ]);
    expect(r.status).toBe('success');
    if (r.status !== 'success') return;
    expect(r.graph.edges.some((e) => e.id === 'e-new')).toBe(true);
    expect(r.applied).toEqual([0, 1]);
  });

  it('updates edge label', () => {
    const r = applyPatchOperations(MIN_VALID_GRAPH, [
      { op: 'update_edge', edgeId: 'e1', label: 'main' },
    ]);
    expect(r.status).toBe('success');
    if (r.status !== 'success') return;
    expect(r.graph.edges.find((e) => e.id === 'e1')?.label).toBe('main');
  });

  it('merges flow settings', () => {
    const withSettings = {
      ...MIN_VALID_GRAPH,
      settings: { defaultModel: 'claude-sonnet-4-5' },
    };
    const r = applyPatchOperations(withSettings, [
      {
        op: 'update_settings',
        settings: { defaultProjectId: '550e8400-e29b-41d4-a716-446655440099' },
      },
    ]);
    expect(r.status).toBe('success');
    if (r.status !== 'success') return;
    expect(r.graph.settings).toEqual({
      defaultModel: 'claude-sonnet-4-5',
      defaultProjectId: '550e8400-e29b-41d4-a716-446655440099',
    });
  });

  it('update_settings sets briefing', () => {
    const r = applyPatchOperations(MIN_VALID_GRAPH, [
      { op: 'update_settings', settings: { briefing: 'Always use TypeScript strict mode.' } },
    ]);
    expect(r.status).toBe('success');
    if (r.status !== 'success') return;
    expect(r.graph.settings?.briefing).toBe('Always use TypeScript strict mode.');
  });

  it('update_settings clears briefing when set to undefined', () => {
    const withBriefing = { ...MIN_VALID_GRAPH, settings: { briefing: 'Old briefing' } };
    const r = applyPatchOperations(withBriefing, [
      { op: 'update_settings', settings: { briefing: undefined } },
    ]);
    expect(r.status).toBe('success');
    if (r.status !== 'success') return;
    expect(r.graph.settings?.briefing).toBeUndefined();
  });

  it('update_settings preserves briefing when patching an unrelated setting', () => {
    const withBriefing = {
      ...MIN_VALID_GRAPH,
      settings: { briefing: 'Keep me', defaultModel: 'claude-sonnet-4-5' },
    };
    const r = applyPatchOperations(withBriefing, [
      {
        op: 'update_settings',
        settings: { defaultProjectId: '550e8400-e29b-41d4-a716-446655440099' },
      },
    ]);
    expect(r.status).toBe('success');
    if (r.status !== 'success') return;
    expect(r.graph.settings?.briefing).toBe('Keep me');
    expect(r.graph.settings?.defaultProjectId).toBe('550e8400-e29b-41d4-a716-446655440099');
  });
});

describe('applyPatchOperations — partial success (per-op resilience)', () => {
  it('continues past a failing op and applies the rest', () => {
    // Op 0: update_node on missing node -> fails
    // Op 1: update_node on existing node -> succeeds
    const r = applyPatchOperations(MIN_VALID_GRAPH, [
      { op: 'update_node', nodeId: 'missing-node', config: { instructions: 'x' } },
      { op: 'update_node', nodeId: 'n2', config: { instructions: 'applied' } },
    ]);
    expect(r.status).toBe('partial');
    if (r.status !== 'partial') return;
    expect(r.applied).toEqual([1]);
    expect(r.failed).toHaveLength(1);
    expect(r.failed[0].index).toBe(0);
    expect(r.failed[0].error).toContain('not found');
    expect(r.skipped).toEqual([]);
    const agent = r.graph.nodes.find((n) => n.id === 'n2');
    expect(agent?.config).toMatchObject({ instructions: 'applied' });
  });

  it('5 ops, op #2 fails: ops 0,1,3,4 applied, op 2 in failed', () => {
    const baseGraph: FlowGraph = {
      nodes: [
        { id: 'n1', blockType: 'manual_trigger' },
        {
          id: 'nst',
          blockType: 'start_task',
          config: { projectId: '550e8400-e29b-41d4-a716-446655440010' },
        },
        { id: 'n2', blockType: 'agent', config: { instructions: 'a', fireAndForget: true } },
        { id: 'n3', blockType: 'agent', config: { instructions: 'b', fireAndForget: true } },
        { id: 'n4', blockType: 'agent', config: { instructions: 'c', fireAndForget: true } },
      ],
      edges: [
        { id: 'e0', source: 'n1', target: 'nst' },
        { id: 'e1', source: 'nst', target: 'n2' },
      ],
    };
    const r = applyPatchOperations(baseGraph, [
      { op: 'update_node', nodeId: 'n2', config: { instructions: 'op0' } },
      { op: 'update_node', nodeId: 'n3', config: { instructions: 'op1' } },
      { op: 'update_node', nodeId: 'DOES-NOT-EXIST', config: { instructions: 'op2' } },
      { op: 'update_node', nodeId: 'n4', config: { instructions: 'op3' } },
      { op: 'update_node', nodeId: 'n2', config: { instructions: 'op4' } },
    ]);
    expect(r.status).toBe('partial');
    if (r.status !== 'partial') return;
    expect(r.applied).toEqual([0, 1, 3, 4]);
    expect(r.failed).toHaveLength(1);
    expect(r.failed[0].index).toBe(2);
    expect(r.skipped).toEqual([]);
  });

  it('add_node fails -> subsequent add_edge referencing it goes to skipped (not failed)', () => {
    // Op 0: add_node with existing id -> fails
    // Op 1: add_edge referencing failed node as source -> skipped
    // Op 2: update_settings -> succeeds
    const r = applyPatchOperations(MIN_VALID_GRAPH, [
      { op: 'add_node', node: { id: 'n2', blockType: 'run_command', config: { command: 'x' } } },
      { op: 'add_edge', edge: { id: 'e-new', source: 'n2', target: 'n1' } },
      { op: 'update_settings', settings: { briefing: 'ok' } },
    ]);
    expect(r.status).toBe('partial');
    if (r.status !== 'partial') return;
    expect(r.failed).toHaveLength(1);
    expect(r.failed[0].index).toBe(0);
    expect(r.failed[0].error).toContain('already exists');
    expect(r.skipped).toHaveLength(1);
    expect(r.skipped[0].index).toBe(1);
    expect(r.skipped[0].reason).toContain('n2');
    expect(r.applied).toContain(2);
  });

  it('add_node fails -> subsequent update_node for same ID is skipped; zero-applied yields failure', () => {
    // Op 0: add_node fails (already exists). Op 1: update_node n2 is skipped (cascading).
    // Zero ops applied -> zero-applied guard -> status:'failure'.
    const r = applyPatchOperations(MIN_VALID_GRAPH, [
      { op: 'add_node', node: { id: 'n2', blockType: 'run_command', config: { command: 'x' } } },
      { op: 'update_node', nodeId: 'n2', config: { instructions: 'new' } },
    ]);
    expect(r.status).toBe('failure');
    if (r.status !== 'failure') return;
    expect(r.applied).toEqual([]);
    expect(r.failed[0].index).toBe(0);
    expect(r.skipped[0].index).toBe(1);
    expect(r.skipped[0].reason).toContain('n2');
  });

  it('add_edge with target in failedNodeIds is skipped', () => {
    const r = applyPatchOperations(MIN_VALID_GRAPH, [
      { op: 'add_node', node: { id: 'n2', blockType: 'run_command', config: { command: 'x' } } },
      { op: 'add_edge', edge: { id: 'e-fail', source: 'n1', target: 'n2' } },
      { op: 'update_settings', settings: { briefing: 'ok' } },
    ]);
    expect(r.status).toBe('partial');
    if (r.status !== 'partial') return;
    expect(r.skipped.some((s) => s.index === 1)).toBe(true);
    expect(r.applied).toContain(2);
  });
});

describe('applyPatchOperations — zero-applied guard', () => {
  it('returns status:failure when all ops fail (zero applied)', () => {
    const r = applyPatchOperations(MIN_VALID_GRAPH, [
      { op: 'update_node', nodeId: 'MISSING', config: { instructions: 'x' } },
      { op: 'remove_node', nodeId: 'ALSO-MISSING' },
    ]);
    expect(r.status).toBe('failure');
    if (r.status !== 'failure') return;
    expect(r.applied).toEqual([]);
    expect(r.failed).toHaveLength(2);
    expect(r.error).toContain('not found');
  });

  it('returns status:failure when add_node fails and dependent edges are all skipped (zero applied)', () => {
    // Tiny graph with just two nodes and one edge
    const g: FlowGraph = {
      nodes: [
        { id: 'n1', blockType: 'manual_trigger' },
        { id: 'nst', blockType: 'start_task', config: { projectId: 'p1' } },
      ],
      edges: [{ id: 'e0', source: 'n1', target: 'nst' }],
    };
    const r = applyPatchOperations(g, [
      // add_node for already-existing n1 -> fails
      { op: 'add_node', node: { id: 'n1', blockType: 'run_command', config: { command: 'x' } } },
      // add_edge referencing failed node -> skipped
      { op: 'add_edge', edge: { id: 'e-new', source: 'n1', target: 'nst' } },
    ]);
    expect(r.status).toBe('failure');
    if (r.status !== 'failure') return;
    expect(r.applied).toEqual([]);
  });

  it('single op fails -> status:failure (not partial), error message comes from op', () => {
    const r = applyPatchOperations(MIN_VALID_GRAPH, [{ op: 'remove_edge', edgeId: 'nonexistent' }]);
    expect(r.status).toBe('failure');
    if (r.status !== 'failure') return;
    expect(r.error).toContain('not found');
  });
});

describe('applyPatchOperations — graph-level validation after ops apply', () => {
  it('returns status:failure when an applied add_edge creates an illegal (non-condition) cycle', () => {
    const r = applyPatchOperations(MIN_VALID_GRAPH, [
      { op: 'add_edge', edge: { id: 'e-cycle', source: 'n2', target: 'n1' } },
    ]);
    expect(r.status).toBe('failure');
    if (r.status !== 'failure') return;
    expect(r.applied).toEqual([0]);
    expect(r.failed).toEqual([]);
    expect(r.error).toMatch(/Graph validation failed after applying 1\/1 ops/i);
    expect(r.error).toMatch(/cycle/i);
  });

  it('returns status:failure when earlier ops succeed but final graph fails save-mode validation', () => {
    const r = applyPatchOperations(MIN_VALID_GRAPH, [
      { op: 'update_node', nodeId: 'n2', config: { instructions: 'ok so far' } },
      { op: 'add_edge', edge: { id: 'e-cycle', source: 'n2', target: 'n1' } },
    ]);
    expect(r.status).toBe('failure');
    if (r.status !== 'failure') return;
    expect(r.applied).toEqual([0, 1]);
    expect(r.failed).toEqual([]);
    expect(r.error).toMatch(/Graph validation failed after applying 2\/2 ops/i);
    expect(r.error).toMatch(/cycle/i);
  });

  it('returns status:failure when update_settings applies invalid defaultProjectId (save-mode settings errors)', () => {
    const r = applyPatchOperations(MIN_VALID_GRAPH, [
      { op: 'update_settings', settings: { defaultProjectId: '' } },
    ]);
    expect(r.status).toBe('failure');
    if (r.status !== 'failure') return;
    expect(r.applied).toEqual([0]);
    expect(r.error).toMatch(/Graph validation failed/i);
    expect(r.error).toMatch(/defaultProjectId/i);
  });
});

describe('applyPatchOperations — legacy error messages preserved', () => {
  it('rejects add_node when id already exists', () => {
    const r = applyPatchOperations(MIN_VALID_GRAPH, [
      { op: 'add_node', node: { id: 'n2', blockType: 'run_command', config: { command: 'x' } } },
    ]);
    // Single-op failure -> zero-applied -> status:failure
    expect(r.status).toBe('failure');
    if (r.status !== 'failure') return;
    expect(r.error).toContain('already exists');
    expect(r.error).toContain('Operation 1');
  });

  it('rejects update_edge with no label or sourceHandle', () => {
    const r = applyPatchOperations(MIN_VALID_GRAPH, [
      { op: 'update_edge', edgeId: 'e1' } as unknown as PatchOperation,
    ]);
    expect(r.status).toBe('failure');
    if (r.status !== 'failure') return;
    expect(r.error).toContain('label or sourceHandle');
  });

  it('rejects remove_edge when edge missing', () => {
    const r = applyPatchOperations(MIN_VALID_GRAPH, [{ op: 'remove_edge', edgeId: 'missing' }]);
    expect(r.status).toBe('failure');
    if (r.status !== 'failure') return;
    expect(r.error).toContain('not found');
  });
});

// sc-3166: over-cap agent prose would only fail at dispatch, so the patch is refused up front.
describe('applyPatchOperations — agent prose length cap', () => {
  it('refuses a patch that puts instructions over the cap, naming the field and limit', () => {
    const r = applyPatchOperations(MIN_VALID_GRAPH, [
      { op: 'update_node', nodeId: 'n2', config: { instructions: 'a'.repeat(60_000) } },
    ]);
    expect(r.status).toBe('failure');
    if (r.status !== 'failure') return;
    expect(r.error).toContain('instructions is 60,000 characters; the limit is 50,000');
  });

  it('refuses an over-cap agentInstructions (Role), which has no editor field to limit it', () => {
    const r = applyPatchOperations(MIN_VALID_GRAPH, [
      { op: 'update_node', nodeId: 'n2', config: { agentInstructions: 'r'.repeat(50_001) } },
    ]);
    expect(r.status).toBe('failure');
    if (r.status !== 'failure') return;
    expect(r.error).toContain('agentInstructions is 50,001');
  });

  it('saves near-cap instructions (a warning, not a failure)', () => {
    const r = applyPatchOperations(MIN_VALID_GRAPH, [
      { op: 'update_node', nodeId: 'n2', config: { instructions: 'a'.repeat(45_000) } },
    ]);
    expect(r.status).toBe('success');
  });
});
