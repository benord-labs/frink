import { useCallback } from 'react';
import { usePointerDragSession } from '../../../../lib/hooks/use-pointer-drag-session';
import { cn } from '../../../../lib/utils';
import { MIN_PANE_SIZE, snapRatioToGrid } from './resize-utils';

type Corner = 'br' | 'bl' | 'tr' | 'tl';

type GridCornerHandleProps = {
  /** Which corner of the pane (bottom-right, bottom-left, top-right, top-left) — the inner corner at grid center */
  corner: Corner;
  containerRef: React.RefObject<HTMLDivElement | null>;
  gridRatiosRef: React.RefObject<{ rows: number[]; cols: number[] }>;
  onCommit: (rows: number[], cols: number[]) => void;
};

/** Sign for applying pointer delta to grid ratios: newCol0 = startCol0 + signX*deltaX, same for rows.
 *  All corners use signX=1, signY=1 so dragging toward the pane's interior grows that pane. */
function getSigns(_corner: Corner): { signX: number; signY: number } {
  return { signX: 1, signY: 1 };
}

const CORNER_POSITION: Record<Corner, string> = {
  br: 'bottom-0 right-0',
  bl: 'bottom-0 left-0',
  tr: 'top-0 right-0',
  tl: 'top-0 left-0',
};

export function GridCornerHandle({
  corner,
  containerRef,
  gridRatiosRef,
  onCommit,
}: GridCornerHandleProps) {
  const startDragSession = usePointerDragSession();

  const handlePointerDown = useCallback(
    (e: React.PointerEvent<HTMLDivElement>) => {
      startDragSession(e, containerRef, (rect, container) => {
        const { signX, signY } = getSigns(corner);
        const startX = e.clientX;
        const startY = e.clientY;
        const current = gridRatiosRef.current;
        const startRows = [current.rows[0] ?? 0.5, current.rows[1] ?? 0.5];
        const startCols = [current.cols[0] ?? 0.5, current.cols[1] ?? 0.5];

        const minRatio = Math.max(MIN_PANE_SIZE / rect.width, MIN_PANE_SIZE / rect.height);
        // Dead zone is in ratio space, not pixels, and clears when either axis moves far enough.
        let hasMoved = false;
        let finalRows = [...startRows];
        let finalCols = [...startCols];

        return {
          onMove: (ev) => {
            const deltaX = (ev.clientX - startX) / rect.width;
            const deltaY = (ev.clientY - startY) / rect.height;
            if (!hasMoved && Math.abs(deltaX) < 0.005 && Math.abs(deltaY) < 0.005) return;
            hasMoved = true;

            let r0 = startRows[0] + signY * deltaY;
            let c0 = startCols[0] + signX * deltaX;
            r0 = Math.max(minRatio, Math.min(1 - minRatio, r0));
            c0 = Math.max(minRatio, Math.min(1 - minRatio, c0));
            r0 = snapRatioToGrid(r0);
            c0 = snapRatioToGrid(c0);
            finalRows = [r0, 1 - r0];
            finalCols = [c0, 1 - c0];

            container.style.setProperty('--grid-row-0', String(r0));
            container.style.setProperty('--grid-row-1', String(1 - r0));
            container.style.setProperty('--grid-col-0', String(c0));
            container.style.setProperty('--grid-col-1', String(1 - c0));
          },
          onFinish: () => {
            // A plain click never clears the dead zone (hasMoved stays false); don't commit —
            // that would fire a redundant persist/re-render with the ratios unchanged.
            if (hasMoved) onCommit(finalRows, finalCols);
          },
        };
      });
    },
    [corner, containerRef, gridRatiosRef, onCommit, startDragSession],
  );

  // Mouse-only shortcut, intentionally not exposed to assistive tech or the tab order: both axes
  // are already reachable via the focusable, keyboard-operable GridDividers. A non-focusable
  // role="separator" cannot carry aria-value*, so announcing one here would only mislead.
  return (
    <div
      className={cn(
        'absolute z-20 w-3 h-3 rounded-sm border border-border bg-muted/80 hover:bg-muted',
        'cursor-nwse-resize',
        CORNER_POSITION[corner],
        corner === 'bl' && 'cursor-nesw-resize',
        corner === 'tr' && 'cursor-nesw-resize',
      )}
      style={{ touchAction: 'none' }}
      onPointerDown={handlePointerDown}
    />
  );
}
