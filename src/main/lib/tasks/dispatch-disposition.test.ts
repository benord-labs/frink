import { describe, expect, it, vi } from 'vitest';

vi.mock('../sentry/init', () => ({ captureMainMessage: vi.fn() }));

import { classifyDispatchFailure, MAX_DISPATCH_ATTEMPTS } from './dispatch-disposition';

function permanentError(message: string): Error {
  const err = new Error(message);
  (err as Error & { permanent?: boolean }).permanent = true;
  return err;
}

describe('classifyDispatchFailure', () => {
  it('fails a permanent error on the first attempt and preserves prior result keys', () => {
    const disposition = classifyDispatchFailure(permanentError('worktree gone'), {
      chatId: 'c1',
      subChatId: 's1',
    });
    expect(disposition.status).toBe('failed');
    expect(disposition.permanent).toBe(true);
    expect(disposition.result).toMatchObject({
      chatId: 'c1',
      subChatId: 's1',
      error: 'worktree gone',
      dispatchAttempts: 1,
    });
  });

  it('keeps a transient error pending with an incremented counter', () => {
    const disposition = classifyDispatchFailure(new Error('index.lock'), { dispatchAttempts: 3 });
    expect(disposition.status).toBe('pending');
    expect(disposition.permanent).toBe(false);
    expect(disposition.dispatchAttempts).toBe(4);
  });

  it('fails a transient error once the attempt cap is reached', () => {
    const disposition = classifyDispatchFailure(new Error('flaky'), {
      dispatchAttempts: MAX_DISPATCH_ATTEMPTS - 1,
    });
    expect(disposition.status).toBe('failed');
    expect(disposition.dispatchAttempts).toBe(MAX_DISPATCH_ATTEMPTS);
  });

  it('persists an errorAction payload (renderer CTA parity)', () => {
    const err = permanentError('Account "x" is not authenticated on this machine.');
    (err as Error & { action?: string }).action = 'open-connect-account';
    const disposition = classifyDispatchFailure(err, {});
    expect(disposition.status).toBe('failed');
    expect(disposition.result.errorAction).toBe('open-connect-account');
  });

  it('carries dispatchErrorCode + remediation into the result (retry-gate wiring)', () => {
    const err = permanentError('Cannot reuse flow worktree: gone');
    (
      err as Error & { dispatchErrorCode?: string; dispatchErrorRemediation?: string }
    ).dispatchErrorCode = 'WORKTREE_UNAVAILABLE';
    (
      err as Error & { dispatchErrorCode?: string; dispatchErrorRemediation?: string }
    ).dispatchErrorRemediation = 'Restart the run.';
    const disposition = classifyDispatchFailure(err, {});
    expect(disposition.result).toMatchObject({
      dispatchErrorCode: 'WORKTREE_UNAVAILABLE',
      dispatchErrorRemediation: 'Restart the run.',
    });
  });

  it('handles non-Error throws with the generic message', () => {
    const disposition = classifyDispatchFailure('boom', {});
    expect(disposition.status).toBe('pending');
    expect(disposition.result.error).toBe('Task execution failed');
  });
});
