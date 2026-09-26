import { useCallback } from 'react';
import {
  ContextMenu,
  ContextMenuContent,
  ContextMenuItem,
  ContextMenuTrigger,
} from '../../../../components/ui/context-menu';
import { usePointerDragSession } from '../../../../lib/hooks/use-pointer-drag-session';
import { perfMark } from '../../../../lib/perf/marks';
import { cn } from '../../../../lib/utils';
import { MIN_PANE_SIZE, normalizeTwoPaneRatios } from './resize-utils';

type GridDividerProps = {
  /** 'horizontal' = divider is horizontal, resizes rows (Up/Down arrows). 'vertical' = resizes cols (Left/Right). */
  orientation: 'horizontal' | 'vertical';
  containerRef: React.RefObject<HTMLDivElement | null>;
  gridRatiosRef: React.RefObject<{ rows: number[]; cols: number[] }>;
  onCommit: (rows: number[], cols: number[]) => void;
  onResetToEqual: () => void;
  /** Grid placement so this divider sits in the 1px track */
  placement: { gridColumn: string; gridRow: string };
};

export function GridDivider({
  orientation,
  containerRef,
  gridRatiosRef,
  onCommit,
  onResetToEqual,
  placement,
}: GridDividerProps) {
  const startDragSession = usePointerDragSession();

  const isVertical = orientation === 'vertical';
  const resizeAxis = isVertical ? 'cols' : 'rows';

  const handlePointerDown = useCallback(
    (e: React.PointerEvent<HTMLDivElement>) => {
      startDragSession(e, containerRef, (rect, container) => {
        const containerSize = isVertical ? rect.width : rect.height;
        const startPos = isVertical ? e.clientX : e.clientY;
        const current = gridRatiosRef.current;
        const startRatios = isVertical
          ? [current.cols[0] ?? 0.5, current.cols[1] ?? 0.5]
          : [current.rows[0] ?? 0.5, current.rows[1] ?? 0.5];
        const combined = startRatios[0] + startRatios[1];

        const minRatio = MIN_PANE_SIZE / containerSize;
        let hasMoved = false;
        let finalFirst = startRatios[0];
        let finalSecond = startRatios[1];

        return {
          onMove: (ev) => {
            const pos = isVertical ? ev.clientX : ev.clientY;
            const delta = pos - startPos;
            if (!hasMoved && Math.abs(delta) < 3) return;
            if (!hasMoved)
              perfMark('pane:resize-start', { axis: isVertical ? 'cols' : 'rows', panes: 4 });
            hasMoved = true;

            const deltaRatio = delta / containerSize;
            const [newFirst, newSecond] = normalizeTwoPaneRatios(
              startRatios[0] + deltaRatio,
              combined,
              minRatio,
            );
            finalFirst = newFirst;
            finalSecond = newSecond;

            if (isVertical) {
              container.style.setProperty('--grid-col-0', String(newFirst));
              container.style.setProperty('--grid-col-1', String(newSecond));
            } else {
              container.style.setProperty('--grid-row-0', String(newFirst));
              container.style.setProperty('--grid-row-1', String(newSecond));
            }
          },
          onFinish: () => {
            if (hasMoved)
              perfMark('pane:resize-end', { axis: isVertical ? 'cols' : 'rows', panes: 4 });
            const next = { ...gridRatiosRef.current };
            if (isVertical) {
              next.cols = [finalFirst, finalSecond];
            } else {
              next.rows = [finalFirst, finalSecond];
            }
            onCommit(next.rows, next.cols);
          },
        };
      });
    },
    [isVertical, containerRef, gridRatiosRef, onCommit, startDragSession],
  );

  const handleKeyDown = useCallback(
    (e: React.KeyboardEvent) => {
      const step = 0.02;
      const growKey = isVertical ? 'ArrowRight' : 'ArrowDown';
      const shrinkKey = isVertical ? 'ArrowLeft' : 'ArrowUp';

      if (e.key === growKey || e.key === shrinkKey) {
        e.preventDefault();
        const current = gridRatiosRef.current;
        const arr = resizeAxis === 'cols' ? [...current.cols] : [...current.rows];
        const delta = e.key === growKey ? step : -step;
        const container = containerRef.current;
        const size = container
          ? isVertical
            ? container.getBoundingClientRect().width
            : container.getBoundingClientRect().height
          : 800;
        const minRatio = MIN_PANE_SIZE / size;
        const combined = (arr[0] ?? 0.5) + (arr[1] ?? 0.5);
        const [newFirst, newSecond] = normalizeTwoPaneRatios(
          (arr[0] ?? 0.5) + delta,
          combined,
          minRatio,
          false,
        );
        arr[0] = newFirst;
        arr[1] = newSecond;
        const next = { ...current };
        if (resizeAxis === 'cols') next.cols = arr;
        else next.rows = arr;
        onCommit(next.rows, next.cols);
      } else if (e.key === 'Enter' || e.key === ' ') {
        e.preventDefault();
        onResetToEqual();
      }
    },
    [isVertical, containerRef, gridRatiosRef, onCommit, onResetToEqual, resizeAxis],
  );

  const currentVal =
    resizeAxis === 'cols'
      ? Math.round((gridRatiosRef.current?.cols[0] ?? 0.5) * 100)
      : Math.round((gridRatiosRef.current?.rows[0] ?? 0.5) * 100);

  return (
    <ContextMenu>
      <ContextMenuTrigger asChild>
        <div
          className={cn('relative z-10 bg-border', isVertical ? 'w-px' : 'h-px')}
          style={placement}
        >
          {/* biome-ignore lint/a11y/useSemanticElements: custom resize handle, not a standard separator */}
          <div
            role="separator"
            aria-orientation={isVertical ? 'vertical' : 'horizontal'}
            aria-valuenow={currentVal}
            aria-valuemin={0}
            aria-valuemax={100}
            aria-label={
              isVertical
                ? 'Resize columns. Use Left/Right arrows to resize, Enter to reset to equal.'
                : 'Resize rows. Use Up/Down arrows to resize, Enter to reset to equal.'
            }
            tabIndex={0}
            className={cn(
              'absolute cursor-col-resize',
              isVertical
                ? 'top-0 bottom-0 left-[-4px] w-[9px]'
                : 'left-0 right-0 top-[-4px] h-[9px] cursor-row-resize',
            )}
            style={{ touchAction: 'none' }}
            onPointerDown={handlePointerDown}
            onKeyDown={handleKeyDown}
          />
        </div>
      </ContextMenuTrigger>
      <ContextMenuContent className="w-48">
        <ContextMenuItem onClick={onResetToEqual}>Reset to equal sizes</ContextMenuItem>
      </ContextMenuContent>
    </ContextMenu>
  );
}
