import { useEffect, useRef } from 'react';

/**
 * Subscribes to a `window` event for the lifetime of the component.
 *
 * The handler is held in a ref, so a caller may pass an inline arrow without
 * re-subscribing on every render — the listener is registered once per event name.
 */
export function useWindowEvent(eventName: string, handler: (event: Event) => void): void {
  const handlerRef = useRef(handler);
  // Written after commit, not during render: React may replay or discard a render, and a
  // ref mutated there can leak from UI that never committed.
  useEffect(() => {
    handlerRef.current = handler;
  });

  useEffect(() => {
    const listener = (event: Event): void => handlerRef.current(event);
    window.addEventListener(eventName, listener);
    return () => window.removeEventListener(eventName, listener);
  }, [eventName]);
}
