/** Dev-only: React's component track leaves one uncleared measure per changed-props render and Blink
 * never caps user timing, so trim the buffer on a timer. Rationale: decision renderer-user-timing-bound. */
export const TRIM_INTERVAL_MS = 10_000;
export const MARK_CAP = 10_000;

export function startUserTimingBound(): () => void {
  if (!import.meta.env.DEV) return () => {};
  const timer = setInterval(() => {
    performance.clearMeasures();
    if (performance.getEntriesByType('mark').length > MARK_CAP) performance.clearMarks();
  }, TRIM_INTERVAL_MS);
  return () => clearInterval(timer);
}
