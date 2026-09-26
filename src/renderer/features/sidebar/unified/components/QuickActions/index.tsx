/**
 * SplitViewControls - contextual split-view tuning controls: cycle layout, reset pane sizes,
 * reset pane zoom. Rendered INLINE on the "Add Pane" row in SidebarNav, and each control appears
 * only when it can do something: layout toggle once there are ≥2 panes, reset-sizes only when the
 * panes are unequal, reset-zoom only when a pane is zoomed. Single-pane → renders nothing.
 *
 * The folder keeps its legacy "QuickActions" name on purpose — renaming it would churn the
 * structure import-wall baseline that grandfathers this file's cross-feature atom imports.
 */

import { Button } from '@benord-labs/frink-primitives';
import { useAtomValue } from 'jotai';
import { RotateCcw, Columns2, Rows2, LayoutPanelTop, Grid2x2 } from 'lucide-react';
import { memo, type ReactElement } from 'react';
import { Kbd } from '../../../../../components/ui/kbd';
import { Tooltip, TooltipContent, TooltipTrigger } from '../../../../../components/ui/tooltip';
import {
  getLayoutCycleDescription,
  getNextLayout,
  getValidLayouts,
  type SplitLayout,
  splitViewChatIdsAtom,
  splitViewQuickActionsChromeAtom,
} from '../../../../agents/atoms';

/** Icons for the layout toggle; labels/tooltips use getLayoutCycleDescription (layoutCycleLabel). */
const LAYOUT_ICONS: Record<SplitLayout, ReactElement> = {
  horizontal: <Columns2 className="size-3.5" aria-hidden="true" />,
  vertical: <Rows2 className="size-3.5" aria-hidden="true" />,
  'three-bottom': <LayoutPanelTop className="size-3.5 rotate-180" aria-hidden="true" />,
  'three-right': <LayoutPanelTop className="size-3.5" aria-hidden="true" />,
  grid: <Grid2x2 className="size-3.5" aria-hidden="true" />,
};

type SplitViewControlsProps = {
  /** Cycle through valid layouts for the current pane count. */
  onCycleLayout?: () => void;
  /** Reset pane sizes to equal (snap to grid). */
  onResetPaneSizes?: () => void;
  /** Reset all pane zoom to 100%. */
  onResetPaneZoom?: () => void;
};

function SplitViewControlsComponent({
  onCycleLayout,
  onResetPaneSizes,
  onResetPaneZoom,
}: SplitViewControlsProps): ReactElement | null {
  const chatIds = useAtomValue(splitViewChatIdsAtom);
  const chrome = useAtomValue(splitViewQuickActionsChromeAtom);
  const paneCount = chatIds.length;

  // Contextual: tuning controls exist only once there's a split to tune.
  if (paneCount < 2) return null;

  const currentLayout = chrome.layout;
  const canCycleLayout = getValidLayouts(paneCount).length > 1;
  // Icon for the *next* layout after cycle; label is pane-count-aware.
  const nextLayout =
    currentLayout !== undefined ? getNextLayout(currentLayout, paneCount) : undefined;
  const layoutIcon = nextLayout !== undefined ? LAYOUT_ICONS[nextLayout] : undefined;
  const layoutCycleLabel =
    nextLayout !== undefined ? getLayoutCycleDescription(nextLayout, paneCount) : undefined;

  const showLayoutToggle = canCycleLayout && onCycleLayout && layoutIcon && layoutCycleLabel;
  // Each control shows only when it can act: reset-sizes only when panes are unequal,
  // reset-zoom only when a pane is zoomed.
  const showResetPaneSizes = chrome.hasNonDefaultPaneSizes && onResetPaneSizes !== undefined;
  const showResetPaneZoom = chrome.hasNonDefaultPaneZoom && onResetPaneZoom !== undefined;

  if (!showLayoutToggle && !showResetPaneSizes && !showResetPaneZoom) return null;

  return (
    <div className="flex shrink-0 items-center gap-0.5">
      {showLayoutToggle && (
        <Tooltip>
          <TooltipTrigger asChild>
            <Button
              variant="ghost"
              size="sm"
              onClick={onCycleLayout}
              className="h-6 w-6 shrink-0 text-muted-foreground"
              aria-label={layoutCycleLabel}
              iconOnly
            >
              {layoutIcon}
            </Button>
          </TooltipTrigger>
          <TooltipContent side="bottom">
            {layoutCycleLabel}
            <Kbd shortcutId="cycle-pane-layout" />
          </TooltipContent>
        </Tooltip>
      )}

      {showResetPaneSizes && (
        <Tooltip>
          <TooltipTrigger asChild>
            <Button
              variant="ghost"
              size="sm"
              onClick={onResetPaneSizes}
              className="h-6 w-6 shrink-0 text-muted-foreground"
              aria-label="Reset pane sizes to equal"
              iconOnly
            >
              <RotateCcw className="h-3.5 w-3.5" />
            </Button>
          </TooltipTrigger>
          <TooltipContent side="bottom">
            Reset pane sizes
            <Kbd shortcutId="reset-pane-sizes" />
          </TooltipContent>
        </Tooltip>
      )}

      {showResetPaneZoom && (
        <Tooltip>
          <TooltipTrigger asChild>
            <Button
              variant="ghost"
              size="sm"
              onClick={onResetPaneZoom}
              className="h-6 min-w-[28px] shrink-0 px-1.5 text-[10px] text-muted-foreground"
              aria-label="Reset all pane zoom to 100%"
            >
              100%
            </Button>
          </TooltipTrigger>
          <TooltipContent side="bottom">
            Reset pane zoom
            <Kbd shortcutId="reset-pane-zoom" />
          </TooltipContent>
        </Tooltip>
      )}
    </div>
  );
}

export const SplitViewControls = memo(SplitViewControlsComponent);
