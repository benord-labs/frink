import { describe, expect, it, vi } from 'vitest';
import { trackUserMessageDelivery } from './user-message-delivery';

const { captureMainException } = vi.hoisted(() => ({ captureMainException: vi.fn() }));
vi.mock('../../../sentry/init', () => ({ captureMainException, captureMainMessage: vi.fn() }));
vi.mock('electron-log', () => ({ default: { info: vi.fn() } }));

describe('trackUserMessageDelivery (sc-3666)', () => {
  it('throws a MESSAGE_NOT_DELIVERED error and reports it when nothing was pushed', () => {
    const delivery = trackUserMessageDelivery('sub-1', 'msg-1', () => 10);

    expect(() => delivery.assertDelivered(false, true)).toThrow(
      expect.objectContaining({ category: 'MESSAGE_NOT_DELIVERED' }),
    );
    expect(captureMainException).toHaveBeenCalledWith(
      expect.any(Error),
      expect.objectContaining({ subChatId: 'sub-1', stage: 'deliver', resumed: 'true' }),
    );
  });

  it('passes once any attempt pushed, and leaves an aborted run alone', () => {
    const pushed = trackUserMessageDelivery('sub-1', 'msg-1', () => 10);
    pushed.onPushed(false, true)();
    expect(() => pushed.assertDelivered(false, false)).not.toThrow();

    const aborted = trackUserMessageDelivery('sub-2', 'msg-2', () => 10);
    expect(() => aborted.assertDelivered(true, false)).not.toThrow();
  });
});
