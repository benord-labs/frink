import { beforeEach, describe, expect, it, vi } from 'vitest';

const captureMainMessage = vi.fn();
vi.mock('../sentry/init', () => ({
  captureMainMessage: (...args: unknown[]) => captureMainMessage(...args),
}));

const parkFlowTaskOnClaudeInterruption = vi.fn();
vi.mock('../db/repos/task-parking', () => ({
  parkFlowTaskOnClaudeInterruption: (...args: unknown[]) =>
    parkFlowTaskOnClaudeInterruption(...args),
}));

const getActiveExecution = vi.fn();
vi.mock('../socket/streaming/execution-registry', () => ({
  getActiveExecution: (...args: unknown[]) => getActiveExecution(...args),
}));

import type { UIMessageChunk } from '../claude/types';
import {
  disposeFlowStreamError,
  disposeTrailingStreamErrorChunk,
  latchAbortReason,
  resolveErrorPayloadCategory,
  stampedErrorCategory,
} from './stream-error-disposition';

/**
 * Codex ends a failed turn with an `error` chunk followed by the stream's closing chunks —
 * never a throw — so these shapes are what the executor actually hands the disposition.
 */
function chunks(...parts: Array<Partial<UIMessageChunk> & { type: string }>): UIMessageChunk[] {
  return parts as UIMessageChunk[];
}

const CODEX_401 = 'Codex exited with code 1: 401 Unauthorized — invalid API key for this workspace';

describe('disposeTrailingStreamErrorChunk', () => {
  beforeEach(() => {
    parkFlowTaskOnClaudeInterruption.mockClear();
    captureMainMessage.mockClear();
  });

  it('parks a turn whose stream ended on an error chunk', async () => {
    await disposeTrailingStreamErrorChunk(
      'sub-1',
      chunks(
        { type: 'text-delta', delta: 'working' },
        { type: 'error', errorText: CODEX_401 },
        { type: 'finish-step' },
        { type: 'finish' },
      ),
      undefined,
    );
    expect(parkFlowTaskOnClaudeInterruption).toHaveBeenCalledWith('sub-1', {
      kind: 'api-error',
      status: null,
      message: CODEX_401,
    });
  });

  it('leaves a turn that errored and then kept working alone', async () => {
    await disposeTrailingStreamErrorChunk(
      'sub-1',
      chunks(
        { type: 'error', errorText: CODEX_401 },
        { type: 'text-delta', delta: 'recovered on a fresh session' },
        { type: 'finish' },
      ),
      undefined,
    );
    expect(parkFlowTaskOnClaudeInterruption).not.toHaveBeenCalled();
  });

  it('does nothing for a clean stream or an empty one', async () => {
    await disposeTrailingStreamErrorChunk(
      'sub-1',
      chunks({ type: 'text-delta', delta: 'all done' }, { type: 'finish' }),
      undefined,
    );
    await disposeTrailingStreamErrorChunk('sub-1', [], undefined);
    expect(parkFlowTaskOnClaudeInterruption).not.toHaveBeenCalled();
  });

  it('does not park when the user pressed Stop — SIGKILL surfaces as a non-zero-exit error', async () => {
    await disposeTrailingStreamErrorChunk(
      'sub-1',
      chunks({ type: 'error', errorText: 'Codex exited with code 143' }, { type: 'finish' }),
      'remote-stop',
    );
    expect(parkFlowTaskOnClaudeInterruption).not.toHaveBeenCalled();
  });

  it('carries a classified status through when the text is the CLI API-error shape', async () => {
    const text = 'API Error: 429 {"error":{"type":"rate_limit_error"}}';
    await disposeTrailingStreamErrorChunk(
      'sub-1',
      chunks({ type: 'error', errorText: text }, { type: 'finish' }),
      undefined,
    );
    expect(parkFlowTaskOnClaudeInterruption).toHaveBeenCalledWith('sub-1', {
      kind: 'api-error',
      status: 429,
      message: text,
    });
  });

  // The SDK reports an involuntary teardown with the SAME "aborted by user" text as a real Stop,
  // so a text-only classifier files it as a user stop and the turn ends in silence.
  it('reports an involuntary teardown even though the SDK calls it a user abort', async () => {
    const sdkText = 'Claude Code process aborted by user';

    const stopped = await disposeFlowStreamError('sub-1', sdkText, 'remote-stop');
    expect(stopped.isUserStoppedExecution).toBe(true);

    for (const reason of ['renderer-reload', 'renderer-crashed']) {
      const torn = await disposeFlowStreamError('sub-1', sdkText, reason);
      expect(torn.isUserStoppedExecution).toBe(false);
      expect(torn.involuntary).toBe(reason);
      // Reporting the SDK's own wording would be dropped by the renderer's user-abort filter.
      expect(torn.reportMessage).not.toMatch(/aborted by user/i);
      // A rising rate is a regression in the app's window lifecycle, not a user action.
      expect(captureMainMessage).toHaveBeenCalledWith(
        'agent run torn down involuntarily',
        'warning',
        { subChatId: 'sub-1', reason },
      );
    }
    // Its own teardown already reconciled the flow task — parking here would fight that.
    expect(parkFlowTaskOnClaudeInterruption).not.toHaveBeenCalled();
  });

  it('ignores an error chunk with no usable text', async () => {
    await disposeTrailingStreamErrorChunk(
      'sub-1',
      chunks({ type: 'error', errorText: '' }, { type: 'finish' }),
      undefined,
    );
    expect(parkFlowTaskOnClaudeInterruption).not.toHaveBeenCalled();
  });
});

/**
 * `executionAbortSources` is keyed by sub-chat, so consecutive runs of the same chat share an
 * entry. A run must classify on the reason recorded for ITS OWN abort — otherwise a leftover
 * teardown reason makes the NEXT run's genuine failure skip its park and durably mis-stamp
 * `interruptedBy` on the wrong message.
 */
describe('latchAbortReason', () => {
  it('reads the reason at the instant its own signal fires, not later', () => {
    const sources = new Map<string, string>();
    const controller = new AbortController();
    const reason = latchAbortReason(controller.signal, sources, 'sub-1');

    expect(reason()).toBeUndefined(); // never aborted — not a stop

    sources.set('sub-1', 'renderer-reload');
    controller.abort();
    sources.set('sub-1', 'remote-stop'); // a later run stamps over it
    sources.delete('sub-1'); // …and the teardown clears it

    expect(reason()).toBe('renderer-reload');
  });

  it('does not leak one run’s reason into the next run on the same sub-chat', () => {
    const sources = new Map<string, string>([['sub-1', 'renderer-reload']]);
    const next = new AbortController();
    const reason = latchAbortReason(next.signal, sources, 'sub-1');

    // The stale entry is present, but THIS run never aborted, so it is not a stop at all.
    expect(reason()).toBeUndefined();
  });

  // A run that swaps in a fresh AbortController mid-flight would, with a latch bound only to the
  // original signal, read "never aborted" for every abort after the swap.
  it('follows a controller the run swapped in mid-flight', () => {
    const sources = new Map<string, string>();
    const original = new AbortController();
    const replacement = new AbortController();
    let reason = latchAbortReason(original.signal, sources, 'sub-1');
    reason = latchAbortReason(replacement.signal, sources, 'sub-1', reason);

    sources.set('sub-1', 'renderer-reload');
    replacement.abort();

    expect(reason()).toBe('renderer-reload');
  });

  it('keeps a reason latched before the swap over the replacement signal', () => {
    const sources = new Map<string, string>([['sub-1', 'remote-stop']]);
    const original = new AbortController();
    let reason = latchAbortReason(original.signal, sources, 'sub-1');
    original.abort();

    reason = latchAbortReason(new AbortController().signal, sources, 'sub-1', reason);

    expect(reason()).toBe('remote-stop');
  });

  it('reports a bare abort with nothing stamped as a stop, but never an involuntary one', () => {
    const controller = new AbortController();
    const reason = latchAbortReason(controller.signal, new Map(), 'sub-1');

    controller.abort();

    expect(reason()).toBe('aborted');
  });
});

describe('resolveErrorPayloadCategory', () => {
  it('an explicit stamp outranks the text heuristics', () => {
    const apiError = { status: 500, message: 'boom' } as never;
    expect(resolveErrorPayloadCategory('FLOW_RUN_ENDED', true, apiError)).toEqual({
      category: 'FLOW_RUN_ENDED',
    });
    expect(resolveErrorPayloadCategory(undefined, true, apiError)).toEqual({
      category: 'RATE_LIMIT_SDK',
    });
    expect(resolveErrorPayloadCategory(undefined, false, apiError)).toEqual({
      category: 'API_ERROR',
    });
    expect(resolveErrorPayloadCategory(undefined, false, null)).toEqual({});
  });
});

describe('stampedErrorCategory', () => {
  it('reads only a string category stamped on an Error', () => {
    expect(
      stampedErrorCategory(Object.assign(new Error('x'), { category: 'FLOW_RUN_ENDED' })),
    ).toBe('FLOW_RUN_ENDED');
    expect(stampedErrorCategory(new Error('x'))).toBeUndefined();
    expect(stampedErrorCategory(Object.assign(new Error('x'), { category: 7 }))).toBeUndefined();
    expect(stampedErrorCategory('not an error')).toBeUndefined();
  });
});

describe('disposeFlowStreamError with a stamped category', () => {
  beforeEach(() => {
    parkFlowTaskOnClaudeInterruption.mockClear();
    captureMainMessage.mockClear();
  });

  it('treats an expected decline (FLOW_RUN_ENDED) as classified — no unclassified capture', async () => {
    const message = 'Flow task t1 is no longer execution-eligible';
    const controller = new AbortController();
    getActiveExecution.mockReturnValue({ controller });
    const result = await disposeFlowStreamError('sub-1', message, undefined, {
      stampedCategory: 'FLOW_RUN_ENDED',
      executionController: controller,
    });

    expect(captureMainMessage).not.toHaveBeenCalled();
    // Still parks when this run OWNS the sub-chat: a follow-up message can CAS-flip a failed task
    // back to running before the eligibility assert throws, and this park is what un-sticks it.
    expect(parkFlowTaskOnClaudeInterruption).toHaveBeenCalledWith('sub-1', {
      kind: 'api-error',
      status: null,
      message,
    });
    expect(result.supersededDecline()).toBe(false);
    expect(result.isUserStoppedExecution).toBe(false);
    expect(result.reportMessage).toBe(message);
  });

  it('a decline superseded by a newer execution neither parks nor reaches the renderer', async () => {
    const message = 'Flow run r1 is no longer admitted for provider execution';
    getActiveExecution.mockReturnValue({ controller: new AbortController() });
    const result = await disposeFlowStreamError('sub-1', message, undefined, {
      stampedCategory: 'FLOW_RUN_ENDED',
      executionController: new AbortController(),
    });

    // The park is keyed by sub-chat — parking here would park the superseding NEWER task.
    expect(parkFlowTaskOnClaudeInterruption).not.toHaveBeenCalled();
    expect(result.supersededDecline()).toBe(true);
  });

  it('a FLOW_RUN_RESUMING decline gets the same superseded guard (the convert variant must not tear down the newer send it converted for)', async () => {
    getActiveExecution.mockReturnValue({ controller: new AbortController() });
    const result = await disposeFlowStreamError(
      'sub-1',
      'Flow run r1 is no longer admitted for provider execution',
      undefined,
      { stampedCategory: 'FLOW_RUN_RESUMING', executionController: new AbortController() },
    );

    expect(parkFlowTaskOnClaudeInterruption).not.toHaveBeenCalled();
    expect(result.supersededDecline()).toBe(true);
  });

  it('a cleaned-up registry entry also counts as superseded (the newer run already finished)', async () => {
    getActiveExecution.mockReturnValue(undefined);
    const result = await disposeFlowStreamError(
      'sub-1',
      'Flow task t1 is no longer execution-eligible',
      undefined,
      { stampedCategory: 'FLOW_RUN_ENDED', executionController: new AbortController() },
    );

    expect(result.supersededDecline()).toBe(true);
    expect(parkFlowTaskOnClaudeInterruption).not.toHaveBeenCalled();
  });

  it('still captures a genuinely unclassified stream error when nothing is stamped', async () => {
    await disposeFlowStreamError('sub-1', 'renderer pipe burst mid-stream', undefined);

    expect(captureMainMessage).toHaveBeenCalledWith(
      'flow stream error parked unclassified',
      'warning',
      {
        subChatId: 'sub-1',
      },
    );
  });

  it('uses the caller-controlled message for durable and renderer-facing failure sinks', async () => {
    const result = await disposeFlowStreamError(
      'sub-1',
      'opaque SDK detail containing a bearer token',
      undefined,
      { safeErrorMessage: 'Claude execution failed. Please try again.' },
    );

    expect(parkFlowTaskOnClaudeInterruption).toHaveBeenCalledWith('sub-1', {
      kind: 'api-error',
      status: null,
      message: 'Claude execution failed. Please try again.',
    });
    expect(result.reportMessage).toBe('Claude execution failed. Please try again.');
  });

  it('preserves rate-limit classification with a controlled usage-limit message', async () => {
    const result = await disposeFlowStreamError(
      'sub-1',
      "Claude Code returned an error result: You've hit your limit · resets 2:20pm (Europe/London)",
      undefined,
      { safeErrorMessage: 'Claude execution failed. Please try again.' },
    );

    expect(result.isUsageLimit).toBe(true);
    expect(parkFlowTaskOnClaudeInterruption).toHaveBeenCalledWith('sub-1', {
      kind: 'usage-limit',
      limitText: 'Claude usage limit reached. Please try again later.',
    });
    expect(result.reportMessage).toBe('Claude usage limit reached. Please try again later.');
  });
});
