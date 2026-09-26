import { describe, expect, it } from 'vitest';
import { describeFlowNodeConfigChange } from './flow-change-config-detail';

describe('describeFlowNodeConfigChange', () => {
  it('names known safe facets without returning values', () => {
    const detail = describeFlowNodeConfigChange({
      instructions: 'PRIVATE-INSTRUCTIONS',
      agentInstructions: 'PRIVATE-ROLE',
      model: 'PRIVATE-MODEL',
      fireAndForget: true,
    });

    expect(detail).toBe('Instructions · Agent role · Model · Completion behavior');
    expect(detail).not.toContain('PRIVATE-');
  });

  it('deduplicates aliases and keeps unknown keys opaque', () => {
    expect(
      describeFlowNodeConfigChange({
        instructions: 'secret',
        instructionsCommandName: 'secret-command',
      }),
    ).toBe('Instructions');

    expect(
      describeFlowNodeConfigChange({
        instructions: 'secret',
        instructionsCommandName: 'secret-command',
        apiToken: 'secret-token',
      }),
    ).toBe('Instructions · Other step setup');
  });

  it('falls back safely for empty and malformed configuration', () => {
    expect(describeFlowNodeConfigChange({})).toBe('Step setup');
    expect(describeFlowNodeConfigChange('not-an-object')).toBe('Step setup');
  });
});
