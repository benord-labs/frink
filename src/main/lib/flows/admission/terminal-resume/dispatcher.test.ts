import { TRPCError } from '@trpc/server';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  db: null as unknown,
  dispatchAndAdvance: vi.fn(async (..._args: unknown[]) => {}),
  requestTerminalFlowResume: vi.fn(async (_input: EnqueueTerminalFlowResumeInput) => ({
    created: true,
  })),
  stageResumeBehindHeldAdmission: vi.fn(async (_input: EnqueueTerminalFlowResumeInput) => false),
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
// dispatcher.ts imports exactly these names.
vi.mock('../runtime', () => ({
  registerTerminalFlowResumeDispatcher: (
    fn: (intent: unknown, ticket: number) => Promise<void>,
  ) => {
    mocks.registered = fn;
  },
  requestTerminalFlowResume: mocks.requestTerminalFlowResume,
  stageResumeBehindHeldAdmission: mocks.stageResumeBehindHeldAdmission,
}));
vi.mock('../../event-emit', async (orig) => ({
  ...(await orig<typeof import('../../event-emit')>()),
  emitRunStarted: vi.fn(),
}));

import type { FlowGraph } from '../../../../../shared/lib/validate-flow-graph';
import { RESTART_INTERRUPTION_REASON } from '../../../../../shared/types/flow';
import { setFlowRunStatus } from '../../../db/repos/flow-runs';
import { createNodeRun, setNodeRunStatus } from '../../../db/repos/node-runs';
import { abandonRestartInterruption } from '../../../db/repos/task-parking/abandon-marker';
import { chats, subChatMessages, subChats, tasks } from '../../../db/schema';
import { seedActiveAdmission, seedFlowRun } from '../../../db/test-utils/flow-fixtures';
import { freshDb, type TestDb } from '../../../db/test-utils/fresh-db';
import { retryTerminalFlowRun } from './dispatcher';
import { type EnqueueTerminalFlowResumeInput, TerminalResumeAdmissionError } from './resume-store';

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

/** The request the latest retry enqueued, with the gate its enqueue transaction runs. */
function lastEnqueued() {
  const request = mocks.requestTerminalFlowResume.mock.lastCall?.[0];
  if (!request?.admit) throw new Error('No terminal resume was enqueued with an admit gate');
  return { ...request, admit: request.admit };
}

/** A task that drove `stepId` in sub-1, its prompt sent and, when `answered`, replied to. */
async function seedStepTask(stepId: string, answered: boolean): Promise<void> {
  if ((await db.select().from(subChats)).length === 0) {
    await db.insert(chats).values({ id: 'chat-1', name: 'chat' });
    await db.insert(subChats).values({ id: 'sub-1', chatId: 'chat-1', sessionId: 'sess-1' });
  }
  const id = `task-${stepId}`;
  await db.insert(tasks).values({
    id,
    description: id,
    source: 'flow',
    status: 'failed',
    result: { subChatId: 'sub-1' },
    flowRunId,
    sourceId: stepId,
    nodeRunId: stepId,
  });
  const prompt = { id: `u-${id}`, role: 'user', parts: [], metadata: { dispatchTaskId: id } };
  const reply = { id: `a-${id}`, role: 'assistant', parts: [] };
  const seq = (await db.select().from(subChatMessages)).length;
  for (const [i, message] of (answered ? [prompt, reply] : [prompt]).entries()) {
    await db
      .insert(subChatMessages)
      .values({ subChatId: 'sub-1', seq: seq + i, message: JSON.stringify(message) });
  }
}

/** The run as a restart leaves it: `cancelled`, its unfinished step carrying the restart marker. */
async function interruptByRestart(): Promise<void> {
  await setNodeRunStatus(db, nodeRunId, 'cancelled', {
    completedAt: new Date(),
    nodeOutput: {
      status: 'cancelled',
      outputs: {},
      artifacts: [],
      durationMs: 0,
      error: { message: RESTART_INTERRUPTION_REASON, retryable: true },
    },
  });
  await setFlowRunStatus(db, flowRunId, 'cancelled');
}

describe('retryTerminalFlowRun', () => {
  it('re-admits a failed run, refusing it in the enqueue once a concurrent Cancel took it', async () => {
    await setFlowRunStatus(db, flowRunId, 'failed');
    await expect(retryTerminalFlowRun(db, flowRunId, 'retry')).resolves.toBe(true);
    const request = lastEnqueued();
    expect(request).toMatchObject({ flowRunId, nodeRunId });
    expect(request.admit(db)).toBe(true);
    await setFlowRunStatus(db, flowRunId, 'cancelled');
    expect(request.admit(db)).toBe(false);
  });

  it('anchors a completed run to its last step attempt', async () => {
    await setNodeRunStatus(db, nodeRunId, 'completed', { completedAt: new Date() });
    await setFlowRunStatus(db, flowRunId, 'completed');
    await expect(retryTerminalFlowRun(db, flowRunId, 'retry')).resolves.toBe(true);
    expect(lastEnqueued()).toMatchObject({ flowRunId, nodeRunId });
  });

  it('admits a restart-interrupted run only while the enqueue still sees its marker', async () => {
    await interruptByRestart();
    await expect(retryTerminalFlowRun(db, flowRunId, 'retry')).resolves.toBe(true);
    const { admit } = lastEnqueued();
    expect(admit(db)).toBe(true);
    abandonRestartInterruption(db, flowRunId);
    expect(admit(db)).toBe(false);
  });

  // The enqueue transaction re-checks the label the user clicked before any admission is written.
  it('refuses in the enqueue a step that no longer recovers as the clicked kind', async () => {
    await setFlowRunStatus(db, flowRunId, 'failed');
    await expect(retryTerminalFlowRun(db, flowRunId, 'continue')).resolves.toBe(true);
    const { admit, kind } = lastEnqueued();
    expect(kind).toBe('continue');
    expect(() => admit(db)).toThrow(
      expect.objectContaining({
        code: 'PRECONDITION_FAILED',
        message: expect.stringMatching(/refresh/),
      }),
    );
  });

  // A run still holding its slot would refuse a second live admission; the click is staged behind
  // it with the same gate instead, and nothing is enqueued now.
  it('stages behind a held admission instead of enqueueing', async () => {
    await interruptByRestart();
    mocks.stageResumeBehindHeldAdmission.mockResolvedValueOnce(true);
    await expect(retryTerminalFlowRun(db, flowRunId, 'retry')).resolves.toBe(true);
    expect(mocks.requestTerminalFlowResume).not.toHaveBeenCalled();
    const staged = mocks.stageResumeBehindHeldAdmission.mock.lastCall?.[0];
    expect(staged).toMatchObject({ flowRunId, nodeRunId, kind: 'retry' });
    expect(staged?.admit?.(db)).toBe(true);
    // The staged click keeps the enqueue's gate: a Work Queue Cancel before the settle wins.
    abandonRestartInterruption(db, flowRunId);
    expect(staged?.admit?.(db)).toBe(false);
  });

  // A held slot that kept a cleanup error refuses the click while staging; that refusal must reach
  // the user as-is, never fall through to a direct enqueue into the still-held slot.
  it('passes a staging refusal through without enqueueing', async () => {
    await interruptByRestart();
    const refused = new TRPCError({ code: 'PRECONDITION_FAILED', message: 'failed cleanup' });
    mocks.stageResumeBehindHeldAdmission.mockRejectedValueOnce(refused);
    await expect(retryTerminalFlowRun(db, flowRunId, 'retry')).rejects.toBe(refused);
    expect(mocks.requestTerminalFlowResume).not.toHaveBeenCalled();
  });

  it('refuses a run the user cancelled (no restart marker) before enqueueing', async () => {
    await setFlowRunStatus(db, flowRunId, 'cancelled');
    await expect(retryTerminalFlowRun(db, flowRunId, 'retry')).rejects.toMatchObject({
      code: 'PRECONDITION_FAILED',
      message: expect.stringMatching(/cancelled by the user/i),
    });
    expect(mocks.requestTerminalFlowResume).not.toHaveBeenCalled();
  });

  it('reports a Work Queue Cancel that cleared the marker during the enqueue as the user cancelling', async () => {
    await interruptByRestart();
    const declined = new TerminalResumeAdmissionError('Flow resume admission cancelled');
    mocks.requestTerminalFlowResume.mockImplementationOnce(async () => {
      abandonRestartInterruption(db, flowRunId);
      throw declined;
    });
    await expect(retryTerminalFlowRun(db, flowRunId, 'retry')).rejects.toMatchObject({
      code: 'PRECONDITION_FAILED',
      cause: declined,
    });
  });

  it('passes an admission failure through while the run is still interrupted', async () => {
    await interruptByRestart();
    const failed = new TerminalResumeAdmissionError('Flow resume admission failed');
    mocks.requestTerminalFlowResume.mockRejectedValueOnce(failed);
    await expect(retryTerminalFlowRun(db, flowRunId, 'retry')).rejects.toBe(failed);
  });
});

describe('dispatchAdmittedTerminalResume (registered dispatcher)', () => {
  const intent = () => ({
    version: 1,
    action: 'resume',
    flow_run_id: flowRunId,
    node_run_id: nodeRunId,
  });

  it('continues an anchor its session answered, and re-runs one no session answered', async () => {
    await mocks.registered?.(intent(), ticket);
    expect(mocks.dispatchAndAdvance).toHaveBeenCalledOnce();
    expect(mocks.dispatchAndAdvance.mock.calls[0][0]).toEqual({ flowRunId, ticket });
    expect(mocks.dispatchAndAdvance.mock.calls[0][5]).toEqual({ resumeKind: undefined });

    await seedStepTask(nodeRunId, true);
    await mocks.registered?.(intent(), ticket);
    expect(mocks.dispatchAndAdvance.mock.calls[1][5]).toEqual({ resumeKind: 'continuation' });
  });

  // The session answered the node's first attempt; the second's prompt was sent but never answered.
  it('re-runs a fresh attempt of a node an earlier attempt got answered', async () => {
    await seedStepTask(nodeRunId, true);
    const second = await createNodeRun(db, {
      flowRunId,
      nodeId: 'work',
      blockType: 'agent',
      status: 'failed',
    });
    await seedStepTask(second.id, false);

    await mocks.registered?.({ ...intent(), node_run_id: second.id }, ticket);

    expect(mocks.dispatchAndAdvance.mock.calls[0][5]).toEqual({ resumeKind: undefined });
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
      resumeKind: undefined,
      laneIndex: 3,
      parentFanOutNodeRunId: parent.id,
    });
  });

  it('returns quietly for a run a Cancel took after promotion, before any dispatch', async () => {
    const { flowRuns } = await import('../../../db/schema');
    const { eq } = await import('drizzle-orm');
    await db.update(flowRuns).set({ status: 'cancelled' }).where(eq(flowRuns.id, flowRunId));

    await expect(mocks.registered?.(intent(), ticket)).resolves.toBeUndefined();
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

    await expect(mocks.registered?.(intent(), ticket)).resolves.toBeUndefined();
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

      await expect(retryTerminalFlowRun(db, flowRunId, 'retry')).resolves.toBe(true);
      expect(mocks.requestTerminalFlowResume).toHaveBeenCalledWith({
        flowRunId,
        nodeRunId: failedRun.id,
        kind: 'retry',
        admit: expect.any(Function),
      });

      await mocks.registered?.(
        { version: 1, action: 'resume', flow_run_id: flowRunId, node_run_id: failedRun.id },
        ticket,
      );

      const calls = mocks.dispatchAndAdvance.mock.calls.map((call) => ({
        nodeId: (call[1] as { id: string }).id,
        options: call[5],
      }));
      const scope = { laneIndex: 0, parentFanOutNodeRunId: fanRunId };
      expect(calls).toEqual([
        { nodeId: 'a', options: { resumeKind: undefined, ...scope } },
        { nodeId: 'b', options: { resumeKind: 'continuation', ...scope } },
      ]);
    },
  );
});
