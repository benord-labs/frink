import { describe, expect, it } from 'vitest';
import { normalizeTwoPaneRatios, snapRatioToGrid } from './resize-utils';

describe('snapRatioToGrid', () => {
  it.each([
    [0.26, 1 / 4],
    [0.52, 1 / 2],
    [0.65, 2 / 3],
  ])('pulls %s onto the nearest grid fraction', (value, expected) => {
    expect(snapRatioToGrid(value)).toBeCloseTo(expected, 5);
  });

  it('leaves a ratio outside every snap radius untouched', () => {
    expect(snapRatioToGrid(0.58)).toBe(0.58);
  });

  // Exact-threshold comparison is not meaningful in binary floating point (0.54 - 0.5 evaluates
  // to 0.04000000000000004, just over), so bracket the boundary instead of sitting on it.
  it('snaps just inside the threshold but not just outside', () => {
    expect(snapRatioToGrid(0.535)).toBeCloseTo(0.5, 5);
    expect(snapRatioToGrid(0.545)).toBe(0.545);
  });

  it('honours a caller-supplied threshold', () => {
    expect(snapRatioToGrid(0.52, 0.01)).toBe(0.52);
  });
});

describe('normalizeTwoPaneRatios', () => {
  it('preserves the combined ratio when clamping the leading pane', () => {
    const [first, second] = normalizeTwoPaneRatios(0.05, 1, 0.2, false);

    expect(first).toBeCloseTo(0.2, 5);
    expect(first + second).toBeCloseTo(1, 5);
  });

  it('preserves the combined ratio when clamping the trailing pane', () => {
    const [first, second] = normalizeTwoPaneRatios(0.95, 1, 0.2, false);

    expect(second).toBeCloseTo(0.2, 5);
    expect(first + second).toBeCloseTo(1, 5);
  });

  it('preserves a combined ratio that is only part of the container', () => {
    // Two adjacent panes in a 3-pane split share 0.6 between them.
    const [first, second] = normalizeTwoPaneRatios(0.5, 0.6, 0.1, false);

    expect(first + second).toBeCloseTo(0.6, 5);
  });

  it('returns the exact candidate when snapping is disabled', () => {
    const [first] = normalizeTwoPaneRatios(0.52, 1, 0.2, false);

    expect(first).toBe(0.52);
  });

  it('snaps the candidate by default', () => {
    const [first] = normalizeTwoPaneRatios(0.52, 1, 0.2);

    expect(first).toBeCloseTo(0.5, 5);
  });

  // A keyboard step is 0.02 and the snap radius is 0.04, so snapped stepping from a grid value
  // never escapes it. This is what makes arrow-key resize a no-op if snapping is left on.
  it('lets a keyboard-sized step leave a grid value when snapping is disabled', () => {
    const [snapped] = normalizeTwoPaneRatios(0.5 + 0.02, 1, 0.2);
    const [stepped] = normalizeTwoPaneRatios(0.5 + 0.02, 1, 0.2, false);

    expect(snapped).toBeCloseTo(0.5, 5);
    expect(stepped).toBeCloseTo(0.52, 5);
  });

  // A small container can push minRatio (0.35) past a grid gap: snapping 0.36 → 1/3 would drop the
  // pane below the floor. The snap must be skipped when it would break the >= minRatio invariant.
  it('does not let snapping push a pane below the floor', () => {
    const minRatio = 0.35;
    const [first, second] = normalizeTwoPaneRatios(0.36, 1, minRatio);

    expect(first).toBeGreaterThanOrEqual(minRatio);
    expect(second).toBeGreaterThanOrEqual(minRatio);
  });
});
