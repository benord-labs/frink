import { useCallback, useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import {
  ContextMenu,
  ContextMenuContent,
  ContextMenuItem,
  ContextMenuTrigger,
} from '../../../../components/ui/context-menu';
import { usePointerDragSession } from '../../../../lib/hooks/use-pointer-drag-session';
import { perfMark } from '../../../../lib/perf/marks';
import { overlayGlass } from '@/lib/overlay-styles';
import { cn } from '../../../../lib/utils';
import { MIN_PANE_SIZE, normalizeTwoPaneRatios } from './resize-utils';

type SplitDividerProps = {
  index: number;
  isVertical: boolean;
  containerRef: React.RefObject<HTMLDivElement | null>;
  ratiosRef: React.RefObject<number[]>;
  onCommitRatios: (ratios: number[]) => void;
  onCloseSplit: () => void;
};

export function SplitDivider({
  index,
  isVertical,
  containerRef,
  ratiosRef,
  onCommitRatios,
  onCloseSplit,
}: SplitDividerProps) {
  const [isResizing, setIsResizing] = useState(false);
  const [isHovering, setIsHovering] = useState(false);
  const [tooltipPos, setTooltipPos] = useState<{ x: number; y: number } | null>(null);
  const handleRef = useRef<HTMLDivElement>(null);
  const tooltipTimeoutRef = useRef<NodeJS.Timeout | null>(null);
  const startDragSession = usePointerDragSession();

  useEffect(() => {
    return () => {
      if (tooltipTimeoutRef.current) {
        clearTimeout(tooltipTimeoutRef.current);
        tooltipTimeoutRef.current = null;
      }
    };
  }, []);

  const handlePointerDown = useCallback(
    (event: React.PointerEvent<HTMLDivElement>) => {
      startDragSession(event, containerRef, (rect, container) => {
        const containerSize = isVertical ? rect.height : rect.width;
        const startPos = isVertical ? event.clientY : event.clientX;
        const startRatios = [...(ratiosRef.current ?? [])];

        if (tooltipTimeoutRef.current) {
          clearTimeout(tooltipTimeoutRef.current);
          tooltipTimeoutRef.current = null;
        }
        setIsResizing(true);
        setIsHovering(false);
        setTooltipPos(null);

        // Doubles as click-vs-drag discrimination: a pointerup with no movement means "close split".
        let hasMoved = false;
        let finalRatios = startRatios;

        const minRatio = MIN_PANE_SIZE / containerSize;
        const combined = (startRatios[index] ?? 0) + (startRatios[index + 1] ?? 0);

        return {
          onMove: (e) => {
            const currentPos = isVertical ? e.clientY : e.clientX;
            const delta = currentPos - startPos;
            if (!hasMoved && Math.abs(delta) < 3) return;
            if (!hasMoved)
              perfMark('pane:resize-start', { divider: index, panes: startRatios.length });
            hasMoved = true;

            const deltaRatio = delta / containerSize;
            const [newFirst, newSecond] = normalizeTwoPaneRatios(
              (startRatios[index] ?? 0) + deltaRatio,
              combined,
              minRatio,
            );

            const newRatios = [...startRatios];
            newRatios[index] = newFirst;
            newRatios[index + 1] = newSecond;
            finalRatios = newRatios;
            // Update CSS vars on container so pane sizes change without React re-render (avoids resize lag)
            container.style.setProperty(`--pane-${index}`, String(newFirst));
            container.style.setProperty(`--pane-${index + 1}`, String(newSecond));
          },
          onFinish: () => {
            setIsResizing(false);

            if (!hasMoved) {
              onCloseSplit();
            } else {
              perfMark('pane:resize-end', { divider: index, panes: startRatios.length });
              onCommitRatios(finalRatios);
            }
          },
        };
      });
    },
    [index, isVertical, containerRef, ratiosRef, onCommitRatios, onCloseSplit, startDragSession],
  );

  const handleMouseEnter = useCallback(
    (e: React.MouseEvent) => {
      if (isResizing) return;
      if (tooltipTimeoutRef.current) clearTimeout(tooltipTimeoutRef.current);
      const y = e.clientY;
      tooltipTimeoutRef.current = setTimeout(() => {
        if (handleRef.current) {
          const rect = handleRef.current.getBoundingClientRect();
          setTooltipPos({ x: rect.right + 8, y });
        }
        setIsHovering(true);
      }, 300);
    },
    [isResizing],
  );

  const handleMouseLeave = useCallback(() => {
    if (isResizing) return;
    if (tooltipTimeoutRef.current) {
      clearTimeout(tooltipTimeoutRef.current);
      tooltipTimeoutRef.current = null;
    }
    setIsHovering(false);
    setTooltipPos(null);
  }, [isResizing]);

  // Keyboard support: arrow keys to resize, Enter/Space to close split
  const handleKeyDown = useCallback(
    (e: React.KeyboardEvent) => {
      const step = 0.02; // 2% per keypress
      const growKey = isVertical ? 'ArrowDown' : 'ArrowRight';
      const shrinkKey = isVertical ? 'ArrowUp' : 'ArrowLeft';

      if (e.key === growKey || e.key === shrinkKey) {
        e.preventDefault();
        const currentRatios = [...(ratiosRef.current ?? [])];
        const delta = e.key === growKey ? step : -step;
        const combined = (currentRatios[index] ?? 0) + (currentRatios[index + 1] ?? 0);
        const container = containerRef.current;
        const containerSize = container
          ? isVertical
            ? container.getBoundingClientRect().height
            : container.getBoundingClientRect().width
          : 800;
        const minRatio = MIN_PANE_SIZE / containerSize;

        const [newFirst, newSecond] = normalizeTwoPaneRatios(
          (currentRatios[index] ?? 0) + delta,
          combined,
          minRatio,
          false,
        );

        currentRatios[index] = newFirst;
        currentRatios[index + 1] = newSecond;
        onCommitRatios(currentRatios);
      } else if (e.key === 'Enter' || e.key === ' ') {
        e.preventDefault();
        onCloseSplit();
      }
    },
    [index, isVertical, ratiosRef, containerRef, onCommitRatios, onCloseSplit],
  );

  return (
    <>
      <ContextMenu>
        <ContextMenuTrigger asChild>
          <div
            ref={handleRef}
            className={cn('relative shrink-0 z-10')}
            style={
              isVertical
                ? { height: '1px', touchAction: 'none' }
                : { width: '1px', touchAction: 'none' }
            }
          >
            {/* Visible 1px border */}
            <div className={cn('absolute inset-0 transition-colors duration-100', 'bg-border')} />

            {/* Hit area - drag to resize, click to close split */}
            {/* biome-ignore lint/a11y/useSemanticElements: custom resize handle, not a standard separator */}
            <div
              role="separator"
              aria-orientation={isVertical ? 'horizontal' : 'vertical'}
              aria-valuenow={Math.round((ratiosRef.current?.[index] ?? 0.5) * 100)}
              aria-valuemin={0}
              aria-valuemax={100}
              aria-label={`Resize panes ${index + 1} and ${index + 2}. Use ${isVertical ? 'Up/Down' : 'Left/Right'} arrows to resize, Enter to close split.`}
              tabIndex={0}
              className={cn(
                'absolute',
                isVertical
                  ? 'left-0 right-0 cursor-row-resize'
                  : 'top-0 bottom-0 cursor-col-resize',
              )}
              style={isVertical ? { top: '-4px', height: '9px' } : { left: '-4px', width: '9px' }}
              onPointerDown={handlePointerDown}
              onMouseEnter={handleMouseEnter}
              onMouseLeave={handleMouseLeave}
              onKeyDown={handleKeyDown}
            />
          </div>
        </ContextMenuTrigger>
        <ContextMenuContent className="w-40">
          <ContextMenuItem onClick={onCloseSplit}>Close Split</ContextMenuItem>
        </ContextMenuContent>
      </ContextMenu>

      {/* Tooltip */}
      {isHovering &&
        !isResizing &&
        tooltipPos &&
        createPortal(
          <div
            className="fixed z-50 pointer-events-none"
            style={{
              left: `${tooltipPos.x}px`,
              top: `${tooltipPos.y}px`,
              transform: 'translateY(-50%)',
            }}
          >
            <div
              className={cn(
                'rounded-md border px-2 py-1 flex flex-col items-start gap-0.5 text-xs text-popover-foreground shadow-lg',
                overlayGlass,
              )}
            >
              <div className="flex items-center gap-1">
                <span>Separate</span>
                <span className="text-muted-foreground">Click</span>
              </div>
              <div className="flex items-center gap-1">
                <span>Resize</span>
                <span className="text-muted-foreground">Drag</span>
              </div>
            </div>
          </div>,
          document.body,
        )}
    </>
  );
}
