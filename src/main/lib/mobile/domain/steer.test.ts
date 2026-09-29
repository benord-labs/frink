import { beforeEach, describe, expect, it, vi } from 'vitest';

const fixture = vi.hoisted(() => ({ steer: vi.fn(), requireChat: vi.fn() }));
vi.mock('../../socket/steering', () => ({ steerActiveTurn: fixture.steer }));
vi.mock('./context', () => ({ requireChat: fixture.requireChat }));
import { steerMobileMessage } from './steer';

const request = (requestId: string) => ({
  type: 'steerMessage' as const,
  chatId: 'chat',
  subChatId: 'sub',
  requestId,
  text: 'Use pnpm',
});

beforeEach(() => {
  vi.clearAllMocks();
  fixture.requireChat.mockResolvedValue({});
});

describe('steerMobileMessage', () => {
  it.each([
    ['delivered', 'delivered'],
    ['not-steerable', 'not-delivered'],
    ['unsupported', 'not-delivered'],
  ])('reports %s as %s', async (outcome, expected) => {
    fixture.steer.mockResolvedValue(outcome);
    await expect(steerMobileMessage(request(`id-${outcome}`))).resolves.toEqual({
      outcome: expected,
    });
    expect(fixture.steer).toHaveBeenCalledWith('sub', { text: 'Use pnpm' });
  });

  it('answers a retried request id without steering twice', async () => {
    fixture.steer.mockResolvedValue('delivered');
    await steerMobileMessage(request('retry'));
    await expect(steerMobileMessage(request('retry'))).resolves.toEqual({ outcome: 'delivered' });
    expect(fixture.steer).toHaveBeenCalledTimes(1);
  });

  it('lets a failed request run again', async () => {
    fixture.requireChat.mockRejectedValueOnce(new Error('Chat not found.'));
    await expect(steerMobileMessage(request('gone'))).rejects.toThrow('Chat not found.');
    fixture.steer.mockResolvedValue('delivered');
    await expect(steerMobileMessage(request('gone'))).resolves.toEqual({ outcome: 'delivered' });
  });
});
