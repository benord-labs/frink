import { describe, expect, it, vi } from 'vitest';
import { createFlowVersion } from '../db/repos/flow-versions';
import { createFlow } from '../db/repos/flows';
import { freshDb } from '../db/test-utils/fresh-db';
import type { FlowGraphNode, ParsedFlowGraph } from './graph';
import { findScheduleTrigger, runScheduledTriggerTick } from './schedule-trigger';
import type { startFlowRun } from './start';

const graphOf = (nodes: FlowGraphNode[]): ParsedFlowGraph => ({ nodes, edges: [] });

describe('findScheduleTrigger', () => {
  it('finds a schedule trigger that an agent appended after the other steps', () => {
    const graph = graphOf([
      { id: 'step', blockType: 'agent' },
      { id: 'tick', blockType: 'schedule_trigger', config: { cronExpression: '0 7 * * 1-5' } },
    ]);
    expect(findScheduleTrigger(graph)?.id).toBe('tick');
  });

  it('ignores a flow that another trigger starts', () => {
    const graph = graphOf([
      { id: 'hook', blockType: 'webhook_trigger' },
      { id: 'step', blockType: 'agent' },
    ]);
    expect(findScheduleTrigger(graph)).toBeUndefined();
  });
});

describe('runScheduledTriggerTick', () => {
  it('starts an agent-built Flow whose schedule trigger is not the first node', async () => {
    const db = freshDb();
    await createFlow(db, { id: 'flow-1', name: 'Nightly check' });
    await createFlowVersion(db, {
      flowId: 'flow-1',
      graph: graphOf([
        { id: 'step', blockType: 'agent' },
        { id: 'tick', blockType: 'schedule_trigger', config: { cronExpression: '* * * * *' } },
      ]),
    });
    const startRun = vi.fn<typeof startFlowRun>();
    const now = new Date('2026-10-17T07:00:00Z');

    const result = await runScheduledTriggerTick(now, { db, startRun });

    expect(result.fired).toBe(1);
    expect(startRun).toHaveBeenCalledWith(
      expect.objectContaining({
        flowId: 'flow-1',
        idempotencyKey: `schedule:flow-1:${now.getTime()}`,
      }),
    );
  });
});
