import { describe, expect, it } from 'vitest';
import { formatFlowBlockTypeLabel } from './format-flow-block-label';

describe('formatFlowBlockTypeLabel', () => {
  it('title-cases snake_case block ids', () => {
    expect(formatFlowBlockTypeLabel('run_command')).toBe('Run Command');
    expect(formatFlowBlockTypeLabel('start_task')).toBe('Start Task');
  });
});
