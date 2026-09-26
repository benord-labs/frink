import { describe, expect, it } from 'vitest';
import { isValidTaskStatus } from './task-status';

describe('isValidTaskStatus', () => {
  it.each([
    'pending',
    'running',
    'plan_ready',
    'needs_attention',
    'done',
    'completed',
    'failed',
    'cancelled',
  ] as const)('accepts canonical status "%s"', (status) => {
    expect(isValidTaskStatus(status)).toBe(true);
  });

  it.each([
    ['', 'empty string'],
    ['bogus_status', 'unknown token'],
    ['Done', 'wrong case'],
    ['done ', 'trailing space'],
    [' running', 'leading space'],
    ['awaiting_input', 'non-task status string'],
  ])('rejects invalid value (%s) — %s', (value, _desc) => {
    expect(isValidTaskStatus(value)).toBe(false);
  });
});
