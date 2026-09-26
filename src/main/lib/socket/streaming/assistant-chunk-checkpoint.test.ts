import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { getDatabase } from '../../db';
import type { upsertAssistantMessage as upsertAssistantMessageReal } from '../../db/repos/sub-chats';
import {
  _resetStreamCadenceForTests,
  drainStreamCadenceSnapshot,
} from '../../diagnostics/stream-cadence';
import {
  clearChunkCounter,
  persistAssistantChunkLocally,
  recordStreamChunk,
} from './assistant-chunk-checkpoint';

const upsertAssistantMessage = vi.fn<typeof upsertAssistantMessageReal>(async () => 'patched');
// SAFETY: the fake upsert never touches the handle; only its identity is passed through.
const deps = { getDatabase: () => ({}) as ReturnType<typeof getDatabase>, upsertAssistantMessage };

type StreamIds = { subChatId: string; assistantMessageId: string; streamEpoch: string };
const isCheckpointChunk = (payload: StreamIds & { chunk: unknown }): boolean =>
  recordStreamChunk(payload).isCheckpoint;

/** Distinct ids per test so the module-level counter maps never leak across cases. */
let seq = 0;
const freshIds = (): StreamIds => {
  seq += 1;
  return { subChatId: `sub-${seq}`, assistantMessageId: `msg-${seq}`, streamEpoch: `epoch-${seq}` };
};

const textDelta = (ids: StreamIds) => ({
  ...ids,
  chunk: { type: 'text-delta' },
});

beforeEach(() => {
  _resetStreamCadenceForTests();
  upsertAssistantMessage.mockClear();
});
afterEach(() => {
  vi.useRealTimers();
});

describe('recordStreamChunk', () => {
  it('checkpoints every 10th chunk', () => {
    const ids = freshIds();
    const results = Array.from({ length: 20 }, () => isCheckpointChunk(textDelta(ids)));
    expect(results.filter(Boolean)).toHaveLength(2);
    expect(results[9]).toBe(true);
    expect(results[19]).toBe(true);
  });

  it('checkpoints semantic boundaries regardless of count', () => {
    // A short all-tool burst never reaches 10 chunks; without these it would never persist.
    for (const type of ['text-start', 'text-end', 'tool-output-available', 'finish']) {
      const ids = freshIds();
      expect(isCheckpointChunk({ ...ids, chunk: { type } })).toBe(true);
    }
  });

  it('does not checkpoint a text-delta below the count', () => {
    // Deliberately excluded: per-delta checkpoints made the row rewrite O(N^2) over a turn.
    const ids = freshIds();
    expect(isCheckpointChunk(textDelta(ids))).toBe(false);
  });

  it('counts each message separately, so one stream cannot advance another to a checkpoint', () => {
    const a = freshIds();
    const b = freshIds();
    for (let i = 0; i < 9; i++) isCheckpointChunk(textDelta(a));
    // 9 chunks on `a` plus 1 on `b` must not trip either counter.
    expect(isCheckpointChunk(textDelta(b))).toBe(false);
    expect(isCheckpointChunk(textDelta(a))).toBe(true);
  });
});

describe('chunk-arrival probe', () => {
  it('records no gap for the first chunk of a message', () => {
    // There is no previous arrival to subtract; recording one would report the age of the
    // process as a stall.
    isCheckpointChunk(textDelta(freshIds()));
    expect(drainStreamCadenceSnapshot().streamChunkGapMsMax).toBe(0);
  });

  it('records the gap between consecutive chunks of the same message', () => {
    vi.useFakeTimers();
    const ids = freshIds();
    isCheckpointChunk(textDelta(ids));
    vi.advanceTimersByTime(4_000);
    isCheckpointChunk(textDelta(ids));

    expect(drainStreamCadenceSnapshot().streamChunkGapMsMax).toBe(4_000);
  });

  it('keeps gaps per sub-chat when two panes interleave chunks', () => {
    // The multi-pane case. A single shared "last chunk at" would measure the spacing between
    // DIFFERENT streams' chunks — always small — and report a stalled pane as healthy.
    vi.useFakeTimers();
    const slow = freshIds();
    const busy = freshIds();

    isCheckpointChunk(textDelta(slow));
    for (let i = 0; i < 10; i++) {
      vi.advanceTimersByTime(500);
      isCheckpointChunk(textDelta(busy));
    }
    isCheckpointChunk(textDelta(slow));

    // The busy pane's own gaps are 500ms; the stalled pane's is the full 5s and must survive.
    expect(drainStreamCadenceSnapshot().streamChunkGapMsMax).toBe(5_000);
  });

  it('records no gap across a cleared counter, so a wake-burst wait is not a stall', () => {
    // Each burst ends with execute-complete, which clears the counter. The minutes a pump spends
    // parked between bursts are not a stall, and reporting them as one would bury real ones.
    vi.useFakeTimers();
    const ids = freshIds();
    isCheckpointChunk(textDelta(ids));
    clearChunkCounter(ids.subChatId, ids.assistantMessageId);
    vi.advanceTimersByTime(600_000);
    isCheckpointChunk(textDelta(ids));

    expect(drainStreamCadenceSnapshot().streamChunkGapMsMax).toBe(0);
  });
});

describe('bounded counter sweep', () => {
  it('evicts arrival stamps alongside counters, so the probe map cannot grow unboundedly', () => {
    // The counter map has a 256-entry safety net for keys that never got a clear (a run that died
    // without execute-complete). The arrival map is keyed identically and MUST be swept with it —
    // otherwise this probe leaks one entry per abandoned message for the life of the process.
    // Observable proxy: an evicted key has no previous arrival, so its next chunk records no gap.
    vi.useFakeTimers();
    const victim = { subChatId: 'sub-victim', assistantMessageId: 'msg-victim', streamEpoch: 'e' };
    isCheckpointChunk(textDelta(victim));

    for (let i = 0; i < 300; i++) {
      isCheckpointChunk(
        textDelta({ subChatId: `sub-flood-${i}`, assistantMessageId: 'm', streamEpoch: 'e' }),
      );
    }
    drainStreamCadenceSnapshot(); // discard the flood's own gaps

    vi.advanceTimersByTime(30_000);
    isCheckpointChunk(textDelta(victim));

    expect(drainStreamCadenceSnapshot().streamChunkGapMsMax).toBe(0);
  });
});

describe('persistAssistantChunkLocally', () => {
  it('copies parts before awaiting so later mutation cannot rewrite the checkpoint', async () => {
    const live: unknown[] = [{ type: 'text' }];
    const seen: unknown[][] = [];
    upsertAssistantMessage.mockImplementationOnce(async (_db, _subChatId, _messageId, parts) => {
      live.push({ type: 'text' }); // the stream keeps pushing onto the SAME array
      seen.push(parts);
      return 'patched';
    });

    await persistAssistantChunkLocally(
      { ...freshIds(), chunk: { type: 'finish' }, parts: live },
      0,
      deps,
    );

    expect(seen[0]).toHaveLength(1);
    expect(live).toHaveLength(2);
  });

  it('skips the write when the payload carries no parts', async () => {
    await persistAssistantChunkLocally({ ...freshIds(), chunk: { type: 'finish' } }, 0, deps);

    expect(upsertAssistantMessage).not.toHaveBeenCalled();
  });

  it('swallows a failed write so the live stream survives a persistence outage', async () => {
    upsertAssistantMessage.mockRejectedValueOnce(new Error('disk full'));

    await expect(
      persistAssistantChunkLocally(
        { ...freshIds(), chunk: { type: 'finish' }, parts: [{ type: 'text' }] },
        0,
        deps,
      ),
    ).resolves.toBeUndefined();
  });
});
