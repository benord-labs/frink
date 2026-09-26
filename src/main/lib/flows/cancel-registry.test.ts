import { describe, expect, it, vi } from 'vitest';
import {
  registerNodeAbort,
  reserveNodeAbortRegistration,
  unregisterNodeAbort,
  withFlowRunCancellation,
  withFlowRunCancellationGuard,
} from './cancel-registry';

describe('Flow cancellation registry', () => {
  it('aborts late registrations until every durable cancellation write settles', async () => {
    let settleFirst = () => {};
    let settleSecond = () => {};
    const first = withFlowRunCancellation(
      'flow-run',
      () => new Promise<void>((resolve) => (settleFirst = resolve)),
    );
    const second = withFlowRunCancellation(
      'flow-run',
      () => new Promise<void>((resolve) => (settleSecond = resolve)),
    );

    const duringBoth = new AbortController();
    registerNodeAbort('flow-run', duringBoth);
    expect(duringBoth.signal.aborted).toBe(true);

    settleFirst();
    await first;
    const duringSecond = new AbortController();
    registerNodeAbort('flow-run', duringSecond);
    expect(duringSecond.signal.aborted).toBe(true);

    settleSecond();
    await second;
    const after = new AbortController();
    registerNodeAbort('flow-run', after);
    expect(after.signal.aborted).toBe(false);
    unregisterNodeAbort('flow-run', after);
  });

  it('holds cancellation until the matching reserved dispatch registers its controller', async () => {
    const releaseReserved = reserveNodeAbortRegistration('reserved-flow');
    expect(releaseReserved).not.toBeNull();
    let cancelled = false;
    let persisted = false;
    const cancellation = withFlowRunCancellation('reserved-flow', async () => {
      persisted = true;
    }).then(() => {
      cancelled = true;
    });
    expect(reserveNodeAbortRegistration('reserved-flow')).toBeNull();
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(persisted).toBe(false);
    expect(cancelled).toBe(false);

    const unrelatedController = new AbortController();
    registerNodeAbort('reserved-flow', unrelatedController);
    expect(unrelatedController.signal.aborted).toBe(true);
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(persisted).toBe(false);
    expect(cancelled).toBe(false);

    const reservedController = new AbortController();
    registerNodeAbort('reserved-flow', reservedController);
    releaseReserved?.();
    expect(reservedController.signal.aborted).toBe(true);
    await vi.waitFor(() => expect(cancelled).toBe(true), { timeout: 100 });
    await cancellation;
    expect(persisted).toBe(true);
    expect(cancelled).toBe(true);
  });

  it('drains reserved dispatches before a synchronous ownership write', async () => {
    const releaseReserved = reserveNodeAbortRegistration('owned-flow');
    let persisted = false;
    const cancellation = withFlowRunCancellationGuard('owned-flow', () => {
      persisted = true;
    });

    await Promise.resolve();
    expect(persisted).toBe(false);
    releaseReserved?.();
    await cancellation;
    expect(persisted).toBe(true);
  });
});
