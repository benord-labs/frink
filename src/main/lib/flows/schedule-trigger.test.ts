import { describe, expect, it, vi } from 'vitest';
import { createFlowVersion } from '../db/repos/flow-versions';
import { copyFlow, createFlow, updateFlow } from '../db/repos/flows';
import { flowRuns } from '../db/schema';
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
        automatic: true,
      }),
    );
  });

  it('runs a duplicated schedule flow once it is turned on, and stops when it is turned off', async () => {
    const db = freshDb();
    await createFlow(db, { id: 'source', name: 'Every minute' });
    await createFlowVersion(db, {
      flowId: 'source',
      graph: graphOf([
        { id: 'tick', blockType: 'schedule_trigger', config: { cronExpression: '* * * * *' } },
      ]),
    });
    const startRun = vi.fn<typeof startFlowRun>();
    const minute = (n: number) => new Date(Date.UTC(2026, 10, 18, 7, n));
    await runScheduledTriggerTick(minute(0), { db, startRun });

    const { id: copyId } = await copyFlow(db, { sourceFlowId: 'source' });
    await updateFlow(db, copyId, { isEnabled: true });
    await runScheduledTriggerTick(minute(1), { db, startRun });

    const copyRuns = () => startRun.mock.calls.filter(([input]) => input.flowId === copyId);
    expect(copyRuns()).toHaveLength(1);

    await updateFlow(db, copyId, { isEnabled: false });
    await runScheduledTriggerTick(minute(2), { db, startRun });

    expect(copyRuns()).toHaveLength(1);
  });

  it('adds no run while one waits for Start, even when the schedule does not skip busy Flows', async () => {
    const db = freshDb();
    await createFlow(db, { id: 'flow-1', name: 'Nightly check' });
    const version = await createFlowVersion(db, {
      flowId: 'flow-1',
      graph: {
        ...graphOf([
          { id: 'tick', blockType: 'schedule_trigger', config: { cronExpression: '* * * * *' } },
        ]),
        settings: { askBeforeRunning: true },
      },
    });
    await db.insert(flowRuns).values({ flowVersionId: version.id, status: 'running' });
    const startRun = vi.fn<typeof startFlowRun>();
    const now = new Date('2026-10-17T07:00:00Z');

    expect((await runScheduledTriggerTick(now, { db, startRun })).fired).toBe(1);
    await db.insert(flowRuns).values({ flowVersionId: version.id, heldAt: now });
    const nextMinute = new Date(now.getTime() + 60_000);
    expect((await runScheduledTriggerTick(nextMinute, { db, startRun })).fired).toBe(0);
  });
});
