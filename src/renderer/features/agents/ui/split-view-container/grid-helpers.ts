import type React from 'react';
import { getDefaultGridRatios, type SplitLayout } from '../../atoms';

/**
 * Compute CSS grid template for 3+ pane layouts.
 * Uses CSS custom properties (--grid-row-0, --grid-col-0, etc.) so dividers can update
 * them during drag without React state. Includes 1px divider tracks; do not use fr units.
 */
export function getGridStyle(
  layout: SplitLayout,
  paneCount: number,
  gridRatios?: { rows: number[]; cols: number[] } | null,
): React.CSSProperties {
  void (gridRatios ?? getDefaultGridRatios()); // container sets CSS vars from gridRatios
  // Subtract the 1px gutter so columns/rows sum to 100% (avoids 100%+1px overflow clipping right/bottom borders).
  const colTpl = `calc((100% - 1px) * var(--grid-col-0)) 1px calc((100% - 1px) * var(--grid-col-1))`;
  const rowTpl = `calc((100% - 1px) * var(--grid-row-0)) 1px calc((100% - 1px) * var(--grid-row-1))`;

  switch (layout) {
    case 'three-bottom':
      return { gridTemplateColumns: colTpl, gridTemplateRows: rowTpl };
    case 'three-right':
      return { gridTemplateColumns: colTpl, gridTemplateRows: rowTpl };
    case 'grid':
      return {
        gridTemplateColumns: colTpl,
        gridTemplateRows: paneCount <= 2 ? '1fr' : rowTpl,
      };
    default:
      return {};
  }
}

/** Grid line placement for content panes (3 columns × 3 rows: content, 1px, content). */
export function getGridPanePlacement(
  layout: SplitLayout,
  index: number,
): { gridColumn: string; gridRow: string } {
  switch (layout) {
    case 'three-bottom':
      // Row 0: panes 0, 1 (cols 1–2, 3–4). Row 2: pane 2 (cols 1–4).
      if (index === 0) return { gridColumn: '1 / 2', gridRow: '1 / 2' };
      if (index === 1) return { gridColumn: '3 / 4', gridRow: '1 / 2' };
      if (index === 2) return { gridColumn: '1 / -1', gridRow: '3 / 4' };
      break;
    case 'three-right':
      // Col 0: panes 0, 1 (rows 1–2, 3–4). Col 2: pane 2 (rows 1–4).
      if (index === 0) return { gridColumn: '1 / 2', gridRow: '1 / 2' };
      if (index === 1) return { gridColumn: '1 / 2', gridRow: '3 / 4' };
      if (index === 2) return { gridColumn: '3 / -1', gridRow: '1 / -1' };
      break;
    case 'grid':
      // 2×2 content cells at (1,1), (3,1), (1,3), (3,3).
      if (index === 0) return { gridColumn: '1 / 2', gridRow: '1 / 2' };
      if (index === 1) return { gridColumn: '3 / 4', gridRow: '1 / 2' };
      if (index === 2) return { gridColumn: '1 / 2', gridRow: '3 / 4' };
      if (index === 3) return { gridColumn: '3 / 4', gridRow: '3 / 4' };
      break;
    default:
      break;
  }
  return { gridColumn: '1 / -1', gridRow: '1 / -1' };
}

const GRID_AREA_MAP: Record<string, string[]> = {
  'three-bottom': ['a', 'b', 'c'],
  'three-right': ['a', 'b', 'c'],
};

/** Legacy: named grid area for 3-pane (used by GridPane for aria-label). */
export function getGridArea(layout: SplitLayout, index: number): string | undefined {
  return GRID_AREA_MAP[layout]?.[index];
}

/** Which corner of a pane is the "inner" corner (at grid center) for corner-drag resize. Only for 4-pane grid. */
export function getGridPaneResizeCorner(
  layout: SplitLayout,
  paneIndex: number,
): 'br' | 'bl' | 'tr' | 'tl' | null {
  if (layout !== 'grid') return null;
  // 2x2: pane 0 top-left (inner=br), 1 top-right (inner=bl), 2 bottom-left (inner=tr), 3 bottom-right (inner=tl)
  const map: ('br' | 'bl' | 'tr' | 'tl')[] = ['br', 'bl', 'tr', 'tl'];
  return map[paneIndex] ?? null;
}

/** Outer border-radius only (avoids inner rounded corners at grid seams). */
export function getGridPaneOuterCornerClass(
  layout: SplitLayout,
  index: number,
  totalPanes: number,
): string {
  if (totalPanes <= 1) return 'rounded-(--pane-outer-radius)';
  switch (layout) {
    case 'three-bottom':
      if (index === 0) return 'rounded-tl-(--pane-outer-radius)';
      if (index === 1) return 'rounded-tr-(--pane-outer-radius)';
      if (index === 2) return 'rounded-b-(--pane-outer-radius)';
      return '';
    case 'three-right':
      if (index === 0) return 'rounded-tl-(--pane-outer-radius)';
      if (index === 1) return 'rounded-bl-(--pane-outer-radius)';
      if (index === 2) return 'rounded-r-(--pane-outer-radius)';
      return '';
    case 'grid':
      if (totalPanes >= 4) {
        if (index === 0) return 'rounded-tl-(--pane-outer-radius)';
        if (index === 1) return 'rounded-tr-(--pane-outer-radius)';
        if (index === 2) return 'rounded-bl-(--pane-outer-radius)';
        if (index === 3) return 'rounded-br-(--pane-outer-radius)';
      }
      return 'rounded-(--pane-outer-radius)';
    default:
      return 'rounded-lg';
  }
}

/** Placement for grid dividers (1px tracks). Vertical divider resizes cols; horizontal resizes rows. */
export function getGridDividerPlacements(layout: SplitLayout): {
  vertical: { gridColumn: string; gridRow: string };
  horizontal: { gridColumn: string; gridRow: string };
} {
  switch (layout) {
    case 'three-bottom':
      return {
        vertical: { gridColumn: '2', gridRow: '1 / 2' },
        horizontal: { gridRow: '2', gridColumn: '1 / -1' },
      };
    case 'three-right':
      return {
        horizontal: { gridRow: '2', gridColumn: '1 / 2' },
        vertical: { gridColumn: '2', gridRow: '1 / -1' },
      };
    case 'grid':
      return {
        vertical: { gridColumn: '2', gridRow: '1 / -1' },
        horizontal: { gridRow: '2', gridColumn: '1 / -1' },
      };
    default:
      return {
        vertical: { gridColumn: '2', gridRow: '1 / -1' },
        horizontal: { gridRow: '2', gridColumn: '1 / -1' },
      };
  }
}
