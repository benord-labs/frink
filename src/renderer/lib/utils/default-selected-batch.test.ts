import { describe, expect, it } from 'vitest';
import { resolveDefaultSelectedBatchId } from './default-selected-batch';

const summary = (id: string, lastActivityAt: string | null, firstRunAt: string | null = null) => ({
  batch_id: id,
  first_run_at: firstRunAt,
  last_activity_at: lastActivityAt,
});

describe('resolveDefaultSelectedBatchId', () => {
  it('prefers the active batch, even when absent from the summaries (planned, never dispatched)', () => {
    expect(
      resolveDefaultSelectedBatchId('b-active', [summary('b-old', '2026-01-02T00:00:00Z')]),
    ).toBe('b-active');
  });

  it('falls back to the most recently active batch when no active batch is set', () => {
    expect(
      resolveDefaultSelectedBatchId(null, [
        summary('b-1', '2026-01-01T00:00:00Z'),
        summary('b-2', '2026-01-03T00:00:00Z'),
        summary('b-3', '2026-01-02T00:00:00Z'),
      ]),
    ).toBe('b-2');
  });

  it('uses first_run_at when last_activity_at is missing', () => {
    expect(
      resolveDefaultSelectedBatchId(null, [
        summary('b-1', null, '2026-01-05T00:00:00Z'),
        summary('b-2', '2026-01-03T00:00:00Z'),
      ]),
    ).toBe('b-1');
  });

  it('returns null with no active batch and no summaries', () => {
    expect(resolveDefaultSelectedBatchId(null, undefined)).toBeNull();
    expect(resolveDefaultSelectedBatchId(null, [])).toBeNull();
  });
});
