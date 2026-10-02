import { useAtomValue } from 'jotai';
import { memo, useCallback } from 'react';
import { PANE_CHAT_BEHIND_PANEL_CLASS } from '@/components/ui/resizable-sidebar/constants';
import type { PaneFileTreeHandle } from '../../../../features/files-sidebar/PaneFileTree';
import { isFullscreenAtom } from '../../../../lib/atoms';
import { getPaneColor, getPanePermissionHighlightRing } from '../../../../lib/pane-colors';
import { cn } from '../../../../lib/utils';
import { isMacOS } from '../../../../lib/utils/platform';
import type { SplitLayout } from '../../atoms';
import { GridCornerHandle } from './GridCornerHandle';
import {
  getGridPaneOuterCorners,
  getLinearPaneOuterCorners,
  type PaneCorners,
} from './grid-helpers';
import { PaneHeader } from './PaneHeader';
import { PaneDropSection } from './pane-reorder-dnd';
import { SplitPaneFileTreeSidebar } from './SplitPaneFileTreeSidebar';
import type { SplitPaneData } from './types';
import { ZoomWrapper } from './ZoomWrapper';

type ResizeCorner = 'br' | 'bl' | 'tr' | 'tl';

const OUTER_CORNER_CLASS: Record<keyof PaneCorners, string> = {
  tl: 'rounded-tl-(--pane-outer-radius)',
  tr: 'rounded-tr-(--pane-outer-radius)',
  br: 'rounded-br-(--pane-outer-radius)',
  bl: 'rounded-bl-(--pane-outer-radius)',
};

/** One radius on its own GPU layer (on Mac the only rounded clip glass skips a mask surface for),
 *  reaching past each unrounded side so the body's rect clip cuts those corners off. */
function bodyCornerClipStyle({ br, bl }: PaneCorners): React.CSSProperties {
  if (!br && !bl) return { inset: 0 };
  const reach = 'calc(-1 * var(--pane-inner-radius))';
  const inset = 'var(--pane-inner-radius)';
  return {
    top: reach,
    right: br ? 0 : reach,
    bottom: 0,
    left: bl ? 0 : reach,
    paddingTop: inset,
    paddingRight: br ? 0 : inset,
    paddingLeft: bl ? 0 : inset,
    borderRadius: inset,
  };
}

type SplitPaneBase = {
  pane: SplitPaneData;
  index: number;
  isActive: boolean;
  onSetActive: () => void;
  onClose: () => void;
  children: React.ReactNode;
  onFileTreeRef: (handle: PaneFileTreeHandle | null) => void;
  onCloseFileTree?: () => void;
  totalPanes: number;
  onSwapPanes?: (from: number, to: number) => void;
  isDragSource?: boolean;
  justSwapped?: boolean;
  isRequestingPermission?: boolean;
  zoomFactor?: number;
  onResetPaneZoom?: () => void;
};

type SplitPaneLinearProps = SplitPaneBase & {
  variant: 'linear';
  isVertical: boolean;
  sizeStyle: React.CSSProperties;
  showFileTree: boolean;
};

type SplitPaneGridProps = SplitPaneBase & {
  variant: 'grid';
  layout: SplitLayout;
  fileTreeOpen: boolean;
  gridArea?: string;
  gridPlacement?: { gridColumn: string; gridRow: string };
  resizeCorner?: ResizeCorner | null;
  gridContainerRef?: React.RefObject<HTMLDivElement | null>;
  gridRatiosRef?: React.RefObject<{ rows: number[]; cols: number[] }>;
  onGridRatiosChange?: (rows: number[], cols: number[]) => void;
};

type SplitPaneProps = SplitPaneLinearProps | SplitPaneGridProps;

export const SplitPane = memo(function SplitPane(props: SplitPaneProps) {
  const {
    pane,
    index,
    isActive,
    onSetActive,
    onClose,
    children,
    onFileTreeRef,
    onCloseFileTree,
    totalPanes,
    onSwapPanes,
    isDragSource,
    justSwapped,
    isRequestingPermission,
    zoomFactor = 1,
    onResetPaneZoom,
  } = props;

  const isLinear = props.variant === 'linear';
  const isVertical = isLinear ? props.isVertical : false;
  const sizeStyle = isLinear ? props.sizeStyle : undefined;
  const showFileTree = isLinear
    ? props.showFileTree && !!pane.projectPath
    : props.fileTreeOpen && !!pane.projectPath;

  const layout = isLinear ? undefined : props.layout;
  const gridArea = isLinear ? undefined : props.gridArea;
  const gridPlacement = isLinear ? undefined : props.gridPlacement;
  const resizeCorner = isLinear ? undefined : props.resizeCorner;
  const gridContainerRef = isLinear ? undefined : props.gridContainerRef;
  const gridRatiosRef = isLinear ? undefined : props.gridRatiosRef;
  const onGridRatiosChange = isLinear ? undefined : props.onGridRatiosChange;

  const color = getPaneColor(index);
  const isFullscreen = useAtomValue(isFullscreenAtom);

  const handlePaneClick = useCallback(() => {
    if (!isActive) onSetActive();
  }, [isActive, onSetActive]);

  const corners: PaneCorners = isLinear
    ? getLinearPaneOuterCorners(isVertical, index, totalPanes)
    : layout
      ? getGridPaneOuterCorners(layout, index, totalPanes)
      : { tl: false, tr: false, br: false, bl: false };

  const gridStyle: React.CSSProperties | undefined = isLinear
    ? undefined
    : (gridPlacement ?? (gridArea ? { gridArea } : undefined));

  return (
    <PaneDropSection
      paneIndex={index}
      onClick={handlePaneClick}
      style={isLinear ? sizeStyle : gridStyle}
      // The section paints its rounded border but never clips: a rounded clip around the chat's GPU
      // layer costs every glass pass a mask surface on Mac, so the inner corner clip does the rounding.
      className={cn(
        '@container/pane relative flex flex-col border-[3px]',
        'transition-colors duration-200 motion-reduce:transition-none',
        'contain-[layout]',
        corners.tl && OUTER_CORNER_CLASS.tl,
        corners.tr && OUTER_CORNER_CLASS.tr,
        corners.br && OUTER_CORNER_CLASS.br,
        corners.bl && OUTER_CORNER_CLASS.bl,
        isActive ? color.border : color.borderSubtle,
        color.bg,
        '[--open-sidebar-button-position:absolute]',
        showFileTree
          ? '[--open-sidebar-button-left:1px] [--open-sidebar-button-inset:0px]'
          : '[--open-sidebar-button-left:calc(1rem_-_3px)]',
        // macOS clips windowed apps with a native corner radius CSS cannot read, and Tahoe's is wider
        // than the 12px default. Widen outer corners so the border wraps it; fullscreen is square.
        isMacOS() && isFullscreen !== true && '[--pane-outer-radius:16px]',
        '[--pane-inner-radius:calc(var(--pane-outer-radius)_-_3px)]',
        isDragSource && 'opacity-40',
        justSwapped && 'motion-safe:animate-pane-swap',
        isLinear && (isVertical ? 'w-full' : 'h-full'),
        !isLinear && 'min-h-0 min-w-0',
      )}
      overClassName={!isDragSource ? 'ring-2 ring-primary/60 ring-inset' : undefined}
      idleClassName={
        isRequestingPermission && !isDragSource ? getPanePermissionHighlightRing(index) : undefined
      }
      data-pane-index={index}
      aria-label={`Split pane ${index + 1}${pane.label ? `: ${pane.label}` : ''}${isActive ? ' (active)' : ''}`}
      aria-current={isActive || undefined}
    >
      <PaneHeader
        paneNumber={index + 1}
        paneIndex={index}
        isActive={isActive}
        label={pane.label}
        totalPanes={totalPanes}
        onActivate={onSetActive}
        onClose={onClose}
        onMoveLeft={onSwapPanes ? () => onSwapPanes(index, index - 1) : undefined}
        onMoveRight={onSwapPanes ? () => onSwapPanes(index, index + 1) : undefined}
        canMoveLeft={index > 0}
        canMoveRight={index < totalPanes - 1}
        isVertical={isLinear ? isVertical : undefined}
        paneReorderIndex={onSwapPanes ? index : undefined}
        zoomFactor={zoomFactor}
        onResetPaneZoom={onResetPaneZoom}
        className={cn(
          corners.tl && 'rounded-tl-(--pane-inner-radius)',
          corners.tr && 'rounded-tr-(--pane-inner-radius)',
        )}
      />
      <div
        data-pane-body
        className="group/pane-body relative flex-1 min-h-0 min-w-0 overflow-hidden flex"
      >
        <div
          data-pane-corner-clip
          className="absolute flex overflow-hidden"
          style={{
            ...bodyCornerClipStyle(corners),
            transform: 'translateZ(0)',
            willChange: 'transform',
          }}
        >
          {/* The clip reaches past the body to hide its unrounded corners; this box sits exactly on the
              body again, so a Compact panel's absolute inset-0 fills the body, not the overhang. */}
          <div data-pane-body-box className="relative flex flex-1 min-w-0 min-h-0">
            {showFileTree && pane.projectPath && (
              <SplitPaneFileTreeSidebar
                projectPath={pane.projectPath}
                isWorktree={pane.isWorktree}
                chatId={pane.id}
                paneIndex={index}
                onFileTreeRef={onFileTreeRef}
                onCloseFileTree={onCloseFileTree}
              />
            )}
            <div
              data-pane-chat
              className={cn(
                'flex-1 min-w-0 min-h-0 overflow-auto flex flex-col',
                PANE_CHAT_BEHIND_PANEL_CLASS,
              )}
            >
              <ZoomWrapper zoomFactor={zoomFactor} className="min-h-0 min-w-0 flex-1 flex flex-col">
                {children}
              </ZoomWrapper>
            </div>
          </div>
        </div>
      </div>
      {!isLinear && resizeCorner && gridContainerRef && gridRatiosRef && onGridRatiosChange && (
        <GridCornerHandle
          corner={resizeCorner}
          containerRef={gridContainerRef}
          gridRatiosRef={gridRatiosRef}
          onCommit={onGridRatiosChange}
        />
      )}
    </PaneDropSection>
  );
});
