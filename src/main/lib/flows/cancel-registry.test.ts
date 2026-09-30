import { describe, expect, it } from 'vitest';
import { abortFlowRun, registerNodeAbort, unregisterNodeAbort } from './cancel-registry';

describe('Flow cancellation registry', () => {
  it('aborts every registered controller of a run once, and none of another run', () => {
    const first = new AbortController();
    const second = new AbortController();
    const other = new AbortController();
    registerNodeAbort('flow-run', first);
    registerNodeAbort('flow-run', second);
    registerNodeAbort('other-run', other);

    expect(abortFlowRun('flow-run')).toBe(2);

    expect([first.signal.aborted, second.signal.aborted, other.signal.aborted]).toEqual([
      true,
      true,
      false,
    ]);
    expect(abortFlowRun('flow-run')).toBe(0);
    unregisterNodeAbort('other-run', other);
  });

  it('never aborts an unregistered controller, and registers late ones live', () => {
    const gone = new AbortController();
    registerNodeAbort('flow-run', gone);
    unregisterNodeAbort('flow-run', gone);

    expect(abortFlowRun('flow-run')).toBe(0);
    expect(gone.signal.aborted).toBe(false);

    const late = new AbortController();
    registerNodeAbort('flow-run', late);
    expect(late.signal.aborted).toBe(false);
    expect(abortFlowRun('flow-run')).toBe(1);
  });
});
