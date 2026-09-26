/**
 * Classifies Anthropic API errors surfaced through the Claude Agent SDK. The SDK errors the
 * message iterator instead of yielding the result frame, so the error TEXT is all the executor
 * ever sees (`api_error_status` never reaches us). The CLI passes the API body through verbatim,
 * usually wrapped by the SDK as "Claude Code returned an error result: <text>":
 *
 *   "Failed to authenticate. API Error: 401 {"error":{"type":"authentication_error",…}}"
 *   "API Error: 429 {"error":{"type":"rate_limit_error",…}}"
 *   "API Error: 529 {"error":{"type":"overloaded_error",…}}"
 *
 * `auth` (401) usually means the injected static token expired mid-run — the executor re-resolves
 * the credential (fresh keychain read) and retries once. `transient` (408/429/5xx/529) retries
 * once after a backoff. Other statuses (400/403/…) are terminal and classify as null.
 * Usage-limit texts are excluded — they have their own park path (see usage-limit.ts).
 */

import { type FinalPartLike, trailingTextPart } from './trailing-text';
import { isUsageLimitText } from './usage-limit';

export type ApiErrorClassification = {
  status: number | null;
  /** 'auth' → re-resolve the credential before the single retry; 'transient' → backoff + retry. */
  kind: 'auth' | 'transient';
};

/**
 * Base delay before the transient retry (plus up to 1s jitter). The executor retries at most
 * ONCE (first-attempt-only guard), mirroring codex's 401→refresh-once→retry-once — keeps a 429
 * storm bounded.
 */
export const API_ERROR_RETRY_BACKOFF_MS = 2_000;

/**
 * Real CLI API-error results are a one-line prefix plus the raw JSON body (~200-400 chars).
 * Anything longer is an agent's own message quoting an error — never retry on those (mirrors
 * usage-limit.ts's length guard).
 */
const MAX_API_ERROR_TEXT_LENGTH = 600;
/** The SDK wraps the CLI's result text when it errors the stream — strip before anchoring. */
const SDK_WRAPPER_RE = /^Claude Code returned an error result:\s*/i;
/**
 * A genuine API-error result STARTS with the CLI's own prefix: the 401 line or the generic
 * "API Error: <status>" line (the raw JSON body always follows one of these). A bare `{` is NOT
 * anchored — an agent whose own message is JSON (e.g. `{"error":{"type":"rate_limit_error"}}`, or
 * a quoted API body) would otherwise be misclassified into an unwanted retry.
 */
const ANCHOR_RE = /^(failed to authenticate|api error:)/i;

const API_ERROR_STATUS_RE = /API Error:?\s*(\d{3})/i;
const RETRYABLE_STATUSES = new Set([408, 429, 500, 502, 503, 504, 529]);
const AUTH_ERROR_RE = /failed to authenticate|authentication_error/i;
const TRANSIENT_ERROR_RE = /rate_limit_error|overloaded_error/i;

export function classifyApiErrorText(text: string): ApiErrorClassification | null {
  if (text.length > MAX_API_ERROR_TEXT_LENGTH || isUsageLimitText(text)) return null;

  const body = text.replace(SDK_WRAPPER_RE, '').trimStart();
  if (!ANCHOR_RE.test(body)) return null;

  const statusMatch = API_ERROR_STATUS_RE.exec(body);
  const status = statusMatch ? Number(statusMatch[1]) : null;

  if (status === 401 || AUTH_ERROR_RE.test(body)) {
    return { status: status ?? 401, kind: 'auth' };
  }
  if ((status != null && RETRYABLE_STATUSES.has(status)) || TRANSIENT_ERROR_RE.test(body)) {
    return { status, kind: 'transient' };
  }
  return null;
}

export type TrailingApiError = { status: number | null; message: string };

/**
 * The CLEAN-stream shape of an API failure: the SDK yields a NORMAL result frame and the error
 * text IS the final assistant text part, so nothing throws and the executor's catch never runs.
 * Left undetected the flow task stays `running` until the quiet-idle sweep's 45-minute ceiling.
 *
 * This is a PARK decision, not a RETRY decision, which is why it does not reuse
 * {@link classifyApiErrorText}: that function deliberately returns null for 400/403 because no
 * retry can save them, but those are exactly the failures that most need to stop a flow. Here
 * every status parks. The anchor + length guard are the whole false-positive defence — an agent's
 * own closing message essentially never STARTS with the CLI's error prefix in under 600 chars.
 */
export function extractTrailingApiError(
  parts: ReadonlyArray<FinalPartLike>,
): TrailingApiError | null {
  const text = trailingTextPart(parts);
  if (text === null || text.length > MAX_API_ERROR_TEXT_LENGTH || isUsageLimitText(text)) {
    return null;
  }
  const body = text.replace(SDK_WRAPPER_RE, '').trimStart();
  if (!ANCHOR_RE.test(body)) return null;
  const statusMatch = API_ERROR_STATUS_RE.exec(body);
  return { status: statusMatch ? Number(statusMatch[1]) : null, message: text };
}
