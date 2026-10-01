import { describe, expect, it } from 'vitest';
import { formatElapsedTime } from './format-elapsed-time';

describe('formatElapsedTime', () => {
  it.each([
    [999, ''],
    [1_000, '1s'],
    [59_999, '59s'],
    [180_000, '3m'],
    [192_500, '3m 12s'],
  ])('%i ms reads %s', (ms, text) => {
    expect(formatElapsedTime(ms)).toBe(text);
  });
});
