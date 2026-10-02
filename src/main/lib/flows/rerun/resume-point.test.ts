import { describe, expect, it } from 'vitest';
import type { NodeRun } from '../../db/schema';
import type { ParsedFlowGraph } from '../graph';
import { lastUnfinishedNodeRun, resolveRerunStartNode } from './resume-point';

/** Minimal NodeRun for the pure resume-point helper — only `status`/`nodeId` are read. */
function nr(nodeId: string, status: NodeRun['status']): NodeRun {
  return { nodeId, status } as unknown as NodeRun;
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

  it('skips an attempt a retry superseded once its replacement finished', () => {
    expect(
      lastUnfinishedNodeRun([nr('a', 'superseded'), nr('a', 'completed'), nr('b', 'completed')]),
    ).toBeUndefined();
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
