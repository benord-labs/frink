import { describe, expect, it } from 'vitest';
import type { NodeRun } from '../../db/schema';
import type { ParsedFlowGraph } from '../graph';
import { siblingBranchResumeTargets } from './fan-out-lane-resume';

// fan → [a] | [b1 → b2] | [c] → after
const GRAPH: ParsedFlowGraph = {
  nodes: [
    { id: 'fan', blockType: 'fan_out' },
    { id: 'a', blockType: 'agent', parentId: 'fan' },
    { id: 'b1', blockType: 'agent', parentId: 'fan' },
    { id: 'b2', blockType: 'agent', parentId: 'fan' },
    { id: 'c', blockType: 'agent', parentId: 'fan' },
    { id: 'after', blockType: 'agent' },
  ],
  edges: [
    { id: 'e1', source: 'fan', target: 'a' },
    { id: 'e2', source: 'fan', target: 'b1' },
    { id: 'e3', source: 'b1', target: 'b2' },
    { id: 'e4', source: 'fan', target: 'c' },
    { id: 'e5', source: 'a', target: 'after' },
    { id: 'e6', source: 'b2', target: 'after' },
    { id: 'e7', source: 'c', target: 'after' },
  ],
};

function laneRun(
  id: string,
  nodeId: string,
  status: NodeRun['status'],
  overrides: Partial<NodeRun> = {},
): NodeRun {
  return {
    id,
    nodeId,
    status,
    laneIndex: 2,
    parentFanOutNodeRunId: 'fan-run',
    nodeOutput: null,
    ...overrides,
  } as unknown as NodeRun;
}

const targetIds = (runs: NodeRun[], anchor: NodeRun) =>
  siblingBranchResumeTargets(GRAPH, runs, anchor).map((target) => target.node.id);

describe('siblingBranchResumeTargets', () => {
  it('returns nothing for an anchor outside a Fan Out lane', () => {
    const anchor = laneRun('x', 'after', 'failed', {
      laneIndex: null,
      parentFanOutNodeRunId: null,
    });
    expect(siblingBranchResumeTargets(GRAPH, [anchor], anchor)).toEqual([]);
  });

  it('re-dispatches a swept sibling node and skips the anchor branch', () => {
    const anchor = laneRun('a1', 'a', 'failed');
    const runs = [anchor, laneRun('b1-1', 'b1', 'cancelled'), laneRun('c1', 'c', 'cancelled')];
    expect(targetIds(runs, anchor)).toEqual(['b1', 'c']);
  });

  it('leaves a branch whose tail already completed', () => {
    const anchor = laneRun('a1', 'a', 'failed');
    const runs = [
      laneRun('b1-1', 'b1', 'completed'),
      laneRun('b2-1', 'b2', 'completed'),
      anchor,
      laneRun('c1', 'c', 'completed'),
    ];
    expect(targetIds(runs, anchor)).toEqual([]);
  });

  it('continues a branch at its next node, carrying the completed output', () => {
    const anchor = laneRun('a1', 'a', 'failed');
    const output = { status: 'completed', outputs: { x: 1 }, artifacts: [], durationMs: 0 };
    const runs = [
      laneRun('b1-1', 'b1', 'completed', { nodeOutput: output }),
      anchor,
      laneRun('c1', 'c', 'completed'),
    ];
    expect(siblingBranchResumeTargets(GRAPH, runs, anchor)).toEqual([
      { node: expect.objectContaining({ id: 'b2' }), previousOutput: output },
    ]);
  });

  it('dispatches the root of a branch that never started', () => {
    const anchor = laneRun('a1', 'a', 'failed');
    expect(targetIds([anchor, laneRun('c1', 'c', 'completed')], anchor)).toEqual(['b1']);
  });

  it('only reads the anchor lane — other items and older attempts do not count', () => {
    const anchor = laneRun('a1', 'a', 'failed');
    const runs = [
      laneRun('c-old', 'c', 'completed', { laneIndex: 1 }),
      laneRun('b1-old', 'b1', 'completed', { laneIndex: 1 }),
      laneRun('b2-old', 'b2', 'completed', { laneIndex: 1 }),
      laneRun('c-1', 'c', 'cancelled'),
      laneRun('c-2', 'c', 'completed'),
      anchor,
      laneRun('b1-1', 'b1', 'cancelled'),
    ];
    expect(targetIds(runs, anchor)).toEqual(['b1']);
  });

  it('hands a stopped or never-started sibling what its first dispatch received (sc-2762)', () => {
    const anchor = laneRun('a1', 'a', 'failed');
    const b1Output = { status: 'completed', outputs: { y: 2 }, artifacts: [], durationMs: 0 };
    const state = { items: ['i0', 'i1', 'i2'], totalCount: 3, arrayField: 'items' };
    const runs = [
      laneRun('b1-1', 'b1', 'completed', { nodeOutput: b1Output }),
      laneRun('b2-1', 'b2', 'cancelled'),
      anchor,
    ];
    expect(siblingBranchResumeTargets(GRAPH, runs, anchor, state)).toEqual([
      { node: expect.objectContaining({ id: 'b2' }), previousOutput: b1Output },
      {
        node: expect.objectContaining({ id: 'c' }),
        previousOutput: expect.objectContaining({
          outputs: expect.objectContaining({ currentItem: 'i2', currentIndex: 2 }),
        }),
      },
    ]);
  });
});
