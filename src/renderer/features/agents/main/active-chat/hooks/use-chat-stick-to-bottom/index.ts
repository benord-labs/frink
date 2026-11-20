import { useCallback } from 'react';
import { useStickToBottom } from 'use-stick-to-bottom';
import { usePrefersReducedMotion } from '../../../../../../hooks/use-prefers-reduced-motion';

/** The chat's scroll owner: growth follows with our patched native glide, or jumps under reduced motion. */
export function useChatStickToBottom() {
  const prefersReducedMotion = usePrefersReducedMotion();
  const stickToBottom = useStickToBottom(
    prefersReducedMotion
      ? { initial: 'instant', resize: 'instant' }
      : { initial: 'instant', resize: 'smooth' },
  );
  // The instance is a fresh object each render while its members are stable: depend on members.
  const { isAtBottom, scrollToBottom: scrollViewportToBottom, stopScroll } = stickToBottom;
  const scrollToBottom = useCallback(() => {
    void scrollViewportToBottom(prefersReducedMotion ? { animation: 'instant' } : undefined);
  }, [scrollViewportToBottom, prefersReducedMotion]);
  return { stickToBottom, isAtBottom, scrollToBottom, stopScroll };
}
