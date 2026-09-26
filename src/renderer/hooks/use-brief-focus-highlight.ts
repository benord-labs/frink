import { type RefObject, useEffect, useRef, useState } from 'react';

const HIGHLIGHT_DURATION_MS = 1600;

/**
 * Deep-link focus affordance: each nonce bump (> 0) scrolls the target element into view
 * and turns on a transient highlight so the user sees which field a warning pointed at.
 */
export function useBriefFocusHighlight<T extends HTMLElement>(
  nonce: number | undefined,
): { ref: RefObject<T | null>; highlighted: boolean } {
  const ref = useRef<T>(null);
  const [highlighted, setHighlighted] = useState(false);

  useEffect(() => {
    if (!nonce) return;
    const reduceMotion = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
    ref.current?.scrollIntoView({ block: 'center', behavior: reduceMotion ? 'auto' : 'smooth' });
    setHighlighted(true);
    const timer = window.setTimeout(() => setHighlighted(false), HIGHLIGHT_DURATION_MS);
    return () => window.clearTimeout(timer);
  }, [nonce]);

  return { ref, highlighted };
}
