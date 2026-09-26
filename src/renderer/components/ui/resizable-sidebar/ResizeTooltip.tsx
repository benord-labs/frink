import { AnimatePresence, motion } from 'motion/react';
import type { ReactElement } from 'react';
import { createPortal } from 'react-dom';
import { Kbd } from '../kbd';
import { TOOLTIP_FADE_DURATION, UI_TEXT } from './constants';
import type { ResizeTooltipProps } from './types';
import { overlayGlass } from '@/lib/overlay-styles';

export function ResizeTooltip({
  tooltipPosition,
  side,
  disableClickToClose,
  closeShortcutId,
  onClose,
  tooltipRef,
}: ResizeTooltipProps): ReactElement | null {
  if (!tooltipPosition || typeof window === 'undefined') {
    return null;
  }

  const handleDismiss = (e: React.MouseEvent | React.KeyboardEvent) => {
    e.stopPropagation();
    e.preventDefault();
    onClose();
  };

  const handleKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === 'Enter' || e.key === ' ') {
      handleDismiss(e);
    }
  };

  return createPortal(
    <AnimatePresence>
      <motion.div
        key="tooltip"
        initial={{ opacity: 0 }}
        animate={{ opacity: 1 }}
        exit={{ opacity: 0 }}
        transition={{ duration: TOOLTIP_FADE_DURATION, ease: 'easeOut' }}
        className="fixed z-10"
        style={{
          left: `${tooltipPosition.x}px`,
          top: `${tooltipPosition.y}px`,
          transform: side === 'left' ? 'translateY(-50%)' : 'translateX(-100%) translateY(-50%)',
          transformOrigin: side === 'left' ? 'left center' : 'right center',
          pointerEvents: 'none',
        }}
      >
        <button
          ref={tooltipRef}
          type="button"
          aria-label="Close sidebar tooltip"
          data-tooltip="true"
          className={`relative rounded-md border px-2 py-1 flex flex-col items-start gap-0.5 text-xs text-popover-foreground shadow-lg dark pointer-events-auto ${overlayGlass}`}
          onPointerDown={(e) => {
            if (e.button === 0) {
              handleDismiss(e);
            }
          }}
          onClick={handleDismiss}
          onKeyDown={handleKeyDown}
        >
          {!disableClickToClose && (
            <div className="flex items-center gap-1 text-xs">
              <span>{UI_TEXT.CLOSE}</span>
              <span className="text-muted-foreground inline-flex items-center gap-1">
                <span>{UI_TEXT.CLICK}</span>
                {closeShortcutId && (
                  <>
                    <span>{UI_TEXT.OR}</span>
                    <Kbd shortcutId={closeShortcutId} />
                  </>
                )}
              </span>
            </div>
          )}
          <div className="flex items-center gap-1 text-xs">
            <span>{UI_TEXT.RESIZE}</span>
            <span className="text-muted-foreground">{UI_TEXT.DRAG}</span>
          </div>
        </button>
      </motion.div>
    </AnimatePresence>,
    document.body,
  );
}
