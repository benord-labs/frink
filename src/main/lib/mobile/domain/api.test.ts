import { beforeEach, describe, expect, it, vi } from 'vitest';

const fixture = vi.hoisted(() => ({ deleteChat: vi.fn(), capture: vi.fn() }));
vi.mock('./chat', () => ({ deleteMobileChat: fixture.deleteChat }));
vi.mock('./composer', () => ({}));
vi.mock('./flows', () => ({}));
vi.mock('./read', () => ({}));
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
