import { describe, expect, it } from 'vitest';
import { dispatchCondition } from './condition';

// Condition must pass upstream outputs through (matching cloud's dispatchCondition) so
// {{previous.<upstreamField>}} still resolves after a condition node — otherwise it silently
// renders as the literal, unresolved placeholder.
function ctx(over: Record<string, unknown> = {}) {
  return {
    flowRunId: 'fr1',
    nodeRunId: 'nr1',
    userId: 'u1',
    node: {
      id: 'cond',
      blockType: 'condition',
      config: { predicate: { field: 'exitCode', operator: 'eq', value: 0 } },
    },
    previousOutput: {
      status: 'completed',
      outputs: { exitCode: 0, message: 'hello' },
      artifacts: [],
      durationMs: 0,
    },
    triggerContext: null,
    loopContext: undefined,
    parsedGraph: { nodes: [], edges: [] },
    signal: new AbortController().signal,
    ...over,
  };
}

describe('dispatchCondition — upstream pass-through', () => {
  it('spreads the predecessor outputs alongside result/passed on the true branch', async () => {
    const res = await dispatchCondition(ctx() as never);
    expect(res.type).toBe('completed');
    const outputs = (res as { output: { outputs: Record<string, unknown> } }).output.outputs;
    expect(outputs.message).toBe('hello');
    expect(outputs.exitCode).toBe(0);
    expect(outputs.result).toBe('continue');
    expect(outputs.passed).toBe(true);
  });

  it('spreads the predecessor outputs on the false/stop branch too', async () => {
    const res = await dispatchCondition(
      ctx({
        node: {
          id: 'cond',
          blockType: 'condition',
          config: { predicate: { field: 'exitCode', operator: 'eq', value: 1 } },
        },
      }) as never,
    );
    const outputs = (res as { output: { outputs: Record<string, unknown> } }).output.outputs;
    expect(outputs.message).toBe('hello');
    expect(outputs.result).toBe('stop');
    expect(outputs.passed).toBe(false);
  });

  it('own result/passed win over a same-named upstream field', async () => {
    const res = await dispatchCondition(
      ctx({
        previousOutput: {
          status: 'completed',
          outputs: { exitCode: 0, result: 'upstream-value', passed: 'upstream-value' },
          artifacts: [],
          durationMs: 0,
        },
      }) as never,
    );
    const outputs = (res as { output: { outputs: Record<string, unknown> } }).output.outputs;
    expect(outputs.result).toBe('continue');
    expect(outputs.passed).toBe(true);
  });

  it('produces just result/passed with no predecessor (undefined previousOutput)', async () => {
    const res = await dispatchCondition(ctx({ previousOutput: undefined }) as never);
    const outputs = (res as { output: { outputs: Record<string, unknown> } }).output.outputs;
    expect(outputs).toEqual({ result: 'stop', passed: false });
  });
});
