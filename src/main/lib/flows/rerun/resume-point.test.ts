import { describe, expect, it } from 'vitest';
import { RESTART_INTERRUPTION_REASON } from '../../../../shared/types/flow';
import type { NodeRun } from '../../db/schema';
import type { ParsedFlowGraph } from '../graph';
import { lastUnfinishedNodeRun, resolveRerunStartNode } from './resume-point';

/** Minimal NodeRun for the pure resume-point helper — only `status`/`nodeId` are read. */
function nr(nodeId: string, status: NodeRun['status']): NodeRun {
  return { nodeId, status } as unknown as NodeRun;
}

/** A node_run inside a Fan Out lane, optionally carrying its own error output. */
function laneRun(
  id: string,
  nodeId: string,
  status: NodeRun['status'],
  errorMessage?: string,
  outputStatus: NodeRun['status'] = status,
): NodeRun {
  return {
    id,
    nodeId,
    status,
    laneIndex: 0,
    parentFanOutNodeRunId: 'fan-run',
    nodeOutput: errorMessage ? { status: outputStatus, error: { message: errorMessage } } : null,
  } as unknown as NodeRun;
}

const GRAPH: ParsedFlowGraph = {
  nodes: [
    { id: 'trigger', blockType: 'manual_trigger' },
    { id: 'setup', blockType: 'start_task' },
    { id: 'agent', blockType: 'agent' },
    { id: 'review', blockType: 'agent' },
  ],
  edges: [
    { id: 'e1', source: 'trigger', target: 'setup' },
    { id: 'e2', source: 'setup', target: 'agent' },
    { id: 'e3', source: 'agent', target: 'review' },
  ],
};

describe('lastUnfinishedNodeRun', () => {
  it('returns undefined for an empty run (boundary)', () => {
    expect(lastUnfinishedNodeRun([])).toBeUndefined();
  });

  it('returns undefined when every node completed or skipped', () => {
    expect(
      lastUnfinishedNodeRun([nr('a', 'completed'), nr('b', 'skipped'), nr('c', 'completed')]),
    ).toBeUndefined();
  });

  it('returns the LATEST unfinished node, not an earlier one', () => {
    // creation order; the helper reverses → the last non-completed/skipped wins.
    expect(
      lastUnfinishedNodeRun([nr('a', 'completed'), nr('b', 'failed'), nr('c', 'completed')])
        ?.nodeId,
    ).toBe('b');
  });

  it('picks the trailing failed node when it is last', () => {
    expect(
      lastUnfinishedNodeRun([nr('a', 'completed'), nr('b', 'completed'), nr('c', 'failed')])
        ?.nodeId,
    ).toBe('c');
  });

  it('treats awaiting_input / running as unfinished', () => {
    expect(lastUnfinishedNodeRun([nr('a', 'completed'), nr('b', 'awaiting_input')])?.nodeId).toBe(
      'b',
    );
  });
});

describe('lastUnfinishedNodeRun — sweep-cancelled siblings (sc-716)', () => {
  it('returns the failed branch, not the newer sibling the failure swept to cancelled', () => {
    const runs = [laneRun('a1', 'a', 'failed', 'boom'), laneRun('b1', 'b', 'cancelled')];
    expect(lastUnfinishedNodeRun(runs)?.id).toBe('a1');
  });

  it('returns the restart-marked row over a newer swept row', () => {
    const runs = [
      laneRun('a1', 'a', 'cancelled', RESTART_INTERRUPTION_REASON),
      laneRun('b1', 'b', 'cancelled'),
    ];
    expect(lastUnfinishedNodeRun(runs)?.id).toBe('a1');
  });

  it('treats a parked sibling the sweep cancelled as swept, not as the cause', () => {
    const runs = [
      laneRun('a1', 'a', 'failed', 'boom'),
      laneRun('b1', 'b', 'cancelled', 'needs approval', 'awaiting_input'),
    ];
    expect(lastUnfinishedNodeRun(runs)?.id).toBe('a1');
  });

  it("counts a user Stop's own cancelled output as a cause", () => {
    const stopped = {
      ...laneRun('b1', 'b', 'cancelled'),
      nodeOutput: { status: 'cancelled', outputs: {} },
    } as unknown as NodeRun;
    expect(lastUnfinishedNodeRun([laneRun('a1', 'a', 'cancelled'), stopped])?.id).toBe('b1');
  });

  it('ignores a failed attempt a later attempt of the same node superseded', () => {
    const runs = [
      laneRun('a1', 'a', 'failed', 'boom'),
      laneRun('b1', 'b', 'completed'),
      laneRun('a2', 'a', 'cancelled'),
    ];
    expect(lastUnfinishedNodeRun(runs)?.id).toBe('a2');
  });

  it('anchors a second failure on the latest attempt, not the first retry round', () => {
    const runs = [
      laneRun('a1', 'a', 'failed', 'boom'),
      laneRun('b1', 'b', 'cancelled'),
      laneRun('b2', 'b', 'cancelled'),
      laneRun('a2', 'a', 'failed', 'boom again'),
      laneRun('b3', 'b', 'cancelled'),
    ];
    expect(lastUnfinishedNodeRun(runs)?.id).toBe('a2');
  });

  it('falls back to the newest unfinished row when every row was swept (a user Cancel)', () => {
    const runs = [laneRun('a1', 'a', 'cancelled'), laneRun('b1', 'b', 'cancelled')];
    expect(lastUnfinishedNodeRun(runs)?.id).toBe('b1');
  });
});

describe('resolveRerunStartNode', () => {
  it('resumes from the last UNFINISHED node when one exists', () => {
    expect(resolveRerunStartNode(GRAPH, [nr('agent', 'completed'), nr('review', 'failed')])).toBe(
      'review',
    );
  });

  it('restarts from the first WORK node (after start_task) when every node completed', () => {
    expect(
      resolveRerunStartNode(GRAPH, [nr('agent', 'completed'), nr('review', 'completed')]),
    ).toBe('agent');
  });

  it('falls back to the node after the trigger when there is no start_task', () => {
    const graph: ParsedFlowGraph = {
      nodes: [
        { id: 'trigger', blockType: 'manual_trigger' },
        { id: 'work', blockType: 'agent' },
      ],
      edges: [{ id: 'e1', source: 'trigger', target: 'work' }],
    };
    expect(resolveRerunStartNode(graph, [nr('work', 'completed')])).toBe('work');
  });
});
