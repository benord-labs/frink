import { describe, expect, it } from 'vitest';
import { isWorkActive } from '../power/work-activity';
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

  it('reports in-flight nodes as live work until the last one settles or the run is cancelled', () => {
    const shell = new AbortController();
    const http = new AbortController();
    registerNodeAbort('awake-run', shell);
    registerNodeAbort('awake-run', http);
    expect(isWorkActive()).toBe(true);

    unregisterNodeAbort('awake-run', shell);
    expect(isWorkActive()).toBe(true);
    unregisterNodeAbort('awake-run', http);
    expect(isWorkActive()).toBe(false);

    registerNodeAbort('awake-run', new AbortController());
    abortFlowRun('awake-run');
    expect(isWorkActive()).toBe(false);
  });
});
