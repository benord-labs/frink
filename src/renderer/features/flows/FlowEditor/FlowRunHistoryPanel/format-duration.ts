export function formatDuration(ms: number): string {
  if (ms < 1000) return `${ms}ms`;
  const s = ms / 1000;
  // Avoid "60.0s" when rounding crosses the minute boundary (e.g. 59950ms).
  if (s < 59.95) return `${s.toFixed(1)}s`;
  return `${Math.round(s / 60)}m`;
}

/** Elapsed wall time from an ISO start timestamp to `endMs` (default: now), formatted like `formatDuration`. */
export function formatElapsedSinceStart(
  startedAtIso: string | null,
  endMs: number = Date.now(),
): string {
  if (!startedAtIso) return '';
  return formatDuration(Math.max(0, endMs - new Date(startedAtIso).getTime()));
}

/**
 * Like `formatDuration` but always includes seconds so a 1-second tick
 * produces a visible change (e.g. "22m 15s" instead of just "22m").
 */
export function formatDurationLive(ms: number): string {
  if (ms < 1000) return `${ms}ms`;
  const totalSeconds = Math.floor(ms / 1000);
  if (totalSeconds < 60) return `${totalSeconds}s`;
  const m = Math.floor(totalSeconds / 60);
  const s = totalSeconds % 60;
  if (m < 60) return `${m}m ${s}s`;
  const h = Math.floor(m / 60);
  const rm = m % 60;
  return `${h}h ${rm}m ${s}s`;
}

/** Like `formatElapsedSinceStart` but uses the live (always-shows-seconds) format. */
export function formatElapsedSinceStartLive(
  startedAtIso: string | null,
  endMs: number = Date.now(),
): string {
  if (!startedAtIso) return '';
  return formatDurationLive(Math.max(0, endMs - new Date(startedAtIso).getTime()));
}
