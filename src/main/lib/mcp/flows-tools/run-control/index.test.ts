import { eq } from 'drizzle-orm';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { getOrCreateFlowRunByIdempotencyKey } from '../../../db/repos/flow-runs';
import { chats, flowRuns, nodeRuns, subChatMessages, subChats, tasks } from '../../../db/schema';
import { seedFlowRun } from '../../../db/test-utils/flow-fixtures';
import { freshDb, type TestDb } from '../../../db/test-utils/fresh-db';

const mocks = vi.hoisted(() => ({
  db: null as unknown,
  recover: vi.fn(),
  executionReady: vi.fn(() => true),
  cancelWorkQueueTask: vi.fn(),
  cancelFlowRun: vi.fn(),
  sendMobileMessage: vi.fn(),
  hasQueuedResume: vi.fn(async () => false),
  stoppedRows: undefined as undefined | ((rows: unknown[]) => unknown[]),
}));

vi.mock('electron-log', () => ({ default: { warn: vi.fn(), error: vi.fn(), info: vi.fn() } }));
vi.mock('../../../db', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../../db')>()),
  getDatabase: () => mocks.db,
}));
vi.mock('../../../trpc/routers/tasks', () => ({
  tasksRouter: { createCaller: () => ({ recover: mocks.recover }) },
}));
vi.mock('../../../mobile/domain/context', () => ({ executionReady: mocks.executionReady }));
vi.mock('../../../tasks/cancel-work-queue-task', () => ({
  cancelWorkQueueTask: mocks.cancelWorkQueueTask,
}));
vi.mock('../../../flows/engine', () => ({ cancelFlowRun: mocks.cancelFlowRun }));
vi.mock('../../../mobile/domain/chat', () => ({ sendMobileMessage: mocks.sendMobileMessage }));
vi.mock('../../../trpc/routers/tasks-recovery', () => ({
  hasQueuedResume: mocks.hasQueuedResume,
}));
// Real recovery resolution, unless a test pins the row the Work Queue would show.
vi.mock('../../../trpc/routers/tasks-subchat', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../../trpc/routers/tasks-subchat')>();
  return {
    ...actual,
    withStoppedTaskRecoveries: async (db: never, rows: never[]) => {
      const resolved = await actual.withStoppedTaskRecoveries(db, rows);
      return mocks.stoppedRows ? mocks.stoppedRows(resolved) : resolved;
    },
  };
});

import { resetRunControlCount } from '../gating/session-call-limiters';
import { handleFlowsToolCall } from '../index';
import { handleCancelRun, handleContinueRun } from './index';

const GRAPH = { nodes: [{ id: 'agent', blockType: 'agent', config: { instructions: 'w' } }] };

let db: TestDb;
let runId: string;

/** A run paused on an agent step whose session answered and now waits for the user's reply. */
beforeEach(async () => {
  vi.clearAllMocks();
  mocks.stoppedRows = undefined;
  mocks.hasQueuedResume.mockResolvedValue(false);
  resetRunControlCount();
  mocks.executionReady.mockReturnValue(true);
  mocks.recover.mockResolvedValue({ ok: true, outcome: 'queued' });
  db = freshDb();
  mocks.db = db;
  ({ flowRunId: runId } = await seedFlowRun(db, { ...GRAPH, edges: [] }));
  await db.update(flowRuns).set({ status: 'paused' }).where(eq(flowRuns.id, runId));
  await db.insert(chats).values({ id: 'chat-1', name: 'Flow chat' });
  await db.insert(subChats).values({ id: 'sub-1', chatId: 'chat-1', sessionId: 'session-1' });
  await db.insert(nodeRuns).values({
    id: 'nr-1',
    flowRunId: runId,
    nodeId: 'agent',
    blockType: 'agent',
    status: 'awaiting_input',
  });
  await db.insert(tasks).values({
    id: 'task-1',
    description: 'Ship the PR',
    source: 'flow',
    status: 'needs_attention',
    flowRunId: runId,
    nodeRunId: 'nr-1',
    sourceId: 'nr-1',
    result: { subChatId: 'sub-1' },
  });
  const prompt = { id: 'u1', role: 'user', parts: [], metadata: { dispatchTaskId: 'task-1' } };
  await db.insert(subChatMessages).values([
    { subChatId: 'sub-1', seq: 0, message: JSON.stringify(prompt) },
    { subChatId: 'sub-1', seq: 1, message: JSON.stringify({ id: 'a1', role: 'assistant', parts: [] }) },
  ]);
});

const text = (result: { content: Array<{ text: string }> }) => result.content[0]?.text ?? '';

describe('frink_flows_continue_run', () => {
  const parkOnUsageLimit = () =>
    db
      .update(tasks)
      .set({ result: { subChatId: 'sub-1', usageLimit: true } })
      .where(eq(tasks.id, 'task-1'));

  it("runs the Work Queue's Carry on on the run's row and relays the outcome", async () => {
    await parkOnUsageLimit();
    const result = await handleContinueRun({ runId, nodeRunId: 'nr-1' }, {});
    expect(result.isError).toBe(false);
    expect(mocks.recover).toHaveBeenCalledWith({
      taskId: 'task-1',
      kind: 'continue',
      recoveryNodeRunId: undefined,
    });
    expect(JSON.parse(text(result))).toEqual({ runId, kind: 'continue', outcome: 'queued' });
  });

  it('asks for a message when the step waits for a reply', async () => {
    const result = await handleContinueRun({ runId }, {});
    expect(text(result)).toContain('waiting for a reply');
    expect(mocks.recover).not.toHaveBeenCalled();
  });

  it("sends the message as the reply typed in the step's chat, guarded on that step", async () => {
    const result = await handleContinueRun({ runId, message: 'devkit is fixed, ship again' }, {});
    expect(mocks.sendMobileMessage).toHaveBeenCalledWith(
      expect.objectContaining({ chatId: 'chat-1', subChatId: 'sub-1', text: 'devkit is fixed, ship again' }),
      { expectedFlowTaskId: 'task-1' },
    );
    expect(JSON.parse(text(result))).toEqual({ runId, outcome: 'replied' });
  });

  it('sends no reply into a step whose run has already failed', async () => {
    await db.update(flowRuns).set({ status: 'failed' }).where(eq(flowRuns.id, runId));
    const result = await handleContinueRun({ runId, message: 'go' }, {});
    expect(text(result)).toContain('not waiting for a reply');
    expect(mocks.sendMobileMessage).not.toHaveBeenCalled();
  });

  it.each([{}, { message: 'here' }])('leaves a secret request to its form (%o)', async (extra) => {
    const result_ = { subChatId: 'sub-1', agentSignal: { secretRequest: { name: 'TOKEN' } } };
    await db.update(tasks).set({ result: result_ }).where(eq(tasks.id, 'task-1'));
    const result = await handleContinueRun({ runId, ...extra }, {});
    expect(text(result)).toContain('waiting for a secret');
    expect(mocks.sendMobileMessage).not.toHaveBeenCalled();
    expect(mocks.recover).not.toHaveBeenCalled();
  });

  it('acts on the step the Work Queue shows, not an earlier finished one', async () => {
    await db.insert(tasks).values({
      id: 'task-0',
      description: 'Plan',
      source: 'flow',
      status: 'done',
      flowRunId: runId,
      createdAt: new Date(Date.now() - 60_000),
    });
    await handleContinueRun({ runId, message: 'go' }, {});
    expect(mocks.sendMobileMessage).toHaveBeenCalledWith(expect.anything(), {
      expectedFlowTaskId: 'task-1',
    });
  });

  /** A run that failed on a later step without a task: it recovers through that step. */
  const failedOnLaterStep = (confirmSideEffects: boolean) => {
    mocks.stoppedRows = (rows) =>
      rows.map((row) => ({
        ...(row as object),
        status: 'failed',
        effectiveStatus: 'failed',
        recoveryKind: 'retry',
        recoveryNodeRunId: 'nr-ship',
        confirmSideEffects,
      }));
  };

  it('retries a failed step pinned to it when the retry repeats nothing', async () => {
    failedOnLaterStep(false);
    const result = await handleContinueRun({ runId, nodeRunId: 'nr-ship' }, {});
    expect(mocks.recover).toHaveBeenCalledWith({
      taskId: 'task-1',
      kind: 'retry',
      recoveryNodeRunId: 'nr-ship',
    });
    expect(result.isError).toBe(false);
  });

  it('never retries a step that may repeat its side effects', async () => {
    failedOnLaterStep(true);
    const result = await handleContinueRun({ runId }, {});
    expect(text(result)).toContain('offers no Continue');
    expect(mocks.recover).not.toHaveBeenCalled();
  });

  it("refuses a held run's Start: it has no step yet", async () => {
    await db.delete(tasks);
    await db.update(flowRuns).set({ status: 'pending' }).where(eq(flowRuns.id, runId));
    const result = await handleContinueRun({ runId }, {});
    expect(text(result)).toContain('offers no Continue');
  });

  it('stops after 20 continue or cancel calls in one session, counted across both tools', async () => {
    await db.update(flowRuns).set({ status: 'completed' }).where(eq(flowRuns.id, runId));
    for (let i = 0; i < 10; i++) {
      await handleContinueRun({ runId }, { executionId: 'exec-1' });
      await handleCancelRun({ runId }, { executionId: 'exec-1' });
    }
    const result = await handleCancelRun({ runId }, { executionId: 'exec-1' });
    expect(text(result)).toContain('limit reached');
  });

  // A run parked at an Approval shows its earlier, finished step; a plan review is plan_ready.
  it.each(['done', 'plan_ready'])('refuses a row the Work Queue offers no Continue for (%s)', async (status) => {
    await db.update(tasks).set({ status }).where(eq(tasks.id, 'task-1'));
    const result = await handleContinueRun({ runId }, {});
    expect(result.isError).toBe(true);
    expect(text(result)).toContain('offers no Continue');
    expect(mocks.recover).not.toHaveBeenCalled();
  });

  it('refuses when the inspected step is no longer the one to continue', async () => {
    const result = await handleContinueRun({ runId, nodeRunId: 'nr-old' }, {});
    expect(text(result)).toContain('no longer the one');
    expect(mocks.recover).not.toHaveBeenCalled();
  });

  it('refuses while Frink has no window to run the step in', async () => {
    mocks.executionReady.mockReturnValue(false);
    const result = await handleContinueRun({ runId, message: 'go' }, {});
    expect(text(result)).toContain('no open window');
    expect(mocks.sendMobileMessage).not.toHaveBeenCalled();
  });

  it('reports a recover refusal as a tool error', async () => {
    await parkOnUsageLimit();
    mocks.recover.mockRejectedValue(new Error('This item changed'));
    const result = await handleContinueRun({ runId }, {});
    expect(result.isError).toBe(true);
    expect(text(result)).toContain('This item changed');
  });

  it("rewords the phone send path's refusal for an agent", async () => {
    const { MobileApiError } = await import('../../../mobile/domain/errors');
    mocks.sendMobileMessage.mockRejectedValue(
      new MobileApiError(409, 'This Flow step changed. Refresh the chat before replying.'),
    );
    const result = await handleContinueRun({ runId, message: 'go' }, {});
    expect(text(result)).toContain('Inspect the run again with frink_flows_get_run');
    expect(text(result)).not.toContain('Refresh the chat');
  });

  it('refuses an unknown run', async () => {
    const result = await handleContinueRun({ runId: 'missing' }, {});
    expect(text(result)).toContain('not found');
  });
});

describe('frink_flows_cancel_run', () => {
  it("cancels through the Work Queue's Cancel on the run's row", async () => {
    mocks.cancelWorkQueueTask.mockImplementation(async () => {
      await db.update(flowRuns).set({ status: 'cancelled' }).where(eq(flowRuns.id, runId));
      return { task: { id: 'task-1' } };
    });
    const result = await handleCancelRun({ runId }, {});
    expect(mocks.cancelWorkQueueTask).toHaveBeenCalledWith(db, 'task-1');
    expect(JSON.parse(text(result))).toEqual({ runId, status: 'cancelled' });
  });

  it('cancels a run with no task yet (held or undispatched) through the run itself', async () => {
    await db.delete(tasks);
    await db.update(flowRuns).set({ status: 'pending' }).where(eq(flowRuns.id, runId));
    await handleCancelRun({ runId }, {});
    expect(mocks.cancelFlowRun).toHaveBeenCalledWith(runId);
    expect(mocks.cancelWorkQueueTask).not.toHaveBeenCalled();
  });

  it("cancels a finished run's queued Retry, as the Work Queue's Cancel does", async () => {
    await db.update(flowRuns).set({ status: 'failed' }).where(eq(flowRuns.id, runId));
    mocks.hasQueuedResume.mockResolvedValue(true);
    mocks.cancelWorkQueueTask.mockResolvedValue({ task: { id: 'task-1' } });
    const result = await handleCancelRun({ runId }, {});
    expect(mocks.cancelWorkQueueTask).toHaveBeenCalledWith(db, 'task-1');
    expect(result.isError).toBe(false);
  });

  it('treats every live run of the calling chat as its own, not only the newest', async () => {
    const [{ id: versionId }] = await db.select({ id: flowRuns.flowVersionId }).from(flowRuns);
    const { run: newer } = await getOrCreateFlowRunByIdempotencyKey(db as never, {
      flowVersionId: versionId,
      status: 'running',
      triggerContext: null,
      idempotencyKey: 'k2',
      startedAt: new Date(),
    });
    await db.insert(tasks).values({
      id: 'task-2',
      description: 'Newer run in the same chat',
      source: 'flow',
      status: 'running',
      flowRunId: newer.id,
      result: { subChatId: 'sub-1' },
    });
    const result = await handleCancelRun({ runId }, { sessionId: 'sub-1' });
    expect(text(result)).toContain('your own run');
    expect(mocks.cancelWorkQueueTask).not.toHaveBeenCalled();
  });

  it('refuses a finished run', async () => {
    await db.update(flowRuns).set({ status: 'completed' }).where(eq(flowRuns.id, runId));
    const result = await handleCancelRun({ runId }, {});
    expect(text(result)).toContain('already finished');
    expect(mocks.cancelWorkQueueTask).not.toHaveBeenCalled();
  });

  it("refuses the calling chat's own run, with the chat passed through the tool dispatcher", async () => {
    await db.update(flowRuns).set({ status: 'running' }).where(eq(flowRuns.id, runId));
    await db.update(tasks).set({ status: 'in_progress' }).where(eq(tasks.id, 'task-1'));
    const result = (await handleFlowsToolCall('frink_flows_cancel_run', { runId }, 'exec-1', undefined, {
      sessionId: 'sub-1',
    }))!;
    expect(text(result)).toContain('your own run');
    expect(mocks.cancelWorkQueueTask).not.toHaveBeenCalled();
  });
});
