import { describe, expect, it } from 'vitest';
import { executeShellStep, type ShellStepDeps, type ShellStepInput } from './shell-step';

type Executor = ShellStepDeps['executeFlowStepLocal'];
type ExecutorResult = Awaited<ReturnType<Executor>>;

const BASE_INPUT: ShellStepInput = {
  flowRunId: 'fr-1',
  nodeRunId: 'nr-1',
  blockType: 'start_task',
  projectId: 'proj-1',
  branch: 'main',
};

/** A stand-in executor that records what it was called with and returns `result`. */
function recordingExecutor(result: ExecutorResult = { status: 'completed', outputs: {} }) {
  const calls: Parameters<Executor>[] = [];
  const deps: ShellStepDeps = {
    executeFlowStepLocal: async (...args) => {
      calls.push(args);
      return result;
    },
  };
  return { calls, deps };
}

describe('executeShellStep payload', () => {
  // Dispatcher tests replace this module, so nothing else checks what reaches the executor.
  it('forwards baseBranches + mergeStrategy to the executor unchanged', async () => {
    const { calls, deps } = recordingExecutor();

    await executeShellStep(
      { ...BASE_INPUT, baseBranches: ['dep-b', 'dep-a'], mergeStrategy: 'most-recent' },
      new AbortController().signal,
      Date.now(),
      deps,
    );

    expect(calls[0]?.[0]).toMatchObject({
      flowRunId: 'fr-1',
      nodeRunId: 'nr-1',
      blockType: 'start_task',
      projectId: 'proj-1',
      branch: 'main',
      baseBranches: ['dep-b', 'dep-a'],
      mergeStrategy: 'most-recent',
    });
  });

  it('leaves baseBranches + mergeStrategy undefined when the input omits them', async () => {
    const { calls, deps } = recordingExecutor();

    await executeShellStep(BASE_INPUT, new AbortController().signal, Date.now(), deps);

    expect(calls[0]?.[0].baseBranches).toBeUndefined();
    expect(calls[0]?.[0].mergeStrategy).toBeUndefined();
  });

  it("passes the caller's abort signal through", async () => {
    const { calls, deps } = recordingExecutor();
    const { signal } = new AbortController();

    await executeShellStep(BASE_INPUT, signal, Date.now(), deps);

    expect(calls[0]?.[1]).toBe(signal);
  });

  it('defaults timeoutMs to 30 minutes and keeps an explicit one', async () => {
    const { calls, deps } = recordingExecutor();
    const { signal } = new AbortController();

    await executeShellStep(BASE_INPUT, signal, Date.now(), deps);
    await executeShellStep({ ...BASE_INPUT, timeoutMs: 5_000 }, signal, Date.now(), deps);

    expect(calls[0]?.[0].timeoutMs).toBe(30 * 60 * 1000);
    expect(calls[1]?.[0].timeoutMs).toBe(5_000);
  });
});

describe('executeShellStep result', () => {
  it('passes status and outputs through with no error', async () => {
    const { deps } = recordingExecutor({
      status: 'awaiting_input',
      outputs: { mergeConflict: true, conflictingBranch: 'dep-a' },
    });

    const output = await executeShellStep(
      BASE_INPUT,
      new AbortController().signal,
      Date.now(),
      deps,
    );

    expect(output).toMatchObject({
      status: 'awaiting_input',
      outputs: { mergeConflict: true, conflictingBranch: 'dep-a' },
      artifacts: [],
    });
    expect(output.error).toBeUndefined();
  });

  it('measures durationMs from the caller-supplied start time', async () => {
    const { deps } = recordingExecutor();

    const output = await executeShellStep(
      BASE_INPUT,
      new AbortController().signal,
      Date.now() - 5_000,
      deps,
    );

    expect(output.durationMs).toBeGreaterThanOrEqual(5_000);
    expect(output.durationMs).toBeLessThan(60_000);
  });

  // The engine turns a thrown dispatcher into a failed node; a swallowed one would look completed.
  it('lets an executor rejection propagate', async () => {
    const deps: ShellStepDeps = {
      executeFlowStepLocal: async () => {
        throw new Error('spawn failed');
      },
    };

    await expect(
      executeShellStep(BASE_INPUT, new AbortController().signal, Date.now(), deps),
    ).rejects.toThrow('spawn failed');
  });

  it('wraps an executor error as non-retryable', async () => {
    const { deps } = recordingExecutor({ status: 'failed', outputs: {}, error: 'boom' });

    const output = await executeShellStep(
      BASE_INPUT,
      new AbortController().signal,
      Date.now(),
      deps,
    );

    expect(output.status).toBe('failed');
    expect(output.error).toEqual({ message: 'boom', retryable: false });
  });
});
