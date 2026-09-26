/**
 * Streaming cadence counters: how long a checkpoint persist blocked the main event loop, and how
 * far apart a sub-chat's chunks arrived. They separate "Frink's own persist stalled the loop" from
 * "the SDK delivered in bursts" after the fact, on the ordinary `[heap-watch] sample` line.
 *
 * Every value is WINDOW-SCOPED: `drainStreamCadenceSnapshot` resets them, so each sample reports
 * the window since the previous one. An all-time peak (the `runtime-snapshot` idiom for memory)
 * would latch on the first bad moment and never say WHEN a stall happened.
 */

let checkpointPersistCount = 0;
let checkpointPersistMsTotal = 0;
let checkpointPersistMsMax = 0;
let checkpointPersistPartsMax = 0;
let chunkGapMsMax = 0;

/**
 * One checkpoint write finished. `parts` is the snapshot's part COUNT, not its serialized size:
 * measuring bytes would mean serialising the snapshot again on the very path this instrumentation
 * exists to keep cheap, and the count answers the same question (is duration tracking message
 * growth?) for free.
 */
export function recordCheckpointPersist(durationMs: number, parts: number): void {
  if (!Number.isFinite(durationMs) || !Number.isFinite(parts)) return;
  checkpointPersistCount += 1;
  checkpointPersistMsTotal += durationMs;
  checkpointPersistMsMax = Math.max(checkpointPersistMsMax, durationMs);
  checkpointPersistPartsMax = Math.max(checkpointPersistPartsMax, parts);
}

/**
 * Gap between two consecutive chunks of one sub-chat. Measured per sub-chat by the caller and
 * reduced to a global max here: with several streams running, a single interleaved "last chunk at"
 * would report the gap between different streams' chunks and always look healthy.
 */
export function recordStreamChunkGap(gapMs: number): void {
  if (!Number.isFinite(gapMs) || gapMs < 0) return;
  chunkGapMsMax = Math.max(chunkGapMsMax, gapMs);
}

/** Read and reset. Called once per diagnostics tick; see the window-scoping note above. */
export function drainStreamCadenceSnapshot() {
  const snapshot = {
    checkpointPersistCount,
    checkpointPersistMsTotal: Math.round(checkpointPersistMsTotal),
    checkpointPersistMsMax: Math.round(checkpointPersistMsMax),
    checkpointPersistPartsMax,
    streamChunkGapMsMax: Math.round(chunkGapMsMax),
  };
  _resetStreamCadenceForTests();
  return snapshot;
}

/** Also the drain's own reset — the counters have no other lifecycle. */
export function _resetStreamCadenceForTests(): void {
  checkpointPersistCount = 0;
  checkpointPersistMsTotal = 0;
  checkpointPersistMsMax = 0;
  checkpointPersistPartsMax = 0;
  chunkGapMsMax = 0;
}
