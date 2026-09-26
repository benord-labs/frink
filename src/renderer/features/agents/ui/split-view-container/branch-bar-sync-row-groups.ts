import type { SplitLayout } from '../../atoms';

/**
 * Footer height sync is scoped to a "row band" so e.g. 2×2 grids only align top panes with
 * each other and bottom panes with each other — not one global max across all panes.
 *
 * - `horizontal` (linear): one row → single group.
 * - `vertical` (linear): one column → single group (all footers match).
 * - `grid` with 4 panes: 2×2 → top row (0,1) vs bottom row (2,3).
 * - `three-bottom`: top pair (0,1) vs full-width bottom (2).
 * - `three-right` and other cases: single group (same as global max).
 */
export function getBranchBarSyncRowGroup(
  layout: SplitLayout,
  paneIndex: number,
  paneCount: number,
): number {
  switch (layout) {
    case 'horizontal':
    case 'vertical':
      return 0;
    case 'grid':
      if (paneCount >= 4 && paneIndex >= 0 && paneIndex < 4) {
        return paneIndex < 2 ? 0 : 1;
      }
      return 0;
    case 'three-bottom':
      if (paneCount === 3 && paneIndex >= 0 && paneIndex < 3) {
        return paneIndex === 2 ? 1 : 0;
      }
      return 0;
    default:
      return 0;
  }
}

/** Max height among panes in the same sync row group as `targetPaneIndex`. */
export function maxBranchBarHeightsInGroup(
  heights: Record<number, number>,
  layout: SplitLayout,
  paneCount: number,
  targetPaneIndex: number,
): number {
  const g = getBranchBarSyncRowGroup(layout, targetPaneIndex, paneCount);
  let m = 0;
  for (const [key, h] of Object.entries(heights)) {
    const idx = Number(key);
    if (getBranchBarSyncRowGroup(layout, idx, paneCount) === g) {
      m = Math.max(m, h);
    }
  }
  return m;
}
