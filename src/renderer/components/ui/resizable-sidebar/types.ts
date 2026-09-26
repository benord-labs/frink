import type { WritableAtom } from 'jotai';
import type { CSSProperties, ReactNode } from 'react';
import type { ShortcutActionId } from '../../../lib/hotkeys';

export type Side = 'left' | 'right';

export type ResizableSidebarProps = {
  isOpen: boolean;
  /** When omitted, close from resize tooltip / extended area is a no-op (e.g. shell where the header owns dismiss). */
  onClose?: () => void;
  widthAtom: WritableAtom<number, [number], void>;
  minWidth?: number;
  maxWidth?: number;
  side: Side;
  closeShortcutId?: ShortcutActionId;
  animationDuration?: number;
  children: ReactNode;
  className?: string;
  initialWidth?: number | string;
  exitWidth?: number | string;
  dataAttributes?: Record<string, string | boolean>;
  disableClickToClose?: boolean;
  showResizeTooltip?: boolean;
  style?: CSSProperties;
  /**
   * When true, keeps `children` mounted while `isOpen` is false: collapses width to 0,
   * sets `minWidth` to 0 while closed, and marks the shell inert (desktop sidebars that
   * should not replay mount effects on toggle). Default false preserves legacy unmount behavior.
   */
  preserveChildrenWhenClosed?: boolean;
};

export type TooltipPosition = {
  x: number;
  y: number;
};

export type ResizeHandleProps = {
  onPointerDown: (event: React.PointerEvent<HTMLButtonElement | HTMLDivElement>) => void;
  onMouseEnter: (e: React.MouseEvent) => void;
  onMouseLeave: (e: React.MouseEvent) => void;
  style: CSSProperties;
  /** When true, handle is not tabbable and ignores pointer (belt-and-suspenders with inert). */
  interactionDisabled?: boolean;
};

export type ExtendedHoverAreaProps = {
  isResizing: boolean;
  onPointerDown: (event: React.PointerEvent<HTMLDivElement>) => void;
  onMouseEnter: (e: React.MouseEvent) => void;
  onMouseLeave: (e: React.MouseEvent) => void;
  style: CSSProperties;
  interactionDisabled?: boolean;
};

export type ResizeTooltipProps = {
  tooltipPosition: TooltipPosition | null;
  side: Side;
  disableClickToClose: boolean;
  closeShortcutId?: ShortcutActionId;
  onClose: () => void;
  tooltipRef: React.RefObject<HTMLButtonElement | null>;
};
