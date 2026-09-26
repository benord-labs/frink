import { describe, expect, it } from 'vitest';
import { getRollbackFailureMessage } from './rollback';

describe('getRollbackFailureMessage', () => {
  it('returns detailed failure for git rollback errors', () => {
    const error = getRollbackFailureMessage({
      success: false,
      error: 'read-tree failed',
    });

    expect(error).toBe('Git rollback failed');
  });

  it('returns null when checkpoint is missing (recoverable — chat truncates, frontend toasts a warning)', () => {
    // A missing checkpoint must NOT abort the rollback. The router proceeds with
    // chat-only truncation and returns gitReverted: false, which the frontend
    // surfaces via toast.warning('Chat reverted — git checkpoint not found, code unchanged').
    // Returning a fatal error here would block rollback entirely on providers that
    // don't emit sdkMessageUuid.
    const error = getRollbackFailureMessage({
      success: true,
      checkpointFound: false,
    });

    expect(error).toBeNull();
  });

  it('returns null when rollback can proceed', () => {
    const error = getRollbackFailureMessage({
      success: true,
      checkpointFound: true,
    });

    expect(error).toBeNull();
  });
});
