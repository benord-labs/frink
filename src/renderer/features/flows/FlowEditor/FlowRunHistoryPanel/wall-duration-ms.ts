/** Wall-clock duration between node run timestamps, or null if incomplete. */
export function wallDurationMs(
  startedAt: string | null,
  completedAt: string | null,
): number | null {
  if (startedAt == null || completedAt == null) return null;
  const ms = new Date(completedAt).getTime() - new Date(startedAt).getTime();
  return Number.isFinite(ms) ? ms : null;
}
