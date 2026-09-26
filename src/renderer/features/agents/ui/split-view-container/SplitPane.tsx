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
import { getGridPaneOuterCornerClass } from './grid-helpers';
import { PaneHeader } from './PaneHeader';
import { PaneDropSection } from './pane-reorder-dnd';
import { SplitPaneFileTreeSidebar } from './SplitPaneFileTreeSidebar';
import type { SplitPaneData } from './types';
import { ZoomWrapper } from './ZoomWrapper';

type ResizeCorner = 'br' | 'bl' | 'tr' | 'tl';

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

  const outerCornerClass = isLinear
    ? totalPanes <= 1
      ? 'rounded-(--pane-outer-radius)'
      : isVertical
        ? cn(
            index === 0 && 'rounded-t-(--pane-outer-radius)',
            index === totalPanes - 1 && 'rounded-b-(--pane-outer-radius)',
          )
        : cn(
            index === 0 && 'rounded-l-(--pane-outer-radius)',
            index === totalPanes - 1 && 'rounded-r-(--pane-outer-radius)',
          )
    : layout
      ? getGridPaneOuterCornerClass(layout, index, totalPanes)
      : '';

  const gridStyle: React.CSSProperties | undefined = isLinear
    ? undefined
    : (gridPlacement ?? (gridArea ? { gridArea } : undefined));

  return (
    <PaneDropSection
      paneIndex={index}
      onClick={handlePaneClick}
      style={isLinear ? sizeStyle : gridStyle}
      className={cn(
        '@container/pane overflow-hidden relative flex flex-col',
        'contain-[layout_paint]',
        '[--open-sidebar-button-position:absolute]',
        showFileTree
          ? '[--open-sidebar-button-left:1px] [--open-sidebar-button-inset:0px]'
          : '[--open-sidebar-button-left:calc(1rem_-_3px)]',
        'border-[3px] transition-colors duration-200 motion-reduce:transition-none',
        outerCornerClass,
        // macOS clips windowed apps with a native corner radius CSS cannot read, and Tahoe's is wider
        // than the 12px default. Widen outer corners so the border wraps it; fullscreen is square.
        isMacOS() && isFullscreen !== true && '[--pane-outer-radius:16px]',
        isActive ? color.border : color.borderSubtle,
        isDragSource && 'opacity-40',
        justSwapped && 'motion-safe:animate-pane-swap',
        color.bg,
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
      />
      <div
        data-pane-body
        className="group/pane-body relative flex-1 min-h-0 min-w-0 overflow-hidden flex"
      >
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
