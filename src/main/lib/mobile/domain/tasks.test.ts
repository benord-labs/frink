import { eq } from 'drizzle-orm';
import { TRPCError } from '@trpc/server';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { RESTART_INTERRUPTION_REASON } from '../../../../shared/types/flow';
import { mobileRequestSchema } from '../../../../shared/types/remote/mobile';
import { setFlowRunStatus } from '../../db/repos/flow-runs';
import { chats, nodeRuns, subChats, type Task, tasks } from '../../db/schema';
import { seedFlowRun, seedFlowStep } from '../../db/test-utils/flow-fixtures';
import { freshDb, type TestDb } from '../../db/test-utils/fresh-db';

const fixture = vi.hoisted(() => ({
  db: null as unknown,
  complete: vi.fn(),
  ready: vi.fn(),
  carryOn: vi.fn(),
  recover: vi.fn(async () => {}),
  handleClaimed: vi.fn(async () => {}),
}));
vi.mock('./context', async () => ({
  MobileApiError: (await import('./errors')).MobileApiError,
  requireExecutionReady: fixture.ready,
  mobileCallers: { tasks: { complete: fixture.complete, recover: fixture.recover } },
}));
vi.mock('../../db', () => ({ getDatabase: () => fixture.db }));
vi.mock('../../flows/rerun', () => ({ carryOnFlowTask: fixture.carryOn }));
vi.mock('../../task-executor', () => ({ handleClaimedTask: fixture.handleClaimed }));
import { mobileTaskActions, runMobileTaskAction } from './tasks';

let db: TestDb;
beforeEach(() => {
  vi.clearAllMocks();
  db = freshDb();
  fixture.db = db;
});

const seed = (id: string, status: string, result: unknown = null) =>
  db.insert(tasks).values({ id, description: id, source: 'manual', status, result });
const task = (status: string, extra: Partial<Parameters<typeof mobileTaskActions>[0]> = {}) => ({
  status,
  flowRunId: null,
  result: null,
  linkedChatId: null,
  ...extra,
});

describe('mobile task actions', () => {
  it('uses the desktop row menu gates', () => {
    expect(mobileTaskActions(task('pending'))).toEqual(['startTask']);
    expect(mobileTaskActions(task('pending', { linkedChatId: 'chat' }))).toEqual([]);
    expect(mobileTaskActions(task('pending', { result: { chatId: 'chat' } }))).toEqual([]);
    expect(mobileTaskActions(task('failed'))).toEqual(['continueTask']);
    expect(mobileTaskActions(task('done'))).toEqual(['completeTask']);
    // A parked question waits for the user's answer, so only a usage-limit park can carry on.
    expect(mobileTaskActions(task('needs_attention'))).toEqual(['completeTask']);
    expect(mobileTaskActions(task('needs_attention', { result: { usageLimit: true } }))).toEqual([
      'continueTask',
      'completeTask',
    ]);
    expect(
      mobileTaskActions(task('failed', { result: { dispatchErrorCode: 'MISSING_PAT' } })),
    ).toEqual([]);
    for (const status of ['running', 'plan_ready', 'completed', 'cancelled', 'interrupted'])
      expect(mobileTaskActions(task(status))).toEqual([]);
    // A Flow's item starts through its run, and is accepted from the row.
    const flow = { flowRunId: 'run', result: { usageLimit: true } };
    expect(mobileTaskActions(task('pending', { flowRunId: 'run' }))).toEqual([]);
    expect(mobileTaskActions(task('needs_attention', flow))).toEqual(['completeTask']);
    expect(mobileTaskActions(task('done', flow))).toEqual(['completeTask']);
  });

  it('recovers a Flow row exactly when the desktop menu does', () => {
    const flow = (status: string, extra: Partial<Parameters<typeof mobileTaskActions>[0]> = {}) =>
      task(status, { flowRunId: 'run', ...extra });
    // Its run's stopped step decides, whatever the row's own task did.
    expect(mobileTaskActions(flow('done', { recoveryKind: 'retry' }), 'interrupted')).toEqual([
      'continueTask',
    ]);
    expect(mobileTaskActions(flow('completed', { recoveryKind: 'continue' }), 'failed')).toEqual([
      'continueTask',
    ]);
    // Nothing to recover, or a failure only fixing credentials on the computer clears.
    expect(mobileTaskActions(flow('failed'), 'failed')).toEqual([]);
    const blocked = {
      recoveryKind: 'retry',
      result: { dispatchErrorCode: 'MISSING_PAT' },
    } as const;
    expect(mobileTaskActions(flow('failed', blocked), 'failed')).toEqual([]);
    expect(mobileTaskActions(flow('running', { recoveryKind: 'retry' }), 'running')).toEqual([]);
  });

  it('offers a Retry that may repeat side effects only to a phone that confirms it', () => {
    const row = task('done', {
      flowRunId: 'run',
      recoveryKind: 'retry',
      confirmSideEffects: true,
    });
    expect(mobileTaskActions(row, 'failed')).toEqual([]);
    const confirms = { confirmsSideEffects: true };
    expect(mobileTaskActions(row, 'failed', confirms)).toEqual(['continueTask']);
    // A Continue resumes the session, so it never needs the ask.
    expect(mobileTaskActions({ ...row, recoveryKind: 'continue' }, 'failed')).toEqual([
      'continueTask',
    ]);
  });

  it('accepts only the named requests with an id', () => {
    const pinned = { type: 'continueTask', id: 'task', kind: 'retry', recoveryNodeRunId: 'step' };
    expect(mobileRequestSchema.safeParse(pinned).success).toBe(true);
    for (const type of ['completeTask', 'continueTask', 'startTask'])
      expect(mobileRequestSchema.safeParse({ type, id: 'task' }).success).toBe(true);
    expect(mobileRequestSchema.safeParse({ type: 'completeTask', id: '' }).success).toBe(false);
    expect(mobileRequestSchema.safeParse({ type: 'retryTask', id: 'task' }).success).toBe(false);
    for (const kind of ['continue', 'retry']) {
      const parsed = mobileRequestSchema.safeParse({ type: 'continueTask', id: 'task', kind });
      expect(parsed.success).toBe(true);
    }
    const unknown = { type: 'continueTask', id: 'task', kind: 'restart' };
    expect(mobileRequestSchema.safeParse(unknown).success).toBe(false);
  });

  it('marks a finished task complete, keeping its result', async () => {
    await seed('done', 'done', { chatId: 'chat', subChatId: 'sub' });
    await expect(runMobileTaskAction({ type: 'completeTask', id: 'done' })).resolves.toEqual({
      ok: true,
    });
    expect(fixture.complete).toHaveBeenCalledWith({
      taskId: 'done',
      result: { chatId: 'chat', subChatId: 'sub', summary: 'Marked complete from your phone' },
    });
  });

  it('refuses an action the task no longer offers, and a task that is gone', async () => {
    await seed('running', 'running');
    await expect(
      runMobileTaskAction({ type: 'completeTask', id: 'running' }),
    ).rejects.toMatchObject({ status: 409 });
    await expect(runMobileTaskAction({ type: 'startTask', id: 'missing' })).rejects.toMatchObject({
      status: 404,
    });
    expect(fixture.complete).not.toHaveBeenCalled();
  });

  it('carries on a failed task, and explains when there is no session to resume', async () => {
    await seed('failed', 'failed');
    fixture.carryOn.mockResolvedValueOnce({ ok: true, task: {} });
    await runMobileTaskAction({ type: 'continueTask', id: 'failed' });
    expect(fixture.ready).toHaveBeenCalled();
    expect(fixture.carryOn).toHaveBeenCalledWith(db, 'failed');

    fixture.carryOn.mockResolvedValueOnce({ ok: false, reason: 'no-session' });
    await expect(runMobileTaskAction({ type: 'continueTask', id: 'failed' })).rejects.toMatchObject(
      { status: 409, message: expect.stringContaining('can’t carry on where it stopped') },
    );

    fixture.carryOn.mockResolvedValueOnce({ ok: false, reason: 'chat-archived' });
    await expect(runMobileTaskAction({ type: 'continueTask', id: 'failed' })).rejects.toMatchObject(
      { status: 409, message: expect.stringContaining('chat is archived. Restore it') },
    );
  });

  it('retries a task that never started through desktop’s recover, not carry on', async () => {
    await seed('failed', 'failed');
    const retry = { type: 'continueTask', id: 'failed', kind: 'retry' } as const;
    await runMobileTaskAction(retry);
    expect(fixture.ready).toHaveBeenCalled();
    expect(fixture.recover).toHaveBeenCalledWith({ taskId: 'failed', kind: 'retry' });
    expect(fixture.carryOn).not.toHaveBeenCalled();

    // recover re-checks the kind; a task that now continues refuses, for the phone to refresh.
    const changed = new TRPCError({ code: 'PRECONDITION_FAILED', message: 'changed' });
    fixture.recover.mockRejectedValueOnce(changed);
    await expect(runMobileTaskAction(retry)).rejects.toBe(changed);
  });

  it("passes recover's typed refusals and faults through, for the API to answer", async () => {
    await seed('failed', 'failed');
    const retry = { type: 'continueTask', id: 'failed', kind: 'retry' } as const;
    // A double tap or desktop's Retry restarted it first; or the task was deleted meanwhile.
    // The API answers these 409 / 404; a fault (a plain Error, wrapped by createCaller) is a 500.
    for (const error of [
      new TRPCError({ code: 'CONFLICT', message: 'Only failed or attention-parked tasks' }),
      new TRPCError({ code: 'NOT_FOUND', message: 'Task not found' }),
      new TRPCError({ code: 'INTERNAL_SERVER_ERROR', message: 'disk full' }),
    ]) {
      fixture.recover.mockRejectedValueOnce(error);
      await expect(runMobileTaskAction(retry)).rejects.toBe(error);
    }
  });

  it('refreshes a Continue whose session is gone, since the row now retries', async () => {
    await seed('failed', 'failed');
    fixture.carryOn.mockResolvedValueOnce({ ok: false, reason: 'no-session' });
    const proceed = { type: 'continueTask', id: 'failed', kind: 'continue' } as const;
    await expect(runMobileTaskAction(proceed)).rejects.toMatchObject({
      status: 409,
      message: 'This item changed. Refresh and try again.',
    });
    expect(fixture.recover).not.toHaveBeenCalled();
  });

  it('starts a waiting task once, as an agent, through the task executor', async () => {
    await seed('inbox', 'pending');
    await runMobileTaskAction({ type: 'startTask', id: 'inbox' });
    expect(fixture.handleClaimed).toHaveBeenCalledWith(
      expect.objectContaining({ id: 'inbox', status: 'running', result: { startMode: 'execute' } }),
    );
    // The claim moved it out of pending, so a second tap is refused.
    await expect(runMobileTaskAction({ type: 'startTask', id: 'inbox' })).rejects.toMatchObject({
      status: 409,
    });
    expect(fixture.handleClaimed).toHaveBeenCalledTimes(1);
  });

  it('does not start a pending task that already has a chat', async () => {
    await seed('linked', 'pending');
    await db.insert(chats).values({ id: 'chat', taskId: 'linked' });
    await expect(runMobileTaskAction({ type: 'startTask', id: 'linked' })).rejects.toMatchObject({
      status: 409,
    });
    expect((await db.select().from(tasks).where(eq(tasks.id, 'linked')))[0].status).toBe('pending');
  });

  it('needs Frink open on the computer to carry on or start', async () => {
    await seed('inbox', 'pending');
    fixture.ready.mockImplementationOnce(() => {
      throw new Error('Open Frink on your computer to continue.');
    });
    await expect(runMobileTaskAction({ type: 'startTask', id: 'inbox' })).rejects.toThrow(
      'Open Frink',
    );
    expect(fixture.handleClaimed).not.toHaveBeenCalled();
  });
});

describe('Flow row recovery', () => {
  let flowRunId: string;
  const step = (id: string, status: Task['status'], node = {}, answered = false) =>
    seedFlowStep(db, flowRunId, id, status, node, answered);
  // The run stopped on a started command after an agent step finished.
  const failedOnCommand = async () => {
    await setFlowRunStatus(db, flowRunId, 'failed');
    const row = await step('a', 'done', {}, true);
    await db.insert(nodeRuns).values({
      id: 'cmd',
      flowRunId,
      nodeId: 'cmd',
      blockType: 'run_command',
      status: 'failed',
      startedAt: new Date(),
    });
    return row;
  };

  beforeEach(async () => {
    ({ flowRunId } = await seedFlowRun(db, { nodes: [], edges: [] }));
    await db.insert(chats).values({ id: 'chat-1', name: 'chat' });
    await db.insert(subChats).values({ id: 'sub-1', chatId: 'chat-1', sessionId: 'sess-1' });
  });

  it('continues a run that failed on a later agent step through desktop’s recover', async () => {
    await setFlowRunStatus(db, flowRunId, 'failed');
    const row = await step('a', 'done', {});
    await step('b', 'cancelled', { status: 'failed' }, true);
    await runMobileTaskAction({ type: 'continueTask', id: row.id, kind: 'continue' });
    expect(fixture.ready).toHaveBeenCalled();
    // The server pins the step it re-checked, so recover refuses once that step moves on.
    expect(fixture.recover).toHaveBeenCalledWith({
      taskId: row.id,
      kind: 'continue',
      recoveryNodeRunId: 'b',
    });
    expect(fixture.carryOn).not.toHaveBeenCalled();
  });

  it('recovers a restart-interrupted run through its marked step', async () => {
    await setFlowRunStatus(db, flowRunId, 'cancelled');
    const row = await step('a', 'done', {});
    const marked = { status: 'cancelled', outputs: {}, artifacts: [], durationMs: 0 };
    const error = { message: RESTART_INTERRUPTION_REASON, retryable: true };
    await step('b', 'cancelled', { status: 'cancelled', nodeOutput: { ...marked, error } });
    await runMobileTaskAction({ type: 'continueTask', id: row.id, kind: 'retry' });
    expect(fixture.recover).toHaveBeenCalledWith({
      taskId: row.id,
      kind: 'retry',
      recoveryNodeRunId: 'b',
    });
  });

  it('retries a step with side effects only as the confirmed, pinned step', async () => {
    const row = await failedOnCommand();
    const retry = { type: 'continueTask', id: row.id, kind: 'retry' } as const;
    // A phone that could not ask sends no pin: nothing re-runs, and it says where to retry.
    await expect(runMobileTaskAction(retry)).rejects.toMatchObject({
      status: 409,
      message: expect.stringContaining('Retry it in Frink on your computer'),
    });
    expect(fixture.recover).not.toHaveBeenCalled();

    await runMobileTaskAction({ ...retry, recoveryNodeRunId: 'cmd' });
    expect(fixture.recover).toHaveBeenCalledWith({
      taskId: row.id,
      kind: 'retry',
      recoveryNodeRunId: 'cmd',
    });
    // recover refuses a pin the run has moved past; the API answers it 409.
    const changed = new TRPCError({ code: 'PRECONDITION_FAILED', message: 'changed' });
    fixture.recover.mockRejectedValueOnce(changed);
    await expect(runMobileTaskAction({ ...retry, recoveryNodeRunId: 'old' })).rejects.toBe(changed);
  });

  it('refuses a label the row no longer has, and a phone that predates Retry', async () => {
    const row = await failedOnCommand();
    for (const request of [
      { type: 'continueTask', id: row.id, kind: 'continue' },
      { type: 'continueTask', id: row.id },
    ] as const)
      await expect(runMobileTaskAction(request)).rejects.toMatchObject({
        status: 409,
        message: 'This item changed. Refresh and try again.',
      });
    expect(fixture.recover).not.toHaveBeenCalled();
  });

  // A paused run recovers through the stopped task itself, so there is no run step to pin; a
  // phone that predates Retry still carries it on.
  it('carries on a paused run through its own stopped task, with nothing pinned', async () => {
    await setFlowRunStatus(db, flowRunId, 'paused');
    const row = await step('a', 'failed', {}, true);
    const legacy = { type: 'continueTask', id: row.id } as const;
    await runMobileTaskAction(legacy);
    expect(fixture.recover).toHaveBeenCalledWith({
      taskId: row.id,
      kind: 'continue',
      recoveryNodeRunId: undefined,
    });
    expect(fixture.carryOn).not.toHaveBeenCalled();

    // Frink must be open on the computer: nothing recovers without it.
    fixture.recover.mockClear();
    fixture.ready.mockImplementationOnce(() => {
      throw new Error('Open Frink on your computer to continue.');
    });
    await expect(runMobileTaskAction(legacy)).rejects.toThrow('Open Frink');
    expect(fixture.recover).not.toHaveBeenCalled();
  });

  it('refuses a run that is still going', async () => {
    const row = await step('a', 'running', {});
    await expect(
      runMobileTaskAction({ type: 'continueTask', id: row.id, kind: 'continue' }),
    ).rejects.toMatchObject({ status: 409 });
    expect(fixture.recover).not.toHaveBeenCalled();
  });
});
