import { TRPCError } from '@trpc/server';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const fixture = vi.hoisted(() => ({
  deleteChat: vi.fn(),
  capture: vi.fn(),
  overview: vi.fn(),
  chats: vi.fn(),
  flow: vi.fn(),
  taskAction: vi.fn(),
}));
vi.mock('./chat', () => ({ deleteMobileChat: fixture.deleteChat }));
vi.mock('./composer', () => ({}));
vi.mock('./flows', () => ({ readMobileFlow: fixture.flow }));
vi.mock('./tasks', () => ({ runMobileTaskAction: fixture.taskAction }));
vi.mock('./read', () => ({
  readMobileOverview: fixture.overview,
  readMobileChats: fixture.chats,
}));
vi.mock('./context', async () => ({
  MobileApiError: (await import('./errors')).MobileApiError,
  mobileCallers: {},
  requireExecutionReady: vi.fn(),
}));
vi.mock('../../sentry', () => ({ captureContained: fixture.capture }));
import { MobileApiError } from './errors';
import { executeMobileRequest } from './api';

beforeEach(() => vi.clearAllMocks());

describe('executeMobileRequest', () => {
  it('passes list windows and search through to the reads', async () => {
    await executeMobileRequest({ type: 'overview', limits: { attention: 50 } });
    expect(fixture.overview).toHaveBeenCalledWith(
      expect.objectContaining({ limits: { attention: 50 } }),
    );
    await executeMobileRequest({ type: 'chats', limit: 60, query: ' 100% ' });
    expect(fixture.chats).toHaveBeenCalledWith(
      expect.objectContaining({ limit: 60, query: '100%' }),
    );
    await executeMobileRequest({ type: 'flow', id: 'flow', runLimit: 40 });
    expect(fixture.flow).toHaveBeenCalledWith(
      expect.objectContaining({ id: 'flow', runLimit: 40 }),
    );
  });

  it('routes a chat deletion to the delete handler', async () => {
    fixture.deleteChat.mockResolvedValue({ ok: true });
    await expect(executeMobileRequest({ type: 'deleteChat', chatId: 'chat' })).resolves.toEqual({
      ok: true,
    });
    expect(fixture.deleteChat).toHaveBeenCalledWith({ type: 'deleteChat', chatId: 'chat' });
  });

  it('routes each Queue task action to the task action handler', async () => {
    fixture.taskAction.mockResolvedValue({ ok: true });
    for (const type of ['completeTask', 'continueTask', 'startTask'] as const) {
      await expect(executeMobileRequest({ type, id: 'task' })).resolves.toEqual({ ok: true });
      expect(fixture.taskAction).toHaveBeenLastCalledWith({ type, id: 'task' });
    }
  });

  it('keeps a recovery kind through the request schema, so Retry never runs as Continue', async () => {
    fixture.taskAction.mockResolvedValue({ ok: true });
    await executeMobileRequest({ type: 'continueTask', id: 'task', kind: 'retry' });
    expect(fixture.taskAction).toHaveBeenLastCalledWith({
      type: 'continueTask',
      id: 'task',
      kind: 'retry',
    });
  });

  it('tells the phone a recovery whose kind changed to refresh, without reporting it', async () => {
    fixture.taskAction.mockRejectedValueOnce(
      new TRPCError({ code: 'PRECONDITION_FAILED', message: 'This step changed' }),
    );
    await expect(
      executeMobileRequest({ type: 'continueTask', id: 'task', kind: 'retry' }),
    ).rejects.toMatchObject({ status: 409, message: 'This item changed. Refresh and try again.' });
    expect(fixture.capture).not.toHaveBeenCalled();
  });

  it('answers a refused Retry that lost no race 404 / 409, reporting only a fault', async () => {
    const retry = { type: 'continueTask', id: 'task', kind: 'retry' } as const;
    fixture.taskAction.mockRejectedValueOnce(
      new TRPCError({ code: 'NOT_FOUND', message: 'Task not found' }),
    );
    await expect(executeMobileRequest(retry)).rejects.toMatchObject({
      status: 404,
      message: 'This item no longer exists.',
    });
    fixture.taskAction.mockRejectedValueOnce(
      new TRPCError({ code: 'CONFLICT', message: 'Only failed or attention-parked tasks' }),
    );
    await expect(executeMobileRequest(retry)).rejects.toMatchObject({
      status: 409,
      message: 'This item changed. Refresh and try again.',
    });
    expect(fixture.capture).not.toHaveBeenCalled();

    // createCaller wraps a plain Error thrown by the procedure as INTERNAL_SERVER_ERROR.
    const fault = new TRPCError({ code: 'INTERNAL_SERVER_ERROR', message: 'disk full' });
    fixture.taskAction.mockRejectedValueOnce(fault);
    await expect(executeMobileRequest(retry)).rejects.toMatchObject({ status: 500 });
    expect(fixture.capture).toHaveBeenCalledWith(fault, {
      surface: 'mobile-api',
      stage: 'continueTask',
    });
  });

  it('reports an unexpected fault it masks, and not an expected refusal', async () => {
    const refusal = new MobileApiError(409, 'This chat belongs to a task or Flow.');
    fixture.deleteChat.mockRejectedValueOnce(refusal);
    await expect(executeMobileRequest({ type: 'deleteChat', chatId: 'chat' })).rejects.toBe(
      refusal,
    );
    expect(fixture.capture).not.toHaveBeenCalled();

    const fault = new Error('/private/path disk failure');
    fixture.deleteChat.mockRejectedValueOnce(fault);
    await expect(
      executeMobileRequest({ type: 'deleteChat', chatId: 'chat' }),
    ).rejects.toMatchObject({
      status: 500,
      message: 'Frink could not complete this request. Try again.',
    });
    expect(fixture.capture).toHaveBeenCalledWith(fault, {
      surface: 'mobile-api',
      stage: 'deleteChat',
    });
  });
});
