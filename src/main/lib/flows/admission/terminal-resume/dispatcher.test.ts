import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  db: null as unknown,
  dispatchAndAdvance: vi.fn(async (..._args: unknown[]) => {}),
  requestTerminalFlowResume: vi.fn(async () => ({ created: true })),
  registered: null as null | ((intent: unknown, ticket: number) => Promise<void>),
}));

vi.mock('../../../db', async (orig) => ({
  ...(await orig<typeof import('../../../db')>()),
  getDatabase: () => mocks.db,
}));
vi.mock('../../advance', async (orig) => ({
  ...(await orig<typeof import('../../advance')>()),
  dispatchAndAdvance: mocks.dispatchAndAdvance,
}));
// Bare mock on purpose: importing the real runtime would boot the admission controller.
// dispatcher.ts imports exactly these two names.
vi.mock('../runtime', () => ({
  registerTerminalFlowResumeDispatcher: (
    fn: (intent: unknown, ticket: number) => Promise<void>,
  ) => {
    mocks.registered = fn;
  },
  requestTerminalFlowResume: mocks.requestTerminalFlowResume,
}));
vi.mock('../../event-emit', async (orig) => ({
  ...(await orig<typeof import('../../event-emit')>()),
  emitRunStarted: vi.fn(),
}));

import type { FlowGraph } from '../../../../../shared/lib/validate-flow-graph';
import { createNodeRun } from '../../../db/repos/node-runs';
import { seedActiveAdmission, seedFlowRun } from '../../../db/test-utils/flow-fixtures';
import { freshDb, type TestDb } from '../../../db/test-utils/fresh-db';
import { retryTerminalFlowRun } from './dispatcher';

const GRAPH: FlowGraph = {
  nodes: [
    { id: 'st', blockType: 'start_task', position: { x: 0, y: 0 } },
    { id: 'work', blockType: 'agent', position: { x: 0, y: 1 } },
  ],
  edges: [{ id: 'e1', source: 'st', target: 'work' }],
};

let db: TestDb;
let flowRunId: string;
let nodeRunId: string;
let ticket: number;

beforeEach(async () => {
  vi.clearAllMocks();
  db = freshDb();
  mocks.db = db;
  ({ flowRunId } = await seedFlowRun(db, GRAPH));
  const nodeRun = await createNodeRun(db, {
    flowRunId,
    nodeId: 'work',
    blockType: 'agent',
    status: 'failed',
  });
  nodeRunId = nodeRun.id;
  ticket = seedActiveAdmission(db, flowRunId);
});

describe('retryTerminalFlowRun', () => {
  it('mints a continuation resume intent (the user-Retry surface)', async () => {
    await expect(retryTerminalFlowRun(db, flowRunId)).resolves.toBe(true);
    expect(mocks.requestTerminalFlowResume).toHaveBeenCalledWith({
      flowRunId,
      nodeRunId,
      continuation: true,
    });
  });
});

describe('dispatchAdmittedTerminalResume (registered dispatcher)', () => {
  function intent(continuation?: true) {
    return {
      version: 1,
      action: 'resume',
      flow_run_id: flowRunId,
      node_run_id: nodeRunId,
      ...(continuation ? { continuation } : {}),
    };
  }

  it("forwards a continuation intent as resumeKind 'continuation'", async () => {
    await mocks.registered?.(intent(true), ticket);
    expect(mocks.dispatchAndAdvance).toHaveBeenCalledOnce();
    expect(mocks.dispatchAndAdvance.mock.calls[0][0]).toEqual({ flowRunId, ticket });
    expect(mocks.dispatchAndAdvance.mock.calls[0][5]).toEqual({ resumeKind: 'continuation' });
  });

  it("forwards a plain intent (flows.rerunRun — the honest re-run surfaces) as resumeKind 'redispatch'", async () => {
    await mocks.registered?.(intent(), ticket);
    expect(mocks.dispatchAndAdvance).toHaveBeenCalledOnce();
    expect(mocks.dispatchAndAdvance.mock.calls[0][5]).toEqual({ resumeKind: 'redispatch' });
  });

  it('forwards the persisted Fan Out branch scope', async () => {
    const parent = await createNodeRun(db, {
      flowRunId,
      nodeId: 'fan',
      blockType: 'fan_out',
      status: 'completed',
    });
    const { nodeRuns } = await import('../../../db/schema');
    const { eq } = await import('drizzle-orm');
    await db
      .update(nodeRuns)
      .set({ laneIndex: 3, parentFanOutNodeRunId: parent.id })
      .where(eq(nodeRuns.id, nodeRunId));

    await mocks.registered?.(intent(), ticket);

    expect(mocks.dispatchAndAdvance.mock.calls[0][5]).toEqual({
      resumeKind: 'redispatch',
      laneIndex: 3,
      parentFanOutNodeRunId: parent.id,
    });
  });

  it('returns quietly for a run a Cancel took after promotion, before any dispatch', async () => {
    const { flowRuns } = await import('../../../db/schema');
    const { eq } = await import('drizzle-orm');
    await db.update(flowRuns).set({ status: 'cancelled' }).where(eq(flowRuns.id, flowRunId));

    await expect(mocks.registered?.(intent(true), ticket)).resolves.toBeUndefined();
    expect(mocks.dispatchAndAdvance).not.toHaveBeenCalled();
  });

  it('returns quietly once a Cancel and a Retry replaced its promoted ticket', async () => {
    const { flowRunAdmissions } = await import('../../../db/schema');
    const { eq } = await import('drizzle-orm');
    await db
      .update(flowRunAdmissions)
      .set({ state: 'released', settledAt: new Date() })
      .where(eq(flowRunAdmissions.ticket, ticket));
    seedActiveAdmission(db, flowRunId);

    await expect(mocks.registered?.(intent(true), ticket)).resolves.toBeUndefined();
    expect(mocks.dispatchAndAdvance).not.toHaveBeenCalled();
  });
});

describe('Fan Out branch failure — the resume re-dispatches the whole item (sc-716)', () => {
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

  async function seedFailedItem(order: 'failed-first' | 'failed-last') {
    db = freshDb();
    mocks.db = db;
    ({ flowRunId } = await seedFlowRun(db, FAN_GRAPH));
    ticket = seedActiveAdmission(db, flowRunId);
    const fan = await createNodeRun(db, {
      flowRunId,
      nodeId: 'fan',
      blockType: 'fan_out',
      status: 'completed',
    });
    const lane = { laneIndex: 0, parentFanOutNodeRunId: fan.id };
    const failed = () =>
      createNodeRun(db, {
        flowRunId,
        nodeId: 'a',
        blockType: 'agent',
        status: 'failed',
        nodeOutput: {
          status: 'failed',
          outputs: {},
          artifacts: [],
          durationMs: 0,
          error: { message: 'boom' },
        },
        ...lane,
      });
    // The sibling the failure's run-terminal sweep cancelled: no error of its own.
    const swept = () =>
      createNodeRun(db, {
        flowRunId,
        nodeId: 'b',
        blockType: 'agent',
        status: 'cancelled',
        ...lane,
      });
    const failedRun = order === 'failed-first' ? await failed() : (await swept(), await failed());
    if (order === 'failed-first') await swept();
    return { failedRun, fanRunId: fan.id };
  }

  it('waits for every branch dispatch before surfacing one that threw', async () => {
    const { failedRun } = await seedFailedItem('failed-first');
    let siblingSettled = false;
    mocks.dispatchAndAdvance.mockImplementation(async (...args: unknown[]) => {
      if ((args[1] as { id: string }).id === 'a') throw new Error('anchor dispatch blew up');
      await new Promise((resolve) => setTimeout(resolve, 10));
      siblingSettled = true;
    });

    try {
      await expect(
        mocks.registered?.(
          { version: 1, action: 'resume', flow_run_id: flowRunId, node_run_id: failedRun.id },
          ticket,
        ),
      ).rejects.toThrow('anchor dispatch blew up');
      expect(siblingSettled).toBe(true);
    } finally {
      mocks.dispatchAndAdvance.mockImplementation(async () => {});
    }
  });

  it.each(['failed-first', 'failed-last'] as const)(
    'anchors Retry on the failed branch and re-dispatches the swept sibling too (%s)',
    async (order) => {
      const { failedRun, fanRunId } = await seedFailedItem(order);

      await expect(retryTerminalFlowRun(db, flowRunId)).resolves.toBe(true);
      expect(mocks.requestTerminalFlowResume).toHaveBeenCalledWith({
        flowRunId,
        nodeRunId: failedRun.id,
        continuation: true,
      });

      await mocks.registered?.(
        {
          version: 1,
          action: 'resume',
          flow_run_id: flowRunId,
          node_run_id: failedRun.id,
          continuation: true,
        },
        ticket,
      );

      const calls = mocks.dispatchAndAdvance.mock.calls.map((call) => ({
        nodeId: (call[1] as { id: string }).id,
        options: call[5],
      }));
      const scope = { laneIndex: 0, parentFanOutNodeRunId: fanRunId };
      expect(calls).toEqual([
        { nodeId: 'a', options: { resumeKind: 'continuation', ...scope } },
        { nodeId: 'b', options: { resumeKind: 'redispatch', ...scope } },
      ]);
    },
  );
});
