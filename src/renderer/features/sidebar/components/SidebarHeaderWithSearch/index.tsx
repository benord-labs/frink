/**
 * SidebarHeaderWithSearch - Shared header for sidebars: title, search, and optional close.
 * Used by both UnifiedSidebar (Frink) and FilesSidebar for consistent layout and behavior.
 */

import { Button, Input } from '@benord-labs/frink-primitives';
import { PanelLeftClose, Search, X } from 'lucide-react';
import type { ReactElement } from 'react';
import { memo } from 'react';
import { Kbd } from '@/components/ui/kbd';
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip';
import type { ShortcutActionId } from '@/lib/hotkeys';
import { cn } from '@/lib/utils';

const TOOLTIP_DELAY_MS = 500;

type SidebarHeaderWithSearchProps = {
  title: string;
  titleIcon?: ReactElement;
  searchPlaceholder: string;
  searchQuery: string;
  onSearchChange: (query: string) => void;
  searchInputRef?: React.RefObject<HTMLInputElement | null>;
  onClose?: () => void;
  closeTooltipLabel: string;
  closeShortcutId?: ShortcutActionId;
  showClearInInput?: boolean;
  /** Merged onto the search input (e.g. frosted panel variant). */
  searchInputClassName?: string;
  /** Merged onto the outer header wrapper. */
  className?: string;
};

function SidebarHeaderWithSearchComponent({
  title,
  titleIcon,
  searchPlaceholder,
  searchQuery,
  onSearchChange,
  searchInputRef,
  onClose,
  closeTooltipLabel,
  closeShortcutId,
  showClearInInput = false,
  searchInputClassName,
  className,
}: SidebarHeaderWithSearchProps): ReactElement {
  const hasTitleText = title.trim().length > 0;
  const centerBrandRow = Boolean(titleIcon) && !hasTitleText;

  return (
    <div className={cn('shrink-0 space-y-2 p-3 pb-2 pt-8', className)}>
      {/* Title row - no close here; close lives next to search for consistent layout */}
      <div
        className={cn(
          'flex w-full items-center gap-2',
          centerBrandRow ? 'mb-0 justify-center' : 'mb-1 min-h-7 justify-start',
        )}
      >
        {titleIcon}
        {hasTitleText && (
          <span className="text-base font-semibold tracking-tight text-foreground">{title}</span>
        )}
      </div>

      {/* Search + Close (same row for both sidebars) */}
      <div className="flex items-center gap-1.5">
        <div className={cn('relative flex-1', centerBrandRow && 'mt-2')}>
          <Input
            ref={searchInputRef}
            placeholder={searchPlaceholder}
            value={searchQuery}
            onChange={(e) => onSearchChange(e.target.value)}
            size="sm"
            className={cn(
              'relative z-0 border-input bg-muted pl-8',
              showClearInInput && 'pr-8',
              searchInputClassName,
            )}
          />
          {/* After input + z-10: avoids backdrop-blur-sm on input sampling the icon as backdrop */}
          <Search className="pointer-events-none absolute left-2.5 top-1/2 z-10 h-3.5 w-3.5 -translate-y-1/2 text-muted-foreground/60" />
          {showClearInInput && searchQuery && (
            <Button
              variant="ghost"
              size="icon"
              onClick={() => onSearchChange('')}
              className="absolute right-2.5 top-1/2 z-10 -translate-y-1/2 bg-transparent text-muted-foreground hover:bg-transparent hover:text-foreground"
              aria-label="Clear search"
            >
              <X className="h-3.5 w-3.5" />
            </Button>
          )}
        </div>
        {onClose && (
          <Tooltip delayDuration={TOOLTIP_DELAY_MS}>
            <TooltipTrigger asChild>
              <Button
                variant="ghost"
                size="sm"
                onClick={onClose}
                className={cn(
                  'size-8 shrink-0 text-muted-foreground hover:bg-foreground/5 hover:text-foreground',
                  centerBrandRow && 'mt-2',
                )}
                aria-label={closeTooltipLabel}
                iconOnly
              >
                <PanelLeftClose className="h-4 w-4" />
              </Button>
            </TooltipTrigger>
            <TooltipContent side="bottom">
              {closeTooltipLabel}
              {closeShortcutId && <Kbd shortcutId={closeShortcutId} />}
            </TooltipContent>
          </Tooltip>
        )}
      </div>
    </div>
  );
}

export const SidebarHeaderWithSearch = memo(SidebarHeaderWithSearchComponent);
