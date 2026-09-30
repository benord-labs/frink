import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  db: null as unknown,
  dispatchAndAdvance: vi.fn(async (..._args: unknown[]) => {}),
  requestTerminalFlowResume: vi.fn(async () => ({ created: true })),
  registered: null as null | ((intent: unknown) => Promise<void>),
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
  registerTerminalFlowResumeDispatcher: (fn: (intent: unknown) => Promise<void>) => {
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
import { seedFlowRun } from '../../../db/test-utils/flow-fixtures';
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
    await mocks.registered?.(intent(true));
    expect(mocks.dispatchAndAdvance).toHaveBeenCalledOnce();
    expect(mocks.dispatchAndAdvance.mock.calls[0][5]).toEqual({ resumeKind: 'continuation' });
  });

  it("forwards a plain intent (flows.rerunRun — the honest re-run surfaces) as resumeKind 'redispatch'", async () => {
    await mocks.registered?.(intent());
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

    await mocks.registered?.(intent());

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

    await expect(mocks.registered?.(intent(true))).resolves.toBeUndefined();
    expect(mocks.dispatchAndAdvance).not.toHaveBeenCalled();
  });
});
