import { describe, expect, it } from 'vitest';
import { claudeErrorText } from './sdk-error-text';

describe('claudeErrorText', () => {
  it.each([
    [
      'exit code',
      'Claude Code process exited with code 1. stderr: AbortError: The operation was aborted',
      'Claude Code process exited with code 1',
    ],
    [
      'signal',
      'Claude Code process terminated by signal SIGKILL. stderr: aborted by user',
      'Claude Code process terminated by signal SIGKILL',
    ],
    [
      'nested write error',
      'Cannot write to process that exited with error: Claude Code process exited with code 1. stderr: token=secret',
      'Cannot write to process that exited with error: Claude Code process exited with code 1',
    ],
    [
      'multi-line tail',
      "Claude Code process exited with code 2. stderr: line one\nYou've hit your limit · resets 3pm\n  at x",
      'Claude Code process exited with code 2',
    ],
  ])('removes the %s stderr tail', (_label, input, expected) => {
    expect(claudeErrorText(new Error(input))).toBe(expected);
  });

  it.each([
    'Claude Code process exited with code 1',
    'Claude Code returned an error result: API Error: 500. stderr: x',
    'The operation was aborted',
  ])('leaves %j unchanged', (input) => {
    expect(claudeErrorText(new Error(input))).toBe(input);
  });

  it('handles a non-Error value', () => {
    expect(claudeErrorText('Claude Code process terminated by signal SIGTERM. stderr: x')).toBe(
      'Claude Code process terminated by signal SIGTERM',
    );
    expect(claudeErrorText(42)).toBe('42');
  });
});
