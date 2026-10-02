import { eq } from 'drizzle-orm';
import { describe, expect, it } from 'vitest';
import type { FlowGraph } from '../../../../shared/lib/validate-flow-graph';
import { createNodeRun, getNodeRun } from '../../db/repos/node-runs';
import { flowRuns } from '../../db/schema';
import { seedActiveAdmission, seedFlowRun } from '../../db/test-utils/flow-fixtures';
import { freshDb } from '../../db/test-utils/fresh-db';
import { RESTART_INTERRUPTION_REASON } from '../../../../shared/types/flow';
import { isRestartInterrupted, unparkFailedRunCommand } from './unpark';

const FAILED_OUTPUT = {
  status: 'failed',
  outputs: {},
  artifacts: [],
  durationMs: 0,
  error: { message: 'boom', retryable: false },
};

const FAN_GRAPH: FlowGraph = {
  nodes: [
    { id: 'fan', blockType: 'fan_out', position: { x: 0, y: 0 } },
    { id: 'a', blockType: 'agent', parentId: 'fan', position: { x: 0, y: 1 } },
    { id: 'b', blockType: 'agent', parentId: 'fan', position: { x: 1, y: 1 } },
    { id: 'after', blockType: 'agent', position: { x: 0, y: 2 } },
  ],
  edges: [
    { id: 'e1', source: 'fan', target: 'a' },
    { id: 'e2', source: 'fan', target: 'b' },
    { id: 'e3', source: 'a', target: 'after' },
    { id: 'e4', source: 'b', target: 'after' },
  ],
};

async function seedFailedRun(graph: FlowGraph) {
  const db = freshDb();
  const { flowRunId } = await seedFlowRun(db, graph);
  seedActiveAdmission(db, flowRunId);
  await db.update(flowRuns).set({ status: 'failed' }).where(eq(flowRuns.id, flowRunId));
  return { db, flowRunId };
}

describe('unparkFailedRunCommand — Fan Out branch failures (sc-716)', () => {
  it('declines, writing nothing, while the failure left a sibling branch swept', async () => {
    const { db, flowRunId } = await seedFailedRun(FAN_GRAPH);
    const fan = await createNodeRun(db, {
      flowRunId,
      nodeId: 'fan',
      blockType: 'fan_out',
      status: 'completed',
    });
    const lane = { laneIndex: 0, parentFanOutNodeRunId: fan.id };
    // The swept sibling is OLDER, so the failed branch is the anchor an in-place un-park would revive.
    await createNodeRun(db, {
      flowRunId,
      nodeId: 'b',
      blockType: 'agent',
      status: 'cancelled',
      ...lane,
    });
    const failed = await createNodeRun(db, {
      flowRunId,
      nodeId: 'a',
      blockType: 'agent',
      status: 'failed',
      nodeOutput: FAILED_OUTPUT,
      ...lane,
    });

    expect(unparkFailedRunCommand(db, flowRunId)).toBeNull();
    expect((await getNodeRun(db, failed.id))?.status).toBe('failed');
  });

  it('still un-parks a failed branch whose siblings already finished', async () => {
    const { db, flowRunId } = await seedFailedRun(FAN_GRAPH);
    const fan = await createNodeRun(db, {
      flowRunId,
      nodeId: 'fan',
      blockType: 'fan_out',
      status: 'completed',
    });
    const lane = { laneIndex: 0, parentFanOutNodeRunId: fan.id };
    await createNodeRun(db, {
      flowRunId,
      nodeId: 'b',
      blockType: 'agent',
      status: 'completed',
      ...lane,
    });
    const failed = await createNodeRun(db, {
      flowRunId,
      nodeId: 'a',
      blockType: 'agent',
      status: 'failed',
      nodeOutput: FAILED_OUTPUT,
      ...lane,
    });

    expect(unparkFailedRunCommand(db, flowRunId)?.id).toBe(failed.id);
  });

  it('un-parks a failed linear node as before', async () => {
    const { db, flowRunId } = await seedFailedRun({
      nodes: [{ id: 'work', blockType: 'agent', position: { x: 0, y: 0 } }],
      edges: [],
    });
    const failed = await createNodeRun(db, {
      flowRunId,
      nodeId: 'work',
      blockType: 'agent',
      status: 'failed',
      nodeOutput: FAILED_OUTPUT,
    });

    expect(unparkFailedRunCommand(db, flowRunId)?.id).toBe(failed.id);
  });
});

describe('Fan Out runs that stopped mid-item (sc-716 edge cases)', () => {
  async function seedLane(runStatus: 'cancelled' | 'paused') {
    const { db, flowRunId } = await seedFailedRun(FAN_GRAPH);
    await db.update(flowRuns).set({ status: runStatus }).where(eq(flowRuns.id, flowRunId));
    const fan = await createNodeRun(db, {
      flowRunId,
      nodeId: 'fan',
      blockType: 'fan_out',
      status: 'completed',
    });
    return { db, flowRunId, lane: { laneIndex: 0, parentFanOutNodeRunId: fan.id } };
  }

  it('stays restart-interrupted when the watcher sweep cancelled a NEWER sibling without the marker', async () => {
    const { db, flowRunId, lane } = await seedLane('cancelled');
    await createNodeRun(db, {
      flowRunId,
      nodeId: 'a',
      blockType: 'agent',
      status: 'cancelled',
      nodeOutput: {
        status: 'cancelled',
        outputs: {},
        artifacts: [],
        durationMs: 0,
        error: { message: RESTART_INTERRUPTION_REASON, retryable: true },
      },
      ...lane,
    });
    await createNodeRun(db, {
      flowRunId,
      nodeId: 'b',
      blockType: 'agent',
      status: 'cancelled',
      ...lane,
    });

    expect(isRestartInterrupted(db, flowRunId)).toBe(true);
  });

  it('still un-parks a paused branch while its sibling is legitimately running', async () => {
    const { db, flowRunId, lane } = await seedLane('paused');
    await createNodeRun(db, {
      flowRunId,
      nodeId: 'b',
      blockType: 'agent',
      status: 'running',
      ...lane,
    });
    const parked = await createNodeRun(db, {
      flowRunId,
      nodeId: 'a',
      blockType: 'agent',
      status: 'awaiting_input',
      ...lane,
    });

    expect(unparkFailedRunCommand(db, flowRunId)?.id).toBe(parked.id);
  });
});
