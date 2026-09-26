import { ArrowDown } from 'lucide-react';
import { AnimatePresence, motion } from 'motion/react';
import type { ReactElement } from 'react';
import { memo } from 'react';
import { Kbd } from '@/components/ui/kbd';
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip';
import { STRINGS } from '../constants';

type Props = {
  /** `!isAtBottom` from useStickToBottom, alone. Never add `escapedFromLock`: the hook's own
   *  `scrollToBottom()` leaves it set, so the button would stay up at the bottom after a click. */
  hasLeftBottom: boolean;
  onScrollToBottom: () => void;
};

/** Sits in ChatDock's stack off its top edge (`bottom-full`), clearing whatever the stack holds.
 *  It is a direct child of that pointer-events-none stack, so it opts back into pointer events. */
export const ScrollToBottomButton = memo(function ScrollToBottomButton({
  hasLeftBottom,
  onScrollToBottom,
}: Props): ReactElement {
  return (
    <AnimatePresence>
      {hasLeftBottom && (
        <Tooltip delayDuration={300}>
          <TooltipTrigger asChild>
            <motion.button
              initial={{ opacity: 0, scale: 0.96, y: 8 }}
              animate={{ opacity: 1, scale: 1, y: 0 }}
              exit={{ opacity: 0, scale: 0.96, y: 8 }}
              transition={{ duration: 0.2, ease: [0.23, 1, 0.32, 1] }}
              onClick={onScrollToBottom}
              className="pointer-events-auto absolute bottom-full right-4 mb-2 p-2 rounded-full glass-float border border-border shadow-md hover:bg-accent active:scale-[0.97] transition-colors"
              aria-label={STRINGS.SCROLL_TO_BOTTOM}
            >
              <ArrowDown className="h-4 w-4 text-muted-foreground" />
            </motion.button>
          </TooltipTrigger>
          <TooltipContent side="top">
            {STRINGS.SCROLL_TO_BOTTOM}
            <Kbd shortcutId="scroll-to-bottom" />
          </TooltipContent>
        </Tooltip>
      )}
    </AnimatePresence>
  );
});
