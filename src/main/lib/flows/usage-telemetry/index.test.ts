import { eq } from 'drizzle-orm';
import { afterEach, beforeEach, describe, expect, it, type Mock, vi } from 'vitest';
import type { trackFlowRunCompleted } from '../../analytics';
import { type FlowGraph, normalizeFlowGraph } from '../../../../shared/lib/validate-flow-graph';
import type { FlowExecutionEvent } from '../../../../shared/types/flow';
import { createFlowVersion } from '../../db/repos/flow-versions';
import { createFlow } from '../../db/repos/flows';
import * as database from '../../db';
import { flowRuns } from '../../db/schema';
import { seedFlowRun } from '../../db/test-utils/flow-fixtures';
import { freshDb, type TestDb } from '../../db/test-utils/fresh-db';
import { loadRunContext } from '../advance-walk/run-context';
import { emitRunTerminal } from '../event-emit';
import { flowEventBus } from '../events';
import { countFlowSteps, flowTriggerKind, startFlowRunTelemetry } from './index';

let db: TestDb;
vi.spyOn(database, 'getDatabase').mockImplementation(() => db);

const graphWith = (triggerType: string): FlowGraph => ({
  nodes: [
    { id: 't', blockType: triggerType, position: { x: 0, y: 0 } },
    { id: 'a', blockType: 'agent', position: { x: 0, y: 1 } },
    { id: 'b', blockType: 'run_command', position: { x: 0, y: 2 } },
  ],
  edges: [],
});

const emit = (event: Partial<FlowExecutionEvent>) =>
  // SAFETY: each test supplies the eventType and ids its case needs; the rest are defaults
  flowEventBus.emitFlowEvent({
    flowName: 'Secret name',
    runStatus: 'completed',
    ...event,
  } as FlowExecutionEvent);

describe('flowTriggerKind / countFlowSteps', () => {
  it('names how a Flow starts, without the block suffix', () => {
    expect(flowTriggerKind(graphWith('manual_trigger'))).toBe('manual');
    expect(flowTriggerKind(graphWith('schedule_trigger'))).toBe('schedule');
    expect(flowTriggerKind(graphWith('webhook_trigger'))).toBe('webhook');
    expect(flowTriggerKind(graphWith('post_task_trigger'))).toBe('post_task');
    expect(flowTriggerKind(graphWith('agent'))).toBe('none');
    expect(flowTriggerKind(null)).toBe('none');
    expect(flowTriggerKind(normalizeFlowGraph('not a graph'))).toBe('none');
  });

  it('counts the steps a Flow has, leaving out its trigger', () => {
    expect(countFlowSteps(graphWith('manual_trigger'))).toBe(2);
    expect(countFlowSteps(null)).toBe(0);
  });
});

describe('startFlowRunTelemetry', () => {
  let track: Mock<typeof trackFlowRunCompleted>;
  let stop: () => void;

  beforeEach(() => {
    db = freshDb();
    track = vi.fn<typeof trackFlowRunCompleted>();
    stop = startFlowRunTelemetry(db, track);
  });

  afterEach(() => stop());

  it('counts a run once, however often it re-terminalizes', async () => {
    const { flowId, flowRunId } = await seedFlowRun(db, graphWith('manual_trigger'));
    const otherFlow = await createFlow(db, { name: 'G' });
    const otherVersion = await createFlowVersion(db, {
      flowId: otherFlow.id,
      graph: graphWith('webhook_trigger'),
    });
    const [otherRun] = await db
      .insert(flowRuns)
      .values({ flowVersionId: otherVersion.id, status: 'cancelled' })
      .returning();
    const other = { flowId: otherFlow.id, flowRunId: otherRun.id };

    emit({ eventType: 'run_failed', flowId, flowRunId, runStatus: 'failed', summary: 'boom' });
    emit({ eventType: 'run_completed', flowId, flowRunId });
    emit({ eventType: 'run_cancelled', flowId: other.flowId, flowRunId: other.flowRunId });

    await vi.waitFor(() => expect(track).toHaveBeenCalledTimes(2));
    expect(track.mock.calls).toEqual([
      [{ flowId, outcome: 'failed', stepCount: 2, batchSize: 1 }],
      [{ flowId: other.flowId, outcome: 'cancelled', stepCount: 2, batchSize: 1 }],
    ]);
  });

  it('counts a batch once, in place of its member runs', async () => {
    const { flowId, flowRunId, versionId } = await seedFlowRun(db, graphWith('manual_trigger'));
    db.update(flowRuns).set({ batchId: 'batch-1' }).where(eq(flowRuns.id, flowRunId)).run();
    db.insert(flowRuns)
      .values({ flowVersionId: versionId, status: 'completed', batchId: 'batch-1' })
      .run();

    emit({ eventType: 'run_completed', flowId, flowRunId, batchId: 'batch-1' });
    emit({ eventType: 'batch_completed', flowId, batchId: 'batch-1', runStatus: 'failed' });
    emit({ eventType: 'batch_completed', flowId, batchId: 'batch-1' });

    await vi.waitFor(() => expect(track).toHaveBeenCalled());
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(track.mock.calls).toEqual([[{ flowId, outcome: 'failed', stepCount: 2, batchSize: 2 }]]);
  });

  // The engine, not this module, marks batch members: a run context that dropped batchId would
  // count every item of a batch as its own run.
  it('skips a batch member as the engine reports it, and counts a standalone run', async () => {
    const member = await seedFlowRun(db, graphWith('manual_trigger'));
    db.update(flowRuns).set({ batchId: 'batch-1' }).where(eq(flowRuns.id, member.flowRunId)).run();
    const [standalone] = await db
      .insert(flowRuns)
      .values({ flowVersionId: member.versionId, status: 'completed' })
      .returning();

    for (const flowRunId of [member.flowRunId, standalone.id]) {
      const ctx = await loadRunContext(flowRunId);
      if (ctx) emitRunTerminal(ctx.meta, flowRunId, 'completed');
    }

    await vi.waitFor(() => expect(track).toHaveBeenCalled());
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(track.mock.calls).toEqual([
      [{ flowId: member.flowId, outcome: 'completed', stepCount: 2, batchSize: 1 }],
    ]);
  });

  it('ignores events that are not a run or batch ending', async () => {
    const { flowId, flowRunId } = await seedFlowRun(db, graphWith('manual_trigger'));

    emit({ eventType: 'run_started', flowId, flowRunId, runStatus: 'running' });
    emit({ eventType: 'node_completed', flowId, flowRunId, runStatus: 'running' });
    await new Promise((resolve) => setTimeout(resolve, 20));

    expect(track).not.toHaveBeenCalled();
  });
});
