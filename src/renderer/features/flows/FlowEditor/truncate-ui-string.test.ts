import { describe, expect, it } from 'vitest';
import { truncateUiString } from './truncate-ui-string';

describe('truncateUiString', () => {
  it('returns unchanged when within max', () => {
    expect(truncateUiString('hi', 10)).toBe('hi');
  });

  it('truncates with ellipsis when over max', () => {
    expect(truncateUiString('abcdef', 4)).toBe('abc…');
  });
});
