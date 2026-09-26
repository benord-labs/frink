import type { CSSProperties, ReactElement, ReactNode } from 'react';
import type { ShortcutActionId } from '../../../lib/hotkeys';
import { ExtendedHoverArea } from './ExtendedHoverArea';
import { ResizeHandle } from './ResizeHandle';
import { ResizeTooltip } from './ResizeTooltip';
import type { Side } from './types';
import type { UseSidebarInteractionsReturn } from './useSidebarInteractions';

type Props = {
  interactions: UseSidebarInteractionsReturn;
  side: Side;
  closeShortcutId?: ShortcutActionId;
  disableClickToClose: boolean;
  showResizeTooltip: boolean;
  chromeDisabled: boolean;
  extendedHoverAreaStyle: CSSProperties;
  resizeHandleStyle: CSSProperties;
  children: ReactNode;
};

export function ResizableSidebarChrome({
  interactions,
  side,
  closeShortcutId,
  disableClickToClose,
  showResizeTooltip,
  chromeDisabled,
  extendedHoverAreaStyle,
  resizeHandleStyle,
  children,
}: Props): ReactElement {
  return (
    <>
      <ExtendedHoverArea
        isResizing={interactions.isResizing}
        onPointerDown={interactions.handleResizePointerDown}
        onMouseEnter={interactions.handleMouseEnterExtended}
        onMouseLeave={interactions.handleMouseLeaveExtended}
        style={extendedHoverAreaStyle}
        interactionDisabled={chromeDisabled}
      />

      <ResizeHandle
        onPointerDown={interactions.handleResizePointerDown}
        onMouseEnter={interactions.handleMouseEnterHandle}
        onMouseLeave={interactions.handleMouseLeaveHandle}
        style={resizeHandleStyle}
        interactionDisabled={chromeDisabled}
      />

      {showResizeTooltip &&
        !chromeDisabled &&
        interactions.isHoveringResizeHandle &&
        !interactions.isResizing &&
        !interactions.isTooltipDismissed && (
          <ResizeTooltip
            tooltipPosition={interactions.tooltipPosition}
            side={side}
            disableClickToClose={disableClickToClose}
            closeShortcutId={closeShortcutId}
            onClose={interactions.handleClose}
            tooltipRef={interactions.tooltipRef}
          />
        )}

      {children}
    </>
  );
}
