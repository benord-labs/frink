// Flow activation counts for the analytics client; see user-docs/telemetry.md for what is sent.

import { count, eq } from 'drizzle-orm';
import log from 'electron-log';
import { isTriggerBlockType } from '../../../../shared/lib/block-registry';
import { type FlowGraph, normalizeFlowGraph } from '../../../../shared/lib/validate-flow-graph';
import type { FlowExecutionEvent } from '../../../../shared/types/flow';
import { type FlowTriggerKind, trackFlowRunCompleted } from '../../analytics';
import { getDatabase } from '../../db';
import { getEarliestRunForBatch, getFlowRun } from '../../db/repos/flow-runs';
import { getVersion } from '../../db/repos/flow-versions';
import { flowRuns } from '../../db/schema';
import { subscribeFlowEvents } from '../events';

type Db = ReturnType<typeof getDatabase>;
type Outcome = Parameters<typeof trackFlowRunCompleted>[0]['outcome'];

function runOutcome(eventType: FlowExecutionEvent['eventType']): Outcome | null {
  switch (eventType) {
    case 'run_completed':
      return 'completed';
    case 'run_failed':
      return 'failed';
    case 'run_cancelled':
      return 'cancelled';
    default:
      return null;
  }
}

export function flowTriggerKind(graph: FlowGraph | null): FlowTriggerKind {
  const trigger = graph?.nodes.find((node) => isTriggerBlockType(node.blockType));
  // SAFETY: every registered trigger block type is `<kind>_trigger`
  return trigger ? (trigger.blockType.replace(/_trigger$/, '') as FlowTriggerKind) : 'none';
}

export function countFlowSteps(graph: FlowGraph | null): number {
  return graph?.nodes.filter((node) => !isTriggerBlockType(node.blockType)).length ?? 0;
}

async function stepsForRun(db: Db, flowRunId: string | undefined): Promise<number> {
  const run = flowRunId ? await getFlowRun(db, flowRunId) : null;
  const version = run ? await getVersion(db, run.flowVersionId) : null;
  return countFlowSteps(version ? normalizeFlowGraph(version.graph) : null);
}

/**
 * Counts each run once, and a batch once in place of its member runs. A rerun re-terminalizes the
 * same run or batch, so the ids already counted this session are skipped. An id whose reads fail
 * is released, so a later terminal event can still count it.
 */
export function startFlowRunTelemetry(
  db: Db = getDatabase(),
  track: typeof trackFlowRunCompleted = trackFlowRunCompleted,
): () => void {
  const counted = new Set<string>();

  const readOrRelease = async <T>(id: string, read: () => Promise<T>): Promise<T> => {
    try {
      return await read();
    } catch (err) {
      counted.delete(id);
      throw err;
    }
  };

  const report = async (event: FlowExecutionEvent): Promise<void> => {
    const { flowRunId, batchId } = event;
    const outcome = runOutcome(event.eventType);
    if (outcome && flowRunId && !batchId && !counted.has(flowRunId)) {
      counted.add(flowRunId);
      const stepCount = await readOrRelease(flowRunId, () => stepsForRun(db, flowRunId));
      track({ flowId: event.flowId, outcome, stepCount, batchSize: 1 });
      return;
    }
    if (event.eventType !== 'batch_completed' || !batchId || counted.has(batchId)) {
      return;
    }
    counted.add(batchId);
    const { stepCount, batchSize } = await readOrRelease(batchId, async () => {
      const earliest = await getEarliestRunForBatch(db, batchId);
      const [members] = await db
        .select({ n: count() })
        .from(flowRuns)
        .where(eq(flowRuns.batchId, batchId));
      return { stepCount: await stepsForRun(db, earliest?.id), batchSize: members?.n ?? 0 };
    });
    track({
      flowId: event.flowId,
      outcome: event.runStatus === 'completed' ? 'completed' : 'failed',
      stepCount,
      batchSize,
    });
  };

  return subscribeFlowEvents((event) => {
    report(event).catch((err) => log.warn('[FlowTelemetry] count failed', err));
  });
}
