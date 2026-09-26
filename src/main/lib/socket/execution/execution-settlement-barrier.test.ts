import { describe, expect, it } from 'vitest';
import { createExecutionSettlementBarrier } from './execution-settlement-barrier';

describe('createExecutionSettlementBarrier', () => {
  it('waits for the outer owner and every retained cleanup owner', async () => {
    const barrier = createExecutionSettlementBarrier();
    const wake = barrier.retain();
    let settled = false;
    void barrier.wait().then(() => {
      settled = true;
    });

    barrier.finish();
    await Promise.resolve();
    expect(settled).toBe(false);

    wake.finish();
    await expect(barrier.wait()).resolves.toBeUndefined();
  });

  it('retains cleanup errors until the final owner settles', async () => {
    const barrier = createExecutionSettlementBarrier();
    const wake = barrier.retain();
    const outerError = new Error('outer cleanup failed');
    const wakeError = new Error('wake cleanup failed');

    barrier.finish(outerError);
    wake.finish(wakeError);

    await expect(barrier.wait()).rejects.toEqual(
      new AggregateError([outerError, wakeError], 'Execution cleanup failed'),
    );
  });

  it('makes retained finish callbacks idempotent', async () => {
    const barrier = createExecutionSettlementBarrier();
    const wake = barrier.retain();

    wake.finish();
    wake.finish(new Error('late duplicate'));
    barrier.finish();

    await expect(barrier.wait()).resolves.toBeUndefined();
  });
});
