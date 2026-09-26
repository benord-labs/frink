export const USER_ABORT_ERROR_PATTERNS = [
  'claude code process aborted by user',
  'process aborted by user',
  'aborted by user',
  'operation was aborted',
  'aborterror',
] as const;

export function isUserAbortErrorMessage(rawError: string): boolean {
  const normalized = rawError.toLowerCase();
  return USER_ABORT_ERROR_PATTERNS.some((pattern) => normalized.includes(pattern));
}

/**
 * Abort reasons Frink stamps when IT tore the run down, not the user.
 *
 * The reason must be carried explicitly because the error text cannot distinguish these: the SDK
 * reports every abort — Stop button, window reload, crash — as "Claude Code process aborted by
 * user", which {@link isUserAbortErrorMessage} then matches. A teardown classified off that text
 * alone is filed as a user Stop, and Frink's user-stop path is deliberately silent: no error, no
 * toast, no park. The run simply stops with its last tool card frozen mid-call, which reads as a
 * hang.
 *
 * Allow-list rather than deny-list: the other stamped reasons are free-form strings
 * ('chat archived (batch)', chat delete, 'remote-stop') and all genuinely user-initiated, so
 * naming only these two cannot change how any of them are handled.
 */
const INVOLUNTARY_ABORT_REASONS = ['renderer-reload', 'renderer-crashed'] as const;

export type InvoluntaryAbortReason = (typeof INVOLUNTARY_ABORT_REASONS)[number];

export function isInvoluntaryAbortReason(
  reason: string | undefined,
): reason is InvoluntaryAbortReason {
  return INVOLUNTARY_ABORT_REASONS.includes(reason as InvoluntaryAbortReason);
}

/**
 * User-facing reason for an involuntary teardown. Must not contain any
 * {@link USER_ABORT_ERROR_PATTERNS} substring — the renderer discards errors that match those
 * before it ever reads the category, so a message quoting the SDK's own wording would be dropped.
 */
export function involuntaryAbortMessage(reason: InvoluntaryAbortReason): string {
  return reason === 'renderer-reload'
    ? 'Stopped: the app window reloaded before this turn finished.'
    : 'Stopped: the app window closed unexpectedly before this turn finished.';
}
