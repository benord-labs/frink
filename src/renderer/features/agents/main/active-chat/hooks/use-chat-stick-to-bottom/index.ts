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
  return { stickToBottom, prefersReducedMotion };
}
