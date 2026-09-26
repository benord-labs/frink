/**
 * Report an error that was CONTAINED rather than propagated — the caller logged it and carried on,
 * so nothing downstream will ever surface it. A contained fault with only a local log line is
 * invisible in production, which is precisely the silent degradation that
 * docs/decisions/sub-chat-read-failure-posture.md rules against on the contain-and-log side of its
 * two-tier posture. Propagating paths need no capture: their caller reports them.
 *
 * This barrel deliberately does NOT re-export `./init`. Reaching init through a lazy import is the
 * whole point — it keeps @sentry/electron, and the `electron` module it pulls in, out of the static
 * graph of the flow engine and tRPC helpers that call this (their tests do not mock `electron`).
 * The two callers that legitimately need init's own API (boot wiring, the steer path) deep-import
 * `./init` directly. Mirrors worktree-config.ts's captureWriteFailure.
 *
 * Never throws: a reporting failure must not become the failure. Tags must stay low-cardinality
 * (surface/stage/blockType, never ids) so Sentry can group them.
 */
export function captureContained(error: unknown, tags: Record<string, string>): void {
  void import('./init')
    .then(({ captureMainException }) => {
      captureMainException(error, tags);
    })
    .catch(() => {});
}
