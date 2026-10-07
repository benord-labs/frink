import { eq } from 'drizzle-orm';
import { TRPCError } from '@trpc/server';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { mobileRequestSchema } from '../../../../shared/types/remote/mobile';
import { chats, tasks } from '../../db/schema';
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
    // A Flow's item starts and carries on through its run, but is accepted from the row.
    const flow = { flowRunId: 'run', result: { usageLimit: true } };
    expect(mobileTaskActions(task('pending', { flowRunId: 'run' }))).toEqual([]);
    expect(mobileTaskActions(task('needs_attention', flow))).toEqual(['completeTask']);
    expect(mobileTaskActions(task('done', flow))).toEqual(['completeTask']);
  });

  it('accepts only the named requests with an id', () => {
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
