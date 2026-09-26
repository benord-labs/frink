import { useCallback, useEffect, useLayoutEffect, useRef } from 'react';

/**
 * Hands `callback` the latest pushed value at most once per animation frame. `flush` delivers a
 * pending value now, so the last frame of a drag is never lost; unmounting flushes too.
 */
export function useFrameCoalesced<T>(callback: (value: T) => void) {
  const callbackRef = useRef(callback);
  const pending = useRef<{ value: T } | null>(null);
  const frame = useRef(0);

  useLayoutEffect(() => {
    callbackRef.current = callback;
  });

  const flush = useCallback(() => {
    cancelAnimationFrame(frame.current);
    frame.current = 0;
    const next = pending.current;
    pending.current = null;
    if (next) callbackRef.current(next.value);
  }, []);

  const push = useCallback(
    (value: T) => {
      pending.current = { value };
      frame.current ||= requestAnimationFrame(flush);
    },
    [flush],
  );

  useEffect(() => flush, [flush]);

  return { push, flush };
}
