import { Button } from '@benord-labs/frink-primitives';
import { ChevronDown, ChevronLeft, ChevronRight, ChevronUp } from 'lucide-react';
import { type MouseEvent, useCallback } from 'react';
import { Kbd } from '../../../../components/ui/kbd';
import { Tooltip, TooltipContent, TooltipTrigger } from '../../../../components/ui/tooltip';
import { getPaneColor } from '../../../../lib/pane-colors';
import { cn } from '../../../../lib/utils';
import { CompactPaneDigitBadge } from './pane-number-badge';
import { PaneReorderHandleButton } from './pane-reorder-dnd';

const CHEVRON_ICONS = {
  left: ChevronLeft,
  right: ChevronRight,
  up: ChevronUp,
  down: ChevronDown,
} as const;

/** Arrow button for pane reorder (shared between left/up and right/down directions) */
function ReorderArrowButton({
  direction,
  paneNumber,
  disabled,
  onClick,
}: {
  direction: 'left' | 'right' | 'up' | 'down';
  paneNumber: number;
  disabled: boolean;
  onClick: () => void;
}) {
  // biome-ignore lint/style/useNamingConvention: Renders as a component
  const Icon = CHEVRON_ICONS[direction];

  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <Button
          variant="ghost"
          size="sm"
          disabled={disabled}
          onClick={(e) => {
            e.stopPropagation();
            onClick();
          }}
          className={cn(
            // A Compact pane keeps only the drag handle for reordering.
            'text-xs p-2 rounded motion-reduce:transition-none @max-[30rem]/pane:hidden',
            !disabled ? '' : 'text-muted-foreground/60 cursor-not-allowed',
          )}
          aria-label={`Move pane ${paneNumber} ${direction}`}
          iconOnly
        >
          <Icon className="h-3.5 w-3.5" aria-hidden="true" />
        </Button>
      </TooltipTrigger>
      <TooltipContent side="bottom">
        {`Move ${direction}`}
        <Kbd
          shortcutId={
            direction === 'left' || direction === 'up' ? 'reorder-pane-left' : 'reorder-pane-right'
          }
        />
      </TooltipContent>
    </Tooltip>
  );
}

export function PaneHeader({
  paneNumber,
  paneIndex,
  isActive,
  label,
  onClose,
  onMoveLeft,
  onMoveRight,
  canMoveLeft = false,
  canMoveRight = false,
  isVertical = false,
  paneReorderIndex,
  zoomFactor,
  onResetPaneZoom,
  totalPanes,
  onActivate,
}: {
  paneNumber: number;
  paneIndex: number;
  isActive: boolean;
  label?: string;
  onClose: () => void;
  /** Move this pane one position earlier */
  onMoveLeft?: () => void;
  /** Move this pane one position later */
  onMoveRight?: () => void;
  canMoveLeft?: boolean;
  canMoveRight?: boolean;
  /** Whether panes are stacked vertically (changes arrow direction labels) */
  isVertical?: boolean;
  /** When set, render a drag handle wired to dnd-kit pane-reorder for this pane index. */
  paneReorderIndex?: number;
  /** Current zoom factor (1 = 100%). When !== 1, show reset zoom button. */
  zoomFactor?: number;
  /** Reset this pane's zoom to 1x. Shown when zoomFactor !== 1. */
  onResetPaneZoom?: () => void;
  /** When >= 2, prefix label with "Pane N · " so tabs clearly map to panes. */
  totalPanes?: number;
  /** When provided, clicking the header activates this pane (avoids activating when clicking content). */
  onActivate?: () => void;
}) {
  const color = getPaneColor(paneIndex);
  const displayLabel =
    (totalPanes !== undefined && totalPanes >= 2 ? `Pane ${paneNumber} · ` : '') +
    (label ?? 'Chat');

  const handleActivateClick = useCallback(
    (e: MouseEvent) => {
      // The enclosing pane section also activates on click; stop the bubble so this explicit
      // activate button doesn't fire a second activation through the section handler.
      e.stopPropagation();
      onActivate?.();
    },
    [onActivate],
  );

  const headerBarClassName = cn(
    'flex items-center justify-between px-2 py-1 border-b shrink-0 gap-2',
    isActive ? cn(color.borderSubtle, color.sidebarBg) : 'border-border/50 bg-muted/30',
  );

  const badgeAndLabel = (
    <>
      <CompactPaneDigitBadge paneIndex={paneIndex} paneNumber={paneNumber} />
      <Tooltip>
        <TooltipTrigger asChild>
          <span
            className={cn(
              'text-xs truncate',
              isActive ? 'text-foreground' : 'text-muted-foreground',
            )}
          >
            {displayLabel}
          </span>
        </TooltipTrigger>
        <TooltipContent side="bottom">{label ?? 'Chat'}</TooltipContent>
      </Tooltip>
      {isActive && (
        <span
          className={cn(
            'inline-flex items-center h-3.5 px-1 rounded text-[9px] font-medium tracking-wide uppercase shrink-0 @max-[30rem]/pane:hidden',
            color.badgeBg,
            color.badgeText,
          )}
          aria-hidden="true"
        >
          Active
        </span>
      )}
    </>
  );

  return (
    <div className={headerBarClassName}>
      <div className="flex items-center gap-1.5 min-w-0 flex-1">
        {/* Drag handle - outside activate button to avoid nested buttons */}
        {paneReorderIndex !== undefined && <PaneReorderHandleButton paneIndex={paneReorderIndex} />}
        {onActivate ? (
          <Button
            variant="ghost"
            onClick={handleActivateClick}
            className={cn(
              'flex gap-1.5 min-w-0 flex-1 min-h-[44px] h-auto text-left bg-transparent border-0 px-0 py-2 rounded outline-offset-2 focus-visible:outline-solid focus-visible:outline-2 focus-visible:outline-ring -my-1 justify-start',
            )}
            aria-label={!isActive ? `Focus pane ${paneNumber}` : undefined}
          >
            {badgeAndLabel}
          </Button>
        ) : (
          badgeAndLabel
        )}
      </div>
      <div className="flex items-center gap-0.5 shrink-0">
        {/* Reset zoom (when this pane is zoomed) */}
        {zoomFactor !== undefined && zoomFactor !== 1 && onResetPaneZoom && (
          <Tooltip>
            <TooltipTrigger asChild>
              <Button
                variant="ghost"
                size="sm"
                onClick={(e) => {
                  e.stopPropagation();
                  onResetPaneZoom();
                }}
                className="text-xs px-1.5 py-1 rounded h-auto"
                aria-label={`Reset zoom to 100% (currently ${Math.round(zoomFactor * 100)}%)`}
              >
                {Math.round(zoomFactor * 100)}%
              </Button>
            </TooltipTrigger>
            <TooltipContent side="bottom">Reset zoom to 100%</TooltipContent>
          </Tooltip>
        )}
        {zoomFactor !== undefined &&
          zoomFactor !== 1 &&
          onResetPaneZoom &&
          (onMoveLeft ?? onMoveRight) && (
            <div className="w-px h-3 bg-border/50 mx-0.5" aria-hidden="true" />
          )}
        {/* Pane reorder arrow buttons */}
        {onMoveLeft && (
          <ReorderArrowButton
            direction={isVertical ? 'up' : 'left'}
            paneNumber={paneNumber}
            disabled={!canMoveLeft}
            onClick={onMoveLeft}
          />
        )}
        {onMoveRight && (
          <ReorderArrowButton
            direction={isVertical ? 'down' : 'right'}
            paneNumber={paneNumber}
            disabled={!canMoveRight}
            onClick={onMoveRight}
          />
        )}
        {/* Separator between reorder and close button */}
        {(onMoveLeft || onMoveRight) && (
          <div className="w-px h-3 bg-border/50 mx-0.5 @max-[30rem]/pane:hidden" />
        )}
        <Tooltip>
          <TooltipTrigger asChild>
            <Button
              variant="ghost"
              size="sm"
              onClick={(e) => {
                e.stopPropagation();
                onClose();
              }}
              className="text-xs p-2 rounded motion-reduce:transition-none"
              aria-label={`Remove pane ${paneNumber} from split`}
              iconOnly
            >
              ✕
            </Button>
          </TooltipTrigger>
          <TooltipContent side="bottom">
            Remove from split
            <Kbd shortcutId="close-split" />
          </TooltipContent>
        </Tooltip>
      </div>
    </div>
  );
}
