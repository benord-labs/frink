import { describe, expect, it } from 'vitest';
import { computeVisibleFrom } from './index';

describe('computeVisibleFrom', () => {
  it('keeps every item when they all fit without a more control', () => {
    expect(computeVisibleFrom([100, 120], 228, 28, 8)).toBe(0);
  });

  it('hides from the left and reserves room for the more control', () => {
    // 120 alone fits in 160; 100 + 8 + 120 does not, and neither does 120 + 8 + 28 in 150.
    expect(computeVisibleFrom([100, 120], 160, 28, 8)).toBe(1);
    expect(computeVisibleFrom([100, 120], 150, 28, 8)).toBe(2);
  });

  it('hides everything when even the last item cannot sit beside the more control', () => {
    expect(computeVisibleFrom([100, 120], 100, 28, 8)).toBe(2);
  });
});
