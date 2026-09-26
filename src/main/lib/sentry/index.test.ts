import { describe, expect, it, vi } from 'vitest';

const captureMainExceptionMock = vi.fn();
vi.mock('./init', () => ({
  captureMainException: (...args: unknown[]) => captureMainExceptionMock(...args),
}));

import { captureContained } from './index';

/**
 * Every call site of this helper sits inside a catch that has already decided to carry on, so a
 * throw from HERE would turn a contained fault into the crash the containment existed to prevent.
 * These pin that guarantee and the tag passthrough; the lazy `./init` import means the assertions
 * must await a tick.
 */
describe('captureContained', () => {
  it('forwards the error and its tags to the main-process capture', async () => {
    captureMainExceptionMock.mockReset();
    const error = new Error('SQLITE_IOERR: disk I/O error');

    captureContained(error, { surface: 'flow-dispatch', blockType: 'condition' });
    await vi.waitFor(() => expect(captureMainExceptionMock).toHaveBeenCalledTimes(1));

    expect(captureMainExceptionMock).toHaveBeenCalledWith(error, {
      surface: 'flow-dispatch',
      blockType: 'condition',
    });
  });

  it('returns synchronously and swallows a failure in the reporter itself', async () => {
    captureMainExceptionMock.mockReset();
    captureMainExceptionMock.mockImplementation(() => {
      throw new Error('sentry transport is down');
    });

    // Must not throw, and must not reject on the detached promise either.
    expect(() => captureContained(new Error('original'), { surface: 'chat-name' })).not.toThrow();
    await vi.waitFor(() => expect(captureMainExceptionMock).toHaveBeenCalledTimes(1));
  });
});
