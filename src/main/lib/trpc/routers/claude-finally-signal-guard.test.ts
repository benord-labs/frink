import { describe, expect, it, vi } from 'vitest';
import { sharedFinallyCleanup } from './claude-shared-finally-cleanup';

describe('claude router terminal signal finally guard', () => {
  it('runs ensureTerminalTaskSignal before safeComplete', async () => {
    const callOrder: string[] = [];
    const ensureTerminalTaskSignal = vi.fn(async () => {
      callOrder.push('ensure');
    });
    const handleTerminalTaskSignalPersistError = vi.fn((_: unknown) => {
      callOrder.push('handle-error');
    });
    const safeComplete = vi.fn(() => {
      callOrder.push('safe-complete');
    });

    await sharedFinallyCleanup({
      ensureTerminalTaskSignal,
      handleTerminalTaskSignalPersistError,
      safeComplete,
    });

    expect(ensureTerminalTaskSignal).toHaveBeenCalledTimes(1);
    expect(handleTerminalTaskSignalPersistError).not.toHaveBeenCalled();
    expect(safeComplete).toHaveBeenCalledTimes(1);
    expect(callOrder).toEqual(['ensure', 'safe-complete']);
  });

  it('invokes error handler when ensureTerminalTaskSignal rejects and still completes safely', async () => {
    const callOrder: string[] = [];
    const failure = new Error('persist failed');
    const ensureTerminalTaskSignal = vi.fn(async () => {
      callOrder.push('ensure');
      throw failure;
    });
    const handleTerminalTaskSignalPersistError = vi.fn((_: unknown) => {
      callOrder.push('handle-error');
    });
    const safeComplete = vi.fn(() => {
      callOrder.push('safe-complete');
    });

    await sharedFinallyCleanup({
      ensureTerminalTaskSignal,
      handleTerminalTaskSignalPersistError,
      safeComplete,
    });

    expect(ensureTerminalTaskSignal).toHaveBeenCalledTimes(1);
    expect(handleTerminalTaskSignalPersistError).toHaveBeenCalledTimes(1);
    expect(handleTerminalTaskSignalPersistError).toHaveBeenCalledWith(failure);
    expect(safeComplete).toHaveBeenCalledTimes(1);
    expect(callOrder).toEqual(['ensure', 'handle-error', 'safe-complete']);
  });

  it('still completes when the persist-error handler throws', async () => {
    const callOrder: string[] = [];
    const ensureTerminalTaskSignal = vi.fn(async () => {
      callOrder.push('ensure');
      throw new Error('persist failed');
    });
    const handleTerminalTaskSignalPersistError = vi.fn((_: unknown) => {
      callOrder.push('handle-error');
      throw new Error('handler failed');
    });
    const safeComplete = vi.fn(() => {
      callOrder.push('safe-complete');
    });

    await expect(
      sharedFinallyCleanup({
        ensureTerminalTaskSignal,
        handleTerminalTaskSignalPersistError,
        safeComplete,
      }),
    ).resolves.toBeUndefined();

    expect(safeComplete).toHaveBeenCalledTimes(1);
    expect(callOrder).toEqual(['ensure', 'handle-error', 'safe-complete']);
  });
});
