/** Minimum pane dimension in px (width or height) for linear and grid resize. */
export const MIN_PANE_SIZE = 200;

/** Grid positions to snap to (equal splits and common fractions). */
const SNAP_GRID = [1 / 4, 1 / 3, 1 / 2, 2 / 3, 3 / 4];

/** Default distance (in ratio units) within which we snap to a grid value. */
const DEFAULT_SNAP_THRESHOLD = 0.04;

/**
 * Snap a ratio in (0, 1) to the nearest grid value (e.g. 0.25, 0.33, 0.5, 0.67, 0.75)
 * when within threshold. Otherwise return the value unchanged.
 */
export function snapRatioToGrid(value: number, threshold: number = DEFAULT_SNAP_THRESHOLD): number {
  for (const grid of SNAP_GRID) {
    if (Math.abs(value - grid) <= threshold) return grid;
  }
  return value;
}

/**
 * Clamp and snap a 2-pane split while preserving the combined ratio.
 * Returns [first, second] where both are >= minRatio and first may be snapped.
 *
 * Pass `snap: false` for discrete steps such as keyboard resize. Snapping is drag magnetism, and
 * the grid radius (0.04) is wider than one keyboard step (0.02) — left on, every step taken from a
 * grid value is pulled straight back to it and the divider cannot be moved by keyboard at all.
 */
export function normalizeTwoPaneRatios(
  candidateFirst: number,
  combined: number,
  minRatio: number,
  snap = true,
): [number, number] {
  let first = candidateFirst;
  let second = combined - first;

  if (first < minRatio) {
    first = minRatio;
    second = combined - minRatio;
  }
  if (second < minRatio) {
    second = minRatio;
    first = combined - minRatio;
  }

  if (snap) {
    // Only accept the snap when it keeps BOTH panes at or above the floor: a small container can
    // push minRatio past a grid gap, so snapping could otherwise pull a pane back below minRatio
    // and break the [first, second] >= minRatio invariant.
    const snappedFirst = snapRatioToGrid(first);
    if (snappedFirst >= minRatio && combined - snappedFirst >= minRatio) {
      first = snappedFirst;
      second = combined - snappedFirst;
    }
  }
  return [first, second];
}
