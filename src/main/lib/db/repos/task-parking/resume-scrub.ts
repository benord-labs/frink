/**
 * What a RESUME must clear from a task's result — the third leg of this folder's marker lifecycle:
 * a park writes a reason (index.ts, scrubbing PARK_STALE_RESULT_KEYS first), a cancel merges its
 * marker (cancel-marker.ts, preserving linkage), and a resume clears every per-attempt marker the
 * ended attempt left behind.
 */

/**
 * Per-attempt markers a resume must clear before flipping a task back to `running` — they describe
 * the attempt that ENDED, and a survivor misclassifies the next park (a stale `userPause` reads as
 * user-paused; a stale `usageLimit`/`apiError` reads as a transient retry). Load-bearing for BOTH
 * executor resume paths since cancel writes started MERGING their marker onto the existing result
 * rather than replacing it (that replace is what previously made a short scrub sufficient, and it
 * was also wiping `result.subChatId`, the link the resume lookup needs). Linkage (`subChatId`,
 * `startMode`) and the caller's own fields are deliberately preserved.
 */
export const RESUME_STALE_RESULT_KEYS = [
  'agentSignal',
  'cancelled',
  'error',
  'failureCode',
  'staleExecution',
  'staleDetectedAt',
  'lastHeartbeatAt',
  'usageLimit',
  'apiError',
  'userPause',
  'quietEndedAt',
  'resumedBy',
  'resumedAt',
  'previousStatus',
] as const;

/** The result with every {@link RESUME_STALE_RESULT_KEYS} marker removed; input untouched. */
export function scrubResumedResult(previous: Record<string, unknown>): Record<string, unknown> {
  const resumed = { ...previous };
  for (const key of RESUME_STALE_RESULT_KEYS) delete resumed[key];
  return resumed;
}
