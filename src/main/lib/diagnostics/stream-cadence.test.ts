import { beforeEach, describe, expect, it } from 'vitest';
import {
  _resetStreamCadenceForTests,
  drainStreamCadenceSnapshot,
  recordCheckpointPersist,
  recordStreamChunkGap,
} from './stream-cadence';

beforeEach(() => _resetStreamCadenceForTests());

describe('recordCheckpointPersist', () => {
  it('accumulates count and total while tracking the max separately', () => {
    recordCheckpointPersist(10, 3);
    recordCheckpointPersist(40, 1);
    recordCheckpointPersist(25, 9);

    expect(drainStreamCadenceSnapshot()).toMatchObject({
      checkpointPersistCount: 3,
      checkpointPersistMsTotal: 75,
      checkpointPersistMsMax: 40,
      checkpointPersistPartsMax: 9,
    });
  });

  it('rounds the reported milliseconds, since performance.now() is fractional', () => {
    recordCheckpointPersist(1.4, 1);
    recordCheckpointPersist(2.4, 1);

    // Totals round once at the boundary rather than per sample, so 3.8 does not become 3.
    expect(drainStreamCadenceSnapshot()).toMatchObject({
      checkpointPersistMsTotal: 4,
      checkpointPersistMsMax: 2,
    });
  });

  it.each([
    ['NaN duration', Number.NaN, 1],
    ['Infinity duration', Number.POSITIVE_INFINITY, 1],
    ['NaN parts', 5, Number.NaN],
  ])('ignores a %s rather than poisoning every later sample', (_label, duration, parts) => {
    recordCheckpointPersist(duration, parts);
    recordCheckpointPersist(10, 2);

    // Without the guard, one Infinity makes max and total permanently useless.
    expect(drainStreamCadenceSnapshot()).toMatchObject({
      checkpointPersistCount: 1,
      checkpointPersistMsTotal: 10,
      checkpointPersistMsMax: 10,
      checkpointPersistPartsMax: 2,
    });
  });

  it('accepts a zero-duration persist as a real sample', () => {
    // Sub-millisecond writes are the expected case once the fast path is doing its job; dropping
    // them as falsy would make the count under-report exactly when things are healthy.
    recordCheckpointPersist(0, 0);
    expect(drainStreamCadenceSnapshot().checkpointPersistCount).toBe(1);
  });

  it('survives a very large sample without overflowing to a non-finite total', () => {
    recordCheckpointPersist(Number.MAX_SAFE_INTEGER, 1);
    const snapshot = drainStreamCadenceSnapshot();
    expect(Number.isFinite(snapshot.checkpointPersistMsTotal)).toBe(true);
    expect(snapshot.checkpointPersistMsMax).toBe(Number.MAX_SAFE_INTEGER);
  });
});

describe('recordStreamChunkGap', () => {
  it('keeps the largest gap seen in the window', () => {
    recordStreamChunkGap(120);
    recordStreamChunkGap(9_800);
    recordStreamChunkGap(35);

    expect(drainStreamCadenceSnapshot().streamChunkGapMsMax).toBe(9_800);
  });

  it('ignores a negative gap rather than reporting time running backwards', () => {
    recordStreamChunkGap(-5);
    expect(drainStreamCadenceSnapshot().streamChunkGapMsMax).toBe(0);
  });

  it('ignores a non-finite gap', () => {
    recordStreamChunkGap(Number.POSITIVE_INFINITY);
    recordStreamChunkGap(Number.NaN);
    recordStreamChunkGap(42);

    expect(drainStreamCadenceSnapshot().streamChunkGapMsMax).toBe(42);
  });
});

describe('drainStreamCadenceSnapshot', () => {
  it('resets every counter, so each sample describes only its own window', () => {
    // An all-time peak would latch on the first bad moment and never again say WHEN a stall
    // happened — the one question these fields exist to answer.
    recordCheckpointPersist(50, 4);
    recordStreamChunkGap(9_000);
    drainStreamCadenceSnapshot();

    expect(drainStreamCadenceSnapshot()).toEqual({
      checkpointPersistCount: 0,
      checkpointPersistMsTotal: 0,
      checkpointPersistMsMax: 0,
      checkpointPersistPartsMax: 0,
      streamChunkGapMsMax: 0,
    });
  });

  it('reports an all-zero window rather than throwing when nothing streamed', () => {
    expect(drainStreamCadenceSnapshot().checkpointPersistCount).toBe(0);
  });
});
