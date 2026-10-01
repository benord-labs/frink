import log from 'electron-log';

/**
 * rowId → attempt token of rows already reported, so one persistently corrupt row cannot flood
 * Sentry on every read and a stale capture's cleanup cannot unlatch a newer attempt. Bounded: past
 * the cap the map is dropped and those rows may report once more.
 */
const REPORTED_ROWS_MAX = 256;
const reportedCorruptRows = new Map<string, number>();
let attempts = 0;

type Capture = (
  ...args: Parameters<typeof import('../sentry/init').captureMainException>
) => void | Promise<void>;
const lazyCapture: Capture = (err, context) =>
  import('../sentry/init').then((m) => m.captureMainException(err, context));
let capture: Capture = lazyCapture;

export function reportCorruptTranscript(rowId: string, raw: string, err: Error): void {
  log.warn(`[sub-chats] skipping an unparseable message in sub-chat ${rowId}`, err);
  if (reportedCorruptRows.has(rowId)) return;
  if (reportedCorruptRows.size >= REPORTED_ROWS_MAX) reportedCorruptRows.clear();
  const attempt = ++attempts;
  reportedCorruptRows.set(rowId, attempt);
  // The caught error is deliberately NOT forwarded. V8 embeds a window of the offending input in
  // its message (`Unexpected token '@', "@[{"role":"... is not valid JSON`) — here that window IS
  // the user's transcript, and this path is absent from the scrubber's SENSITIVE_PATH_PATTERNS.
  // Adding it there instead would drop the event entirely and defeat the monitoring, so the signal
  // is re-synthesised carrying only the failure kind and a length. Fire-and-forget behind a lazy
  // import: callers are synchronous transaction callbacks, and @sentry/electron stays out of the
  // static graph, matching the executor's other error paths.
  const safe = new Error(`sub-chats transcript parse failed: ${err.name} (len=${raw.length})`);
  // Latched before the capture so concurrent reads dedupe; unlatched if the capture cannot load,
  // so the next read retries instead of the row going permanently unreported.
  void Promise.resolve()
    .then(() => capture(safe, { surface: 'sub-chats-transcript-corruption' }))
    .catch(() => {
      if (reportedCorruptRows.get(rowId) === attempt) reportedCorruptRows.delete(rowId);
    });
}

/** Test-only: observe the capture without mocking the Sentry module. */
export function _setCorruptTranscriptCaptureForTests(next: Capture | null): void {
  capture = next ?? lazyCapture;
}

/** Test-only: the dedup set is module state and would otherwise leak across cases. */
export function _resetCorruptTranscriptReportsForTests(): void {
  reportedCorruptRows.clear();
}
