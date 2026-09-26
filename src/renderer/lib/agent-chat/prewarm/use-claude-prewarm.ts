import { type FocusEvent, useCallback, useEffect, useRef } from 'react';

/** How long a chat stays the open, visible pane before its CLI starts: a navigation, not a pass. */
export const PREWARM_DWELL_MS = 1_500;
/** Editor focus asks at most this often; main skips a chat whose CLI is already up. */
export const PREWARM_FOCUS_THROTTLE_MS = 30_000;

/**
 * When to start a chat's Claude CLI ahead of its send: once `armed` (the chat is the open, visible
 * pane, idle and eligible) has held for the dwell, which also re-warms after a stream settles
 * (a reply, Stop, a failed send), and on later editor focus. Returns the chat root's onFocus.
 */
export function useClaudePrewarm(armed: boolean, prewarm: () => void) {
  const prewarmRef = useRef(prewarm);
  prewarmRef.current = prewarm;
  const dwelledRef = useRef(false);
  const lastRequestAtRef = useRef(0);

  useEffect(() => {
    if (!armed) return;
    const timer = setTimeout(() => {
      dwelledRef.current = true;
      lastRequestAtRef.current = Date.now();
      prewarmRef.current();
    }, PREWARM_DWELL_MS);
    return () => {
      clearTimeout(timer);
      dwelledRef.current = false;
    };
  }, [armed]);

  // Opening a chat focuses its editor at once, so only a focus after the dwell asks again. Not the
  // composer's model and mode controls: they change what the send will need.
  return useCallback((event: FocusEvent) => {
    if (!dwelledRef.current || !(event.target as Element).matches('[data-chat-input]')) return;
    if (Date.now() - lastRequestAtRef.current < PREWARM_FOCUS_THROTTLE_MS) return;
    lastRequestAtRef.current = Date.now();
    prewarmRef.current();
  }, []);
}
