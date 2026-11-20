import { TRPCError } from '@trpc/server';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const fixture = vi.hoisted(() => ({
  deleteChat: vi.fn(),
  readChat: vi.fn(),
  capture: vi.fn(),
  overview: vi.fn(),
  chats: vi.fn(),
  flow: vi.fn(),
  taskAction: vi.fn(),
}));
vi.mock('./chat', () => ({
  deleteMobileChat: fixture.deleteChat,
  readMobileChat: fixture.readChat,
}));
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
import type { MobileChatDetail, MobileRequest } from '../../../../shared/types/remote/mobile';
import type { LiveChatEvent } from '../../socket/streaming/live-stream/events';
import { PhoneSafeRefusal } from '../../trpc/routers/task-refusals';
import { createMobileStreamHub, type ChatEventEnvelope } from '../stream';
import { MobileApiError } from './errors';
import { executeMobileRequest } from './api';

beforeEach(() => vi.clearAllMocks());

describe('executeMobileRequest', () => {
  it('still answers a phone built while the Queue had an Inbox', async () => {
    fixture.overview.mockResolvedValueOnce({ queue: [] });
    const limits = { attention: 1, running: 1, inbox: 1 };
    await expect(executeMobileRequest({ type: 'overview', limits })).resolves.toEqual({
      queue: [],
    });
  });

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
    for (const type of ['completeTask', 'continueTask'] as const) {
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

  it('shows the phone a phone-safe refusal with its own message, without reporting it', async () => {
    const retry = { type: 'continueTask', id: 'task', kind: 'retry' } as const;
    const lostAdmission =
      'This Flow run lost its place in the run queue. Continue or Retry it from the Queue.';
    fixture.taskAction.mockRejectedValueOnce(
      new PhoneSafeRefusal({ code: 'PRECONDITION_FAILED', message: lostAdmission }),
    );
    await expect(executeMobileRequest(retry)).rejects.toMatchObject({
      status: 409,
      message: lostAdmission,
    });
    const superseded = 'This attempt was replaced by a newer one.';
    fixture.taskAction.mockRejectedValueOnce(
      new PhoneSafeRefusal({ code: 'CONFLICT', message: superseded }),
    );
    await expect(executeMobileRequest(retry)).rejects.toMatchObject({
      status: 409,
      message: superseded,
    });
    expect(fixture.capture).not.toHaveBeenCalled();
  });

  it('keeps an unmarked refusal generic, so its text never reaches the phone', async () => {
    fixture.taskAction.mockRejectedValueOnce(
      new TRPCError({ code: 'PRECONDITION_FAILED', message: 'internal detail' }),
    );
    await expect(executeMobileRequest({ type: 'continueTask', id: 'task' })).rejects.toMatchObject({
      status: 409,
      message: 'This item changed. Refresh and try again.',
    });
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

  it('watches a chat on the channel the request came over, and refuses any other', async () => {
    vi.useFakeTimers();
    const detail: MobileChatDetail = {
      chat: { id: 'chat', name: 'Chat', projectId: null },
      subChatId: 'sub-chat',
      subChats: [],
      messages: [],
      hasMore: false,
      activity: 'idle',
      kind: 'chat',
      error: null,
      questions: [],
      permissions: [],
      pendingPlanId: null,
    };
    fixture.readChat.mockImplementation(async () => structuredClone(detail));
    let broadcast: (event: LiveChatEvent) => void = () => {};
    const streams = createMobileStreamHub((listener) => {
      broadcast = listener;
      return () => {};
    });
    const sent: ChatEventEnvelope[] = [];
    streams.register('channel', async (envelope) => {
      sent.push(envelope);
    });
    try {
      const request: MobileRequest = { type: 'watchChat', chatId: 'chat' };
      const watched = await executeMobileRequest(request, { streams, channelId: 'channel' });
      expect(watched).toEqual({ sub: expect.any(String), detail });
      expect(fixture.readChat).toHaveBeenCalledWith({ type: 'chat', id: 'chat' });
      detail.activity = 'running';
      broadcast({ channel: 'socket:stream-chunk', subChatId: 'sub-chat' });
      await vi.advanceTimersByTimeAsync(1_000);
      expect(sent).toHaveLength(1);
      expect(watched).toMatchObject({ sub: sent[0].sub });
      expect(fixture.readChat).toHaveBeenLastCalledWith({
        type: 'chat',
        id: 'chat',
        subChatId: 'sub-chat',
      });
      for (const channelId of ['unknown', undefined])
        await expect(executeMobileRequest(request, { streams, channelId })).rejects.toMatchObject({
          status: 409,
        });
    } finally {
      streams.dispose();
      vi.useRealTimers();
    }
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
