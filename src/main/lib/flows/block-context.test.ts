import { describe, expect, it } from 'vitest';
import type { NodeOutput } from '../../../shared/types/flow';
import { buildVariables } from './block-context';

// sc-1501: `previous` must be the predecessor's flat outputs bag, matching the
// cloud engine's contract (previous: previousNodeOutput?.outputs ?? {}) — not a
// {status, outputs} wrapper, which made every {{previous.<field>}} unresolvable.
describe('buildVariables — previous context shape', () => {
  it('exposes the predecessor outputs flat, not wrapped in {status, outputs}', () => {
    const previousOutput: NodeOutput = {
      status: 'completed',
      outputs: { message: 'hello world', locationName: 'Riberalta' },
      artifacts: [],
      durationMs: 12,
    };

    const variables = buildVariables({
      triggerContext: null,
      previousOutput,
    });

    expect(variables.previous).toEqual({ message: 'hello world', locationName: 'Riberalta' });
  });

  it('resolves the same way regardless of predecessor block type (custom node vs run_command)', () => {
    const customNodeOutput: NodeOutput = {
      status: 'completed',
      outputs: { latitude: -10.9, exitCode: 0 },
      artifacts: [],
      durationMs: 5,
    };
    const runCommandOutput: NodeOutput = {
      status: 'completed',
      outputs: { count: 42, exitCode: 0 },
      artifacts: [],
      durationMs: 5,
    };

    expect(
      buildVariables({ triggerContext: null, previousOutput: customNodeOutput }).previous,
    ).toEqual({ latitude: -10.9, exitCode: 0 });
    expect(
      buildVariables({ triggerContext: null, previousOutput: runCommandOutput }).previous,
    ).toEqual({
      count: 42,
      exitCode: 0,
    });
  });

  it('omits `previous` entirely when there is no predecessor (e.g. the first node after a trigger)', () => {
    const variables = buildVariables({ triggerContext: null, previousOutput: undefined });

    expect(variables.previous).toBeUndefined();
  });

  it('resolves to an empty object when the predecessor produced no outputs', () => {
    const previousOutput: NodeOutput = {
      status: 'completed',
      outputs: {},
      artifacts: [],
      durationMs: 1,
    };

    const variables = buildVariables({ triggerContext: null, previousOutput });

    expect(variables.previous).toEqual({});
  });
});
