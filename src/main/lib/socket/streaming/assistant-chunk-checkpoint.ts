/**
 * Checkpoint cadence for a streaming assistant message, and the local SQLite write that rides it.
 *
 * Phase 1 local-first migration: assistant message updates are persisted directly at the IPC
 * fan-out point, every 10th chunk + semantic boundaries + finalize, so the on-disk row trails the
 * live stream by at most 10 chunks. The mutex inside `upsertAssistantMessage` serialises
 * concurrent streams against the same sub-chat.
 *
 * `text-delta` is deliberately NOT a checkpoint: the snapshot only grows within a turn, so
 * per-delta checkpoints made both the IPC include and the full-row SQLite rewrite O(N²) over a
 * text-heavy turn — the amplification behind the 2026-08-10 renderer OOM (see
 * docs/decisions/live-run-observer-lane.md re-target).
 *
 * Local IPC is delta-only. This cadence is now only the SQLite durability boundary; bounded
 * renderer recovery seeds come from the main-owned live-stream registry.
 */

import log from 'electron-log';
import { getDatabase } from '../../db';
import { upsertAssistantMessage } from '../../db/repos/sub-chats';
import { recordStreamChunkGap } from '../../diagnostics/stream-cadence';

/** Per-(subChatId, assistantMessageId) chunk counts. Cleared on success, error, AND cancel; the
 * bounded sweep below catches anything missed so the Map can't grow unboundedly. */
const CHUNK_COUNTER_MAX = 256;
const chunkCounters = new Map<string, number>();
/** Arrival of the previous chunk, same keys and lifecycle as `chunkCounters`. */
const chunkArrivals = new Map<string, number>();

type CheckpointPayload = {
  subChatId: string;
  assistantMessageId: string;
  streamEpoch?: string;
  chunk: unknown;
  parts?: unknown[];
};

function counterKey(subChatId: string, messageId: string, streamEpoch: string): string {
  return JSON.stringify([subChatId, messageId, streamEpoch]);
}

export function clearChunkCounter(
  subChatId: string,
  messageId: string,
  streamEpoch?: string,
): void {
  if (streamEpoch) {
    chunkCounters.delete(counterKey(subChatId, messageId, streamEpoch));
    chunkArrivals.delete(counterKey(subChatId, messageId, streamEpoch));
    return;
  }
  for (const key of chunkCounters.keys()) {
    const [keySubChatId, keyMessageId] = JSON.parse(key) as [string, string, string];
    if (keySubChatId === subChatId && keyMessageId === messageId) {
      chunkCounters.delete(key);
      chunkArrivals.delete(key);
    }
  }
}

/** Safety net: if we ever leak counters, evict the oldest insertion-order entries. */
function trimChunkCountersIfOverLimit(): void {
  if (chunkCounters.size <= CHUNK_COUNTER_MAX) return;
  const overage = chunkCounters.size - CHUNK_COUNTER_MAX + 32; // dump a chunk to amortise
  let dropped = 0;
  for (const key of chunkCounters.keys()) {
    if (dropped >= overage) break;
    chunkCounters.delete(key);
    chunkArrivals.delete(key);
    dropped += 1;
  }
}

/**
 * Semantic boundaries that checkpoint regardless of chunk count — text block edges, a resolved tool
 * call, and step/turn end.
 *
 * The count alone is not enough: a short all-tool run (a wake burst that fires one command and
 * stops) has no `text-delta` and fewer than 10 chunks, so it would never checkpoint — no snapshot
 * over IPC, nothing for the observer lane to paint, and no row on disk until the run finalized.
 */
const CHECKPOINT_CHUNK_TYPES = new Set([
  'text-start',
  'text-end',
  'tool-output-available',
  'tool-output-error',
  'finish-step',
  'finish',
]);

/** Advance one epoch's cursor and report its 0-based wire index plus persistence cadence. */
export function recordStreamChunk(payload: CheckpointPayload & { streamEpoch: string }): {
  messageIndex: number;
  isCheckpoint: boolean;
} {
  const key = counterKey(payload.subChatId, payload.assistantMessageId, payload.streamEpoch);
  const count = (chunkCounters.get(key) ?? 0) + 1;
  chunkCounters.set(key, count);
  // This already runs on EVERY chunk, so it is the one hook that can measure arrival spacing
  // without adding a line to the send path (client.ts / executor.ts are both size-ratcheted).
  // `performance.now()` because this is an INTERVAL: wall-clock time can step backwards or jump
  // forward (NTP slew, DST, a user setting the clock), and this metric exists precisely to say
  // whether a stall was real — a fabricated multi-second gap is the one failure it cannot afford.
  // No entry means a new message or one whose counter was cleared at end-of-turn; a wake burst
  // waiting minutes between bursts must not report that wait as a stall.
  const now = performance.now();
  const previous = chunkArrivals.get(key);
  if (previous !== undefined) recordStreamChunkGap(now - previous);
  chunkArrivals.set(key, now);
  trimChunkCountersIfOverLimit();
  const type = (payload.chunk as { type?: string } | undefined)?.type;
  return {
    messageIndex: count - 1,
    isCheckpoint: count % 10 === 0 || (type !== undefined && CHECKPOINT_CHUNK_TYPES.has(type)),
  };
}

type PersistDeps = {
  getDatabase: typeof getDatabase;
  upsertAssistantMessage: typeof upsertAssistantMessage;
};

export async function persistAssistantChunkLocally(
  payload: CheckpointPayload,
  generation: number, // from the live-stream registry: what this epoch started against
  deps: PersistDeps = { getDatabase, upsertAssistantMessage },
): Promise<void> {
  if (!payload.parts) return;
  // Copy before the await. `partsSnapshot` hands back the LIVE accumulator array when there is no
  // pending text, and `upsertAssistantMessage` serialises it later inside its mutex — by then the
  // stream has pushed more parts onto that same array, so the row would record a moment that never
  // was a checkpoint. (Parts already in the array are still mutated in place by later chunks; that
  // only ever moves a tool card forward, and the burst's finalize is authoritative regardless.)
  const snapshot = [...payload.parts];
  try {
    const outcome = await deps.upsertAssistantMessage(
      deps.getDatabase(),
      payload.subChatId,
      payload.assistantMessageId,
      snapshot,
      generation,
    );
    // Rate-limited by the checkpoint cadence, unlike the fence itself, which every seed reads.
    if (outcome === 'dropped') {
      log.warn(`[Socket] Checkpoint dropped for ${payload.subChatId}: transcript replaced`);
    }
  } catch (err) {
    log.error('[Socket] Local chunk persist failed:', err);
    // Swallowing keeps a failed write from killing the live stream, but silence here means the
    // transcript quietly stops persisting while the UI still paints — the user only finds out on
    // reload. Capture so the class is visible. Lazy import keeps @sentry/electron out of this
    // module's static graph, matching the executor's other error paths.
    const { captureMainException } = await import('../../sentry/init');
    captureMainException(err, { surface: 'assistant-chunk-checkpoint' });
  }
}
