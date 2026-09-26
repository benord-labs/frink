import { useCallback, useLayoutEffect, useRef, useState } from 'react';

/** Width assumed for the "more" control before it has rendered. */
const MORE_FALLBACK_PX = 28;

/**
 * Index of the first item that fits: items are in display order with priority rising to the
 * right, so hiding always starts from the left. Widths of hidden items are the last measured ones.
 */
export function computeVisibleFrom(
  widths: number[],
  availablePx: number,
  morePx: number,
  gapPx: number,
): number {
  const count = widths.length;
  for (let from = 0; from < count; from++) {
    const visible = widths.slice(from);
    const items = visible.reduce((sum, w) => sum + w, 0) + gapPx * Math.max(0, visible.length - 1);
    const more = from > 0 ? morePx + gapPx : 0;
    if (items + more <= availablePx) return from;
  }
  return count;
}

/**
 * Priority+ overflow: items that fit stay inline, the rest go behind a "more" control. Hidden items
 * keep their measured width; `depsKey` must change whenever an item's content or control changes.
 */
export function usePriorityOverflow(count: number, gapPx: number, depsKey: string) {
  const containerRef = useRef<HTMLDivElement>(null);
  const moreRef = useRef<HTMLButtonElement>(null);
  const itemRefs = useRef<Array<HTMLElement | null>>([]);
  const widths = useRef<number[]>([]);
  // Set once the ResizeObserver has reported a layout: an element with no layout (test DOM, never
  // rendered) is never reported, so its 0px is not trusted, while a laid-out 0px row is real.
  const laidOut = useRef(false);
  // The "more" control's width: a guess until it first mounts, its real width from then on, so the
  // computation converges instead of flip-flopping between the guess and the measurement.
  const moreWidth = useRef(MORE_FALLBACK_PX);
  const [visibleFrom, setVisibleFrom] = useState(0);

  const measure = useCallback(() => {
    const container = containerRef.current;
    if (!container || !laidOut.current) return;
    itemRefs.current.forEach((el, i) => {
      if (el) widths.current[i] = el.offsetWidth;
    });
    if (moreRef.current) moreWidth.current = moreRef.current.offsetWidth || moreWidth.current;
    setVisibleFrom(
      computeVisibleFrom(
        widths.current.slice(0, count),
        container.clientWidth,
        moreWidth.current,
        gapPx,
      ),
    );
  }, [count, gapPx]);

  // Content changed: a hidden item cannot be measured, so mount everything, measure, hide again.
  // Both run in layout effects, so the intermediate all-visible state never paints.
  const resetPending = useRef(false);
  useLayoutEffect(() => {
    resetPending.current = true;
    setVisibleFrom(0);
  }, [depsKey, count]);
  // Re-measure after every visibility change too: the "more" control mounts only then. A pending
  // reset must render first, or hidden items would be measured at their stale widths.
  useLayoutEffect(() => {
    if (resetPending.current && visibleFrom !== 0) return;
    resetPending.current = false;
    measure();
  }, [measure, visibleFrom, depsKey]);

  useLayoutEffect(() => {
    const container = containerRef.current;
    if (!container) return;
    // A pending reset's render measures on its own; measuring here first would read stale widths.
    const observer = new ResizeObserver(() => {
      laidOut.current = true;
      if (!resetPending.current) measure();
    });
    observer.observe(container);
    // Inline items too: a label that changes in place (a checkout, a loaded list) leaves the
    // container's width untouched, so the container alone would never report it.
    for (const el of itemRefs.current) if (el) observer.observe(el);
    return () => observer.disconnect();
  }, [measure, visibleFrom, depsKey]);

  const setItemRef = useCallback(
    (index: number) => (el: HTMLElement | null) => {
      itemRefs.current[index] = el;
    },
    [],
  );

  return { containerRef, moreRef, setItemRef, visibleFrom };
}
