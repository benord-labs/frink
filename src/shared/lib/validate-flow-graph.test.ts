import { describe, expect, it } from 'vitest';
import { LAUNCH_FLAGS } from '../launch-flags';
import { FLOW_BLOCK_TYPES } from '../types/flow';
import { FLOW_BLOCK_DISPLAY_LABELS } from './flow-block-display-labels';
import { findBackEdges } from './flow-graph-cycle';
import {
  type FlowGraph,
  flowGraphsEqual,
  linearFlowGraph,
  MAX_FLOW_GRAPH_NODES,
  normalizeFlowGraph,
  validateGraph,
} from './validate-flow-graph';

const TEST_RUN_STEP = { projectId: 'p1', command: 'echo step' } as const;

/** Linear `{ nodes, edges }` with one trigger + (count - 1) run_command steps. */
function makeLinearFlowGraph(nodeCount: number) {
  const nodes: { id: string; blockType: string; config?: typeof TEST_RUN_STEP }[] = [
    { id: 't0', blockType: 'manual_trigger' },
  ];
  for (let i = 1; i < nodeCount; i += 1) {
    nodes.push({ id: `n${i}`, blockType: 'run_command', config: { ...TEST_RUN_STEP } });
  }
  return linearFlowGraph(nodes);
}

describe('validateGraph (shared)', () => {
  it.each([
    ['{} (empty object)', {} as Record<string, unknown>],
    ['undefined (missing)', undefined],
    // Deserialized graph JSON can have config: null before the editor normalizes it
    ['null', null as unknown as Record<string, unknown>],
  ])('accepts a parameterless custom node with %s config', (_label, config) => {
    const r = validateGraph(
      linearFlowGraph([
        { id: 't', blockType: 'manual_trigger' },
        { id: 'c', blockType: 'my_custom', config },
      ]),
    );
    expect(r).toEqual({ valid: true });
  });

  it('rejects custom node config that is an array (must be object)', () => {
    const r = validateGraph(
      linearFlowGraph([
        { id: 't', blockType: 'manual_trigger' },
        { id: 'c', blockType: 'my_custom', config: [] as unknown as Record<string, unknown> },
      ]),
    );
    expect(r.valid).toBe(false);
    if (!r.valid) {
      expect(r.errors.some((e) => e.includes('config must be an object'))).toBe(true);
    }
  });

  it('FLOW_BLOCK_DISPLAY_LABELS covers every FLOW_BLOCK_TYPE', () => {
    for (const t of FLOW_BLOCK_TYPES) {
      expect(FLOW_BLOCK_DISPLAY_LABELS[t]).toBeTruthy();
      expect(typeof FLOW_BLOCK_DISPLAY_LABELS[t]).toBe('string');
    }
  });

  it('accepts trigger + step with edge', () => {
    const r = validateGraph(
      linearFlowGraph([
        { id: 't', blockType: 'manual_trigger' },
        { id: 's', blockType: 'run_command', config: { ...TEST_RUN_STEP } },
      ]),
    );
    expect(r).toEqual({ valid: true });
  });

  it('rejects single node', () => {
    const r = validateGraph(
      { nodes: [{ id: 't', blockType: 'manual_trigger' }], edges: [] },
      { mode: 'run' },
    );
    expect(r.valid).toBe(false);
  });

  it('rejects empty nodes', () => {
    expect(validateGraph({ nodes: [], edges: [] }, { mode: 'run' })).toEqual({
      valid: false,
      errors: ['Graph must contain at least 2 nodes (trigger + at least one step)'],
    });
  });

  it('rejects raw array (must be object)', () => {
    expect(validateGraph([])).toEqual({
      valid: false,
      errors: ['Graph must be an object with nodes and edges'],
    });
  });

  it('accepts graph at max node count', () => {
    const r = validateGraph(makeLinearFlowGraph(MAX_FLOW_GRAPH_NODES));
    expect(r).toEqual({ valid: true });
  });

  it('rejects graph exceeding max node limit', () => {
    expect(validateGraph(makeLinearFlowGraph(MAX_FLOW_GRAPH_NODES + 1))).toEqual({
      valid: false,
      errors: [`Graph cannot exceed ${MAX_FLOW_GRAPH_NODES} nodes`],
    });
  });

  it('rejects graph with no trigger', () => {
    const g = linearFlowGraph([
      { id: 'x', blockType: 'run_command', config: { ...TEST_RUN_STEP } },
      { id: 'y', blockType: 'run_command', config: { ...TEST_RUN_STEP } },
    ]);
    const noTrigger = validateGraph(g);
    expect(noTrigger.valid).toBe(false);
    if (!noTrigger.valid) {
      expect(noTrigger.errors).toContain('Graph must have exactly one trigger node');
    }
  });

  it('rejects unknown blockType on a node', () => {
    const allowed = FLOW_BLOCK_TYPES.join(', ');
    const result = validateGraph(
      linearFlowGraph([
        { id: 't', blockType: 'manual_trigger' },
        { id: 's', blockType: 'INVALID_BLOCK_TYPE' },
      ]),
    );
    expect(result.valid).toBe(false);
    if (result.valid) throw new Error('expected invalid');
    expect(
      result.errors.some(
        (e) => e.includes('invalid blockType') && e.includes('INVALID_BLOCK_TYPE'),
      ),
    ).toBe(true);
    expect(result.errors.some((e) => e.includes(allowed))).toBe(true);
  });

  it('accepts a custom node blockType (e.g. check-new-prs)', () => {
    const r = validateGraph(
      linearFlowGraph([
        { id: 't', blockType: 'manual_trigger' },
        { id: 'c', blockType: 'check-new-prs', config: { projectId: 'proj-1', repo: 'o/r' } },
      ]),
    );
    expect(r.valid).toBe(true);
    // errors is absent on valid result; warnings may be present for unreachable etc.
    if (!r.valid) throw new Error('expected valid');
  });

  it('accepts custom node names with underscores and digits', () => {
    const r = validateGraph(
      linearFlowGraph([
        { id: 't', blockType: 'manual_trigger' },
        { id: 'c', blockType: 'my_custom_node2', config: {} },
      ]),
    );
    expect(r.valid).toBe(true);
  });

  it('rejects trigger without exactly one outgoing edge', () => {
    const r = validateGraph(
      {
        nodes: [
          { id: 't', blockType: 'manual_trigger' },
          { id: 'a', blockType: 'run_command', config: { ...TEST_RUN_STEP } },
          { id: 'b', blockType: 'run_command', config: { ...TEST_RUN_STEP } },
        ],
        edges: [
          { id: 'e1', source: 't', target: 'a' },
          { id: 'e2', source: 't', target: 'b' },
        ],
      },
      { mode: 'run' },
    );
    expect(r.valid).toBe(false);
    if (!r.valid) {
      expect(r.errors).toContain('Trigger must have exactly one outgoing edge');
    }
  });

  it('rejects directed cycle', () => {
    const r = validateGraph({
      nodes: [
        { id: 't', blockType: 'manual_trigger' },
        { id: 'a', blockType: 'run_command', config: { ...TEST_RUN_STEP } },
        { id: 'b', blockType: 'run_command', config: { ...TEST_RUN_STEP } },
      ],
      edges: [
        { id: 'e1', source: 't', target: 'a' },
        { id: 'e2', source: 'a', target: 'b' },
        { id: 'e3', source: 'b', target: 'a' },
      ],
    });
    expect(r.valid).toBe(false);
    if (!r.valid) {
      expect(r.errors.some((e) => e.includes('creates a cycle'))).toBe(true);
    }
  });

  it('warns when a node exists but is not reachable from the trigger (BFS reachability)', () => {
    const r = validateGraph({
      nodes: [
        { id: 't', blockType: 'manual_trigger' },
        { id: 'a', blockType: 'run_command', config: { ...TEST_RUN_STEP } },
        {
          id: 'o',
          blockType: 'run_command',
          config: { ...TEST_RUN_STEP },
          label: 'Orphan',
        },
      ],
      edges: [{ id: 'e1', source: 't', target: 'a' }],
    });
    expect(r.valid).toBe(true);
    if (r.valid) {
      expect(
        (r.warnings ?? []).some((w: string) => w.includes('Orphan') && w.includes('not reachable')),
      ).toBe(true);
    }
  });
});

describe('normalizeFlowGraph', () => {
  it('accepts { nodes, edges } object', () => {
    const graph = {
      nodes: [
        { id: 't', blockType: 'manual_trigger' },
        { id: 'a', blockType: 'run_command', config: { ...TEST_RUN_STEP } },
      ],
      edges: [{ id: 'e1', source: 't', target: 'a' }],
    };
    const result = normalizeFlowGraph(graph);
    expect(result).toEqual(graph);
  });

  it('converts legacy array to graph', () => {
    const array = [
      { id: 't', blockType: 'manual_trigger' },
      { id: 'a', blockType: 'run_command', config: { ...TEST_RUN_STEP } },
    ];
    const result = normalizeFlowGraph(array);
    expect(result).not.toBeNull();
    if (result) {
      expect(result.nodes).toHaveLength(2);
      expect(result.edges).toHaveLength(1);
      expect(result.edges[0]?.source).toBe('t');
      expect(result.edges[0]?.target).toBe('a');
    }
  });

  it('rejects array with invalid blockType', () => {
    const array = [
      { id: 't', blockType: 'manual_trigger' },
      { id: 'a', blockType: 'INVALID_BLOCK_TYPE' },
    ];
    const result = normalizeFlowGraph(array);
    expect(result).toBeNull();
  });

  it('accepts legacy array with a custom node blockType', () => {
    const array = [
      { id: 't', blockType: 'manual_trigger' },
      { id: 'c', blockType: 'check-new-prs', config: { repo: 'o/r' } },
    ];
    const result = normalizeFlowGraph(array);
    expect(result).not.toBeNull();
    expect(result?.nodes.some((n) => n.blockType === 'check-new-prs')).toBe(true);
  });

  it('rejects array with missing id', () => {
    const array = [{ id: '', blockType: 'run_command' }];
    const result = normalizeFlowGraph(array);
    expect(result).toBeNull();
  });

  it('rejects array with non-object elements', () => {
    const array = ['not an object'];
    const result = normalizeFlowGraph(array);
    expect(result).toBeNull();
  });

  it('returns null for non-object/non-array', () => {
    expect(normalizeFlowGraph(null)).toBeNull();
    expect(normalizeFlowGraph('string')).toBeNull();
    expect(normalizeFlowGraph(123)).toBeNull();
    expect(normalizeFlowGraph({})).toBeNull();
    expect(normalizeFlowGraph({ nodes: [] })).toBeNull();
    expect(normalizeFlowGraph({ edges: [] })).toBeNull();
  });
});

describe('findBackEdges', () => {
  it('returns empty set for acyclic graph', () => {
    const graph = {
      nodes: [{ id: 't' }, { id: 'a' }, { id: 'b' }],
      edges: [
        { id: 'e1', source: 't', target: 'a' },
        { id: 'e2', source: 'a', target: 'b' },
      ],
    };
    expect(findBackEdges(graph).size).toBe(0);
  });

  it('identifies back-edge in simple cycle a→b→a', () => {
    const graph = {
      nodes: [{ id: 't' }, { id: 'a' }, { id: 'b' }],
      edges: [
        { id: 'e1', source: 't', target: 'a' },
        { id: 'e2', source: 'a', target: 'b' },
        { id: 'e3', source: 'b', target: 'a' },
      ],
    };
    const back = findBackEdges(graph);
    expect(back.has('e3')).toBe(true);
    expect(back.has('e1')).toBe(false);
    expect(back.has('e2')).toBe(false);
  });

  it('handles condition node loop-back', () => {
    // trigger → a → condition → (true) b → condition (loop-back)
    const graph = {
      nodes: [{ id: 't' }, { id: 'a' }, { id: 'c' }, { id: 'b' }, { id: 'exit' }],
      edges: [
        { id: 'e1', source: 't', target: 'a' },
        { id: 'e2', source: 'a', target: 'c' },
        { id: 'e3', source: 'c', target: 'b', sourceHandle: 'true' },
        { id: 'e4', source: 'b', target: 'c' },
        { id: 'e5', source: 'c', target: 'exit', sourceHandle: 'false' },
      ],
    };
    const back = findBackEdges(graph);
    expect(back.has('e4')).toBe(true);
    expect(back.has('e3')).toBe(false);
    expect(back.has('e5')).toBe(false);
  });

  it('treats parallel edges to the same target as forward edges (no false back-edges)', () => {
    const graph = {
      nodes: [{ id: 't' }, { id: 'a' }, { id: 'b' }],
      edges: [
        { id: 'e1', source: 't', target: 'a' },
        { id: 'e2', source: 't', target: 'a' },
        { id: 'e3', source: 'a', target: 'b' },
      ],
    };
    expect(findBackEdges(graph).size).toBe(0);
  });

  it('ignores edges whose endpoints are not in the node set', () => {
    const graph = {
      nodes: [{ id: 't' }, { id: 'a' }],
      edges: [
        { id: 'e1', source: 't', target: 'a' },
        { id: 'e-dangle', source: 'a', target: 'missing-node' },
      ],
    };
    expect(findBackEdges(graph).size).toBe(0);
  });
});

describe('validateGraph — loop-back rules', () => {
  it('allows condition back-edge as a warning', () => {
    const graph = {
      nodes: [
        { id: 't', blockType: 'manual_trigger' },
        { id: 'a', blockType: 'run_command', config: { ...TEST_RUN_STEP } },
        { id: 'c', blockType: 'condition' },
        { id: 'exit', blockType: 'run_command', config: { ...TEST_RUN_STEP } },
      ],
      edges: [
        { id: 'e1', source: 't', target: 'a' },
        { id: 'e2', source: 'a', target: 'c' },
        { id: 'e3', source: 'c', target: 'a', sourceHandle: 'true' },
        { id: 'e4', source: 'c', target: 'exit', sourceHandle: 'false' },
      ],
    };
    const r = validateGraph(graph);
    expect(r.valid).toBe(true);
    if (r.valid) {
      expect(r.warnings?.some((w) => w.includes('loop'))).toBe(true);
    }
  });

  it('rejects non-condition back-edge with error', () => {
    const graph = {
      nodes: [
        { id: 't', blockType: 'manual_trigger' },
        { id: 'a', blockType: 'run_command', config: { ...TEST_RUN_STEP } },
        { id: 'b', blockType: 'run_command', config: { ...TEST_RUN_STEP } },
      ],
      edges: [
        { id: 'e1', source: 't', target: 'a' },
        { id: 'e2', source: 'a', target: 'b' },
        { id: 'e3', source: 'b', target: 'a' },
      ],
    };
    const r = validateGraph(graph);
    expect(r.valid).toBe(false);
    if (!r.valid) {
      expect(r.errors.some((e) => e.includes('creates a cycle'))).toBe(true);
    }
  });

  it('rejects condition node where both handles loop back', () => {
    const graph = {
      nodes: [
        { id: 't', blockType: 'manual_trigger' },
        { id: 'a', blockType: 'run_command', config: { ...TEST_RUN_STEP } },
        { id: 'c', blockType: 'condition' },
      ],
      edges: [
        { id: 'e1', source: 't', target: 'a' },
        { id: 'e2', source: 'a', target: 'c' },
        { id: 'e3', source: 'c', target: 'a', sourceHandle: 'true' },
        { id: 'e4', source: 'c', target: 'a', sourceHandle: 'false' },
      ],
    };
    const r = validateGraph(graph);
    expect(r.valid).toBe(false);
    if (!r.valid) {
      expect(r.errors.some((e) => e.includes('no exit path'))).toBe(true);
    }
  });

  it('rejects loop.maxIterations outside 1–50', () => {
    const graph = {
      nodes: [
        { id: 't', blockType: 'manual_trigger' },
        { id: 'a', blockType: 'run_command', config: { ...TEST_RUN_STEP } },
        {
          id: 'c',
          blockType: 'condition',
          config: { loop: { maxIterations: 99, onMaxReached: 'fail' } },
        },
        { id: 'exit', blockType: 'run_command', config: { ...TEST_RUN_STEP } },
      ],
      edges: [
        { id: 'e1', source: 't', target: 'a' },
        { id: 'e2', source: 'a', target: 'c' },
        { id: 'e3', source: 'c', target: 'a', sourceHandle: 'true' },
        { id: 'e4', source: 'c', target: 'exit', sourceHandle: 'false' },
      ],
    };
    const r = validateGraph(graph);
    expect(r.valid).toBe(false);
    if (!r.valid) {
      expect(r.errors.some((e) => e.includes('loop.maxIterations'))).toBe(true);
    }
  });

  it('accepts valid loop config', () => {
    const graph = {
      nodes: [
        { id: 't', blockType: 'manual_trigger' },
        { id: 'a', blockType: 'run_command', config: { ...TEST_RUN_STEP } },
        {
          id: 'c',
          blockType: 'condition',
          config: { loop: { maxIterations: 5, onMaxReached: 'continue' } },
        },
        { id: 'exit', blockType: 'run_command', config: { ...TEST_RUN_STEP } },
      ],
      edges: [
        { id: 'e1', source: 't', target: 'a' },
        { id: 'e2', source: 'a', target: 'c' },
        { id: 'e3', source: 'c', target: 'a', sourceHandle: 'true' },
        { id: 'e4', source: 'c', target: 'exit', sourceHandle: 'false' },
      ],
    };
    const r = validateGraph(graph);
    expect(r.valid).toBe(true);
  });

  it('accepts valid flow settings', () => {
    const base = linearFlowGraph([
      { id: 't', blockType: 'manual_trigger' },
      { id: 's', blockType: 'run_command', config: { ...TEST_RUN_STEP } },
    ]);
    const r = validateGraph({
      ...base,
      settings: {
        defaultModel: 'sonnet',
        defaultProjectId: 'a1b2c3d4-e5f6-7890-abcd-ef1234567890',
      },
    });
    expect(r).toEqual({ valid: true });
  });

  it('rejects non-string defaultModel in settings', () => {
    const base = linearFlowGraph([
      { id: 't', blockType: 'manual_trigger' },
      { id: 's', blockType: 'run_command', config: { ...TEST_RUN_STEP } },
    ]);
    const r = validateGraph({ ...base, settings: { defaultModel: 42 } } as unknown as typeof base);
    expect(r.valid).toBe(false);
    if (!r.valid) {
      expect(r.errors.some((e) => e.includes('defaultModel'))).toBe(true);
    }
  });

  it('includes settings errors together with node errors after nodes/edges shape is valid', () => {
    const r = validateGraph({
      nodes: [
        { id: 't', blockType: 'manual_trigger' },
        { id: 'dup', blockType: 'run_command', config: { ...TEST_RUN_STEP } },
        { id: 'dup', blockType: 'run_command', config: { ...TEST_RUN_STEP } },
      ],
      edges: [{ id: 'e1', source: 't', target: 'dup' }],
      settings: { defaultModel: '!!!' },
    });
    expect(r.valid).toBe(false);
    if (!r.valid) {
      expect(r.errors.some((e) => e.includes('defaultModel'))).toBe(true);
      expect(r.errors.some((e) => e.includes('duplicate id'))).toBe(true);
    }
  });

  it('preserves settings through normalizeFlowGraph', () => {
    const base = linearFlowGraph([
      { id: 't', blockType: 'manual_trigger' },
      { id: 's', blockType: 'run_command', config: { ...TEST_RUN_STEP } },
    ]);
    const settings = { defaultModel: 'haiku' };
    const normalized = normalizeFlowGraph({ ...base, settings });
    expect(normalized).not.toBeNull();
    expect(normalized?.settings).toEqual(settings);
  });

  it('EC-NORMALIZE-BATCH: normalizeFlowGraph preserves batchTriggerSchema in settings', () => {
    // Regression guard: if normalizeFlowGraph ever strips unknown settings keys, the
    // serverBatchTriggerSchema useMemo in FlowEditor returns undefined and the sync
    // effect can never apply auto-merged schemas to local state.
    const base = linearFlowGraph([
      { id: 't', blockType: 'manual_trigger' },
      { id: 's', blockType: 'run_command', config: { ...TEST_RUN_STEP } },
    ]);
    const settings = {
      defaultModel: 'claude-3-haiku',
      batchTriggerSchema: [
        { key: 'ticketId', type: 'string' },
        { key: 'workstreamId', type: 'string' },
      ],
    };
    const normalized = normalizeFlowGraph({ ...base, settings });
    expect(normalized).not.toBeNull();
    expect(normalized?.settings?.batchTriggerSchema).toEqual(settings.batchTriggerSchema);
    expect(normalized?.settings?.defaultModel).toBe('claude-3-haiku');
  });

  const TEST_PROJECT_UUID = 'a1b2c3d4-e5f6-7890-abcd-ef1234567890';

  it('agent: rejects when no upstream start_task', () => {
    const g = linearFlowGraph([
      { id: 't', blockType: 'manual_trigger' },
      { id: 'a', blockType: 'agent', config: { instructions: 'step' } },
    ]);
    const r = validateGraph(g, { mode: 'run' });
    expect(r.valid).toBe(false);
    if (!r.valid) {
      expect(r.errors.some((e) => e.includes('Start Task'))).toBe(true);
    }
  });

  it('agent: accepts when preceded by start_task with projectId', () => {
    const g = {
      nodes: [
        { id: 't', blockType: 'manual_trigger' },
        {
          id: 'st',
          blockType: 'start_task',
          config: { projectId: TEST_PROJECT_UUID },
        },
        { id: 'a', blockType: 'agent', config: { instructions: 'step' } },
      ],
      edges: [
        { id: 'e1', source: 't', target: 'st' },
        { id: 'e2', source: 'st', target: 'a' },
      ],
    };
    expect(validateGraph(g, { mode: 'run' })).toEqual({ valid: true });
  });

  it('agent: accepts fan_out → start_task → agent (start_task not immediate predecessor of trigger)', () => {
    const g = {
      nodes: [
        { id: 't', blockType: 'manual_trigger' },
        { id: 'f', blockType: 'fan_out', label: 'Fan Out' },
        {
          id: 'st',
          blockType: 'start_task',
          parentId: 'f',
          config: { projectId: TEST_PROJECT_UUID },
        },
        { id: 'a', blockType: 'agent', parentId: 'f', config: { instructions: 'step' } },
        { id: 'done', blockType: 'end' },
      ],
      edges: [
        { id: 'e1', source: 't', target: 'f' },
        { id: 'e2', source: 'f', target: 'st' },
        { id: 'e3', source: 'st', target: 'a' },
        { id: 'e4', source: 'a', target: 'done' },
      ],
    };
    expect(validateGraph(g, { mode: 'run' })).toEqual({ valid: true });
  });

  describe('nodes after a Fan Out need a Start Task outside it (sc-3836)', () => {
    const START = { projectId: TEST_PROJECT_UUID };
    // t → [st] → f[st-lane? → a-lane] → after — `outer` / `laneStart` toggle the two start_tasks.
    function afterFanOut(
      after: { blockType: string; config?: Record<string, unknown> },
      opts: { outer: boolean; laneStart: boolean; trigger?: string },
    ) {
      const nodes: Record<string, unknown>[] = [
        { id: 't', blockType: opts.trigger ?? 'manual_trigger' },
        { id: 'f', blockType: 'fan_out', label: 'Fan Out' },
        {
          id: 'a-lane',
          blockType: 'agent',
          parentId: 'f',
          config: { instructions: 'item' },
        },
        { id: 'after', label: 'After', ...after },
      ];
      const edges = [{ id: 'e-tail', source: 'a-lane', target: 'after' }];
      if (opts.outer) {
        nodes.push({ id: 'st', blockType: 'start_task', config: START });
        edges.push(
          { id: 'e1', source: 't', target: 'st' },
          { id: 'e2', source: 'st', target: 'f' },
        );
      } else {
        edges.push({ id: 'e1', source: 't', target: 'f' });
      }
      if (opts.laneStart) {
        nodes.push({
          id: 'st-lane',
          blockType: 'start_task',
          parentId: 'f',
          config: START,
        });
        edges.push(
          { id: 'e3', source: 'f', target: 'st-lane' },
          { id: 'e4', source: 'st-lane', target: 'a-lane' },
        );
      } else {
        edges.push({ id: 'e3', source: 'f', target: 'a-lane' });
      }
      return { nodes, edges };
    }
    const errorsOf = (r: ReturnType<typeof validateGraph>) => (r.valid ? [] : r.errors);
    const AGENT = { blockType: 'agent', config: { instructions: 'report' } };
    const REPLY = {
      blockType: 'chat_reply',
      config: { messageTemplate: 'done' },
    };

    it('rejects an agent after the barrier whose only Start Task (and agent) are inside the lane', () => {
      const r = validateGraph(afterFanOut(AGENT, { outer: false, laneStart: true }), {
        mode: 'run',
      });
      expect(r.valid).toBe(false);
      expect(errorsOf(r).some((e) => e.includes('"After"') && e.includes('outside'))).toBe(true);
    });

    it('rejects a chat reply after the barrier whose only Start Task is inside the lane', () => {
      const r = validateGraph(afterFanOut(REPLY, { outer: false, laneStart: true }), {
        mode: 'run',
      });
      expect(r.valid).toBe(false);
      expect(errorsOf(r).some((e) => e.includes('"After"') && e.includes('outside'))).toBe(true);
    });

    it.each([
      ['agent', AGENT],
      ['chat reply', REPLY],
    ])(
      'accepts a %s after the barrier when an outer Start Task precedes the Fan Out',
      (_l, after) => {
        for (const laneStart of [false, true]) {
          expect(
            validateGraph(afterFanOut(after, { outer: true, laneStart }), {
              mode: 'run',
            }),
          ).toEqual({ valid: true });
        }
      },
    );

    it('still accepts a lane-only chat reply when a Post-Task trigger supplies the chat', () => {
      const r = validateGraph(
        afterFanOut(REPLY, {
          outer: false,
          laneStart: true,
          trigger: 'post_task_trigger',
        }),
        { mode: 'run' },
      );
      expect(errorsOf(r)).not.toContainEqual(expect.stringContaining('"After"'));
    });

    it('accepts an agent after the barrier chained from an outer agent', () => {
      const g = afterFanOut(AGENT, { outer: true, laneStart: false });
      // st → outer agent → f: the outer agent also satisfies an agent's upstream check.
      g.nodes.push({
        id: 'a-outer',
        blockType: 'agent',
        config: { instructions: 'prep' },
      });
      g.edges = g.edges.map((e) => (e.id === 'e2' ? { ...e, target: 'a-outer' } : e));
      g.edges.push({ id: 'e2b', source: 'a-outer', target: 'f' });
      expect(validateGraph(g, { mode: 'run' })).toEqual({ valid: true });
    });
  });

  it('start_task: accepts empty or whitespace branch as optional when startInWorktree is true', () => {
    for (const branch of ['', '   ', '\t']) {
      const g = {
        nodes: [
          { id: 't', blockType: 'manual_trigger' },
          {
            id: 'st',
            blockType: 'start_task',
            config: { projectId: TEST_PROJECT_UUID, startInWorktree: true, branch },
          },
        ],
        edges: [{ id: 'e1', source: 't', target: 'st' }],
      };
      expect(validateGraph(g)).toEqual({ valid: true });
    }
  });

  it('start_task: rejects non-string branch when startInWorktree is true', () => {
    const g = {
      nodes: [
        { id: 't', blockType: 'manual_trigger' },
        {
          id: 'st',
          blockType: 'start_task',
          config: { projectId: TEST_PROJECT_UUID, startInWorktree: true, branch: 123 },
        },
      ],
      edges: [{ id: 'e1', source: 't', target: 'st' }],
    };
    const r = validateGraph(g, { mode: 'run' });
    expect(r.valid).toBe(false);
    if (!r.valid) {
      expect(r.errors.some((e) => e.includes('branch') && e.includes('string'))).toBe(true);
    }
  });

  it('start_task: accepts startInWorktree true with branch omitted', () => {
    const g = {
      nodes: [
        { id: 't', blockType: 'manual_trigger' },
        {
          id: 'st',
          blockType: 'start_task',
          config: { projectId: TEST_PROJECT_UUID, startInWorktree: true },
        },
      ],
      edges: [{ id: 'e1', source: 't', target: 'st' }],
    };
    expect(validateGraph(g)).toEqual({ valid: true });
  });

  it('fan_out: rejects maxParallel out of range in parallel mode', () => {
    const g = {
      nodes: [
        { id: 't', blockType: 'manual_trigger' },
        {
          id: 'f',
          blockType: 'fan_out',
          config: { mode: 'parallel', maxParallel: 99 },
        },
        { id: 'a', blockType: 'run_command', config: { ...TEST_RUN_STEP } },
      ],
      edges: [
        { id: 'e1', source: 't', target: 'f' },
        { id: 'e2', source: 'f', target: 'a' },
      ],
    };
    const r = validateGraph(g, { mode: 'run' });
    expect(r.valid).toBe(false);
    if (!r.valid) {
      expect(r.errors.some((e) => e.includes('maxParallel'))).toBe(true);
    }
  });

  it('chat_reply: warns when messageTemplate is missing', () => {
    const g = linearFlowGraph([
      { id: 't', blockType: 'post_task_trigger' },
      { id: 'cr', blockType: 'chat_reply', config: {} },
    ]);
    const r = validateGraph(g, { mode: 'run' });
    expect(r.valid).toBe(true);
    if (r.valid) {
      expect(r.warnings?.some((w) => w.includes('message template'))).toBe(true);
    }
  });

  it('chat_reply: passes cleanly when messageTemplate is set', () => {
    const g = linearFlowGraph([
      { id: 't', blockType: 'manual_trigger' },
      { id: 'st', blockType: 'start_task', config: { projectId: 'p1' } },
      {
        id: 'cr',
        blockType: 'chat_reply',
        config: { messageTemplate: 'Done: {{trigger.status}}' },
      },
    ]);
    const r = validateGraph(g, { mode: 'run' });
    expect(r.valid).toBe(true);
    if (r.valid) {
      expect(r.warnings?.some((w) => w.includes('message template'))).toBeFalsy();
    }
  });

  it('chat_reply: a complete HTML artifact config follows the interactive-views flag', () => {
    const g = linearFlowGraph([
      { id: 't', blockType: 'post_task_trigger' },
      {
        id: 'cr',
        blockType: 'chat_reply',
        config: {
          contentType: 'html_artifact',
          artifactTitleTemplate: 'Report for {{trigger.taskTitle}}',
          artifactBodyHtmlTemplate: '<button>Open</button>',
        },
      },
    ]);
    const r = validateGraph(g, { mode: 'run' });

    if (LAUNCH_FLAGS.flowHtmlArtifacts) {
      expect(r).toEqual({ valid: true });
      return;
    }
    // Run mode is the authoring-time control: the MCP patch path drops warnings,
    // so a disabled reply type has to surface as an error to reach the agent.
    expect(r.valid).toBe(false);
    if (!r.valid) expect(r.errors.some((e) => e.includes('turned off'))).toBe(true);
  });

  it('chat_reply: a text reply is unaffected by the interactive-views flag', () => {
    const g = linearFlowGraph([
      { id: 't', blockType: 'post_task_trigger' },
      { id: 'cr', blockType: 'chat_reply', config: { messageTemplate: 'done' } },
    ]);
    expect(validateGraph(g, { mode: 'run' })).toEqual({ valid: true });
  });

  it('chat_reply: rejects schedule_trigger path without upstream start_task', () => {
    const g = linearFlowGraph([
      {
        id: 't',
        blockType: 'schedule_trigger',
        config: { cronExpression: '0 2 * * *', timezone: 'UTC' },
      },
      { id: 'rc', blockType: 'run_command', config: { ...TEST_RUN_STEP } },
      { id: 'cr', blockType: 'chat_reply', config: { messageTemplate: 'done' } },
    ]);
    const r = validateGraph(g, { mode: 'run' });
    expect(r.valid).toBe(false);
    if (!r.valid) {
      expect(
        r.errors.some((e) => e.includes('Chat Reply') && e.includes('Post-Task trigger')),
      ).toBe(true);
    }
  });

  it('chat_reply: valid with post_task_trigger and no start_task', () => {
    const g = linearFlowGraph([
      { id: 't', blockType: 'post_task_trigger' },
      {
        id: 'cr',
        blockType: 'chat_reply',
        config: { messageTemplate: 'Summary: {{trigger.result}}' },
      },
    ]);
    expect(validateGraph(g, { mode: 'run' })).toEqual({ valid: true });
  });

  it('chat_reply: valid with manual_trigger and upstream start_task', () => {
    const g = linearFlowGraph([
      { id: 't', blockType: 'manual_trigger' },
      { id: 'st', blockType: 'start_task', config: { projectId: 'p1' } },
      { id: 'cr', blockType: 'chat_reply', config: { messageTemplate: 'ok' } },
    ]);
    expect(validateGraph(g, { mode: 'run' })).toEqual({ valid: true });
  });

  it('chat_reply: rejects when on condition false branch without start_task on that path', () => {
    const g = {
      nodes: [
        { id: 't', blockType: 'manual_trigger' },
        { id: 'rc', blockType: 'run_command', config: { ...TEST_RUN_STEP } },
        {
          id: 'c',
          blockType: 'condition',
          config: {
            predicate: { field: 'exitCode', operator: 'eq', value: 0 },
          },
        },
        { id: 'endT', blockType: 'end' },
        { id: 'cr', blockType: 'chat_reply', config: { messageTemplate: 'false branch' } },
      ],
      edges: [
        { id: 'e1', source: 't', target: 'rc' },
        { id: 'e2', source: 'rc', target: 'c' },
        { id: 'e3', source: 'c', target: 'endT', sourceHandle: 'true' },
        { id: 'e4', source: 'c', target: 'cr', sourceHandle: 'false' },
      ],
    };
    const r = validateGraph(g, { mode: 'run' });
    expect(r.valid).toBe(false);
    if (!r.valid) {
      expect(
        r.errors.some((e) => e.includes('Chat Reply') && e.includes('Post-Task trigger')),
      ).toBe(true);
    }
  });

  it('chat_reply: valid when start_task is separated by run_command from chat_reply', () => {
    const g = linearFlowGraph([
      { id: 't', blockType: 'manual_trigger' },
      { id: 'st', blockType: 'start_task', config: { projectId: 'p1' } },
      { id: 'rc', blockType: 'run_command', config: { ...TEST_RUN_STEP } },
      { id: 'cr', blockType: 'chat_reply', config: { messageTemplate: '{{previous.exitCode}}' } },
    ]);
    expect(validateGraph(g, { mode: 'run' })).toEqual({ valid: true });
  });

  it('chat_reply: rejects manual_trigger with chat_reply and no start_task', () => {
    const g = linearFlowGraph([
      { id: 't', blockType: 'manual_trigger' },
      { id: 'cr', blockType: 'chat_reply', config: { messageTemplate: 'x' } },
    ]);
    const r = validateGraph(g, { mode: 'run' });
    expect(r.valid).toBe(false);
    if (!r.valid) {
      expect(
        r.errors.some((e) => e.includes('Chat Reply') && e.includes('Post-Task trigger')),
      ).toBe(true);
    }
  });

  it('chat_reply: rejects webhook_trigger path without upstream start_task', () => {
    const g = linearFlowGraph([
      { id: 't', blockType: 'webhook_trigger', config: { integrationId: 'i', eventType: 'push' } },
      { id: 'cr', blockType: 'chat_reply', config: { messageTemplate: 'hook' } },
    ]);
    const r = validateGraph(g, { mode: 'run' });
    expect(r.valid).toBe(false);
    if (!r.valid) {
      expect(
        r.errors.some((e) => e.includes('Chat Reply') && e.includes('Post-Task trigger')),
      ).toBe(true);
    }
  });

  it('chat_reply: empty messageTemplate is warning only with post_task_trigger', () => {
    const g = linearFlowGraph([
      { id: 't', blockType: 'post_task_trigger' },
      { id: 'cr', blockType: 'chat_reply', config: { messageTemplate: '   ' } },
    ]);
    const r = validateGraph(g, { mode: 'run' });
    expect(r.valid).toBe(true);
    if (r.valid) {
      expect(r.warnings?.some((w) => w.includes('message template'))).toBe(true);
    }
  });

  it('chat_reply: missing chatId source error plus empty messageTemplate warning together', () => {
    const g = linearFlowGraph([
      { id: 't', blockType: 'manual_trigger' },
      { id: 'cr', blockType: 'chat_reply', config: {} },
    ]);
    const r = validateGraph(g, { mode: 'run' });
    expect(r.valid).toBe(false);
    if (!r.valid) {
      expect(
        r.errors.some((e) => e.includes('Chat Reply') && e.includes('Post-Task trigger')),
      ).toBe(true);
      expect(r.warnings?.some((w) => w.includes('message template'))).toBe(true);
    }
  });

  it('chat_reply: valid on condition false branch with loop back when start_task is upstream', () => {
    const g = {
      nodes: [
        { id: 't', blockType: 'manual_trigger' },
        { id: 'st', blockType: 'start_task', config: { projectId: 'p1' } },
        { id: 'rc', blockType: 'run_command', config: { ...TEST_RUN_STEP } },
        {
          id: 'c',
          blockType: 'condition',
          config: {
            predicate: { field: 'exitCode', operator: 'eq', value: 0 },
          },
        },
        { id: 'cr', blockType: 'chat_reply', config: { messageTemplate: 'exit' } },
      ],
      edges: [
        { id: 'e1', source: 't', target: 'st' },
        { id: 'e2', source: 'st', target: 'rc' },
        { id: 'e3', source: 'rc', target: 'c' },
        { id: 'e4', source: 'c', target: 'rc', sourceHandle: 'true' },
        { id: 'e5', source: 'c', target: 'cr', sourceHandle: 'false' },
      ],
    };
    const r = validateGraph(g, { mode: 'run' });
    expect(r.valid).toBe(true);
  });

  it('chat_reply: rejects condition loop false branch when no start_task upstream (cycle-safe walk)', () => {
    const g = {
      nodes: [
        { id: 't', blockType: 'manual_trigger' },
        { id: 'rc', blockType: 'run_command', config: { ...TEST_RUN_STEP } },
        {
          id: 'c',
          blockType: 'condition',
          config: {
            predicate: { field: 'exitCode', operator: 'eq', value: 0 },
          },
        },
        { id: 'cr', blockType: 'chat_reply', config: { messageTemplate: 'fail' } },
      ],
      edges: [
        { id: 'e1', source: 't', target: 'rc' },
        { id: 'e2', source: 'rc', target: 'c' },
        { id: 'e3', source: 'c', target: 'rc', sourceHandle: 'true' },
        { id: 'e4', source: 'c', target: 'cr', sourceHandle: 'false' },
      ],
    };
    const r = validateGraph(g, { mode: 'run' });
    expect(r.valid).toBe(false);
    if (!r.valid) {
      expect(
        r.errors.some((e) => e.includes('Chat Reply') && e.includes('Post-Task trigger')),
      ).toBe(true);
    }
  });

  it('agent: requires instructions (with upstream start_task)', () => {
    const g = linearFlowGraph([
      { id: 't', blockType: 'manual_trigger' },
      { id: 'st', blockType: 'start_task', config: { projectId: 'p1' } },
      { id: 'a', blockType: 'agent', config: {} },
    ]);
    const r = validateGraph(g, { mode: 'run' });
    expect(r.valid).toBe(false);
    if (!r.valid) {
      expect(r.errors.some((e) => e.includes('instructions'))).toBe(true);
    }
  });

  it('agent: valid with instructions and upstream start_task', () => {
    const g = linearFlowGraph([
      { id: 't', blockType: 'manual_trigger' },
      { id: 'st', blockType: 'start_task', config: { projectId: 'p1' } },
      { id: 'a', blockType: 'agent', config: { instructions: 'do it' } },
    ]);
    const r = validateGraph(g, { mode: 'run' });
    expect(r.valid).toBe(true);
  });

  it('run_command: requires non-empty command', () => {
    const g = linearFlowGraph([
      { id: 't', blockType: 'manual_trigger' },
      { id: 'rc', blockType: 'run_command', config: { projectId: 'p1' } },
    ]);
    const r = validateGraph(g as unknown as Parameters<typeof validateGraph>[0], { mode: 'run' });
    expect(r.valid).toBe(false);
    if (!r.valid) {
      expect(r.errors.some((e) => e.includes('command'))).toBe(true);
    }
  });

  describe('fan_out', () => {
    it('accepts fan_out with exactly one outgoing edge', () => {
      const g = {
        nodes: [
          { id: 't', blockType: 'manual_trigger' },
          { id: 'f', blockType: 'fan_out', label: 'Fan Out' },
          { id: 'a', blockType: 'run_command', parentId: 'f', config: { ...TEST_RUN_STEP } },
          { id: 'done', blockType: 'end' },
        ],
        edges: [
          { id: 'e1', source: 't', target: 'f' },
          { id: 'e2', source: 'f', target: 'a' },
          { id: 'e3', source: 'a', target: 'done' },
        ],
      };
      const r = validateGraph(g);
      expect(r.valid).toBe(true);
    });

    it('rejects fan_out with no outgoing edge', () => {
      const g = {
        nodes: [
          { id: 't', blockType: 'manual_trigger' },
          { id: 'f', blockType: 'fan_out', label: 'Fan Out' },
        ],
        edges: [{ id: 'e1', source: 't', target: 'f' }],
      };
      const r = validateGraph(g, { mode: 'run' });
      expect(r.valid).toBe(false);
      if (!r.valid) {
        expect(r.errors.some((e) => e.includes('no body members'))).toBe(true);
      }
    });

    it('accepts fan_out branches that share one continuation', () => {
      const g = {
        nodes: [
          { id: 't', blockType: 'manual_trigger' },
          { id: 'f', blockType: 'fan_out', label: 'Fan Out' },
          { id: 'a', blockType: 'run_command', parentId: 'f', config: { ...TEST_RUN_STEP } },
          { id: 'b', blockType: 'run_command', parentId: 'f', config: { ...TEST_RUN_STEP } },
          { id: 'done', blockType: 'end' },
        ],
        edges: [
          { id: 'e1', source: 't', target: 'f' },
          { id: 'e2', source: 'f', target: 'a' },
          { id: 'e3', source: 'f', target: 'b' },
          { id: 'e4', source: 'a', target: 'done' },
          { id: 'e5', source: 'b', target: 'done' },
        ],
      };
      const r = validateGraph(g, { mode: 'run' });
      expect(r.valid).toBe(true);
    });

    it('allows an incomplete tail on save but rejects it on run', () => {
      const g = {
        nodes: [
          { id: 't', blockType: 'manual_trigger' },
          { id: 'f', blockType: 'fan_out' },
          { id: 'a', blockType: 'run_command', parentId: 'f', config: { ...TEST_RUN_STEP } },
        ],
        edges: [
          { id: 'e1', source: 't', target: 'f' },
          { id: 'e2', source: 'f', target: 'a' },
        ],
      };
      const save = validateGraph(g);
      expect(save.valid).toBe(true);
      expect(save.warnings?.some((warning) => warning.includes('continuation'))).toBe(true);
      expect(validateGraph(g, { mode: 'run' }).valid).toBe(false);
    });
  });
});

describe('flowGraphsEqual', () => {
  const base: FlowGraph = {
    nodes: [
      { id: 't', blockType: 'manual_trigger', position: { x: 0, y: 0 } },
      { id: 'a', blockType: 'agent', config: { instructions: 'do it' }, position: { x: 0, y: 1 } },
    ],
    edges: [{ id: 'e1', source: 't', target: 'a' }],
  };

  it('treats key order as irrelevant', () => {
    const reordered: FlowGraph = {
      edges: [{ target: 'a', id: 'e1', source: 't' }],
      nodes: [
        { position: { y: 0, x: 0 }, blockType: 'manual_trigger', id: 't' },
        {
          config: { instructions: 'do it' },
          position: { y: 1, x: 0 },
          id: 'a',
          blockType: 'agent',
        },
      ],
    };
    expect(flowGraphsEqual(base, reordered)).toBe(true);
  });

  it('treats `undefined` value and absent key as equal', () => {
    const withUndefined: FlowGraph = {
      nodes: [
        { id: 't', blockType: 'manual_trigger', position: { x: 0, y: 0 }, label: undefined },
        {
          id: 'a',
          blockType: 'agent',
          config: { instructions: 'do it' },
          position: { x: 0, y: 1 },
        },
      ],
      edges: [{ id: 'e1', source: 't', target: 'a' }],
    };
    expect(flowGraphsEqual(base, withUndefined)).toBe(true);
  });

  it('is array-order-sensitive (reordered edges differ)', () => {
    const twoEdges: FlowGraph = {
      ...base,
      edges: [
        { id: 'e1', source: 't', target: 'a' },
        { id: 'e2', source: 'a', target: 't' },
      ],
    };
    const swapped: FlowGraph = {
      ...base,
      edges: [
        { id: 'e2', source: 'a', target: 't' },
        { id: 'e1', source: 't', target: 'a' },
      ],
    };
    expect(flowGraphsEqual(twoEdges, swapped)).toBe(false);
  });

  it('detects nested config changes', () => {
    const changed: FlowGraph = {
      ...base,
      nodes: [
        base.nodes[0],
        {
          id: 'a',
          blockType: 'agent',
          config: { instructions: 'something else' },
          position: { x: 0, y: 1 },
        },
      ],
    };
    expect(flowGraphsEqual(base, changed)).toBe(false);
  });

  it('detects a node position change (drag-to-reposition is a real edit)', () => {
    const moved: FlowGraph = {
      ...base,
      nodes: [base.nodes[0], { ...base.nodes[1], position: { x: 500, y: 250 } }],
    };
    expect(flowGraphsEqual(base, moved)).toBe(false);
  });

  it('detects a settings change', () => {
    const withSettings: FlowGraph = { ...base, settings: { defaultModel: 'claude-sonnet-4-5' } };
    const changedSettings: FlowGraph = { ...base, settings: { defaultModel: 'claude-opus-4-1' } };
    expect(flowGraphsEqual(withSettings, changedSettings)).toBe(false);
    expect(flowGraphsEqual(withSettings, withSettings)).toBe(true);
  });

  it('treats settings array (batchTriggerSchema) order as significant', () => {
    const a: FlowGraph = {
      ...base,
      settings: {
        batchTriggerSchema: [
          { key: 'one', type: 'string' },
          { key: 'two', type: 'string' },
        ],
      },
    };
    const reorderedArray: FlowGraph = {
      ...base,
      settings: {
        batchTriggerSchema: [
          { key: 'two', type: 'string' },
          { key: 'one', type: 'string' },
        ],
      },
    };
    expect(flowGraphsEqual(a, reorderedArray)).toBe(false);
  });
});

describe('validateGraph webhook trigger event id', () => {
  function webhookGraph(eventType: string) {
    return linearFlowGraph([
      {
        id: 't',
        blockType: 'webhook_trigger',
        label: 'W',
        config: { integrationId: 'i', eventType },
      },
      { id: 'a', blockType: 'run_command', config: { ...TEST_RUN_STEP } },
    ]);
  }

  it('warns when the bound event is gone from the provider catalog', () => {
    const r = validateGraph(webhookGraph('story_deleted'), { webhookProvider: 'shortcut' });
    expect(r.valid).toBe(true);
    expect(r.warnings).toContain(
      "Trigger event 'story_deleted' no longer exists for Shortcut — pick an event",
    );
  });

  it('stays silent for an event the provider still publishes', () => {
    const r = validateGraph(webhookGraph('story_assigned'), { webhookProvider: 'shortcut' });
    expect(r.warnings ?? []).toEqual([]);
  });

  it('stays silent when the caller could not resolve the provider', () => {
    expect(validateGraph(webhookGraph('story_deleted')).warnings ?? []).toEqual([]);
  });
});
