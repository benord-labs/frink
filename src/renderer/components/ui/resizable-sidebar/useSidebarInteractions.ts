/* eslint-disable max-lines, max-lines-per-function */
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { flushSync } from 'react-dom';
import { MOVE_THRESHOLD_PX, TOOLTIP_DELAY_MS, TOOLTIP_OFFSET_PX } from './constants';
import type { Side, TooltipPosition } from './types';
import { calculateDelta, clampWidth } from './utils';

type UseSidebarInteractionsProps = {
  isOpen: boolean;
  sidebarWidth: number;
  setSidebarWidth: (width: number) => void;
  minWidth: number;
  maxWidth: number;
  side: Side;
  disableClickToClose: boolean;
  onClose?: () => void;
  sidebarRef: React.RefObject<HTMLDivElement | null>;
};

export type UseSidebarInteractionsReturn = {
  // Resize state
  isResizing: boolean;
  localWidth: number | null;
  resizeHandleRef: React.RefObject<HTMLDivElement | null>;
  handleResizePointerDown: (event: React.PointerEvent<HTMLButtonElement | HTMLDivElement>) => void;
  handleClose: () => void;

  // Tooltip state
  isHoveringResizeHandle: boolean;
  tooltipY: number | null;
  isTooltipDismissed: boolean;
  tooltipRef: React.RefObject<HTMLButtonElement | null>;
  tooltipPosition: TooltipPosition | null;
  handleMouseEnterHandle: (e: React.MouseEvent) => void;
  handleMouseLeaveHandle: (e: React.MouseEvent) => void;
  handleMouseEnterExtended: (e: React.MouseEvent) => void;
  handleMouseLeaveExtended: (e: React.MouseEvent) => void;
};

export function useSidebarInteractions({
  isOpen,
  sidebarWidth,
  setSidebarWidth,
  minWidth,
  maxWidth,
  side,
  disableClickToClose,
  onClose,
  sidebarRef,
}: UseSidebarInteractionsProps): UseSidebarInteractionsReturn {
  // Resize state
  const [isResizing, setIsResizing] = useState(false);
  const [localWidth, setLocalWidth] = useState<number | null>(null);
  const resizeHandleRef = useRef<HTMLDivElement>(null);

  // Tooltip state
  const [isHoveringResizeHandle, setIsHoveringResizeHandle] = useState(false);
  const [tooltipY, setTooltipY] = useState<number | null>(null);
  const [isTooltipDismissed, setIsTooltipDismissed] = useState(false);
  const tooltipRef = useRef<HTMLButtonElement>(null);
  const tooltipTimeoutRef = useRef<NodeJS.Timeout | null>(null);

  // Calculate tooltip position
  const tooltipPosition = useMemo(() => {
    if (!tooltipY || !sidebarRef.current) {
      return null;
    }

    const rect = sidebarRef.current.getBoundingClientRect();
    const x = side === 'left' ? rect.right + TOOLTIP_OFFSET_PX : rect.left - TOOLTIP_OFFSET_PX;

    return { x, y: tooltipY };
  }, [tooltipY, side, sidebarRef]);

  // Clear tooltip when sidebar closes
  useEffect(() => {
    if (!isOpen) {
      if (tooltipTimeoutRef.current) {
        clearTimeout(tooltipTimeoutRef.current);
        tooltipTimeoutRef.current = null;
      }
      setIsHoveringResizeHandle(false);
      setTooltipY(null);
    }
    return () => {
      if (tooltipTimeoutRef.current) {
        clearTimeout(tooltipTimeoutRef.current);
        tooltipTimeoutRef.current = null;
      }
    };
  }, [isOpen]);

  // Reset dismissal when sidebar opens
  useEffect(() => {
    if (isOpen) {
      setIsTooltipDismissed(false);
    }
  }, [isOpen]);

  // Handle close
  const handleClose = useCallback(() => {
    if (isHoveringResizeHandle && !isTooltipDismissed) {
      flushSync(() => {
        setIsTooltipDismissed(true);
      });
    }

    flushSync(() => {
      if (isResizing) {
        setIsResizing(false);
      }
      if (localWidth !== null) {
        setLocalWidth(null);
      }
    });

    onClose?.();
    setIsHoveringResizeHandle(false);
    setTooltipY(null);
  }, [onClose, isResizing, localWidth, isHoveringResizeHandle, isTooltipDismissed]);

  // Global click handler for tooltip dismissal
  useEffect(() => {
    if (!isOpen || !isHoveringResizeHandle || isTooltipDismissed) {
      return;
    }

    const handleDocumentClick = (e: MouseEvent) => {
      const target = e.target as HTMLElement;
      const tooltipElement = target.closest('[data-tooltip="true"]');
      const isClickOnTooltip = tooltipElement || tooltipRef.current?.contains(target);

      // Don't intercept clicks that aren't on the tooltip
      if (!isClickOnTooltip) {
        return;
      }

      if (isClickOnTooltip) {
        e.preventDefault();
        e.stopPropagation();
        flushSync(() => {
          setIsTooltipDismissed(true);
        });
        handleClose();
      }
    };

    document.addEventListener('click', handleDocumentClick, true);
    document.addEventListener('pointerdown', handleDocumentClick, true);

    return () => {
      document.removeEventListener('click', handleDocumentClick, true);
      document.removeEventListener('pointerdown', handleDocumentClick, true);
    };
  }, [isOpen, isHoveringResizeHandle, isTooltipDismissed, handleClose]);

  // Tooltip helpers
  const clearTooltipTimeout = useCallback(() => {
    if (tooltipTimeoutRef.current) {
      clearTimeout(tooltipTimeoutRef.current);
      tooltipTimeoutRef.current = null;
    }
  }, []);

  const scheduleTooltip = useCallback(
    (y: number) => {
      clearTooltipTimeout();
      if (!tooltipY) {
        setTooltipY(y);
      }
      tooltipTimeoutRef.current = setTimeout(() => {
        setIsHoveringResizeHandle(true);
      }, TOOLTIP_DELAY_MS);
    },
    [tooltipY, clearTooltipTimeout],
  );

  // Mouse event handlers
  const handleMouseEnterHandle = useCallback(
    (e: React.MouseEvent) => {
      if (isResizing) {
        return;
      }
      scheduleTooltip(e.clientY);
    },
    [isResizing, scheduleTooltip],
  );

  const handleMouseLeaveHandle = useCallback(
    (e: React.MouseEvent) => {
      if (isResizing) {
        return;
      }

      clearTooltipTimeout();

      const relatedTarget = e.relatedTarget;
      if (relatedTarget instanceof Element && relatedTarget.closest('[data-extended-hover-area]')) {
        return;
      }

      setIsHoveringResizeHandle(false);
      setTooltipY(null);
      setIsTooltipDismissed(false);
    },
    [isResizing, clearTooltipTimeout],
  );

  const handleMouseEnterExtended = useCallback(
    (e: React.MouseEvent) => {
      if (isResizing) {
        return;
      }
      scheduleTooltip(e.clientY);
    },
    [isResizing, scheduleTooltip],
  );

  const handleMouseLeaveExtended = useCallback(
    (e: React.MouseEvent) => {
      if (isResizing) {
        return;
      }

      clearTooltipTimeout();

      const relatedTarget = e.relatedTarget;
      if (
        relatedTarget instanceof Node &&
        (resizeHandleRef.current?.contains(relatedTarget) ||
          resizeHandleRef.current === relatedTarget)
      ) {
        return;
      }

      setIsHoveringResizeHandle(false);
      setTooltipY(null);
      setIsTooltipDismissed(false);
    },
    [isResizing, clearTooltipTimeout],
  );

  // Resize handler
  const handleResizePointerDown = useCallback(
    (event: React.PointerEvent<HTMLButtonElement | HTMLDivElement>) => {
      if (event.button !== 0) {
        return;
      }

      event.preventDefault();
      event.stopPropagation();

      const startX = event.clientX;
      // A pane may clamp the sidebar below its stored width: drag from the width on screen and
      // never save a wider one (+1 absorbs sub-pixel rounding; 0 means not laid out).
      const renderedWidth = sidebarRef.current?.offsetWidth || sidebarWidth;
      const isClamped = renderedWidth + 1 < sidebarWidth;
      const startWidth = isClamped ? renderedWidth : sidebarWidth;
      const widestWidth = isClamped ? renderedWidth : maxWidth;
      const pointerId = event.pointerId;
      let hasMoved = false;
      let currentLocalWidth: number | null = null;

      const handleElement = resizeHandleRef.current ?? (event.currentTarget as HTMLElement);

      handleElement.setPointerCapture?.(pointerId);

      if (tooltipTimeoutRef.current) {
        clearTimeout(tooltipTimeoutRef.current);
        tooltipTimeoutRef.current = null;
      }

      setIsResizing(true);
      setIsHoveringResizeHandle(false);

      const updateWidth = (clientX: number) => {
        const delta = calculateDelta(clientX, startX, side);
        const newWidth = clampWidth(startWidth + delta, minWidth, widestWidth);
        currentLocalWidth = newWidth;
        setLocalWidth(newWidth);
      };

      const handlePointerMove = (pointerEvent: PointerEvent) => {
        const delta = Math.abs(calculateDelta(pointerEvent.clientX, startX, side));

        if (!hasMoved && delta >= MOVE_THRESHOLD_PX) {
          hasMoved = true;
        }

        if (hasMoved) {
          updateWidth(pointerEvent.clientX);
        }
      };

      const finishResize = (pointerEvent?: PointerEvent) => {
        if (handleElement.hasPointerCapture?.(pointerId)) {
          handleElement.releasePointerCapture(pointerId);
        }

        document.removeEventListener('pointermove', handlePointerMove);
        document.removeEventListener('pointerup', handlePointerUp);
        document.removeEventListener('pointercancel', handlePointerCancel);
        setIsResizing(false);

        if (!hasMoved && pointerEvent && !disableClickToClose) {
          handleClose();
        } else if (hasMoved && pointerEvent) {
          const delta = calculateDelta(pointerEvent.clientX, startX, side);
          const finalWidth = clampWidth(startWidth + delta, minWidth, widestWidth);
          setSidebarWidth(finalWidth);
          setLocalWidth(null);
        } else if (currentLocalWidth !== null) {
          setSidebarWidth(currentLocalWidth);
          setLocalWidth(null);
        }
      };

      const handlePointerUp = (pointerEvent: PointerEvent) => {
        finishResize(pointerEvent);
      };

      const handlePointerCancel = () => {
        finishResize();
      };

      document.addEventListener('pointermove', handlePointerMove);
      document.addEventListener('pointerup', handlePointerUp, { once: true });
      document.addEventListener('pointercancel', handlePointerCancel, { once: true });
    },
    [
      sidebarWidth,
      setSidebarWidth,
      handleClose,
      minWidth,
      maxWidth,
      side,
      disableClickToClose,
      sidebarRef,
    ],
  );

  return {
    isResizing,
    localWidth,
    resizeHandleRef,
    handleResizePointerDown,
    handleClose,
    isHoveringResizeHandle,
    tooltipY,
    isTooltipDismissed,
    tooltipRef,
    tooltipPosition,
    handleMouseEnterHandle,
    handleMouseLeaveHandle,
    handleMouseEnterExtended,
    handleMouseLeaveExtended,
  };
}
