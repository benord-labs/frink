import { beforeEach, describe, expect, it, vi } from 'vitest';

const fixture = vi.hoisted(() => ({
  deleteChat: vi.fn(),
  capture: vi.fn(),
  overview: vi.fn(),
  chats: vi.fn(),
  flow: vi.fn(),
}));
vi.mock('./chat', () => ({ deleteMobileChat: fixture.deleteChat }));
vi.mock('./composer', () => ({}));
vi.mock('./flows', () => ({ readMobileFlow: fixture.flow }));
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
