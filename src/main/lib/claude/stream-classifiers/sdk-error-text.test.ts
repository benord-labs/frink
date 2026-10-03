import { describe, expect, it } from 'vitest';
import type { SDKMessage } from '@anthropic-ai/claude-agent-sdk';
import { claudeErrorText, failedResultError } from './sdk-error-text';

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

describe('failedResultError', () => {
  const result = (fields: Record<string, unknown>) =>
    ({ type: 'result', is_error: true, ...fields }) as unknown as SDKMessage;

  it('carries the joined errors the SDK would throw with', () => {
    const msg = result({
      subtype: 'error_during_execution',
      errors: [' No conversation found with session ID: s-1 ', '', 'second'],
    });
    expect(failedResultError(msg)?.message).toBe(
      'Claude Code returned an error result: No conversation found with session ID: s-1; second',
    );
  });

  it('names the subtype when the errors are empty', () => {
    expect(failedResultError(result({ subtype: 'error_max_turns', errors: [] }))?.message).toBe(
      'Claude Code returned an error result: error_max_turns',
    );
  });

  it.each([
    ['a success', result({ subtype: 'success', is_error: false, result: 'done' })],
    ['an is_error success', result({ subtype: 'success', result: "You've hit your limit" })],
    ['an unflagged error subtype', result({ subtype: 'error_during_execution', is_error: false })],
    ['a non-result frame', { type: 'assistant' } as unknown as SDKMessage],
  ])('is undefined for %s', (_label, msg) => {
    expect(failedResultError(msg)).toBeUndefined();
  });
});
