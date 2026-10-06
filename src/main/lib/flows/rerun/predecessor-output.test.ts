import { describe, expect, it } from 'vitest';
import type { NodeOutput } from '../../../../shared/types/flow';
import { iterationOutput } from '../fan-out';
import type { ParsedFlowGraph } from '../graph';
import { type ReplayRow, reconstructPreviousOutput } from './predecessor-output';

// t → prep → fan → [a] | [b1 → b2] → after
const GRAPH: ParsedFlowGraph = {
  nodes: [
    { id: 't', blockType: 'manual_trigger' },
    { id: 'prep', blockType: 'run_command' },
    { id: 'fan', blockType: 'fan_out' },
    { id: 'a', blockType: 'agent', parentId: 'fan' },
    { id: 'b1', blockType: 'agent', parentId: 'fan' },
    { id: 'b2', blockType: 'agent', parentId: 'fan' },
    { id: 'after', blockType: 'run_command' },
  ],
  edges: [
    { id: 'e0', source: 't', target: 'prep' },
    { id: 'e1', source: 'prep', target: 'fan' },
    { id: 'e2', source: 'fan', target: 'a' },
    { id: 'e3', source: 'fan', target: 'b1' },
    { id: 'e4', source: 'b1', target: 'b2' },
    { id: 'e5', source: 'a', target: 'after' },
    { id: 'e6', source: 'b2', target: 'after' },
  ],
};

const out = (outputs: NodeOutput['outputs']): NodeOutput => ({
  status: 'completed',
  outputs,
  artifacts: [],
  durationMs: 0,
});

function run(
  id: string,
  nodeId: string,
  status: ReplayRow['status'],
  overrides: Partial<ReplayRow> = {},
): ReplayRow {
  return {
    id,
    nodeId,
    status,
    laneIndex: null,
    parentFanOutNodeRunId: null,
    nodeOutput: null,
    ...overrides,
  };
}

const lane = (laneIndex: number) => ({ laneIndex, parentFanOutNodeRunId: 'fan-run' });
const STATE = { items: ['i0', 'i1', 'i2'], totalCount: 3, arrayField: 'items' };
const FAN_OUTPUT = iterationOutput(STATE, 0);

describe('reconstructPreviousOutput', () => {
  it('hands the node after the trigger the trigger outputs', () => {
    const trigger = out({ summary: 'from trigger' });
    const runs = [
      run('t1', 't', 'completed', { nodeOutput: trigger }),
      run('p1', 'prep', 'failed'),
    ];
    expect(
      reconstructPreviousOutput({
        graph: GRAPH,
        nodeRuns: runs,
        nodeId: 'prep',
        beforeNodeRunId: 'p1',
      }),
    ).toEqual(trigger);
  });

  it('returns undefined when no predecessor ever ran', () => {
    expect(
      reconstructPreviousOutput({
        graph: GRAPH,
        nodeRuns: [run('p1', 'prep', 'failed')],
        nodeId: 'prep',
      }),
    ).toBeUndefined();
  });

  it('uses the newest finished predecessor attempt created before the anchor', () => {
    const runs = [
      run('p-old', 'prep', 'superseded', { nodeOutput: out({ v: 'stale' }) }),
      run('p-1', 'prep', 'completed', { nodeOutput: out({ v: 'used' }) }),
      run('f-1', 'fan', 'failed'),
      run('p-2', 'prep', 'completed', { nodeOutput: out({ v: 'after the anchor' }) }),
    ];
    expect(
      reconstructPreviousOutput({
        graph: GRAPH,
        nodeRuns: runs,
        nodeId: 'fan',
        beforeNodeRunId: 'f-1',
      }),
    ).toEqual(out({ v: 'used' }));
  });

  it('takes the condition branch that actually ran into a merge node', () => {
    const graph: ParsedFlowGraph = {
      nodes: [
        { id: 'cond', blockType: 'condition' },
        { id: 'yes', blockType: 'agent' },
        { id: 'no', blockType: 'agent' },
        { id: 'merge', blockType: 'run_command' },
      ],
      edges: [
        { id: 'e1', source: 'cond', target: 'yes', sourceHandle: 'true' },
        { id: 'e2', source: 'cond', target: 'no', sourceHandle: 'false' },
        { id: 'e3', source: 'yes', target: 'merge' },
        { id: 'e4', source: 'no', target: 'merge' },
      ],
    };
    const runs = [
      run('c1', 'cond', 'completed'),
      run('n1', 'no', 'completed', { nodeOutput: out({ branch: 'no' }) }),
      run('m1', 'merge', 'failed'),
    ];
    expect(reconstructPreviousOutput({ graph, nodeRuns: runs, nodeId: 'merge' })).toEqual(
      out({ branch: 'no' }),
    );
  });

  it('reads a body member predecessor from its own Fan Out item only', () => {
    const runs = [
      run('b1-l1', 'b1', 'completed', { ...lane(1), nodeOutput: out({ item: 1 }) }),
      run('b1-l2', 'b1', 'completed', { ...lane(2), nodeOutput: out({ item: 2 }) }),
      run('b2-l2', 'b2', 'failed', lane(2)),
    ];
    expect(
      reconstructPreviousOutput({ graph: GRAPH, nodeRuns: runs, nodeId: 'b2', scope: lane(2) }),
    ).toEqual(out({ item: 2 }));
  });

  it("hands a body root its own item's iteration output", () => {
    const runs = [run('fan-run', 'fan', 'completed', { nodeOutput: FAN_OUTPUT })];
    expect(
      reconstructPreviousOutput({
        graph: GRAPH,
        nodeRuns: runs,
        nodeId: 'a',
        scope: lane(2),
        fanOutState: STATE,
      }),
    ).toEqual(iterationOutput(STATE, 2));
  });

  it('keeps the truncation marker a capped Fan Out handed its body roots', () => {
    const capped = { ...STATE, truncated: true, originalCount: 120 };
    const rebuilt = reconstructPreviousOutput({
      graph: GRAPH,
      nodeRuns: [],
      nodeId: 'b1',
      scope: lane(1),
      fanOutState: capped,
    });
    expect(rebuilt?.outputs).toMatchObject({
      currentItem: 'i1',
      truncated: true,
      originalCount: 120,
    });
  });

  it("falls back to the fan_out's own output for item 0 without live state", () => {
    const runs = [run('fan-run', 'fan', 'completed', { nodeOutput: FAN_OUTPUT })];
    expect(
      reconstructPreviousOutput({ graph: GRAPH, nodeRuns: runs, nodeId: 'a', scope: lane(0) }),
    ).toEqual(FAN_OUTPUT);
    expect(
      reconstructPreviousOutput({ graph: GRAPH, nodeRuns: runs, nodeId: 'a', scope: lane(1) }),
    ).toBeUndefined();
  });

  it('rebuilds the aggregate a finished Fan Out handed its continuation', () => {
    const tails = [0, 1, 2].flatMap((i) => [
      run(`a-${i}`, 'a', 'completed', { ...lane(i), nodeOutput: out({ a: i }) }),
      run(`b2-${i}`, 'b2', 'completed', { ...lane(i), nodeOutput: out({ b: i }) }),
    ]);
    const runs = [
      run('fan-run', 'fan', 'completed', { nodeOutput: FAN_OUTPUT }),
      ...tails,
      run('after-1', 'after', 'failed'),
    ];
    expect(
      reconstructPreviousOutput({
        graph: GRAPH,
        nodeRuns: runs,
        nodeId: 'after',
        beforeNodeRunId: 'after-1',
      }),
    ).toEqual(
      out({
        results: [0, 1, 2].map((i) => ({ a: { a: i }, b1: { b: i } })),
        totalCount: 3,
        _fanOutState: 'completed',
      }),
    );
  });

  it('refuses a short aggregate when an item never finished', () => {
    const runs = [
      run('fan-run', 'fan', 'completed', { nodeOutput: FAN_OUTPUT }),
      run('a-0', 'a', 'completed', { ...lane(0), nodeOutput: out({}) }),
      run('b2-0', 'b2', 'completed', { ...lane(0), nodeOutput: out({}) }),
    ];
    expect(
      reconstructPreviousOutput({ graph: GRAPH, nodeRuns: runs, nodeId: 'after' }),
    ).toBeUndefined();
  });

  it("hands the continuation an empty Fan Out's own completed output", () => {
    const empty = out({
      results: [],
      totalCount: 0,
      _fanOutState: 'completed',
      arrayField: 'items',
    });
    const runs = [run('fan-run', 'fan', 'completed', { nodeOutput: empty })];
    expect(reconstructPreviousOutput({ graph: GRAPH, nodeRuns: runs, nodeId: 'after' })).toEqual(
      empty,
    );
  });

  it("never mixes an earlier Fan Out run's items into a re-run's aggregate", () => {
    const firstRun = [0, 1, 2].flatMap((i) => [
      run(`a-${i}`, 'a', 'completed', { ...lane(i), nodeOutput: out({ a: 'old' }) }),
      run(`b2-${i}`, 'b2', 'completed', { ...lane(i), nodeOutput: out({ b: 'old' }) }),
    ]);
    const rerun = { parentFanOutNodeRunId: 'fan-run-2' };
    const runs = [
      run('fan-run', 'fan', 'completed', { nodeOutput: FAN_OUTPUT }),
      ...firstRun,
      run('fan-run-2', 'fan', 'completed', { nodeOutput: FAN_OUTPUT }),
      run('a-new', 'a', 'completed', { laneIndex: 0, ...rerun, nodeOutput: out({ a: 'new' }) }),
      run('b2-new', 'b2', 'completed', { laneIndex: 0, ...rerun, nodeOutput: out({ b: 'new' }) }),
    ];
    // The re-run finished only item 0, so the old run's complete items must not stand in.
    expect(
      reconstructPreviousOutput({ graph: GRAPH, nodeRuns: runs, nodeId: 'after' }),
    ).toBeUndefined();
  });
});
