/**
 * Guards canvas re-hydration from GET /flow-runs/:id against stale React Query cache:
 * only apply when the detail is still the flow's latest *active* run per listRuns. Active =
 * running OR paused — a paused (approval-waiting) run must also repaint its overlay on refresh,
 * else the canvas shows nothing while the run sits waiting for input.
 */

const ACTIVE_REHYDRATE_STATUSES = new Set(['running', 'paused']);

export function isFlowRunDetailAlignedWithLatestRun(
  activeRunDetail: { id: string; status: string },
  latestRun: { id: string; status: string } | undefined,
): boolean {
  if (!ACTIVE_REHYDRATE_STATUSES.has(activeRunDetail.status)) return false;
  if (!latestRun || !ACTIVE_REHYDRATE_STATUSES.has(latestRun.status)) return false;
  return latestRun.id === activeRunDetail.id;
}
