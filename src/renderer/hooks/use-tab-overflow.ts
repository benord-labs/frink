import { type RefObject, useCallback, useEffect, useRef, useState } from 'react';

/** px tolerance for scroll-position rounding */
const OVERFLOW_THRESHOLD = 2;

type TabOverflow = {
  canScrollLeft: boolean;
  canScrollRight: boolean;
  /** rAF-throttled re-measure; bind to the scroll container's `onScroll`. */
  recheck: () => void;
};

/**
 * Track whether a horizontally-scrollable container has hidden content on the
 * left/right (for fade indicators). Re-measures on scroll (rAF-throttled), on
 * container resize (ResizeObserver), and whenever a caller-provided `deps` value
 * changes (e.g. the tab list length). Owns its own rAF lifecycle + cleanup.
 */
export function useTabOverflow(ref: RefObject<HTMLElement | null>, deps: unknown[]): TabOverflow {
  const [canScrollLeft, setCanScrollLeft] = useState(false);
  const [canScrollRight, setCanScrollRight] = useState(false);
  const rafRef = useRef<number | null>(null);

  const recheck = useCallback(() => {
    if (rafRef.current !== null) return; // already scheduled
    rafRef.current = requestAnimationFrame(() => {
      rafRef.current = null;
      const el = ref.current;
      if (!el) return;
      setCanScrollLeft(el.scrollLeft > OVERFLOW_THRESHOLD);
      setCanScrollRight(el.scrollLeft + el.clientWidth < el.scrollWidth - OVERFLOW_THRESHOLD);
    });
  }, [ref]);

  // Cancel any pending rAF on unmount.
  useEffect(() => {
    return () => {
      if (rafRef.current !== null) cancelAnimationFrame(rafRef.current);
    };
  }, []);

  // Re-measure when the caller's deps change (they reflow the DOM).
  useEffect(() => {
    recheck();
  }, [recheck, ...deps]);

  // Re-measure when the container itself resizes.
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    const ro = new ResizeObserver(() => recheck());
    ro.observe(el);
    return () => ro.disconnect();
  }, [ref, recheck]);

  return { canScrollLeft, canScrollRight, recheck };
}
